/** Fetching conversation lists and conversations (05-jmap-mapping §3). */
import { JmapMethodError, type JmapClient } from '../jmap/client';
import type { Email, EmailAddress, EmailBodyPart, EmailFilter, Id } from '../jmap/types';
import { KW, wakeTimeOf } from './mapping';
import type { ViewQuery } from './views';

/** Light email record used by list rows and actions. */
export interface LiteEmail {
  id: Id;
  threadId: Id;
  mailboxIds: Record<Id, boolean>;
  keywords: Record<string, boolean>;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  subject: string | null;
  receivedAt: string;
  preview: string;
  hasAttachment: boolean;
  attachments?: EmailBodyPart[];
}

export interface ThreadSummary {
  threadId: Id;
  /** The newest email of the thread matching the view (what Email/query returned). */
  emailId: Id;
  subject: string;
  preview: string;
  receivedAt: string;
  /** Emails of the thread visible in this view (oldest → newest). */
  emails: LiteEmail[];
  unread: boolean;
  starred: boolean;
  important: boolean;
  hasAttachment: boolean;
  hasDraft: boolean;
  muted: boolean;
  wakeAt?: string;
  /** Mailboxes any email is in. */
  mailboxIds: Set<Id>;
  attachments: (EmailBodyPart & { emailId: Id })[];
  snippet?: { subject: string | null; preview: string | null };
}

export interface ThreadPage {
  items: ThreadSummary[];
  total: number | undefined;
  position: number;
  queryState: string;
}

export const LITE_PROPS = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'subject', 'receivedAt', 'preview', 'hasAttachment', 'attachments'];
const ATTACHMENT_PROPS = ['partId', 'blobId', 'size', 'name', 'type', 'disposition', 'cid'];

/** Summarise a thread's emails (already filtered for the view) into a list row. */
export function summarize(threadId: Id, representative: LiteEmail, emails: LiteEmail[]): ThreadSummary {
  const sorted = [...emails].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const nonDraft = sorted.filter((e) => !e.keywords[KW.draft]);
  const latest = nonDraft.at(-1) ?? sorted.at(-1) ?? representative;
  const mailboxIds = new Set<Id>();
  for (const e of sorted) for (const m of Object.keys(e.mailboxIds)) mailboxIds.add(m);
  const attachments: ThreadSummary['attachments'] = [];
  for (const e of sorted) for (const a of e.attachments ?? []) if (a.disposition !== 'inline' || !a.cid) attachments.push({ ...a, emailId: e.id });
  const wake = sorted.map((e) => wakeTimeOf(e.keywords)).find(Boolean);
  return {
    threadId,
    emailId: representative.id,
    subject: latest.subject ?? representative.subject ?? '',
    preview: latest.preview ?? '',
    receivedAt: representative.receivedAt,
    emails: sorted,
    unread: sorted.some((e) => !e.keywords[KW.seen] && !e.keywords[KW.draft]),
    starred: sorted.some((e) => e.keywords[KW.flagged]),
    important: sorted.some((e) => e.keywords[KW.important]),
    hasAttachment: sorted.some((e) => e.hasAttachment),
    hasDraft: sorted.some((e) => e.keywords[KW.draft]),
    muted: sorted.some((e) => e.keywords[KW.muted]),
    wakeAt: wake?.toISOString(),
    mailboxIds,
    attachments,
  };
}

export interface FetchListOptions {
  position: number;
  limit: number;
  /** Mailboxes whose emails are hidden inside threads (trash/junk) unless the view is scoped to them. */
  hiddenMailboxIds: Id[];
}

/**
 * One request: Email/query → Email/get(threadId) → Thread/get → Email/get(all thread emails)
 * (+ SearchSnippet/get for text searches).
 */
export async function fetchThreadPage(client: JmapClient, q: ViewQuery, opts: FetchListOptions): Promise<ThreadPage> {
  if (!q.valid) return { items: [], total: 0, position: 0, queryState: '' };
  const b = client.batch();
  const query = b.call('Email/query', {
    filter: q.filter,
    sort: q.sort,
    collapseThreads: q.collapseThreads,
    position: opts.position,
    limit: opts.limit,
    calculateTotal: true,
  });
  const reps = b.call('Email/get', { '#ids': query.ref('/ids'), properties: LITE_PROPS, bodyProperties: ATTACHMENT_PROPS });
  const threads = q.collapseThreads ? b.call('Thread/get', { '#ids': reps.ref('/list/*/threadId') }) : null;
  const all = threads ? b.call('Email/get', { '#ids': threads.ref('/list/*/emailIds'), properties: LITE_PROPS, bodyProperties: ATTACHMENT_PROPS }) : null;
  const snippets = q.snippets ? b.call('SearchSnippet/get', { '#emailIds': query.ref('/ids'), filter: q.filter }) : null;
  const res = await b.send();

  const qr = res.get(query);
  const repList = res.get(reps).list as LiteEmail[];
  const byId = new Map<Id, LiteEmail>(repList.map((e) => [e.id, e]));
  const threadEmails = new Map<Id, Id[]>();

  if (threads && all) {
    for (const t of res.get(threads).list) threadEmails.set(t.id, t.emailIds);
    let allList: LiteEmail[];
    try {
      allList = res.get(all).list as LiteEmail[];
    } catch (e) {
      // Threads with very many messages can exceed maxObjectsInGet: fetch in chunks.
      if (!(e instanceof JmapMethodError)) throw e;
      const ids = [...threadEmails.values()].flat();
      allList = await getEmailsChunked(client, ids, LITE_PROPS);
    }
    for (const e of allList) byId.set(e.id, e);
  }

  const snippetMap = new Map<Id, { subject: string | null; preview: string | null }>();
  if (snippets) {
    try {
      for (const s of res.get(snippets).list) snippetMap.set(s.emailId, { subject: s.subject, preview: s.preview });
    } catch {
      /* snippets are optional */
    }
  }

  const hidden = new Set(opts.hiddenMailboxIds.filter((id) => id !== q.scopeMailboxId));
  const items: ThreadSummary[] = [];
  for (const id of qr.ids) {
    const rep = byId.get(id);
    if (!rep) continue;
    let emails: LiteEmail[];
    if (q.collapseThreads) {
      const ids = threadEmails.get(rep.threadId) ?? [id];
      emails = ids.map((x) => byId.get(x)).filter((e): e is LiteEmail => !!e);
      if (q.scopeMailboxId) emails = emails.filter((e) => e.mailboxIds[q.scopeMailboxId!]);
      else emails = emails.filter((e) => e.id === id || !Object.keys(e.mailboxIds).every((m) => hidden.has(m)));
      if (!emails.length) emails = [rep];
    } else emails = [rep];
    const s = summarize(rep.threadId, rep, emails);
    const sn = snippetMap.get(id);
    if (sn) s.snippet = sn;
    items.push(s);
  }
  return { items, total: qr.total, position: qr.position, queryState: qr.queryState };
}

export async function getEmailsChunked(client: JmapClient, ids: Id[], properties: string[], extra: Record<string, unknown> = {}): Promise<LiteEmail[]> {
  const max = client.limits?.maxObjectsInGet ?? 500;
  const maxCalls = client.limits?.maxCallsInRequest ?? 16;
  const out: LiteEmail[] = [];
  const chunks: Id[][] = [];
  for (let i = 0; i < ids.length; i += max) chunks.push(ids.slice(i, i + max));
  for (let i = 0; i < chunks.length; i += maxCalls) {
    const b = client.batch();
    const hs = chunks.slice(i, i + maxCalls).map((c) => b.call('Email/get', { ids: c, properties, bodyProperties: ATTACHMENT_PROPS, ...extra }));
    const r = await b.send();
    for (const h of hs) out.push(...(r.get(h).list as LiteEmail[]));
  }
  return out;
}

// ------------------------------------------------------------------ conversation
export const FULL_PROPS = [
  'id',
  'blobId',
  'threadId',
  'mailboxIds',
  'keywords',
  'size',
  'receivedAt',
  'messageId',
  'inReplyTo',
  'references',
  'sender',
  'from',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'subject',
  'sentAt',
  'hasAttachment',
  'preview',
  'bodyValues',
  'textBody',
  'htmlBody',
  'attachments',
  'header:List-Unsubscribe:asURLs',
  'header:List-Id:asText',
  'header:Authentication-Results:asText',
];

export interface Conversation {
  threadId: Id;
  emails: Email[];
}

export async function fetchConversation(client: JmapClient, threadId: Id): Promise<Conversation> {
  const b = client.batch();
  const t = b.call('Thread/get', { ids: [threadId] });
  const e = b.call('Email/get', {
    '#ids': t.ref('/list/*/emailIds'),
    properties: FULL_PROPS,
    bodyProperties: ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'disposition', 'cid', 'location'],
    fetchHTMLBodyValues: true,
    fetchTextBodyValues: true,
    maxBodyValueBytes: 1_000_000,
  });
  const r = await b.send();
  const list = (r.get(e).list as Email[]).sort((a, b2) => a.receivedAt.localeCompare(b2.receivedAt));
  return { threadId, emails: list };
}

/** Thread ids matching a filter (for "select all N conversations" bulk actions). */
export async function queryAllEmailIds(client: JmapClient, filter: EmailFilter, collapse = false, limit = 10_000): Promise<{ id: Id; threadId: Id }[]> {
  const out: { id: Id; threadId: Id }[] = [];
  let position = 0;
  const page = 1000;
  for (;;) {
    const b = client.batch();
    const q = b.call('Email/query', { filter, collapseThreads: collapse, position, limit: page, sort: [{ property: 'receivedAt', isAscending: false }] });
    const g = b.call('Email/get', { '#ids': q.ref('/ids'), properties: ['id', 'threadId'] });
    const r = await b.send();
    const list = r.get(g).list;
    out.push(...list.map((x) => ({ id: x.id, threadId: x.threadId })));
    if (list.length < page || out.length >= limit) break;
    position += page;
  }
  return out;
}
