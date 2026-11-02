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

/** A reference quote's output is at least this many base units, so its rounding stays under 1 bps of the price it gives. */
export const IMPACT_REF_MIN_OUT = 10_000n;

/**
 * The small quote a larger one's impact is measured against: 1/1000 of `amount` (at least 1 unit), ten times larger
 * while its output is under IMPACT_REF_MIN_OUT units or it cannot be quoted (an output that rounds to nothing), up to
 * 1/10 of `amount`.
 */
export async function referenceQuote(amount: bigint, quote: (amountIn: bigint) => Promise<bigint>): Promise<{ refIn: bigint; refOut: bigint }> {
  if (amount <= 0n) throw new RangeError("amount must be positive");
  const top = amount / 10n > 0n ? amount / 10n : 1n;
  let refIn = amount / 1_000n > 0n ? amount / 1_000n : 1n;
  for (;;) {
    let refOut: bigint | null = null;
    let failure: unknown = null;
    try {
      refOut = await quote(refIn);
    } catch (e) {
      failure = e;
    }
    if (refOut !== null && (refOut >= IMPACT_REF_MIN_OUT || refIn >= top)) return { refIn, refOut };
    if (refIn >= top) throw failure;
    refIn = refIn * 10n > top ? top : refIn * 10n;
  }
}

/**
 * Splits `amount` into equal parts so that each part's quote stays within `maxImpactBps` (design: "Swap besar dipecah
 * menurut dampak harga dari quote, dengan batas dampak per bagian"). `quote(part)` returns the output of one part; the
 * parts double until one part is within the limit, at most `maxParts`. `reference(part)` gives the small quote a part
 * is measured against (default: referenceQuote over `quote`; a caller whose best route changes with the amount gives
 * the better of the small quote and the part's own route at that size). `wholeImpactBps`: the impact of `amount` in one
 * swap. Parts trade one after another, so each sees the price the previous one left: the parts are spaced by the caller.
 */
export async function splitByImpact(
  amount: bigint,
  maxImpactBps: bigint,
  quote: (amountIn: bigint) => Promise<bigint>,
  maxParts = 16,
  reference: (part: bigint) => Promise<{ refIn: bigint; refOut: bigint }> = (part) => referenceQuote(part, quote),
): Promise<{ parts: number; part: bigint; impactBps: bigint; wholeImpactBps: bigint }> {
  if (amount <= 0n) throw new RangeError("amount must be positive");
  let whole: bigint | null = null;
  for (let parts = 1; parts <= maxParts; parts *= 2) {
    const part = amount / BigInt(parts);
    if (part === 0n) break;
    const impact = impactBps({ amount: part, out: await quote(part), ...(await reference(part)) });
    whole ??= impact;
    if (impact <= maxImpactBps) return { parts, part, impactBps: impact, wholeImpactBps: whole };
  }
  throw new RangeError(`even ${maxParts} parts move the price more than ${maxImpactBps} bps each: the pool is too shallow for this amount`);
}

/**
 * The largest amount up to `upper` whose price impact (`impact(amount)`, bps) is at most `maxBps`: bisection to
 * `resolution` (default 1/1000 of `upper`).
 */
export async function impactLimitedSize(upper: bigint, maxBps: bigint, impact: (amount: bigint) => Promise<bigint>, resolution?: bigint): Promise<bigint> {
  if (upper <= 0n) return 0n;
  const step = resolution ?? (upper / 1_000n > 0n ? upper / 1_000n : 1n);
  if ((await impact(upper)) <= maxBps) return upper;
  let lo = 0n;
  let hi = upper;
  while (hi - lo > step) {
    const mid = (lo + hi) / 2n;
    if ((await impact(mid)) <= maxBps) lo = mid;
    else hi = mid;
  }
  return lo;
}

// --- Non-urgent steps -------------------------------------------------------------------------------------------------

/**
 * Non-urgent steps wait a random delay of up to this much, so Ostra agents do not move together (design: "jeda acak
 * per agent"; the design gives no length: 30 minutes is short against a cash vault's daily yield and long against the
 * blocks other agents' runs land in). Urgent steps (the ladder, leaving a vault) never wait.
 */
export const JITTER_MAX_SECONDS = 1_800;

// --- The treasury of a version 4 USDG vault ------------------------------------------------------------------------------
//
// The design's "v4 off chain: the treasury engine in MCP" (approved by Edu on 1 Nov 2026): the tiers of a USDG vault
// (cash idle in the vault, Spark the liquid tier, Steakhouse the core, Raeto USDG the owner's AI budget), break-even
// first, the lower of the 7-day and 30-day realized rates, the caps, no churn, and no automatic exit at a loss.

/**
 * The cash tier: the next CASH_DAYS days of payments at the rate the vault paid over the last PAYMENT_WINDOW (the
 * design's worked example: 20 USDG for 200 USDG a month), at least CASH_MIN (1 USDG).
 */
export const CASH_DAYS = 3n;
export const PAYMENT_WINDOW = 30n * DAY;
export const CASH_MIN = 1_000_000n;
/** The two windows a realized rate is read over: the rate used is the lower of the two, never an advertised APY. */
export const REALIZED_SHORT = 7n * DAY;
export const REALIZED_LONG = 30n * DAY;
/** Core moves between Steakhouse and Spark only when their 7-day realized rates are 0.25 points or more apart. */
export const CORE_MOVE_MIN_GAP = WAD / 400n;
/** Steakhouse at most 1% of its assets. */
export const STEAKHOUSE_MAX_OF_ASSETS_BPS = 100n;
/** Spark at most half of the earning money (while Steakhouse holds the core). */
export const SPARK_MAX_OF_EARNING_BPS = 5_000n;
/** Raeto USDG at most 5% of the Raeto vault's principal (its other holders' principal). */
export const RAETO_MAX_OF_PRINCIPAL_BPS = 500n;
/** Any position at most half of what its venue can pay out now. */
export const POSITION_MAX_OF_PAYOUT_BPS = 5_000n;
/** RaetoVault's and RaetoStockVault's accumulator scale (their ACC_SCALE). */
export const RAETO_ACC_SCALE = 10n ** 36n;

/** The cash tier for `paid30` USDG paid over the last PAYMENT_WINDOW: CASH_DAYS days of it, at least CASH_MIN. */
export function cashTier(paid30: bigint): bigint {
  const t = (paid30 * CASH_DAYS * DAY) / PAYMENT_WINDOW;
  return t > CASH_MIN ? t : CASH_MIN;
}

/** A share price's growth from `then` to `now` over `seconds`, per year (WAD, simple; below zero for a loss); null when it cannot be told. */
export function growthRate(then: bigint, now: bigint, seconds: bigint): bigint | null {
  if (then <= 0n || seconds <= 0n) return null;
  return ((now - then) * WAD * YEAR) / (then * seconds);
}

/** A Raeto accumulator's rise (accPerPrincipal or accPerShare, at RAETO_ACC_SCALE) over `seconds`, per unit per year (WAD); null when it cannot be told. */
export function accRate(then: bigint, now: bigint, seconds: bigint): bigint | null {
  if (seconds <= 0n || now < then) return null;
  return ((now - then) * WAD * YEAR) / (RAETO_ACC_SCALE * seconds);
}

/** The rate used: the lower of the 7-day and the 30-day realized rate; null unless both are known. */
export function lowerRate(short: bigint | null, long: bigint | null): bigint | null {
  if (short === null || long === null) return null;
  return short < long ? short : long;
}

/** Whether `amount` at `rate` pays three round trips of `roundTrip` within 30 days (worthIt over STEP_HORIZON). */
export function pays(amount: bigint, rate: bigint | null, roundTrip: bigint): boolean {
  return rate !== null && rate > 0n && worthIt(yieldOver(amount, rate, STEP_HORIZON), roundTrip);
}

/** The break-even: the least amount that pays three round trips of `roundTrip` within 30 days at `rate`; null when no amount does. */
export function breakEven(rate: bigint | null, roundTrip: bigint): bigint | null {
  if (rate === null || rate <= 0n) return null;
  // yieldOver floors: floor(x * rate * H / (WAD * YEAR)) > 3 * roundTrip  <=>  x * rate * H >= (3 * roundTrip + 1) * WAD * YEAR.
  const need = (STEP_GAS_MULTIPLE * (roundTrip > 0n ? roundTrip : 0n) + 1n) * WAD * YEAR;
  const per = rate * STEP_HORIZON;
  return (need + per - 1n) / per;
}

/** The AI budget's principal: what earns `monthly` USDG of credits a month at `rate` (monthly x 12 / rate); 0 when off, null when the rate is not known. */
export function aiBudgetPrincipal(monthly: bigint, rate: bigint | null): bigint | null {
  if (monthly <= 0n) return 0n;
  if (rate === null || rate <= 0n) return null;
  return (monthly * 12n * WAD) / rate;
}

/** Half (POSITION_MAX_OF_PAYOUT_BPS) of what a venue can pay out now. */
export function payoutCap(payout: bigint): bigint {
  return payout > 0n ? (payout * POSITION_MAX_OF_PAYOUT_BPS) / BPS : 0n;
}

/**
 * Raeto USDG's cap: the smaller of the owner's budget principal and 5% of the Raeto vault's principal held by others
 * (its totalPrincipal less this vault's), and half of what it can pay out now. 0 while the budget is off. While the
 * budget's principal cannot be told (Raeto's realized rate not known or not positive: the venue is closed to new
 * money), what the vault holds stands in for it: the position is kept, within the other two caps, and not exited for a
 * rate that cannot be read (it would come back in later, paying a round trip for nothing).
 */
export function raetoCap(a: { budgetPrincipal: bigint | null; totalPrincipal: bigint; own: bigint; payout: bigint }): bigint {
  const budget = a.budgetPrincipal === null ? a.own : a.budgetPrincipal;
  if (budget <= 0n) return 0n;
  const others = a.totalPrincipal > a.own ? a.totalPrincipal - a.own : 0n;
  const byVenue = (others * RAETO_MAX_OF_PRINCIPAL_BPS) / BPS;
  const byPayout = payoutCap(a.payout);
  return [budget, byVenue, byPayout].reduce((x, y) => (x < y ? x : y));
}

/** Steakhouse's cap: 1% of its assets and half of what it can pay out now (and Ostra's 5% share limit, `room` over what is held). */
export function steakhouseCap(a: { assets: bigint; withdrawable: bigint; room: bigint; held: bigint }): bigint {
  const byAssets = (a.assets * STEAKHOUSE_MAX_OF_ASSETS_BPS) / BPS;
  const byPayout = payoutCap(a.withdrawable);
  const byShare = a.held + a.room;
  return [byAssets, byPayout, byShare].reduce((x, y) => (x < y ? x : y));
}

/**
 * How much more stock a vault may put into a Raeto stock vault: what the venue can pay out now is its collateral, all of
 * it while the USDG it can raise now (`usdgPayout`: its idle USDG and what its sink pays out) covers its loan, else that
 * share of it; the vault's position stays at most half of that, its own new stock counted (an Enter adds collateral with
 * no loan until Raeto's keeper borrows against it); and within the venue's deposit cap (`depositRoom`). Stock units.
 */
export function raetoStockRoom(a: { collateral: bigint; debt: bigint; usdgPayout: bigint; held: bigint; depositRoom: bigint }): bigint {
  const f = a.debt === 0n || a.usdgPayout >= a.debt ? WAD : (a.usdgPayout * WAD) / a.debt;
  // held + x <= (collateral + x) * f / 2  <=>  x * (2 - f) <= collateral * f - 2 * held
  const top = a.collateral * f - 2n * a.held * WAD;
  const room = top <= 0n ? 0n : top / (2n * WAD - f);
  return room < a.depositRoom ? room : a.depositRoom;
}

export type TreasuryVenueName = "spark" | "steakhouse" | "raeto_usdg";

/** What the planner read of one venue of a USDG vault. Amounts in USDG base units; rates per year, WAD. */
export type TreasuryVenue = {
  /** The rate used (the lower of the 7-day and 30-day realized rate; Raeto: the credits its principal earns); null: not known. */
  rate: bigint | null;
  /** The 7-day realized rate (the no-churn rule's); null: not known. */
  rate7: bigint | null;
  /** Today's price of one Enter (Lend) and one Exit (Redeem), the relayer's rule. */
  enterCost: bigint;
  exitCost: bigint;
  /** The most the vault may hold there now (every cap). */
  cap: bigint;
  /** What the vault holds there now. */
  held: bigint;
  /** Whether new money may go in (its checks pass, not in loss); `why` says why not. */
  open: boolean;
  why: string | null;
  /** Whether what is held may come out now without making a loss permanent (never on a venue in loss, without the owner). */
  exitable: boolean;
};

export type TreasuryInput = {
  /** USDG idle in the vault. */
  idle: bigint;
  /** USDG the vault paid over the last PAYMENT_WINDOW. */
  paid30: bigint;
  /** The owner's own cash to keep, in place of the cash tier. */
  cash?: bigint;
  /** The owner's monthly AI budget (USDG of Raeto credits a month; 0: off). */
  aiBudget: bigint;
  venues: Record<TreasuryVenueName, TreasuryVenue>;
};

export type TreasuryMove = { venue: TreasuryVenueName; side: "enter" | "exit"; amount: bigint; urgent: boolean; reason: string };

export type TreasuryPlan = {
  total: bigint;
  cash: bigint;
  earning: bigint;
  /** The tiers' targets: liquid (Spark), the AI budget (Raeto USDG), and the core with its venue. */
  liquid: bigint;
  ai: bigint;
  core: { venue: TreasuryVenueName | null; amount: bigint; reason: string };
  moves: TreasuryMove[];
  notes: string[];
};

const minOf = (...xs: bigint[]) => xs.reduce((x, y) => (x < y ? x : y));
const units = (x: bigint) => `${x < 0n ? "-" : ""}${(x < 0n ? -x : x) / 1_000_000n}.${((x < 0n ? -x : x) % 1_000_000n).toString().padStart(6, "0")}`;
const percent = (wad: bigint | null) => (wad === null ? "not known" : `${Number((wad * 1_000_000n) / WAD) / 10_000}%`);

/**
 * The core's venue for `amount`: Steakhouse when it pays its own break-even and its extra yield over Spark pays its
 * dearer refills (30 days of the gap against three times the difference of their round trips), else Spark when Spark
 * pays its break-even, else none (the money stays idle).
 */
export function coreVenue(amount: bigint, steak: TreasuryVenue, spark: TreasuryVenue): { venue: TreasuryVenueName | null; reason: string } {
  const sparkRt = spark.enterCost + spark.exitCost;
  const steakRt = steak.enterCost + steak.exitCost;
  const sparkPays = spark.open && pays(amount, spark.rate, sparkRt);
  if (steak.open && pays(amount, steak.rate, steakRt) && steak.rate !== null) {
    const gap = spark.rate === null ? steak.rate : steak.rate - spark.rate;
    const dearer = steakRt > sparkRt ? steakRt - sparkRt : 0n;
    if (!sparkPays || (gap > 0n && worthIt(yieldOver(amount, gap, STEP_HORIZON), dearer))) {
      return { venue: "steakhouse", reason: `Steakhouse at ${percent(steak.rate)} against Spark at ${percent(spark.rate)}: 30 days of the gap on ${units(amount)} USDG pays three times the ${units(dearer)} USDG its round trip costs more` };
    }
    if (sparkPays) return { venue: "spark", reason: `Steakhouse's extra yield over Spark (${percent(steak.rate)} against ${percent(spark.rate)}) on ${units(amount)} USDG does not pay three times the ${units(dearer)} USDG its round trip costs more: the earning money stays in Spark` };
  }
  if (sparkPays) return { venue: "spark", reason: steak.open ? `Steakhouse at ${percent(steak.rate)} does not pay its break-even on ${units(amount)} USDG: Spark at ${percent(spark.rate)} does, and the earning money stays in Spark` : `Steakhouse takes no deposit now (${steak.why ?? "closed"}): Spark at ${percent(spark.rate)}, within half of the earning money` };
  return { venue: null, reason: `neither Steakhouse nor Spark pays three round trips within 30 days on ${units(amount)} USDG: it stays idle` };
}

/**
 * The no-churn rule: core held in one venue moves to the other only when the other's 7-day realized rate is
 * CORE_MOVE_MIN_GAP (0.25 points) or more above it, and 30 days of that gap on `amount` pays three times the move's
 * cost (an exit from one and an enter into the other). The design's "the gap held 0.25 points or more for 7 days" is
 * read as the gap of the two venues' realized growth over the same 7 days (each from its last event at or before the
 * window's start: Spark's rate accumulator, Steakhouse's share price at its last Deposit; venues.ts realized), not as
 * the gap at each moment of the week, which the chain does not record (the rates between events are not stored).
 */
export function coreMoves(a: { amount: bigint; from7: bigint | null; to7: bigint | null; moveCost: bigint }): { ok: boolean; reason: string } {
  if (a.from7 === null || a.to7 === null) return { ok: false, reason: "a 7-day realized rate is not known" };
  const gap = a.to7 - a.from7;
  if (gap < CORE_MOVE_MIN_GAP) return { ok: false, reason: `the 7-day gap is ${percent(gap)}, under 0.25 points` };
  if (!worthIt(yieldOver(a.amount, gap, STEP_HORIZON), a.moveCost)) return { ok: false, reason: `30 days of the ${percent(gap)} gap on ${units(a.amount)} USDG does not pay three times the move's ${units(a.moveCost)} USDG` };
  return { ok: true, reason: `the 7-day gap of ${percent(gap)} pays three times the move's ${units(a.moveCost)} USDG within 30 days` };
}

/**
 * The treasury's moves for a USDG vault, in the order they run:
 *   1. exits a cap or the owner's settings call for (a position over its cap, the AI budget turned off), never from a
 *      venue in loss;
 *   2. the cash tier refilled when the idle USDG is under it: from Spark first, then Steakhouse (never from the AI
 *      budget);
 *   3. the core moved between Steakhouse and Spark only under the no-churn rule;
 *   4. the money idle over the cash tier placed: the liquid tier (Spark, the next 30 days of payments, at most half of
 *      the earning money), the AI budget (Raeto USDG, opt-in), then the core (coreVenue; beyond Steakhouse's cap, Spark
 *      within its caps), each only once it pays its break-even (otherwise it stays idle and a note says so).
 */
export function treasuryMoves(t: TreasuryInput): TreasuryPlan {
  const v = t.venues;
  const held = { spark: v.spark.held, steakhouse: v.steakhouse.held, raeto_usdg: v.raeto_usdg.held };
  const total = t.idle + held.spark + held.steakhouse + held.raeto_usdg;
  const cash = t.cash ?? cashTier(t.paid30);
  const earning = total > cash ? total - cash : 0n;
  const moves: TreasuryMove[] = [];
  const notes: string[] = [];
  let idle = t.idle;
  const name: Record<TreasuryVenueName, string> = { spark: "Spark", steakhouse: "Steakhouse", raeto_usdg: "Raeto USDG" };
  const exit = (venue: TreasuryVenueName, amount: bigint, urgent: boolean, reason: string): bigint => {
    const x = v[venue];
    const take = minOf(amount, held[venue]);
    if (take <= 0n) return 0n;
    if (!x.exitable) {
      notes.push(`${name[venue]}: ${reason}, but it reports a loss: no automatic exit (the owner decides, venue_exit)`);
      return 0n;
    }
    moves.push({ venue, side: "exit", amount: take, urgent, reason });
    held[venue] -= take;
    idle += take;
    return take;
  };
  // 1. Caps and the owner's settings.
  if (t.aiBudget === 0n && held.raeto_usdg > 0n) exit("raeto_usdg", held.raeto_usdg, false, "the AI budget is off: its principal comes back");
  for (const venue of ["spark", "steakhouse", "raeto_usdg"] as const) {
    const over = held[venue] - v[venue].cap;
    if (over <= 0n) continue;
    if (over <= v[venue].exitCost) {
      notes.push(`${name[venue]} holds ${units(over)} USDG over its cap of ${units(v[venue].cap)}, no more than its exit costs (${units(v[venue].exitCost)}): kept`);
      continue;
    }
    exit(venue, over, false, `${units(held[venue])} USDG held, over its cap of ${units(v[venue].cap)}`);
  }
  // 2. The cash tier.
  // A shortfall no larger than a Spark exit costs (the fees of the spends that placed the money) waits for the next
  // earnings: an exit for it would cost more than it brings.
  if (idle < cash && cash - idle <= v.spark.exitCost) {
    notes.push(`the cash is ${units(idle)} USDG, ${units(cash - idle)} under the cash tier of ${units(cash)}, no more than a Spark exit costs (${units(v.spark.exitCost)}): no refill`);
  } else if (idle < cash) {
    let short = cash - idle;
    short -= exit("spark", short, true, `the cash is ${units(idle)} USDG, under the cash tier of ${units(cash)}: refilled from Spark`);
    if (short > 0n) exit("steakhouse", short, true, `the cash is under the cash tier of ${units(cash)} and Spark holds too little: the rest from Steakhouse`);
  }
  // The tiers' targets.
  const liquid = v.spark.open ? minOf(t.paid30, (earning * SPARK_MAX_OF_EARNING_BPS) / BPS, v.spark.cap) : 0n;
  const ai = t.aiBudget > 0n && v.raeto_usdg.open ? minOf(v.raeto_usdg.cap, earning > liquid ? earning - liquid : 0n) : 0n;
  const coreAmount = earning > liquid + ai ? earning - liquid - ai : 0n;
  const core = coreVenue(coreAmount, v.steakhouse, v.spark);
  // 3. No churn: the core held where the rule no longer puts it moves only when the gap held and pays.
  const sparkCore = held.spark > liquid ? held.spark - liquid : 0n;
  if (core.venue === "spark" && v.steakhouse.open && held.steakhouse > 0n) {
    const m = coreMoves({ amount: held.steakhouse, from7: v.steakhouse.rate7, to7: v.spark.rate7, moveCost: v.steakhouse.exitCost + v.spark.enterCost });
    if (m.ok) exit("steakhouse", held.steakhouse, false, `the core moves to Spark: ${m.reason}`);
    else notes.push(`the core stays in Steakhouse (${units(held.steakhouse)} USDG): ${m.reason}`);
  } else if (core.venue === "steakhouse" && sparkCore > 0n) {
    const m = coreMoves({ amount: sparkCore, from7: v.spark.rate7, to7: v.steakhouse.rate7, moveCost: v.spark.exitCost + v.steakhouse.enterCost });
    if (m.ok) exit("spark", sparkCore, false, `the core moves to Steakhouse: ${m.reason}`);
    else notes.push(`the core in Spark (${units(sparkCore)} USDG over the liquid tier) stays: ${m.reason}`);
  }
  // 4. The money idle over the cash tier.
  let free = idle > cash ? idle - cash : 0n;
  const enter = (venue: TreasuryVenueName, want: bigint, why: string) => {
    const x = v[venue];
    const amount = minOf(want, free, x.cap > held[venue] ? x.cap - held[venue] : 0n);
    if (amount <= 0n) return;
    if (!x.open) {
      notes.push(`${name[venue]} takes no deposit now (${x.why ?? "closed"}): ${units(amount)} USDG stays idle`);
      return;
    }
    const be = breakEven(x.rate, x.enterCost + x.exitCost);
    if (!pays(amount, x.rate, x.enterCost + x.exitCost)) {
      notes.push(`${units(amount)} USDG for ${name[venue]} (${why}) is under its break-even of ${be === null ? "any amount (its rate is not known or not positive)" : `${units(be)} USDG`} at today's gas (a round trip ${units(x.enterCost + x.exitCost)} USDG, ${percent(x.rate)} a year): it stays idle`);
      return;
    }
    moves.push({ venue, side: "enter", amount, urgent: false, reason: `${units(amount)} USDG into ${name[venue]} (${why}) at ${percent(x.rate)} a year: over its break-even of ${units(be as bigint)} USDG (three round trips of ${units(x.enterCost + x.exitCost)} within 30 days)` });
    held[venue] += amount;
    free -= amount;
  };
  if (liquid > held.spark) enter("spark", liquid - held.spark, `the liquid tier: ${units(liquid)} USDG, the next 30 days of payments, at most half of the earning money`);
  if (ai > held.raeto_usdg) enter("raeto_usdg", ai - held.raeto_usdg, `the AI budget: its principal ${units(ai)} USDG within its caps`);
  if (core.venue === "steakhouse") {
    const want = coreAmount > held.steakhouse ? coreAmount - held.steakhouse : 0n;
    const room = v.steakhouse.cap > held.steakhouse ? v.steakhouse.cap - held.steakhouse : 0n;
    enter("steakhouse", want < room ? want : room, `the core: ${core.reason}`);
    // Beyond Steakhouse's cap: Spark, within its own caps (half of the earning money, half of what it pays out).
    const sparkMax = minOf((earning * SPARK_MAX_OF_EARNING_BPS) / BPS, v.spark.cap);
    if (want > room && sparkMax > held.spark) enter("spark", minOf(want - room, sparkMax - held.spark), `the core beyond Steakhouse's cap of ${units(v.steakhouse.cap)} USDG`);
  } else if (core.venue === "spark" && v.steakhouse.open) {
    // Steakhouse's extra yield does not pay its dearer refills (a small vault): the earning money stays in Spark, all of
    // it, above Spark's cap of half the earning money. The design states this exception itself ("Exit costs count in
    // the choice: ... the earning money stays in Spark"); the half cap holds otherwise.
    enter("spark", free, `the core: ${core.reason} (the design's exception for a small vault: Spark then holds more than half of the earning money)`);
  } else if (core.venue === "spark") {
    // Steakhouse closed: Spark keeps its own cap of half the earning money, and the rest of the core waits idle.
    const sparkMax = minOf((earning * SPARK_MAX_OF_EARNING_BPS) / BPS, v.spark.cap);
    const want = sparkMax > held.spark ? sparkMax - held.spark : 0n;
    enter("spark", want, `the core: ${core.reason}`);
    if (free > 0n) notes.push(`the core: ${units(free)} USDG stays idle while Steakhouse takes no deposit (${v.steakhouse.why ?? "closed"}): Spark holds at most half of the earning money (${units((earning * SPARK_MAX_OF_EARNING_BPS) / BPS)} USDG)`);
  } else if (coreAmount > 0n) notes.push(`the core: ${core.reason}`);
  if (free > 0n) notes.push(`${units(free)} USDG over the cash tier stays idle (under every break-even or cap now); it is placed on a later check once it pays`);
  return { total, cash, earning, liquid, ai, core: { venue: core.venue, amount: coreAmount, reason: core.reason }, moves, notes };
}
