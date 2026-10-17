// Standard leaf denomination and deposit sizing for the shielded pool.
//
// Decided 12 Oct 2026 (design v0.3, open decisions): the pool uses a single
// leaf denomination of 10 USDG (design v0.4: the numbers stay, in USDG). Every leaf in every batch then looks the same,
// so the amount of a leaf says nothing about whose deposit it came from.
//
// The pool keeps a shielding fee per deposit at SealBatch:
//   net = amount - floor(amount * fee_bps / 10_000)
// (src/OstraPool.sol sealBatch). A deposit is sized so that its net
// amount is exactly a whole number of standard leaves.

import { MAX_FEE_BPS } from "./constants.ts";

/** The pool's only leaf amount: 10 USDG in base units (USDG has 6 decimals; OstraPool.leafAmount). */
export const LEAF_DENOMINATION = 10_000_000n;

const BPS = 10_000n;

function feeBpsOf(feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    throw new RangeError(`feeBps must be an integer in 0..${MAX_FEE_BPS}`);
  }
  return BigInt(feeBps);
}

function leafCountOf(leafCount: number): bigint {
  if (!Number.isInteger(leafCount) || leafCount < 1) throw new RangeError("leafCount must be a positive integer");
  return BigInt(leafCount);
}

/** What a deposit adds to its batch after the shielding fee, exactly as SealBatch computes it. */
export function poolNetAmount(amount: bigint, feeBps: number): bigint {
  if (amount < 0n) throw new RangeError("amount must not be negative");
  return amount - (amount * feeBpsOf(feeBps)) / BPS;
}

/** True for the one standard leaf amount. */
export function isStandardLeaf(amount: bigint): boolean {
  return amount === LEAF_DENOMINATION;
}

/** The leaf amounts of `leafCount` standard leaves. */
export function standardLeafAmounts(leafCount: number): bigint[] {
  return Array.from({ length: Number(leafCountOf(leafCount)) }, () => LEAF_DENOMINATION);
}

/**
 * Smallest deposit whose net amount (after the shielding fee) is exactly
 * `leafCount` standard leaves. The net amount grows by at most 1 per unit of
 * deposit, so such a deposit always exists and is unique at its lower end.
 */
export function depositForLeaves(leafCount: number, feeBps: number): bigint {
  const target = leafCountOf(leafCount) * LEAF_DENOMINATION;
  const keep = BPS - feeBpsOf(feeBps);
  // ceil(target * 10_000 / (10_000 - fee)) has net >= target; step down to the smallest.
  let amount = (target * BPS + keep - 1n) / keep;
  while (amount > 0n && poolNetAmount(amount - 1n, feeBps) >= target) amount -= 1n;
  if (poolNetAmount(amount, feeBps) !== target) throw new Error("no deposit nets exactly the requested leaves");
  return amount;
}

/** Most standard leaves a single deposit can carry under the pool's `maxDeposit`. */
export function maxLeavesPerDeposit(maxDeposit: bigint, feeBps: number): number {
  let n = 0;
  while (depositForLeaves(n + 1, feeBps) <= maxDeposit) n += 1;
  return n;
}
