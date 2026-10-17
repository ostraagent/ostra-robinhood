// Wire format, commitments and poll signatures shared by the aggregator and
// the depositors. That a batch built from these leaves seals on-chain is
// checked by test/messages.fork.test.ts and the aggregator's own checks.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  aggregatorPollMessage,
  batchContainsLeaves,
  batchLeavesStandard,
  depositCommitment,
  leafFromWire,
  leafToWire,
  leavesStateHash,
  signAggregatorPoll,
  verifyAggregatorPoll,
  type BatchLeaves,
} from "../src/aggregator.ts";
import { utf8 } from "../src/hash.ts";
import { batchStateHash, encodeLeaf, lthashOfLeaves } from "../src/lthash.ts";

const root = (b: number) => new Uint8Array(32).fill(b);
const leaf = (b: number, amount = 10_000_000n) => ({ keyRoot: root(b), amount });
const POOL = "0x00000000000000000000000000000000000000a1";
const OTHER_POOL = "0x00000000000000000000000000000000000000a2";
const DEPOSIT = keccak256(stringToHex("deposit"));
const OTHER: Hex = keccak256(stringToHex("other deposit"));

function batchOf(leaves: { keyRoot: Uint8Array; amount: bigint }[]): BatchLeaves {
  return { leaves: leaves.map((l) => ({ keyRoot: bytesToHex(l.keyRoot), amount: l.amount })) };
}

test("a leaf round-trips through its wire form", () => {
  const l = leaf(0xab, 10_000_000n);
  const wire = leafToWire(l);
  assert.deepEqual(wire, { keyRoot: "ab".repeat(32), amount: "10000000" });
  const back = leafFromWire(wire);
  assert.deepEqual(back.keyRoot, l.keyRoot);
  assert.equal(back.amount, l.amount);
  assert.equal(leafFromWire({ keyRoot: "00".repeat(32), amount: "18446744073709551615" }).amount, 18_446_744_073_709_551_615n);
});

test("malformed wire leaves are refused", () => {
  const good = "ab".repeat(32);
  for (const bad of [
    null,
    "leaf",
    { keyRoot: good },
    { keyRoot: "AB".repeat(32), amount: "1" },
    { keyRoot: good.slice(2), amount: "1" },
    { keyRoot: good, amount: "0" },
    { keyRoot: good, amount: "01" },
    { keyRoot: good, amount: "-1" },
    { keyRoot: good, amount: "1.5" },
    { keyRoot: good, amount: 1 },
    { keyRoot: good, amount: "18446744073709551616" },
  ]) {
    assert.throws(() => leafFromWire(bad), Error, JSON.stringify(bad));
  }
  assert.throws(() => leafToWire({ keyRoot: new Uint8Array(31), amount: 1n }));
  assert.throws(() => leafToWire({ keyRoot: root(1), amount: 0n }));
});

test("the deposit commitment is the LtHash of the encoded leaves, in any order", () => {
  const leaves = [leaf(1), leaf(2), leaf(3)];
  const expected = lthashOfLeaves(leaves.map((l) => encodeLeaf(l.keyRoot, l.amount)));
  assert.deepEqual(depositCommitment(leaves), expected);
  assert.deepEqual(depositCommitment([leaves[2]!, leaves[0]!, leaves[1]!]), expected);
  assert.notDeepEqual(depositCommitment([leaf(1), leaf(2)]), expected);
});

test("the state hash of a set of leaves is the one of a batch holding exactly them", () => {
  const leaves = [leaf(4), leaf(5), leaf(6, 20_000_000n)];
  assert.deepEqual(leavesStateHash(leaves), batchStateHash(depositCommitment(leaves), 3, 40_000_000n));
  assert.deepEqual(leavesStateHash([leaves[1]!, leaves[2]!, leaves[0]!]), leavesStateHash(leaves));
});

test("a depositor finds its leaves in a batch, counted as a multiset", () => {
  const b = batchOf([leaf(1), leaf(2), leaf(3), leaf(2)]);
  assert.equal(batchContainsLeaves(b, [leaf(2), leaf(3)]), true);
  assert.equal(batchContainsLeaves(b, [leaf(2), leaf(2)]), true);
  assert.equal(batchContainsLeaves(b, [leaf(1), leaf(1)]), false, "listed once in the batch");
  assert.equal(batchContainsLeaves(b, [leaf(4)]), false);
  assert.equal(batchContainsLeaves(b, [leaf(1, 20_000_000n)]), false, "same key root, other amount");
  assert.equal(batchContainsLeaves(b, []), true);
});

test("a depositor approves only a batch whose every leaf is one standard leaf", () => {
  assert.equal(batchLeavesStandard(batchOf([leaf(1), leaf(2), leaf(3)])), true);
  assert.equal(batchLeavesStandard(batchOf([leaf(1), leaf(2, 7_000_000n), leaf(3, 3_000_000n)])), false, "two smaller leaves");
  assert.equal(batchLeavesStandard(batchOf([leaf(1), leaf(2, 20_000_000n)])), false, "a double leaf");
  assert.equal(batchLeavesStandard(batchOf([])), true);
});

test("a poll is signed by the depositor key and bound to the chain, the pool, the deposit and the time", async () => {
  const signer = privateKeyToAccount(`0x${"07".repeat(32)}`);
  const other = privateKeyToAccount(`0x${"08".repeat(32)}`);
  const target = { chainId: 4663, pool: POOL, deposit: DEPOSIT } as const;
  const message = aggregatorPollMessage(target, 1_792_000_000n);
  assert.equal(message.length, 28 + 32 + 20 + 32 + 8);
  assert.deepEqual(message.subarray(0, 28), utf8("OSTRA/AGGREGATOR/POLL/EVM/v1"));
  const sig = await signAggregatorPoll(signer, target, 1_792_000_000n);
  assert.equal(sig.length, 2 + 130);
  assert.equal(await verifyAggregatorPoll(signer.address, target, 1_792_000_000n, sig), true);
  assert.equal(await verifyAggregatorPoll(other.address, target, 1_792_000_000n, sig), false, "another owner");
  assert.equal(await verifyAggregatorPoll(signer.address, { ...target, deposit: OTHER }, 1_792_000_000n, sig), false, "another deposit");
  assert.equal(await verifyAggregatorPoll(signer.address, { ...target, pool: OTHER_POOL }, 1_792_000_000n, sig), false, "another pool");
  assert.equal(await verifyAggregatorPoll(signer.address, { ...target, chainId: 1 }, 1_792_000_000n, sig), false, "another chain");
  assert.equal(await verifyAggregatorPoll(signer.address, target, 1_792_000_001n, sig), false, "another time");
  assert.equal(await verifyAggregatorPoll(signer.address, target, 1_792_000_000n, sig.slice(0, -2) as Hex), false, "short signature");
  assert.equal(await verifyAggregatorPoll(signer.address, target, 1_792_000_000n, "0xzz" as Hex), false, "not hex");
});
