/**
 * The send pipeline shared by POST /emails, POST /emails/batch, SMTP, broadcasts,
 * automations and inbox replies: validate → persist → queue → (worker) build MIME → transport.
 */
import type { AppContext } from '../context.js';
import type { Sql } from '../db.js';
import { domainOf, parseAddress, toList } from '../lib/address.js';
import { ApiError, E } from '../lib/errors.js';
import { blockedExtension } from '../lib/attachments.js';
import { isUuid, uuid } from '../lib/ids.js';
import { parseWhen, startOfUtcDay, startOfUtcMonth } from '../lib/time.js';
import type { AuthContext } from './apiKeys.js';
import { enqueue } from './jobs.js';
import { htmlToText, referencedVariables, renderVars, type Vars } from './render.js';
import { recordEvent, type EmailRow } from './emailEvents.js';

export const MAX_EMAIL_BYTES = 40 * 1024 * 1024;
/** Cloudflare Email Sending's limit for the whole raw message. */
export const CLOUDFLARE_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_RECIPIENTS = 50;
export const MAX_TAGS = 75;
export const MAX_SCHEDULE_DAYS = 30;
const TAG_RE = /^[A-Za-z0-9_-]{1,256}$/;
const ADDR_FMT = 'The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.';

/** Resend's test inbox addresses (https://resend.com/docs/dashboard/emails/send-test-emails). */
export const TEST_ADDRESS_RE = /^(delivered|bounced|complained|suppressed)(\+[^@]*)?@resend\.dev$/i;

export interface InputAttachment {
  content?: unknown;
  filename?: unknown;
  path?: unknown;
  content_type?: unknown;
  content_id?: unknown;
}

export interface SendInput {
  from?: unknown;
  to?: unknown;
  subject?: unknown;
  cc?: unknown;
  bcc?: unknown;
  reply_to?: unknown;
  html?: unknown;
  text?: unknown;
  headers?: unknown;
  tags?: unknown;
  attachments?: unknown;
  scheduled_at?: unknown;
  template?: unknown;
  topic_id?: unknown;
  react?: unknown;
}

export interface NormalizedAttachment {
  filename: string | null;
  contentType: string;
  contentId: string | null;
  disposition: 'inline' | 'attachment';
  content: Buffer | null;
  path: string | null;
}

export interface NormalizedEmail {
  from: string;
  fromAddress: string;
  fromDomain: string;
  domainId: string | null;
  sandbox: boolean;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string> | null;
  tags: { name: string; value: string }[] | null;
  attachments: NormalizedAttachment[];
  scheduledAt: Date | null;
  topicId: string | null;
  templateId: string | null;
  sizeBytes: number;
}

export interface CreateOpts {
  source: 'api' | 'smtp' | 'broadcast' | 'automation' | 'inbox' | 'dashboard';
  batch?: boolean;
  broadcastId?: string | null;
  contactId?: string | null;
  automationRunId?: string | null;
  /** Broadcasts and automations are not subject to the transactional quota. */
  skipQuota?: boolean;
  /** Extra template variables that bypass key validation (e.g. `contact.first_name` for automations). */
  contextVars?: Vars;
}

const contentTypeFor = (filename: string | null): string => {
  const ext = filename?.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html', json: 'application/json', xml: 'application/xml', zip: 'application/zip',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ics: 'text/calendar', eml: 'message/rfc822', mp3: 'audio/mpeg', mp4: 'video/mp4', ico: 'image/x-icon',
  };
  return map[ext] ?? 'application/octet-stream';
};

function addresses(field: string, v: unknown, required: boolean): string[] {
  if (v === undefined || v === null || (Array.isArray(v) && v.length === 0 && !required)) {
    if (required) throw E.missingField(field);
    return [];
  }
  const list = toList(v);
  if (!list) throw E.validation(`Invalid \`${field}\` field. ${ADDR_FMT}`);
  if (required && !list.length) throw E.missingField(field);
  for (const a of list) if (!parseAddress(a)) throw E.validation(`Invalid \`${field}\` field. ${ADDR_FMT}`);
  return list.map((a) => a.trim());
}

const bare = (a: string) => parseAddress(a)!.address;

interface TemplateSnapshot {
  subject: string | null;
  html: string;
  text: string | null;
  from: string | null;
  reply_to: string[] | null;
  variables: { key: string; type: string; fallback_value: string | number | null }[];
}

async function loadPublishedTemplate(sql: Sql, teamId: string, idOrAlias: string): Promise<{ id: string; snap: TemplateSnapshot } | null> {
  const [t] = isUuid(idOrAlias)
    ? await sql`select id, published from templates where team_id = ${teamId} and (id = ${idOrAlias} or alias = ${idOrAlias})`
    : await sql`select id, published from templates where team_id = ${teamId} and alias = ${idOrAlias}`;
  if (!t || !t.published) return null;
  return { id: t.id as string, snap: t.published as TemplateSnapshot };
}

/** Validate a POST /emails body. Throws ApiError with Resend's names/messages. */
export async function normalize(ctx: AppContext, auth: AuthContext, body: SendInput, opts: CreateOpts): Promise<NormalizedEmail> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw E.validation('Invalid request body.', 422);
  let template: { id: string; snap: TemplateSnapshot } | null = null;
  let vars: Vars = {};
  if (body.template !== undefined && body.template !== null) {
    const t = body.template as { id?: unknown; variables?: unknown };
    if (typeof t !== 'object' || typeof t.id !== 'string' || !t.id) throw E.missingField('template.id');
    if (body.html !== undefined || body.text !== undefined || body.react !== undefined) {
      throw E.validation('You cannot use `html`, `text` or `react` together with `template`.');
    }
    template = await loadPublishedTemplate(ctx.sql, auth.team.id, t.id);
    if (!template) throw E.notFound('Template not found');
    if (t.variables !== undefined && (typeof t.variables !== 'object' || t.variables === null || Array.isArray(t.variables))) {
      throw E.validation('Invalid `template.variables` field. It must be an object.');
    }
    vars = (t.variables ?? {}) as Vars;
    for (const [k, v] of Object.entries(vars)) {
      if (!/^[A-Za-z0-9_]{1,50}$/.test(k)) throw E.validation(`Invalid template variable key \`${k}\`.`);
      if (typeof v === 'string' && v.length > 2000) throw E.validation(`Template variable \`${k}\` exceeds 2000 characters.`);
      if (typeof v === 'number' && Math.abs(v) > Number.MAX_SAFE_INTEGER) throw E.validation(`Template variable \`${k}\` is too large.`);
    }
  }

  const fromRaw = body.from ?? template?.snap.from ?? undefined;
  if (fromRaw === undefined || fromRaw === null || fromRaw === '') throw E.missingField('from');
  if (typeof fromRaw !== 'string' || !parseAddress(fromRaw, { strict: true })) throw E.validation(`Invalid \`from\` field. ${ADDR_FMT}`);
  const fromParsed = parseAddress(fromRaw, { strict: true })!;
  const to = addresses('to', body.to, true);
  if (to.length > MAX_RECIPIENTS) throw E.validation(`Too many recipients. The \`to\` field can have at most ${MAX_RECIPIENTS} addresses.`);
  const cc = addresses('cc', body.cc, false);
  const bcc = addresses('bcc', body.bcc, false);
  const replyTo = body.reply_to !== undefined ? addresses('reply_to', body.reply_to, false) : (template?.snap.reply_to ?? []);
  const subjectRaw = body.subject ?? template?.snap.subject ?? undefined;
  if (subjectRaw === undefined || subjectRaw === null) throw E.missingField('subject');
  if (typeof subjectRaw !== 'string') throw E.validation('Invalid `subject` field. It must be a string.');

  let html: string | null = null;
  let text: string | null = null;
  let subject = subjectRaw;
  if (template) {
    const defaults: Vars = {};
    for (const v of template.snap.variables ?? []) if (v.fallback_value !== null && v.fallback_value !== undefined) defaults[v.key] = v.fallback_value;
    // RESEND_UNSUBSCRIBE_URL is filled in at send time (broadcast/automation contacts).
    const merged: Vars = { RESEND_UNSUBSCRIBE_URL: '{{{RESEND_UNSUBSCRIBE_URL}}}', ...(opts.contextVars ?? {}), ...defaults, ...vars };
    const missing = new Set<string>();
    html = renderVars(template.snap.html, merged, { html: true, missing });
    text = template.snap.text === '' ? '' : template.snap.text ? renderVars(template.snap.text, merged, { missing }) : null;
    subject = renderVars(subject, merged, { missing });
    if (missing.size) throw E.validation(`Missing required template variables: ${[...missing].map((m) => `\`${m}\``).join(', ')}.`);
  } else {
    if (body.html !== undefined && body.html !== null && typeof body.html !== 'string') throw E.validation('Invalid `html` field. It must be a string.');
    if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') throw E.validation('Invalid `text` field. It must be a string.');
    html = (body.html as string | null | undefined) ?? null;
    text = (body.text as string | null | undefined) ?? null;
    if (html === null && text === null) throw E.missingFields('Missing `html` or `text` field.');
  }
  // Resend derives text from html unless text was explicitly "" (opt-out).
  if (text === null && html) text = htmlToText(html);
  if (text === '') text = null;

  let headers: Record<string, string> | null = null;
  if (body.headers !== undefined && body.headers !== null) {
    if (typeof body.headers !== 'object' || Array.isArray(body.headers)) throw E.validation('Invalid `headers` field. It must be an object.');
    headers = {};
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
      if (!/^[!-9;-~]+$/.test(k)) throw E.validation(`Invalid header name \`${k}\`.`);
      if (typeof v !== 'string' && typeof v !== 'number') throw E.validation(`Invalid value for header \`${k}\`. It must be a string.`);
      if (/[\r\n\0]/.test(String(v))) throw E.validation(`Invalid value for header \`${k}\`.`);
      headers[k] = String(v);
    }
  }

  let tags: { name: string; value: string }[] | null = null;
  if (body.tags !== undefined && body.tags !== null) {
    if (!Array.isArray(body.tags)) throw E.validation('Invalid `tags` field. It must be an array.');
    if (body.tags.length > MAX_TAGS) throw E.validation(`Too many tags. An email can have at most ${MAX_TAGS} tags.`);
    tags = [];
    for (const t of body.tags as { name?: unknown; value?: unknown }[]) {
      if (!t || typeof t.name !== 'string') throw E.missingField('tags.name');
      if (typeof t.value !== 'string') throw E.missingField('tags.value');
      if (!TAG_RE.test(t.name)) throw E.validation('Tags should only contain ASCII letters (a–z, A–Z), numbers (0–9), underscores (_), or dashes (-), and must be at most 256 characters.');
      if (!TAG_RE.test(t.value)) throw E.validation('Tags should only contain ASCII letters (a–z, A–Z), numbers (0–9), underscores (_), or dashes (-), and must be at most 256 characters.');
      tags.push({ name: t.name, value: t.value });
    }
  }

  const attachments: NormalizedAttachment[] = [];
  if (body.attachments !== undefined && body.attachments !== null) {
    if (opts.batch) throw E.validation('The `attachments` field is not supported for batch emails.');
    if (!Array.isArray(body.attachments)) throw E.validation('Invalid `attachments` field. It must be an array.');
    for (const a of body.attachments as InputAttachment[]) {
      if (!a || typeof a !== 'object') throw E.invalidAttachment();
      const hasContent = a.content !== undefined && a.content !== null && a.content !== '';
      const hasPath = typeof a.path === 'string' && a.path !== '';
      if (!hasContent && !hasPath) throw E.invalidAttachment();
      let filename: string | null = typeof a.filename === 'string' && a.filename ? a.filename : null;
      if (!filename && hasPath) {
        let last = '';
        try {
          last = new URL(String(a.path)).pathname.split('/').pop() || '';
        } catch {
          throw E.invalidAttachment('Invalid attachment `path`. It must be a valid URL.');
        }
        try {
          filename = decodeURIComponent(last) || null;
        } catch {
          throw E.invalidAttachment('Invalid attachment `path`. It contains a malformed percent-encoded sequence.');
        }
      }
      const blocked = blockedExtension(filename);
      if (blocked) throw E.invalidAttachment(`Attachments with the \`.${blocked}\` extension are not supported.`);
      let content: Buffer | null = null;
      if (hasContent) {
        if (typeof a.content === 'string') content = Buffer.from(a.content, 'base64');
        else if (Array.isArray(a.content)) content = Buffer.from(a.content as number[]);
        else if (typeof a.content === 'object' && (a.content as { type?: string; data?: number[] }).type === 'Buffer') content = Buffer.from((a.content as { data: number[] }).data);
        else throw E.invalidAttachment('Invalid attachment `content`. It must be a base64 string or a Buffer.');
      }
      if (hasPath) {
        let u: URL;
        try {
          u = new URL(String(a.path));
        } catch {
          throw E.invalidAttachment('Invalid attachment `path`. It must be a valid URL.');
        }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw E.invalidAttachment('Invalid attachment `path`. It must be an http or https URL.');
      }
      if (a.content_id !== undefined && a.content_id !== null && typeof a.content_id !== 'string') throw E.invalidAttachment('Invalid attachment `content_id`. It must be a string.');
      const contentId = typeof a.content_id === 'string' && a.content_id ? a.content_id.replace(/^<|>$/g, '') : null;
      if (contentId && contentId.length >= 128) throw E.invalidAttachment('Invalid attachment `content_id`. It must be less than 128 characters.');
      if (contentId && /[\s<>\0]/.test(contentId)) throw E.invalidAttachment('Invalid attachment `content_id`.');
      attachments.push({
        filename,
        contentType: typeof a.content_type === 'string' && a.content_type ? a.content_type : contentTypeFor(filename),
        contentId,
        disposition: contentId ? 'inline' : 'attachment',
        content,
        path: hasPath ? String(a.path) : null,
      });
    }
  }

  // Size: 40 MB per email after base64 encoding of attachments.
  const b64 = attachments.reduce((n, a) => n + (a.content ? Math.ceil(a.content.length / 3) * 4 : 0), 0);
  const sizeBytes = b64 + Buffer.byteLength(html ?? '') + Buffer.byteLength(text ?? '') + Buffer.byteLength(subject);
  if (sizeBytes > MAX_EMAIL_BYTES) throw E.validation('The email exceeds the maximum size of 40MB, including attachments after Base64 encoding.');
  // Cloudflare Email Sending (the relay behind TRANSPORT=cloudflare) caps the whole MIME message at 5 MiB.
  if (ctx.config.transport === 'cloudflare' && sizeBytes > CLOUDFLARE_MAX_BYTES) {
    throw E.validation('The email exceeds the maximum size of 5MB supported by this server, including attachments after Base64 encoding.');
  }

  let scheduledAt: Date | null = null;
  if (body.scheduled_at !== undefined && body.scheduled_at !== null && body.scheduled_at !== '') {
    if (typeof body.scheduled_at !== 'string') throw E.validation('Invalid `scheduled_at` field. Use ISO 8601 or natural language (e.g. "in 1 min").');
    if (opts.source === 'smtp') throw E.validation('Emails sent via SMTP cannot be scheduled.');
    scheduledAt = parseWhen(body.scheduled_at, ctx.now());
    if (!scheduledAt) throw E.validation('Invalid `scheduled_at` field. Use ISO 8601 (e.g. 2026-08-05T11:52:01.858Z) or natural language (e.g. "in 1 min").');
    if (scheduledAt.getTime() <= ctx.now().getTime() - 1000) throw E.validation('The `scheduled_at` date must be in the future.');
    if (scheduledAt.getTime() > ctx.now().getTime() + MAX_SCHEDULE_DAYS * 86400_000) throw E.validation('Emails can be scheduled up to 30 days in advance.');
    if (scheduledAt.getTime() <= ctx.now().getTime()) scheduledAt = null;
  }

  let topicId: string | null = null;
  if (body.topic_id !== undefined && body.topic_id !== null && body.topic_id !== '') {
    if (!isUuid(body.topic_id)) throw E.invalidUuid('topic_id');
    const [t] = await ctx.sql`select id from topics where team_id = ${auth.team.id} and id = ${body.topic_id}`;
    if (!t) throw E.notFound('Topic not found');
    topicId = body.topic_id;
  }

  // Sender domain checks.
  const fromDomain = domainOf(fromParsed.address);
  let domainId: string | null = null;
  const sandbox = fromDomain === ctx.config.sandboxDomain;
  if (sandbox) {
    const allowed = await sandboxRecipients(ctx.sql, auth.team.id);
    const all = [...to, ...cc, ...bcc].map(bare);
    const bad = all.find((r) => !TEST_ADDRESS_RE.test(r) && !allowed.has(r.toLowerCase()));
    if (bad) {
      const own = [...allowed][0] ?? 'youremail@domain.com';
      throw E.forbidden(
        `You can only send testing emails to your own email address (${own}). To send emails to other recipients, please verify a domain at ${ctx.config.dashboardBase.replace(/^https?:\/\//, '')}/domains, and change the \`from\` address to an email using this domain.`,
      );
    }
    if (auth.domainId) throw E.forbidden(`This API key can only send emails from its domain. The \`${fromDomain}\` domain is not allowed.`);
  } else {
    const [d] = await ctx.sql`select id, status, sending from domains where team_id = ${auth.team.id} and lower(name) = ${fromDomain}`;
    if (!d || d.status !== 'verified' || d.sending !== 'enabled') {
      throw E.forbidden(`The ${fromDomain} domain is not verified. Please, add and verify your domain on ${ctx.config.dashboardBase.replace(/^https?:\/\//, '')}/domains`);
    }
    if (auth.domainId && auth.domainId !== d.id) throw E.forbidden(`This API key is restricted to another domain and cannot send emails from \`${fromDomain}\`.`);
    domainId = d.id as string;
  }

  return {
    from: fromRaw.trim(),
    fromAddress: fromParsed.address,
    fromDomain,
    domainId,
    sandbox,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    html,
    text,
    headers,
    tags,
    attachments,
    scheduledAt,
    topicId,
    templateId: template?.id ?? null,
    sizeBytes,
  };
}

/** Team members may receive sandbox (resend.dev) emails, like Resend's "your own email address". */
async function sandboxRecipients(sql: Sql, teamId: string): Promise<Set<string>> {
  const rows = await sql`select email from team_members where team_id = ${teamId} order by role = 'admin' desc, created_at`;
  return new Set(rows.map((r) => (r.email as string).toLowerCase()));
}

export interface QuotaUsage {
  daily: number;
  monthly: number;
}

export async function quotaUsage(sql: Sql, teamId: string, now: Date): Promise<QuotaUsage> {
  const [r] = await sql`
    select count(*) filter (where created_at >= ${startOfUtcDay(now).toISOString()})::int as daily,
           count(*)::int as monthly
    from emails
    where team_id = ${teamId} and created_at >= ${startOfUtcMonth(now).toISOString()}
      and source not in ('broadcast')`;
  const [recv] = await sql`
    select count(*) filter (where created_at >= ${startOfUtcDay(now).toISOString()})::int as daily, count(*)::int as monthly
    from received_emails where team_id = ${teamId} and created_at >= ${startOfUtcMonth(now).toISOString()}`;
  return { daily: (r!.daily as number) + (recv!.daily as number), monthly: (r!.monthly as number) + (recv!.monthly as number) };
}

export async function checkQuota(ctx: AppContext, auth: AuthContext, n: number): Promise<QuotaUsage> {
  const u = await quotaUsage(ctx.sql, auth.team.id, ctx.now());
  if (auth.team.daily_quota !== null && u.daily + n > auth.team.daily_quota) throw E.dailyQuota();
  if (u.monthly + n > auth.team.monthly_quota) throw E.monthlyQuota();
  return u;
}

/** Persist validated emails and queue them. Returns ids in input order. */
export async function persist(ctx: AppContext, auth: AuthContext, emails: NormalizedEmail[], opts: CreateOpts): Promise<string[]> {
  const ids: string[] = [];
  const rows: EmailRow[] = [];
  await ctx.sql.begin(async (tx) => {
    for (const n of emails) {
      const id = uuid();
      const messageId = `<${id}@${n.sandbox ? 'resend.dev' : n.fromDomain}>`;
      const [row] = await tx`
        insert into emails (id, team_id, api_key_id, domain_id, source, from_addr, to_addrs, cc, bcc, reply_to, subject, html, text,
                            headers, tags, topic_id, template_id, broadcast_id, contact_id, automation_run_id, scheduled_at, last_event, message_id, size_bytes)
        values (${id}, ${auth.team.id}, ${auth.apiKeyId}, ${n.domainId}, ${opts.source}, ${n.from}, ${n.to}, ${n.cc.length ? n.cc : null},
                ${n.bcc.length ? n.bcc : null}, ${n.replyTo.length ? n.replyTo : null}, ${n.subject}, ${n.html}, ${n.text},
                ${n.headers ? tx.json(n.headers) : null}, ${n.tags ? tx.json(n.tags as never) : null}, ${n.topicId}, ${n.templateId},
                ${opts.broadcastId ?? null}, ${opts.contactId ?? null}, ${opts.automationRunId ?? null},
                ${n.scheduledAt ? n.scheduledAt.toISOString() : null}, ${n.scheduledAt ? 'scheduled' : 'queued'}, ${messageId}, ${n.sizeBytes})
        returning id, team_id, domain_id, broadcast_id, template_id, contact_id, from_addr, to_addrs, cc, bcc, subject, message_id, tags, created_at`;
      for (const a of n.attachments) {
        await tx`
          insert into email_attachments (email_id, team_id, filename, content_type, content_id, disposition, size, content, path)
          values (${id}, ${auth.team.id}, ${a.filename}, ${a.contentType}, ${a.contentId}, ${a.disposition}, ${a.content?.length ?? 0}, ${a.content}, ${a.path})`;
      }
      ids.push(id);
      rows.push(row as unknown as EmailRow);
      await tx`
        insert into jobs (kind, payload, run_at, unique_key, max_attempts)
        values ('send_email', ${tx.json({ emailId: id })}, ${(n.scheduledAt ?? ctx.now()).toISOString()}, ${`email:${id}`}, 6)`;
    }
  });
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    await recordEvent(ctx, row, emails[i]!.scheduledAt ? 'scheduled' : 'queued', { webhook: !!emails[i]!.scheduledAt });
  }
  await ctx.sql`select pg_notify('send_jobs', 'send_email')`;
  return ids;
}

/** Convenience: validate + quota + persist one email. */
export async function createEmail(ctx: AppContext, auth: AuthContext, body: SendInput, opts: CreateOpts): Promise<string> {
  const n = await normalize(ctx, auth, body, opts);
  if (!opts.skipQuota) await checkQuota(ctx, auth, 1);
  const [id] = await persist(ctx, auth, [n], opts);
  return id!;
}

export interface BatchResult {
  data: { id: string }[];
  errors?: { index: number; message: string }[];
}

export async function createBatch(ctx: AppContext, auth: AuthContext, bodies: unknown, mode: 'strict' | 'permissive', opts: CreateOpts): Promise<BatchResult> {
  if (!Array.isArray(bodies)) throw E.validation('The request body must be an array of emails.');
  if (bodies.length === 0) throw E.validation('The batch must contain at least one email.');
  if (bodies.length > 100) throw E.validation('Too many emails in the batch. The maximum is 100.');
  const ok: { index: number; n: NormalizedEmail }[] = [];
  const errors: { index: number; message: string }[] = [];
  for (let i = 0; i < bodies.length; i++) {
    try {
      ok.push({ index: i, n: await normalize(ctx, auth, bodies[i] as SendInput, { ...opts, batch: true }) });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (mode === 'strict') throw new ApiError(e.statusCode, e.errorName, bodies.length > 1 ? `${e.message.replace(/\.$/, '')} at index ${i}.` : e.message);
      errors.push({ index: i, message: e.message });
    }
  }
  if (ok.length) await checkQuota(ctx, auth, ok.length);
  const ids = ok.length ? await persist(ctx, auth, ok.map((o) => o.n), opts) : [];
  const data = ids.map((id) => ({ id }));
  return mode === 'permissive' ? { data, errors } : { data };
}
