// Lattice homomorphic multiset hash (LtHash), byte-compatible with
// src/LtHash.sol (and the Solana program's lthash.rs): 1024 little-endian u16 lanes, wrapping addition,
// each element expanded by SHA-256 in counter mode.
//
// The batch accumulator is the LtHash of the batch's leaves; the state a
// depositor approves hashes it with the leaf count and total, so an approval
// covers exactly the leaves the batch holds (OstraPool.batchState).

import { keccak256, sha256, u64Le, utf8 } from "./hash.ts";

export const LTHASH_LANES = 1024;
export const LTHASH_BYTES = LTHASH_LANES * 2;
/** Leaf encoding: key_root (32) || amount (u64 LE). */
export const LEAF_LEN = 40;

const DOMAIN = utf8("OSTRA/LTHASH/v1");
const BLOCKS = LTHASH_BYTES / 32;

function checkAcc(acc: Uint8Array, name: string): void {
  if (acc.length !== LTHASH_BYTES) throw new RangeError(`${name} must be ${LTHASH_BYTES} bytes`);
}

function lanes(acc: Uint8Array): DataView {
  return new DataView(acc.buffer, acc.byteOffset, acc.byteLength);
}

/** Leaf bytes exactly as AppendLeaves takes them: key_root || amount (u64 LE). */
export function encodeLeaf(keyRoot: Uint8Array, amount: bigint): Uint8Array {
  if (keyRoot.length !== 32) throw new RangeError("keyRoot must be 32 bytes");
  const out = new Uint8Array(LEAF_LEN);
  out.set(keyRoot, 0);
  out.set(u64Le(amount), 32);
  return out;
}

/** Empty accumulator (all lanes zero). */
export function lthashZero(): Uint8Array {
  return new Uint8Array(LTHASH_BYTES);
}

/** acc += expansion(leaf), in place. Returns acc. */
export function lthashAddLeaf(acc: Uint8Array, leaf: Uint8Array): Uint8Array {
  checkAcc(acc, "acc");
  if (leaf.length !== LEAF_LEN) throw new RangeError(`leaf must be ${LEAF_LEN} bytes`);
  const input = new Uint8Array(DOMAIN.length + 1 + LEAF_LEN);
  input.set(DOMAIN, 0);
  input.set(leaf, DOMAIN.length + 1);
  const a = lanes(acc);
  for (let ctr = 0; ctr < BLOCKS; ctr++) {
    input[DOMAIN.length] = ctr;
    const block = lanes(sha256([input]));
    const base = ctr * 32;
    for (let k = 0; k < 32; k += 2) {
      a.setUint16(base + k, (a.getUint16(base + k, true) + block.getUint16(k, true)) & 0xffff, true);
    }
  }
  return acc;
}

/** acc += other, lane-wise wrapping, in place. Returns acc. */
export function lthashAdd(acc: Uint8Array, other: Uint8Array): Uint8Array {
  checkAcc(acc, "acc");
  checkAcc(other, "other");
  const a = lanes(acc);
  const o = lanes(other);
  for (let k = 0; k < LTHASH_BYTES; k += 2) {
    a.setUint16(k, (a.getUint16(k, true) + o.getUint16(k, true)) & 0xffff, true);
  }
  return acc;
}

/** acc -= other, lane-wise wrapping, in place. Returns acc. */
export function lthashSub(acc: Uint8Array, other: Uint8Array): Uint8Array {
  checkAcc(acc, "acc");
  checkAcc(other, "other");
  const a = lanes(acc);
  const o = lanes(other);
  for (let k = 0; k < LTHASH_BYTES; k += 2) {
    a.setUint16(k, (a.getUint16(k, true) - o.getUint16(k, true)) & 0xffff, true);
  }
  return acc;
}

/** True if every lane is zero. */
export function lthashIsZero(acc: Uint8Array): boolean {
  checkAcc(acc, "acc");
  let x = 0;
  for (const byte of acc) x |= byte;
  return x === 0;
}

/** LtHash of a multiset of encoded leaves (order does not matter). */
export function lthashOfLeaves(leaves: readonly Uint8Array[]): Uint8Array {
  const acc = lthashZero();
  for (const leaf of leaves) lthashAddLeaf(acc, leaf);
  return acc;
}

/**
 * Batch state a depositor approves: keccak256(acc || leaf_count (u16 LE) ||
 * total_amount (u64 LE)), as computed by OstraPool.batchState.
 */
export function batchStateHash(acc: Uint8Array, leafCount: number, totalAmount: bigint): Uint8Array {
  checkAcc(acc, "acc");
  if (!Number.isInteger(leafCount) || leafCount < 0 || leafCount > 0xffff) {
    throw new RangeError("leafCount must be a u16");
  }
  const count = new Uint8Array(2);
  new DataView(count.buffer).setUint16(0, leafCount, true);
  return keccak256([acc, count, u64Le(totalAmount)]);
}
