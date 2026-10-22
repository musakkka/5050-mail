import net from 'node:net';
import type { AppContext } from '../../context.js';
import { pgToIso } from '../../db.js';
import { E } from '../../lib/errors.js';
import { list, paginate, parsePage } from '../../lib/pagination.js';
import { isPrivateIp } from '../../lib/ssrf.js';
import { newSigningSecret, replay, WEBHOOK_EVENT_TYPES } from '../../services/webhooks.js';
import { body, param, query, teamId, uuidParam, type Router } from '../router.js';

export function validateEndpoint(ctx: AppContext, v: unknown): string {
  if (typeof v !== 'string' || !v) throw E.validation('Invalid `endpoint` field. It must be a valid URL.');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw E.validation('Invalid `endpoint` field. It must be a valid URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw E.validation('Invalid `endpoint` field. It must use https.');
  if (u.username || u.password) throw E.validation('Invalid `endpoint` field. URLs with credentials are not allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!ctx.config.allowPrivateWebhooks && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || (net.isIP(host) && isPrivateIp(host)))) {
    throw E.validation('Invalid `endpoint` field. Private and loopback addresses are not allowed.');
  }
  return v;
}

export function validateEvents(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length) throw E.validation('Invalid `events` field. It must be a non-empty array of event types.');
  for (const e of v) {
    if (typeof e !== 'string' || !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(e)) throw E.validation(`Invalid event type \`${String(e)}\`. See https://resend.com/docs/webhooks/event-types.`);
  }
  return [...new Set(v as string[])];
}

const iso = (s: unknown) => pgToIso(s as string);

export function registerWebhookRoutes(r: Router) {
  r.post('/webhooks', async (c, ctx) => {
    const b = body(c);
    if (b.endpoint === undefined) throw E.missingField('endpoint');
    if (b.events === undefined) throw E.missingField('events');
    const endpoint = validateEndpoint(ctx, b.endpoint);
    const events = validateEvents(b.events);
    const secret = newSigningSecret();
    const [row] = await ctx.sql`insert into webhooks (team_id, endpoint, events, signing_secret) values (${teamId(c)}, ${endpoint}, ${events}, ${secret}) returning id`;
    return c.json({ object: 'webhook', id: row!.id, signing_secret: secret }, 201);
  });

  r.get('/webhooks', async (c, ctx) => {
    const page = parsePage(query(c), null);
    const { rows, hasMore } = await paginate(ctx.sql, 'webhooks', ctx.sql`team_id = ${teamId(c)}`, page);
    return c.json(list(rows.map((w) => ({ id: w.id, created_at: w.created_at, status: w.status, endpoint: w.endpoint, events: w.events ?? null })), hasMore));
  });

  r.get('/webhooks/:webhook_id', async (c, ctx) => {
    const id = uuidParam(c, 'webhook_id', 'webhook_id');
    const [w] = await ctx.sql`select * from webhooks where id = ${id} and team_id = ${teamId(c)}`;
    if (!w) throw E.notFound('Webhook not found');
    return c.json({ object: 'webhook', id: w.id, created_at: w.created_at, status: w.status, endpoint: w.endpoint, events: w.events ?? null, signing_secret: w.signing_secret });
  });

  r.patch('/webhooks/:webhook_id', async (c, ctx) => {
    const id = uuidParam(c, 'webhook_id', 'webhook_id');
    const b = body(c);
    const [w] = await ctx.sql`select * from webhooks where id = ${id} and team_id = ${teamId(c)}`;
    if (!w) throw E.notFound('Webhook not found');
    const endpoint = b.endpoint !== undefined ? validateEndpoint(ctx, b.endpoint) : (w.endpoint as string);
    const events = b.events !== undefined ? validateEvents(b.events) : (w.events as string[] | null);
    if (b.status !== undefined && b.status !== 'enabled' && b.status !== 'disabled') throw E.validation('Invalid `status` field. It must be `enabled` or `disabled`.');
    const status = (b.status as string | undefined) ?? (w.status as string);
    await ctx.sql`update webhooks set endpoint = ${endpoint}, events = ${events}, status = ${status},
                  failing_since = case when ${status} = 'enabled' and status = 'disabled' then null else failing_since end,
                  disabled_reason = case when ${status} = 'enabled' then null else disabled_reason end, updated_at = now()
                  where id = ${id}`;
    return c.json({ object: 'webhook', id });
  });

  r.delete('/webhooks/:webhook_id', async (c, ctx) => {
    const id = uuidParam(c, 'webhook_id', 'webhook_id');
    const rows = await ctx.sql`delete from webhooks where id = ${id} and team_id = ${teamId(c)} returning id`;
    if (!rows.length) throw E.notFound('Webhook not found');
    return c.json({ object: 'webhook', id, deleted: true });
  });

  r.post('/webhooks/:webhook_id/signing-secret/rotate', async (c, ctx) => {
    const id = uuidParam(c, 'webhook_id', 'webhook_id');
    const secret = newSigningSecret();
    const rows = await ctx.sql`
      update webhooks set previous_secret = signing_secret, previous_secret_expires_at = now() + interval '24 hours', signing_secret = ${secret}, updated_at = now()
      where id = ${id} and team_id = ${teamId(c)} returning id`;
    if (!rows.length) throw E.notFound('Webhook not found');
    return c.json({ object: 'webhook', id, signing_secret: secret });
  });

  r.get('/webhooks/:webhook_id/events', async (c, ctx) => {
    const id = uuidParam(c, 'webhook_id', 'webhook_id');
    const [w] = await ctx.sql`select id from webhooks where id = ${id} and team_id = ${teamId(c)}`;
    if (!w) throw E.notFound('Webhook not found');
    const page = parsePage(query(c), 20, { before: false, uuidCursor: false });
    const { rows, hasMore } = await paginate(ctx.sql, 'webhook_events', ctx.sql`webhook_id = ${id} and team_id = ${teamId(c)}`, page, ctx.sql`id, type, created_at, status`);
    return c.json(list(rows.map((e) => ({ id: e.id, type: e.type, created_at: iso(e.created_at), status: e.status })), hasMore));
  });

  r.get('/webhooks/:webhook_id/events/:event_id', async (c, ctx) => {
    const id = uuidParam(c, 'webhook_id', 'webhook_id');
    const [e] = await ctx.sql`select * from webhook_events where webhook_id = ${id} and id = ${param(c, 'event_id')} and team_id = ${teamId(c)}`;
    if (!e) throw E.notFound('Webhook event not found');
    return c.json({ object: 'webhook_event', id: e.id, type: e.type, created_at: iso(e.created_at), status: e.status, next_attempt_at: e.next_attempt_at && (e.status === 'pending' || e.status === 'attempting') ? iso(e.next_attempt_at) : null, payload: e.payload });
  });

  r.post('/webhooks/:webhook_id/events/:event_id/replay', async (c, ctx) => {
    const id = uuidParam(c, 'webhook_id', 'webhook_id');
    const eid = param(c, 'event_id');
    const [e] = await ctx.sql`select id from webhook_events where webhook_id = ${id} and id = ${eid} and team_id = ${teamId(c)}`;
    if (!e) throw E.notFound('Webhook event not found');
    await replay(ctx, id, eid);
    return c.json({ object: 'webhook_event', id: eid });
  });

  r.get('/webhooks/:webhook_id/events/:event_id/attempts', async (c, ctx) => {
    const id = uuidParam(c, 'webhook_id', 'webhook_id');
    const eid = param(c, 'event_id');
    const [e] = await ctx.sql`select id from webhook_events where webhook_id = ${id} and id = ${eid} and team_id = ${teamId(c)}`;
    if (!e) throw E.notFound('Webhook event not found');
    const page = parsePage(query(c), 20, { before: false, uuidCursor: false });
    const { rows, hasMore } = await paginate(ctx.sql, 'webhook_attempts', ctx.sql`webhook_id = ${id} and webhook_event_id = ${eid}`, page, ctx.sql`*`, 'sent_at');
    return c.json(list(rows.map((a) => ({ id: a.id, http_status_code: a.http_status_code ?? 0, response: (a.response as string | null) ?? (a.error as string | null) ?? '', sent_at: iso(a.sent_at) })), hasMore));
  });
}
