/** Idempotency-Key handling for sending endpoints (24 h, body-bound). */
import type { AppContext } from '../context.js';
import { ApiError, E } from '../lib/errors.js';
import { sha256hex } from '../lib/crypto.js';

export interface StoredResponse {
  status: number;
  body: unknown;
}

export async function withIdempotency(
  ctx: AppContext,
  teamId: string,
  endpoint: string,
  key: string | undefined,
  rawBody: string,
  fn: () => Promise<StoredResponse>,
): Promise<StoredResponse> {
  if (key === undefined) return fn();
  if (key.length < 1 || key.length > 256) throw E.invalidIdempotencyKey();
  const hash = sha256hex(rawBody);
  await ctx.sql`delete from idempotency_keys where team_id = ${teamId} and endpoint = ${endpoint} and key = ${key} and created_at < now() - interval '24 hours'`;
  const ins = await ctx.sql`
    insert into idempotency_keys (team_id, key, endpoint, body_hash) values (${teamId}, ${key}, ${endpoint}, ${hash})
    on conflict do nothing returning key`;
  if (!ins.length) {
    const [row] = await ctx.sql`select body_hash, state, response_status, response_body from idempotency_keys where team_id = ${teamId} and endpoint = ${endpoint} and key = ${key}`;
    if (!row) return withIdempotency(ctx, teamId, endpoint, key, rawBody, fn);
    if (row.body_hash !== hash) throw E.idempotencyMismatch();
    if (row.state !== 'done') throw E.idempotencyConcurrent();
    return { status: row.response_status as number, body: row.response_body };
  }
  try {
    const r = await fn();
    await ctx.sql`update idempotency_keys set state = 'done', response_status = ${r.status}, response_body = ${ctx.sql.json(r.body as never)}
                  where team_id = ${teamId} and endpoint = ${endpoint} and key = ${key}`;
    return r;
  } catch (e) {
    // Failed requests don't consume the key (they can be retried with the same key).
    await ctx.sql`delete from idempotency_keys where team_id = ${teamId} and endpoint = ${endpoint} and key = ${key}`;
    if (e instanceof ApiError) throw e;
    throw e;
  }
}
