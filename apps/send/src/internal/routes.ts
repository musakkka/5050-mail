/** /api/internal/* — the dashboard's JSON API. Documented in docs/internal-api.md. */
import type { Context, Hono } from 'hono';
import type { AppContext } from '../context.js';
import type { InternalBindings, PublicApi } from '../api/app.js';
import { isEmail } from '../lib/address.js';
import { isUuid } from '../lib/ids.js';
import { pgToIso } from '../db.js';
import { loadTeam, type AuthContext } from '../services/apiKeys.js';
import { usageObject } from '../api/routes/misc.js';
import { computeMetrics } from '../services/metrics.js';
import { smtpInfo, integrationSnippets } from '../services/integrations.js';
import { analyticsState } from '../services/analytics.js';
import type { InternalEnv } from './app.js';
import { registerDashboardExtras } from './extras.js';

type C = Context<InternalEnv>;

const bad = (c: C, message: string, status = 400) => c.json({ error: 'bad_request', message }, status as 400);
const forbidden = (c: C, message = 'You do not have access to this') => c.json({ error: 'forbidden', message }, 403);
const notFound = (c: C, message = 'Not found') => c.json({ error: 'not_found', message }, 404);

export interface TeamAccess {
  team: { id: string; name: string; monthly_quota: number; daily_quota: number | null; rate_limit: number };
  role: 'admin' | 'member' | 'superadmin';
}

/** Stalwart admins can reach every team (role superadmin); others only teams they belong to. */
export async function teamAccess(ctx: AppContext, c: C, teamId: string): Promise<TeamAccess | null> {
  if (!isUuid(teamId)) return null;
  const s = c.get('session');
  const team = await loadTeam(ctx.sql, teamId);
  if (!team) return null;
  if (s.isAdmin) return { team, role: 'superadmin' };
  const [m] = await ctx.sql`select role from team_members where team_id = ${teamId} and email = ${s.email}`;
  return m ? { team, role: m.role as 'admin' | 'member' } : null;
}

const canManage = (a: TeamAccess) => a.role === 'admin' || a.role === 'superadmin';

const teamView = (t: Record<string, unknown>, role?: string) => ({
  id: t.id, name: t.name, monthly_quota: t.monthly_quota, daily_quota: t.daily_quota ?? null, rate_limit: t.rate_limit,
  created_at: pgToIso(t.created_at as string), ...(role ? { role } : {}),
});

export function registerInternalRoutes(app: Hono<InternalEnv>, ctx: AppContext, api: PublicApi) {
  const base = '/api/internal';

  app.get(`${base}/me`, async (c) => {
    const s = c.get('session');
    const teams = s.isAdmin
      ? (await ctx.sql`select t.*, m.role from teams t left join team_members m on m.team_id = t.id and m.email = ${s.email} order by t.created_at`).map((t) => teamView(t, (t.role as string) ?? 'superadmin'))
      : (await ctx.sql`select t.*, m.role from teams t join team_members m on m.team_id = t.id where m.email = ${s.email} order by t.created_at`).map((t) => teamView(t, t.role as string));
    return c.json({ email: s.email, name: s.name, isAdmin: s.isAdmin, teams });
  });

  app.get(`${base}/system`, async (c) => {
    const st = await analyticsState(ctx);
    return c.json({
      apiBase: ctx.config.publicApiBase,
      dashboardBase: ctx.config.dashboardBase,
      transport: ctx.transport.name,
      cloudflareConfigured: !!ctx.cf,
      docsBase: process.env.DOCS_BASE ?? `${ctx.config.publicApiBase}/docs`,
      supportEmail: process.env.SUPPORT_EMAIL || null,
      analytics: st,
      warnings: st.authorized === false ? [{ code: 'analytics_unauthorized', message: 'Delivery tracking is limited: the Cloudflare API token cannot read Email Sending analytics (needs Account Analytics:Read). Emails stay at "sent" until it can.' }] : [],
    });
  });

  // ---------------- teams (developer accounts)
  app.get(`${base}/teams`, async (c) => {
    const s = c.get('session');
    const rows = s.isAdmin
      ? await ctx.sql`select t.*, (select count(*)::int from team_members m where m.team_id = t.id) as members from teams t order by t.created_at`
      : await ctx.sql`select t.*, m.role, (select count(*)::int from team_members x where x.team_id = t.id) as members from teams t join team_members m on m.team_id = t.id where m.email = ${s.email} order by t.created_at`;
    return c.json({ data: rows.map((t) => ({ ...teamView(t, (t.role as string | undefined) ?? (s.isAdmin ? 'superadmin' : undefined)), members: t.members })) });
  });

  app.post(`${base}/teams`, async (c) => {
    const s = c.get('session');
    if (!s.isAdmin) return forbidden(c, 'Only mail administrators can create teams');
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100) return bad(c, 'Enter a team name (max 100 characters)');
    const monthly = b.monthly_quota === undefined ? ctx.config.defaultMonthlyQuota : Number(b.monthly_quota);
    const daily = b.daily_quota === undefined || b.daily_quota === null ? ctx.config.defaultDailyQuota : Number(b.daily_quota);
    const rate = b.rate_limit === undefined ? ctx.config.defaultRateLimit : Number(b.rate_limit);
    if (!Number.isInteger(monthly) || monthly < 0 || (daily !== null && (!Number.isInteger(daily) || daily < 0)) || !Number.isInteger(rate) || rate < 1) return bad(c, 'Quotas must be non-negative integers; rate limit at least 1');
    const [t] = await ctx.sql`insert into teams (name, monthly_quota, daily_quota, rate_limit) values (${b.name.trim()}, ${monthly}, ${daily}, ${rate}) returning *`;
    const members = Array.isArray(b.members) ? (b.members as { email?: unknown; role?: unknown }[]) : [];
    for (const m of members) {
      if (typeof m.email !== 'string' || !isEmail(m.email)) continue;
      await ctx.sql`insert into team_members (team_id, email, role, added_by) values (${t!.id as string}, ${m.email.toLowerCase()}, ${m.role === 'admin' ? 'admin' : 'member'}, ${s.email}) on conflict do nothing`;
    }
    return c.json(teamView(t!), 201);
  });

  app.get(`${base}/teams/:teamId`, async (c) => {
    const a = await teamAccess(ctx, c, c.req.param('teamId'));
    if (!a) return notFound(c, 'Team not found');
    const [t] = await ctx.sql`select * from teams where id = ${a.team.id}`;
    return c.json({ ...teamView(t!, a.role), settings: t!.settings ?? {} });
  });

  app.patch(`${base}/teams/:teamId`, async (c) => {
    const a = await teamAccess(ctx, c, c.req.param('teamId'));
    if (!a) return notFound(c, 'Team not found');
    if (!canManage(a)) return forbidden(c, 'Only team admins can change team settings');
    const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const s = c.get('session');
    if ((b.monthly_quota !== undefined || b.daily_quota !== undefined || b.rate_limit !== undefined) && !s.isAdmin) return forbidden(c, 'Only mail administrators can change quotas and rate limits');
    const name = b.name === undefined ? a.team.name : String(b.name).trim();
    if (!name || name.length > 100) return bad(c, 'Enter a team name (max 100 characters)');
    const monthly = b.monthly_quota === undefined ? a.team.monthly_quota : Number(b.monthly_quota);
    const daily = b.daily_quota === undefined ? a.team.daily_quota : b.daily_quota === null ? null : Number(b.daily_quota);
    const rate = b.rate_limit === undefined ? a.team.rate_limit : Number(b.rate_limit);
    if (!Number.isInteger(monthly) || monthly < 0 || (daily !== null && (!Number.isInteger(daily) || daily < 0)) || !Number.isInteger(rate) || rate < 1) return bad(c, 'Quotas must be non-negative integers; rate limit at least 1');
    let settingsPatch: Record<string, unknown> = {};
    if (b.settings !== undefined) {
      if (!b.settings || typeof b.settings !== 'object' || Array.isArray(b.settings)) return bad(c, 'settings must be an object');
      settingsPatch = b.settings as Record<string, unknown>;
      if (JSON.stringify(settingsPatch).length > 20_000) return bad(c, 'settings is too large');
    }
    const [t] = await ctx.sql`update teams set name = ${name}, monthly_quota = ${monthly}, daily_quota = ${daily}, rate_limit = ${rate},
                              settings = settings || ${ctx.sql.json(settingsPatch as never)}, updated_at = now() where id = ${a.team.id} returning *`;
    return c.json({ ...teamView(t!, a.role), settings: t!.settings ?? {} });
  });

  app.delete(`${base}/teams/:teamId`, async (c) => {
    if (!c.get('session').isAdmin) return forbidden(c, 'Only mail administrators can delete teams');
    const id = c.req.param('teamId');
    if (!isUuid(id)) return notFound(c, 'Team not found');
    const rows = await ctx.sql`delete from teams where id = ${id} returning id`;
    if (!rows.length) return notFound(c, 'Team not found');
    return c.json({ id, deleted: true });
  });

  // ---------------- members
  app.get(`${base}/teams/:teamId/members`, async (c) => {
    const a = await teamAccess(ctx, c, c.req.param('teamId'));
    if (!a) return notFound(c, 'Team not found');
    const rows = await ctx.sql`select email, role, added_by, created_at from team_members where team_id = ${a.team.id} order by created_at`;
    return c.json({ data: rows.map((m) => ({ email: m.email, role: m.role, added_by: m.added_by ?? null, created_at: pgToIso(m.created_at as string) })) });
  });
  app.post(`${base}/teams/:teamId/members`, async (c) => {
    const a = await teamAccess(ctx, c, c.req.param('teamId'));
    if (!a) return notFound(c, 'Team not found');
    if (!canManage(a)) return forbidden(c, 'Only team admins can add members');
    const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (typeof b.email !== 'string' || !isEmail(b.email.trim())) return bad(c, 'Enter a valid email address');
    const role = b.role === 'admin' ? 'admin' : b.role === undefined || b.role === 'member' ? 'member' : null;
    if (!role) return bad(c, 'Role must be admin or member');
    const email = b.email.trim().toLowerCase();
    const [m] = await ctx.sql`insert into team_members (team_id, email, role, added_by) values (${a.team.id}, ${email}, ${role}, ${c.get('session').email})
                              on conflict (team_id, email) do update set role = excluded.role returning email, role, created_at`;
    return c.json({ email: m!.email, role: m!.role, created_at: pgToIso(m!.created_at as string) }, 201);
  });
  app.patch(`${base}/teams/:teamId/members/:email`, async (c) => {
    const a = await teamAccess(ctx, c, c.req.param('teamId'));
    if (!a) return notFound(c, 'Team not found');
    if (!canManage(a)) return forbidden(c, 'Only team admins can change roles');
    const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (b.role !== 'admin' && b.role !== 'member') return bad(c, 'Role must be admin or member');
    const email = decodeURIComponent(c.req.param('email')).toLowerCase();
    if (b.role === 'member') {
      const [n] = await ctx.sql`select count(*)::int as n from team_members where team_id = ${a.team.id} and role = 'admin' and email <> ${email}`;
      if (n!.n === 0 && !c.get('session').isAdmin) return bad(c, 'A team needs at least one admin', 409);
    }
    const rows = await ctx.sql`update team_members set role = ${b.role} where team_id = ${a.team.id} and email = ${email} returning email, role`;
    if (!rows.length) return notFound(c, 'Member not found');
    return c.json({ email: rows[0]!.email, role: rows[0]!.role });
  });
  app.delete(`${base}/teams/:teamId/members/:email`, async (c) => {
    const a = await teamAccess(ctx, c, c.req.param('teamId'));
    if (!a) return notFound(c, 'Team not found');
    const email = decodeURIComponent(c.req.param('email')).toLowerCase();
    const self = email === c.get('session').email;
    if (!canManage(a) && !self) return forbidden(c, 'Only team admins can remove members');
    const rows = await ctx.sql`delete from team_members where team_id = ${a.team.id} and email = ${email} returning email`;
    if (!rows.length) return notFound(c, 'Member not found');
    return c.json({ email, deleted: true });
  });

  // ---------------- team dashboard data
  const withTeam = (fn: (c: C, a: TeamAccess) => Promise<Response>) => async (c: C) => {
    const a = await teamAccess(ctx, c, c.req.param('teamId') ?? '');
    if (!a) return notFound(c, 'Team not found');
    return fn(c, a);
  };

  app.get(`${base}/teams/:teamId/usage`, withTeam(async (c, a) => c.json(await usageObject(ctx, a.team))));

  app.get(`${base}/teams/:teamId/overview`, withTeam(async (c, a) => {
    const [counts] = await ctx.sql`
      select (select count(*)::int from domains where team_id = ${a.team.id}) as domains,
             (select count(*)::int from domains where team_id = ${a.team.id} and status = 'verified') as verified_domains,
             (select count(*)::int from api_keys where team_id = ${a.team.id}) as api_keys,
             (select count(*)::int from webhooks where team_id = ${a.team.id}) as webhooks,
             (select count(*)::int from contacts where team_id = ${a.team.id}) as contacts,
             (select count(*)::int from emails where team_id = ${a.team.id} and created_at > now() - interval '30 days') as emails_30d`;
    const st = await analyticsState(ctx);
    return c.json({
      team: teamView(a.team as unknown as Record<string, unknown>, a.role),
      counts,
      usage: await usageObject(ctx, a.team),
      warnings: st.authorized === false ? [{ code: 'analytics_unauthorized', message: 'Delivery tracking is limited until the Cloudflare token can read Email Sending analytics.' }] : [],
    });
  }));

  /** Metrics page: any GET /emails/metrics query, plus a `days` shortcut. */
  app.get(`${base}/teams/:teamId/metrics`, withTeam(async (c, a) => {
    const q = c.req.queries();
    const days = Number(q.days?.[0] ?? 0);
    const start = q.start_date?.[0] ?? (days > 0 ? new Date(ctx.now().getTime() - days * 86400_000).toISOString() : undefined);
    return c.json(await computeMetrics(ctx, a.team.id, {
      start_date: start, end_date: q.end_date?.[0], timezone: q.timezone?.[0], granularity: q.granularity?.[0],
      metrics: q.metrics, dimensions: q.dimensions ?? ['period'], domain_id: q.domain_id, email_id: q.email_id, broadcast_id: q.broadcast_id,
    }));
  }));

  /** Daily rollups (worker-maintained) for fast charts. */
  app.get(`${base}/teams/:teamId/stats/daily`, withTeam(async (c, a) => {
    const days = Math.min(400, Math.max(1, Number(c.req.query('days') ?? 30)));
    const rows = await ctx.sql`select day::text, domain_id, metrics from stats_daily where team_id = ${a.team.id} and day >= current_date - ${days}::int order by day, domain_id`;
    return c.json({ data: rows.map((r) => ({ day: r.day, domain_id: r.domain_id === '00000000-0000-0000-0000-000000000000' ? null : r.domain_id, ...(r.metrics as object) })) });
  }));

  app.get(`${base}/teams/:teamId/emails/:emailId/events`, withTeam(async (c, a) => {
    const id = c.req.param('emailId');
    if (!isUuid(id)) return notFound(c, 'Email not found');
    const [e] = await ctx.sql`select id from emails where id = ${id} and team_id = ${a.team.id}`;
    if (!e) return notFound(c, 'Email not found');
    const rows = await ctx.sql`select type, recipient, data, created_at from email_events where email_id = ${id} order by created_at, id`;
    const enrich = (d: Record<string, any>) => {
      const message = d.bounce?.message ?? d.suppressed?.message ?? d.message ?? (d.failed ? undefined : undefined);
      const reason = d.failed?.reason ?? d.suppressed?.type ?? d.reason;
      return { ...d, ...(message ? { message } : {}), ...(d.click?.link ? { link: d.click.link } : {}), ...(reason ? { reason } : {}) };
    };
    return c.json({ data: rows.map((r) => ({ type: r.type, recipient: r.recipient ?? null, data: enrich((r.data ?? {}) as Record<string, any>), created_at: pgToIso(r.created_at as string) })) });
  }));

  app.get(`${base}/teams/:teamId/logs`, withTeam(async (c, a) => {
    const q = c.req.query();
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50)));
    const filters = [ctx.sql`team_id = ${a.team.id}`];
    if (q.status) filters.push(q.status.endsWith('xx') ? ctx.sql`response_status / 100 = ${Number(q.status[0])}` : ctx.sql`response_status = ${Number(q.status)}`);
    if (q.method) filters.push(ctx.sql`method = ${q.method.toUpperCase()}`);
    if (q.endpoint) filters.push(ctx.sql`endpoint like ${q.endpoint.replace(/[%_]/g, '\\$&') + '%'}`);
    if (q.api_key_id && isUuid(q.api_key_id)) filters.push(ctx.sql`api_key_id = ${q.api_key_id}`);
    if (q.source) filters.push(ctx.sql`source = ${q.source}`);
    if (q.before && isUuid(q.before)) filters.push(ctx.sql`(created_at, id) < (select created_at, id from api_logs where id = ${q.before})`);
    const where = filters.reduce((x, f) => ctx.sql`${x} and ${f}`);
    const rows = await ctx.sql`select id, created_at, method, endpoint, response_status, user_agent, api_key_id, source, duration_ms, ip from api_logs where ${where} order by created_at desc, id desc limit ${limit + 1}`;
    return c.json({ has_more: rows.length > limit, data: rows.slice(0, limit).map((l) => ({ ...l, created_at: pgToIso(l.created_at as string) })) });
  }));
  app.get(`${base}/teams/:teamId/logs/:logId`, withTeam(async (c, a) => {
    const id = c.req.param('logId');
    if (!isUuid(id)) return notFound(c);
    const [l] = await ctx.sql`select * from api_logs where id = ${id} and team_id = ${a.team.id}`;
    if (!l) return notFound(c, 'Log not found');
    return c.json({ ...l, created_at: pgToIso(l.created_at as string) });
  }));

  app.get(`${base}/teams/:teamId/webhooks/:webhookId/events/:eventId/attempts`, withTeam(async (c, a) => {
    const wid = c.req.param('webhookId');
    if (!isUuid(wid)) return notFound(c);
    const rows = await ctx.sql`select id, http_status_code, response, error, duration_ms, is_replay, sent_at from webhook_attempts
                               where webhook_id = ${wid} and webhook_event_id = ${c.req.param('eventId')} and team_id = ${a.team.id} order by sent_at desc, id desc`;
    return c.json({ data: rows.map((r) => ({ ...r, sent_at: pgToIso(r.sent_at as string) })) });
  }));
  app.get(`${base}/teams/:teamId/webhooks/:webhookId/health`, withTeam(async (c, a) => {
    const wid = c.req.param('webhookId');
    if (!isUuid(wid)) return notFound(c);
    const [w] = await ctx.sql`select status, failing_since, disabled_reason from webhooks where id = ${wid} and team_id = ${a.team.id}`;
    if (!w) return notFound(c, 'Webhook not found');
    const [s] = await ctx.sql`select count(*) filter (where status = 'success')::int as success, count(*) filter (where status = 'failed')::int as failed,
                              count(*) filter (where status in ('pending','attempting'))::int as pending from webhook_events where webhook_id = ${wid} and created_at > now() - interval '7 days'`;
    return c.json({ status: w.status, failing_since: pgToIso(w.failing_since as string), disabled_reason: w.disabled_reason ?? null, last_7_days: s });
  }));

  app.get(`${base}/teams/:teamId/domains/:domainId/cloudflare`, withTeam(async (c, a) => {
    const id = c.req.param('domainId');
    if (!isUuid(id)) return notFound(c);
    const [d] = await ctx.sql`select cf_zone_id, cf_zone_name, cf_enabled, last_error, last_checked_at, verified_at from domains where id = ${id} and team_id = ${a.team.id}`;
    if (!d) return notFound(c, 'Domain not found');
    return c.json({ zone_id: d.cf_zone_id ?? null, zone: d.cf_zone_name ?? null, managed: !!d.cf_zone_id, sending_enabled: d.cf_enabled, last_error: d.last_error ?? null,
      last_checked_at: pgToIso(d.last_checked_at as string), verified_at: pgToIso(d.verified_at as string) });
  }));

  app.get(`${base}/teams/:teamId/smtp`, withTeam(async (c) => c.json(smtpInfo(ctx))));
  app.get(`${base}/teams/:teamId/integrations`, withTeam(async (c) => c.json({ smtp: smtpInfo(ctx), snippets: integrationSnippets(ctx) })));

  registerDashboardExtras(app, ctx, teamAccess);

  // ---------------- everything the public API does, as this team
  app.all(`${base}/teams/:teamId/resend/*`, async (c) => {
    const a = await teamAccess(ctx, c, c.req.param('teamId'));
    if (!a) return notFound(c, 'Team not found');
    const s = c.get('session');
    const prefix = `${base}/teams/${c.req.param('teamId')}/resend`;
    const u = new URL(c.req.url);
    const sub = u.pathname.slice(prefix.length) || '/';
    u.pathname = sub; // the URL parser resolves dot segments (incl. %2e) exactly as the API router will see them
    // Authorize on the decoded, normalized route, not the raw path (`/%61pi-keys`, `//api-keys`, `/API-KEYS` …).
    let route: string;
    try {
      route = decodeURIComponent(u.pathname).replace(/\/{2,}/g, '/').toLowerCase();
    } catch {
      return c.json({ error: 'bad_request', message: 'Malformed path' }, 400);
    }
    if (a.role === 'member' && /^\/api-keys(\/|$)/.test(route) && c.req.method !== 'GET' && c.req.method !== 'HEAD') return forbidden(c, 'Only team admins can manage API keys');
    const auth: AuthContext = { team: a.team, apiKeyId: null, permission: 'full_access', domainId: null, source: 'dashboard', actor: s.email, platformAdmin: a.role === 'superadmin' };
    const headers = new Headers(c.req.raw.headers);
    headers.delete('cookie');
    const init: RequestInit = { method: c.req.method, headers };
    if (!['GET', 'HEAD'].includes(c.req.method)) init.body = await c.req.arrayBuffer();
    const env: InternalBindings = { dashboardAuth: auth };
    return api.app.fetch(new Request(u, init), env);
  });
}
