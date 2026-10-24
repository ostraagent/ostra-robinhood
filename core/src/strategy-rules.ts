// The rules of Ostra's strategy planner, as pure functions of what the planner read (strategy.ts reads, these
// decide). Every number is the design document's ("Strategi (versi 2)", decided 24 Oct 2026) or a decision of Edu's
// of 24 Oct 2026, unless its comment says it was measured; amounts are base units, rates are per year (WAD, simple).

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const YEAR = 31_536_000n;
export const DAY = 86_400n;

// --- Cash (Strategy 1) ------------------------------------------------------------------------------------------------

/** The agent's working buffer (x402, swaps, payments) is never deposited: by default 7 days of what its USDG vault spent. */
export const BUFFER_DAYS = 7n;
/** Cash moves to another vault only when it earns more than 1 point more there, and the 7 days' gain is over 3x the gas. */
export const MOVE_MIN_SPREAD = WAD / 100n;
export const MOVE_HORIZON = 7n * DAY;
/** Every step must earn more than 3x its gas within 30 days. */
export const STEP_GAS_MULTIPLE = 3n;
export const STEP_HORIZON = 30n * DAY;
/** A cash vault is left when its share price grew less than half of what its markets modelled, over at least 3 days. */
export const SHARE_GROWTH_MIN_OF_MODEL_BPS = 5_000n;
export const SHARE_GROWTH_WINDOW = 3n * DAY;
/**
 * A cash vault is left when its liquidity market is 99% used or more: withdrawals then depend on borrowers repaying.
 * The design lists this market's utilisation among the checks of every run without a number; 99% is the breaker's
 * (Strategy 3) number for the same condition.
 */
export const LIQUIDITY_EXIT_UTILIZATION = (99n * WAD) / 100n;

/** Interest `amount` earns at `apy` (per year, WAD, simple) over `seconds`. */
export function yieldOver(amount: bigint, apy: bigint, seconds: bigint): bigint {
  if (amount <= 0n || apy <= 0n || seconds <= 0n) return 0n;
  return (amount * apy * seconds) / (WAD * YEAR);
}

/** Whether a step earning `gain` over its horizon is worth `cost` (both USDG base units): gain > 3x cost. */
export function worthIt(gain: bigint, cost: bigint): boolean {
  return gain > STEP_GAS_MULTIPLE * cost;
}

/** What may be deposited: the USDG vault's balance less the buffer (never negative). */
export function depositable(balance: bigint, buffer: bigint): bigint {
  return balance > buffer ? balance - buffer : 0n;
}

/**
 * Whether cash should leave a vault because its share price grew too little: `prev` and `now` are the share price
 * (assets of one share unit) at two runs at least SHARE_GROWTH_WINDOW apart, `modelApy` the yield modelled at `prev`.
 * Null when the window is too short to tell.
 */
export function shareGrowthTooLow(prev: { price: bigint; at: bigint; modelApy: bigint }, now: { price: bigint; at: bigint }): boolean | null {
  const dt = now.at - prev.at;
  if (dt < SHARE_GROWTH_WINDOW || prev.price === 0n) return null;
  const modelled = yieldOver(prev.price, prev.modelApy, dt);
  if (modelled === 0n) return false;
  const grew = now.price - prev.price;
  return grew * BPS < modelled * SHARE_GROWTH_MIN_OF_MODEL_BPS;
}

// --- Carry (Strategy 2) -----------------------------------------------------------------------------------------------

/**
 * The stocks a carry may use and its opening level (share of the LLTV): SPY and QQQ 50%, NVDA 45%. Stocks with a
 * 38.5% LLTV are not used (design: "Tidak dipakai: carry di saham LLTV 38,5%").
 */
export const CARRY_OPEN_OF_LLTV_BPS: Readonly<Record<string, bigint>> = { SPY: 5_000n, QQQ: 5_000n, NVDA: 4_500n };
/** At 70% of the LLTV the debt goes back to the opening level; at 85% it is repaid in full. */
export const CARRY_RESET_OF_LLTV_BPS = 7_000n;
export const CARRY_CLOSE_OF_LLTV_BPS = 8_500n;
/** NVDA at most 60% of the LLTV over a weekend or a holiday and before earnings (above it: back to the opening level). */
export const CARRY_EVENT_MAX_OF_LLTV_BPS: Readonly<Record<string, bigint>> = { NVDA: 6_000n };
/** A carry opens only when the cash vault pays more than 1 point over the loan, and is repaid when it stops paying that. */
export const CARRY_MIN_SPREAD = WAD / 100n;
/** A market is not borrowed from past 90% use (the IRM's rate climbs fast above its 90% target). */
export const CARRY_MAX_UTILIZATION = (90n * WAD) / 100n;
/**
 * A stock oracle's feed is stale when its last answer is older than this while the market is open: measured over 30
 * days (24 Oct 2026), the longest weekday gap between updates was 24.0 hours for SPY and QQQ and 19.4 hours for NVDA (a
 * 24-hour heartbeat), plus one hour of margin. The same oracles' quote feed, USDG / USD, answers once a day (longest
 * gap 86,430 s over its last 40 rounds, read 24 Oct 2026), within it too.
 */
export const STOCK_FEED_MAX_AGE = 25n * 3_600n;
/** How far ahead a run looks for a market closure or an earnings report (the next run may come a day later). */
export const EVENT_LOOKAHEAD = DAY;

/**
 * The debt a stock vault's carry aims at (design): min(open x LLTV x collateral value, its debt now plus what keeps
 * the market at 90% use: 90% of its supply less its borrows). The market's borrows, read on-chain, already hold every
 * Ostra vault's debt (this one's too), so the room is one allocation that all Ostra vaults share, and nothing is
 * counted twice. `collateralValue` in USDG base units at the oracle's price, `lltv` WAD; never below zero.
 */
export function carryTarget(a: { symbol: string; collateralValue: bigint; lltv: bigint; supply: bigint; borrowed: bigint; debt: bigint }): bigint {
  const open = CARRY_OPEN_OF_LLTV_BPS[a.symbol];
  if (open === undefined) return 0n;
  const byCollateral = (a.collateralValue * a.lltv * open) / (WAD * BPS);
  const free = (a.supply * CARRY_MAX_UTILIZATION) / WAD - a.borrowed;
  const room = a.debt + (free > 0n ? free : 0n);
  return byCollateral < room ? byCollateral : room;
}

export type CarryState = {
  symbol: string;
  debt: bigint;
  /** What the collateral allows at the full LLTV (debt / this = how far toward liquidation). */
  fullLimit: bigint;
  supply: bigint;
  borrowed: bigint;
  /** The loan's rate at the last two runs (this one last), and the cash vault's modelled yield now. */
  borrowRates: readonly bigint[];
  cashApy: bigint;
  /** A market closure (weekend, holiday) or an earnings report is now or within EVENT_LOOKAHEAD. */
  eventWindow: boolean;
};

export type CarryAction =
  | { kind: "hold"; reason: string }
  | { kind: "repay"; amount: bigint; reason: string; urgent: boolean }
  | { kind: "close"; reason: string; urgent: boolean };

/** Basis points of `x` over `y` (debt over full limit), rounded down; 10x when the limit is zero and a debt exists. */
export function ofBps(x: bigint, y: bigint): bigint {
  if (x === 0n) return 0n;
  return y === 0n ? 10n * BPS : (x * BPS) / y;
}

/**
 * The ladder, in order (design): 85% of the LLTV or more: repay in full; the loan's rate averaged over the last two
 * runs above the cash yield less 1 point: repay in full; 70% or more (60% for NVDA in an event window): back to the
 * opening level; the market past 90% use: repay what brings it back to 90% (all of it when that is the whole debt or
 * more); else hold.
 */
export function carryAction(s: CarryState): CarryAction {
  if (s.debt === 0n) return { kind: "hold", reason: "no debt" };
  const open = CARRY_OPEN_OF_LLTV_BPS[s.symbol];
  const ltv = ofBps(s.debt, s.fullLimit);
  if (ltv >= CARRY_CLOSE_OF_LLTV_BPS) return { kind: "close", reason: `the debt is ${ltv} bps of the LLTV limit, at or past ${CARRY_CLOSE_OF_LLTV_BPS}`, urgent: true };
  const floor = s.cashApy > CARRY_MIN_SPREAD ? s.cashApy - CARRY_MIN_SPREAD : 0n;
  if (s.borrowRates.length >= 2) {
    const [a, b] = s.borrowRates.slice(-2) as [bigint, bigint];
    if ((a + b) / 2n > floor) return { kind: "close", reason: "the loan's rate, averaged over the last two runs, is above the cash yield less 1 point", urgent: false };
  }
  const eventMax = CARRY_EVENT_MAX_OF_LLTV_BPS[s.symbol];
  const reset = s.eventWindow && eventMax !== undefined ? eventMax : CARRY_RESET_OF_LLTV_BPS;
  if (open !== undefined && ltv >= reset) {
    const target = (s.fullLimit * open) / BPS;
    const amount = s.debt > target ? s.debt - target : 0n;
    if (amount > 0n) return { kind: "repay", amount, reason: `the debt is ${ltv} bps of the LLTV limit, at or past ${reset}: back to ${open}`, urgent: true };
  }
  if (s.supply > 0n && s.borrowed * WAD > s.supply * CARRY_MAX_UTILIZATION) {
    const over = s.borrowed - (s.supply * CARRY_MAX_UTILIZATION) / WAD;
    // An excess of the whole debt or more repays it all (by its shares, so no dust of interest is left).
    if (over >= s.debt) return { kind: "close", reason: "the market is past 90% use by the whole debt or more", urgent: false };
    if (over > 0n) return { kind: "repay", amount: over, reason: "the market is past 90% use", urgent: false };
  }
  return { kind: "hold", reason: `the debt is ${ltv} bps of the LLTV limit` };
}

/** Whether a carry may open now: a carry stock, the market open and its feed fresh, and the cash yield over the loan's rate by more than 1 point. */
export function carryMayOpen(a: { symbol: string; marketClosed: boolean; feedAge: bigint; borrowRate: bigint; cashApy: bigint }): { ok: boolean; reason: string } {
  if (CARRY_OPEN_OF_LLTV_BPS[a.symbol] === undefined) return { ok: false, reason: `${a.symbol} is not a carry stock (SPY, QQQ, NVDA)` };
  if (a.marketClosed) return { ok: false, reason: "the stock market is closed" };
  if (a.feedAge > STOCK_FEED_MAX_AGE) return { ok: false, reason: `the price feed is ${a.feedAge} s old` };
  if (a.cashApy <= a.borrowRate + CARRY_MIN_SPREAD) return { ok: false, reason: "the cash yield is not more than 1 point over the loan's rate" };
  return { ok: true, reason: "ok" };
}

/** The USDG kept idle in the USDG vault against a carry: what the 70% step repays (2/7 of the debt, design). */
export function carryIdleReserve(totalDebt: bigint): bigint {
  return (totalDebt * 2n + 6n) / 7n;
}

// --- Trading working capital (decided by Edu on 24 Oct 2026: Ostra's limits, an agent may only tighten them) -----------

/**
 * A position is at most 25% of the trading capital, and at most the size whose quote moves the price 1%; buys stop for
 * the day after a 5% loss of the capital that day, and for the week after 10% that week. 25%, 5% and 10% are common
 * risk-management conventions, not measurements; the 1% impact is measured from a quote each time.
 */
export const TRADE_POSITION_MAX_BPS = 2_500n;
export const TRADE_MAX_IMPACT_BPS = 100n;
export const TRADE_DAILY_LOSS_BPS = 500n;
export const TRADE_WEEKLY_LOSS_BPS = 1_000n;

export type TradingLimits = { positionMaxBps: bigint; maxImpactBps: bigint; dailyLossBps: bigint; weeklyLossBps: bigint };
export const DEFAULT_TRADING_LIMITS: TradingLimits = { positionMaxBps: TRADE_POSITION_MAX_BPS, maxImpactBps: TRADE_MAX_IMPACT_BPS, dailyLossBps: TRADE_DAILY_LOSS_BPS, weeklyLossBps: TRADE_WEEKLY_LOSS_BPS };

/** An agent's limits, each at most Ostra's (a looser one is refused, not silently clipped). */
export function tradingLimits(asked: Partial<TradingLimits> = {}): TradingLimits {
  const out = { ...DEFAULT_TRADING_LIMITS };
  for (const k of Object.keys(DEFAULT_TRADING_LIMITS) as (keyof TradingLimits)[]) {
    const v = asked[k];
    if (v === undefined) continue;
    if (v <= 0n || v > DEFAULT_TRADING_LIMITS[k]) throw new RangeError(`${k} may be 1 to ${DEFAULT_TRADING_LIMITS[k]} bps (an agent may only tighten Ostra's limits)`);
    out[k] = v;
  }
  return out;
}

/**
 * Whether a buy may happen now: `capital` the trading capital at the start of the day and of the week, `now` its value
 * now (holdings at quotes plus its USDG), all USDG base units.
 */
export function buysAllowed(l: TradingLimits, a: { dayStart: bigint; weekStart: bigint; now: bigint }): { ok: boolean; reason: string } {
  if (a.dayStart > 0n && (a.dayStart - a.now) * BPS >= a.dayStart * l.dailyLossBps) return { ok: false, reason: `the trading capital lost ${l.dailyLossBps} bps or more today` };
  if (a.weekStart > 0n && (a.weekStart - a.now) * BPS >= a.weekStart * l.weeklyLossBps) return { ok: false, reason: `the trading capital lost ${l.weeklyLossBps} bps or more this week` };
  return { ok: true, reason: "ok" };
}

/** The most one position may be: min(positionMaxBps of the capital, the size the quotes allow at maxImpactBps). */
export function positionMax(l: TradingLimits, capital: bigint, impactLimitedSize: bigint): bigint {
  const byCapital = (capital * l.positionMaxBps) / BPS;
  return byCapital < impactLimitedSize ? byCapital : impactLimitedSize;
}

// --- Price impact and splitting ---------------------------------------------------------------------------------------

/** The price impact (bps) of a quote: how much less `out` is than `amount` at the price of a small quote (`refIn` -> `refOut`). */
export function impactBps(a: { amount: bigint; out: bigint; refIn: bigint; refOut: bigint }): bigint {
  if (a.amount === 0n || a.refIn === 0n || a.refOut === 0n) return 0n;
  const atRef = (a.amount * a.refOut) / a.refIn;
  if (a.out >= atRef) return 0n;
  return ((atRef - a.out) * BPS) / atRef;
}

/**
 * Splits `amount` into equal parts so that each part's quote stays within `maxImpactBps` (design: "Swap besar dipecah
 * menurut dampak harga dari quote, dengan batas dampak per bagian"). `quote(part)` returns the output of one part; the
 * parts double until one part is within the limit, at most `maxParts`. Parts trade one after another, so each sees the
 * price the previous one left: the parts are spaced by the caller.
 */
export async function splitByImpact(amount: bigint, maxImpactBps: bigint, quote: (amountIn: bigint) => Promise<bigint>, maxParts = 16): Promise<{ parts: number; part: bigint; impactBps: bigint }> {
  if (amount <= 0n) throw new RangeError("amount must be positive");
  const refIn = amount / 1_000n > 0n ? amount / 1_000n : 1n;
  const refOut = await quote(refIn);
  for (let parts = 1; parts <= maxParts; parts *= 2) {
    const part = amount / BigInt(parts);
    const impact = impactBps({ amount: part, out: await quote(part), refIn, refOut });
    if (impact <= maxImpactBps) return { parts, part, impactBps: impact };
  }
  throw new RangeError(`even ${maxParts} parts move the price more than ${maxImpactBps} bps each: the pool is too shallow for this amount`);
}

// --- Non-urgent steps -------------------------------------------------------------------------------------------------

/**
 * Non-urgent steps wait a random delay of up to this much, so Ostra agents do not move together (design: "jeda acak
 * per agent"; the design gives no length: 30 minutes is short against a cash vault's daily yield and long against the
 * blocks other agents' runs land in). Urgent steps (the ladder, leaving a vault) never wait.
 */
export const JITTER_MAX_SECONDS = 1_800;
