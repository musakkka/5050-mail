/** Fixed-window per-key rate limiter (in-memory; per instance). */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Registers a hit; returns seconds until reset if the key is over the limit, else 0. */
  hit(key: string): number {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    if (this.hits.size > 50_000) this.prune();
    return e.count > this.limit ? Math.ceil((e.resetAt - t) / 1000) : 0;
  }

  /** True if the key is already over the limit (does not count a hit). */
  peek(key: string): boolean {
    const e = this.hits.get(key);
    return !!e && e.resetAt > this.now() && e.count >= this.limit;
  }

  /** Forget a key (e.g. after a successful login). */
  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.hits) if (e.resetAt <= t) this.hits.delete(k);
  }
}
