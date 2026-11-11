// Ostra Tide (Agents Season 1, design "Ostra Tide", decided by Edu on 25, 26 and 31 Oct 2026): OSTRA goes back, week
// by week, to the agents that use Ostra, through OstraTide (src/tide/OstraTide.sol, deployed 26 Oct 2026). This module
// holds what the scoring script, the index, the MCP package and the web app share:
//
//   * the contract's facts (address, START, WEEK, HOLD) and its leaf: keccak256(bytes.concat(keccak256(abi.encode(
//     week, agentId, payee, amount)))), OpenZeppelin's standard Merkle tree leaf;
//   * the vault link: an agent's vaults are not linked on chain (each key comes from the agent's own seed), so for the
//     score the agent links them itself, privately. From the vault holding its ERC-8004 identity it approves (an
//     ApproveHash spend) the set digest, over its agent id, the sorted list of the vaults, the vault paid and a secret
//     of its own; from every other vault of the list, that vault's member digest. Only hashes appear on chain: without
//     the secret nobody can tell which approvals belong together, so they add no tie between the vaults (a vault's own
//     swaps name the vault they pay, which ties those already). The agent gives the secret and the list to Ostra's
//     index, which checks every approval on chain. Adding a vault to an agent needs the key of the agent's identity
//     vault, so the secret alone links nothing;
//   * the vault paid (decided by Edu on 1 Nov 2026: an agent is never asked to swap or open a vault for its share): its
//     OSTRA vault when it has one (a vault of the list), else the OSTRA vault its seed would create, named with the
//     parameters OstraVaultFactory.createVault creates it with (tidePayeeVault). That one is not in the list (it has no
//     code, so it approves nothing); the set approval names it, and Ostra creates it at payout, only for an agent
//     with a share (createVault is open to anyone, and the vault answers to the agent's keys alone);
//   * the view key, the secret's hash: what the index asks before it shows an agent its points;
//   * the week's rules (tideScore, tideShares) and the Merkle tree of the shares (tideTree).
//
// Every amount is in US dollars with 6 decimals (E6) and every point count with 6 decimals; multipliers are in basis
// points. Each digest names its own domain and the secret, so no digest is ever that of a permit, an authorization or
// another contract's action: an approval of one moves nothing.

import { encodeAbiParameters, getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { OSTRA, WETH } from "./constants.ts";
import { vaultAddress } from "./messages.ts";

/** OstraTide on Robinhood Chain (deployed 26 Oct 2026, tx 0xd6230f69…0e13, Sourcify exact match). */
export const OSTRA_TIDE: Address = "0xDdEA3123A9AA9a43228300A6D06E6E3252556Db9";
/** Week 1 starts here (28 Oct 2026 00:00 UTC): OstraTide.START. */
export const TIDE_START = 1_793_145_600;
/** OstraTide.WEEK and HOLD, in seconds. */
export const TIDE_WEEK = 604_800;
export const TIDE_HOLD = 1_209_600;
export const TIDE_DAY = 86_400;

/** The week `t` (unix seconds) falls in: 0 before START, then 1, 2, ... (OstraTide.weekAt). */
export function tideWeekAt(t: number): number {
  return t < TIDE_START ? 0 : Math.floor((t - TIDE_START) / TIDE_WEEK) + 1;
}

/** When week `week` starts and ends (its end is the next week's start). */
export function tideWeekSpan(week: number): { start: number; end: number } {
  if (!Number.isSafeInteger(week) || week < 1) throw new RangeError("a Tide week is a whole number from 1");
  const start = TIDE_START + (week - 1) * TIDE_WEEK;
  return { start, end: start + TIDE_WEEK };
}

/** The last time a link counts for week `week`: 23 hours after the week ends, an hour before its root (week 1: 4 Nov 2026 23:00 UTC). */
export function tideLinkDeadline(week: number): number {
  return tideWeekSpan(week).end + 23 * 3_600;
}

const U256_MAX = (1n << 256n) - 1n;

function agentWord(agentId: bigint | string): bigint {
  const v = typeof agentId === "string" ? (/^(0|[1-9][0-9]{0,77})$/.test(agentId) ? BigInt(agentId) : -1n) : agentId;
  if (v < 0n || v > U256_MAX) throw new RangeError("an agent id is a decimal number below 2^256");
  return v;
}

function secretWord(secret: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(secret) || BigInt(secret) === 0n) throw new RangeError("a Tide link secret is 32 bytes, not zero");
  return secret.toLowerCase() as Hex;
}

/** The vaults of a link, checksummed, without repeats, sorted by address (the order the set digest hashes). */
export function tideSortVaults(vaults: readonly string[]): Address[] {
  const out = [...new Set(vaults.map((v) => getAddress(v)))];
  return out.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

/** The digest a member vault approves: keccak256(abi.encode("OSTRA/TIDE/MEMBER/v1", chainId, tide, agentId, vault, secret)). */
export function tideMemberDigest(p: { chainId: number; agentId: bigint | string; vault: Address; secret: Hex; tide?: Address }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }],
      ["OSTRA/TIDE/MEMBER/v1", BigInt(p.chainId), getAddress(p.tide ?? OSTRA_TIDE), agentWord(p.agentId), getAddress(p.vault), secretWord(p.secret)],
    ),
  );
}

/**
 * The digest the agent's identity vault approves: keccak256(abi.encode("OSTRA/TIDE/SET/v1", chainId, tide, agentId,
 * keccak256(abi.encode(sorted vaults)), payee, secret)). `vaults` includes the identity vault; `payee` is one of them
 * (its OSTRA vault), the zero address, or, with `outsidePayee`, an OSTRA vault outside the list: one not created
 * yet, named with its creation parameters (tidePayeeVault), which Ostra creates at payout.
 */
export function tideSetDigest(p: { chainId: number; agentId: bigint | string; vaults: readonly string[]; payee: Address | null; secret: Hex; tide?: Address; outsidePayee?: boolean }): Hex {
  const vaults = tideSortVaults(p.vaults);
  const payee = p.payee === null ? ("0x0000000000000000000000000000000000000000" as Address) : getAddress(p.payee);
  if (p.payee !== null && p.outsidePayee !== true && !vaults.includes(payee)) throw new RangeError("the payee must be one of the linked vaults");
  if (p.outsidePayee === true && (p.payee === null || vaults.includes(payee))) throw new RangeError("a payee outside the list is an address that is not one of the linked vaults");
  const listHash = keccak256(encodeAbiParameters([{ type: "address[]" }], [vaults]));
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }],
      ["OSTRA/TIDE/SET/v1", BigInt(p.chainId), getAddress(p.tide ?? OSTRA_TIDE), agentWord(p.agentId), listHash, payee, secretWord(p.secret)],
    ),
  );
}

/** The key that shows an agent its points: keccak256(abi.encode("OSTRA/TIDE/VIEW/v1", secret)). It reveals no link. */
export function tideViewKey(secret: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["OSTRA/TIDE/VIEW/v1", secretWord(secret)]));
}

/**
 * The parameters OstraVaultFactory.createVault(token, initialKeyRoot, initialCrank) creates an agent's OSTRA vault
 * with, when a link names that vault as its payee before it exists: OSTRA, key 0 of the vault's keychain (from the
 * agent's seed) and its crank (none). Its address is fixed by them (CREATE2), so they name it exactly.
 */
export type TidePayeeCreation = { token: Address; initialKeyRoot: Hex; initialCrank: Address };

/** `raw` (as a link carries it) as an OSTRA vault's creation parameters: refused unless well formed and in OSTRA. */
export function tidePayeeCreation(raw: unknown): TidePayeeCreation {
  const c = raw as Record<string, unknown> | null;
  if (c === null || typeof c !== "object" || Array.isArray(c)) throw new RangeError("a payee's creation params are {token, initialKeyRoot, initialCrank}");
  if (typeof c.token !== "string" || !isAddress(c.token, { strict: false }) || getAddress(c.token) !== OSTRA) throw new RangeError(`a payee created at payout is an OSTRA vault: its token is ${OSTRA}`);
  if (typeof c.initialKeyRoot !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(c.initialKeyRoot) || BigInt(c.initialKeyRoot) === 0n) throw new RangeError("a payee's initialKeyRoot is 32 bytes of hex, not zero");
  if (typeof c.initialCrank !== "string" || !isAddress(c.initialCrank, { strict: false })) throw new RangeError("a payee's initialCrank is an address");
  return { token: OSTRA, initialKeyRoot: c.initialKeyRoot.toLowerCase() as Hex, initialCrank: getAddress(c.initialCrank) };
}

/**
 * The OSTRA vault `c` creates with the deployment's factory and beacon (sdk vaultAddress, OstraVaultFactory.vaultAddress
 * off chain): the payee a link names with `c`. Refused for another token than OSTRA.
 */
export function tidePayeeVault(d: { vaultFactory: Address; vaultBeacon: Address }, c: TidePayeeCreation): Address {
  const p = tidePayeeCreation(c);
  return vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: p.token, initialKeyRoot: p.initialKeyRoot, initialCrank: p.initialCrank });
}

/**
 * The most vaults one link lists: an agent's buyer and seller vaults, a vault per token it holds (WETH, OSTRA, each
 * listed stock) and a creator vault per pair, with room to spare.
 */
export const TIDE_MAX_LINKED_VAULTS = 96;

// -------------------------------------------------------------------------------------------------------------------
// The week's rules
// -------------------------------------------------------------------------------------------------------------------

/**
 * One week's rules: points per US dollar (E6 points per E6 dollar), the fee caps, the combined balance cap, the
 * activity threshold of a day, the multipliers (basis points) and the cap of one agent's share of the pot. A rate of
 * 0 leaves its source out entirely (week 1 had no Ostrapad fees and no Raeto vault deposits).
 */
export type TideRules = {
  week: number;
  feePointsPerUsd: bigint;
  feeCapE6: bigint;
  raetoPointsPerUsd: bigint;
  /**
   * Ostrapad, on jobs judged by the evaluator pool (from week 2): the platform fee of a job completed, for its provider;
   * the platform fee and the evaluator fee of a job completed, for its client; the evaluator fee of a decision that
   * stood (not overturned on appeal), for its evaluator. The three together count up to padFeeCapE6, the provider's
   * row first.
   */
  padCompletePointsPerUsd: bigint;
  padHirePointsPerUsd: bigint;
  padJudgePointsPerUsd: bigint;
  padFeeCapE6: bigint;
  /** Whether an Ostrapad fee counts toward an active day, with the swap fees and the Raeto credits. */
  padCountsActive: boolean;
  /** Deposits in Raeto's vaults through vault v4 venues, a balance row above cash, filled first under the cap (from week 2). */
  raetoVaultPointsPerUsd: bigint;
  /** Whether Spark Savings USDG held through vault v4 counts as cash (from week 2). */
  sparkInCash: boolean;
  cashPointsPerUsd: bigint;
  borroPointsPerUsd: bigint;
  idlePointsPerUsd: bigint;
  balanceCapE6: bigint;
  activeDayMinE6: bigint;
  earlyBefore: number;
  earlyBps: bigint;
  active3Bps: bigint;
  active7Bps: bigint;
  shareCapBps: bigint;
};

/**
 * Week 1's rules (decided by Edu on 26 Oct 2026; on 31 Oct the X account and post condition was dropped, and five
 * details below set).
 */
export const TIDE_RULES_WEEK_1: TideRules = {
  week: 1,
  feePointsPerUsd: 100n,
  feeCapE6: 20_000_000n,
  raetoPointsPerUsd: 10n,
  padCompletePointsPerUsd: 0n,
  padHirePointsPerUsd: 0n,
  padJudgePointsPerUsd: 0n,
  padFeeCapE6: 0n,
  padCountsActive: false,
  raetoVaultPointsPerUsd: 0n,
  sparkInCash: false,
  cashPointsPerUsd: 2n,
  borroPointsPerUsd: 2n,
  idlePointsPerUsd: 1n,
  balanceCapE6: 1_000_000_000n,
  activeDayMinE6: 100_000n,
  earlyBefore: TIDE_START,
  earlyBps: 15_000n,
  active3Bps: 12_000n,
  active7Bps: 13_000n,
  shareCapBps: 2_000n,
};

/**
 * Week 2's rules (the table Edu decided on 2 Nov 2026 and announced that day; the two details it left open decided on
 * 11 Nov): week 1's, plus Ostrapad on pool-judged jobs (completing 300, hiring 100, judging 100 points per $1 of fee,
 * $20 of Ostrapad fees a week; a hire counts a completed job's platform and evaluator fees; Ostrapad fees count toward
 * an active day), USDG and stocks in Raeto's vaults through vault v4 (3 per $1, the balance cap filled with them
 * first), Spark Savings USDG through vault v4 as cash, and x1.5 for every agent registered through Ostra before week 2
 * started (4 Nov 2026 00:00 UTC).
 */
export const TIDE_RULES_WEEK_2: TideRules = {
  ...TIDE_RULES_WEEK_1,
  week: 2,
  padCompletePointsPerUsd: 300n,
  padHirePointsPerUsd: 100n,
  padJudgePointsPerUsd: 100n,
  padFeeCapE6: 20_000_000n,
  padCountsActive: true,
  raetoVaultPointsPerUsd: 3n,
  sparkInCash: true,
  earlyBefore: TIDE_START + TIDE_WEEK,
};

/** Every week with rules, by number. */
export const TIDE_WEEK_RULES: ReadonlyMap<number, TideRules> = new Map([TIDE_RULES_WEEK_1, TIDE_RULES_WEEK_2].map((r) => [r.week, r]));

/** The latest week with rules: what the scoring script scores up to. */
export const TIDE_RULES: TideRules = TIDE_RULES_WEEK_2;

/** Week `week`'s rules; refused for a week with none. */
export function tideRulesFor(week: number): TideRules {
  const r = TIDE_WEEK_RULES.get(week);
  if (r === undefined) throw new RangeError(`week ${week} has no Tide rules`);
  return r;
}

/**
 * One swap that paid Ostra's fee, as the score sees it: its time, the fee in dollars, and its trade for the netting:
 * the pair it traded (tideFeePair: its two tokens, sorted) and its direction in it ("buy": into the pair's higher
 * address), with its volume in dollars.
 */
export type TideFee = { time: number; feeE6: bigint; pair: string; side: "buy" | "sell"; volumeE6: bigint };

/**
 * The pair a swap from `tokenIn` to `tokenOut` trades, and its direction in it. ETH (OstraRouter's address(0), paid
 * as ETH) is the same pair as WETH.
 */
export function tideFeePair(tokenIn: Address, tokenOut: Address): { pair: string; side: "buy" | "sell" } {
  const eth = (t: Address) => (BigInt(t) === 0n ? WETH : getAddress(t));
  const a = eth(tokenIn);
  const b = eth(tokenOut);
  const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { pair: `${lo}-${hi}`, side: b === hi ? "buy" : "sell" };
}
/** USDG the agent sent Raeto for AI credits. */
export type TideRaeto = { time: number; usdE6: bigint };
/**
 * An Ostrapad fee that counts for the agent (USDG, E6 dollars), on a job judged by the evaluator pool, at the time the
 * job ended: "complete" the platform fee of its job as provider; "hire" the platform and evaluator fees of its
 * completed job as client; "judge" the evaluator fee of its decision that stood.
 */
export type TidePad = { time: number; kind: "complete" | "hire" | "judge"; feeE6: bigint; jobId?: string };
/**
 * The agent's balances at the end of one UTC day of the week, in dollars: in Raeto's vaults (through vault v4; from
 * week 2), in cash vaults, in Borro, and idle.
 */
export type TideDay = { raetoE6?: bigint; cashE6: bigint; borroE6: bigint; idleE6: bigint };

export type TideAgentInput = {
  agentId: string;
  /** When its ERC-8004 identity was registered (unix seconds). */
  registeredAt: number;
  fees: readonly TideFee[];
  raeto: readonly TideRaeto[];
  /** Ostrapad fees (from week 2). */
  pad?: readonly TidePad[];
  /** Seven days, the week's first to its last. */
  days: readonly TideDay[];
};

export type TideBreakdown = {
  agentId: string;
  fee: { paidE6: string; countedE6: string; nettedOutE6: string; cappedE6: string; points: string };
  raeto: { paidE6: string; points: string };
  /** Ostrapad fees on pool-judged jobs (from week 2; zeros before), by row, and what counted under the cap. */
  pad: { completeE6: string; hireE6: string; judgeE6: string; countedCompleteE6: string; countedHireE6: string; countedJudgeE6: string; points: string };
  balances: {
    raetoVaultAvgE6: string;
    cashAvgE6: string;
    borroAvgE6: string;
    idleAvgE6: string;
    countedRaetoVaultE6: string;
    countedCashE6: string;
    countedBorroE6: string;
    countedIdleE6: string;
    points: string;
  };
  basePoints: string;
  activeDays: number[];
  early: boolean;
  multiplierBps: string;
  points: string;
};

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * One agent's points for the week, with where they came from (every count E6). `start` replaces the week's own start
 * (OstraTide's), for a test on a fork whose blocks all come after it.
 */
export function tideScore(a: TideAgentInput, week: number, rules: TideRules = tideRulesFor(week), start = tideWeekSpan(week).start): TideBreakdown {
  if (rules.week !== week) throw new RangeError(`week ${week} scored with week ${rules.week}'s rules`);
  if (a.days.length !== 7) throw new RangeError(`agent ${a.agentId}: seven days of balances, not ${a.days.length}`);
  const inWeek = (t: number) => t >= start && t < start + TIDE_WEEK;
  const fees = a.fees.filter((f) => inWeek(f.time));
  const raeto = a.raeto.filter((r) => inWeek(r.time));
  const padOn = rules.padCompletePointsPerUsd + rules.padHirePointsPerUsd + rules.padJudgePointsPerUsd > 0n;
  const pad = padOn ? (a.pad ?? []).filter((p) => inWeek(p.time)) : [];

  // Fees, round trips netted per pair: a pair traded both ways in the week counts the fees of its trades in the share
  // of its volume that is not undone (|bought - sold| over bought + sold).
  let paid = 0n;
  let counted = 0n;
  const byPair = new Map<string, TideFee[]>();
  for (const f of fees) {
    paid += f.feeE6;
    byPair.set(f.pair, [...(byPair.get(f.pair) ?? []), f]);
  }
  for (const list of byPair.values()) {
    const bought = list.filter((f) => f.side === "buy").reduce((s, f) => s + f.volumeE6, 0n);
    const sold = list.filter((f) => f.side === "sell").reduce((s, f) => s + f.volumeE6, 0n);
    const fee = list.reduce((s, f) => s + f.feeE6, 0n);
    counted += bought + sold === 0n ? 0n : (fee * abs(bought - sold)) / (bought + sold);
  }
  const capped = counted > rules.feeCapE6 ? rules.feeCapE6 : counted;
  const feePoints = capped * rules.feePointsPerUsd;

  const raetoPaid = raeto.reduce((s, r) => s + r.usdE6, 0n);
  const raetoPoints = raetoPaid * rules.raetoPointsPerUsd;

  // Ostrapad fees: the three rows share one cap, filled by the provider's row first.
  const padSum = (kind: TidePad["kind"]) => pad.filter((p) => p.kind === kind).reduce((s, p) => s + p.feeE6, 0n);
  const padComplete = padSum("complete");
  const padHire = padSum("hire");
  const padJudge = padSum("judge");
  let padRoom = rules.padFeeCapE6;
  const padTake = (v: bigint) => {
    const t = v < padRoom ? v : padRoom;
    padRoom -= t;
    return t;
  };
  const cComplete = padTake(padComplete);
  const cHire = padTake(padHire);
  const cJudge = padTake(padJudge);
  const padPoints = cComplete * rules.padCompletePointsPerUsd + cHire * rules.padHirePointsPerUsd + cJudge * rules.padJudgePointsPerUsd;

  // Daily average balances; the combined cap filled by the highest rows first: Raeto vaults, then cash and Borro, then idle.
  const avg = (pick: (d: TideDay) => bigint) => a.days.reduce((s, d) => s + pick(d), 0n) / 7n;
  const raetoVaultAvg = rules.raetoVaultPointsPerUsd === 0n ? 0n : avg((d) => d.raetoE6 ?? 0n);
  const cashAvg = avg((d) => d.cashE6);
  const borroAvg = avg((d) => d.borroE6);
  const idleAvg = avg((d) => d.idleE6);
  let room = rules.balanceCapE6;
  const take = (v: bigint) => {
    const t = v < room ? v : room;
    room -= t;
    return t;
  };
  const cRaetoVault = take(raetoVaultAvg);
  const cCash = take(cashAvg);
  const cBorro = take(borroAvg);
  const cIdle = take(idleAvg);
  const balancePoints = cRaetoVault * rules.raetoVaultPointsPerUsd + cCash * rules.cashPointsPerUsd + cBorro * rules.borroPointsPerUsd + cIdle * rules.idlePointsPerUsd;

  // Active days: at least $0.10 of fees to Ostra or Raeto credits in the UTC day (and Ostrapad fees, when the week says so).
  const spent = new Array<bigint>(7).fill(0n);
  for (const f of fees) spent[Math.floor((f.time - start) / TIDE_DAY)]! += f.feeE6;
  for (const r of raeto) spent[Math.floor((r.time - start) / TIDE_DAY)]! += r.usdE6;
  if (rules.padCountsActive) {
    // One job's fees count once toward a day: an agent on two sides of a job (its own vaults hiring and providing)
    // paid its platform fee once, so the job counts its largest credit, not their sum.
    const perJob = new Map<string, TidePad>();
    pad.forEach((p, i) => {
      const k = p.jobId ?? `#${i}`;
      const prev = perJob.get(k);
      if (prev === undefined || p.feeE6 > prev.feeE6) perJob.set(k, p);
    });
    for (const p of perJob.values()) spent[Math.floor((p.time - start) / TIDE_DAY)]! += p.feeE6;
  }
  const activeDays = spent.flatMap((v, i) => (v >= rules.activeDayMinE6 ? [i + 1] : []));
  const early = a.registeredAt < rules.earlyBefore;
  let mult = 10_000n;
  if (early) mult = (mult * rules.earlyBps) / 10_000n;
  if (activeDays.length === 7) mult = (mult * rules.active7Bps) / 10_000n;
  else if (activeDays.length >= 3) mult = (mult * rules.active3Bps) / 10_000n;

  const base = feePoints + raetoPoints + padPoints + balancePoints;
  const points = (base * mult) / 10_000n;
  return {
    agentId: a.agentId,
    fee: { paidE6: paid.toString(), countedE6: counted.toString(), nettedOutE6: (paid - counted).toString(), cappedE6: capped.toString(), points: feePoints.toString() },
    raeto: { paidE6: raetoPaid.toString(), points: raetoPoints.toString() },
    pad: {
      completeE6: padComplete.toString(),
      hireE6: padHire.toString(),
      judgeE6: padJudge.toString(),
      countedCompleteE6: cComplete.toString(),
      countedHireE6: cHire.toString(),
      countedJudgeE6: cJudge.toString(),
      points: padPoints.toString(),
    },
    balances: {
      raetoVaultAvgE6: raetoVaultAvg.toString(),
      cashAvgE6: cashAvg.toString(),
      borroAvgE6: borroAvg.toString(),
      idleAvgE6: idleAvg.toString(),
      countedRaetoVaultE6: cRaetoVault.toString(),
      countedCashE6: cCash.toString(),
      countedBorroE6: cBorro.toString(),
      countedIdleE6: cIdle.toString(),
      points: balancePoints.toString(),
    },
    basePoints: base.toString(),
    activeDays,
    early,
    multiplierBps: mult.toString(),
    points: points.toString(),
  };
}

/**
 * The pot shared by points, at most `shareCapBps` of the pot to one agent: an agent over the cap gets the cap and the
 * rest is shared again among the others by their points, until none is over; what no one can take stays in the pot.
 * Amounts round down (in the token's base units). Ties keep the input order; agents with no points get nothing.
 */
export function tideShares(points: readonly { agentId: string; points: bigint }[], pot: bigint, rules: TideRules = TIDE_RULES): Map<string, bigint> {
  const cap = (pot * rules.shareCapBps) / 10_000n;
  const out = new Map<string, bigint>();
  let open = points.filter((p) => p.points > 0n);
  let left = pot;
  for (;;) {
    const total = open.reduce((s, p) => s + p.points, 0n);
    if (open.length === 0 || total === 0n || left === 0n) break;
    const over = open.filter((p) => (left * p.points) / total > cap);
    if (over.length === 0) {
      for (const p of open) out.set(p.agentId, (left * p.points) / total);
      break;
    }
    for (const p of over) {
      out.set(p.agentId, cap);
      left -= cap;
    }
    const capped = new Set(over.map((p) => p.agentId));
    open = open.filter((p) => !capped.has(p.agentId));
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------------------
// The Merkle tree of a week's shares
// -------------------------------------------------------------------------------------------------------------------

export type TideShare = { week: number; agentId: string; payee: Address; amount: bigint };

/** OstraTide.leaf: keccak256(bytes.concat(keccak256(abi.encode(week, agentId, payee, amount)))). */
export function tideLeaf(s: TideShare): Hex {
  const inner = keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }], [BigInt(s.week), agentWord(s.agentId), getAddress(s.payee), s.amount]),
  );
  return keccak256(inner);
}

function hashPair(a: Hex, b: Hex): Hex {
  const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return keccak256(`0x${x.slice(2)}${y.slice(2)}` as Hex);
}

/**
 * The week's tree: leaves sorted by hash, paired level by level with OpenZeppelin's commutative hash (MerkleProof's),
 * an odd node carried up. Its root, and each share's proof. One share: its leaf is the root and its proof empty.
 */
export function tideTree(shares: readonly TideShare[]): { root: Hex; proofs: Map<string, Hex[]>; leaves: Map<string, Hex> } {
  if (shares.length === 0) throw new RangeError("a tree needs at least one share");
  const leaves = new Map<string, Hex>();
  for (const s of shares) {
    if (leaves.has(s.agentId)) throw new RangeError(`agent ${s.agentId} has two shares`);
    leaves.set(s.agentId, tideLeaf(s));
  }
  let level = [...leaves.values()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const proofOf = new Map<Hex, Hex[]>([...leaves.values()].map((l) => [l, []]));
  // The members of each node, so a node's sibling joins every member's proof.
  let members = new Map<Hex, Hex[]>(level.map((l) => [l, [l]]));
  while (level.length > 1) {
    const next: Hex[] = [];
    const nextMembers = new Map<Hex, Hex[]>();
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1];
      if (b === undefined) {
        next.push(a);
        nextMembers.set(a, members.get(a)!);
        continue;
      }
      for (const m of members.get(a)!) proofOf.get(m)!.push(b);
      for (const m of members.get(b)!) proofOf.get(m)!.push(a);
      const p = hashPair(a, b);
      next.push(p);
      nextMembers.set(p, [...members.get(a)!, ...members.get(b)!]);
    }
    level = next;
    members = nextMembers;
  }
  const proofs = new Map<string, Hex[]>();
  for (const [agentId, leaf] of leaves) proofs.set(agentId, proofOf.get(leaf)!);
  return { root: level[0]!, proofs, leaves };
}

/** Whether `proof` proves `leaf` under `root`, as MerkleProof.verify does. */
export function tideVerify(root: Hex, leaf: Hex, proof: readonly Hex[]): boolean {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}
