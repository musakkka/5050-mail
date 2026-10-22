/**
 * Broadcasts: drafts, scheduling and the fan-out worker job.
 * Fan-out creates one email per subscribed contact through the regular send
 * pipeline (persist → send_email job), so events, webhooks and suppressions
 * behave exactly like transactional emails.
 */
import type { AppContext } from '../context.js';
import { parseAddress } from '../lib/address.js';
import { ApiError, E } from '../lib/errors.js';
import { isUuid } from '../lib/ids.js';
import { parseWhen } from '../lib/time.js';
import { loadTeam, type AuthContext } from './apiKeys.js';
import { normalize, persist, TEST_ADDRESS_RE, type NormalizedEmail } from './emails.js';
import { cancelJob, enqueue } from './jobs.js';
import { escapeHtml, htmlToText, renderVars, type Vars } from './render.js';

/** Contacts per fan-out job (BROADCAST_FANOUT_BATCH overrides, e.g. in tests). */
export const fanoutBatch = () => Math.max(1, Number(process.env.BROADCAST_FANOUT_BATCH ?? 500));
export const MAX_SCHEDULE_DAYS = 30;
const ADDR_FMT = 'The email address needs to follow the `email@example.com` or `Name <email@example.com>` format';

export interface BroadcastRow {
  id: string;
  team_id: string;
  name: string | null;
  segment_id: string | null;
  audience_id: string | null;
  from_addr: string | null;
  subject: string | null;
  reply_to: string[] | null;
  preview_text: string | null;
  html: string | null;
  text: string | null;
  topic_id: string | null;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string;
}

export function broadcastObject(b: BroadcastRow) {
  return {
    object: 'broadcast',
    id: b.id,
    name: b.name,
    audience_id: b.segment_id,
    segment_id: b.segment_id,
    from: b.from_addr,
    subject: b.subject,
    reply_to: b.reply_to,
    preview_text: b.preview_text,
    html: b.html,
    text: b.text,
    status: b.status,
    created_at: b.created_at,
    scheduled_at: b.scheduled_at,
    sent_at: b.sent_at,
    topic_id: b.topic_id,
  };
}

export const broadcastListItem = (b: BroadcastRow) => ({
  id: b.id,
  name: b.name,
  audience_id: b.segment_id,
  segment_id: b.segment_id,
  status: b.status,
  created_at: b.created_at,
  scheduled_at: b.scheduled_at,
  sent_at: b.sent_at,
  topic_id: b.topic_id,
});

export interface BroadcastInput {
  name?: unknown;
  segment_id?: unknown;
  audience_id?: unknown;
  from?: unknown;
  subject?: unknown;
  reply_to?: unknown;
  preview_text?: unknown;
  html?: unknown;
  text?: unknown;
  topic_id?: unknown;
  send?: unknown;
  scheduled_at?: unknown;
}

function str(field: string, v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw E.validation(`Invalid \`${field}\` field. It must be a string.`);
  return v;
}

function replyTo(v: unknown): string[] | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : null;
  if (!list || !list.every((x) => typeof x === 'string' && parseAddress(x))) throw new ApiError(422, 'invalid_parameter', `Invalid \`reply_to\` field. ${ADDR_FMT}`);
  return list.length ? (list as string[]) : null;
}

async function checkRefs(ctx: AppContext, teamId: string, segmentId: string | null | undefined, topicId: string | null | undefined) {
  if (segmentId) {
    if (!isUuid(segmentId)) throw E.invalidUuid('segment_id');
    const [s] = await ctx.sql`select id from segments where id = ${segmentId} and team_id = ${teamId}`;
    if (!s) throw E.notFound('Segment not found');
  }
  if (topicId) {
    if (!isUuid(topicId)) throw E.invalidUuid('topic_id');
    const [t] = await ctx.sql`select id from topics where id = ${topicId} and team_id = ${teamId}`;
    if (!t) throw E.notFound('Topic not found');
  }
}

function fromField(v: unknown, required: boolean): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw E.missingField('from');
    return undefined;
  }
  if (typeof v !== 'string' || !parseAddress(v)) throw new ApiError(422, 'invalid_parameter', `Invalid \`from\` field. ${ADDR_FMT}`);
  return v.trim();
}

export async function createBroadcast(ctx: AppContext, auth: AuthContext, b: BroadcastInput): Promise<BroadcastRow> {
  const segmentId = str('segment_id', b.segment_id) ?? str('audience_id', b.audience_id);
  if (!segmentId) throw E.missingField('segment_id');
  const from = fromField(b.from, true)!;
  const subject = str('subject', b.subject);
  if (!subject) throw E.missingField('subject');
  const topicId = str('topic_id', b.topic_id);
  await checkRefs(ctx, auth.team.id, segmentId, topicId);
  if (b.send !== undefined && typeof b.send !== 'boolean') throw E.validation('Invalid `send` field. It must be a boolean.');
  if (b.scheduled_at !== undefined && b.scheduled_at !== null && b.send !== true) throw E.validation('The `scheduled_at` field can only be used when `send` is `true`.');
  const [row] = await ctx.sql`
    insert into broadcasts (team_id, name, segment_id, audience_id, from_addr, subject, reply_to, preview_text, html, text, topic_id)
    values (${auth.team.id}, ${str('name', b.name) ?? null}, ${segmentId}, ${segmentId}, ${from}, ${subject}, ${replyTo(b.reply_to) ?? null},
            ${str('preview_text', b.preview_text) ?? null}, ${str('html', b.html) ?? null}, ${str('text', b.text) ?? null}, ${topicId ?? null})
    returning *`;
  const bc = row as unknown as BroadcastRow;
  if (b.send === true) await sendBroadcast(ctx, auth, bc, b.scheduled_at);
  return bc;
}

export async function updateBroadcast(ctx: AppContext, auth: AuthContext, bc: BroadcastRow, b: BroadcastInput): Promise<void> {
  const editable = bc.status === 'draft' || bc.status === 'scheduled';
  const keys = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (!editable && keys.some((k) => k !== 'name')) throw E.validation(`Broadcasts with status \`${bc.status}\` can only have their name updated.`);
  const segmentId = str('segment_id', b.segment_id) ?? str('audience_id', b.audience_id);
  const topicId = str('topic_id', b.topic_id);
  await checkRefs(ctx, auth.team.id, segmentId, topicId);
  const from = fromField(b.from, false);
  const pick = <T>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
  await ctx.sql`
    update broadcasts set
      name = ${pick(str('name', b.name), bc.name)},
      segment_id = ${pick(segmentId, bc.segment_id)}, audience_id = ${pick(segmentId, bc.segment_id)},
      from_addr = ${pick(from, bc.from_addr)},
      subject = ${pick(str('subject', b.subject), bc.subject)},
      reply_to = ${pick(replyTo(b.reply_to), bc.reply_to)},
      preview_text = ${pick(str('preview_text', b.preview_text), bc.preview_text)},
      html = ${pick(str('html', b.html), bc.html)},
      text = ${pick(str('text', b.text), bc.text)},
      topic_id = ${pick(topicId, bc.topic_id)},
      updated_at = now()
    where id = ${bc.id}`;
}

/** Validate sender/content once (as POST /emails would) and return the base email. */
async function baseEmail(ctx: AppContext, auth: AuthContext, bc: BroadcastRow): Promise<NormalizedEmail> {
  if (!bc.segment_id) throw E.missingField('segment_id');
  if (!bc.from_addr) throw E.missingField('from');
  if (!bc.subject) throw E.missingField('subject');
  // Recipient is a placeholder: per-contact recipients are set during fan-out.
  return normalize(ctx, auth, { from: bc.from_addr, to: ['delivered@resend.dev'], subject: bc.subject, html: bc.html ?? undefined, text: bc.text ?? undefined, reply_to: bc.reply_to ?? undefined }, { source: 'broadcast' });
}

export async function sendBroadcast(ctx: AppContext, auth: AuthContext, bc: BroadcastRow, scheduledAt: unknown): Promise<void> {
  if (bc.status !== 'draft') throw E.validation(`Broadcasts with status \`${bc.status}\` cannot be sent. Only draft broadcasts can be sent.`);
  await baseEmail(ctx, auth, bc);
  let when: Date | null = null;
  if (scheduledAt !== undefined && scheduledAt !== null && scheduledAt !== '') {
    if (typeof scheduledAt !== 'string') throw E.validation('Invalid `scheduled_at` field.');
    when = parseWhen(scheduledAt, ctx.now());
    if (!when) throw E.validation('Invalid `scheduled_at` field. Use ISO 8601 (e.g. 2026-08-05T11:52:01.858Z) or natural language (e.g. "in 1 min").');
    if (when.getTime() <= ctx.now().getTime() - 1000) throw E.validation('The `scheduled_at` date must be in the future.');
    if (when.getTime() > ctx.now().getTime() + MAX_SCHEDULE_DAYS * 86400_000) throw E.validation('Broadcasts can be scheduled up to 30 days in advance.');
    if (when.getTime() <= ctx.now().getTime()) when = null;
  }
  if (when) {
    await ctx.sql`update broadcasts set status = 'scheduled', scheduled_at = ${when.toISOString()}, updated_at = now() where id = ${bc.id}`;
  } else {
    await ctx.sql`update broadcasts set status = 'queued', scheduled_at = null, updated_at = now() where id = ${bc.id}`;
  }
  await enqueue(ctx.sql, 'broadcast_fanout', { broadcastId: bc.id }, { runAt: when ?? ctx.now(), uniqueKey: `broadcast:${bc.id}` });
}

/** scheduled → draft (no emails sent); queued → canceled (stops remaining recipients). */
export async function cancelBroadcast(ctx: AppContext, bc: BroadcastRow): Promise<void> {
  if (bc.status === 'scheduled') {
    await cancelJob(ctx.sql, `broadcast:${bc.id}`);
    await ctx.sql`update broadcasts set status = 'draft', scheduled_at = null, updated_at = now() where id = ${bc.id}`;
    return;
  }
  if (bc.status === 'queued') {
    await ctx.sql`update broadcasts set status = 'canceled', updated_at = now() where id = ${bc.id}`;
    await ctx.sql`delete from jobs where unique_key like ${`broadcast:${bc.id}%`} and locked_at is null`;
    const pending = await ctx.sql`update emails set last_event = 'canceled', last_event_at = now(), updated_at = now()
                                  where broadcast_id = ${bc.id} and last_event = 'queued' returning id`;
    if (pending.length) await ctx.sql`delete from jobs where unique_key = any(${pending.map((p) => `email:${p.id}`)}) and locked_at is null`;
    return;
  }
  throw E.validation(`Broadcasts with status \`${bc.status}\` cannot be canceled. Only queued or scheduled broadcasts can be canceled.`);
}

export async function duplicateBroadcast(ctx: AppContext, bc: BroadcastRow): Promise<string> {
  const name = `${bc.name ?? ''} (copy)`.slice(0, 70);
  const [row] = await ctx.sql`
    insert into broadcasts (team_id, name, segment_id, audience_id, from_addr, subject, reply_to, preview_text, html, text, topic_id)
    values (${bc.team_id}, ${name}, ${bc.segment_id}, ${bc.segment_id}, ${bc.from_addr}, ${bc.subject}, ${bc.reply_to}, ${bc.preview_text}, ${bc.html}, ${bc.text}, ${bc.topic_id})
    returning id`;
  return row!.id as string;
}

function contactVars(c: Record<string, unknown>): Vars {
  const v: Vars = {
    'contact.first_name': c.first_name as string | null,
    'contact.last_name': c.last_name as string | null,
    'contact.email': c.email as string,
    FIRST_NAME: c.first_name as string | null,
    LAST_NAME: c.last_name as string | null,
    EMAIL: c.email as string,
    // Left for delivery, which knows the per-email unsubscribe URL.
    RESEND_UNSUBSCRIBE_URL: '{{{RESEND_UNSUBSCRIBE_URL}}}',
  };
  for (const [k, val] of Object.entries((c.properties as Record<string, unknown>) ?? {})) {
    if (val === null || typeof val === 'object') continue;
    v[`contact.${k}`] = val as string | number;
    if (!(k in v)) v[k] = val as string | number;
  }
  return v;
}

function withPreheader(html: string, preview: string | null): string {
  if (!preview) return html;
  const pre = `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(preview)}</div>`;
  return /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => m + pre) : pre + html;
}

/**
 * One fan-out batch (worker job `broadcast_fanout`). Payload: { broadcastId, after? }.
 * Re-enqueues itself with a contact cursor until the segment is exhausted.
 */
export async function runFanout(ctx: AppContext, payload: { broadcastId: string; after?: string }): Promise<void> {
  const [row] = await ctx.sql`select * from broadcasts where id = ${payload.broadcastId}`;
  if (!row) return;
  const bc = row as unknown as BroadcastRow;
  if (bc.status === 'canceled' || bc.status === 'sent' || bc.status === 'draft') return;
  if (bc.status === 'scheduled') await ctx.sql`update broadcasts set status = 'queued', updated_at = now() where id = ${bc.id}`;
  const team = await loadTeam(ctx.sql, bc.team_id);
  if (!team) return;
  const auth: AuthContext = { team, apiKeyId: null, permission: 'full_access', domainId: null, source: 'api' };
  let base: NormalizedEmail;
  try {
    base = await baseEmail(ctx, auth, bc);
  } catch (e) {
    ctx.log('broadcasts', 'broadcast cannot be sent', { broadcastId: bc.id, error: (e as Error).message });
    await ctx.sql`update broadcasts set status = 'draft', updated_at = now() where id = ${bc.id}`;
    return;
  }
  let topicDefault: string | null = null;
  if (bc.topic_id) {
    const [t] = await ctx.sql`select default_subscription from topics where id = ${bc.topic_id}`;
    topicDefault = (t?.default_subscription as string | undefined) ?? 'opt_out';
  }
  const contacts = await ctx.sql`
    select c.*, ct.subscription from contacts c
    join contact_segments cs on cs.contact_id = c.id and cs.segment_id = ${bc.segment_id}
    left join contact_topics ct on ct.contact_id = c.id and ct.topic_id = ${bc.topic_id}
    where c.team_id = ${bc.team_id} and c.unsubscribed = false
      ${payload.after ? ctx.sql`and c.id > ${payload.after}` : ctx.sql``}
      and not exists (select 1 from emails e where e.broadcast_id = ${bc.id} and e.contact_id = c.id)
    order by c.id
    limit ${fanoutBatch()}`;
  const allowedSandbox = base.sandbox
    ? new Set((await ctx.sql`select lower(email) as e from team_members where team_id = ${bc.team_id}`).map((r) => r.e as string))
    : null;
  const emails: { n: NormalizedEmail; contactId: string }[] = [];
  for (const c of contacts) {
    if (bc.topic_id && ((c.subscription as string | null) ?? topicDefault) !== 'opt_in') continue;
    const email = c.email as string;
    if (allowedSandbox && !TEST_ADDRESS_RE.test(email) && !allowedSandbox.has(email.toLowerCase())) continue;
    const vars = contactVars(c);
    let html = bc.html ? renderVars(bc.html, vars, { html: true }) : null;
    if (html) html = withPreheader(html, bc.preview_text);
    let text = bc.text !== null && bc.text !== undefined ? renderVars(bc.text, vars) : null;
    if (text === null && html) text = htmlToText(html);
    if (text === '') text = null;
    emails.push({
      contactId: c.id as string,
      n: { ...base, to: [email], cc: [], bcc: [], subject: renderVars(bc.subject ?? '', vars), html, text, topicId: bc.topic_id, attachments: [] },
    });
  }
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    // Contact ids differ per email, so persist one at a time within the chunk.
    for (const e of chunk) await persist(ctx, auth, [e.n], { source: 'broadcast', broadcastId: bc.id, contactId: e.contactId, skipQuota: true });
  }
  if (contacts.length === fanoutBatch()) {
    await enqueue(ctx.sql, 'broadcast_fanout', { broadcastId: bc.id, after: contacts.at(-1)!.id as string }, { uniqueKey: `broadcast:${bc.id}:${contacts.at(-1)!.id}` });
    return;
  }
  await ctx.sql`update broadcasts set status = 'sent', sent_at = now(), updated_at = now() where id = ${bc.id} and status = 'queued'`;
}

// ------------------------------------------------------------------ recipients & clicked links

/** Opaque offset cursors, like Resend's `b2Zmc2V0OjA` (= base64 "offset:0"). */
export const offsetCursor = (i: number) => Buffer.from(`offset:${i}`).toString('base64url');
export function parseOffsetCursor(name: string, c: string): number {
  const m = /^offset:(\d+)$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
  if (!m) throw E.validation(`The \`${name}\` parameter must be a valid cursor. See https://resend.com/docs/pagination for more information.`);
  return Number(m[1]);
}

/** Slice an ordered list with offset cursors; returns rows with their cursor ids. */
export function pageByOffset<T>(rows: T[], page: { limit: number | null; after?: string; before?: string }) {
  const limit = page.limit ?? 20;
  let start = 0;
  let end = rows.length;
  if (page.after) start = parseOffsetCursor('after', page.after) + 1;
  if (page.before) {
    end = Math.min(rows.length, parseOffsetCursor('before', page.before));
    start = Math.max(0, end - limit);
  }
  const slice = rows.slice(start, Math.min(end, start + limit));
  const hasMore = page.before ? start > 0 : start + limit < end;
  return { data: slice.map((r, i) => ({ id: offsetCursor(start + i), ...r })), hasMore };
}

export const RECIPIENT_TYPES = ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed', 'suppressed'] as const;

export async function listRecipients(ctx: AppContext, bc: BroadcastRow, type: string, email: string | undefined, bounceType: string | undefined) {
  const events = await ctx.sql`
    select ev.email_id, ev.data, e.contact_id, e.to_addrs[1] as email
    from email_events ev join emails e on e.id = ev.email_id
    where ev.broadcast_id = ${bc.id} and ev.team_id = ${bc.team_id} and ev.type = ${type}
      ${email ? ctx.sql`and e.to_addrs[1] ilike ${'%' + email.replace(/[%_\\]/g, '\\$&') + '%'}` : ctx.sql``}
    order by e.to_addrs[1], ev.id`;
  const contacts = new Set((await ctx.sql`select id from contacts where team_id = ${bc.team_id} and id = any(${[...new Set(events.map((e) => e.contact_id as string).filter(Boolean))]})`).map((r) => r.id as string));
  const byEmail = new Map<string, { contact_id: string | null; email: string; count: number; links: Map<string, number>; bounce?: string }>();
  for (const ev of events) {
    const key = ev.email as string;
    type G = { contact_id: string | null; email: string; count: number; links: Map<string, number>; bounce?: string };
    const g: G = byEmail.get(key) ?? { contact_id: ev.contact_id && contacts.has(ev.contact_id as string) ? (ev.contact_id as string) : null, email: key, count: 0, links: new Map() };
    g.count++;
    const data = (ev.data ?? {}) as { click?: { link?: string }; bounce?: { type?: string } };
    if (data.click?.link) g.links.set(data.click.link, (g.links.get(data.click.link) ?? 0) + 1);
    if (data.bounce) {
      const t = (data.bounce.type ?? '').toLowerCase();
      g.bounce = t === 'permanent' ? 'permanent' : t === 'transient' ? 'transient' : 'undetermined';
    }
    byEmail.set(key, g);
  }
  let rows = [...byEmail.values()];
  if (bounceType) rows = rows.filter((r) => r.bounce === bounceType);
  return rows.map((r) => ({
    contact_id: r.contact_id,
    email: r.email,
    ...(type === 'opened' || type === 'clicked' ? { count: r.count } : {}),
    ...(type === 'clicked' ? { clicked_links: [...r.links].map(([url, clicks]) => ({ url, clicks })) } : {}),
    ...(type === 'bounced' ? { bounce_type: r.bounce ?? 'undetermined' } : {}),
  }));
}

export async function listClickedLinks(ctx: AppContext, bc: BroadcastRow) {
  const rows = await ctx.sql`
    select ev.data->'click'->>'link' as url, count(*)::int as clicks, count(distinct ev.email_id)::int as unique_clicks
    from email_events ev
    where ev.broadcast_id = ${bc.id} and ev.team_id = ${bc.team_id} and ev.type = 'clicked' and ev.data->'click'->>'link' is not null
    group by 1 order by 2 desc, 1`;
  return rows.map((r) => ({ url: r.url as string, clicks: r.clicks as number, unique_clicks: r.unique_clicks as number }));
}
