/**
 * Postgres session store (DATABASE_URL): sessions survive restarts and are shared
 * by every process (node:cluster workers, several containers behind one proxy).
 * The cookie holds a random id; the table keeps only its SHA-256, and the
 * Stalwart credential is encrypted with AES-256-GCM under SESSION_SECRET.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import type { Session, SessionStore } from './sessions.js';

const hash = (id: string) => createHash('sha256').update(id).digest('hex');
const TOUCH_EVERY_MS = 60_000;

export function sealer(secret: string) {
  const key = createHmac('sha256', secret).update('5050-mail:session-credential').digest();
  return {
    seal(plain: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
    },
    open(blob: string): string | null {
      try {
        const b = Buffer.from(blob, 'base64url');
        const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
        d.setAuthTag(b.subarray(12, 28));
        return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

export class PgSessionStore implements SessionStore {
  private sql: postgres.Sql;
  private ready: Promise<void>;
  private box: ReturnType<typeof sealer>;
  private timer: NodeJS.Timeout;

  constructor(
    url: string,
    secret: string,
    private idleMs: number,
    private maxMs: number,
    private now: () => number = Date.now,
  ) {
    if (secret.length < 32) throw new Error('SESSION_SECRET (>= 32 chars) is required with DATABASE_URL');
    this.box = sealer(secret);
    this.sql = postgres(url, { max: Number(process.env.PG_POOL_MAX) || 5, onnotice: () => {}, connection: { application_name: '5050-mail-webmail' } });
    this.ready = this.sql`
      create table if not exists webmail_sessions (
        id_hash text primary key,
        email text not null,
        name text not null,
        is_admin boolean not null,
        credential text not null,
        created_at bigint not null,
        last_seen_at bigint not null
      )`.then(() => undefined);
    this.timer = setInterval(() => void this.sweep().catch(() => {}), 10 * 60_000);
    this.timer.unref();
  }

  async create(data: Omit<Session, 'id' | 'createdAt' | 'lastSeenAt'>): Promise<Session> {
    await this.ready;
    const t = this.now();
    const id = randomBytes(32).toString('base64url');
    await this.sql`insert into webmail_sessions (id_hash, email, name, is_admin, credential, created_at, last_seen_at)
      values (${hash(id)}, ${data.email}, ${data.name}, ${data.isAdmin}, ${this.box.seal(data.authorization)}, ${t}, ${t})`;
    return { ...data, id, createdAt: t, lastSeenAt: t };
  }

  async get(id: string): Promise<Session | undefined> {
    if (!id || id.length > 100) return undefined;
    await this.ready;
    const [r] = await this.sql`select * from webmail_sessions where id_hash = ${hash(id)}`;
    if (!r) return undefined;
    const createdAt = Number(r.created_at);
    const lastSeenAt = Number(r.last_seen_at);
    const t = this.now();
    const authorization = this.box.open(r.credential as string);
    if (!authorization || t - lastSeenAt > this.idleMs || t - createdAt > this.maxMs) {
      await this.delete(id);
      return undefined;
    }
    return { id, email: r.email as string, name: r.name as string, isAdmin: r.is_admin as boolean, authorization, createdAt, lastSeenAt };
  }

  /** Live sessions (for the mail worker, which acts with each user's own credential). */
  async all(): Promise<Session[]> {
    await this.ready;
    const t = this.now();
    const rows = await this.sql`select * from webmail_sessions where last_seen_at >= ${t - this.idleMs} and created_at >= ${t - this.maxMs}`;
    return rows.flatMap((r) => {
      const authorization = this.box.open(r.credential as string);
      return authorization
        ? [{ id: '', email: r.email as string, name: r.name as string, isAdmin: r.is_admin as boolean, authorization, createdAt: Number(r.created_at), lastSeenAt: Number(r.last_seen_at) }]
        : [];
    });
  }

  async touch(id: string): Promise<void> {
    const t = this.now();
    await this.sql`update webmail_sessions set last_seen_at = ${t} where id_hash = ${hash(id)} and last_seen_at < ${t - TOUCH_EVERY_MS}`;
  }

  async delete(id: string): Promise<void> {
    await this.sql`delete from webmail_sessions where id_hash = ${hash(id)}`;
  }

  async sweep(): Promise<void> {
    const t = this.now();
    await this.sql`delete from webmail_sessions where last_seen_at < ${t - this.idleMs} or created_at < ${t - this.maxMs}`;
  }

  close(): void {
    clearInterval(this.timer);
    void this.sql.end({ timeout: 2 });
  }
}
