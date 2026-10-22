/** The worker role: job queue, webhook delivery, periodic analytics/rollups/retention. */
import { hostname } from 'node:os';
import { writeFileSync } from 'node:fs';
import type { AppContext } from '../context.js';
import { claim, complete, fail, type Job } from '../services/jobs.js';
import { processSendEmail, RetryableError } from '../services/delivery.js';
import { deliverDue, runReplayJob } from '../services/webhooks.js';
import { runVerification, VERIFY_INTERVAL_MS } from '../services/domains.js';
import { pollAnalytics } from '../services/analytics.js';
import { purgeExpiredSessions } from '../internal/sessions.js';

export type JobHandler = (ctx: AppContext, job: Job) => Promise<void | { rescheduleAt: Date }>;
/** Extra handlers registered by feature modules (broadcasts, imports, automations, inbound). */
export const extraHandlers: Partial<Record<Job['kind'], JobHandler>> = {};
/** Extra periodic tasks registered by feature modules (e.g. the JMAP inbound poller). */
export const extraPeriodic: { name: string; every: number; fn: (ctx: AppContext) => Promise<unknown> }[] = [];

const handlers: Partial<Record<Job['kind'], JobHandler>> = {
  send_email: async (ctx, job) => processSendEmail(ctx, job.payload.emailId as string, job.attempts, job.max_attempts),
  deliver_webhook: async (ctx, job) => runReplayJob(ctx, job.payload.webhookId as string, job.payload.eventId as string),
  domain_verify: async (ctx, job) => {
    const startedAt = new Date((job.payload.startedAt as string) ?? ctx.now().toISOString());
    const again = await runVerification(ctx, job.payload.domainId as string, startedAt);
    if (again) return { rescheduleAt: new Date(ctx.now().getTime() + VERIFY_INTERVAL_MS) };
  },
};

export async function runJob(ctx: AppContext, job: Job): Promise<void> {
  const h = handlers[job.kind] ?? extraHandlers[job.kind];
  if (!h) {
    ctx.log('worker', 'no handler for job', { kind: job.kind });
    await complete(ctx.sql, job.id);
    return;
  }
  try {
    const r = await h(ctx, job);
    if (r && 'rescheduleAt' in r) {
      await ctx.sql`update jobs set run_at = ${r.rescheduleAt.toISOString()}, locked_at = null, locked_by = null, attempts = 0 where id = ${job.id}`;
    } else await complete(ctx.sql, job.id);
  } catch (e) {
    const retry = await fail(ctx.sql, job, e as Error);
    ctx.log('worker', retry ? 'job failed, will retry' : 'job failed permanently', { kind: job.kind, id: job.id, attempts: job.attempts, error: (e as Error).message, retryable: e instanceof RetryableError });
  }
}

/** Process everything that is due right now (tests call this directly). Returns work done. */
export async function drain(ctx: AppContext, opts: { maxRounds?: number } = {}): Promise<number> {
  const id = `${hostname()}:${process.pid}`;
  let total = 0;
  for (let round = 0; round < (opts.maxRounds ?? 50); round++) {
    const jobs = await claim(ctx.sql, id, 20, undefined, ctx.now());
    for (const j of jobs) await runJob(ctx, j);
    const hooks = await deliverDue(ctx);
    total += jobs.length + hooks;
    if (!jobs.length && !hooks) break;
  }
  return total;
}

export async function rollupStats(ctx: AppContext, days = 2): Promise<void> {
  await ctx.sql`
    insert into stats_daily (team_id, day, domain_id, metrics, updated_at)
    select team_id, (created_at at time zone 'UTC')::date as day, coalesce(domain_id, '00000000-0000-0000-0000-000000000000'::uuid),
      jsonb_build_object(
        'sent', count(*) filter (where type = 'sent'),
        'delivered', count(*) filter (where type = 'delivered'),
        'bounced', count(*) filter (where type = 'bounced'),
        'complained', count(*) filter (where type = 'complained'),
        'opened', count(*) filter (where type = 'opened'),
        'unique_opened', count(distinct email_id) filter (where type = 'opened'),
        'clicked', count(*) filter (where type = 'clicked'),
        'unique_clicked', count(distinct email_id) filter (where type = 'clicked'),
        'failed', count(*) filter (where type = 'failed'),
        'suppressed', count(*) filter (where type = 'suppressed'),
        'delivery_delayed', count(*) filter (where type = 'delivery_delayed'),
        'unsubscribed', count(*) filter (where type = 'unsubscribed')
      ), now()
    from email_events
    where created_at >= (current_date - ${days}::int)
    group by 1, 2, 3
    on conflict (team_id, day, domain_id) do update set metrics = excluded.metrics, updated_at = now()`;
}

export async function retention(ctx: AppContext): Promise<void> {
  const d = `${ctx.config.logRetentionDays} days`;
  await ctx.sql`delete from api_logs where created_at < now() - ${d}::interval`;
  await ctx.sql`delete from idempotency_keys where created_at < now() - interval '24 hours'`;
  await ctx.sql`delete from webhook_events where created_at < now() - ${d}::interval and status in ('success', 'failed')`;
  await purgeExpiredSessions(ctx);
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

/** Long-running loop: LISTEN for new work, poll as a fallback, run periodic tasks. */
export function startWorker(ctx: AppContext): WorkerHandle {
  let stopped = false;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) => new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    wake = () => {
      clearTimeout(t);
      res();
    };
  });
  let listener: { unlisten: () => Promise<void> } | null = null;
  void ctx.sql.listen('send_jobs', () => wake?.()).then((l) => (listener = l)).catch(() => {});

  const periodic: { every: number; last: number; fn: () => Promise<unknown>; name: string }[] = [
    { name: 'analytics', every: ctx.config.analyticsPollIntervalMs, last: 0, fn: () => pollAnalytics(ctx) },
    { name: 'rollup', every: 5 * 60_000, last: 0, fn: () => rollupStats(ctx) },
    { name: 'retention', every: 3600_000, last: 0, fn: () => retention(ctx) },
    ...extraPeriodic.map((p) => ({ name: p.name, every: p.every, last: 0, fn: () => p.fn(ctx) })),
  ];

  const loop = (async () => {
    while (!stopped) {
      try {
        try {
          writeFileSync(process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/send-worker.heartbeat', String(Date.now()));
        } catch {
          /* read-only fs: healthcheck will report it */
        }
        await drain(ctx, { maxRounds: 5 });
        const now = Date.now();
        for (const p of process.env.WORKER_PERIODIC === '0' ? [] : periodic) {
          if (now - p.last >= p.every) {
            p.last = now;
            await p.fn().catch((e) => ctx.log('worker', `${p.name} failed`, { error: (e as Error).message }));
          }
        }
      } catch (e) {
        ctx.log('worker', 'loop error', { error: (e as Error).message });
      }
      if (!stopped) await sleep(ctx.config.workerPollMs);
    }
  })();

  return {
    async stop() {
      stopped = true;
      (wake as (() => void) | null)?.();
      await loop;
      await (listener as { unlisten: () => Promise<void> } | null)?.unlisten().catch(() => {});
    },
  };
}
