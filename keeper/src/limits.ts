// Token-bucket rate limits for the voucher and close endpoints: one bucket per
// channel, and one shared bucket for channels the keeper has not seen before.

export class TokenBucket {
  readonly #perSecond: number;
  readonly #now: () => number;
  #tokens: number;
  #last: number;

  /** `perSecond` requests per second, with a burst of the same size. */
  constructor(perSecond: number, now: () => number = Date.now) {
    if (!Number.isInteger(perSecond) || perSecond < 1) throw new RangeError("perSecond must be a positive integer");
    this.#perSecond = perSecond;
    this.#now = now;
    this.#tokens = perSecond;
    this.#last = now();
  }

  #refill(): void {
    const now = this.#now();
    if (now > this.#last) {
      this.#tokens = Math.min(this.#perSecond, this.#tokens + ((now - this.#last) * this.#perSecond) / 1_000);
    }
    this.#last = now;
  }

  /** Takes one token; false when the limit is reached. */
  take(): boolean {
    this.#refill();
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  /** True once the bucket has refilled completely, so dropping it changes nothing. */
  full(): boolean {
    this.#refill();
    return this.#tokens >= this.#perSecond;
  }
}

/** One bucket per key; buckets that refilled completely are dropped by `prune`. */
export class KeyedLimiter {
  readonly #perSecond: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, TokenBucket>();

  constructor(perSecond: number, now: () => number = Date.now) {
    this.#perSecond = perSecond;
    this.#now = now;
  }

  take(key: string): boolean {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = new TokenBucket(this.#perSecond, this.#now);
      this.#buckets.set(key, bucket);
    }
    return bucket.take();
  }

  prune(): void {
    for (const [key, bucket] of this.#buckets) if (bucket.full()) this.#buckets.delete(key);
  }

  get size(): number {
    return this.#buckets.size;
  }
}
