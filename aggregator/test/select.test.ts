import assert from "node:assert/strict";
import { test } from "node:test";
import { FRESH_SECONDS, MAX_DEPOSITS_PER_BATCH, MIN_ANONYMITY_DEPOSITS } from "../src/config.ts";
import { isFresh, selectDeposits, shuffle } from "../src/select.ts";
import type { DepositRecord } from "../src/store.ts";

const NOW = 1_800_000_000;
const leaf = { keyRoot: "00".repeat(32), amount: "10000000" };

function rec(n: number, o: { leaves?: number; queuedAt?: number; polledAt?: number | null } = {}): DepositRecord {
  return {
    deposit: `deposit-${String(n).padStart(3, "0")}`,
    depositor: "0x00000000000000000000000000000000000000aa",
    leaves: Array.from({ length: o.leaves ?? 1 }, () => leaf),
    attempt: 0,
    minAttempt: 0,
    queuedAt: o.queuedAt ?? NOW - 1000 + n,
    polledAt: o.polledAt === undefined ? NOW - 10 : o.polledAt,
    pollNotBefore: 0,
  };
}

test("the decided numbers", () => {
  assert.equal(MIN_ANONYMITY_DEPOSITS, 8);
  assert.equal(MAX_DEPOSITS_PER_BATCH, 43);
  assert.equal(FRESH_SECONDS, 600);
});

test("a deposit is fresh for FRESH_SECONDS after its last poll", () => {
  assert.equal(isFresh(rec(1, { polledAt: null }), NOW), false);
  assert.equal(isFresh(rec(1, { polledAt: NOW - FRESH_SECONDS }), NOW), true);
  assert.equal(isFresh(rec(1, { polledAt: NOW - FRESH_SECONDS - 1 }), NOW), false);
});

test("no batch below the minimum anonymity, counting only fresh deposits", () => {
  const seven = Array.from({ length: 7 }, (_, i) => rec(i));
  assert.equal(selectDeposits(seven, NOW), null);
  assert.equal(selectDeposits([...seven, rec(7, { polledAt: null })], NOW), null);
  assert.equal(selectDeposits([...seven, rec(7, { polledAt: NOW - FRESH_SECONDS - 1 })], NOW), null);
  const picked = selectDeposits([...seven, rec(7)], NOW);
  assert.equal(picked?.length, 8);
});

test("a deposit waiting for a new leaf set is never batched, fresh or not", () => {
  const seven = Array.from({ length: 7 }, (_, i) => rec(i));
  const rekey = { ...rec(7), leaves: [], minAttempt: 1 };
  assert.equal(isFresh(rekey, NOW), true);
  assert.equal(selectDeposits([...seven, rekey], NOW), null);
  assert.equal(selectDeposits([...seven, rekey, rec(8)], NOW)?.some((r) => r.deposit === rekey.deposit), false);
});

test("deposits are taken oldest first, up to MAX_DEPOSITS_PER_BATCH", () => {
  const all = Array.from({ length: 60 }, (_, i) => rec(i, { queuedAt: NOW - i }));
  const picked = selectDeposits(all, NOW);
  assert.equal(picked?.length, MAX_DEPOSITS_PER_BATCH);
  assert.deepEqual(picked?.map((r) => r.deposit), all.slice(all.length - MAX_DEPOSITS_PER_BATCH).reverse().map((r) => r.deposit));
});

test("a deposit that would pass MAX_LEAVES_PER_BATCH leaves is skipped for later ones that fit", () => {
  // 8 deposits of 24 leaves = 192 leaves; a ninth of 24 does not fit, a 1-leaf one would not either.
  const big = Array.from({ length: 8 }, (_, i) => rec(i, { leaves: 24 }));
  const picked = selectDeposits([...big, rec(8, { leaves: 24 }), rec(9, { leaves: 1 })], NOW);
  assert.equal(picked?.length, 8);
  assert.equal(picked?.reduce((s, r) => s + r.leaves.length, 0), 192);
  // 7 deposits of 24 leaves (168): a 25-leaf deposit would pass 192 and is skipped; the next 24-leaf one fits exactly.
  const mixed = selectDeposits([...big.slice(0, 7), rec(20, { leaves: 25 }), rec(21, { leaves: 24 })], NOW);
  assert.deepEqual(mixed?.map((r) => r.deposit), [...big.slice(0, 7).map((r) => r.deposit), "deposit-021"]);
});

test("the shuffle is a permutation driven by the random source", () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const out = shuffle(items);
  assert.notEqual(out, items);
  assert.deepEqual([...out].sort((a, b) => a - b), items);
  // A source that always picks the last position leaves the order unchanged; one that always picks 0 rotates it.
  assert.deepEqual(shuffle([1, 2, 3, 4], (bound) => bound - 1), [1, 2, 3, 4]);
  assert.deepEqual(shuffle([1, 2, 3, 4], () => 0), [2, 3, 4, 1]);
  assert.deepEqual(shuffle([], () => 0), []);
});
