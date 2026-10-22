/** Postgres-backed dashboard sessions; the cookie holds a random id, the DB only its hash. */
import { randomBytes } from 'node:crypto';
import type { AppContext } from '../context.js';
import { decrypt, encrypt, sha256hex } from '../lib/crypto.js';

export interface DashboardSession {
  idHash: string;
  email: string;
  name: string;
  isAdmin: boolean;
  credential: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  adminCheckedAt: Date;
}

const toDate = (s: unknown) => new Date(String(s).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));

export async function createSession(ctx: AppContext, data: { email: string; name: string; isAdmin: boolean; authorization: string }): Promise<string> {
  const sid = randomBytes(32).toString('base64url');
  await ctx.sql`
    insert into dashboard_sessions (id_hash, email, name, is_admin, credential)
    values (${sha256hex(sid)}, ${data.email}, ${data.name}, ${data.isAdmin}, ${encrypt(ctx.config.sessionSecret, data.authorization)})`;
  return sid;
}

export async function loadSession(ctx: AppContext, sid: string | undefined): Promise<DashboardSession | null> {
  if (!sid || sid.length > 100) return null;
  const h = sha256hex(sid);
  const [r] = await ctx.sql`select * from dashboard_sessions where id_hash = ${h}`;
  if (!r) return null;
  const s: DashboardSession = {
    idHash: h,
    email: r.email as string,
    name: r.name as string,
    isAdmin: r.is_admin as boolean,
    credential: r.credential ? decrypt(ctx.config.sessionSecret, r.credential as string) : null,
    createdAt: toDate(r.created_at),
    lastSeenAt: toDate(r.last_seen_at),
    adminCheckedAt: toDate(r.admin_checked_at),
  };
  const now = ctx.now().getTime();
  if (now - s.lastSeenAt.getTime() > ctx.config.sessionIdleMs || now - s.createdAt.getTime() > ctx.config.sessionMaxMs) {
    await deleteSession(ctx, sid);
    return null;
  }
  if (now - s.lastSeenAt.getTime() > 60_000) await ctx.sql`update dashboard_sessions set last_seen_at = now() where id_hash = ${h}`;
  return s;
}

export async function deleteSession(ctx: AppContext, sid: string): Promise<void> {
  await ctx.sql`delete from dashboard_sessions where id_hash = ${sha256hex(sid)}`;
}

export async function purgeExpiredSessions(ctx: AppContext): Promise<void> {
  await ctx.sql`delete from dashboard_sessions where last_seen_at < now() - ${`${Math.floor(ctx.config.sessionIdleMs / 1000)} seconds`}::interval
                or created_at < now() - ${`${Math.floor(ctx.config.sessionMaxMs / 1000)} seconds`}::interval`;
}
