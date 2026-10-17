// Checks LtHash against golden vectors produced by the Solana program crate
// (ostraagent/ostra e4a4153, program-tests/tests/lthash_vectors.rs), which
// src/LtHash.sol also matches.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fromHex, toHex } from "../src/hash.ts";
import {
  LEAF_LEN,
  LTHASH_BYTES,
  LTHASH_LANES,
  batchStateHash,
  encodeLeaf,
  lthashAdd,
  lthashAddLeaf,
  lthashIsZero,
  lthashOfLeaves,
  lthashSub,
  lthashZero,
} from "../src/lthash.ts";

type Leaf = { name: string; key_root: string; amount: string; encoded: string };
type StateCase = { acc: string; leaf_count: number; total_amount: string; hash: string };
type Vectors = {
  params: { lanes: number; bytes: number; leaf_len: number };
  leaves: Leaf[];
  accumulators: Record<string, string>;
  state_hashes: StateCase[];
};

const v: Vectors = JSON.parse(readFileSync(new URL("./vectors/lthash.json", import.meta.url), "utf8"));
const acc = (name: string): string => {
  const a = v.accumulators[name];
  if (a === undefined) throw new Error(`missing accumulator ${name}`);
  return a;
};
const leaf = (name: string): Uint8Array => {
  const l = v.leaves.find((x) => x.name === name);
  if (l === undefined) throw new Error(`missing leaf ${name}`);
  return encodeLeaf(fromHex(l.key_root), BigInt(l.amount));
};

test("LtHash parameters match the program crate", () => {
  assert.deepEqual(v.params, { lanes: LTHASH_LANES, bytes: LTHASH_BYTES, leaf_len: LEAF_LEN });
});

test("leaf encoding matches the program crate", () => {
  assert.equal(v.leaves.length, 4);
  for (const l of v.leaves) {
    assert.equal(toHex(encodeLeaf(fromHex(l.key_root), BigInt(l.amount))), l.encoded, l.name);
  }
});

test("accumulators match the program crate", () => {
  const [a, b, c, max] = ["leaf/a", "leaf/b", "leaf/c", "leaf/max"].map(leaf) as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];
  assert.equal(toHex(lthashOfLeaves([a])), acc("single_a"));
  assert.equal(toHex(lthashOfLeaves([a, b])), acc("deposit_1_ab"));
  assert.equal(toHex(lthashOfLeaves([c, max])), acc("deposit_2_cmax"));
  assert.equal(toHex(lthashOfLeaves([max, a, c, b])), acc("batch_max_a_c_b"));
  assert.equal(toHex(lthashOfLeaves([a, a])), acc("double_a"));
  assert.equal(toHex(lthashSub(lthashZero(), lthashOfLeaves([a]))), acc("neg_a"));
});

test("homomorphism: union adds, the seal check reaches zero", () => {
  const batch = fromHex(acc("batch_max_a_c_b"));
  const d1 = fromHex(acc("deposit_1_ab"));
  const d2 = fromHex(acc("deposit_2_cmax"));
  assert.equal(toHex(lthashAdd(d1.slice(), d2)), toHex(batch));
  // SealBatch: acc -= each consumed commitment, must end at zero.
  const rest = lthashSub(lthashSub(batch.slice(), d1), d2);
  assert.ok(lthashIsZero(rest));
  // Missing or substituted leaf: the check fails.
  const missing = lthashSub(lthashSub(lthashOfLeaves([leaf("leaf/a"), leaf("leaf/b")]), d1), d2);
  assert.ok(!lthashIsZero(missing));
  const altered = lthashAddLeaf(lthashOfLeaves([leaf("leaf/a")]), encodeLeaf(fromHex(v.leaves[1]!.key_root), 2_500_001n));
  assert.notEqual(toHex(altered), acc("deposit_1_ab"));
});

test("batch state hash matches the program rule", () => {
  assert.equal(v.state_hashes.length, 2);
  for (const s of v.state_hashes) {
    assert.equal(toHex(batchStateHash(fromHex(acc(s.acc)), s.leaf_count, BigInt(s.total_amount))), s.hash, s.acc);
  }
});

test("LtHash input validation", () => {
  assert.throws(() => encodeLeaf(new Uint8Array(31), 1n), RangeError);
  assert.throws(() => encodeLeaf(new Uint8Array(32), -1n), RangeError);
  assert.throws(() => lthashAddLeaf(lthashZero(), new Uint8Array(39)), RangeError);
  assert.throws(() => lthashAdd(new Uint8Array(2047), lthashZero()), RangeError);
  assert.throws(() => batchStateHash(lthashZero(), 65536, 0n), RangeError);
});
