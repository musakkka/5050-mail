import type { Sql } from '../db.js';

export type JobKind =
  | 'send_email'
  | 'deliver_webhook'
  | 'broadcast_fanout'
  | 'contact_import'
  | 'automation_step'
  | 'domain_verify'
  | 'analytics_poll'
  | 'stats_rollup'
  | 'retention'
  | 'inbound_process';

export interface Job {
  id: number;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function enqueue(
  sql: Sql,
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; uniqueKey?: string; maxAttempts?: number } = {},
): Promise<void> {
  const runAt = (opts.runAt ?? new Date()).toISOString();
  if (opts.uniqueKey) {
    await sql`
      insert into jobs (kind, payload, run_at, unique_key, max_attempts)
      values (${kind}, ${sql.json(payload as never)}, ${runAt}, ${opts.uniqueKey}, ${opts.maxAttempts ?? 5})
      on conflict (unique_key) do update set run_at = excluded.run_at, payload = excluded.payload, attempts = 0, last_error = null
      where jobs.locked_at is null`;
  } else {
    await sql`insert into jobs (kind, payload, run_at, max_attempts) values (${kind}, ${sql.json(payload as never)}, ${runAt}, ${opts.maxAttempts ?? 5})`;
  }
  await sql`select pg_notify('send_jobs', ${kind})`;
}

export async function cancelJob(sql: Sql, uniqueKey: string): Promise<void> {
  await sql`delete from jobs where unique_key = ${uniqueKey} and locked_at is null`;
}

export async function rescheduleJob(sql: Sql, uniqueKey: string, runAt: Date): Promise<void> {
  await sql`update jobs set run_at = ${runAt.toISOString()} where unique_key = ${uniqueKey} and locked_at is null`;
}

/** Claim up to `n` due jobs (stale locks older than 10 minutes are reclaimed). */
export async function claim(sql: Sql, workerId: string, n = 10, kinds?: JobKind[], now = new Date()): Promise<Job[]> {
  const rows = await sql`
    update jobs set locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
    where id in (
      select id from jobs
      where run_at <= ${now.toISOString()}
        and (locked_at is null or locked_at < now() - interval '10 minutes')
        ${kinds ? sql`and kind = any(${kinds})` : sql``}
      order by run_at, id
      limit ${n}
      for update skip locked
    )
    returning id, kind, payload, attempts, max_attempts`;
  return rows as unknown as Job[];
}

export async function complete(sql: Sql, id: number): Promise<void> {
  await sql`delete from jobs where id = ${id}`;
}

/** Exponential backoff retry; drops the job after max_attempts. */
export async function fail(sql: Sql, job: Job, err: Error, retryInMs?: number): Promise<boolean> {
  if (job.attempts >= job.max_attempts) {
    await sql`delete from jobs where id = ${job.id}`;
    return false;
  }
  const delay = retryInMs ?? Math.min(3600_000, 2 ** job.attempts * 5_000);
  await sql`update jobs set locked_at = null, locked_by = null, last_error = ${err.message.slice(0, 2000)},
            run_at = now() + ${`${delay} milliseconds`}::interval where id = ${job.id}`;
  return true;
}
