/**
 * Inboxes (Resend's shared-mailbox product): inboxes, threads, labels, drafts.
 * Inbound mail is attached to threads by ingestRaw() (services/inbound.ts);
 * outbound replies/forwards/drafts go through the normal send pipeline
 * (normalize → persist, source 'inbox') and are added to the thread.
 */
import type { AppContext } from '../context.js';
import { blockedExtension } from '../lib/attachments.js';
import { pgToIso } from '../db.js';
import { domainOf, isEmail, parseAddress } from '../lib/address.js';
import { ApiError, E } from '../lib/errors.js';
import { UUID_RE } from '../lib/ids.js';
import type { AuthContext } from './apiKeys.js';
import { checkQuota, normalize, persist, type SendInput } from './emails.js';
import { emit, type WebhookEventType } from './webhooks.js';

export const FOLDERS = ['inbox', 'archive', 'spam', 'sent', 'trash'] as const;
export const MOVE_FOLDERS = ['inbox', 'archive', 'spam', 'trash'] as const;
export const AGENT_ACTIONS = ['draft_reply', 'forward_thread', 'add_labels', 'assign_thread', 'mark_as_spam', 'archive', 'move_to_trash'] as const;
export const AGENT_TONES = ['concise_professional', 'concise_casual', 'expanded_professional', 'expanded_casual'] as const;
const PALETTE = ['#E93D82', '#00A2C7', '#46A758', '#F76B15', '#8E4EC6', '#FFC53D', '#3E63DD', '#E5484D'];
export const randomColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)]!;

type Row = Record<string, unknown>;
export type Source = 'api' | 'dashboard' | 'agent' | 'system';
export const sourceOf = (auth: AuthContext): Source => (auth.source === 'dashboard' ? 'dashboard' : 'api');
const iso = (v: unknown) => pgToIso(v as string | null);

// ------------------------------------------------------------ inbox lookup / views

/** `inbox_id` path parameter: an Inbox ID or the inbox address (case-insensitive). */
export async function resolveInbox(ctx: AppContext, teamId: string, raw: string): Promise<Row> {
  let key = raw;
  try {
    key = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  let rows;
  if (key.includes('@')) {
    if (!isEmail(key)) throw E.validation('The `inbox_id` must be a valid UUID or email address.');
    rows = await ctx.sql`select * from inboxes where team_id = ${teamId} and lower(email_address) = ${key.toLowerCase()}`;
  } else {
    if (!UUID_RE.test(key)) throw E.validation('The `inbox_id` must be a valid UUID or email address.');
    rows = await ctx.sql`select * from inboxes where team_id = ${teamId} and id = ${key.toLowerCase()}`;
  }
  if (!rows[0]) throw E.notFound('Inbox not found.');
  return rows[0];
}

/** Domain-restricted keys may only use inboxes on their domain (403). */
export function checkInboxDomain(auth: AuthContext, inbox: Row) {
  if (auth.domainId && auth.domainId !== inbox.domain_id) {
    throw new ApiError(403, 'validation_error', 'This API key is restricted to another domain and cannot use this inbox.');
  }
}

async function inboxCounts(ctx: AppContext, inboxId: string) {
  const [r] = await ctx.sql`
    select
      (select count(*)::int from inbox_threads t where t.inbox_id = ${inboxId} and t.folder = 'inbox'
         and exists (select 1 from inbox_messages m where m.thread_id = t.id and not m.read)) as unread,
      (select count(*)::int from inbox_drafts d where d.inbox_id = ${inboxId} and d.sent_at is null) as drafts,
      (select max(m.received_at)::text from inbox_messages m join inbox_threads t on t.id = m.thread_id
         where m.inbox_id = ${inboxId} and m.direction = 'inbound' and t.folder = 'inbox') as last_received`;
  return { unread: r!.unread as number, drafts: r!.drafts as number, last_received: iso(r!.last_received) };
}

export async function inboxObject(ctx: AppContext, i: Row) {
  const c = await inboxCounts(ctx, i.id as string);
  return {
    object: 'inbox',
    id: i.id,
    name: i.name,
    email_address: i.email_address,
    domain_id: i.domain_id,
    receiving_address: i.receiving_address ?? null,
    from_name: i.from_name ?? null,
    unread: c.unread,
    drafts: c.drafts,
    last_received: c.last_received,
    created_at: iso(i.created_at),
    updated_at: iso(i.updated_at),
  };
}

export async function inboxListItem(ctx: AppContext, i: Row) {
  const c = await inboxCounts(ctx, i.id as string);
  return {
    id: i.id, name: i.name, email_address: i.email_address, from_name: i.from_name ?? null,
    unread: c.unread, last_received: c.last_received, created_at: iso(i.created_at), updated_at: iso(i.updated_at),
  };
}

export async function emitInbox(ctx: AppContext, teamId: string, type: WebhookEventType, data: Row) {
  await emit(ctx, teamId, type, data);
}

// ------------------------------------------------------------ threads

export async function threadLabels(ctx: AppContext, threadId: string) {
  const rows = await ctx.sql`select l.id, l.name, l.color from inbox_thread_labels tl join inbox_labels l on l.id = tl.label_id
                             where tl.thread_id = ${threadId} order by l.created_at, l.id`;
  return rows.map((l) => ({ id: l.id, name: l.name, color: l.color }));
}

export async function threadSummary(ctx: AppContext, t: Row) {
  const [r] = await ctx.sql`select bool_and(read) as read from inbox_messages where thread_id = ${t.id as string}`;
  return { object: 'inbox_thread', id: t.id, subject: t.subject ?? null, folder: t.folder, labels: await threadLabels(ctx, t.id as string), read: (r?.read as boolean | null) ?? true };
}

export async function threadView(ctx: AppContext, t: Row) {
  const [last] = await ctx.sql`select * from inbox_messages where thread_id = ${t.id as string} order by received_at desc, id desc limit 1`;
  const [agg] = await ctx.sql`select count(*)::int as n, bool_and(read) as read from inbox_messages where thread_id = ${t.id as string}`;
  const [draft] = await ctx.sql`select 1 from inbox_drafts where thread_id = ${t.id as string} and sent_at is null limit 1`;
  const hasAtt = last ? (await messageAttachments(ctx, last)).length > 0 : false;
  return {
    id: t.id,
    subject: t.subject ?? null,
    from: (last?.from_addr as string | undefined) ?? null,
    to: (last?.to_addrs as string[] | undefined) ?? [],
    cc: (last?.cc as string[] | undefined) ?? [],
    bcc: (last?.bcc as string[] | undefined) ?? [],
    labels: await threadLabels(ctx, t.id as string),
    email_count: agg!.n as number,
    has_attachment: hasAtt,
    has_draft: !!draft,
    read: (agg!.read as boolean | null) ?? true,
    received_at: iso(t.last_activity_at),
    folder: t.folder,
  };
}

export async function loadThread(ctx: AppContext, inbox: Row, threadId: string): Promise<Row> {
  if (!UUID_RE.test(threadId)) throw E.invalidUuid('thread_id');
  const [t] = await ctx.sql`select * from inbox_threads where id = ${threadId} and inbox_id = ${inbox.id as string}`;
  if (!t) throw E.notFound('Thread not found.');
  return t;
}

// ------------------------------------------------------------ messages

export async function messageAttachments(ctx: AppContext, m: Row): Promise<{ id: string; filename: string | null; size: number | null }[]> {
  const rows = m.direction === 'inbound'
    ? await ctx.sql`select id, filename, size from received_attachments where email_id = ${m.id as string} order by created_at, id`
    : await ctx.sql`select id, filename, size from email_attachments where email_id = ${m.id as string} order by created_at, id`;
  return rows.map((a) => ({ id: a.id as string, filename: (a.filename as string | null) ?? null, size: (a.size as number | null) ?? null }));
}

export async function messageView(ctx: AppContext, m: Row, withBody = true) {
  return {
    id: m.id,
    direction: m.direction,
    from: m.from_addr,
    to: m.to_addrs ?? [],
    cc: m.cc ?? [],
    bcc: m.bcc ?? [],
    reply_to: m.reply_to ?? [],
    subject: m.subject ?? null,
    message_id: m.message_id ?? null,
    ...(withBody ? { html: m.html ?? null, text: m.text ?? null } : {}),
    attachments: await messageAttachments(ctx, m),
    read: m.read,
    received_at: iso(m.received_at),
  };
}

export async function loadMessage(ctx: AppContext, thread: Row, emailId: string): Promise<Row> {
  if (!UUID_RE.test(emailId)) throw E.invalidUuid('email_id');
  const [m] = await ctx.sql`select * from inbox_messages where id = ${emailId} and thread_id = ${thread.id as string}`;
  if (!m) throw E.notFound('Email not found.');
  return m;
}

const stripPrefixes = (s: string) => s.replace(/^\s*((re|fwd?|aw|wg|sv)\s*:\s*)+/i, '').trim().toLowerCase();

/** Called by ingestRaw for each team that received a message: add it to every matching inbox thread. */
export async function deliverInboundToInboxes(
  ctx: AppContext,
  teamId: string,
  receivedEmailId: string,
  rcpts: string[],
  msg: { from: string; to: string[]; cc: string[]; replyTo: string[]; subject: string; messageId: string; inReplyTo: string | null; references: string[]; html: string | null; text: string | null },
): Promise<void> {
  const lower = [...new Set(rcpts.map((r) => r.toLowerCase()))];
  const inboxes = await ctx.sql`select * from inboxes where team_id = ${teamId} and (lower(email_address) = any(${lower}) or lower(receiving_address) = any(${lower}))`;
  for (const inbox of inboxes) {
    const delivered = lower.filter((r) => r === (inbox.email_address as string).toLowerCase() || r === ((inbox.receiving_address as string | null) ?? '').toLowerCase());
    const ids = [msg.inReplyTo, ...msg.references].filter((x): x is string => !!x);
    let thread: Row | undefined;
    if (ids.length) {
      [thread] = await ctx.sql`select t.* from inbox_threads t join inbox_messages m on m.thread_id = t.id
                               where m.inbox_id = ${inbox.id as string} and m.message_id = any(${ids}) order by m.received_at desc limit 1`;
    }
    if (!thread && msg.subject) {
      const sender = (parseAddress(msg.from)?.address ?? msg.from).toLowerCase();
      const cands = await ctx.sql`select t.* from inbox_threads t where t.inbox_id = ${inbox.id as string} and t.last_activity_at > now() - interval '30 days'
                                  order by t.last_activity_at desc limit 50`;
      for (const t of cands) {
        if (stripPrefixes((t.subject as string) ?? '') !== stripPrefixes(msg.subject)) continue;
        const [p] = await ctx.sql`select 1 from inbox_messages where thread_id = ${t.id as string}
                                  and (lower(from_addr) like ${'%' + sender + '%'} or exists (select 1 from unnest(to_addrs || cc) a where lower(a) like ${'%' + sender + '%'})) limit 1`;
        if (p) {
          thread = t;
          break;
        }
      }
    }
    let created = false;
    if (!thread) {
      [thread] = await ctx.sql`insert into inbox_threads (inbox_id, team_id, subject, folder) values (${inbox.id as string}, ${teamId}, ${msg.subject || null}, 'inbox') returning *`;
      created = true;
    }
    const folderBefore = thread!.folder as string;
    const newFolder = folderBefore === 'sent' || folderBefore === 'archive' ? 'inbox' : folderBefore;
    await ctx.sql`update inbox_threads set last_activity_at = now(), folder = ${newFolder}, trash_at = case when ${newFolder} = 'trash' then trash_at else null end where id = ${thread!.id as string}`;
    await ctx.sql`
      insert into inbox_messages (id, thread_id, inbox_id, team_id, direction, from_addr, to_addrs, cc, bcc, reply_to, subject, message_id, in_reply_to, refs, html, text, read)
      values (${receivedEmailId}, ${thread!.id as string}, ${inbox.id as string}, ${teamId}, 'inbound', ${msg.from}, ${delivered}, ${msg.cc}, ${[]}, ${msg.replyTo},
              ${msg.subject || null}, ${msg.messageId || null}, ${msg.inReplyTo}, ${msg.references}, ${msg.html}, ${msg.text}, false)
      on conflict (id) do nothing`;
    await emitThreadEmail(ctx, teamId, created ? 'inbox.thread.created' : null, 'inbox.email.received', 'system', inbox, thread!.id as string, receivedEmailId);
  }
}

async function emitThreadEmail(ctx: AppContext, teamId: string, first: WebhookEventType | null, then: WebhookEventType, source: Source, inbox: Row, threadId: string, emailId: string, extra: Row = {}) {
  const [t] = await ctx.sql`select * from inbox_threads where id = ${threadId}`;
  const [m] = await ctx.sql`select * from inbox_messages where id = ${emailId}`;
  const data = {
    source,
    inbox_id: inbox.id,
    thread_id: threadId,
    email_id: emailId,
    ...extra,
    ...(t ? { thread: await threadSummary(ctx, t) } : {}),
    ...(m ? { email: await messageView(ctx, m, false) } : {}),
  };
  if (first) await emit(ctx, teamId, first, data);
  await emit(ctx, teamId, then, data);
}

// ------------------------------------------------------------ sending from an inbox

const BLOCKED_HEADERS = new Set(['in-reply-to', 'references', 'reply-to']);

export function validateCustomHeaders(h: unknown): Record<string, string> | null {
  if (h === undefined || h === null) return null;
  if (typeof h !== 'object' || Array.isArray(h)) throw E.validation('Invalid `headers` field. It must be an object.');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Row)) {
    if (!k.trim()) throw E.validation('Header names cannot be empty.');
    if (BLOCKED_HEADERS.has(k.toLowerCase())) throw E.validation(`The \`${k}\` header is set by Resend and cannot be set here.`);
    if (/[\r\n\0]/.test(k) || /[\r\n\0]/.test(String(v))) throw E.validation(`Invalid value for header \`${k}\`.`);
    if (typeof v !== 'string') throw E.validation(`Invalid value for header \`${k}\`. It must be a string.`);
    out[k] = v;
  }
  return out;
}

export function validateSubject(s: unknown, field = 'subject'): string | null {
  if (s === undefined || s === null) return null;
  if (typeof s !== 'string' || !s.trim() || s.length > 2000 || /[\r\n]/.test(s)) throw E.validation(`The \`${field}\` must be 1 to 2000 characters, with no line breaks.`);
  return s;
}

export function addrList(field: string, v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const list = typeof v === 'string' ? [v] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  if (!list) throw E.validation(`Invalid \`${field}\` field.`);
  for (const a of list) if (!parseAddress(a)) throw E.validation(`Invalid \`${field}\` field. The email address needs to follow the \`email@example.com\` or \`Name <email@example.com>\` format.`);
  return list.map((a) => a.trim());
}

export const fromHeader = (inbox: Row) => (inbox.from_name ? `${inbox.from_name} <${inbox.email_address}>` : (inbox.email_address as string));

/** Reply recipients: Reply-To, else sender; for a message the inbox sent, its `to`. */
export function replyRecipients(m: Row, replyAll: boolean, inboxAddress: string): string[] {
  const own = inboxAddress.toLowerCase();
  const base = m.direction === 'outbound' ? ((m.to_addrs as string[]) ?? []) : (m.reply_to as string[])?.length ? (m.reply_to as string[]) : [m.from_addr as string];
  let out = [...base];
  if (replyAll) out = [...out, ...((m.to_addrs as string[]) ?? []), ...((m.cc as string[]) ?? [])];
  const seen = new Set<string>();
  return out.filter((a) => {
    const b = (parseAddress(a)?.address ?? a).toLowerCase();
    if (b === own || seen.has(b)) return false;
    seen.add(b);
    return true;
  });
}

export interface InboxSend {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html?: string | null;
  text?: string | null;
  attachments?: unknown;
  headers?: Record<string, string> | null;
  replyTo?: Row | null;
  /** existing thread, or null to start a new one in `sent` */
  thread: Row | null;
}

/** Send through the normal pipeline and record the outbound message in the thread. Returns {emailId, threadId, created}. */
export async function sendFromInbox(ctx: AppContext, auth: AuthContext, inbox: Row, s: InboxSend) {
  if (!s.to.length) throw E.missingField('to');
  if (s.to.length + s.cc.length + s.bcc.length > 50) throw E.validation('`to`, `cc` and `bcc` combined cannot exceed 50 recipients.');
  const headers: Record<string, string> = { ...(s.headers ?? {}) };
  let refs: string[] = [];
  if (s.replyTo) {
    const mid = s.replyTo.message_id as string | null;
    refs = [...((s.replyTo.refs as string[]) ?? []), ...(mid ? [mid] : [])];
    if (mid) headers['In-Reply-To'] = mid;
    if (refs.length) headers['References'] = refs.join(' ');
  }
  const body: SendInput = {
    from: fromHeader(inbox),
    to: s.to,
    ...(s.cc.length ? { cc: s.cc } : {}),
    ...(s.bcc.length ? { bcc: s.bcc } : {}),
    subject: s.subject,
    ...(s.html !== undefined && s.html !== null ? { html: s.html } : {}),
    ...(s.text !== undefined && s.text !== null ? { text: s.text } : {}),
    ...(s.attachments !== undefined && s.attachments !== null ? { attachments: s.attachments } : {}),
    headers,
  };
  const n = await normalize(ctx, auth, body, { source: 'inbox' });
  await checkQuota(ctx, auth, 1);
  const [emailId] = await persist(ctx, auth, [n], { source: 'inbox' });
  let thread = s.thread;
  let created = false;
  if (!thread) {
    thread = (await ctx.sql`insert into inbox_threads (inbox_id, team_id, subject, folder) values (${inbox.id as string}, ${auth.team.id}, ${s.subject}, 'sent') returning *`)[0] as Row;
    created = true;
  }
  await ctx.sql`update inbox_threads set last_activity_at = now() where id = ${thread!.id as string}`;
  const [e] = await ctx.sql`select message_id, html, text from emails where id = ${emailId!}`;
  await ctx.sql`
    insert into inbox_messages (id, thread_id, inbox_id, team_id, direction, from_addr, to_addrs, cc, bcc, reply_to, subject, message_id, in_reply_to, refs, html, text, read)
    values (${emailId!}, ${thread!.id as string}, ${inbox.id as string}, ${auth.team.id}, 'outbound', ${fromHeader(inbox)}, ${n.to}, ${n.cc}, ${n.bcc}, ${[]},
            ${s.subject}, ${e!.message_id as string}, ${(s.replyTo?.message_id as string | null) ?? null}, ${refs}, ${e!.html as string | null}, ${e!.text as string | null}, true)`;
  return { emailId: emailId!, threadId: thread!.id as string, created };
}

export async function emitSent(ctx: AppContext, auth: AuthContext, inbox: Row, r: { emailId: string; threadId: string; created: boolean }, extra: Row = {}, alsoDraftSent = false) {
  const src = sourceOf(auth);
  await emitThreadEmail(ctx, auth.team.id, r.created ? 'inbox.thread.created' : null, 'inbox.email.sent', src, inbox, r.threadId, r.emailId);
  if (alsoDraftSent) await emitThreadEmail(ctx, auth.team.id, null, 'inbox.draft.sent', src, inbox, r.threadId, r.emailId, extra);
}

// ------------------------------------------------------------ drafts

export async function draftAttachments(ctx: AppContext, draftId: string) {
  const rows = await ctx.sql`select id, filename, content_type, size from inbox_draft_attachments where draft_id = ${draftId} order by created_at, id`;
  return rows.map((a) => ({ id: a.id, filename: a.filename, content_type: a.content_type, size: a.size }));
}

export async function draftObject(ctx: AppContext, d: Row, withBody = true) {
  return {
    object: 'inbox_draft',
    id: d.id,
    type: d.reply_to_email_id ? 'reply' : 'standalone',
    to: (d.to_addrs as string[] | null) ?? null,
    cc: d.cc ?? [],
    bcc: d.bcc ?? [],
    subject: d.subject ?? null,
    ...(withBody ? { html: d.html ?? null, text: d.text ?? null } : {}),
    thread_id: d.thread_id ?? null,
    reply_to_email_id: d.reply_to_email_id ?? null,
    email_id: d.email_id ?? null,
    created_at: iso(d.created_at),
    updated_at: iso(d.updated_at),
    attachments: await draftAttachments(ctx, d.id as string),
  };
}

export async function draftListItem(ctx: AppContext, d: Row) {
  const body = ((d.text as string | null) ?? (d.html as string | null)?.replace(/<[^>]+>/g, ' ') ?? '').replace(/\s+/g, ' ').trim();
  return {
    id: d.id,
    type: d.reply_to_email_id ? 'reply' : 'standalone',
    to: (d.to_addrs as string[] | null) ?? null,
    cc: d.cc ?? [],
    bcc: d.bcc ?? [],
    subject: d.subject ?? null,
    snippet: body ? body.slice(0, 200) : null,
    thread_id: d.thread_id ?? null,
    reply_to_email_id: d.reply_to_email_id ?? null,
    updated_at: iso(d.updated_at),
    attachments: await draftAttachments(ctx, d.id as string),
  };
}

const MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

export function parseDraftAttachments(v: unknown): { filename: string; content_type: string; content: Buffer }[] | null {
  if (v === undefined) return null;
  if (v === null) return [];
  if (!Array.isArray(v)) throw E.validation('Invalid `attachments` field. It must be an array.');
  const out = [];
  let total = 0;
  for (const a of v as Row[]) {
    if (a?.path !== undefined && a?.content === undefined) throw new ApiError(422, 'validation_error', 'Draft attachments need `content`; `path` is not supported on drafts.');
    if (a?.content_id !== undefined) throw new ApiError(422, 'validation_error', 'Draft attachments do not accept `content_id`.');
    if (typeof a?.filename !== 'string' || !a.filename) throw E.missingField('attachments.filename');
    if (blockedExtension(a.filename)) throw new ApiError(422, 'validation_error', `The file type of \`${a.filename}\` is not allowed.`);
    const ct = (a.content_type ?? a.contentType) as unknown;
    if (typeof ct !== 'string' || !MIME_RE.test(ct)) throw new ApiError(422, 'validation_error', 'Invalid attachment `content_type`. It must be a valid MIME type.');
    let content: Buffer;
    if (typeof a.content === 'string') content = Buffer.from(a.content, 'base64');
    else if (a.content && typeof a.content === 'object' && (a.content as Row).type === 'Buffer') content = Buffer.from((a.content as { data: number[] }).data);
    else throw E.missingField('attachments.content');
    if (!content.length) throw new ApiError(422, 'validation_error', 'Attachments cannot be empty.');
    total += content.length;
    out.push({ filename: a.filename, content_type: ct, content });
  }
  if (total > 25 * 1024 * 1024) throw new ApiError(422, 'validation_error', 'The files on a draft can total at most 25 MB.');
  return out;
}

export async function replaceDraftAttachments(ctx: AppContext, draftId: string, atts: { filename: string; content_type: string; content: Buffer }[]) {
  await ctx.sql`delete from inbox_draft_attachments where draft_id = ${draftId}`;
  for (const a of atts) {
    await ctx.sql`insert into inbox_draft_attachments (draft_id, filename, content_type, size, content) values (${draftId}, ${a.filename}, ${a.content_type}, ${a.content.length}, ${a.content})`;
  }
}

export async function emitDraft(ctx: AppContext, teamId: string, type: WebhookEventType, source: Source, inbox: Row, d: Row) {
  const [t] = d.thread_id ? await ctx.sql`select * from inbox_threads where id = ${d.thread_id as string}` : [];
  await emit(ctx, teamId, type, {
    source,
    inbox_id: inbox.id,
    ...(d.thread_id ? { thread_id: d.thread_id } : {}),
    draft_id: d.id,
    ...(t ? { thread: await threadSummary(ctx, t) } : {}),
    ...(type !== 'inbox.draft.deleted' ? { draft: await draftObject(ctx, d, false) } : {}),
  });
}

export const inboxDomainOf = (address: string) => domainOf(address);
