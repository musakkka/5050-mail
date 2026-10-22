/**
 * Webhook fan-out, Svix-compatible signing and delivery with Resend's retry schedule.
 * https://resend.com/docs/webhooks/retries-and-replays
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { AppContext } from '../context.js';
import { attemptId, msgId } from '../lib/ids.js';
import { safeRequest, SsrfError } from '../lib/ssrf.js';
import { enqueue } from './jobs.js';

export const WEBHOOK_EVENT_TYPES = [
  'email.sent', 'email.scheduled', 'email.delivered', 'email.delivery_delayed', 'email.complained', 'email.bounced',
  'email.opened', 'email.clicked', 'email.received', 'email.failed', 'email.suppressed',
  'contact.created', 'contact.updated', 'contact.deleted', 'contact.topics.updated',
  'domain.created', 'domain.updated', 'domain.deleted',
  'suppression.added', 'suppression.removed',
  'topic.created', 'topic.updated', 'topic.deleted',
  'inbox.created', 'inbox.updated', 'inbox.deleted', 'inbox.thread.created', 'inbox.thread.folder.updated',
  'inbox.thread.assigned', 'inbox.thread.unassigned', 'inbox.thread.labels.updated', 'inbox.email.received',
  'inbox.email.sent', 'inbox.draft.created', 'inbox.draft.updated', 'inbox.draft.sent', 'inbox.draft.deleted',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Delay before attempt N+1, after attempt N failed (attempt 1 is immediate). */
export const RETRY_SCHEDULE_MS = [5_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 5 * 3600_000, 10 * 3600_000, 10 * 3600_000];
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;
/** Endpoints failing continuously for this long are disabled (Svix behaviour). */
export const AUTO_DISABLE_AFTER_MS = 5 * 86400_000;

export const newSigningSecret = () => `whsec_${randomBytes(24).toString('base64')}`;

/** Svix signature header value: `v1,<base64 hmac>` for each active secret, space separated. */
export function sign(secrets: string[], id: string, timestamp: number, body: string): string {
  return secrets
    .map((s) => {
      const key = Buffer.from(s.startsWith('whsec_') ? s.slice(6) : s, 'base64');
      return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
    })
    .join(' ');
}

/**
 * Record an event for every enabled webhook of the team subscribed to `type`
 * and queue delivery. Returns the shared `msg_` id (or null when no webhook wants it).
 */
export async function emit(ctx: AppContext, teamId: string, type: WebhookEventType, data: Record<string, unknown>): Promise<string | null> {
  const hooks = await ctx.sql`
    select id from webhooks
    where team_id = ${teamId} and status = 'enabled' and (events is null or ${type} = any(events))`;
  if (!hooks.length) return null;
  const id = msgId();
  const now = ctx.now();
  const payload = { type, created_at: now.toISOString(), data };
  for (const h of hooks) {
    await ctx.sql`
      insert into webhook_events (id, webhook_id, team_id, type, payload, status, next_attempt_at, created_at)
      values (${id}, ${h.id as string}, ${teamId}, ${type}, ${ctx.sql.json(payload as never)}, 'pending', ${now.toISOString()}, ${now.toISOString()})`;
  }
  await ctx.sql`select pg_notify('send_jobs', 'webhook')`;
  return id;
}

interface EventRow {
  id: string;
  webhook_id: string;
  team_id: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  status: string;
  endpoint: string;
  hook_status: string;
  signing_secret: string;
  previous_secret: string | null;
  previous_secret_expires_at: string | null;
  failing_since: string | null;
}

async function attempt(ctx: AppContext, ev: EventRow, isReplay: boolean): Promise<{ ok: boolean; status: number | null }> {
  const body = JSON.stringify(ev.payload);
  const ts = Math.floor(ctx.now().getTime() / 1000);
  const secrets = [ev.signing_secret];
  if (ev.previous_secret && ev.previous_secret_expires_at && new Date(ev.previous_secret_expires_at.replace(' ', 'T').replace(/\+00$/, 'Z')) > ctx.now()) {
    secrets.push(ev.previous_secret);
  }
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'Svix-Webhooks/1.0 (5050-send; +https://api.example.com)',
    'svix-id': ev.id,
    'svix-timestamp': String(ts),
    'svix-signature': sign(secrets, ev.id, ts, body),
  };
  const started = Date.now();
  let status: number | null = null;
  let response = '';
  let error: string | null = null;
  try {
    const r = await safeRequest(ev.endpoint, {
      method: 'POST',
      headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
      body,
      timeoutMs: 15_000,
      maxBytes: 4096,
      allowPrivate: ctx.config.allowPrivateWebhooks,
    });
    status = r.status;
    response = r.body.toString('utf8').slice(0, 2048);
  } catch (e) {
    error = e instanceof SsrfError ? e.message : `Request failed: ${(e as Error).message}`;
  }
  const duration = Date.now() - started;
  await ctx.sql`
    insert into webhook_attempts (id, webhook_event_id, webhook_id, team_id, http_status_code, response, error, duration_ms, is_replay, sent_at)
    values (${attemptId()}, ${ev.id}, ${ev.webhook_id}, ${ev.team_id}, ${status}, ${response}, ${error}, ${duration}, ${isReplay}, ${ctx.now().toISOString()})`;
  return { ok: status !== null && status >= 200 && status < 300, status };
}

/** Deliver every due event (scheduled attempts). Returns the number of attempts made. */
export async function deliverDue(ctx: AppContext, limit = 50): Promise<number> {
  const due = (await ctx.sql`
    with picked as (
      select e.webhook_id, e.id from webhook_events e
      where e.status in ('pending', 'attempting') and e.next_attempt_at <= ${ctx.now().toISOString()}
      order by e.next_attempt_at limit ${limit}
      for update skip locked
    )
    update webhook_events e set next_attempt_at = now() + interval '2 minutes'
    from picked where e.webhook_id = picked.webhook_id and e.id = picked.id
    returning e.id, e.webhook_id, e.team_id, e.payload, e.attempt_count, e.status`) as unknown as Pick<EventRow, 'id' | 'webhook_id' | 'team_id' | 'payload' | 'attempt_count' | 'status'>[];
  let n = 0;
  for (const d of due) {
    const [hook] = await ctx.sql`select endpoint, status, signing_secret, previous_secret, previous_secret_expires_at, failing_since from webhooks where id = ${d.webhook_id}`;
    if (!hook || hook.status !== 'enabled') {
      await ctx.sql`update webhook_events set status = 'failed', next_attempt_at = null where webhook_id = ${d.webhook_id} and id = ${d.id}`;
      continue;
    }
    const ev = { ...d, endpoint: hook.endpoint, hook_status: hook.status, signing_secret: hook.signing_secret, previous_secret: hook.previous_secret, previous_secret_expires_at: hook.previous_secret_expires_at, failing_since: hook.failing_since } as EventRow;
    const r = await attempt(ctx, ev, false);
    n++;
    const count = d.attempt_count + 1;
    if (r.ok) {
      await ctx.sql`update webhook_events set status = 'success', attempt_count = ${count}, next_attempt_at = null where webhook_id = ${d.webhook_id} and id = ${d.id}`;
      await ctx.sql`update webhooks set failing_since = null where id = ${d.webhook_id}`;
    } else if (count >= MAX_ATTEMPTS) {
      await ctx.sql`update webhook_events set status = 'failed', attempt_count = ${count}, next_attempt_at = null where webhook_id = ${d.webhook_id} and id = ${d.id}`;
      await markFailing(ctx, d.webhook_id);
    } else {
      const next = new Date(ctx.now().getTime() + RETRY_SCHEDULE_MS[count - 1]!);
      await ctx.sql`update webhook_events set status = 'attempting', attempt_count = ${count}, next_attempt_at = ${next.toISOString()} where webhook_id = ${d.webhook_id} and id = ${d.id}`;
      await markFailing(ctx, d.webhook_id);
    }
  }
  return n;
}

async function markFailing(ctx: AppContext, webhookId: string) {
  const [h] = await ctx.sql`update webhooks set failing_since = coalesce(failing_since, now()) where id = ${webhookId} returning failing_since::text as f`;
  const since = h?.f ? new Date(String(h.f).replace(' ', 'T').replace(/\+00$/, 'Z')) : null;
  if (since && ctx.now().getTime() - since.getTime() > AUTO_DISABLE_AFTER_MS) {
    await ctx.sql`update webhooks set status = 'disabled', disabled_reason = 'Endpoint failed continuously for 5 days', updated_at = now() where id = ${webhookId}`;
    ctx.log('webhooks', 'endpoint auto-disabled after continuous failures', { webhookId });
  }
}

/** One extra immediate delivery (dashboard "Replay" / POST …/replay); the retry schedule is untouched. */
export async function replay(ctx: AppContext, webhookId: string, eventId: string): Promise<void> {
  await enqueue(ctx.sql, 'deliver_webhook', { webhookId, eventId, replay: true });
}

export async function runReplayJob(ctx: AppContext, webhookId: string, eventId: string): Promise<void> {
  const [row] = await ctx.sql`
    select e.id, e.webhook_id, e.team_id, e.payload, e.attempt_count, e.status,
           w.endpoint, w.status as hook_status, w.signing_secret, w.previous_secret, w.previous_secret_expires_at, w.failing_since
    from webhook_events e join webhooks w on w.id = e.webhook_id
    where e.webhook_id = ${webhookId} and e.id = ${eventId}`;
  if (!row) return;
  const r = await attempt(ctx, row as unknown as EventRow, true);
  if (r.ok) {
    await ctx.sql`update webhook_events set status = 'success', next_attempt_at = null where webhook_id = ${webhookId} and id = ${eventId}`;
    await ctx.sql`update webhooks set failing_since = null where id = ${webhookId}`;
  }
}
