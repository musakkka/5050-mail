import { randomBytes } from 'node:crypto';

export interface Session {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  /** Pre-computed `Basic …` header for Stalwart. Never sent to the browser. */
  authorization: string;
  /** JMAP account ids this login may address (from Stalwart's session at sign-in). */
  accountIds?: string[];
  createdAt: number;
  lastSeenAt: number;
}

export interface SessionStore {
  create(data: Omit<Session, 'id' | 'createdAt' | 'lastSeenAt'>): Promise<Session>;
  get(id: string): Promise<Session | undefined>;
  touch(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  /** Live sessions (used by the mail worker to reach signed-in accounts). */
  all?(): Promise<Session[]>;
}

/**
 * In-memory session store (v1).
 *
 * TODO(redis): when REDIS_URL is set, back this with Redis so sessions survive
 * restarts and the service can scale horizontally. The stored `authorization`
 * value is a credential: encrypt it at rest (AES-GCM with a key from
 * SESSION_SECRET) before writing it to Redis.
 */
export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();
  private timer: NodeJS.Timeout;

  constructor(
    private idleMs: number,
    private maxMs: number,
    private now: () => number = Date.now,
  ) {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  async create(data: Omit<Session, 'id' | 'createdAt' | 'lastSeenAt'>): Promise<Session> {
    const t = this.now();
    const s: Session = { ...data, id: randomBytes(32).toString('base64url'), createdAt: t, lastSeenAt: t };
    this.sessions.set(s.id, s);
    return s;
  }

  async get(id: string): Promise<Session | undefined> {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (this.expired(s)) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  async touch(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = this.now();
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async all(): Promise<Session[]> {
    return [...this.sessions.values()].filter((s) => !this.expired(s));
  }

  size(): number {
    return this.sessions.size;
  }

  private expired(s: Session): boolean {
    const t = this.now();
    return t - s.lastSeenAt > this.idleMs || t - s.createdAt > this.maxMs;
  }

  sweep(): void {
    for (const [id, s] of this.sessions) if (this.expired(s)) this.sessions.delete(id);
  }

  close(): void {
    clearInterval(this.timer);
  }
}
