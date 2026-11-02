// The treasury's rules (strategy-rules.ts, the design's "v4 off chain: the treasury engine in MCP"), which need no chain:
// the tiers of the design's worked example, break-even, the caps, no churn, the cash refill from Spark, and no exit at a
// loss.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CASH_MIN,
  CORE_MOVE_MIN_GAP,
  DAY,
  RAETO_ACC_SCALE,
  STEP_HORIZON,
  WAD,
  YEAR,
  accRate,
  aiBudgetPrincipal,
  breakEven,
  cashTier,
  coreMoves,
  growthRate,
  lowerRate,
  pays,
  raetoCap,
  raetoStockRoom,
  steakhouseCap,
  treasuryMoves,
  yieldOver,
  type TreasuryInput,
  type TreasuryVenue,
} from "../src/index.ts";

const USDG = 10n ** 6n;
/** Percent with two decimals, as WAD. */
const pct = (hundredths: bigint) => (hundredths * WAD) / 10_000n;

/** A venue the planner read: open, exitable, no cap, nothing held, unless given. */
const venue = (v: Partial<TreasuryVenue> & Pick<TreasuryVenue, "rate" | "enterCost" | "exitCost">): TreasuryVenue => ({
  rate7: v.rate,
  cap: 10n ** 30n,
  held: 0n,
  open: true,
  why: null,
  exitable: true,
  ...v,
});

/**
 * The design's numbers of 30 Oct 2026: Spark about 3.64% with a round trip of 0.0286 USDG (break-even about 29 USDG),
 * Steakhouse about 3.9% with 0.074 (about 69), Raeto USDG about 3.8% with 0.09 (about 88), Raeto's principal 9,940 USDG
 * held by others (its 5% cap 497).
 */
const spark = (v: Partial<TreasuryVenue> = {}) => venue({ rate: pct(364n), enterCost: 13_600n, exitCost: 15_000n, ...v });
const steak = (v: Partial<TreasuryVenue> = {}) => venue({ rate: pct(390n), enterCost: 40_000n, exitCost: 34_000n, ...v });
const raeto = (v: Partial<TreasuryVenue> = {}) => venue({ rate: pct(380n), enterCost: 50_000n, exitCost: 40_000n, cap: 497n * USDG, ...v });

test("the cash tier is the next 3 days of 30 days of payments, at least 1 USDG", () => {
  assert.equal(cashTier(200n * USDG), 20n * USDG);
  assert.equal(cashTier(0n), CASH_MIN);
  assert.equal(cashTier(5n * USDG), CASH_MIN);
});

test("break-even: the least amount whose 30 days pay three round trips; the design's 29, 69 and 88 USDG", () => {
  for (const [rate, rt, about] of [[pct(364n), 28_600n, 29n], [pct(390n), 74_000n, 69n], [pct(380n), 90_000n, 88n]] as const) {
    const be = breakEven(rate, rt) as bigint;
    assert.ok(pays(be, rate, rt), "the break-even pays");
    assert.ok(!pays(be - 1n, rate, rt), "one unit less does not");
    assert.ok(be / USDG >= about - 2n && be / USDG <= about + 1n, `${be} is about ${about} USDG`);
    // Three round trips within 30 days, exactly as worthIt counts them.
    assert.ok(yieldOver(be, rate, STEP_HORIZON) > 3n * rt);
  }
  assert.equal(breakEven(null, 1n), null);
  assert.equal(breakEven(0n, 1n), null);
  assert.equal(pays(10n ** 12n, -1n, 1n), false);
});

test("realized rates: share price growth, a Raeto accumulator's rise, the lower of 7 and 30 days", () => {
  // 1% over 36.5 days: 10% a year.
  assert.equal(growthRate(1_000_000n, 1_010_000n, YEAR / 10n), pct(1_000n));
  assert.equal(growthRate(0n, 1n, DAY), null);
  assert.ok((growthRate(100n, 99n, DAY) as bigint) < 0n, "a fall is a negative rate");
  // accPerPrincipal rising by 0.001 of a unit over 36.5 days: 1% a year.
  assert.equal(accRate(5n * RAETO_ACC_SCALE, 5n * RAETO_ACC_SCALE + RAETO_ACC_SCALE / 1_000n, YEAR / 10n), pct(100n));
  assert.equal(accRate(2n, 1n, DAY), null);
  assert.equal(lowerRate(pct(400n), pct(380n)), pct(380n));
  assert.equal(lowerRate(pct(400n), null), null);
});

test("the caps: Raeto USDG at the smaller of the budget's principal, 5% of others' principal and half its payout; Steakhouse at 1% and half its payout", () => {
  // 100 USDG of credits a month at 3.8% needs 31,578.947368 USDG of principal.
  assert.equal(aiBudgetPrincipal(100n * USDG, pct(380n)), 31_578_947_368n);
  assert.equal(aiBudgetPrincipal(0n, null), 0n);
  assert.equal(aiBudgetPrincipal(1n, null), null);
  assert.equal(raetoCap({ budgetPrincipal: 31_578_947_368n, totalPrincipal: 9_940n * USDG, own: 0n, payout: 10_000n * USDG }), 497n * USDG);
  // The vault's own principal is not counted toward the 5%.
  assert.equal(raetoCap({ budgetPrincipal: 10n ** 12n, totalPrincipal: 10_437n * USDG, own: 497n * USDG, payout: 10n ** 12n }), 497n * USDG);
  assert.equal(raetoCap({ budgetPrincipal: 10n ** 12n, totalPrincipal: 10n ** 12n, own: 0n, payout: 100n * USDG }), 50n * USDG);
  assert.equal(raetoCap({ budgetPrincipal: 0n, totalPrincipal: 10n ** 12n, own: 0n, payout: 10n ** 12n }), 0n);
  assert.equal(steakhouseCap({ assets: 518_000_000n * USDG, withdrawable: 2_000_000n * USDG, room: 10n ** 15n, held: 0n }), 1_000_000n * USDG);
  assert.equal(steakhouseCap({ assets: 518_000_000n * USDG, withdrawable: 10n ** 15n, room: 300n * USDG, held: 100n * USDG }), 400n * USDG);
});

test("a Raeto stock vault's room: half of what it can pay out, its own new stock counted, within its deposit cap", () => {
  const e18 = 10n ** 18n;
  // Its USDG covers its loan: it can pay out all its collateral, so a newcomer may add as much as is there.
  assert.equal(raetoStockRoom({ collateral: 617n * 10n ** 15n, debt: 40n * USDG, usdgPayout: 41n * USDG, held: 0n, depositRoom: 10n * e18 }), 617n * 10n ** 15n);
  // Half covered: what it pays out is half its collateral; a newcomer's x stays at most half of (collateral + x) / 2.
  const room = raetoStockRoom({ collateral: 3n * e18, debt: 40n * USDG, usdgPayout: 20n * USDG, held: 0n, depositRoom: 10n * e18 });
  assert.equal(room, e18);
  // Holding half already: no more.
  assert.equal(raetoStockRoom({ collateral: 2n * e18, debt: 0n, usdgPayout: 0n, held: e18, depositRoom: 10n * e18 }), 0n);
  assert.equal(raetoStockRoom({ collateral: 9n * e18, debt: 0n, usdgPayout: 0n, held: 0n, depositRoom: e18 }), e18);
});

test("the design's worked example: 2,000 USDG, 200 a month of payments, AI credits: 20 cash, 200 Spark, 497 Raeto USDG, 1,283 Steakhouse", () => {
  const p = treasuryMoves({ idle: 2_000n * USDG, paid30: 200n * USDG, aiBudget: 50n * USDG, venues: { spark: spark(), steakhouse: steak(), raeto_usdg: raeto() } });
  assert.equal(p.cash, 20n * USDG);
  assert.equal(p.earning, 1_980n * USDG);
  assert.equal(p.liquid, 200n * USDG);
  assert.equal(p.ai, 497n * USDG);
  assert.deepEqual(p.core, { ...p.core, venue: "steakhouse", amount: 1_283n * USDG });
  assert.deepEqual(
    p.moves.map((m) => [m.venue, m.side, m.amount, m.urgent]),
    [
      ["spark", "enter", 200n * USDG, false],
      ["raeto_usdg", "enter", 497n * USDG, false],
      ["steakhouse", "enter", 1_283n * USDG, false],
    ],
  );
  for (const m of p.moves) assert.match(m.reason, /over its break-even of/);
});

test("paying: the cash under its tier is refilled from Spark first, urgently, then from Steakhouse; never from the AI budget", () => {
  const held = { spark: 200n * USDG, steakhouse: 1_283n * USDG, raeto_usdg: 497n * USDG };
  const at = (idle: bigint, sparkHeld = held.spark) => treasuryMoves({ idle, paid30: 200n * USDG, aiBudget: 50n * USDG, venues: { spark: spark({ held: sparkHeld }), steakhouse: steak({ held: held.steakhouse }), raeto_usdg: raeto({ held: held.raeto_usdg }) } });
  const p = at(5n * USDG);
  assert.deepEqual(p.moves.map((m) => [m.venue, m.side, m.amount, m.urgent]), [["spark", "exit", 15n * USDG, true]]);
  // Spark holds less than is missing: the rest from Steakhouse.
  const q = at(0n, 8n * USDG);
  assert.deepEqual(q.moves.map((m) => [m.venue, m.side, m.amount, m.urgent]).slice(0, 2), [["spark", "exit", 8n * USDG, true], ["steakhouse", "exit", 12n * USDG, true]]);
  // Short by no more than a Spark exit costs (the fees of the spends that placed the money): no refill.
  const r = at(20n * USDG - 10_000n);
  assert.deepEqual(r.moves, []);
  assert.ok(r.notes.some((n) => /0\.010000 under the cash tier of 20\.000000, no more than a Spark exit costs \(0\.015000\): no refill/.test(n)), r.notes.join("\n"));
});

test("a small vault: Steakhouse's extra yield does not pay its dearer refills, so the earning money stays in Spark", () => {
  const p = treasuryMoves({ idle: 300n * USDG, paid30: 50n * USDG, aiBudget: 0n, venues: { spark: spark(), steakhouse: steak(), raeto_usdg: raeto({ open: false, why: "the AI budget is off" }) } });
  assert.equal(p.core.venue, "spark");
  assert.match(p.core.reason, /does not pay three times .* the earning money stays in Spark/);
  assert.deepEqual(p.moves.map((m) => [m.venue, m.side, m.amount]), [["spark", "enter", 50n * USDG], ["spark", "enter", 245n * USDG]]);
});

test("below break-even the money stays idle and the plan says so; earnings are placed once they pay", () => {
  const p = treasuryMoves({ idle: 25n * USDG, paid30: 0n, aiBudget: 0n, venues: { spark: spark(), steakhouse: steak(), raeto_usdg: raeto({ open: false, why: "off" }) } });
  assert.deepEqual(p.moves, []);
  assert.equal(p.core.venue, null);
  assert.ok(p.notes.some((n) => /stays idle/.test(n)), p.notes.join("\n"));
  // New earnings beside a position: placed only once the increment pays its own break-even.
  const small = treasuryMoves({ idle: 21n * USDG, paid30: 0n, aiBudget: 0n, venues: { spark: spark({ held: 300n * USDG }), steakhouse: steak(), raeto_usdg: raeto({ open: false, why: "off" }) } });
  assert.deepEqual(small.moves, []);
  assert.ok(small.notes.some((n) => /under its break-even of/.test(n)), small.notes.join("\n"));
  const enough = treasuryMoves({ idle: 41n * USDG, paid30: 0n, aiBudget: 0n, venues: { spark: spark({ held: 300n * USDG }), steakhouse: steak(), raeto_usdg: raeto({ open: false, why: "off" }) } });
  assert.deepEqual(enough.moves.map((m) => [m.venue, m.side, m.amount]), [["spark", "enter", 40n * USDG]]);
});

test("Raeto USDG over its cap (its principal shrank) comes back, but never at a loss; the AI budget off brings it all back", () => {
  const base = { idle: 20n * USDG, paid30: 200n * USDG, venues: { spark: spark({ held: 200n * USDG }), steakhouse: steak({ held: 1_283n * USDG }), raeto_usdg: raeto({ held: 497n * USDG, cap: 47n * USDG }) } } satisfies Omit<TreasuryInput, "aiBudget">;
  const p = treasuryMoves({ ...base, aiBudget: 50n * USDG });
  // The principal that came back goes to the core, as new money does.
  assert.deepEqual(p.moves.map((m) => [m.venue, m.side, m.amount, m.urgent]), [["raeto_usdg", "exit", 450n * USDG, false], ["steakhouse", "enter", 450n * USDG, false]]);
  assert.match(p.moves[0]?.reason ?? "", /over its cap of 47\.000000/);
  // In loss: no exit, a note.
  const loss = treasuryMoves({ ...base, aiBudget: 50n * USDG, venues: { ...base.venues, raeto_usdg: raeto({ held: 497n * USDG, cap: 47n * USDG, exitable: false, open: false, why: "it reports a loss" }) } });
  assert.ok(!loss.moves.some((m) => m.side === "exit"), JSON.stringify(loss.moves, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.ok(loss.notes.some((n) => /reports a loss: no automatic exit/.test(n)));
  // The budget off: the whole principal comes back.
  const off = treasuryMoves({ ...base, aiBudget: 0n, venues: { ...base.venues, raeto_usdg: raeto({ held: 497n * USDG, open: false, why: "off" }) } });
  assert.deepEqual(off.moves.filter((m) => m.venue === "raeto_usdg").map((m) => [m.side, m.amount]), [["exit", 497n * USDG]]);
});

test("no churn: the core moves only when the 7-day gap held 0.25 points and 30 days of it pay three moves", () => {
  assert.equal(coreMoves({ amount: 1_000n * USDG, from7: pct(360n), to7: pct(360n) + CORE_MOVE_MIN_GAP - 1n, moveCost: 1n }).ok, false);
  assert.equal(coreMoves({ amount: 1_000n * USDG, from7: pct(360n), to7: pct(360n) + CORE_MOVE_MIN_GAP, moveCost: 10_000n }).ok, true);
  assert.equal(coreMoves({ amount: 10n * USDG, from7: pct(360n), to7: pct(400n), moveCost: 10_000n }).ok, false);
  assert.equal(coreMoves({ amount: 1_000n * USDG, from7: null, to7: pct(400n), moveCost: 1n }).ok, false);
  // Steakhouse's rate falls under Spark's by 0.04 points: the core stays.
  const stays = treasuryMoves({ idle: 20n * USDG, paid30: 200n * USDG, aiBudget: 0n, venues: { spark: spark({ held: 200n * USDG, rate7: pct(364n) }), steakhouse: steak({ held: 1_000n * USDG, rate: pct(360n), rate7: pct(360n) }), raeto_usdg: raeto({ open: false, why: "off" }) } });
  assert.ok(!stays.moves.some((m) => m.venue === "steakhouse"), JSON.stringify(stays.moves, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.ok(stays.notes.some((n) => /the core stays in Steakhouse/.test(n)), stays.notes.join("\n"));
  // Spark 0.4 points over it for 7 days: the core moves.
  const moves = treasuryMoves({ idle: 20n * USDG, paid30: 200n * USDG, aiBudget: 0n, venues: { spark: spark({ held: 200n * USDG, rate: pct(400n), rate7: pct(400n) }), steakhouse: steak({ held: 1_000n * USDG, rate: pct(360n), rate7: pct(360n) }), raeto_usdg: raeto({ open: false, why: "off" }) } });
  assert.deepEqual(moves.moves.map((m) => [m.venue, m.side, m.amount]), [["steakhouse", "exit", 1_000n * USDG], ["spark", "enter", 1_000n * USDG]]);
});

test("a venue closed (the breaker, a loss, an unknown rate) takes no new money; what is held stays", () => {
  const p = treasuryMoves({ idle: 2_000n * USDG, paid30: 200n * USDG, aiBudget: 0n, venues: { spark: spark({ open: false, why: "the breaker finds: code" }), steakhouse: steak(), raeto_usdg: raeto({ open: false, why: "off" }) } });
  assert.equal(p.liquid, 0n);
  assert.ok(!p.moves.some((m) => m.venue === "spark"));
  assert.deepEqual(p.moves.map((m) => [m.venue, m.amount]), [["steakhouse", 1_980n * USDG]]);
  // Steakhouse closed: Spark takes the liquid tier and the core up to half of the earning money; the rest waits idle.
  const q = treasuryMoves({ idle: 2_000n * USDG, paid30: 200n * USDG, aiBudget: 0n, venues: { spark: spark(), steakhouse: steak({ open: false, why: "USDe's price is not known" }), raeto_usdg: raeto({ open: false, why: "off" }) } });
  assert.deepEqual(q.moves.map((m) => [m.venue, m.side, m.amount]), [["spark", "enter", 200n * USDG], ["spark", "enter", 790n * USDG]]);
  assert.ok(q.notes.some((n) => /990\.000000 USDG stays idle while Steakhouse takes no deposit \(USDe's price is not known\)/.test(n)), q.notes.join("\n"));
});

test("Raeto's rate not known: no new money, and the position is kept within the venue's own caps (no exit for an unread rate)", () => {
  const cap = raetoCap({ budgetPrincipal: aiBudgetPrincipal(50n * USDG, null), totalPrincipal: 10_437n * USDG, own: 497n * USDG, payout: 10n ** 12n });
  assert.equal(cap, 497n * USDG, "what is held stands in for the budget's principal");
  // Within the other caps still: 5% of the others' principal.
  assert.equal(raetoCap({ budgetPrincipal: null, totalPrincipal: 1_497n * USDG, own: 497n * USDG, payout: 10n ** 12n }), 50n * USDG);
  const p = treasuryMoves({ idle: 20n * USDG, paid30: 200n * USDG, aiBudget: 50n * USDG, venues: { spark: spark({ held: 200n * USDG }), steakhouse: steak({ held: 1_283n * USDG }), raeto_usdg: raeto({ held: 497n * USDG, cap, rate: null, rate7: null, open: false, why: "its realized rate is not known" }) } });
  assert.ok(!p.moves.some((m) => m.venue === "raeto_usdg"), JSON.stringify(p.moves, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
});
