/** Fixed-window limiters (in-memory, per process). */

/** Per-team requests-per-second limiter producing IETF draft-06 `ratelimit-*` header values. */
export class TeamRateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private now: () => number = Date.now, private windowMs = 1000) {}

  hit(key: string, limit: number): { allowed: boolean; limit: number; remaining: number; resetSec: number } {
    const t = this.now();
    const start = t - (t % this.windowMs);
    let w = this.windows.get(key);
    if (!w || w.start !== start) {
      w = { start, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 10_000) for (const [k, v] of this.windows) if (v.start < start) this.windows.delete(k);
    }
    w.count++;
    const resetSec = Math.max(1, Math.ceil((start + this.windowMs - t) / 1000));
    return { allowed: w.count <= limit, limit, remaining: Math.max(0, limit - w.count), resetSec };
  }
}

/** Login limiter copied from the webmail BFF (web/server/src/rateLimit.ts). */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}
  hit(key: string): number {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    return e.count > this.limit ? Math.ceil((e.resetAt - t) / 1000) : 0;
  }
  peek(key: string): boolean {
    const e = this.hits.get(key);
    return !!e && e.resetAt > this.now() && e.count >= this.limit;
  }
  reset(key: string): void {
    this.hits.delete(key);
  }
}
