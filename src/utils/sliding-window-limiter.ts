/** Simple in-memory sliding-window rate limiter, keyed by an arbitrary string (socket id, IP, user id). */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxHits: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if `key` is still within its limit, recording this call as a hit. */
  consume(key: string): boolean {
    const now = Date.now();
    const timestamps = (this.hits.get(key) ?? []).filter(
      (t) => now - t < this.windowMs,
    );

    if (timestamps.length >= this.maxHits) {
      this.hits.set(key, timestamps);
      return false;
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return true;
  }

  /**
   * Drops any key whose window has fully expired. Callers that key by user/IP
   * (rather than a per-connection id they can `reset()` on disconnect) have no
   * single moment to clean up — without this, `hits` grows by one entry per
   * distinct key ever seen, forever, for the life of the process.
   */
  sweepExpired(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.hits) {
      const stillLive = timestamps.some((t) => now - t < this.windowMs);
      if (!stillLive) this.hits.delete(key);
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
