/** API keys: `re_<8>_<24>` tokens, stored as SHA-256 only, shown once. */
import type { Sql } from '../db.js';
import { safeEqual, sha256 } from '../lib/crypto.js';
import { randomToken } from '../lib/ids.js';

export interface Team {
  id: string;
  name: string;
  monthly_quota: number;
  daily_quota: number | null;
  rate_limit: number;
}

export interface AuthContext {
  team: Team;
  apiKeyId: string | null;
  permission: 'full_access' | 'sending_access';
  /** For sending_access keys restricted to one domain. */
  domainId: string | null;
  source: 'api' | 'dashboard' | 'smtp';
  /** Dashboard user email (source=dashboard). */
  actor?: string;
  /** Dashboard user is a platform (Stalwart) admin: may use the operator's Cloudflare zones one-click. */
  platformAdmin?: boolean;
}

const TOKEN_RE = /^re_([A-Za-z0-9]{8})_([A-Za-z0-9]{24})$/;

export function generateToken(): { token: string; prefix: string; hash: Buffer } {
  const prefix = randomToken(8);
  const token = `re_${prefix}_${randomToken(24)}`;
  return { token, prefix, hash: sha256(token) };
}

export const looksLikeToken = (t: string) => TOKEN_RE.test(t);

export async function createApiKey(
  sql: Sql,
  teamId: string,
  name: string,
  permission: 'full_access' | 'sending_access',
  domainId: string | null,
  createdBy: string | null,
): Promise<{ id: string; token: string }> {
  const { token, prefix, hash } = generateToken();
  const [row] = await sql`
    insert into api_keys (team_id, name, permission, domain_id, token_prefix, token_hash, created_by)
    values (${teamId}, ${name}, ${permission}, ${domainId}, ${prefix}, ${hash}, ${createdBy})
    returning id`;
  return { id: row!.id as string, token };
}

export type KeyLookup = { status: 'ok'; auth: AuthContext } | { status: 'malformed' } | { status: 'unknown' };

/** Constant-time verification; also bumps last_used_at (at most once a minute). */
export async function verifyApiKey(sql: Sql, token: string): Promise<KeyLookup> {
  const m = TOKEN_RE.exec(token);
  if (!m) return { status: 'malformed' };
  const [row] = await sql`
    select k.id, k.permission, k.domain_id, k.token_hash, k.last_used_at,
           t.id as team_id, t.name as team_name, t.monthly_quota, t.daily_quota, t.rate_limit
    from api_keys k join teams t on t.id = k.team_id
    where k.token_prefix = ${m[1]!}`;
  const want = sha256(token);
  if (!row) {
    safeEqual(want, want);
    return { status: 'unknown' };
  }
  if (!safeEqual(row.token_hash as Buffer, want)) return { status: 'unknown' };
  await sql`update api_keys set last_used_at = now() where id = ${row.id as string} and (last_used_at is null or last_used_at < now() - interval '1 minute')`;
  return {
    status: 'ok',
    auth: {
      team: { id: row.team_id as string, name: row.team_name as string, monthly_quota: row.monthly_quota as number, daily_quota: row.daily_quota as number | null, rate_limit: row.rate_limit as number },
      apiKeyId: row.id as string,
      permission: row.permission as AuthContext['permission'],
      domainId: (row.domain_id as string | null) ?? null,
      source: 'api',
    },
  };
}

export async function loadTeam(sql: Sql, teamId: string): Promise<Team | null> {
  const [t] = await sql`select id, name, monthly_quota, daily_quota, rate_limit from teams where id = ${teamId}`;
  return (t as unknown as Team) ?? null;
}
