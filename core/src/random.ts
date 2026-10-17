// Random values from the platform's CSPRNG (Web Crypto: globalThis.crypto in
// Node and in browsers).

/** `n` fresh random bytes. */
export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** A random u64: 8 random bytes read little-endian. */
export function randomU64(): bigint {
  const bytes = randomBytes(8);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

/** A uniform random integer from `min` (included) to `max` (excluded); max - min is at most 2^32. */
export function randomInt(min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max <= min || max - min > 2 ** 32) {
    throw new RangeError("randomInt needs safe integers with 0 < max - min <= 2^32");
  }
  const range = max - min;
  // Rejection sampling over u32 values: every result is equally likely.
  const limit = 2 ** 32 - (2 ** 32 % range);
  const word = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(word);
    const value = word[0] as number;
    if (value < limit) return min + (value % range);
  }
}
