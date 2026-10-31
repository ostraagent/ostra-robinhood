// Ostra Tide's score of a week, read from Robinhood Chain (design "Ostra Tide", decided by Edu on 26 and 31 Oct 2026):
// who takes part, which vaults each one linked, what they paid and held in the week, their points (sdk tideScore) and
// their shares of the week's pot (tideShares). Run by scripts/tide-score.ts; its output is Ostra's private record (it
// names every agent's linked vaults), served to each agent alone by the index, and its tree's root is what OstraTide
// pays against.
//
//   Agents     an ERC-8004 identity registered by an Ostra vault (its AgentRegistered event) before the week ended,
//              still owned by that vault; none of Ostra's own (OSTRA_STATS_OWN's list: its test agents and its
//              services' vaults). A vault takes part once: of several identities it registered, the earliest it
//              still owns counts, the others are left out (each would count the same vaults again).
//   Vaults     the identity vault, and the vaults of the agent's link: the identity vault approved the link's set
//              digest and each vault its member digest, each an Ostra vault, the approvals in force at the link
//              deadline (hashValidFrom at the last block before it: approved, not withdrawn, not voided by the lock
//              turned on since, and valid from a time not after the deadline). Of several links, the one whose set
//              approval is valid from the latest time counts. A vault that is another agent's identity vault, or
//              Ostra's own, counts for none; a vault two links claim counts for the agent whose member approval is
//              valid from the earlier time (the lower agent id on a tie).
//   Fees       OstraRouter Swapped events in the week whose recipient is one of the agent's vaults (a vault's swap is
//              paid out to it; the fee is the hub's, USDG or WETH, WETH at Chainlink ETH/USD at the swap's block); the
//              volume, for the netting, is the fee over its rate. Private swaps name no vault and are not counted.
//   Raeto      USDG sent from one of the agent's vaults to Raeto's payTo in the week.
//   Balances   at the last block of each UTC day of the week, in each of the agent's vaults: USDG, WETH (Chainlink
//              ETH/USD) and the stock tokens with a Chainlink feed (at that block), idle; Steakhouse USDG shares
//              (Ostra's cash vault, previewRedeem), in cash; Borro's USDG vault shares, and per Borro stock market the
//              stock vault shares held and posted as Morpho collateral, at the market's own oracle, less the debt in
//              it (never below 0), in Borro: what is borrowed and held again is not counted twice. OSTRA and other
//              tokens are not counted. A day not over yet is read at the latest block (an estimate, said so).
//   State      who owns an identity, the link approvals, the payee's token and the pot are read at one block: the
//              last before the link deadline once it has passed (the latest before), so a score read again after
//              the deadline gives the same result whatever happens later.
//
// State is read at past blocks: the RPC must keep them (an archive node). Event searches go to Robinhood Chain's
// public RPC, one value per topic position, so a window can span the whole week.

import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, erc20Abi, getAddress, parseAbi, parseAbiItem, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
import {
  BORRO_USDG_VAULT,
  CHAINLINK_ETH_USD,
  ERC8004_IDENTITY_REGISTRY,
  LAUNCH_PAIRS,
  MORPHO_BLUE,
  OSTRA,
  OSTRA_TIDE,
  STEAKHOUSE_USDG,
  TIDE_DAY,
  TIDE_RULES,
  USDG,
  WETH,
  borroStocks,
  chainlinkAggregatorAbi,
  morphoBlueAbi,
  morphoOracleAbi,
  readMorphoMarket,
  tideFeePair,
  tideMemberDigest,
  tideScore,
  tideSetDigest,
  tideShares,
  tideSortVaults,
  tideTree,
  tideViewKey,
  tideWeekSpan,
  toAssetsUp,
  vaultV2Abi,
  type TideAgentInput,
  type TideBreakdown,
  type TideDay,
  type TideFee,
  type TideRaeto,
} from "@ostraagent/sdk";

/** Where Raeto takes USDG for credits (core/src/raeto.ts RAETO_PAY_TO, read 25 Oct 2026). */
export const RAETO_PAY_TO: Address = "0xF0Cc2FE5A90a3BB784De818f6E2061fd99c236Bf";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** An agent's link as the index keeps it: what the agent sent (its secret never leaves Ostra's records). */
export type TideLinkRecord = { agentId: string; secret: Hex; vaults: Address[]; payee: Address | null; at: number };

export type TideLinkStatus =
  | { status: "none" }
  | { status: "verified"; vaults: Address[]; payee: Address | null; setApprovedAt: number }
  | { status: "unproven"; missing: string[] };

export type TideAgentResult = {
  agentId: string;
  identityVault: Address;
  registeredAt: number;
  link: TideLinkStatus;
  /** The vaults counted: the identity vault and the link's verified ones. */
  vaults: Address[];
  payee: Address | null;
  breakdown: TideBreakdown;
  /** Its share of the pot, in OSTRA base units. */
  share: string;
  /** Vaults a link claimed that count for another agent, Ostra or nobody, and why. */
  dropped: { vault: Address; reason: string }[];
  /**
   * The view key of the link that counts (sdk tideViewKey of its secret): the index answers this result to it alone.
   * Null without a verified link.
   */
  viewKey: Hex | null;
  /** Every other link kept for this agent, by its view key, with what it lacks: the index answers each to its key. */
  pending: { viewKey: Hex; missing: string[] }[];
};

export type TideWeekResult = {
  week: number;
  start: number;
  end: number;
  /** When it was read, the block, and whether the week was over (false: days not over are estimates). */
  at: number;
  block: string;
  final: boolean;
  pot: string;
  totalPoints: string;
  shared: string;
  agents: TideAgentResult[];
  excluded: { agentId: string; vault: Address; reason: string }[];
  /** The block the identities, link approvals, payees and pot were read at (the last before the link deadline once it passed). */
  stateBlock: string;
  tree: { root: Hex; total: string; leaves: { agentId: string; payee: Address; amount: string; proof: Hex[] }[] } | null;
};

const EV = {
  vaultCreated: parseAbiItem("event VaultCreated(address indexed vault, address indexed token, bytes32 initialKeyRoot, address initialCrank)"),
  agentRegistered: parseAbiItem("event AgentRegistered(uint256 indexed agentId)"),
  swapped: parseAbiItem("event Swapped(address indexed account, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address hub, uint256 fee, uint16 feeBps, address recipient)"),
  transfer: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
} as const;

const tideAbi = parseAbi(["function potBalance(uint256 week) view returns (uint256)"]);
const identityAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);
const approvalAbi = parseAbi(["function hashValidFrom(bytes32 hash) view returns (uint64)"]);
const tokenAbi = parseAbi(["function token() view returns (address)"]);

type Log = { address: Address; blockNumber: bigint; logIndex: number; transactionHash: Hex; args: Record<string, unknown> };

const WINDOW_MIN = 500n;

/** The logs of `get` over [from, to]: the whole range in one window, halved when the RPC refuses one, grown back after. */
async function scan(from: bigint, to: bigint, get: (a: bigint, b: bigint) => Promise<unknown[]>): Promise<Log[]> {
  const out: Log[] = [];
  if (to < from) return out;
  const whole = to - from + 1n > WINDOW_MIN ? to - from + 1n : WINDOW_MIN;
  let window = whole;
  let a = from;
  while (a <= to) {
    const b = a + window - 1n < to ? a + window - 1n : to;
    let logs: unknown[];
    try {
      logs = await get(a, b);
    } catch (err) {
      if (window <= WINDOW_MIN) throw err;
      window = window / 2n < WINDOW_MIN ? WINDOW_MIN : window / 2n;
      continue;
    }
    for (const l of logs as { address: Address; blockNumber: bigint | null; logIndex: number | null; transactionHash: Hex | null; args?: Record<string, unknown>; removed?: boolean }[]) {
      if (l.blockNumber === null || l.logIndex === null || l.transactionHash === null || l.removed === true || l.args === undefined) continue;
      out.push({ address: getAddress(l.address), blockNumber: l.blockNumber, logIndex: l.logIndex, transactionHash: l.transactionHash, args: l.args });
    }
    a = b + 1n;
    if (window < whole) window = window * 2n > whole ? whole : window * 2n;
  }
  return out.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
}

async function mapLimit<T, U>(items: readonly T[], limit: number, f: (item: T) => Promise<U>): Promise<U[]> {
  const out = new Array<U>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The last block with a timestamp below `time` in [lo, hi] (hi when every block is). */
async function lastBlockBefore(lo: bigint, hi: bigint, time: number, at: (n: bigint) => Promise<number>): Promise<bigint> {
  if ((await at(hi)) < time) return hi;
  if ((await at(lo)) >= time) throw new Error(`block ${lo} is already at or after ${time}`);
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await at(mid)) < time) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** US dollars (E6) of `amount` base units (`decimals`) at a Chainlink answer of 8 decimals. */
function usdE6(amount: bigint, decimals: number, answerE8: bigint): bigint {
  return (amount * answerE8) / 10n ** BigInt(decimals + 2);
}

const STOCKS = LAUNCH_PAIRS.filter((p) => p.kind === "stock" && p.feed !== null).map((p) => ({ token: p.address, feed: p.feed as Address, decimals: p.decimals, symbol: p.symbol }));

/** What one block's balances are priced with: Chainlink's answers, and each Borro stock market's oracle and totals. */
type Prices = { feeds: Map<Address, bigint>; borro: { price: bigint; borrowAssets: bigint; borrowShares: bigint }[] };

async function pricesAt(client: PublicClient, blockNumber: bigint, timestamp: number): Promise<Prices> {
  const borro = borroStocks();
  const feeds = [...new Set([CHAINLINK_ETH_USD, ...STOCKS.map((s) => s.feed)])];
  const r = (await client.multicall({
    contracts: [
      ...feeds.map((f) => ({ address: f, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" }) as const),
      ...borro.map((b) => ({ address: b.market.oracle, abi: morphoOracleAbi, functionName: "price" }) as const),
    ],
    allowFailure: false,
    blockNumber,
  })) as unknown[];
  const out: Prices = { feeds: new Map(), borro: [] };
  feeds.forEach((f, i) => {
    const answer = (r[i] as readonly [bigint, bigint, bigint, bigint, bigint])[1];
    if (answer <= 0n) throw new Error(`feed ${f} answers ${answer} at block ${blockNumber}`);
    out.feeds.set(f, answer);
  });
  // Each market's borrows accrued to the block's time, as Morpho would accrue them (sdk readMorphoMarket).
  const markets = await Promise.all(borro.map((b) => readMorphoMarket(client, b.marketId, { blockNumber, timestamp: BigInt(timestamp) })));
  borro.forEach((_, k) => {
    const m = markets[k]!.expected ?? markets[k]!.stored;
    out.borro.push({ price: r[feeds.length + k] as bigint, borrowAssets: m.totalBorrowAssets, borrowShares: m.totalBorrowShares });
  });
  return out;
}

/**
 * One vault set's balances at `blockNumber`, in dollars (E6): idle (USDG, WETH, stock tokens), cash (Steakhouse USDG),
 * Borro (Borro USDG vault shares; per Borro stock market, the stock vault shares held and posted as collateral at the
 * market's oracle less the debt, never below 0). The debt is Morpho's toAssetsUp of the borrow shares at the market's
 * borrows accrued to the block's time (pricesAt).
 */
async function balancesAt(client: PublicClient, vaults: readonly Address[], blockNumber: bigint, prices: Prices): Promise<TideDay> {
  const borro = borroStocks();
  const ethPrice = prices.feeds.get(CHAINLINK_ETH_USD)!;
  const day: TideDay = { cashE6: 0n, borroE6: 0n, idleE6: 0n };
  for (const v of vaults) {
    const tokens = [USDG, WETH, ...STOCKS.map((s) => s.token)];
    const bal = (await client.multicall({
      contracts: [
        ...tokens.map((t) => ({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [v] }) as const),
        { address: STEAKHOUSE_USDG, abi: vaultV2Abi, functionName: "balanceOf", args: [v] } as const,
        { address: BORRO_USDG_VAULT, abi: vaultV2Abi, functionName: "balanceOf", args: [v] } as const,
        ...borro.map((b) => ({ address: b.vault, abi: vaultV2Abi, functionName: "balanceOf", args: [v] }) as const),
        ...borro.map((b) => ({ address: MORPHO_BLUE, abi: morphoBlueAbi, functionName: "position", args: [b.marketId, v] }) as const),
      ],
      allowFailure: false,
      blockNumber,
    })) as unknown[];
    let i = 0;
    const next = () => bal[i++];
    day.idleE6 += next() as bigint; // USDG, 6 decimals: E6 dollars
    day.idleE6 += usdE6(next() as bigint, 18, ethPrice);
    for (const s of STOCKS) day.idleE6 += usdE6(next() as bigint, s.decimals, prices.feeds.get(s.feed)!);
    const steak = next() as bigint;
    const borroUsdg = next() as bigint;
    const stockShares = borro.map(() => next() as bigint);
    const positions = borro.map(() => next() as readonly [bigint, bigint, bigint]);
    const redeem = async (vault: Address, shares: bigint) =>
      shares === 0n ? 0n : ((await client.readContract({ address: vault, abi: vaultV2Abi, functionName: "previewRedeem", args: [shares], blockNumber })) as bigint);
    day.cashE6 += await redeem(STEAKHOUSE_USDG, steak);
    day.borroE6 += await redeem(BORRO_USDG_VAULT, borroUsdg);
    for (const k of borro.keys()) {
      const [, borrowShares, collateral] = positions[k]!;
      const held = stockShares[k]! + collateral;
      if (held === 0n && borrowShares === 0n) continue;
      const p = prices.borro[k]!;
      // The oracle prices one collateral unit (a stock vault share) in USDG base units, scaled by 1e36.
      const value = (held * p.price) / 10n ** 36n;
      const debt = borrowShares === 0n ? 0n : toAssetsUp(borrowShares, p.borrowAssets, p.borrowShares);
      if (value > debt) day.borroE6 += value - debt;
    }
  }
  return day;
}

export type TideReadOptions = {
  /** A client of an archive node (state at past blocks). */
  client: PublicClient;
  /** A client of an RPC serving wide eth_getLogs windows (Robinhood Chain's public RPC). */
  logsClient: PublicClient;
  factory: Address;
  router: Address;
  fromBlock: bigint;
  week: number;
  links: readonly TideLinkRecord[];
  own: ReadonlySet<Address>;
  /** Approvals after this time do not count for this week (week 1: 4 Nov 2026 23:00 UTC). */
  linkDeadline: number;
  chainId: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Tests only: the week's start in place of OstraTide's (a fork's blocks all come after week 1 started). */
  testStart?: number;
};

/** The week's score: every agent's vaults, points and share, and the tree of the shares (null before the week ends). */
export async function readTideWeek(o: TideReadOptions): Promise<TideWeekResult> {
  const log = o.log ?? (() => {});
  const start = o.testStart ?? tideWeekSpan(o.week).start;
  const end = start + (tideWeekSpan(o.week).end - tideWeekSpan(o.week).start);
  const head = await o.client.getBlock();
  const latest = head.number;
  const now = Number(head.timestamp);
  const final = now >= end;
  const times = new Map<bigint, number>();
  const timeOf = async (n: bigint) => {
    let t = times.get(n);
    if (t === undefined) {
      t = Number((await o.client.getBlock({ blockNumber: n })).timestamp);
      times.set(n, t);
    }
    return t;
  };
  const ev = (event: AbiEvent, address: Address, from: bigint, to: bigint, args?: Record<string, unknown>) =>
    scan(from, to, (a, b) => o.logsClient.getLogs({ address, event, ...(args === undefined ? {} : { args }), fromBlock: a, toBlock: b }) as Promise<unknown[]>);

  // The week's blocks: its first, and the last of each UTC day (or the latest block for a day not over).
  const weekStartBlock = (await lastBlockBefore(o.fromBlock, latest, start, timeOf)) + 1n;
  const dayEnds: { block: bigint; estimate: boolean }[] = [];
  for (let d = 1; d <= 7; d++) {
    const t = start + d * TIDE_DAY;
    dayEnds.push(t <= now ? { block: await lastBlockBefore(weekStartBlock, latest, t, timeOf), estimate: false } : { block: latest, estimate: true });
  }
  const weekEndBlock = final ? dayEnds[6]!.block : latest;
  // The block state is read at: the last before the link deadline once it has passed, else the latest.
  const stateBlock = o.linkDeadline < now ? await lastBlockBefore(weekStartBlock, latest, o.linkDeadline + 1, timeOf) : latest;
  const stateTime = await timeOf(stateBlock);
  log("tide_blocks", { week: o.week, weekStartBlock: weekStartBlock.toString(), weekEndBlock: weekEndBlock.toString(), stateBlock: stateBlock.toString(), final });

  // Every Ostra vault, and the agents they registered (a vault's earliest identity it still owns).
  const vaults = new Set((await ev(EV.vaultCreated, o.factory, o.fromBlock, latest)).map((l) => getAddress(l.args.vault as Address)));
  const registered = (await mapLimit([...vaults], 4, (v) => ev(EV.agentRegistered, v, o.fromBlock, weekEndBlock))).flat();
  registered.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
  const excluded: TideWeekResult["excluded"] = [];
  const agents: { agentId: string; vault: Address; at: number }[] = [];
  const seenIds = new Set<string>();
  const counted = new Map<Address, string>();
  for (const l of registered) {
    const agentId = (l.args.agentId as bigint).toString();
    if (seenIds.has(agentId)) continue;
    seenIds.add(agentId);
    const vault = l.address;
    if (o.own.has(vault)) {
      excluded.push({ agentId, vault, reason: "Ostra's own" });
      continue;
    }
    const owner = getAddress((await o.client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [BigInt(agentId)], blockNumber: stateBlock })) as Address);
    if (owner !== vault) {
      excluded.push({ agentId, vault, reason: `its identity is now owned by ${owner}, not the vault that registered it` });
      continue;
    }
    const first = counted.get(vault);
    if (first !== undefined) {
      excluded.push({ agentId, vault, reason: `another identity of a vault that takes part as agent ${first}` });
      continue;
    }
    counted.set(vault, agentId);
    agents.push({ agentId, vault, at: await timeOf(l.blockNumber) });
  }
  agents.sort((a, b) => (BigInt(a.agentId) < BigInt(b.agentId) ? -1 : 1));
  const identityVaults = new Set(agents.map((a) => a.vault));

  // Links: each approval as the vault holds it at the state block, in force by the deadline.
  const validFrom = async (vault: Address, hash: Hex): Promise<number | null> => {
    let from: bigint;
    try {
      from = (await o.client.readContract({ address: vault, abi: approvalAbi, functionName: "hashValidFrom", args: [hash], blockNumber: stateBlock })) as bigint;
    } catch (err) {
      // A vault before version 3 has no hashValidFrom (it reverts or returns nothing): it approves no hash. Anything
      // else (a timeout, a rate limit, the node) stops the score instead of dropping a link.
      const noFunction = err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null;
      if (noFunction) return null;
      throw err;
    }
    const t = Number(from);
    return t !== 0 && t <= o.linkDeadline && t <= stateTime ? t : null;
  };
  const deadlineText = new Date(o.linkDeadline * 1000).toISOString();
  type Verified = { agentId: string; vaults: Address[]; payee: Address | null; viewKey: Hex; setFrom: number; at: number; memberFrom: Map<Address, number> };
  const verified = new Map<string, Verified>();
  const pending = new Map<string, { viewKey: Hex; missing: string[] }[]>();
  for (const a of agents) {
    const tried: { viewKey: Hex; missing: string[] }[] = [];
    for (const r of o.links.filter((x) => x.agentId === a.agentId)) {
      const viewKey = tideViewKey(r.secret);
      const list = tideSortVaults([...r.vaults, a.vault]);
      const setFrom = await validFrom(a.vault, tideSetDigest({ chainId: o.chainId, agentId: a.agentId, vaults: list, payee: r.payee, secret: r.secret }));
      // Without the identity vault's approval nothing else is read: a link anyone may post costs one read.
      if (setFrom === null) {
        tried.push({ viewKey, missing: [`the identity vault ${a.vault} has no approval of this link's set digest in force by ${deadlineText}`] });
        continue;
      }
      const missing: string[] = [];
      const memberFrom = new Map<Address, number>();
      for (const v of list) {
        if (v === a.vault) continue;
        if (!vaults.has(v)) {
          missing.push(`${v} is not an Ostra vault`);
          continue;
        }
        const m = await validFrom(v, tideMemberDigest({ chainId: o.chainId, agentId: a.agentId, vault: v, secret: r.secret }));
        if (m === null) missing.push(`${v} has no approval of its member digest in force by ${deadlineText}`);
        else memberFrom.set(v, m);
      }
      if (missing.length > 0) {
        tried.push({ viewKey, missing });
        continue;
      }
      const prev = verified.get(a.agentId);
      const next: Verified = { agentId: a.agentId, vaults: list, payee: r.payee, viewKey, setFrom, at: r.at, memberFrom };
      if (prev === undefined || setFrom > prev.setFrom || (setFrom === prev.setFrom && r.at > prev.at)) {
        if (prev !== undefined) tried.push({ viewKey: prev.viewKey, missing: ["a later link of this agent counts in its place"] });
        verified.set(a.agentId, next);
      } else tried.push({ viewKey, missing: ["a later link of this agent counts in its place"] });
    }
    const v = verified.get(a.agentId);
    pending.set(a.agentId, tried.filter((t) => v === undefined || t.viewKey !== v.viewKey));
  }
  // A vault claimed by two links counts for the earlier member approval; identity vaults and Ostra's own for none.
  const claimedBy = new Map<Address, { agentId: string; from: number }>();
  for (const v of verified.values()) {
    for (const [vault, from] of v.memberFrom) {
      const c = claimedBy.get(vault);
      if (c === undefined || from < c.from || (from === c.from && BigInt(v.agentId) < BigInt(c.agentId))) claimedBy.set(vault, { agentId: v.agentId, from });
    }
  }
  const vaultsOf = new Map<string, { vaults: Address[]; dropped: { vault: Address; reason: string }[]; payee: Address | null }>();
  for (const a of agents) {
    const v = verified.get(a.agentId);
    const countedVaults: Address[] = [a.vault];
    const dropped: { vault: Address; reason: string }[] = [];
    if (v !== undefined) {
      for (const vault of v.vaults) {
        if (vault === a.vault) continue;
        if (o.own.has(vault)) dropped.push({ vault, reason: "Ostra's own vault" });
        else if (identityVaults.has(vault)) dropped.push({ vault, reason: "another agent's identity vault" });
        else if (claimedBy.get(vault)?.agentId !== a.agentId) dropped.push({ vault, reason: `linked first by agent ${claimedBy.get(vault)?.agentId}` });
        else countedVaults.push(vault);
      }
    }
    let payee: Address | null = null;
    if (v !== undefined && v.payee !== null && countedVaults.includes(getAddress(v.payee))) {
      const token = getAddress((await o.client.readContract({ address: v.payee, abi: tokenAbi, functionName: "token", blockNumber: stateBlock })) as Address);
      if (token === OSTRA) payee = getAddress(v.payee);
      else dropped.push({ vault: v.payee, reason: "the payee is not an OSTRA vault" });
    }
    vaultsOf.set(a.agentId, { vaults: tideSortVaults(countedVaults), dropped, payee });
  }

  // The week's swaps and Raeto credits, of every vault counted.
  const owner = new Map<Address, string>();
  for (const [id, x] of vaultsOf) for (const v of x.vaults) owner.set(v, id);
  const swaps = await ev(EV.swapped, o.router, weekStartBlock, weekEndBlock);
  const fees = new Map<string, TideFee[]>();
  for (const l of swaps) {
    const id = owner.get(getAddress(l.args.recipient as Address));
    if (id === undefined) continue;
    const fee = l.args.fee as bigint;
    const bps = BigInt(l.args.feeBps as number);
    const hub = getAddress(l.args.hub as Address);
    let feeE6: bigint;
    if (hub === USDG) feeE6 = fee;
    else if (hub === WETH) {
      const r = (await o.client.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAggregatorAbi, functionName: "latestRoundData", blockNumber: l.blockNumber })) as readonly [bigint, bigint, bigint, bigint, bigint];
      feeE6 = usdE6(fee, 18, r[1]);
    } else throw new Error(`swap ${l.transactionHash}: a fee in ${hub}, neither USDG nor WETH`);
    if (feeE6 === 0n || bps === 0n) continue;
    const { pair, side } = tideFeePair(l.args.tokenIn as Address, l.args.tokenOut as Address);
    fees.set(id, [...(fees.get(id) ?? []), { time: await timeOf(l.blockNumber), feeE6, pair, side, volumeE6: (feeE6 * 10_000n) / bps }]);
  }
  const credits = await ev(EV.transfer, USDG, weekStartBlock, weekEndBlock, { to: RAETO_PAY_TO });
  const raeto = new Map<string, TideRaeto[]>();
  for (const l of credits) {
    const id = owner.get(getAddress(l.args.from as Address));
    if (id === undefined) continue;
    raeto.set(id, [...(raeto.get(id) ?? []), { time: await timeOf(l.blockNumber), usdE6: l.args.value as bigint }]);
  }

  // Balances at each day's last block, priced once per block.
  const prices = await mapLimit(dayEnds, 2, async (d) => pricesAt(o.client, d.block, await timeOf(d.block)));
  const inputs: TideAgentInput[] = [];
  for (const a of agents) {
    const { vaults: vs } = vaultsOf.get(a.agentId)!;
    const days = await mapLimit(dayEnds.map((d, k) => ({ d, k })), 2, ({ d, k }) => balancesAt(o.client, vs, d.block, prices[k]!));
    inputs.push({ agentId: a.agentId, registeredAt: a.at, fees: fees.get(a.agentId) ?? [], raeto: raeto.get(a.agentId) ?? [], days });
    log("tide_agent", { agentId: a.agentId, vaults: vs.length });
  }
  const scores = inputs.map((x) => tideScore(x, o.week, TIDE_RULES, start));
  const pot = (await o.client.readContract({ address: OSTRA_TIDE, abi: tideAbi, functionName: "potBalance", args: [BigInt(o.week)], blockNumber: stateBlock })) as bigint;
  const shares = tideShares(scores.map((s) => ({ agentId: s.agentId, points: BigInt(s.points) })), pot);
  const results: TideAgentResult[] = agents.map((a, i) => {
    const x = vaultsOf.get(a.agentId)!;
    const v = verified.get(a.agentId);
    const tried = pending.get(a.agentId) ?? [];
    const link: TideLinkStatus =
      v !== undefined ? { status: "verified", vaults: v.vaults, payee: v.payee, setApprovedAt: v.setFrom } : tried.length > 0 ? { status: "unproven", missing: tried[tried.length - 1]!.missing } : { status: "none" };
    return {
      agentId: a.agentId,
      identityVault: a.vault,
      registeredAt: a.at,
      link,
      vaults: x.vaults,
      payee: x.payee,
      breakdown: scores[i]!,
      share: (shares.get(a.agentId) ?? 0n).toString(),
      dropped: x.dropped,
      viewKey: v?.viewKey ?? null,
      pending: tried,
    };
  });
  const totalPoints = scores.reduce((s, x) => s + BigInt(x.points), 0n);
  const shared = [...shares.values()].reduce((s, x) => s + x, 0n);
  let tree: TideWeekResult["tree"] = null;
  const paid = results.filter((r) => BigInt(r.share) > 0n);
  if (final && paid.length > 0) {
    const t = tideTree(paid.map((r) => ({ week: o.week, agentId: r.agentId, payee: r.payee ?? ZERO, amount: BigInt(r.share) })));
    tree = { root: t.root, total: shared.toString(), leaves: paid.map((r) => ({ agentId: r.agentId, payee: r.payee ?? ZERO, amount: r.share, proof: t.proofs.get(r.agentId)! })) };
  }
  return { week: o.week, start, end, at: now, block: latest.toString(), final, pot: pot.toString(), totalPoints: totalPoints.toString(), shared: shared.toString(), agents: results, excluded, stateBlock: stateBlock.toString(), tree };
}
