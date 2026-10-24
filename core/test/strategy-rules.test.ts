// The strategy planner's rules (strategy-rules.ts), which need no chain: each number checked against the design's rule
// it implements, at its edges.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BPS,
  CARRY_CLOSE_OF_LLTV_BPS,
  CARRY_MAX_UTILIZATION,
  CARRY_MIN_SPREAD,
  CARRY_RESET_OF_LLTV_BPS,
  DAY,
  DEFAULT_TRADING_LIMITS,
  STEP_HORIZON,
  STOCK_FEED_MAX_AGE,
  WAD,
  YEAR,
  buysAllowed,
  carryAction,
  carryIdleReserve,
  carryMayOpen,
  carryTarget,
  depositable,
  impactBps,
  ofBps,
  positionMax,
  shareGrowthTooLow,
  splitByImpact,
  tradingLimits,
  worthIt,
  yieldOver,
  type CarryState,
} from "../src/index.ts";

const USDG = 10n ** 6n;
const pct = (n: bigint) => (n * WAD) / 100n;

test("yieldOver is simple interest over the seconds given, and nothing for nothing", () => {
  assert.equal(yieldOver(1_000n * USDG, pct(10n), YEAR), 100n * USDG);
  assert.equal(yieldOver(1_000n * USDG, pct(10n), STEP_HORIZON), (1_000n * USDG * pct(10n) * STEP_HORIZON) / (WAD * YEAR));
  assert.equal(yieldOver(0n, pct(10n), YEAR), 0n);
  assert.equal(yieldOver(1n, 0n, YEAR), 0n);
  assert.equal(yieldOver(1n, pct(10n), 0n), 0n);
  assert.equal(yieldOver(1n, -1n, YEAR), 0n);
});

test("a step is worth its gas only when it earns more than 3x it", () => {
  assert.equal(worthIt(301n, 100n), true);
  assert.equal(worthIt(300n, 100n), false);
  assert.equal(worthIt(1n, 0n), true);
  assert.equal(worthIt(0n, 0n), false);
});

test("the buffer is never deposited", () => {
  assert.equal(depositable(100n, 30n), 70n);
  assert.equal(depositable(30n, 30n), 0n);
  assert.equal(depositable(10n, 30n), 0n);
});

test("share growth under half of the model over 3 days or more is too low; a shorter window cannot tell", () => {
  const prev = { price: 10n ** 18n, at: 1_000_000n, modelApy: pct(5n) };
  const window = 3n * DAY;
  const modelled = yieldOver(prev.price, prev.modelApy, window);
  assert.equal(shareGrowthTooLow(prev, { price: prev.price + modelled, at: prev.at + window - 1n }), null);
  assert.equal(shareGrowthTooLow(prev, { price: prev.price + modelled, at: prev.at + window }), false);
  // Exactly half (rounded up) is enough; one unit less is too low.
  const half = (modelled + 1n) / 2n;
  assert.equal(shareGrowthTooLow(prev, { price: prev.price + half, at: prev.at + window }), false);
  assert.equal(shareGrowthTooLow(prev, { price: prev.price + half - 1n, at: prev.at + window }), true);
  assert.equal(shareGrowthTooLow(prev, { price: prev.price - 1n, at: prev.at + window }), true);
  assert.equal(shareGrowthTooLow({ ...prev, modelApy: 0n }, { price: prev.price, at: prev.at + window }), false);
  assert.equal(shareGrowthTooLow({ ...prev, price: 0n }, { price: 1n, at: prev.at + window }), null);
});

test("the carry's target is the opening share of the LLTV, within the room under 90% use that every Ostra vault shares", () => {
  const lltv = pct(77n); // 0.77
  const base = { symbol: "SPY", collateralValue: 10_000n * USDG, lltv, supply: 1_000_000n * USDG, borrowed: 0n, debt: 0n };
  // By collateral: 10,000 x 0.77 x 50% = 3,850.
  assert.equal(carryTarget(base), 3_850n * USDG);
  assert.equal(carryTarget({ ...base, symbol: "NVDA" }), (10_000n * USDG * lltv * 4_500n) / (WAD * BPS));
  assert.equal(carryTarget({ ...base, symbol: "AAPL" }), 0n);
  // By the market: 90% of 1,000,000 less 899,000 borrowed leaves 1,000 for everyone.
  assert.equal(carryTarget({ ...base, borrowed: 899_000n * USDG }), 1_000n * USDG);
  // The market's borrows already hold this vault's own debt: the target counts it once, as part of the room.
  assert.equal(carryTarget({ ...base, borrowed: 899_000n * USDG, debt: 2_000n * USDG }), 3_000n * USDG);
  // Past 90% use there is no room: the target is the debt itself (nothing to add), never more than by collateral.
  assert.equal(carryTarget({ ...base, borrowed: 950_000n * USDG, debt: 2_000n * USDG }), 2_000n * USDG);
  assert.equal(carryTarget({ ...base, borrowed: 950_000n * USDG, debt: 5_000n * USDG }), 3_850n * USDG);
  assert.equal((base.supply * CARRY_MAX_UTILIZATION) / WAD, 900_000n * USDG);
});

test("ofBps", () => {
  assert.equal(ofBps(0n, 0n), 0n);
  assert.equal(ofBps(1n, 0n), 10n * BPS);
  assert.equal(ofBps(7n, 10n), 7_000n);
});

test("the carry ladder, in the design's order", () => {
  const limit = 10_000n * USDG;
  const s: CarryState = { symbol: "SPY", debt: 5_000n * USDG, fullLimit: limit, supply: 1_000_000n * USDG, borrowed: 500_000n * USDG, borrowRates: [pct(5n), pct(5n)], cashApy: pct(8n), eventWindow: false };
  assert.equal(carryAction({ ...s, debt: 0n }).kind, "hold");
  assert.deepEqual(carryAction(s).kind, "hold");
  // 85% of the LLTV: repaid in full, at once (before any other rule).
  const close = carryAction({ ...s, debt: (limit * CARRY_CLOSE_OF_LLTV_BPS) / BPS, borrowRates: [pct(20n), pct(20n)] });
  assert.equal(close.kind, "close");
  assert.equal(close.kind === "close" && close.urgent, true);
  // The rate averaged over the last two runs above the cash yield less 1 point: repaid in full, not urgent.
  const floor = pct(8n) - CARRY_MIN_SPREAD;
  assert.equal(carryAction({ ...s, borrowRates: [floor, floor] }).kind, "hold");
  const dear = carryAction({ ...s, borrowRates: [floor, floor + 2n] });
  assert.equal(dear.kind, "close");
  assert.equal(dear.kind === "close" && dear.urgent, false);
  // One run's rate alone does not close it.
  assert.equal(carryAction({ ...s, borrowRates: [pct(20n)] }).kind, "hold");
  // 70%: back to the opening level (50% for SPY), at once.
  const at70 = carryAction({ ...s, debt: (limit * CARRY_RESET_OF_LLTV_BPS) / BPS });
  assert.deepEqual(at70.kind === "repay" ? [at70.amount, at70.urgent] : null, [2_000n * USDG, true]);
  assert.equal(carryAction({ ...s, debt: (limit * CARRY_RESET_OF_LLTV_BPS) / BPS - 1n }).kind, "hold");
  // NVDA in an event window: 60% already brings it back to 45%; outside one, it holds until 70%.
  const nvda = { ...s, symbol: "NVDA", debt: 6_000n * USDG };
  const ev = carryAction({ ...nvda, eventWindow: true });
  assert.deepEqual(ev.kind === "repay" ? [ev.amount, ev.urgent] : null, [1_500n * USDG, true]);
  assert.equal(carryAction(nvda).kind, "hold");
  // The market past 90% use: what brings it back to 90%, at most the debt, not urgent.
  // An excess of the whole debt or more: all of it, not urgent.
  const busy = carryAction({ ...s, borrowed: 910_000n * USDG });
  assert.deepEqual([busy.kind, busy.kind === "close" && busy.urgent], ["close", false]);
  assert.equal(carryAction({ ...s, borrowed: 905_000n * USDG }).kind, "close");
  const busier = carryAction({ ...s, borrowed: 902_000n * USDG });
  assert.deepEqual(busier.kind === "repay" ? busier.amount : null, 2_000n * USDG);
});

test("a carry opens only for a carry stock, with the market open, a fresh feed and more than 1 point of spread", () => {
  const ok = { symbol: "QQQ", marketClosed: false, feedAge: STOCK_FEED_MAX_AGE, borrowRate: pct(5n), cashApy: pct(6n) + 1n };
  assert.equal(carryMayOpen(ok).ok, true);
  assert.equal(carryMayOpen({ ...ok, symbol: "TSLA" }).ok, false);
  assert.equal(carryMayOpen({ ...ok, marketClosed: true }).ok, false);
  assert.equal(carryMayOpen({ ...ok, feedAge: STOCK_FEED_MAX_AGE + 1n }).ok, false);
  assert.equal(carryMayOpen({ ...ok, cashApy: pct(6n) }).ok, false);
  assert.equal(STOCK_FEED_MAX_AGE, 25n * 3_600n);
});

test("the idle reserve is what the 70% step repays: 2/7 of the debt, rounded up", () => {
  assert.equal(carryIdleReserve(7_000n), 2_000n);
  assert.equal(carryIdleReserve(1n), 1n);
  assert.equal(carryIdleReserve(0n), 0n);
  // From 70% back to 50%: 70 - 50 = 20 of 70 = 2/7.
  assert.equal(carryIdleReserve(70n), 20n);
});

test("trading limits: Ostra's by default, an agent may only tighten them", () => {
  assert.deepEqual(tradingLimits(), DEFAULT_TRADING_LIMITS);
  assert.deepEqual(DEFAULT_TRADING_LIMITS, { positionMaxBps: 2_500n, maxImpactBps: 100n, dailyLossBps: 500n, weeklyLossBps: 1_000n });
  assert.equal(tradingLimits({ positionMaxBps: 1_000n }).positionMaxBps, 1_000n);
  assert.throws(() => tradingLimits({ positionMaxBps: 2_501n }), RangeError);
  assert.throws(() => tradingLimits({ dailyLossBps: 0n }), RangeError);
  assert.throws(() => tradingLimits({ maxImpactBps: 101n }), RangeError);
});

test("buys stop for the day after a 5% loss, and for the week after 10%", () => {
  const l = DEFAULT_TRADING_LIMITS;
  assert.equal(buysAllowed(l, { dayStart: 1_000n, weekStart: 1_000n, now: 951n }).ok, true);
  assert.equal(buysAllowed(l, { dayStart: 1_000n, weekStart: 1_000n, now: 950n }).ok, false);
  // 47 of 950 is under 5% today and 97 of 1,000 under 10% this week; 5 of 905 today but 100 of 1,000 this week stops.
  assert.equal(buysAllowed(l, { dayStart: 950n, weekStart: 1_000n, now: 903n }).ok, true);
  assert.equal(buysAllowed(l, { dayStart: 905n, weekStart: 1_000n, now: 900n }).ok, false);
  assert.match(buysAllowed(l, { dayStart: 905n, weekStart: 1_000n, now: 900n }).reason, /this week/);
  assert.equal(buysAllowed(l, { dayStart: 0n, weekStart: 0n, now: 0n }).ok, true);
  assert.equal(buysAllowed(l, { dayStart: 1_000n, weekStart: 1_000n, now: 2_000n }).ok, true);
});

test("a position is at most 25% of the capital and at most what the quotes allow", () => {
  assert.equal(positionMax(DEFAULT_TRADING_LIMITS, 1_000n, 10_000n), 250n);
  assert.equal(positionMax(DEFAULT_TRADING_LIMITS, 1_000n, 100n), 100n);
});

// A constant-product pool (Uniswap v2's x*y=k with a 0.3% fee), the formula a quote of such a pool computes: the
// splitting rule is tested against the impact it really has, not against made-up outputs.
function constantProduct(reserveIn: bigint, reserveOut: bigint) {
  return async (amountIn: bigint) => {
    const inWithFee = amountIn * 997n;
    return (inWithFee * reserveOut) / (reserveIn * 1_000n + inWithFee);
  };
}

test("impactBps measures a quote against a small one", async () => {
  const q = constantProduct(1_000_000n * USDG, 1_000_000n * USDG);
  const refIn = 1_000n * USDG;
  const refOut = await q(refIn);
  assert.equal(impactBps({ amount: refIn, out: refOut, refIn, refOut }), 0n);
  // 1% of the pool moves its price about 1% from the spot; against the small quote (itself 0.1% of the pool in, so
  // about 0.1% off the spot, the fee the same in both) that is about 0.9%.
  const big = 10_000n * USDG;
  const i = impactBps({ amount: big, out: await q(big), refIn, refOut });
  assert.ok(i >= 85n && i <= 92n, `impact ${i}`);
  assert.equal(impactBps({ amount: 0n, out: 0n, refIn, refOut }), 0n);
});

test("splitByImpact doubles the parts until each part moves the price within the limit", async () => {
  const q = constantProduct(1_000_000n * USDG, 1_000_000n * USDG);
  const one = await splitByImpact(5_000n * USDG, 100n, q);
  assert.equal(one.parts, 1);
  const split = await splitByImpact(40_000n * USDG, 100n, q);
  assert.ok(split.parts > 1);
  assert.ok(split.impactBps <= 100n);
  assert.equal(split.part, (40_000n * USDG) / BigInt(split.parts));
  // Half as many parts would move the price past the limit.
  const refOut = await q(40n * USDG);
  const half = (40_000n * USDG) / BigInt(split.parts / 2);
  assert.ok(impactBps({ amount: half, out: await q(half), refIn: 40n * USDG, refOut }) > 100n);
  await assert.rejects(splitByImpact(10_000_000n * USDG, 100n, q, 4), RangeError);
  await assert.rejects(splitByImpact(0n, 100n, q), RangeError);
});
