// Standard leaf denomination and deposit sizing. The fee formula mirrors
// OstraPool.sealBatch; the end-to-end check that a deposit sized here seals
// exactly is test/messages.fork.test.ts (a relayed deposit on the fork).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LEAF_DENOMINATION,
  depositForLeaves,
  isStandardLeaf,
  maxLeavesPerDeposit,
  poolNetAmount,
  standardLeafAmounts,
} from "../src/leaves.ts";

test("the only leaf amount is 10 USDG", () => {
  assert.equal(LEAF_DENOMINATION, 10_000_000n);
  assert.equal(isStandardLeaf(10_000_000n), true);
  for (const other of [0n, 1_000_000n, 9_999_999n, 10_000_001n, 100_000_000n]) assert.equal(isStandardLeaf(other), false);
  assert.deepEqual(standardLeafAmounts(3), [10_000_000n, 10_000_000n, 10_000_000n]);
});

test("net amount matches the pool fee: floor(amount * fee_bps / 10_000) is kept", () => {
  // Same numbers as the 0.30% pool of the Solana program's tests: 3 USDG keeps 9_000.
  assert.equal(poolNetAmount(3_000_000n, 30), 2_991_000n);
  assert.equal(poolNetAmount(5_000_000n, 30), 4_985_000n);
  assert.equal(poolNetAmount(1n, 30), 1n, "fees round down");
  assert.equal(poolNetAmount(10_000_000n, 0), 10_000_000n);
});

test("a sized deposit nets exactly its leaves and is the smallest that does", () => {
  assert.equal(depositForLeaves(2, 30), 20_060_180n);
  for (const fee of [0, 1, 7, 30, 99, 250, 500]) {
    for (let n = 1; n <= 30; n++) {
      const amount = depositForLeaves(n, fee);
      const target = BigInt(n) * LEAF_DENOMINATION;
      assert.equal(poolNetAmount(amount, fee), target, `fee ${fee} leaves ${n}`);
      assert.ok(poolNetAmount(amount - 1n, fee) < target, `fee ${fee} leaves ${n}: not the smallest`);
    }
  }
});

test("one deposit under the 250 USDG limit carries at most 24 leaves at 0.30%", () => {
  assert.equal(maxLeavesPerDeposit(250_000_000n, 30), 24);
  assert.ok(depositForLeaves(24, 30) <= 250_000_000n);
  assert.ok(depositForLeaves(25, 30) > 250_000_000n);
  assert.equal(maxLeavesPerDeposit(10_000_000n, 30), 0, "10 USDG cannot cover one leaf plus the fee");
  assert.equal(maxLeavesPerDeposit(10_000_000n, 0), 1);
});

test("input validation", () => {
  assert.throws(() => depositForLeaves(0, 30), RangeError);
  assert.throws(() => depositForLeaves(1.5, 30), RangeError);
  assert.throws(() => depositForLeaves(1, 501), RangeError);
  assert.throws(() => poolNetAmount(-1n, 30), RangeError);
  assert.throws(() => standardLeafAmounts(0), RangeError);
});
