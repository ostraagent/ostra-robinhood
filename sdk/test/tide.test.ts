// Ostra Tide's shared rules (src/tide.ts): the link digests and view key, week 1's score (fees netted per pair and
// capped, Raeto credits, average balances under the combined cap, active days and multipliers), the pot's shares
// under the 20% cap, and the Merkle tree's proofs. The leaf against the deployed OstraTide is checked in keeper's
// fork test (test/tide-pay.fork.test.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import {
  TIDE_START,
  tideLeaf,
  tideFeePair,
  tideMemberDigest,
  tideScore,
  tideSetDigest,
  tideShares,
  tideSortVaults,
  tideTree,
  tideVerify,
  tideViewKey,
  tideWeekAt,
  tideWeekSpan,
  type TideAgentInput,
  type TideDay,
} from "../src/tide.ts";

const S1: Hex = `0x${"11".repeat(32)}`;
const S2: Hex = `0x${"22".repeat(32)}`;
const A: Address = getAddress("0x00000000000000000000000000000000000000a1");
const B: Address = getAddress("0x00000000000000000000000000000000000000b2");
const NVDA: Address = getAddress("0x00000000000000000000000000000000000000c3");
const day = (n: number, h = 12) => TIDE_START + (n - 1) * 86_400 + h * 3600;
const zeroDays: TideDay[] = Array.from({ length: 7 }, () => ({ cashE6: 0n, borroE6: 0n, idleE6: 0n }));

test("weeks: week 1 starts at START and lasts seven days", () => {
  assert.equal(tideWeekAt(TIDE_START - 1), 0);
  assert.equal(tideWeekAt(TIDE_START), 1);
  assert.equal(tideWeekAt(TIDE_START + 604_799), 1);
  assert.equal(tideWeekAt(TIDE_START + 604_800), 2);
  assert.deepEqual(tideWeekSpan(1), { start: TIDE_START, end: TIDE_START + 604_800 });
  assert.throws(() => tideWeekSpan(0));
});

test("link digests: fixed, distinct per secret, vault and order-free list; the payee must be listed", () => {
  const m = tideMemberDigest({ chainId: 4663, agentId: "19802", vault: A, secret: S1 });
  assert.equal(m, tideMemberDigest({ chainId: 4663, agentId: 19802n, vault: A.toLowerCase() as Address, secret: S1 }));
  assert.notEqual(m, tideMemberDigest({ chainId: 4663, agentId: "19802", vault: A, secret: S2 }));
  assert.notEqual(m, tideMemberDigest({ chainId: 4663, agentId: "19802", vault: B, secret: S1 }));
  assert.notEqual(m, tideMemberDigest({ chainId: 4663, agentId: "19803", vault: A, secret: S1 }));
  assert.notEqual(m, tideMemberDigest({ chainId: 1, agentId: "19802", vault: A, secret: S1 }));
  const s = tideSetDigest({ chainId: 4663, agentId: "19802", vaults: [B, A, A], payee: null, secret: S1 });
  assert.equal(s, tideSetDigest({ chainId: 4663, agentId: "19802", vaults: [A, B], payee: null, secret: S1 }));
  assert.notEqual(s, tideSetDigest({ chainId: 4663, agentId: "19802", vaults: [A, B], payee: B, secret: S1 }));
  assert.notEqual(s, tideSetDigest({ chainId: 4663, agentId: "19802", vaults: [A], payee: null, secret: S1 }));
  assert.throws(() => tideSetDigest({ chainId: 4663, agentId: "19802", vaults: [A], payee: B, secret: S1 }), /payee/);
  assert.throws(() => tideMemberDigest({ chainId: 4663, agentId: "19802", vault: A, secret: `0x${"00".repeat(32)}` }), /secret/);
  assert.throws(() => tideMemberDigest({ chainId: 4663, agentId: "-1", vault: A, secret: S1 }), /agent id/);
  assert.deepEqual(tideSortVaults([B, A.toLowerCase()]), [A, B]);
  assert.notEqual(tideViewKey(S1), tideViewKey(S2));
  assert.notEqual(tideViewKey(S1), S1);
});

const agent = (over: Partial<TideAgentInput>): TideAgentInput => ({ agentId: "1", registeredAt: TIDE_START + 10, fees: [], raeto: [], days: zeroDays, ...over });

test("score: fees netted per pair, capped at $20, 100 points a dollar; fees outside the week ignored", () => {
  // NVDA bought for $1,000 and sold for $600: 400/1600 of its $8 of fees count, $2.
  const r = tideScore(
    agent({
      fees: [
        { time: day(1), feeE6: 5_000_000n, pair: "P", side: "buy", volumeE6: 1_000_000_000n },
        { time: day(2), feeE6: 3_000_000n, pair: "P", side: "sell", volumeE6: 600_000_000n },
        { time: TIDE_START - 1, feeE6: 9_000_000n, pair: "P", side: "buy", volumeE6: 1n },
      ],
    }),
    1,
  );
  assert.equal(r.fee.paidE6, "8000000");
  assert.equal(r.fee.countedE6, "2000000");
  assert.equal(r.fee.nettedOutE6, "6000000");
  assert.equal(r.fee.points, "200000000"); // 200 points
  const big = tideScore(agent({ fees: [{ time: day(3), feeE6: 50_000_000n, pair: "P", side: "buy", volumeE6: 10n ** 12n }] }), 1);
  assert.equal(big.fee.cappedE6, "20000000");
  assert.equal(big.fee.points, "2000000000"); // 2,000 points
  // A swap and its way back are one pair, opposite sides.
  const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  const there = tideFeePair(USDG, NVDA);
  const back = tideFeePair(NVDA, USDG);
  assert.equal(there.pair, back.pair);
  assert.notEqual(there.side, back.side);
});

test("score: Raeto credits 10 points a dollar; balances averaged over seven days under the $1,000 cap, 2-point ones first", () => {
  const days: TideDay[] = Array.from({ length: 7 }, (_, i) => ({ cashE6: 700_000_000n, borroE6: 0n, idleE6: i === 0 ? 2_100_000_000n : 0n }));
  const r = tideScore(agent({ raeto: [{ time: day(4), usdE6: 2_500_000n }], days }), 1);
  assert.equal(r.raeto.points, "25000000");
  assert.equal(r.balances.cashAvgE6, "700000000");
  assert.equal(r.balances.idleAvgE6, "300000000");
  assert.equal(r.balances.countedCashE6, "700000000");
  assert.equal(r.balances.countedIdleE6, "300000000");
  assert.equal(r.balances.points, "1700000000"); // 700 x 2 + 300 x 1
  const over = tideScore(agent({ days: Array.from({ length: 7 }, () => ({ cashE6: 0n, borroE6: 900_000_000n, idleE6: 900_000_000n })) }), 1);
  assert.equal(over.balances.countedBorroE6, "900000000");
  assert.equal(over.balances.countedIdleE6, "100000000");
  assert.equal(over.balances.points, "1900000000");
});

test("score: active days from $0.10 a UTC day; x1.2 from 3 days, x1.3 at 7, x1.5 when registered before week 1", () => {
  const spendOn = (ds: number[]) => ds.map((d) => ({ time: day(d), usdE6: 100_000n }));
  const two = tideScore(agent({ raeto: [...spendOn([1, 2]), { time: day(3), usdE6: 99_999n }] }), 1);
  assert.deepEqual(two.activeDays, [1, 2]);
  assert.equal(two.multiplierBps, "10000");
  const three = tideScore(agent({ raeto: spendOn([1, 4, 7]) }), 1);
  assert.deepEqual(three.activeDays, [1, 4, 7]);
  assert.equal(three.multiplierBps, "12000");
  assert.equal(three.points, ((3_000_000n * 12_000n) / 10_000n).toString());
  const seven = tideScore(agent({ registeredAt: TIDE_START - 1, raeto: spendOn([1, 2, 3, 4, 5, 6, 7]) }), 1);
  assert.equal(seven.early, true);
  assert.equal(seven.multiplierBps, "19500");
  // The last second of the week is day 7; the first of the next is not counted.
  const edge = tideScore(agent({ raeto: [{ time: TIDE_START + 604_799, usdE6: 1_000_000n }, { time: TIDE_START + 604_800, usdE6: 1_000_000n }] }), 1);
  assert.deepEqual(edge.activeDays, [7]);
  assert.equal(edge.raeto.paidE6, "1000000");
  assert.throws(() => tideScore(agent({ days: zeroDays.slice(1) }), 1), /seven days/);
});

test("shares: by points, at most 20% of the pot each, the rest shared again; what nobody can take stays", () => {
  const pot = 5_000_000n * 10n ** 18n;
  const s = tideShares(
    [
      { agentId: "a", points: 900n },
      { agentId: "b", points: 50n },
      { agentId: "c", points: 50n },
      { agentId: "z", points: 0n },
    ],
    pot,
  );
  assert.equal(s.get("a"), pot / 5n);
  assert.equal(s.has("z"), false);
  // b and c take 20% each too (each would get half of the 80% left), so 40% stays.
  assert.equal(s.get("b"), pot / 5n);
  assert.equal(s.get("c"), pot / 5n);
  const many = tideShares(Array.from({ length: 10 }, (_, i) => ({ agentId: String(i), points: i === 0 ? 1_000n : 10n })), 1_000_000n);
  assert.equal(many.get("0"), 200_000n);
  for (let i = 1; i < 10; i++) assert.equal(many.get(String(i)), 800_000n / 9n);
  const total = [...many.values()].reduce((a, b) => a + b, 0n);
  assert.ok(total <= 1_000_000n && total > 999_990n);
});

test("tree: every share's proof verifies against the root, for 1 to 9 shares; a changed share does not", () => {
  for (let n = 1; n <= 9; n++) {
    const shares = Array.from({ length: n }, (_, i) => ({ week: 1, agentId: String(19800 + i), payee: getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`), amount: BigInt(i + 1) * 10n ** 18n }));
    const t = tideTree(shares);
    for (const s of shares) {
      assert.ok(tideVerify(t.root, tideLeaf(s), t.proofs.get(s.agentId)!), `${n} shares: agent ${s.agentId}`);
      assert.equal(tideVerify(t.root, tideLeaf({ ...s, amount: s.amount + 1n }), t.proofs.get(s.agentId)!), false);
    }
    if (n === 1) assert.equal(t.root, tideLeaf(shares[0]!));
  }
  assert.throws(() => tideTree([]), /at least one/);
});
