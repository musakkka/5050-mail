/**
 * Dashboard-only endpoints requested in docs/dashboard-needs.md (filtered email list,
 * raw MIME, API keys with permission/preview, one-click Cloudflare, JSON contact import).
 * Registered before the /resend/* passthrough so they can shadow it where needed.
 */
import type { Context, Hono } from 'hono';
import type { AppContext } from '../context.js';
import { pgToIso } from '../db.js';
import { isEmail } from '../lib/address.js';
import { isUuid } from '../lib/ids.js';
import { buildMime } from '../services/mime.js';
import { refreshFromCloudflare, runVerification, startVerification, type DomainRow } from '../services/domains.js';
import type { InternalEnv } from './app.js';
import type { TeamAccess } from './routes.js';

type C = Context<InternalEnv>;
type Access = (ctx: AppContext, c: C, teamId: string) => Promise<TeamAccess | null>;

const notFound = (c: C, message = 'Not found') => c.json({ error: 'not_found', message }, 404);
const bad = (c: C, message: string) => c.json({ error: 'bad_request', message }, 400);

export async function cloudflareView(ctx: AppContext, teamId: string, domainId: string) {
  const [d] = await ctx.sql`select cf_zone_id, cf_zone_name, cf_enabled, last_error, last_checked_at, verified_at from domains where id = ${domainId} and team_id = ${teamId}`;
  if (!d) return null;
  return {
    zone_id: d.cf_zone_id ?? null, zone: d.cf_zone_name ?? null, managed: !!d.cf_zone_id, sending_enabled: d.cf_enabled, last_error: d.last_error ?? null,
    last_checked_at: pgToIso(d.last_checked_at as string), verified_at: pgToIso(d.verified_at as string),
  };
}

export function registerDashboardExtras(app: Hono<InternalEnv>, ctx: AppContext, teamAccess: Access) {
  const base = '/api/internal/teams/:teamId';
  const withTeam = (fn: (c: C, a: TeamAccess) => Promise<Response>) => async (c: C) => {
    const a = await teamAccess(ctx, c, c.req.param('teamId') ?? '');
    if (!a) return notFound(c, 'Team not found');
    return fn(c, a);
  };

  // 1. Filtered email list
  app.get(`${base}/emails`, withTeam(async (c, a) => {
    const q = c.req.query();
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 40) || 40));
    const f = [ctx.sql`team_id = ${a.team.id}`];
    if (q.status) f.push(ctx.sql`last_event = ${q.status}`);
    if (q.api_key_id && isUuid(q.api_key_id)) f.push(ctx.sql`api_key_id = ${q.api_key_id}`);
    if (q.start && !Number.isNaN(Date.parse(q.start))) f.push(ctx.sql`created_at >= ${new Date(q.start).toISOString()}`);
    if (q.end && !Number.isNaN(Date.parse(q.end))) f.push(ctx.sql`created_at <= ${new Date(q.end).toISOString()}`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
      f.push(ctx.sql`(subject ilike ${like} or from_addr ilike ${like} or array_to_string(to_addrs, ',') ilike ${like} or id::text = ${q.q.toLowerCase()})`);
    }
    const cursorId = q.after ?? q.before;
    let backward = false;
    if (cursorId && isUuid(cursorId)) {
      backward = !q.after;
      f.push(backward
        ? ctx.sql`(created_at, id) > (select created_at, id from emails where id = ${cursorId} and team_id = ${a.team.id})`
        : ctx.sql`(created_at, id) < (select created_at, id from emails where id = ${cursorId} and team_id = ${a.team.id})`);
    }
    const where = f.reduce((x, y) => ctx.sql`${x} and ${y}`);
    let rows: Record<string, unknown>[] = backward
      ? await ctx.sql`select * from emails where ${where} order by created_at asc, id asc limit ${limit + 1}`
      : await ctx.sql`select * from emails where ${where} order by created_at desc, id desc limit ${limit + 1}`;
    const hasMore = rows.length > limit;
    rows = rows.slice(0, limit);
    if (backward) rows = [...rows].reverse();
    return c.json({
      object: 'list', has_more: hasMore,
      data: rows.map((r) => ({
        object: 'email', id: r.id, to: r.to_addrs, from: r.from_addr, created_at: r.created_at, subject: r.subject,
        bcc: r.bcc ?? null, cc: r.cc ?? null, reply_to: r.reply_to ?? null, last_event: r.last_event, scheduled_at: r.scheduled_at ?? null,
        api_key_id: r.api_key_id ?? null, source: r.source,
      })),
    });
  }));

  // 2. Raw MIME (as we would hand it to the transport; tracking/rewrites not applied)
  app.get(`${base}/emails/:emailId/raw`, withTeam(async (c, a) => {
    const id = c.req.param('emailId');
    if (!isUuid(id)) return notFound(c, 'Email not found');
    const [e] = await ctx.sql`select * from emails where id = ${id} and team_id = ${a.team.id}`;
    if (!e) return notFound(c, 'Email not found');
    const atts = await ctx.sql`select filename, content_type, content_id, disposition, content from email_attachments where email_id = ${id} order by created_at, id`;
    const raw = await buildMime({
      messageId: e.message_id as string, from: e.from_addr as string, to: e.to_addrs as string[], cc: e.cc as string[] | null,
      replyTo: e.reply_to as string[] | null, subject: e.subject as string, html: e.html as string | null, text: e.text as string | null,
      headers: e.headers as Record<string, string> | null, date: new Date(String(e.sent_at ?? e.created_at).replace(' ', 'T').replace(/\+00$/, 'Z')),
      attachments: atts.map((x) => ({ filename: x.filename as string | null, contentType: x.content_type as string, contentId: x.content_id as string | null, disposition: x.disposition as 'inline' | 'attachment', content: (x.content as Buffer | null) ?? Buffer.alloc(0) })),
    });
    return c.json({ raw: raw.toString('utf8') });
  }));

  // 3. API keys with dashboard fields
  app.get(`${base}/api-keys`, withTeam(async (c, a) => {
    const rows = await ctx.sql`select id, name, created_at, last_used_at, permission, domain_id, token_prefix, created_by from api_keys where team_id = ${a.team.id} order by created_at desc, id desc`;
    return c.json({
      object: 'list', has_more: false,
      data: rows.map((k) => ({ id: k.id, name: k.name, created_at: k.created_at, last_used_at: k.last_used_at ?? null, permission: k.permission,
        domain_id: k.domain_id ?? null, token_preview: `re_${k.token_prefix as string}`, created_by: k.created_by ?? null })),
    });
  }));

  // 6. One-click Cloudflare connect
  app.post(`${base}/domains/:domainId/cloudflare`, withTeam(async (c, a) => {
    const id = c.req.param('domainId');
    if (!isUuid(id)) return notFound(c, 'Domain not found');
    const b = ((await c.req.json().catch(() => null)) ?? {}) as { action?: unknown };
    if (b.action !== 'connect') return bad(c, 'action must be "connect"');
    const [d] = await ctx.sql`select * from domains where id = ${id} and team_id = ${a.team.id}`;
    if (!d) return notFound(c, 'Domain not found');
    if (!ctx.cf) return c.json({ error: 'not_configured', message: 'Cloudflare is not configured on this server' }, 409);
    // Connecting a zone of the operator's Cloudflare account is a platform-admin action: it
    // publishes records and makes the zone's DNS count as proof of ownership.
    if (a.role !== 'superadmin') return c.json({ error: 'forbidden', message: 'Only platform administrators can connect a domain through Cloudflare' }, 403);
    const [managed] = await ctx.sql`update domains set cf_managed = true where id = ${id} returning *`;
    const fresh = await refreshFromCloudflare(ctx, managed as unknown as DomainRow, { onboard: true });
    if (fresh.cf_enabled) {
      await startVerification(ctx, fresh);
      await runVerification(ctx, id, ctx.now());
    }
    return c.json(await cloudflareView(ctx, a.team.id, id));
  }));

  // 7. JSON contact import (rows parsed in the browser). No contact.* webhooks, like Resend imports.
  app.post(`${base}/resend/contacts/imports`, async (c, next) => {
    if (!(c.req.header('content-type') ?? '').includes('application/json')) return next();
    const a = await teamAccess(ctx, c, c.req.param('teamId') ?? '');
    if (!a) return notFound(c, 'Team not found');
    const b = ((await c.req.json().catch(() => null)) ?? {}) as { contacts?: unknown; segment_id?: unknown };
    if (!Array.isArray(b.contacts)) return bad(c, 'contacts must be an array');
    if (b.contacts.length > 10_000) return bad(c, 'At most 10,000 contacts per import');
    let segmentId: string | null = null;
    if (b.segment_id) {
      if (!isUuid(b.segment_id)) return bad(c, 'segment_id must be a UUID');
      const [s] = await ctx.sql`select id from segments where id = ${b.segment_id} and team_id = ${a.team.id}`;
      if (!s) return notFound(c, 'Segment not found');
      segmentId = b.segment_id;
    }
    let imported = 0;
    let skipped = 0;
    for (const r of b.contacts as Record<string, unknown>[]) {
      const email = typeof r?.email === 'string' ? r.email.trim() : '';
      if (!isEmail(email)) {
        skipped++;
        continue;
      }
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      const [row] = await ctx.sql`
        insert into contacts (team_id, email, first_name, last_name, unsubscribed)
        values (${a.team.id}, ${email}, ${str(r.first_name)}, ${str(r.last_name)}, ${r.unsubscribed === true})
        on conflict (team_id, lower(email)) do nothing returning id`;
      if (!row) {
        skipped++;
        if (segmentId) await ctx.sql`insert into contact_segments (contact_id, segment_id) select id, ${segmentId} from contacts where team_id = ${a.team.id} and lower(email) = ${email.toLowerCase()} on conflict do nothing`;
        continue;
      }
      imported++;
      if (segmentId) await ctx.sql`insert into contact_segments (contact_id, segment_id) values (${row.id as string}, ${segmentId}) on conflict do nothing`;
    }
    const counts = { total: b.contacts.length, created: imported, updated: 0, skipped, failed: 0 };
    const [imp] = await ctx.sql`insert into contact_imports (team_id, status, options, counts, completed_at)
                                values (${a.team.id}, 'completed', ${ctx.sql.json({ source: 'dashboard', segment_id: segmentId })}, ${ctx.sql.json(counts)}, now()) returning id`;
    return c.json({ id: imp!.id, imported, skipped }, 201);
  });
}
