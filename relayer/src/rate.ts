// Request limits per client, kept in memory: they bound what a burst of requests costs the relayer in simulations; a
// restart forgets them. What reverted spends cost is bounded in the ledger instead (private.ts privateRevertRefusal),
// so a restart does not reset that.

import { isIP } from "node:net";

/**
 * The key a client's requests count under: an IPv4 address as it is (an IPv4-mapped IPv6 address as its IPv4), an
 * IPv6 address by its /64 prefix, since one client usually holds a whole /64 and could take a new address for every
 * request. Anything else is its own key.
 */
export function clientKey(ip: string): string {
  const a = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped !== null && isIP(mapped[1] as string) === 4) return mapped[1] as string;
  if (isIP(a) !== 6) return a;
  const [head, tail] = a.split("::") as [string, string | undefined];
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  // An embedded IPv4 tail (a:b::1.2.3.4) is two groups; it lies past the first four groups unless the address is short.
  const groups = [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => (g.includes(".") ? g : (Number.parseInt(g, 16) || 0).toString(16)))
    .join(":")}::/64`;
}

/** At most this many keys are tracked; past it the keys used least recently are forgotten. */
const MAX_KEYS = 50_000;

export class RateWindow {
  readonly #times = new Map<string, number[]>();
  #swept = 0;
  readonly limit: number;
  readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    if (!Number.isInteger(limit) || limit < 1 || !(windowMs > 0)) throw new RangeError("a rate window needs a positive limit and length");
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Counts a request of `key` at `now` and says whether it is within the limit; a refused request is not counted. */
  take(key: string, now: number): boolean {
    const recent = (this.#times.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.#times.set(key, recent);
      return false;
    }
    recent.push(now);
    // Deleted and set again, so the map keeps keys in the order they were last used (the cap drops the least recent).
    this.#times.delete(key);
    this.#times.set(key, recent);
    this.#sweep(now);
    return true;
  }

  /** Drops keys with nothing in the window (at most every tenth of a window), then the oldest past MAX_KEYS. */
  #sweep(now: number): void {
    if (this.#times.size > 10_000 && now - this.#swept >= this.windowMs / 10) {
      this.#swept = now;
      for (const [k, v] of this.#times) if (v.every((t) => now - t >= this.windowMs)) this.#times.delete(k);
    }
    for (const k of this.#times.keys()) {
      if (this.#times.size <= MAX_KEYS) break;
      this.#times.delete(k);
    }
  }
}
