/** Resend Inboxes API: https://resend.com/docs/api-reference/inboxes */
import type { Context } from 'hono';
import type { AppContext } from '../../context.js';
import type { Fragment } from '../../db.js';
import { isEmail } from '../../lib/address.js';
import { ApiError, E } from '../../lib/errors.js';
import { UUID_RE } from '../../lib/ids.js';
import { list } from '../../lib/pagination.js';
import { withIdempotency } from '../../services/idempotency.js';
import {
  AGENT_ACTIONS, AGENT_TONES, FOLDERS, MOVE_FOLDERS, addrList, checkInboxDomain, draftListItem, draftObject, emitDraft, emitInbox, emitSent,
  inboxListItem, inboxObject, loadMessage, loadThread, messageView, parseDraftAttachments, randomColor, replaceDraftAttachments,
  replyRecipients, resolveInbox, sendFromInbox, sourceOf, threadLabels, threadSummary, threadView, validateCustomHeaders, validateSubject,
} from '../../services/inboxes.js';
import { body, param, query, teamId, type ApiEnv, type Router } from '../router.js';

type C = Context<ApiEnv>;
type Row = Record<string, unknown>;

const PAGE_LIMIT_MSG = 'The pagination limit must be a number between 1 and 100. See https://resend.com/docs/api-reference/pagination for more information.';
const CURSOR_404 = 'The pagination cursor references an object that does not exist. See https://resend.com/docs/api-reference/pagination for more information.';

interface Page {
  limit: number;
  after?: string;
  before?: string;
}

function page(c: C, cursorLabel = 'thread'): Page {
  const q = query(c);
  let limit = 20;
  if (q.limit !== undefined && q.limit !== '') {
    if (!/^\d+$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > 100) throw E.validation(PAGE_LIMIT_MSG);
    limit = Number(q.limit);
  }
  if (q.after && q.before) throw E.validation('You can only pass one of `before` or `after` for pagination. See https://resend.com/docs/api-reference/pagination for more information.');
  for (const k of ['after', 'before'] as const) {
    const v = q[k];
    if (v !== undefined && !UUID_RE.test(v)) {
      if (cursorLabel === 'thread' && !Number.isNaN(Date.parse(v))) {
        throw E.validation(`The \`${k}\` parameter must be a thread ID. To filter by date, use \`GET /inboxes/:id/threads/search\` with \`${k === 'after' ? 'start_date' : 'end_date'}\`.`);
      }
      throw E.validation(`The \`${k}\` parameter must be a valid ${cursorLabel} ID.`);
    }
  }
  return { limit, ...(q.after ? { after: q.after } : {}), ...(q.before ? { before: q.before } : {}) };
}

/** Keyset page over (col, id) in `dir` order; `after` = further along, `before` = back. */
async function keyset(ctx: AppContext, table: string, where: Fragment, p: Page, col: string, dir: 'asc' | 'desc'): Promise<{ rows: Row[]; hasMore: boolean }> {
  const sql = ctx.sql;
  const t = sql(table);
  const oc = sql(col);
  const cid = p.after ?? p.before;
  let cur: Row | undefined;
  if (cid) {
    [cur] = await sql`select ${oc}::text as c, id::text as id from ${t} where ${where} and id = ${cid}`;
    if (!cur) throw E.notFound(CURSOR_404);
  }
  const forward = !p.before;
  const effDir = forward ? dir : dir === 'asc' ? 'desc' : 'asc';
  const cmp = effDir === 'desc' ? sql`<` : sql`>`;
  const order = effDir === 'desc' ? sql`${oc} desc, id desc` : sql`${oc} asc, id asc`;
  let rows = (await sql`select * from ${t} where ${where} ${cur ? sql`and (${oc}, id::text) ${cmp} (${cur.c as string}::timestamptz, ${cur.id as string})` : sql``}
                        order by ${order} limit ${p.limit + 1}`) as unknown as Row[];
  const hasMore = rows.length > p.limit;
  rows = rows.slice(0, p.limit);
  if (!forward) rows.reverse();
  return { rows, hasMore };
}

const bool = (name: string, v: string | undefined): boolean | undefined => {
  if (v === undefined) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw E.validation(`The \`${name}\` parameter must be \`true\` or \`false\`.`);
};

const csv = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

async function threadFilters(ctx: AppContext, c: C, inbox: Row): Promise<{ where: Fragment; folders: string[] }> {
  const q = query(c);
  const labels = csv(q.labels);
  if (labels.length > 50) throw E.validation(`The \`labels\` parameter must contain at most 50 label IDs, but received ${labels.length}.`);
  for (const l of labels) if (!UUID_RE.test(l)) throw E.validation(`The \`labels\` value "${l}" must be a valid UUID.`);
  for (const l of labels) {
    const [x] = await ctx.sql`select 1 from inbox_labels where id = ${l} and inbox_id = ${inbox.id as string}`;
    if (!x) throw E.notFound(`Label "${l}" not found.`);
  }
  const folders = q.folders !== undefined ? csv(q.folders) : labels.length ? ['inbox', 'archive', 'sent'] : ['inbox'];
  for (const f of folders) if (!(FOLDERS as readonly string[]).includes(f)) throw E.validation(`The \`folders\` value "${f}" must be one of: ${FOLDERS.join(', ')}.`);
  const read = bool('read', q.read);
  const sql = ctx.sql;
  let where = sql`inbox_id = ${inbox.id as string} and folder = any(${folders})`;
  if (labels.length) where = sql`${where} and exists (select 1 from inbox_thread_labels tl where tl.thread_id = inbox_threads.id and tl.label_id = any(${labels}))`;
  if (read === true) where = sql`${where} and not exists (select 1 from inbox_messages m where m.thread_id = inbox_threads.id and not m.read)`;
  if (read === false) where = sql`${where} and exists (select 1 from inbox_messages m where m.thread_id = inbox_threads.id and not m.read)`;
  return { where, folders };
}

function parseSearchDate(name: string, v: string | undefined, endOfDay: boolean): Date | null {
  if (!v) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(dateOnly ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw E.validation(`The \`${name}\` must be a valid ISO 8601 date.`);
  return dateOnly && endOfDay ? new Date(d.getTime() + 86400_000 - 1) : d;
}

/** Message-level search predicate (all given filters must match the same email). */
function searchPredicate(ctx: AppContext, c: C): { pred: Fragment | null; ranked: boolean } {
  const q = query(c);
  const sql = ctx.sql;
  const parts: Fragment[] = [];
  let ranked = false;
  if (q.query !== undefined && q.query !== '') {
    if (q.query.length > 256) throw E.validation(`The \`query\` parameter must be at most 256 characters, but received ${q.query.length}.`);
    const tokens = [...q.query.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)].map((m) => ({ neg: !!(m[1] || m[3]), text: (m[2] ?? m[4] ?? '').toLowerCase() })).filter((t) => t.text);
    if (tokens.length > 32) throw E.validation(`The \`query\` parameter must contain at most 32 words, but received ${tokens.length}.`);
    const hay = sql`lower(coalesce(m.subject,'') || ' ' || coalesce(m.text,'') || ' ' || coalesce(m.html,'') || ' ' || m.from_addr || ' ' || array_to_string(m.to_addrs || m.cc, ' ') || ' ' ||
      coalesce((select string_agg(coalesce(filename,''), ' ') from received_attachments ra where ra.email_id = m.id), '') || ' ' ||
      coalesce((select string_agg(coalesce(filename,''), ' ') from email_attachments ea where ea.email_id = m.id), ''))`;
    for (const t of tokens) {
      const like = `%${t.text.replace(/[\\%_]/g, '\\$&')}%`;
      parts.push(t.neg ? sql`${hay} not like ${like}` : sql`${hay} like ${like}`);
    }
    ranked = tokens.some((t) => !t.neg);
  }
  for (const f of ['from', 'to', 'cc', 'bcc'] as const) {
    const vals = csv(q[f]).map((v) => v.toLowerCase());
    if (vals.length > 20) throw E.validation(`The \`${f}\` parameter must contain at most 20 values, but received ${vals.length}.`);
    if (!vals.length) continue;
    const likes = vals.map((v) => `%${v.replace(/[\\%_]/g, '\\$&')}%`);
    if (f === 'from') parts.push(sql`lower(m.from_addr) like any(${likes})`);
    else {
      const col = f === 'to' ? sql`m.to_addrs` : f === 'cc' ? sql`m.cc` : sql`m.bcc`;
      parts.push(sql`exists (select 1 from unnest(${col}) a where lower(a) like any(${likes}))`);
    }
  }
  const has = bool('has_attachment', q.has_attachment);
  if (has !== undefined) {
    const ex = sql`(exists (select 1 from received_attachments ra where ra.email_id = m.id) or exists (select 1 from email_attachments ea where ea.email_id = m.id))`;
    parts.push(has ? ex : sql`not ${ex}`);
  }
  const start = parseSearchDate('start_date', q.start_date, false);
  const end = parseSearchDate('end_date', q.end_date, true);
  if (start && end && start > end) throw E.validation('The `start_date` must be on or before the `end_date`.');
  if (start) parts.push(sql`m.received_at >= ${start.toISOString()}`);
  if (end) parts.push(sql`m.received_at <= ${end.toISOString()}`);
  if (!parts.length) return { pred: null, ranked };
  return { pred: parts.reduce((a, b) => sql`${a} and ${b}`), ranked };
}

export function registerInboxRoutes(r: Router) {
  const inboxOf = async (c: C, ctx: AppContext) => {
    const inbox = await resolveInbox(ctx, teamId(c), param(c, 'inbox_id'));
    checkInboxDomain(c.get('auth'), inbox);
    return inbox;
  };

  // ---------------------------------------------------------------- inboxes
  r.post('/inboxes', async (c, ctx) => {
    const b = body(c);
    const auth = c.get('auth');
    if (b.email_address === undefined || b.email_address === null || b.email_address === '') throw E.missingField('email_address');
    if (typeof b.email_address !== 'string') throw E.validation('Invalid `email_address` field.');
    const address = b.email_address.trim().toLowerCase();
    const at = address.lastIndexOf('@');
    const local = address.slice(0, at);
    if (at < 1 || !isEmail(address) || local.length > 64 || !/^[a-z0-9._%-]+$/.test(local) || /^\.|\.$|\.\./.test(local)) {
      throw E.validation('Invalid `email_address` field. The part before the `@` can contain only letters, numbers, `.`, `_`, `%` and `-` (max 64 characters).');
    }
    if (b.name !== undefined && b.name !== null && (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 64)) throw E.validation('Invalid `name` field. Max 64 characters.');
    if (b.from_name !== undefined && b.from_name !== null && (typeof b.from_name !== 'string' || b.from_name.length > 78 || /[:<>\r\n]/.test(b.from_name))) {
      throw E.validation('Invalid `from_name` field. Use a plain name without `:`, `<`, `>` or line breaks (max 78 characters).');
    }
    if (b.forwarding !== undefined && typeof b.forwarding !== 'boolean') throw E.validation('Invalid `forwarding` field. It must be a boolean.');
    const dom = address.slice(at + 1);
    const [d] = await ctx.sql`select * from domains where team_id = ${auth.team.id} and lower(name) = ${dom}`;
    const sendingOk = d && ['verified', 'partially_verified', 'partially_failed'].includes(d.status as string);
    if (!d || (!b.forwarding && (d.receiving !== 'enabled' || !sendingOk)) || (b.forwarding && !sendingOk)) {
      throw E.validation(b.forwarding
        ? `The ${dom} domain must have DKIM and SPF verified to create an inbox.`
        : `The ${dom} domain must have receiving enabled with DKIM and SPF verified to create an inbox.`);
    }
    if (auth.domainId && auth.domainId !== d.id) throw new ApiError(403, 'validation_error', 'This API key is restricted to another domain.');
    const limit = Number(process.env.INBOX_LIMIT_PER_TEAM ?? 0);
    if (limit > 0) {
      const [n] = await ctx.sql`select count(*)::int as n from inboxes where team_id = ${auth.team.id}`;
      if ((n!.n as number) >= limit) throw new ApiError(403, 'validation_error', 'You have reached the inboxes included in your plan.');
    }
    const [dup] = await ctx.sql`select 1 from inboxes where lower(email_address) = ${address}`;
    if (dup) throw new ApiError(409, 'validation_error', `The ${address} address is already in use by another inbox.`);
    const fwdDomain = process.env.INBOX_FORWARDING_DOMAIN;
    const [row] = await ctx.sql`
      insert into inboxes (team_id, domain_id, email_address, name, from_name, forwarding)
      values (${auth.team.id}, ${d.id as string}, ${address}, ${typeof b.name === 'string' ? b.name.trim() : address}, ${(b.from_name as string | undefined) || null}, ${b.forwarding === true})
      returning *`;
    let inbox = row!;
    if (b.forwarding === true && fwdDomain) {
      [inbox] = await ctx.sql`update inboxes set receiving_address = ${`${(inbox.id as string).slice(0, 8)}.${local}@${fwdDomain}`} where id = ${inbox.id as string} returning *`;
    }
    await emitInbox(ctx, auth.team.id, 'inbox.created', { source: sourceOf(auth), inbox_id: inbox.id, inbox: await inboxObject(ctx, inbox) });
    return c.json({ object: 'inbox', id: inbox.id }, 201);
  });

  r.get('/inboxes', async (c, ctx) => {
    const p = page(c, 'inbox');
    const { rows, hasMore } = await keyset(ctx, 'inboxes', ctx.sql`team_id = ${teamId(c)}`, p, 'created_at', 'desc');
    return c.json(list(await Promise.all(rows.map((i) => inboxListItem(ctx, i))), hasMore));
  });

  r.get('/inboxes/:inbox_id', async (c, ctx) => c.json(await inboxObject(ctx, await inboxOf(c, ctx))));

  r.patch('/inboxes/:inbox_id', async (c, ctx) => {
    const inbox = await inboxOf(c, ctx);
    const b = body(c);
    if (b.name === undefined && b.from_name === undefined) throw E.missingFields('At least one of `name` or `from_name` is required.');
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 64)) throw E.validation('Invalid `name` field. It must be between 1 and 64 characters.');
    if (b.from_name !== undefined && b.from_name !== null && (typeof b.from_name !== 'string' || b.from_name.length > 78 || /[:<>\r\n]/.test(b.from_name))) {
      throw E.validation('Invalid `from_name` field. Use a plain name without `:`, `<`, `>` or line breaks (max 78 characters).');
    }
    const [u] = await ctx.sql`update inboxes set name = ${typeof b.name === 'string' ? b.name.trim() : (inbox.name as string)},
      from_name = ${b.from_name === undefined ? (inbox.from_name as string | null) : (b.from_name as string | null) || null}, updated_at = now()
      where id = ${inbox.id as string} returning *`;
    const auth = c.get('auth');
    await emitInbox(ctx, auth.team.id, 'inbox.updated', { source: sourceOf(auth), inbox_id: inbox.id, inbox: await inboxObject(ctx, u!) });
    return c.json({ object: 'inbox', id: inbox.id });
  });

  r.delete('/inboxes/:inbox_id', async (c, ctx) => {
    const inbox = await inboxOf(c, ctx);
    await ctx.sql`delete from inboxes where id = ${inbox.id as string}`;
    const auth = c.get('auth');
    await emitInbox(ctx, auth.team.id, 'inbox.deleted', { source: sourceOf(auth), inbox_id: inbox.id });
    return c.json({ object: 'inbox', id: inbox.id, deleted: true });
  });

  // ---------------------------------------------------------------- agent (settings only; actions are phase 2)
  r.get('/inboxes/:inbox_id/agent', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const actions = (i.agent_actions as string[]) ?? [];
    return c.json({ object: 'inbox_agent', instructions: i.agent_instructions ?? null, tone: i.agent_tone ?? null, actions: AGENT_ACTIONS.filter((a) => actions.includes(a)) });
  });
  r.patch('/inboxes/:inbox_id/agent', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const b = body(c);
    if (b.instructions === undefined && b.tone === undefined && b.actions === undefined) throw E.missingFields('At least one of `instructions`, `tone` or `actions` is required.');
    if (b.instructions !== undefined && b.instructions !== null && (typeof b.instructions !== 'string' || !b.instructions.trim() || b.instructions.trim().length > 4000)) {
      throw E.validation('Invalid `instructions` field. It must be 1 to 4000 characters.');
    }
    if (b.tone !== undefined && b.tone !== null && !(AGENT_TONES as readonly unknown[]).includes(b.tone)) throw E.validation(`Invalid \`tone\` field. It must be one of: ${AGENT_TONES.join(', ')}.`);
    if (b.actions !== undefined && (!Array.isArray(b.actions) || b.actions.some((a) => !(AGENT_ACTIONS as readonly unknown[]).includes(a)))) {
      throw E.validation(`Invalid \`actions\` field. Each action must be one of: ${AGENT_ACTIONS.join(', ')}.`);
    }
    await ctx.sql`update inboxes set
      agent_instructions = ${b.instructions === undefined ? (i.agent_instructions as string | null) : b.instructions === null ? null : (b.instructions as string).trim()},
      agent_tone = ${b.tone === undefined ? (i.agent_tone as string | null) : (b.tone as string | null)},
      agent_actions = ${b.actions === undefined ? (i.agent_actions as string[]) : [...new Set(b.actions as string[])]}, updated_at = now()
      where id = ${i.id as string}`;
    return c.json({ object: 'inbox_agent', id: i.id });
  });

  // ---------------------------------------------------------------- labels
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const labelObj = (l: Row) => ({ id: l.id, name: l.name, color: l.color, created_at: new Date(String(l.created_at).replace(' ', 'T').replace(/\+00$/, 'Z')).toISOString() });
  r.get('/inboxes/:inbox_id/labels', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const rows = await ctx.sql`select * from inbox_labels where inbox_id = ${i.id as string} order by created_at, id`;
    return c.json({ object: 'list', data: rows.map(labelObj) });
  });
  r.post('/inboxes/:inbox_id/labels', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const b = body(c);
    if (b.name === undefined || b.name === null) throw E.missingField('name');
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 64) throw E.validation('Invalid `name` field. Max 64 characters.');
    if (b.color !== undefined && (typeof b.color !== 'string' || !COLOR_RE.test(b.color))) throw E.validation('Invalid `color` field. It must be a `#RRGGBB` hex color.');
    const [n] = await ctx.sql`select count(*)::int as n from inbox_labels where inbox_id = ${i.id as string}`;
    if ((n!.n as number) >= 100) throw E.validation('An inbox can have at most 100 labels.');
    const [dup] = await ctx.sql`select 1 from inbox_labels where inbox_id = ${i.id as string} and lower(name) = ${b.name.trim().toLowerCase()}`;
    if (dup) throw E.validation(`A label named "${b.name.trim()}" already exists in this inbox.`);
    const [l] = await ctx.sql`insert into inbox_labels (inbox_id, team_id, name, color) values (${i.id as string}, ${teamId(c)}, ${b.name.trim()}, ${((b.color as string | undefined) ?? randomColor()).toUpperCase()}) returning id`;
    return c.json({ object: 'inbox_label', id: l!.id }, 201);
  });
  r.patch('/inboxes/:inbox_id/labels/:label_id', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const lid = param(c, 'label_id');
    if (!UUID_RE.test(lid)) throw E.invalidUuid('label_id');
    const [l] = await ctx.sql`select * from inbox_labels where id = ${lid} and inbox_id = ${i.id as string}`;
    if (!l) throw E.notFound('Label not found.');
    const b = body(c);
    if (b.name === undefined && b.color === undefined) throw E.missingFields('At least one of `name` or `color` is required.');
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 64)) throw E.validation('Invalid `name` field. Max 64 characters.');
    if (b.color !== undefined && (typeof b.color !== 'string' || !COLOR_RE.test(b.color))) throw E.validation('Invalid `color` field. It must be a `#RRGGBB` hex color.');
    if (typeof b.name === 'string') {
      const [dup] = await ctx.sql`select 1 from inbox_labels where inbox_id = ${i.id as string} and lower(name) = ${b.name.trim().toLowerCase()} and id <> ${lid}`;
      if (dup) throw E.validation(`A label named "${b.name.trim()}" already exists in this inbox.`);
    }
    await ctx.sql`update inbox_labels set name = ${typeof b.name === 'string' ? b.name.trim() : (l.name as string)},
      color = ${typeof b.color === 'string' ? b.color.toUpperCase() : (l.color as string)} where id = ${lid}`;
    return c.json({ object: 'inbox_label', id: lid });
  });
  r.delete('/inboxes/:inbox_id/labels/:label_id', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const lid = param(c, 'label_id');
    if (!UUID_RE.test(lid)) throw E.invalidUuid('label_id');
    const rows = await ctx.sql`delete from inbox_labels where id = ${lid} and inbox_id = ${i.id as string} returning id`;
    if (!rows.length) throw E.notFound('Label not found.');
    return c.json({ object: 'inbox_label', id: lid, deleted: true });
  });

  // ---------------------------------------------------------------- threads
  r.get('/inboxes/:inbox_id/threads', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const { where } = await threadFilters(ctx, c, i);
    const p = page(c);
    const { rows, hasMore } = await keyset(ctx, 'inbox_threads', where, p, 'last_activity_at', 'desc');
    return c.json(list(await Promise.all(rows.map((t) => threadView(ctx, t))), hasMore));
  });

  r.get('/inboxes/:inbox_id/threads/search', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const { pred, ranked } = searchPredicate(ctx, c);
    const { where, folders } = await threadFilters(ctx, c, i);
    const sql = ctx.sql;
    let w = where;
    if (pred) {
      // the matching email must itself be in one of `folders` (for `sent`, an email the inbox sent)
      const dirOk = folders.includes('sent') && folders.length === 1 ? sql`m.direction = 'outbound'` : sql`true`;
      w = sql`${w} and exists (select 1 from inbox_messages m where m.thread_id = inbox_threads.id and ${dirOk} and ${pred})`;
    }
    const p = page(c);
    const { rows, hasMore } = await keyset(ctx, 'inbox_threads', w, p, 'last_activity_at', 'desc');
    const data = [];
    for (const t of rows) {
      const [m] = pred
        ? await sql`select m.id from inbox_messages m where m.thread_id = ${t.id as string} and ${pred} order by m.received_at desc limit 1`
        : await sql`select m.id from inbox_messages m where m.thread_id = ${t.id as string} order by m.received_at desc limit 1`;
      data.push({ ...(await threadView(ctx, t)), matched_email_id: (m?.id as string | undefined) ?? null });
    }
    void ranked;
    return c.json(list(data, hasMore));
  });

  r.get('/inboxes/:inbox_id/threads/:thread_id', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    return c.json(await threadSummary(ctx, await loadThread(ctx, i, param(c, 'thread_id'))));
  });

  r.patch('/inboxes/:inbox_id/threads/:thread_id', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const t = await loadThread(ctx, i, param(c, 'thread_id'));
    const b = body(c);
    if (b.read === undefined && b.folder === undefined) throw E.missingFields('At least one of `read` or `folder` is required.');
    if (b.read !== undefined && typeof b.read !== 'boolean') throw E.validation('Invalid `read` field. It must be a boolean.');
    if (b.folder !== undefined && !(MOVE_FOLDERS as readonly unknown[]).includes(b.folder)) throw E.validation(`Invalid \`folder\` field. It must be one of: ${MOVE_FOLDERS.join(', ')}.`);
    if (typeof b.read === 'boolean') await ctx.sql`update inbox_messages set read = ${b.read} where thread_id = ${t.id as string}`;
    if (typeof b.folder === 'string' && b.folder !== t.folder) {
      await ctx.sql`update inbox_threads set folder = ${b.folder}, trash_at = ${b.folder === 'trash' ? new Date(ctx.now().getTime() + 30 * 86400_000).toISOString() : null} where id = ${t.id as string}`;
      const auth = c.get('auth');
      const [nt] = await ctx.sql`select * from inbox_threads where id = ${t.id as string}`;
      await emitInbox(ctx, auth.team.id, 'inbox.thread.folder.updated', { source: sourceOf(auth), inbox_id: i.id, thread_id: t.id, from: t.folder, to: b.folder, thread: await threadSummary(ctx, nt!) });
    }
    const [nt] = await ctx.sql`select * from inbox_threads where id = ${t.id as string}`;
    return c.json(await threadSummary(ctx, nt!));
  });

  r.delete('/inboxes/:inbox_id/threads/:thread_id', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const t = await loadThread(ctx, i, param(c, 'thread_id'));
    if (t.folder === 'trash') return c.json({ object: 'inbox_thread', id: t.id, deleted: false });
    await ctx.sql`update inbox_threads set folder = 'trash', trash_at = ${new Date(ctx.now().getTime() + 30 * 86400_000).toISOString()} where id = ${t.id as string}`;
    const auth = c.get('auth');
    const [nt] = await ctx.sql`select * from inbox_threads where id = ${t.id as string}`;
    await emitInbox(ctx, auth.team.id, 'inbox.thread.folder.updated', { source: sourceOf(auth), inbox_id: i.id, thread_id: t.id, from: t.folder, to: 'trash', thread: await threadSummary(ctx, nt!) });
    return c.json({ object: 'inbox_thread', id: t.id, deleted: true });
  });

  // ---------------------------------------------------------------- thread labels
  const labelChange = async (c: C, ctx: AppContext, mode: 'add' | 'set' | 'remove') => {
    const i = await inboxOf(c, ctx);
    const t = await loadThread(ctx, i, param(c, 'thread_id'));
    let ids: string[];
    if (mode === 'remove') {
      const lid = param(c, 'label_id');
      if (!UUID_RE.test(lid)) throw E.invalidUuid('label_id');
      ids = [lid];
    } else {
      const b = body(c);
      if (!Array.isArray(b.labels)) throw E.missingField('labels');
      ids = [...new Set(b.labels as unknown[])] as string[];
      if (mode === 'add' && (ids.length < 1 || ids.length > 10)) throw E.validation('The `labels` field must contain between 1 and 10 label IDs.');
      if (mode === 'set' && ids.length > 100) throw E.validation('The `labels` field must contain at most 100 label IDs.');
      for (const l of ids) if (typeof l !== 'string' || !UUID_RE.test(l)) throw E.validation(`The \`labels\` value "${String(l)}" must be a valid UUID.`);
    }
    for (const l of ids) {
      const [x] = await ctx.sql`select 1 from inbox_labels where id = ${l} and inbox_id = ${i.id as string}`;
      if (!x) throw E.notFound(`Label "${l}" not found.`);
    }
    const before = await threadLabels(ctx, t.id as string);
    await ctx.sql.begin(async (tx) => {
      if (mode === 'set') await tx`delete from inbox_thread_labels where thread_id = ${t.id as string}`;
      if (mode === 'remove') await tx`delete from inbox_thread_labels where thread_id = ${t.id as string} and label_id = ${ids[0]!}`;
      else for (const l of ids) await tx`insert into inbox_thread_labels (thread_id, label_id) values (${t.id as string}, ${l}) on conflict do nothing`;
    });
    const after = await threadLabels(ctx, t.id as string);
    const added = after.filter((a) => !before.some((b) => b.id === a.id));
    const removed = before.filter((b) => !after.some((a) => a.id === b.id));
    if (added.length || removed.length) {
      const auth = c.get('auth');
      await emitInbox(ctx, auth.team.id, 'inbox.thread.labels.updated', { source: sourceOf(auth), inbox_id: i.id, thread_id: t.id, added, removed, thread: await threadSummary(ctx, t) });
    }
    return c.json({ object: 'list', data: after });
  };
  r.post('/inboxes/:inbox_id/threads/:thread_id/labels', (c, ctx) => labelChange(c, ctx, 'add'));
  r.put('/inboxes/:inbox_id/threads/:thread_id/labels', (c, ctx) => labelChange(c, ctx, 'set'));
  r.delete('/inboxes/:inbox_id/threads/:thread_id/labels/:label_id', (c, ctx) => labelChange(c, ctx, 'remove'));

  // ---------------------------------------------------------------- thread emails
  r.get('/inboxes/:inbox_id/threads/:thread_id/emails', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const t = await loadThread(ctx, i, param(c, 'thread_id'));
    const p = page(c, 'email');
    const { rows, hasMore } = await keyset(ctx, 'inbox_messages', ctx.sql`thread_id = ${t.id as string}`, p, 'received_at', 'asc');
    return c.json(list(await Promise.all(rows.map((m) => messageView(ctx, m))), hasMore));
  });

  r.get('/inboxes/:inbox_id/threads/:thread_id/emails/:email_id', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const t = await loadThread(ctx, i, param(c, 'thread_id'));
    return c.json(await messageView(ctx, await loadMessage(ctx, t, param(c, 'email_id'))));
  });

  const idem = async (c: C, ctx: AppContext, endpoint: string, fn: () => Promise<{ status: number; body: unknown }>) => {
    const auth = c.get('auth');
    const key = c.req.header('idempotency-key');
    let replayed = true;
    const res = await withIdempotency(ctx, auth.team.id, endpoint, key, c.get('rawBody') ?? '', async () => {
      replayed = false;
      return fn();
    });
    if (key !== undefined && replayed) c.header('idempotent-replayed', 'true');
    return c.json(res.body as object, res.status as 200);
  };

  r.post(
    '/inboxes/:inbox_id/threads/:thread_id/emails/:email_id/reply',
    async (c, ctx) => {
      const auth = c.get('auth');
      const i = await inboxOf(c, ctx);
      return idem(c, ctx, `POST /inboxes/${i.id}/threads/${param(c, 'thread_id')}/emails/${param(c, 'email_id')}/reply`, async () => {
        const t = await loadThread(ctx, i, param(c, 'thread_id'));
        const m = await loadMessage(ctx, t, param(c, 'email_id'));
        const b = body(c);
        if ((b.html === undefined || b.html === null) && (b.text === undefined || b.text === null)) throw E.missingFields('At least one of `html` or `text` is required.');
        if (b.reply_all !== undefined && typeof b.reply_all !== 'boolean') throw E.validation('Invalid `reply_all` field. It must be a boolean.');
        const cc = addrList('cc', b.cc);
        const bcc = addrList('bcc', b.bcc);
        if (cc.length + bcc.length > 49) throw E.validation('`cc` and `bcc` combined can have at most 49 addresses.');
        const subject = validateSubject(b.subject) ?? `Re: ${((t.subject as string | null) ?? (m.subject as string | null) ?? '').replace(/^\s*re\s*:\s*/i, '')}`;
        const to = replyRecipients(m, b.reply_all === true, i.email_address as string);
        const r2 = await sendFromInbox(ctx, auth, i, {
          to: to.length ? to : [m.from_addr as string], cc, bcc, subject,
          html: b.html as string | null, text: b.text as string | null, attachments: b.attachments, headers: validateCustomHeaders(b.headers), replyTo: m, thread: t,
        });
        await emitSent(ctx, auth, i, r2);
        return { status: 200, body: { id: r2.emailId } };
      });
    },
    { sending: true },
  );

  r.post(
    '/inboxes/:inbox_id/threads/:thread_id/emails/:email_id/forward',
    async (c, ctx) => {
      const auth = c.get('auth');
      const i = await inboxOf(c, ctx);
      return idem(c, ctx, `POST /inboxes/${i.id}/threads/${param(c, 'thread_id')}/emails/${param(c, 'email_id')}/forward`, async () => {
        const t = await loadThread(ctx, i, param(c, 'thread_id'));
        const m = await loadMessage(ctx, t, param(c, 'email_id'));
        const b = body(c);
        if (b.to === undefined || b.to === null || (Array.isArray(b.to) && !b.to.length)) throw E.missingField('to');
        const to = addrList('to', b.to);
        const cc = addrList('cc', b.cc);
        const bcc = addrList('bcc', b.bcc);
        const base = (t.subject as string | null) ?? (m.subject as string | null) ?? '';
        const subject = validateSubject(b.subject) ?? (/^\s*fwd?\s*:/i.test(base) ? base : `Fwd: ${base}`);
        // Original attachments travel with the forward.
        const orig = m.direction === 'inbound'
          ? await ctx.sql`select filename, content_type, content_id, content from received_attachments where email_id = ${m.id as string} order by created_at, id`
          : await ctx.sql`select filename, content_type, content_id, content, path from email_attachments where email_id = ${m.id as string} order by created_at, id`;
        if (orig.some((a) => !a.content && a.path)) throw new ApiError(422, 'validation_error', 'An original attachment that was sent from a URL (`path`) cannot be forwarded.');
        const extra = Array.isArray(b.attachments) ? (b.attachments as Row[]) : [];
        const attachments = [
          ...orig.map((a) => ({ filename: a.filename, content: (a.content as Buffer).toString('base64'), content_type: a.content_type, ...(a.content_id ? { content_id: a.content_id } : {}) })),
          ...extra,
        ];
        if (attachments.length > 10) throw new ApiError(422, 'validation_error', 'A forward can have up to 10 files.');
        const contentBytes = orig.reduce((n, a) => n + ((a.content as Buffer | null)?.length ?? 0), 0) + extra.reduce((n, a) => n + (typeof a.content === 'string' ? Math.floor((a.content.length * 3) / 4) : 0), 0);
        if (contentBytes > 25 * 1024 * 1024) throw new ApiError(422, 'validation_error', 'Attachments can have at most 25 MB of `content` in total.');
        const quoteText = `\n\n---------- Forwarded message ---------\nFrom: ${m.from_addr}\nSubject: ${m.subject ?? ''}\nTo: ${((m.to_addrs as string[]) ?? []).join(', ')}\n\n${(m.text as string | null) ?? ''}`;
        const quoteHtml = `<br><br><div>---------- Forwarded message ---------<br>From: ${String(m.from_addr).replace(/</g, '&lt;')}<br>Subject: ${String(m.subject ?? '').replace(/</g, '&lt;')}<br><br></div>${(m.html as string | null) ?? `<pre>${String(m.text ?? '').replace(/</g, '&lt;')}</pre>`}`;
        const r2 = await sendFromInbox(ctx, auth, i, {
          to, cc, bcc, subject,
          html: typeof b.html === 'string' || m.html ? `${(b.html as string | undefined) ?? ''}${quoteHtml}` : null,
          text: `${(b.text as string | undefined) ?? ''}${quoteText}`,
          attachments: attachments.length ? attachments : undefined, headers: validateCustomHeaders(b.headers), replyTo: m, thread: t,
        });
        await emitSent(ctx, auth, i, r2);
        return { status: 200, body: { id: r2.emailId } };
      });
    },
    { sending: true },
  );

  // ---------------------------------------------------------------- drafts
  const loadDraft = async (ctx: AppContext, i: Row, id: string) => {
    if (!UUID_RE.test(id)) throw E.invalidUuid('draft_id');
    const [d] = await ctx.sql`select * from inbox_drafts where id = ${id} and inbox_id = ${i.id as string}`;
    if (!d) throw E.notFound('Draft not found.');
    return d;
  };
  const nonEmpty = (d: Row, attCount: number) =>
    ((d.to_addrs as string[] | null)?.length ?? 0) + ((d.cc as string[]).length) + ((d.bcc as string[]).length) > 0 ||
    !!(d.subject as string | null) || !!(d.text as string | null) || !!(d.html as string | null) || attCount > 0;

  r.get('/inboxes/:inbox_id/drafts', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const p = page(c, 'draft');
    const { rows, hasMore } = await keyset(ctx, 'inbox_drafts', ctx.sql`inbox_id = ${i.id as string} and sent_at is null`, p, 'updated_at', 'desc');
    return c.json(list(await Promise.all(rows.map((d) => draftListItem(ctx, d))), hasMore));
  });

  r.post(
    '/inboxes/:inbox_id/drafts',
    async (c, ctx) => {
      const auth = c.get('auth');
      const i = await inboxOf(c, ctx);
      return idem(c, ctx, `POST /inboxes/${i.id}/drafts`, async () => {
        const b = body(c);
        const hasT = b.thread_id !== undefined && b.thread_id !== null;
        const hasR = b.reply_to_email_id !== undefined && b.reply_to_email_id !== null;
        if (hasT !== hasR) throw E.validation('`thread_id` and `reply_to_email_id` must be sent together.');
        let thread: Row | null = null;
        let replyMsg: Row | null = null;
        if (hasT) {
          thread = await loadThread(ctx, i, String(b.thread_id));
          replyMsg = await loadMessage(ctx, thread, String(b.reply_to_email_id));
        }
        const atts = parseDraftAttachments(b.attachments);
        const to = b.to === undefined || b.to === null ? (replyMsg ? replyRecipients(replyMsg, false, i.email_address as string) : null) : addrList('to', b.to);
        const cc = addrList('cc', b.cc);
        const bcc = addrList('bcc', b.bcc);
        if ((to?.length ?? 0) + cc.length + bcc.length > 50) throw E.validation('`to`, `cc` and `bcc` combined cannot exceed 50 recipients.');
        const subject = validateSubject(b.subject);
        for (const k of ['html', 'text'] as const) if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string') throw E.validation(`Invalid \`${k}\` field. It must be a string.`);
        if (replyMsg) {
          const [existing] = await ctx.sql`select * from inbox_drafts where reply_to_email_id = ${replyMsg.id as string} and sent_at is null`;
          if (existing) {
            if (atts) await replaceDraftAttachments(ctx, existing.id as string, atts);
            return { status: 200, body: { object: 'inbox_draft', id: existing.id } };
          }
        }
        const draftRow = {
          to_addrs: to, cc, bcc, subject,
          html: (b.html as string | null | undefined) ?? null,
          text: (b.text as string | null | undefined) ?? (replyMsg && b.html === undefined ? '' : null),
        };
        if (!replyMsg && !nonEmpty(draftRow, atts?.length ?? 0)) throw E.validation('At least one of `to`, `cc`, `bcc`, `subject`, `text`, `html` or `attachments` must be non-empty.');
        const [d] = await ctx.sql`
          insert into inbox_drafts (inbox_id, team_id, thread_id, reply_to_email_id, to_addrs, cc, bcc, subject, html, text)
          values (${i.id as string}, ${auth.team.id}, ${(thread?.id as string | undefined) ?? null}, ${(replyMsg?.id as string | undefined) ?? null},
                  ${draftRow.to_addrs}, ${cc}, ${bcc}, ${subject}, ${draftRow.html}, ${draftRow.text})
          returning *`;
        if (atts?.length) await replaceDraftAttachments(ctx, d!.id as string, atts);
        await emitDraft(ctx, auth.team.id, 'inbox.draft.created', sourceOf(auth), i, d!);
        return { status: 201, body: { object: 'inbox_draft', id: d!.id } };
      });
    },
    { sending: true },
  );

  r.get('/inboxes/:inbox_id/drafts/:draft_id', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    return c.json(await draftObject(ctx, await loadDraft(ctx, i, param(c, 'draft_id'))));
  });

  r.patch('/inboxes/:inbox_id/drafts/:draft_id', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const d = await loadDraft(ctx, i, param(c, 'draft_id'));
    if (d.sent_at) throw new ApiError(409, 'validation_error', 'This draft was already sent.');
    const b = body(c);
    const keys = ['to', 'cc', 'bcc', 'subject', 'html', 'text', 'attachments'].filter((k) => b[k] !== undefined);
    if (!keys.length) throw E.missingFields('Send at least one field to update.');
    const next: Row = { ...d };
    if (b.to !== undefined) next.to_addrs = b.to === null ? null : addrList('to', b.to);
    if (b.cc !== undefined) next.cc = addrList('cc', b.cc);
    if (b.bcc !== undefined) next.bcc = addrList('bcc', b.bcc);
    if (b.subject !== undefined) next.subject = validateSubject(b.subject);
    if (b.html !== undefined || b.text !== undefined) {
      for (const k of ['html', 'text'] as const) if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string') throw E.validation(`Invalid \`${k}\` field. It must be a string.`);
      next.html = (b.html as string | null | undefined) ?? null;
      next.text = (b.text as string | null | undefined) ?? null;
    }
    if (((next.to_addrs as string[] | null)?.length ?? 0) + (next.cc as string[]).length + (next.bcc as string[]).length > 50) throw E.validation('`to`, `cc` and `bcc` combined cannot exceed 50 recipients.');
    const atts = parseDraftAttachments(b.attachments);
    const [ac] = await ctx.sql`select count(*)::int as n from inbox_draft_attachments where draft_id = ${d.id as string}`;
    if (!nonEmpty(next, atts ? atts.length : (ac!.n as number))) throw E.validation('The draft must keep at least one non-empty field.');
    await ctx.sql`update inbox_drafts set to_addrs = ${next.to_addrs as string[] | null}, cc = ${next.cc as string[]}, bcc = ${next.bcc as string[]},
      subject = ${next.subject as string | null}, html = ${next.html as string | null}, text = ${next.text as string | null}, updated_at = now() where id = ${d.id as string}`;
    if (atts) await replaceDraftAttachments(ctx, d.id as string, atts);
    const auth = c.get('auth');
    const [nd] = await ctx.sql`select * from inbox_drafts where id = ${d.id as string}`;
    await emitDraft(ctx, auth.team.id, 'inbox.draft.updated', sourceOf(auth), i, nd!);
    return c.json({ object: 'inbox_draft', id: d.id });
  });

  r.delete('/inboxes/:inbox_id/drafts/:draft_id', async (c, ctx) => {
    const i = await inboxOf(c, ctx);
    const d = await loadDraft(ctx, i, param(c, 'draft_id'));
    await ctx.sql`delete from inbox_drafts where id = ${d.id as string}`;
    const auth = c.get('auth');
    await emitDraft(ctx, auth.team.id, 'inbox.draft.deleted', sourceOf(auth), i, d);
    return c.json({ object: 'inbox_draft', id: d.id, deleted: true });
  });

  r.post(
    '/inboxes/:inbox_id/drafts/:draft_id/send',
    async (c, ctx) => {
      const auth = c.get('auth');
      const i = await inboxOf(c, ctx);
      return idem(c, ctx, `POST /inboxes/${i.id}/drafts/${param(c, 'draft_id')}/send`, async () => {
        const d = await loadDraft(ctx, i, param(c, 'draft_id'));
        if (d.sent_at) throw new ApiError(409, 'validation_error', 'This draft was already sent.');
        const b = body(c);
        const headers = validateCustomHeaders(b.headers);
        const to = (d.to_addrs as string[] | null) ?? [];
        if (!to.length) throw new ApiError(422, 'missing_required_field', 'The draft needs a `to` recipient.');
        if (!d.html && !d.text) throw new ApiError(422, 'missing_required_field', 'The draft needs `html` or `text`.');
        let thread: Row | null = null;
        let replyMsg: Row | null = null;
        if (d.thread_id) {
          thread = ((await ctx.sql`select * from inbox_threads where id = ${d.thread_id as string}`)[0] as Row | undefined) ?? null;
          replyMsg = d.reply_to_email_id ? (((await ctx.sql`select * from inbox_messages where id = ${d.reply_to_email_id as string}`)[0] as Row | undefined) ?? null) : null;
        }
        if (!d.subject && !replyMsg) throw new ApiError(422, 'missing_required_field', 'The draft needs a `subject`.');
        const subject = (d.subject as string | null) ?? `Re: ${((thread?.subject as string | null) ?? '').replace(/^\s*re\s*:\s*/i, '')}`;
        const atts = await ctx.sql`select filename, content_type, content from inbox_draft_attachments where draft_id = ${d.id as string} order by created_at, id`;
        const r2 = await sendFromInbox(ctx, auth, i, {
          to, cc: d.cc as string[], bcc: d.bcc as string[], subject, html: d.html as string | null, text: (d.text as string | null) || null,
          attachments: atts.length ? atts.map((a) => ({ filename: a.filename, content_type: a.content_type, content: (a.content as Buffer).toString('base64') })) : undefined,
          headers, replyTo: replyMsg, thread,
        });
        await ctx.sql`update inbox_drafts set sent_at = now(), email_id = ${r2.emailId}, thread_id = ${r2.threadId}, updated_at = now() where id = ${d.id as string}`;
        const [sd] = await ctx.sql`select * from inbox_drafts where id = ${d.id as string}`;
        await emitSent(ctx, auth, i, r2, { draft_id: d.id, draft: await draftObject(ctx, sd!, false) }, true);
        return { status: 200, body: { id: r2.emailId } };
      });
    },
    { sending: true },
  );
}
