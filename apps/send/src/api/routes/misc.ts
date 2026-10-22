import type { AppContext } from '../../context.js';
import { pgToIso } from '../../db.js';
import { isEmail } from '../../lib/address.js';
import { E } from '../../lib/errors.js';
import { isUuid, UUID_RE } from '../../lib/ids.js';
import { list, paginate, parsePage } from '../../lib/pagination.js';
import { nextUtcDay, nextUtcMonth, startOfUtcDay, startOfUtcMonth } from '../../lib/time.js';
import { addSuppression } from '../../services/emailEvents.js';
import { emit } from '../../services/webhooks.js';
import { body, param, query, teamId, uuidParam, type Router } from '../router.js';

const suppressionItem = (s: Record<string, unknown>) => ({ id: s.id, email: s.email, origin: s.origin, source_id: s.source_id ?? null, created_at: s.created_at });

async function removeSuppression(ctx: AppContext, team: string, row: Record<string, unknown>) {
  await ctx.sql`delete from suppressions where id = ${row.id as string}`;
  await emit(ctx, team, 'suppression.removed', { id: row.id, email: row.email, origin: row.origin, source_id: row.source_id ?? null, created_at: pgToIso(row.created_at as string) });
}

export async function usageObject(ctx: AppContext, team: { id: string; monthly_quota: number; daily_quota: number | null; rate_limit: number }) {
  const now = ctx.now();
  const day = startOfUtcDay(now).toISOString();
  const month = startOfUtcMonth(now).toISOString();
  const [s] = await ctx.sql`
    select count(*) filter (where created_at >= ${day} and source <> 'broadcast')::int as sent_d,
           count(*) filter (where source <> 'broadcast')::int as sent_m
    from emails where team_id = ${team.id} and created_at >= ${month}`;
  const [rv] = await ctx.sql`
    select count(*) filter (where created_at >= ${day})::int as d, count(*)::int as m
    from received_emails where team_id = ${team.id} and created_at >= ${month}`;
  const [counts] = await ctx.sql`
    select (select count(*)::int from contacts where team_id = ${team.id}) as contacts,
           (select count(*)::int from segments where team_id = ${team.id}) as segments,
           (select count(*)::int from broadcasts where team_id = ${team.id} and status = 'sent') as broadcasts,
           (select count(*)::int from domains where team_id = ${team.id}) as domains,
           (select count(*)::int from automation_runs where team_id = ${team.id} and created_at >= ${month}) as runs`;
  return {
    object: 'usage',
    emails: {
      daily: { used: s!.sent_d + rv!.d, limit: team.daily_quota, sent: s!.sent_d, received: rv!.d, resets_at: nextUtcDay(now).toISOString() },
      monthly: { used: s!.sent_m + rv!.m, limit: team.monthly_quota, sent: s!.sent_m, received: rv!.m, resets_at: nextUtcMonth(now).toISOString() },
    },
    contacts: { used: counts!.contacts, limit: 1000 },
    segments: { used: counts!.segments, limit: null },
    broadcasts: { used: counts!.broadcasts, limit: null },
    ai_credits: { used: 0, limit: 0, next_increase_at: null },
    automation_runs: { used: counts!.runs, limit: 10000, resets_at: nextUtcMonth(now).toISOString() },
    domains: { used: counts!.domains, limit: null },
    rate_limit: { limit: team.rate_limit, duration: '1000ms' },
  };
}

export function registerMiscRoutes(r: Router) {
  // ---- Logs
  r.get('/logs', async (c, ctx) => {
    const page = parsePage(query(c), 20);
    const { rows, hasMore } = await paginate(ctx.sql, 'api_logs', ctx.sql`team_id = ${teamId(c)} and source = 'api'`, page,
      ctx.sql`id, created_at, endpoint, method, response_status, user_agent`);
    return c.json(list(rows.map((l) => ({ id: l.id, created_at: l.created_at, endpoint: l.endpoint, method: l.method, response_status: l.response_status, user_agent: l.user_agent ?? null })), hasMore));
  });
  r.get('/logs/:log_id', async (c, ctx) => {
    const id = uuidParam(c, 'log_id', 'log_id');
    const [l] = await ctx.sql`select * from api_logs where id = ${id} and team_id = ${teamId(c)}`;
    if (!l) throw E.notFound('Log not found');
    return c.json({ object: 'log', id: l.id, created_at: l.created_at, endpoint: l.endpoint, method: l.method, response_status: l.response_status, user_agent: l.user_agent ?? null, request_body: l.request_body ?? null, response_body: l.response_body ?? null });
  });

  // ---- Usage
  r.get('/usage', async (c, ctx) => c.json(await usageObject(ctx, c.get('auth').team)));

  // ---- Suppressions
  r.post('/suppressions', async (c, ctx) => {
    const b = body(c);
    if (b.email === undefined || b.email === null || b.email === '') throw E.missingField('email');
    if (typeof b.email !== 'string' || !isEmail(b.email)) throw E.validation('Invalid `email` field.');
    const created = await addSuppression(ctx, teamId(c), b.email, 'manual', null);
    const row = created ?? (await ctx.sql`select id from suppressions where team_id = ${teamId(c)} and lower(email) = ${b.email.toLowerCase()}`)[0];
    return c.json({ object: 'suppression', id: row!.id }, 201);
  });
  r.post('/suppressions/batch/add', async (c, ctx) => {
    const b = body(c);
    if (!Array.isArray(b.emails)) throw E.missingField('emails');
    if (b.emails.length > 100) throw E.validation('The `emails` field can contain at most 100 addresses.');
    for (const e of b.emails) if (typeof e !== 'string' || !isEmail(e)) throw E.validation(`Invalid email address \`${String(e)}\`.`);
    const out = [];
    for (const e of b.emails as string[]) {
      const created = await addSuppression(ctx, teamId(c), e, 'manual', null);
      const row = created ?? (await ctx.sql`select id from suppressions where team_id = ${teamId(c)} and lower(email) = ${e.toLowerCase()}`)[0];
      out.push({ object: 'suppression', id: row!.id });
    }
    return c.json({ data: out }, 201);
  });
  r.post('/suppressions/batch/remove', async (c, ctx) => {
    const b = body(c);
    const emails = b.emails as unknown[] | undefined;
    const ids = b.ids as unknown[] | undefined;
    if (emails && ids) throw E.validation('Provide either `emails` or `ids`, not both.');
    const items = emails ?? ids;
    if (!Array.isArray(items)) throw E.missingFields('Missing `emails` or `ids` field.');
    if (items.length > 100) throw E.validation('At most 100 items can be removed at once.');
    const out = [];
    for (const it of items) {
      if (typeof it !== 'string') throw E.validation('Invalid item.');
      if (ids && !isUuid(it)) throw E.invalidUuid('ids');
      const [row] = ids
        ? await ctx.sql`select * from suppressions where team_id = ${teamId(c)} and id = ${it}`
        : await ctx.sql`select * from suppressions where team_id = ${teamId(c)} and lower(email) = ${it.toLowerCase()}`;
      if (row) await removeSuppression(ctx, teamId(c), row);
      out.push({ object: 'suppression', id: (row?.id as string | undefined) ?? it, deleted: !!row });
    }
    return c.json({ data: out });
  });
  r.get('/suppressions', async (c, ctx) => {
    const q = query(c);
    const page = parsePage(q, 20);
    if (q.origin && !['bounce', 'complaint', 'manual'].includes(q.origin)) throw E.validation('Invalid `origin` parameter. It must be `bounce`, `complaint` or `manual`.');
    const dash = c.get('auth').source === 'dashboard';
    const filters = [ctx.sql`team_id = ${teamId(c)}`];
    if (q.origin) filters.push(ctx.sql`origin = ${q.origin}`);
    if (dash && q.q) filters.push(ctx.sql`email ilike ${`%${q.q.replace(/[\\%_]/g, '\\$&')}%`}`);
    if (dash && q.reason) filters.push(q.reason === 'unsubscribe' ? ctx.sql`false` : ctx.sql`origin = ${q.reason}`);
    const where = filters.reduce((x, y) => ctx.sql`${x} and ${y}`);
    const { rows, hasMore } = await paginate(ctx.sql, 'suppressions', where, page);
    if (!dash) return c.json(list(rows.map(suppressionItem), hasMore));
    // Dashboard extras: the diagnostic of the bounce/complaint that caused it.
    const ids = rows.map((r) => r.source_id).filter(Boolean) as string[];
    const evs = ids.length ? await ctx.sql`select distinct on (email_id) email_id::text, type, data from email_events where email_id = any(${ids}) and type in ('bounced', 'complained') order by email_id, created_at desc` : [];
    const byEmail = new Map(evs.map((e) => [e.email_id as string, e]));
    return c.json(list(rows.map((r) => {
      const ev = r.source_id ? byEmail.get(r.source_id as string) : undefined;
      const d = (ev?.data ?? {}) as Record<string, any>;
      return { ...suppressionItem(r), email_id: r.source_id ?? null, details: d.bounce?.message ?? (ev?.type === 'complained' ? 'Marked as spam by the recipient' : null) };
    }), hasMore));
  });
  const findSuppression = async (ctx: AppContext, team: string, key: string) => {
    const k = decodeURIComponent(key);
    if (UUID_RE.test(k)) return (await ctx.sql`select * from suppressions where team_id = ${team} and id = ${k}`)[0];
    if (isEmail(k)) return (await ctx.sql`select * from suppressions where team_id = ${team} and lower(email) = ${k.toLowerCase()}`)[0];
    throw E.validation('The suppression identifier must be a suppression ID or an email address.');
  };
  r.get('/suppressions/:suppression', async (c, ctx) => {
    const row = await findSuppression(ctx, teamId(c), param(c, 'suppression'));
    if (!row) throw E.notFound('Suppression not found');
    return c.json({ object: 'suppression', ...suppressionItem(row) });
  });
  r.delete('/suppressions/:suppression', async (c, ctx) => {
    const row = await findSuppression(ctx, teamId(c), param(c, 'suppression'));
    if (!row) throw E.notFound('Suppression not found');
    await removeSuppression(ctx, teamId(c), row);
    return c.json({ object: 'suppression', id: row.id, deleted: true });
  });

  // ---- OAuth grants (no OAuth apps are registered yet; see spec phase 2)
  r.get('/oauth/grants', async (c, ctx) => {
    const page = parsePage(query(c), 20);
    const { rows, hasMore } = await paginate(ctx.sql, 'oauth_grants', ctx.sql`team_id = ${teamId(c)}`, page);
    return c.json(list(rows.map((g) => ({ id: g.id, client_id: g.client_id, scopes: g.scopes, created_at: g.created_at, revoked_at: g.revoked_at ?? null, revoked_reason: g.revoked_reason ?? null, client: { name: g.client_name, logo_uri: g.client_logo_uri ?? null } })), hasMore));
  });
  r.delete('/oauth/grants/:oauth_grant_id', async (c, ctx) => {
    const id = uuidParam(c, 'oauth_grant_id', 'oauth_grant_id');
    const [g] = await ctx.sql`update oauth_grants set revoked_at = coalesce(revoked_at, now()), revoked_reason = coalesce(revoked_reason, 'revoked_by_user')
                              where id = ${id} and team_id = ${teamId(c)} returning id, revoked_at, revoked_reason`;
    if (!g) throw E.notFound('OAuth grant not found');
    return c.json({ object: 'oauth_grant', id: g.id, revoked_at: pgToIso(g.revoked_at as string), revoked_reason: g.revoked_reason });
  });
}
