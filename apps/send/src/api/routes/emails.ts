import type { Context } from 'hono';
import type { AppContext } from '../../context.js';
import { pgToDate, pgToIso } from '../../db.js';
import { E } from '../../lib/errors.js';
import { list, paginate, parsePage } from '../../lib/pagination.js';
import { parseDuration, parseWhen } from '../../lib/time.js';
import { signToken } from '../../lib/crypto.js';
import { checkQuota, createBatch, normalize, persist, quotaUsage, MAX_SCHEDULE_DAYS, type SendInput } from '../../services/emails.js';
import { withIdempotency } from '../../services/idempotency.js';
import { cancelJob, rescheduleJob } from '../../services/jobs.js';
import { recordEvent, type EmailRow } from '../../services/emailEvents.js';
import type { AuthContext } from '../../services/apiKeys.js';
import { body, query, teamId, uuidParam, type ApiEnv, type Router } from '../router.js';
import { registerMetricsRoutes } from './metrics.js';
import { registerReceivingRoutes } from './receiving.js';

const emailListItem = (r: Record<string, unknown>) => ({
  id: r.id,
  to: r.to_addrs,
  from: r.from_addr,
  created_at: r.created_at,
  subject: r.subject,
  bcc: r.bcc ?? null,
  cc: r.cc ?? null,
  reply_to: r.reply_to ?? null,
  last_event: r.last_event,
  scheduled_at: r.last_event === 'scheduled' || r.scheduled_at ? r.scheduled_at ?? null : null,
  message_id: r.message_id,
});

export function emailObject(r: Record<string, unknown>) {
  return {
    object: 'email',
    id: r.id,
    to: r.to_addrs,
    from: r.from_addr,
    created_at: r.created_at,
    subject: r.subject,
    html: r.html ?? null,
    text: r.text ?? null,
    bcc: r.bcc ?? [],
    cc: r.cc ?? [],
    reply_to: r.reply_to ?? [],
    last_event: r.last_event,
    scheduled_at: r.scheduled_at ?? null,
    ...(r.tags ? { tags: r.tags } : {}),
    ...(r.topic_id ? { topic_id: r.topic_id } : {}),
    message_id: r.message_id,
  };
}

export async function quotaHeaders(c: Context<ApiEnv>, ctx: AppContext, auth: AuthContext) {
  const u = await quotaUsage(ctx.sql, auth.team.id, ctx.now());
  c.header('x-resend-monthly-quota', String(u.monthly));
  if (auth.team.daily_quota !== null) c.header('x-resend-daily-quota', String(u.daily));
}

export function attachmentObject(ctx: AppContext, kind: 'sent' | 'received', r: Record<string, unknown>, withObject: boolean) {
  const exp = new Date(ctx.now().getTime() + 3600_000);
  const token = signToken(ctx.config.sessionSecret, 'attachment', { k: kind, a: r.id, x: Math.floor(exp.getTime() / 1000) });
  return {
    ...(withObject ? { object: 'attachment' } : {}),
    id: r.id,
    filename: r.filename ?? null,
    size: r.size,
    content_type: r.content_type,
    content_disposition: r.disposition ?? (r.content_id ? 'inline' : 'attachment'),
    content_id: r.content_id ?? null,
    download_url: `${ctx.config.publicApiBase}/attachments/${token}`,
    expires_at: exp.toISOString(),
  };
}

export function shareUrl(ctx: AppContext, kind: 'sent' | 'received', id: string, expiresInSec: number): string {
  const token = signToken(ctx.config.sessionSecret, 'share', { k: kind, e: id, x: Math.floor(ctx.now().getTime() / 1000) + expiresInSec });
  return `${ctx.config.dashboardBase}/shared?token=${token}`;
}

export function registerEmailRoutes(r: Router) {
  r.post(
    '/emails',
    async (c, ctx) => {
      const auth = c.get('auth');
      const res = await withIdempotency(ctx, auth.team.id, 'POST /emails', c.req.header('idempotency-key'), c.get('rawBody') ?? '', async () => {
        const n = await normalize(ctx, auth, body<SendInput>(c), { source: auth.source === 'dashboard' ? 'dashboard' : 'api' });
        await checkQuota(ctx, auth, 1);
        const [id] = await persist(ctx, auth, [n], { source: auth.source === 'dashboard' ? 'dashboard' : 'api' });
        return { status: 200, body: { id } };
      });
      await quotaHeaders(c, ctx, auth);
      return c.json(res.body as object, res.status as 200);
    },
    { sending: true },
  );

  r.post(
    '/emails/batch',
    async (c, ctx) => {
      const auth = c.get('auth');
      const mode = (c.req.header('x-batch-validation') ?? 'strict').toLowerCase();
      if (mode !== 'strict' && mode !== 'permissive') throw E.validation('The `x-batch-validation` header must be `strict` or `permissive`.');
      const res = await withIdempotency(ctx, auth.team.id, 'POST /emails/batch', c.req.header('idempotency-key'), `${mode}\n${c.get('rawBody') ?? ''}`, async () => {
        const out = await createBatch(ctx, auth, c.get('requestBody'), mode, { source: 'api' });
        return { status: 200, body: out };
      });
      await quotaHeaders(c, ctx, auth);
      return c.json(res.body as object, res.status as 200);
    },
    { sending: true },
  );

  r.get('/emails', async (c, ctx) => {
    const page = parsePage(query(c), 20);
    const { rows, hasMore } = await paginate(ctx.sql, 'emails', ctx.sql`team_id = ${teamId(c)}`, page);
    return c.json(list(rows.map(emailListItem), hasMore));
  });

  // Static sub-paths must be registered before /emails/:email_id.
  registerMetricsRoutes(r);
  registerReceivingRoutes(r);

  r.get('/emails/:email_id', async (c, ctx) => {
    const id = uuidParam(c, 'email_id', 'id');
    const [row] = await ctx.sql`select * from emails where id = ${id} and team_id = ${teamId(c)}`;
    if (!row) throw E.notFound('Email not found');
    if (c.get('auth').source === 'dashboard') {
      const [log] = await ctx.sql`select id from api_logs where team_id = ${teamId(c)} and response_body->>'id' = ${id} order by created_at limit 1`;
      return c.json({ ...emailObject(row), api_key_id: row.api_key_id ?? null, log_id: log?.id ?? null, source: row.source });
    }
    return c.json(emailObject(row));
  });

  r.patch('/emails/:email_id', async (c, ctx) => {
    const id = uuidParam(c, 'email_id', 'id');
    const b = body<{ scheduled_at?: unknown }>(c);
    if (b.scheduled_at === undefined || b.scheduled_at === null || b.scheduled_at === '') throw E.missingField('scheduled_at');
    if (typeof b.scheduled_at !== 'string') throw E.validation('Invalid `scheduled_at` field.');
    const when = parseWhen(b.scheduled_at, ctx.now());
    if (!when) throw E.validation('Invalid `scheduled_at` field. Use ISO 8601 (e.g. 2026-08-05T11:52:01.858Z) or natural language (e.g. "in 1 min").');
    if (when.getTime() <= ctx.now().getTime()) throw E.validation('The `scheduled_at` date must be in the future.');
    if (when.getTime() > ctx.now().getTime() + MAX_SCHEDULE_DAYS * 86400_000) throw E.validation('Emails can be scheduled up to 30 days in advance.');
    const [row] = await ctx.sql`select id, last_event from emails where id = ${id} and team_id = ${teamId(c)}`;
    if (!row) throw E.notFound('Email not found');
    if (row.last_event !== 'scheduled') throw E.validation('Only scheduled emails can be updated.');
    await ctx.sql`update emails set scheduled_at = ${when.toISOString()}, updated_at = now() where id = ${id}`;
    await rescheduleJob(ctx.sql, `email:${id}`, when);
    return c.json({ object: 'email', id });
  });

  r.post('/emails/:email_id/cancel', async (c, ctx) => {
    const id = uuidParam(c, 'email_id', 'id');
    const [row] = await ctx.sql`select * from emails where id = ${id} and team_id = ${teamId(c)}`;
    if (!row) throw E.notFound('Email not found');
    if (row.last_event !== 'scheduled') throw E.validation('Only scheduled emails can be canceled.');
    await cancelJob(ctx.sql, `email:${id}`);
    await recordEvent(ctx, row as unknown as EmailRow, 'canceled');
    return c.json({ object: 'email', id });
  });

  r.post('/emails/:email_id/share', async (c, ctx) => {
    const id = uuidParam(c, 'email_id', 'id');
    const b = body<{ expires_in?: unknown }>(c);
    let secs = 48 * 3600;
    if (b.expires_in !== undefined && b.expires_in !== null) {
      const d = typeof b.expires_in === 'string' ? parseDuration(b.expires_in) : null;
      if (!d || d <= 0) throw E.validation('Invalid `expires_in` field. Use a duration like `10m`, `2 hours` or `1 day`.');
      if (d > 48 * 3600) throw E.validation('The `expires_in` field cannot exceed 48 hours.');
      secs = d;
    }
    const [sent] = await ctx.sql`select id from emails where id = ${id} and team_id = ${teamId(c)}`;
    const [recv] = sent ? [] : await ctx.sql`select id from received_emails where id = ${id} and team_id = ${teamId(c)}`;
    if (!sent && !recv) throw E.notFound('Email not found');
    return c.json({ object: 'email', id, url: shareUrl(ctx, sent ? 'sent' : 'received', id, secs) });
  });

  r.get('/emails/:email_id/attachments', async (c, ctx) => {
    const id = uuidParam(c, 'email_id', 'email_id');
    const [e] = await ctx.sql`select id from emails where id = ${id} and team_id = ${teamId(c)}`;
    if (!e) throw E.notFound('Email not found');
    const page = parsePage(query(c), null);
    const { rows, hasMore } = await paginate(ctx.sql, 'email_attachments', ctx.sql`email_id = ${id} and team_id = ${teamId(c)}`, page,
      ctx.sql`id, filename, size, content_type, content_id, disposition, created_at`);
    return c.json(list(rows.map((a) => attachmentObject(ctx, 'sent', a, false)), hasMore));
  });

  r.get('/emails/:email_id/attachments/:attachment_id', async (c, ctx) => {
    const id = uuidParam(c, 'email_id', 'email_id');
    const aid = uuidParam(c, 'attachment_id', 'id');
    const [a] = await ctx.sql`select id, filename, size, content_type, content_id, disposition from email_attachments where id = ${aid} and email_id = ${id} and team_id = ${teamId(c)}`;
    if (!a) throw E.notFound('Attachment not found');
    return c.json(attachmentObject(ctx, 'sent', a, true));
  });
}

export { pgToDate, pgToIso };
