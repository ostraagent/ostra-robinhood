// Ostra's strategy planner for an agent (stage 2 of the planner, design "Penyusun Strategi Ostra di MCP", decided by Edu
// on 24 Oct 2026). It runs on the agent's machine, not on Ostra's servers, and only for an agent registered in the
// ERC-8004 Identity Registry through Ostra (its creator vault owns the identity and is its agentWallet).
//
// Every plan is computed again from what is read at that moment: the agent's vaults, the cash vaults' checks (sdk
// checkCashVault, plus the changes their curators submitted and that are still pending), Borro's markets accrued to
// the block, Chainlink feeds, the gas of each spend priced as the relayer prices it. What cannot be read or proved
// leaves its route out. The rules and their numbers are strategy-rules.ts.
//
//   * plan(): a conservative plan (cash, Strategy 1) and, when a carry of the agent's SPY, QQQ or NVDA may open, a
//     balanced one (cash and the carry, Strategy 2), both keeping the trading capital's cash (trading.ts) in the USDG vault.
//     Each step earns more than 3x its gas within 30 days or is left out.
//   * apply(): runs a plan's steps in order, each checked and sized again right before it is signed, and each one's
//     effect read back on-chain after it lands; a plan that is not urgent waits a random delay first
//     (strategy-rules JITTER_MAX_SECONDS), so Ostra agents do not move together.
//   * check(): what each run of the agent looks at (the cash vault's state, settings and pending changes, its share
//     price against its model, USDe's price from Chainlink on Ethereum, the carry ladder), with the actions it calls
//     for; urgent ones run at once, the others are kept as a plan for apply().
//   * report(): yield per day by route, realized share growth, and each carry's distance to liquidation.
//
// Strategy 3 (the guardian breaker, OstraBreaker, breaker.ts): each plan says whether it watches the USDG vault's cash
// vaults. It does only under the vault's withdrawal lock (decided by Edu on 25 Oct 2026: turning the lock on arms it);
// without the lock the MCP's sweep runs exitCheck() each minute while it runs, and leaves a failing cash vault at once.

import { getAddress, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import {
  BORRO_BUILDERS,
  BORRO_USDG_VAULT,
  CASH_VAULTS,
  MORPHO_BLUE,
  USDE,
  USDE_EXIT_PRICE,
  USDG,
  VAULT_ACTION,
  agentIdsRegisteredBy,
  blockTime,
  borroStocks,
  borrowParams,
  capIdsFromEvents,
  capsAfterPending,
  cashCollateralHolds,
  cashVaultRoom,
  checkCashVault,
  getLogsChunked,
  halfLltvMaxDebt,
  isRevert,
  pendingChangeProblems,
  instantBorrowRate,
  lendParams,
  listOstraVaults,
  postCollateralParams,
  readAgentIdentity,
  readBorroPosition,
  readMorphoMarket,
  readOracle,
  readPendingChanges,
  readUsdeUsd,
  readVault,
  readVaultGuard,
  redeemParams,
  setLinkedVaultParams,
  utilization,
  vaultV2Abi,
  worstCaseExposure,
  type BorroPosition,
  type BorroStock,
  type CashVaultCheck,
  type PendingChange,
  type VaultV2State,
} from "@ostraagent/sdk";
import { formatUnitsAmount, TOKEN_DECIMALS } from "./amount.ts";
import { BORRO_REPAY_BUFFER_BPS, type BorroService } from "./borro.ts";
import type { BreakerService } from "./breaker.ts";
import { chainTime, tokenBalance } from "./chain.ts";
import type { Config } from "./config.ts";
import { randomInt } from "./random.ts";
import type { Folder } from "./storage.ts";
import {
  BPS,
  BUFFER_DAYS,
  CARRY_EVENT_MAX_OF_LLTV_BPS,
  CARRY_OPEN_OF_LLTV_BPS,
  DAY,
  EVENT_LOOKAHEAD,
  JITTER_MAX_SECONDS,
  LIQUIDITY_EXIT_UTILIZATION,
  MOVE_HORIZON,
  MOVE_MIN_SPREAD,
  STEP_HORIZON,
  WAD,
  YEAR,
  carryAction,
  carryIdleReserve,
  carryMayOpen,
  carryTarget,
  depositable,
  ofBps,
  shareGrowthTooLow,
  worthIt,
  yieldOver,
  type CarryAction,
} from "./strategy-rules.ts";
import type { TradingService } from "./trading.ts";
import type { VaultOperationResult, VaultService } from "./vault.ts";

/**
 * The most gas a Morpho spend used on a fork with Borro's live markets (design, measured 24 Oct 2026: 246,600 to
 * 603,551). A step that can run only after an earlier one lands (a loan before its collateral is posted) cannot be
 * simulated now, so it is priced at this.
 */
export const MEASURED_MORPHO_SPEND_GAS = 603_551n;
/** OstraFees on mainnet: its pure nyseClosed(time) is the NYSE calendar (weekends, holidays 2026 to 2028, US daylight time). */
export const OSTRA_FEES_MAINNET: Address = "0x8e79671DC9729476614C78aFcf2345D4c1963801";
const feesAbi = parseAbi(["function nyseClosed(uint256 time) view returns (bool)"]);
const timelockAbi = parseAbi(["function executableAt(bytes data) view returns (uint256)", "function abdicated(bytes4 selector) view returns (bool)"]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const VAULTS_FILE = "ostra-vaults.json";
const RUNS_FILE = "runs.jsonl";
const PLANS_DIR = "plans";
/** Blocks a log cursor stays behind the head (about 5 minutes at Robinhood Chain's 9.5 blocks a second, measured 24 Oct 2026). */
export const LOG_RESCAN_BLOCKS = 3_000n;

export class StrategyGateError extends Error {
  readonly code = "not_registered";
  constructor(message: string) {
    super(message);
    this.name = "StrategyGateError";
  }
}

export type StrategyParts = {
  client: PublicClient;
  /** Serves eth_getLogs over long windows (getLogsChunked adapts its spans). */
  logsClient: PublicClient;
  config: Config;
  buyer: VaultService;
  tokenVault: (token: Address) => VaultService;
  /** The creator vault: it owns the agent's ERC-8004 identity. */
  creator: VaultService;
  borro: BorroService;
  folder: Folder;
  /** The agent id the launchpad recorded at registration (agent.json), or null: then the Registered events are searched. */
  agentId: () => Promise<string | null>;
  /**
   * An Ethereum mainnet client (chain mainnet, for ENS), for Chainlink's USDe / USD feed; null when none is set: then
   * USDe's price is unknown, so no cash goes into a vault that can lend against USDe.
   */
  ethClient: PublicClient | null;
  /** OstraBreaker on the USDG vault (null: a deployment without one). */
  breaker?: BreakerService | null;
  /** The trading capital (trading.ts): its cash stays in the USDG vault (null or absent: none). */
  trading?: TradingService | null;
};

export type PlanOptions = {
  /** USDG kept for x402, swaps and payments; default: what the USDG vault spent over the last 7 days. */
  buffer?: bigint;
  /** Earnings dates (unix seconds) the agent knows, by stock; without one NVDA stays at most 60% of its LLTV at all times. */
  earnings?: Readonly<Record<string, bigint>>;
};

export type Step = {
  kind: "lend_cash" | "redeem_cash" | "lend_stock" | "post_collateral" | "link" | "borrow" | "repay" | "close_carry";
  /** "USDG" or a stock symbol. */
  what: string;
  /** A cash vault for lend_cash and redeem_cash. */
  vault?: Address;
  /**
   * Base units (USDG 6 decimals, stocks 18; shares for redeem_cash); "all": every share or the whole debt; "free"
   * (lend_cash): what the USDG vault holds over the plan's `keep` when the step runs, within the vault's room.
   */
  amount: string;
  urgent: boolean;
  /** Unix seconds before which a step that is not urgent is not signed. */
  notBefore: number;
  /** USDG base units, as the relayer prices it now. */
  cost: string;
  reason: string;
};

export type Plan = {
  id: string;
  /** "check": the actions a run's check called for that are not urgent, kept as a plan for apply(). */
  profile: "conservative" | "balanced" | "check";
  at: number;
  steps: Step[];
  /**
   * USDG base units the USDG vault keeps when a "free" lend runs: the buffer, the trading capital's cash, a carry's
   * idle reserve. The trading capital's part is taken again when the step runs (`trading.cashUnits` is what it was).
   */
  keep: string;
  /** What the plan earns over 30 days at the rates read now, net of every step's gas (USDG). */
  expected30d: string;
  cashApy: string;
  /** The trading capital (trading.ts) when one is set: its cash is kept in the USDG vault. */
  trading: { capital: string; cash: string; cashUnits: string; limits: { positionMaxBps: string; maxImpactBps: string; dailyLossBps: string; weeklyLossBps: string } } | null;
  risks: string[];
  stopWhen: string[];
  breaker: string;
  doneSteps?: number;
};

type RunRecord = {
  at: number;
  block: string;
  cash: {
    vault: Address;
    sharePrice: string;
    modelApy: string;
    held: string;
    /** What the per-run check compares with the last run (design): fees, maxRate, the liquidity adapter and data, the adapters, owner and curator. */
    settings?: Record<string, string>;
  }[];
  carry: { symbol: string; borrowRate: string; debt: string; ltvBps: string }[];
};

export type StepOutcome = { step: number; kind: Step["kind"]; what: string; landed: boolean; result?: VaultOperationResult; skipped?: string; note?: string };

const usd = (x: bigint) => formatUnitsAmount(x < 0n ? 0n : x, TOKEN_DECIMALS);
const pct = (wad: bigint) => `${wad < 0n ? "-" : ""}${formatUnitsAmount((wad < 0n ? -wad : wad) * 100n, 18)}%`;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const isPlanId = (id: string) => /^[0-9]+-[0-9]+$/.test(id);

/** The steps that open or add to a position: the ERC-8004 gate is checked before them (exits never wait for it). */
const OPENING_STEPS = new Set<Step["kind"]>(["lend_cash", "lend_stock", "post_collateral", "link", "borrow"]);

/** Whether a step took effect: what #measure reads went down for an exit or a repayment, up for the others. */
function stepMoved(s: Step, before: bigint, after: bigint): boolean {
  return s.kind === "redeem_cash" || s.kind === "repay" || s.kind === "close_carry" ? after < before : after > before;
}

/** Why a cash vault takes no deposit now: its problems, USDe's price, its collateral limits and what makes a run leave it. */
function whyNot(c: { problems: string[]; usdeProblem: string | null; collateralHolds: string[]; exitReasons: string[] }): string {
  return [...c.problems, ...(c.usdeProblem === null ? [] : [c.usdeProblem]), ...c.collateralHolds, ...c.exitReasons].join("; ");
}

/** What the collateral allows at the full LLTV, in USDG base units (debt / this = how far toward liquidation). */
function fullLimit(p: BorroPosition): bigint {
  return (((p.collateral * p.price) / 10n ** 36n) * p.stock.market.lltv) / WAD;
}

/** How long a read of USDe's price is used again (its feed answers about once a day: USDE_FEED_MAX_AGE). */
export const USDE_CACHE_MS = 5 * 60_000;

export class StrategyService {
  readonly #p: StrategyParts;
  #usdeCache: { at: number; value: { price: bigint; stale: boolean; age: bigint; feed: Address } | { error: string } } | null = null;

  constructor(p: StrategyParts) {
    this.#p = p;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The ERC-8004 gate
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * The agent's ERC-8004 identity, read in the Identity Registry: the creator vault must own it and be its
   * agentWallet. Throws StrategyGateError (with how to register) otherwise.
   */
  async gate(): Promise<{ agentId: string; creatorVault: Address }> {
    const creatorVault = getAddress(await this.#p.creator.vaultAddress());
    const ids: bigint[] = [];
    const recorded = await this.#p.agentId();
    if (recorded !== null && /^[0-9]+$/.test(recorded)) ids.push(BigInt(recorded));
    else {
      // Uncached: viem keeps a block number for its polling interval (4 s), and an identity registered within it
      // would be missed (seen on the fork, 24 Oct 2026).
      const to = await this.#p.logsClient.getBlockNumber({ cacheTime: 0 });
      ids.push(...(await agentIdsRegisteredBy(this.#p.logsClient, creatorVault, BigInt(this.#p.config.deployment.fromBlock), to)));
    }
    for (const id of ids) {
      const who = await readAgentIdentity(this.#p.client, id);
      if (who !== null && getAddress(who.owner) === creatorVault && getAddress(who.wallet) === creatorVault) return { agentId: id.toString(), creatorVault };
    }
    throw new StrategyGateError(
      `Ostra's strategies are for agents registered in the ERC-8004 Identity Registry through Ostra: the creator vault ${creatorVault} must own the agent's identity and be its agentWallet${ids.length === 0 ? " (it has none)" : ` (agent ${ids.map(String).join(", ")} is not)`}. Register with publish_profile (it registers the agent), then ask again.`,
    );
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------------------------------

  /** A JSON file of this folder, or undefined when it is missing or cannot be parsed (it is then rebuilt from the chain). */
  async #readJson<T>(name: string): Promise<T | undefined> {
    const text = await this.#p.folder.read(name);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  /**
   * The block a log cursor may be kept at after a scan up to `to`: LOG_RESCAN_BLOCKS under it, so the next scan reads
   * those blocks again (a node behind a load balancer may answer getLogs for blocks it does not have yet with nothing).
   */
  #cursor(to: bigint, previous: bigint): bigint {
    const c = to - LOG_RESCAN_BLOCKS;
    return c > previous ? c : previous;
  }

  /** Every Ostra vault of `token` (the factory's VaultCreated events, kept here and read on from the last block). */
  async ostraVaults(token: Address): Promise<Address[]> {
    const d = this.#p.config.deployment;
    const kept = (await this.#readJson<{ toBlock: string; vaults: { vault: Address; token: Address }[] }>(VAULTS_FILE)) ?? { toBlock: (BigInt(d.fromBlock) - 1n).toString(), vaults: [] };
    const to = await this.#p.logsClient.getBlockNumber({ cacheTime: 0 });
    const from = BigInt(kept.toBlock) + 1n;
    if (from <= to) {
      const found = await listOstraVaults(this.#p.logsClient, d.vaultFactory, from, to);
      for (const f of found) if (!kept.vaults.some((v) => getAddress(v.vault) === f.vault)) kept.vaults.push({ vault: f.vault, token: f.token });
      kept.toBlock = this.#cursor(to, BigInt(kept.toBlock)).toString();
      await this.#p.folder.write(VAULTS_FILE, JSON.stringify(kept));
    }
    const t = getAddress(token);
    return kept.vaults.filter((v) => getAddress(v.token) === t).map((v) => getAddress(v.vault));
  }

  /** A cash vault's cap ids (its cap events), kept here and read on from the last block. */
  async #capIds(vault: Address): Promise<Map<string, Hex>> {
    const name = `caps-${vault.toLowerCase()}.json`;
    const kept = (await this.#readJson<{ toBlock: string; ids: Record<string, Hex> }>(name)) ?? { toBlock: "-1", ids: {} };
    const to = await this.#p.logsClient.getBlockNumber({ cacheTime: 0 });
    const from = BigInt(kept.toBlock) + 1n;
    if (from <= to) {
      const found = await capIdsFromEvents(this.#p.logsClient, vault, from, to);
      for (const [id, data] of found) kept.ids[id] = data;
      kept.toBlock = this.#cursor(to, BigInt(kept.toBlock)).toString();
      await this.#p.folder.write(name, JSON.stringify(kept));
    }
    return new Map(Object.entries(kept.ids));
  }

  /**
   * The changes a cash vault's curator submitted (on the vault and its adapters) that are still pending at the
   * state's block: Submit events kept here and read on from the last block, each confirmed again by executableAt and
   * abdicated. A change whose state cannot be read now is kept as pending (it is never dropped on a failed read).
   */
  async pendingChanges(state: VaultV2State): Promise<PendingChange[]> {
    type Kept = { target: Address; selector: Hex; data: Hex; executableAt: string; abdicated: boolean };
    const name = `pending-${state.address.toLowerCase()}.json`;
    const kept = (await this.#readJson<{ toBlock: string; items: Kept[] }>(name)) ?? { toBlock: "-1", items: [] };
    const from = BigInt(kept.toBlock) + 1n;
    if (from <= state.at.blockNumber) {
      for (const p of await readPendingChanges(this.#p.logsClient, state, from)) {
        if (!kept.items.some((i) => getAddress(i.target) === getAddress(p.target) && i.data === p.data)) kept.items.push({ target: p.target, selector: p.selector, data: p.data, executableAt: p.executableAt.toString(), abdicated: p.abdicated });
      }
      kept.toBlock = this.#cursor(state.at.blockNumber, BigInt(kept.toBlock)).toString();
    }
    const still: Kept[] = [];
    for (const i of kept.items) {
      const bn = state.at.blockNumber;
      try {
        const at = await this.#p.client.readContract({ address: i.target, abi: timelockAbi, functionName: "executableAt", args: [i.data], blockNumber: bn });
        if (at === 0n) continue; // executed or revoked
        const ab = await this.#p.client.readContract({ address: i.target, abi: timelockAbi, functionName: "abdicated", args: [i.selector], blockNumber: bn });
        still.push({ ...i, executableAt: at.toString(), abdicated: ab });
      } catch (e) {
        if (isRevert(e)) continue; // a target without the timelock system: nothing can execute there
        still.push(i);
      }
    }
    kept.items = still;
    await this.#p.folder.write(name, JSON.stringify(kept));
    return still.map((i) => ({ target: getAddress(i.target), selector: i.selector, data: i.data, executableAt: BigInt(i.executableAt), abdicated: i.abdicated }));
  }

  /**
   * USDe's price from Chainlink's USDe / USD feed on Ethereum (sdk readUsdeUsd), or why it is not known (no Ethereum
   * client, the read failed). Read at most every USDE_CACHE_MS, a failure included.
   */
  async usde(): Promise<{ price: bigint; stale: boolean; age: bigint; feed: Address } | { error: string }> {
    if (this.#p.ethClient === null) return { error: "no Ethereum RPC is set" };
    // Read at most every USDE_CACHE_MS (the MCP's sweep checks each minute; Chainlink updates it about daily).
    const c = this.#usdeCache;
    if (c !== null && Date.now() - c.at < USDE_CACHE_MS) return c.value;
    // A failed read is kept as long: an Ethereum RPC that is down must not hold every minute's exit check up.
    let value: Awaited<ReturnType<StrategyService["usde"]>>;
    try {
      value = await readUsdeUsd(this.#p.ethClient);
    } catch (e) {
      value = { error: (e as Error).message.split("\n")[0] as string };
    }
    this.#usdeCache = { at: Date.now(), value };
    return value;
  }

  /**
   * Strategy 1's check of every cash vault (sdk checkCashVault, the worst case bounded with `planned` more in it), with
   * what the planner adds: a pending change that would make it fail the check once executed is a problem (sdk
   * pendingChangeProblems), and a vault whose caps can reach a USDe market takes no deposit unless USDe's price is
   * known, fresh and at least USDE_EXIT_PRICE (`usdeProblem`), nor while a collateral limit does not hold under its caps
   * now or once its pending cap increases are executed (sdk cashCollateralHolds: mGLO's share and NAV age,
   * `collateralHolds`). `ok`: no problem, no usdeProblem, no collateral hold and no exit reason. The 5% share limit is not
   * part of `ok`: a deposit is capped at `room` (cashVaultRoom) instead. A collateral hold, like usdeProblem, only stops
   * new deposits: what is held stays.
   */
  async cashVaults(
    planned = 0n,
    usde?: Awaited<ReturnType<StrategyService["usde"]>>,
  ): Promise<
    (CashVaultCheck & { room: bigint; pendingFine: string[]; pendingIgnored: string[]; usdeExposed: boolean; usdeProblem: string | null; collateralHolds: string[]; exitReasons: string[] })[]
  > {
    const holder = await this.#p.buyer.vaultAddress();
    const ostra = await this.ostraVaults(USDG);
    const out = [];
    let price = usde;
    const runs = await this.#runs();
    const now = await chainTime(this.#p.client);
    for (const v of CASH_VAULTS) {
      const c = await checkCashVault(this.#p.client, v, { capIds: await this.#capIds(v), holders: [holder], ostraVaults: ostra, planned });
      const pendingNow = await this.pendingChanges(c.state);
      const pending = pendingChangeProblems(c.state, c.caps, pendingNow);
      const problems = [...c.problems, ...pending.problems];
      const total = c.state.accruedTotalAssets + planned;
      const collateralHolds = [...(await cashCollateralHolds(this.#p.client, c.state, c.caps, total))];
      for (const x of await cashCollateralHolds(this.#p.client, c.state, capsAfterPending(c.state, c.caps, pendingNow), total)) {
        if (!collateralHolds.includes(x)) collateralHolds.push(`once its submitted cap increases are executed, ${x}`);
      }
      const usdeExposed = worstCaseExposure(c.state, c.caps, c.state.accruedTotalAssets + planned).markets.some((m) => getAddress(m.params.collateralToken) === USDE);
      let usdeProblem: string | null = null;
      if (usdeExposed) {
        price ??= await this.usde();
        if ("error" in price) usdeProblem = `its caps reach a USDe market and USDe's price is not known: ${price.error}`;
        else if (price.stale) usdeProblem = `its caps reach a USDe market and Chainlink's USDe / USD answer is ${price.age} s old`;
        else if (price.price < USDE_EXIT_PRICE) usdeProblem = `its caps reach a USDe market and USDe is at ${formatUnitsAmount(price.price, 18)} US dollars, under 0.995`;
      }
      // What makes each run leave it (design), so a plan does not enter what the next run would leave: USDe's price read
      // under the line while it lends against USDe (a price that cannot be read is not a reason to leave: a failing
      // Ethereum RPC must not empty the vault), its liquidity market 99% used, its share price under half its model.
      const exitReasons: string[] = [];
      const st = c.state;
      if (st.adapters.some((x) => x.kind === "market" && x.markets.some((m) => getAddress(m.params.collateralToken) === USDE && m.supplyAssets > 0n))) {
        price ??= await this.usde();
        if (!("error" in price) && price.price < USDE_EXIT_PRICE) exitReasons.push(`it lends against USDe, which is at ${formatUnitsAmount(price.price, 18)} US dollars, under 0.995`);
      }
      const lm = st.liquidityMarket;
      if (lm !== null && lm.expected !== null && utilization(lm.expected) >= LIQUIDITY_EXIT_UTILIZATION) exitReasons.push("its liquidity market is 99% used or more");
      const prev = [...runs].reverse().find((r) => now - BigInt(r.at) >= 3n * DAY && r.cash.some((x) => x.vault === c.vault));
      const pc = prev?.cash.find((x) => x.vault === c.vault);
      if (prev !== undefined && pc !== undefined && shareGrowthTooLow({ price: BigInt(pc.sharePrice), at: BigInt(prev.at), modelApy: BigInt(pc.modelApy) }, { price: c.sharePrice, at: now }) === true) {
        exitReasons.push("its share price grew less than half of its model over the last 3 days or more");
      }
      out.push({
        ...c,
        ok: problems.length === 0 && usdeProblem === null && collateralHolds.length === 0 && exitReasons.length === 0,
        problems,
        room: cashVaultRoom(c),
        pendingFine: pending.fine,
        pendingIgnored: pending.ignored,
        usdeExposed,
        usdeProblem,
        collateralHolds,
        exitReasons,
      });
    }
    return out;
  }

  /**
   * USDG the USDG vault sent out over the last BUFFER_DAYS days: its Transfers to anything but where Ostra's strategies
   * put money (cash vaults, Borro's vaults, BorroBuilders, Morpho Blue).
   */
  async spentLastDays(): Promise<bigint> {
    const vault = await this.#p.buyer.vaultAddress();
    const now = await this.#p.client.getBlock();
    const since = now.timestamp - BUFFER_DAYS * DAY;
    // The first block at or after `since`, by bisection over block timestamps.
    let lo = 0n;
    let hi = now.number;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const b = await this.#p.client.getBlock({ blockNumber: mid });
      if (b.timestamp < since) lo = mid + 1n;
      else hi = mid;
    }
    const logs = await getLogsChunked(this.#p.logsClient, { address: USDG, event: transferEvent, args: { from: vault }, fromBlock: lo, toBlock: now.number });
    const internal = new Set([...CASH_VAULTS, BORRO_USDG_VAULT, BORRO_BUILDERS, MORPHO_BLUE].map((a) => getAddress(a)));
    let spent = 0n;
    for (const l of logs) {
      const a = l.args as { to: Address; value: bigint };
      if (!internal.has(getAddress(a.to))) spent += a.value;
    }
    return spent;
  }

  /**
   * What the agent's vaults hold for the strategies: USDG, cash vault shares, and per Borro stock its vault, what it
   * holds (less the trading capital's tokens) and its position.
   */
  async holdings(): Promise<{
    buyer: Address;
    usdg: bigint;
    cash: { vault: Address; shares: bigint; value: bigint }[];
    stocks: { stock: BorroStock; vault: Address; exists: boolean; balance: bigint; position: BorroPosition | null }[];
    /** Stocks whose vault or position could not be read now (they are left out of `stocks`). */
    errors: string[];
  }> {
    const d = this.#p.config.deployment;
    const buyer = getAddress(await this.#p.buyer.vaultAddress());
    const usdg = (await readVault(this.#p.client, d, buyer)) === null ? 0n : await tokenBalance(this.#p.client, USDG, buyer);
    const cash = [];
    for (const v of CASH_VAULTS) {
      const shares = (await this.#p.client.readContract({ address: v, abi: vaultV2Abi, functionName: "balanceOf", args: [buyer] })) as bigint;
      const value = shares === 0n ? 0n : ((await this.#p.client.readContract({ address: v, abi: vaultV2Abi, functionName: "previewRedeem", args: [shares] })) as bigint);
      cash.push({ vault: v, shares, value });
    }
    const stocks = [];
    const errors: string[] = [];
    // The trading capital's tokens are its own: a carry does not lend them.
    const traded = (await this.#p.trading?.heldTokens()) ?? new Map<Address, bigint>();
    for (const s of borroStocks()) {
      try {
        const vault = getAddress(await this.#p.tokenVault(s.token).vaultAddress());
        const exists = (await readVault(this.#p.client, d, vault)) !== null;
        const held = exists ? await tokenBalance(this.#p.client, s.token, vault) : 0n;
        const capital = traded.get(getAddress(s.token)) ?? 0n;
        const balance = held > capital ? held - capital : 0n;
        const position = exists ? await readBorroPosition(this.#p.client, vault, s) : null;
        stocks.push({ stock: s, vault, exists, balance, position });
      } catch (e) {
        errors.push(`${s.symbol}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    return { buyer, usdg, cash, stocks, errors };
  }

  /** Whether the NYSE is closed at `time` (OstraFees.nyseClosed). */
  async #nyseClosed(time: bigint): Promise<boolean> {
    const fees = this.#p.config.deployment.launchpad?.fees ?? OSTRA_FEES_MAINNET;
    return (await this.#p.client.readContract({ address: fees, abi: feesAbi, functionName: "nyseClosed", args: [time] })) as boolean;
  }

  /** A closure (weekend, holiday) now or within EVENT_LOOKAHEAD, or an earnings report within it (NVDA without a date: always). */
  async #eventWindow(symbol: string, now: bigint, earnings?: Readonly<Record<string, bigint>>): Promise<boolean> {
    if ((await this.#nyseClosed(now)) || (await this.#nyseClosed(now + EVENT_LOOKAHEAD))) return true;
    const e = earnings?.[symbol];
    if (e === undefined) return symbol === "NVDA";
    return now + EVENT_LOOKAHEAD >= e && now <= e + DAY;
  }

  /** The age of the oldest price feed behind a Borro stock's oracle, in seconds (a very large age when none can be read). */
  async #feedAge(stock: BorroStock, now: bigint): Promise<bigint> {
    const o = await readOracle(this.#p.client, stock.market.oracle);
    const feeds = [...o.baseFeeds, ...o.quoteFeeds];
    if (feeds.length === 0 || feeds.some((f) => f.updatedAt === null)) return 10n ** 9n;
    return feeds.map((f) => now - (f.updatedAt as bigint)).reduce((a, b) => (a > b ? a : b));
  }

  /** The loan's rate per year right after borrowing `loan` more on the stock's market (design: r_b(u') from the rate at target now). */
  async #rateAfter(stock: BorroStock, loan: bigint): Promise<bigint> {
    const m = await readMorphoMarket(this.#p.client, stock.marketId, await blockTime(this.#p.client));
    if (m.expected === null) throw new Error(`the ${stock.symbol} market is not on the AdaptiveCurveIrm`);
    return instantBorrowRate({ totalSupplyAssets: m.expected.totalSupplyAssets, totalBorrowAssets: m.expected.totalBorrowAssets + loan }, m.nextRateAtTarget) * YEAR;
  }

  /** The cash yield now: the best modelled yield of the cash vaults that pass every check. */
  async #cashApy(): Promise<bigint> {
    return (await this.cashVaults()).filter((c) => c.ok).reduce((a, c) => (c.modelApy > a ? c.modelApy : a), 0n);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------------------------------------------------

  /** A step's cost now: simulated when it can run now, else at MEASURED_MORPHO_SPEND_GAS (it runs after steps before it). */
  async #cost(what: string, action: number, params: Hex, label: string, dependent: boolean): Promise<bigint> {
    if (!dependent) return (await this.#p.borro.spendCost(what, action, params, label)).usdg;
    return (await this.#p.borro.spendCostAt(what, action, params, MEASURED_MORPHO_SPEND_GAS)).usdg;
  }

  /**
   * A conservative plan and, when a carry may open, a balanced one, for what the agent's vaults hold now (see the file
   * comment). Throws StrategyGateError for an agent that is not registered. Nothing is signed; the plans are kept for
   * apply().
   */
  async plan(o: PlanOptions = {}): Promise<Plan[]> {
    await this.gate();
    const now = await chainTime(this.#p.client);
    const h = await this.holdings();
    if (h.errors.length > 0) throw new Error(`the vaults could not all be read now (${h.errors.join("; ")}): nothing was planned; ask again`);
    const buffer = o.buffer ?? (await this.spentLastDays());
    const kept = (await this.#p.trading?.kept()) ?? null;
    const tradingCapital = kept === null ? 0n : await (this.#p.trading as TradingService).reservedCash();
    // The idle reserve of the carries open now stays in the USDG vault too (the 70% step repays from it).
    const existingDebt = h.stocks.reduce((a, s) => a + (s.position?.debt ?? 0n), 0n);
    const reserved = buffer + tradingCapital + carryIdleReserve(existingDebt);
    const free = depositable(h.usdg, reserved);

    const checks = await this.cashVaults(free);
    const best = checks.filter((c) => c.ok).reduce<(typeof checks)[number] | null>((a, c) => (a === null || c.modelApy > a.modelApy ? c : a), null);
    const cashApy = best?.modelApy ?? 0n;
    const room = best === null ? 0n : best.room;
    const risks = ["Ostra and Borro are not audited; Morpho Blue and Vault V2 are.", "A cash vault pays out only up to its free liquidity; its curator can move funds within its caps without a timelock."];
    for (const c of checks) if (!c.ok) risks.push(`${c.vault} is not used now: ${whyNot(c)}`);
    const stopWhen = [
      "a cash vault fails a check (sdk checkCashVault), a change to it is submitted, its share price grows less than half of its model over 3 days, it lends against USDe while Chainlink's USDe / USD price is under 0.995, or its liquidity market is 99% used: it is redeemed (an emergency redeem of what it can pay out); all Ostra vaults holding more than 5% of what it can pay out: the excess is redeemed",
      "a carry reaches 70% of the LLTV (60% for NVDA around a closure or earnings): back to its opening level; 85%: repaid in full; its rate averaged over two runs above the cash yield less 1 point: repaid in full; its market past 90% use: the excess repaid",
    ];
    const breaker = await this.#breakerNote();
    const trading = kept === null ? null : { capital: usd(kept.capital), cash: usd(tradingCapital), cashUnits: tradingCapital.toString(), limits: kept.limits };
    const make = (profile: Plan["profile"], steps: Step[], keep: bigint, earn30: bigint, cost: bigint, extra: string[]): Plan => ({
      id: `${Number(now)}-${randomInt(0, 2 ** 30)}`,
      profile,
      at: Number(now),
      steps,
      keep: keep.toString(),
      expected30d: usd(earn30 - cost),
      cashApy: pct(cashApy),
      trading,
      risks: [...risks, ...extra],
      stopWhen,
      breaker,
    });

    // Moves: cash held in a vault that passes its checks but pays more than 1 point less than the best one moves there
    // when 7 days of the difference earn over 3x the gas (a vault that fails a check is left by check(), at once).
    const moves: Step[] = [];
    const consNotes: string[] = [];
    let moved = 0n;
    let moveEarn = 0n;
    let moveCost = 0n;
    if (best !== null) {
      for (const held of h.cash) {
        const c = checks.find((x) => x.vault === held.vault);
        if (held.shares === 0n || held.vault === best.vault || c === undefined || !c.ok) continue;
        const spread = cashApy - c.modelApy;
        if (spread <= MOVE_MIN_SPREAD) continue;
        const x = await this.#cost("USDG", VAULT_ACTION.REDEEM, redeemParams({ vault: held.vault, shares: held.shares, minAssets: 0n }), "the cash redeem", false);
        const lendCost = await this.#cost("USDG", VAULT_ACTION.LEND, lendParams({ vault: best.vault, assets: held.value, minShares: 0n }), "the cash lend", true);
        const gain7 = yieldOver(held.value, spread, MOVE_HORIZON);
        if (!worthIt(gain7, x + lendCost)) {
          consNotes.push(`moving ${usd(held.value)} USDG from ${held.vault} to ${best.vault} earns ${usd(gain7)} in 7 days, not over 3x its gas: left where it is`);
          continue;
        }
        moves.push({ kind: "redeem_cash", what: "USDG", vault: held.vault, amount: "all", urgent: false, notBefore: 0, cost: x.toString(), reason: `move ${usd(held.value)} USDG from ${held.vault} (${pct(c.modelApy)}) to ${best.vault} (${pct(cashApy)})` });
        moved += held.value;
        moveEarn += yieldOver(held.value, spread, STEP_HORIZON);
        moveCost += x;
      }
    }

    // Conservative: the USDG over the buffer and the trading capital (and what the moves redeem) to the best cash vault.
    const tCons = Number(now) + randomInt(0, JITTER_MAX_SECONDS);
    const cons: Step[] = moves.map((m) => ({ ...m, notBefore: tCons }));
    let consEarn = moveEarn;
    let consCost = moveCost;
    const lendNow = min(free + moved, room);
    if (best !== null && lendNow > 0n) {
      const c = await this.#cost("USDG", VAULT_ACTION.LEND, lendParams({ vault: best.vault, assets: lendNow, minShares: 0n }), "the cash lend", moved > 0n);
      const gain = yieldOver(min(free, lendNow), cashApy, STEP_HORIZON);
      if (worthIt(gain + moveEarn, c + moveCost)) {
        cons.push({ kind: "lend_cash", what: "USDG", vault: best.vault, amount: "free", urgent: false, notBefore: tCons, cost: c.toString(), reason: `${usd(lendNow)} USDG over the ${usd(reserved)} kept to ${best.vault} at ${pct(cashApy)} a year: ${usd(gain + moveEarn)} USDG more in 30 days against ${usd(c + moveCost)} of gas` });
        consEarn += gain;
        consCost += c;
      } else {
        consNotes.push(`lending ${usd(lendNow)} USDG earns ${usd(gain)} in 30 days, not over 3x its gas of ${usd(c)}: left out`);
        cons.length = 0;
        consEarn = 0n;
        consCost = 0n;
      }
    } else if (best !== null && free > 0n) consNotes.push(`${best.vault} has no room for more Ostra deposits now`);
    const plans: Plan[] = [make("conservative", cons, reserved, consEarn, consCost, consNotes)];

    // Balanced: a carry of each carry stock the agent holds (Strategy 2); the loans go to the cash vault less the idle
    // reserve the 70% step repays from, in one lend after them.
    if (best !== null) {
      const t0 = Number(now) + randomInt(0, JITTER_MAX_SECONDS);
      // The moves only when the conservative plan found them worth their gas with its lend.
      const movesUsed = cons.length > 0 ? moves : [];
      const steps: Step[] = movesUsed.map((m) => ({ ...m, notBefore: t0 }));
      const notes: string[] = [];
      let roomLeft = room - lendNow;
      let loans = 0n;
      let carryEarn = 0n;
      let carryCost = 0n;
      let interest30 = 0n;
      const marketClosed = await this.#nyseClosed(now);
      const buyerLocked = (await readVaultGuard(this.#p.client, h.buyer)).lockedSince !== 0n;
      for (const s of h.stocks) {
        if (CARRY_OPEN_OF_LLTV_BPS[s.stock.symbol] === undefined || !s.exists || s.position === null) continue;
        const p = s.position;
        if (s.balance === 0n && p.shares === 0n && p.collateral === 0n) continue;
        if (!p.listed) {
          notes.push(`${s.stock.symbol} carry not opened: Borro no longer lists its market`);
          continue;
        }
        const guard = await readVaultGuard(this.#p.client, s.vault);
        if (guard.lockedSince !== 0n && !buyerLocked) {
          notes.push(`${s.stock.symbol} carry not opened: the stock vault is locked and the USDG vault is not (lock the USDG vault first, vault_lock)`);
          continue;
        }
        if (guard.linkedVault !== h.buyer && guard.lockedSince !== 0n) {
          notes.push(`${s.stock.symbol} carry not opened yet: the locked stock vault's link to the USDG vault waits its lock's delay (vault_link first)`);
          continue;
        }
        // The collateral after the steps: the shares posted, the shares lent, and the shares the stock lent now buys.
        const newShares = s.balance === 0n ? 0n : ((await this.#p.client.readContract({ address: s.stock.vault, abi: vaultV2Abi, functionName: "previewDeposit", args: [s.balance] })) as bigint);
        const collateral = p.collateral + p.shares + newShares;
        const collateralValue = (collateral * p.price) / 10n ** 36n;
        const target = min(carryTarget({ symbol: s.stock.symbol, collateralValue, lltv: s.stock.market.lltv, supply: p.supply, borrowed: p.borrowed, debt: p.debt }), halfLltvMaxDebt(collateral, p.price, s.stock.market.lltv));
        let loan = target > p.debt ? target - p.debt : 0n;
        if (loan > p.available) loan = p.available;
        if (loan === 0n) {
          notes.push(`${s.stock.symbol} carry: no loan to add (its debt is at its target, or the market has no room under 90% use)`);
          continue;
        }
        const rate = await this.#rateAfter(s.stock, loan);
        const ok = carryMayOpen({ symbol: s.stock.symbol, marketClosed, feedAge: await this.#feedAge(s.stock, now), borrowRate: rate, cashApy });
        if (!ok.ok) {
          notes.push(`${s.stock.symbol} carry not opened: ${ok.reason}`);
          continue;
        }
        const own: Step[] = [];
        let c = 0n;
        if (s.balance > 0n) {
          const x = await this.#cost(s.stock.symbol, VAULT_ACTION.LEND, lendParams({ vault: s.stock.vault, assets: s.balance, minShares: 0n }), `the ${s.stock.symbol} lend`, false);
          own.push({ kind: "lend_stock", what: s.stock.symbol, amount: s.balance.toString(), urgent: false, notBefore: t0, cost: x.toString(), reason: `lend the ${formatUnitsAmount(s.balance, 18)} ${s.stock.symbol} to Borro's ${s.stock.symbol} vault` });
          c += x;
        }
        if (s.balance > 0n || p.shares > 0n) {
          const x = await this.#cost(s.stock.symbol, VAULT_ACTION.POST_COLLATERAL, postCollateralParams({ market: s.stock.market, shares: p.shares + newShares }), `the ${s.stock.symbol} collateral`, s.balance > 0n);
          own.push({ kind: "post_collateral", what: s.stock.symbol, amount: "all", urgent: false, notBefore: t0, cost: x.toString(), reason: "post every share as collateral" });
          c += x;
        }
        if (guard.linkedVault !== h.buyer) {
          const x = await this.#cost(s.stock.symbol, VAULT_ACTION.SET_LINKED_VAULT, setLinkedVaultParams(h.buyer), `the ${s.stock.symbol} vault's link`, false);
          own.push({ kind: "link", what: s.stock.symbol, amount: "0", urgent: false, notBefore: t0, cost: x.toString(), reason: "link the stock vault to the USDG vault (a loan is paid only to the linked vault)" });
          c += x;
        }
        const x = await this.#cost(s.stock.symbol, VAULT_ACTION.BORROW, borrowParams({ market: s.stock.market, assets: loan }), `the ${s.stock.symbol} loan`, true);
        own.push({ kind: "borrow", what: s.stock.symbol, amount: loan.toString(), urgent: false, notBefore: t0, cost: x.toString(), reason: `borrow ${usd(loan)} USDG at about ${pct(rate)} a year into the USDG vault (opening at ${CARRY_OPEN_OF_LLTV_BPS[s.stock.symbol]} bps of the LLTV)` });
        c += x;
        const deposited = min(loan - min(loan, carryIdleReserve(loan)), roomLeft);
        const gain = yieldOver(deposited, cashApy, STEP_HORIZON) - yieldOver(loan, rate, STEP_HORIZON);
        if (!worthIt(gain, c)) {
          notes.push(`${s.stock.symbol} carry of ${usd(loan)} USDG earns ${usd(gain)} in 30 days net of its interest, not over 3x its gas of ${usd(c)}: left out`);
          continue;
        }
        steps.push(...own);
        roomLeft -= deposited;
        loans += loan;
        interest30 += yieldOver(loan, rate, STEP_HORIZON);
        carryCost += c;
      }
      // The one lend after the loans: what it really deposits decides what the carries earn (their loans less the idle
      // reserve, within the vault's room, after what the conservative plan would lend anyway).
      const idle = carryIdleReserve(existingDebt + loans);
      const keep = buffer + tradingCapital + idle;
      const movedHere = movesUsed.length > 0 ? moved : 0n;
      const amount = min(depositable(h.usdg + movedHere + loans, keep), room);
      const base = min(depositable(h.usdg + movedHere, reserved), amount);
      carryEarn = yieldOver(amount - base, cashApy, STEP_HORIZON) - interest30;
      const lendCost = loans > 0n && amount > 0n ? await this.#cost("USDG", VAULT_ACTION.LEND, lendParams({ vault: best.vault, assets: amount, minShares: 0n }), "the cash lend", true) : 0n;
      if (loans > 0n && (amount === 0n || !worthIt(carryEarn, carryCost + lendCost))) {
        notes.push(`the carries would deposit ${usd(amount - base)} USDG (the cash vault's room ${usd(room)}), earning ${usd(carryEarn)} in 30 days net of ${usd(interest30)} of interest, not over 3x their gas of ${usd(carryCost + lendCost)}: left out`);
        loans = 0n;
      }
      if (loans > 0n) {
        const c = lendCost;
        steps.push({ kind: "lend_cash", what: "USDG", vault: best.vault, amount: "free", urgent: false, notBefore: t0, cost: c.toString(), reason: `${usd(amount)} USDG to ${best.vault} at ${pct(cashApy)} a year, keeping ${usd(keep)} (${usd(idle)} of it idle for the carry's 70% step)` });
        carryCost += c;
        // What the conservative plan earns (its moves and its lend) is earned here too, in the same lend.
        carryEarn += movesUsed.length > 0 || cons.length > 0 ? consEarn : yieldOver(base, cashApy, STEP_HORIZON);
        carryCost += movesUsed.length > 0 ? moveCost : 0n;
        plans.push(
          make("balanced", steps, keep, carryEarn, carryCost, [
            ...notes,
            "Borro's stock vaults lend their shares to short sellers against steakUSDG: a carry is exposed to that market's credit; a loss liquidation does not cover falls on the market's lenders.",
            "Chainlink's stock feeds stop over weekends and holidays: a carry is not opened then, and NVDA stays at most 60% of its LLTV around a closure.",
          ]),
        );
      } else (plans[0] as Plan).risks.push(...notes);
    }
    const dir = this.#p.folder.folder(PLANS_DIR);
    await dir.ensure();
    for (const p of plans) await dir.write(`${p.id}.json`, JSON.stringify(p));
    return plans;
  }

  /** What a plan says of Strategy 3: whether OstraBreaker watches the USDG vault's cash vaults now, and what acts if not. */
  async #breakerNote(): Promise<string> {
    const b = this.#p.breaker ?? null;
    const runs = "the agent's own runs act (each minute while the MCP server runs, and at least daily; on Friday before 18:00 UTC and Monday after 00:00 UTC while a carry is open)";
    if (b === null || b.address === null) return `OstraBreaker is not deployed on this deployment: ${runs}.`;
    try {
      const s = await b.status();
      const watched = s.watches.filter((w) => w.watched).map((w) => w.target);
      if (s.locked && watched.length > 0) return `OstraBreaker ${s.breaker} watches ${watched.join(", ")} for this vault: when a limit is crossed on chain (share price, a run, its liquidity market's use, what it can pay out), anyone, Ostra's breaker keeper first, redeems the shares back into the vault; ${runs} as well.`;
      if (s.locked) return `the vault's withdrawal lock is on but OstraBreaker does not watch its cash vaults (it is set up before the lock, which then has to be turned off first): ${runs}.`;
      return `OstraBreaker acts only under the vault's withdrawal lock, which is off: ${runs}. Turning the lock on (vault_lock) sets the breaker up first.`;
    } catch (e) {
      return `OstraBreaker could not be read now (${(e as Error).message.split("\n")[0]}): ${runs}.`;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Running a plan
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Runs plan `id`'s steps that are due, in order, each checked and sized again right before it is signed (the gate for
   * the steps that open a position, the cash vault's check, the carry's opening rules) and its effect read back after
   * it lands. Stops at the first step that waits or does not take effect; call again to go on. A step whose sending was
   * interrupted (the process stopped after it was sent) is found by its effect and not sent again.
   */
  async apply(id: string, o: PlanOptions = {}): Promise<{ done: StepOutcome[]; next: { step: number; notBefore: number } | null; note?: string }> {
    if (!isPlanId(id)) throw new RangeError("not a plan id");
    const dir = this.#p.folder.folder(PLANS_DIR);
    const file = `${id}.json`;
    const text = await dir.read(file);
    if (text === undefined) throw new Error(`no plan ${id}: plan again`);
    let plan: Plan & { inFlight?: { step: number; before: string } };
    try {
      plan = JSON.parse(text) as Plan & { inFlight?: { step: number; before: string } };
    } catch {
      throw new Error(`plan ${id} cannot be read: plan again`);
    }
    const done: StepOutcome[] = [];
    const now = Number(await chainTime(this.#p.client));
    let gated = false;
    for (let i = plan.doneSteps ?? 0; i < plan.steps.length; i++) {
      const s = plan.steps[i] as Step;
      if (!s.urgent && now < s.notBefore) return { done, next: { step: i, notBefore: s.notBefore } };
      if (OPENING_STEPS.has(s.kind) && !gated) {
        await this.gate();
        gated = true;
      }
      const before = await this.#measure(s);
      if (plan.inFlight?.step === i && stepMoved(s, BigInt(plan.inFlight.before), before)) {
        done.push({ step: i, kind: s.kind, what: s.what, landed: true, note: "it had landed before the process stopped" });
      } else {
        plan.inFlight = { step: i, before: before.toString() };
        await dir.write(file, JSON.stringify(plan));
        const out = await this.#runStep(s, before, await this.#keepNow(plan), o);
        done.push({ step: i, kind: s.kind, what: s.what, ...out });
        if (!out.landed) {
          delete plan.inFlight;
          await dir.write(file, JSON.stringify(plan));
          return { done, next: { step: i, notBefore: now }, note: out.note ?? "the step did not take effect: call again" };
        }
      }
      delete plan.inFlight;
      plan.doneSteps = i + 1;
      await dir.write(file, JSON.stringify(plan));
    }
    return { done, next: null };
  }

  /** A plan's keep now: the trading capital's cash as it is now in place of what it was when the plan was made. */
  async #keepNow(plan: Plan): Promise<bigint> {
    const was = BigInt(plan.trading?.cashUnits ?? "0");
    const now = this.#p.trading === undefined || this.#p.trading === null ? 0n : await this.#p.trading.reservedCash();
    const k = BigInt(plan.keep) - was + now;
    return k > 0n ? k : 0n;
  }

  /** What a step changes, read on-chain: cash vault shares, Borro shares, collateral, the link, or borrow shares. */
  async #measure(s: Step): Promise<bigint> {
    const buyer = getAddress(await this.#p.buyer.vaultAddress());
    if (s.kind === "lend_cash" || s.kind === "redeem_cash") return (await this.#p.client.readContract({ address: s.vault as Address, abi: vaultV2Abi, functionName: "balanceOf", args: [buyer] })) as bigint;
    const stock = borroStocks().find((x) => x.symbol === s.what);
    if (stock === undefined) throw new RangeError(`${s.what} is not a Borro stock`);
    const vault = await this.#p.tokenVault(stock.token).vaultAddress();
    if (s.kind === "link") return (await readVaultGuard(this.#p.client, vault)).linkedVault === buyer ? 1n : 0n;
    const p = await readBorroPosition(this.#p.client, vault, stock);
    if (s.kind === "lend_stock") return p.shares;
    if (s.kind === "post_collateral") return p.collateral;
    return p.borrowShares;
  }

  async #runStep(s: Step, before: bigint, keep: bigint, o: PlanOptions): Promise<{ landed: boolean; result?: VaultOperationResult; skipped?: string; note?: string }> {
    let result: VaultOperationResult;
    const buyer = await this.#p.buyer.vaultAddress();
    switch (s.kind) {
      case "lend_cash": {
        const usdg = await tokenBalance(this.#p.client, USDG, buyer);
        const wanted = s.amount === "free" ? depositable(usdg, keep) : BigInt(s.amount);
        const c = (await this.cashVaults(wanted)).find((x) => x.vault === s.vault);
        if (c === undefined || !c.ok) throw new Error(`${s.vault} does not pass Strategy 1's check now: ${c === undefined ? "not a cash vault" : whyNot(c)}; nothing was signed`);
        const amount = min(wanted, c.room);
        if (amount === 0n) return { landed: true, skipped: wanted === 0n ? "nothing to lend now" : "the cash vault has no room for more Ostra deposits now (5% of what it can pay out)" };
        result = await this.#p.borro.lendCash(c.vault, amount);
        break;
      }
      case "redeem_cash":
        if (before === 0n) return { landed: true, skipped: "no shares held" };
        result = await this.#p.borro.redeemCash(s.vault as Address, s.amount === "all" ? before : min(BigInt(s.amount), before), s.urgent);
        break;
      case "lend_stock": {
        const stock = borroStocks().find((x) => x.symbol === s.what) as BorroStock;
        const held = await tokenBalance(this.#p.client, stock.token, await this.#p.tokenVault(stock.token).vaultAddress());
        // Not the trading capital's tokens, which it may have bought since the plan.
        const capital = (await this.#p.trading?.heldTokens())?.get(getAddress(stock.token)) ?? 0n;
        const amount = min(BigInt(s.amount), held > capital ? held - capital : 0n);
        if (amount === 0n) return { landed: true, skipped: `the vault holds no ${s.what} now beyond the trading capital's` };
        result = await this.#p.borro.lend(s.what, formatUnitsAmount(amount, 18));
        break;
      }
      case "post_collateral": {
        const stock = borroStocks().find((x) => x.symbol === s.what) as BorroStock;
        const held = (await this.#p.client.readContract({ address: stock.vault, abi: vaultV2Abi, functionName: "balanceOf", args: [await this.#p.tokenVault(stock.token).vaultAddress()] })) as bigint;
        if (held === 0n) return { landed: true, skipped: `no shares of Borro's ${s.what} vault to post` };
        result = await this.#p.borro.postCollateral(s.what, "all");
        break;
      }
      case "link": {
        if (before === 1n) return { landed: true, skipped: "already linked" };
        const stock = borroStocks().find((x) => x.symbol === s.what) as BorroStock;
        const g = await readVaultGuard(this.#p.client, await this.#p.tokenVault(stock.token).vaultAddress());
        if (g.pendingLink !== null && g.pendingLink.vault === getAddress(buyer)) return { landed: false, note: `the link to the USDG vault takes effect at ${new Date(Number(g.pendingLink.at) * 1000).toISOString()} (the lock's delay): call again then` };
        result = await this.#p.borro.setLink(s.what, buyer);
        break;
      }
      case "borrow": {
        const stock = borroStocks().find((x) => x.symbol === s.what) as BorroStock;
        const p = await readBorroPosition(this.#p.client, await this.#p.tokenVault(stock.token).vaultAddress(), stock);
        const now = await chainTime(this.#p.client);
        // Sized again: the target at the price and the market read now, the vault's half-LLTV cap, an event's limit.
        const value = (p.collateral * p.price) / 10n ** 36n;
        let target = min(carryTarget({ symbol: s.what, collateralValue: value, lltv: stock.market.lltv, supply: p.supply, borrowed: p.borrowed, debt: p.debt }), p.maxDebt);
        const eventMax = CARRY_EVENT_MAX_OF_LLTV_BPS[s.what];
        if (eventMax !== undefined && (await this.#eventWindow(s.what, now, o.earnings))) target = min(target, (fullLimit(p) * eventMax) / BPS);
        const amount = min(min(BigInt(s.amount), target > p.debt ? target - p.debt : 0n), p.available);
        if (amount === 0n) return { landed: true, skipped: "no room for the loan now (its target, the vault's half-LLTV cap or the market's liquidity)" };
        const ok = carryMayOpen({ symbol: s.what, marketClosed: await this.#nyseClosed(now), feedAge: await this.#feedAge(stock, now), borrowRate: await this.#rateAfter(stock, amount), cashApy: await this.#cashApy() });
        if (!ok.ok) throw new Error(`the ${s.what} carry may not open now: ${ok.reason}; nothing was signed`);
        result = await this.#p.borro.borrow(s.what, formatUnitsAmount(amount, TOKEN_DECIMALS));
        break;
      }
      case "repay":
      case "close_carry": {
        if (before === 0n) return { landed: true, skipped: "no debt" };
        // Within what the USDG vault holds: the whole debt (by its shares, with BORRO_REPAY_BUFFER_BPS for the interest
        // until it lands) only when that is covered; otherwise as much as it holds, and the rest at the next run.
        const stock = borroStocks().find((x) => x.symbol === s.what) as BorroStock;
        const p = await readBorroPosition(this.#p.client, await this.#p.tokenVault(stock.token).vaultAddress(), stock);
        const usdg = await tokenBalance(this.#p.client, USDG, buyer);
        const whole = s.kind === "close_carry" || s.amount === "all" || BigInt(s.amount) >= p.debt;
        const wholeNeeds = p.debt + (p.debt * BORRO_REPAY_BUFFER_BPS) / BPS + 1n;
        if (whole && usdg >= wholeNeeds) result = await this.#p.borro.repay(s.what, "all");
        else {
          const want = whole ? p.debt : BigInt(s.amount);
          // Under the debt, or BorroService would repay by shares and need the buffer.
          const amount = min(min(want, usdg), p.debt - 1n);
          if (amount <= 0n) return { landed: false, note: `the USDG vault holds ${usd(usdg)} USDG: nothing to repay ${s.what}'s debt of ${usd(p.debt)} with` };
          result = await this.#p.borro.repay(s.what, formatUnitsAmount(amount, TOKEN_DECIMALS));
        }
        break;
      }
    }
    if (result.status !== "sent") return { landed: false, result, note: `a spend signed earlier was sent first (${result.note}); call again` };
    if (!stepMoved(s, before, await this.#measure(s))) return { landed: false, result, note: "the transaction landed but did not change the position (a Morpho spend that failed inside the vault, or a link that waits the lock's delay): call again" };
    return { landed: true, result };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Each run's check
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * What every run of the agent looks at (design, Strategy 1 and 2), and the actions it calls for. `execute`: urgent
   * actions (leaving a cash vault, the ladder's repayments) run at once, no jitter. The actions that are not urgent are
   * kept as a plan (`plan`) whose steps wait a random delay, for apply(). The run is recorded for report() and for the
   * next run's rate and share-price comparisons. It is not gated (exits and repayments must never be blocked), and the
   * cash checks and the carry ladder run apart: a failure in one is a finding, the other still runs.
   */
  async check(o: PlanOptions & { execute?: boolean } = {}): Promise<{
    findings: string[];
    actions: Step[];
    plan: string | null;
    results: { kind: Step["kind"]; what: string; landed?: boolean; result?: VaultOperationResult; skipped?: string; note?: string; error?: string }[];
  }> {
    const now = await chainTime(this.#p.client);
    const block = await this.#p.client.getBlockNumber({ cacheTime: 0 });
    const h = await this.holdings();
    const runs = await this.#runs();
    const last = runs.at(-1);
    const findings: string[] = [];
    const actions: Step[] = [];
    const record: RunRecord = { at: Number(now), block: block.toString(), cash: [], carry: [] };
    for (const e of h.errors) findings.push(`a stock vault could not be read now (its carry is checked at the next run): ${e}`);
    // The cash yield the carry's rate rule compares with: the best of the cash vaults with no problem of their own
    // (USDe's price unknown or the share limit stop new deposits, not the yield of what is held). Null: not known now.
    let cashApy: bigint | null = null;
    const withdrawable = new Map<Address, bigint>();
    try {
      const usde = await this.usde();
      const checks = await this.cashVaults(0n, usde);
      if ("error" in usde) findings.push(`USDe's price is not known: ${usde.error}`);
      else findings.push(`USDe at ${formatUnitsAmount(usde.price, 18)} US dollars (Chainlink USDe / USD on Ethereum, ${usde.age} s old${usde.stale ? ", stale" : ""})`);
      cashApy = checks.filter((c) => c.problems.length === 0 && c.exitReasons.length === 0).reduce((a, c) => (c.modelApy > a ? c.modelApy : a), 0n);
      for (const c of checks) {
        withdrawable.set(c.vault, c.withdrawable);
        const held = h.cash.find((x) => x.vault === c.vault);
        const v = c.state;
        const settings: Record<string, string> = {
          performanceFee: v.performanceFee.toString(),
          managementFee: v.managementFee.toString(),
          maxRate: v.maxRate.toString(),
          liquidityAdapter: v.liquidityAdapter,
          liquidityData: v.liquidityData,
          adapters: v.adapters.map((x) => x.address).join(","),
          owner: v.owner,
          curator: v.curator,
        };
        record.cash.push({ vault: c.vault, sharePrice: c.sharePrice.toString(), modelApy: c.modelApy.toString(), held: (held?.shares ?? 0n).toString(), settings });
        // What changed since the last run (design: fees, maxRate, the liquidity adapter and data, adapters; changes
        // that add risk through the timelock are pending changes, the others are reported).
        const before = last?.cash.find((x) => x.vault === c.vault)?.settings;
        if (before !== undefined) for (const [k, x] of Object.entries(settings)) if (before[k] !== undefined && before[k] !== x) findings.push(`${c.vault}: its ${k} changed from ${before[k]} to ${x}`);
        for (const f of c.pendingFine) findings.push(`${c.vault}: a submitted change that keeps it within the checks: ${f}`);
        if (held === undefined || held.shares === 0n) continue;
        const reasons = [...c.problems, ...c.exitReasons];
        if (reasons.length > 0) {
          // Leave: what it can pay out now, at minAssets 0 (an exit must not fail).
          const payable = min(c.withdrawable, held.value);
          const shares = payable === held.value ? held.shares : (held.shares * payable) / held.value;
          if (shares > 0n) actions.push({ kind: "redeem_cash", what: "USDG", vault: c.vault, amount: shares.toString(), urgent: true, notBefore: 0, cost: "0", reason: `leave ${c.vault}: ${reasons.join("; ")}` });
          findings.push(`${c.vault}: ${reasons.join("; ")}`);
        } else if (c.shareProblem !== null && c.ostraHeld > 0n) {
          // Over the share limit (what it can pay out shrank): this vault's part of the excess back, not urgent.
          const cap = cashVaultRoom({ withdrawable: c.withdrawable, ostraHeld: 0n });
          const excess = c.ostraHeld > cap ? c.ostraHeld - cap : 0n;
          const value = min((held.value * excess + c.ostraHeld - 1n) / c.ostraHeld, min(held.value, c.withdrawable));
          const shares = value === held.value ? held.shares : (held.shares * value) / held.value;
          if (shares > 0n) actions.push({ kind: "redeem_cash", what: "USDG", vault: c.vault, amount: shares.toString(), urgent: false, notBefore: 0, cost: "0", reason: `${c.shareProblem}: this vault's part of the excess back` });
          findings.push(`${c.vault}: ${c.shareProblem}`);
        } else {
          // A hold (USDe's price not known, a collateral limit) stops new deposits only: what is held stays (design).
          const holds = [...(c.usdeProblem === null ? [] : [c.usdeProblem]), ...c.collateralHolds];
          if (holds.length > 0) findings.push(`${c.vault}: held ${usd(held.value)} USDG, kept (no exit reason); new deposits wait: ${holds.join("; ")}`);
          else findings.push(`${c.vault}: every check passes; held ${usd(held.value)} USDG at ${pct(c.modelApy)} a year`);
        }
      }
    } catch (e) {
      findings.push(`the cash vaults could not be checked now: ${(e as Error).message.split("\n")[0]}`);
    }
    if (cashApy === null) findings.push("the cash yield is not known now: the carries' rate rule waits for the next run");
    for (const s of h.stocks) {
      const p = s.position;
      if (p === null || p.debt === 0n) continue;
      try {
        const limit = fullLimit(p);
        const prevRate = last?.carry.find((x) => x.symbol === s.stock.symbol)?.borrowRate;
        const a: CarryAction = carryAction({
          symbol: s.stock.symbol,
          debt: p.debt,
          fullLimit: limit,
          supply: p.supply,
          borrowed: p.borrowed,
          // One rate alone never closes a carry: without the cash yield, the rate rule is skipped.
          borrowRates: prevRate === undefined || cashApy === null ? [p.borrowRatePerYear] : [BigInt(prevRate), p.borrowRatePerYear],
          cashApy: cashApy ?? 0n,
          eventWindow: await this.#eventWindow(s.stock.symbol, now, o.earnings),
        });
        record.carry.push({ symbol: s.stock.symbol, borrowRate: p.borrowRatePerYear.toString(), debt: p.debt.toString(), ltvBps: ofBps(p.debt, limit).toString() });
        findings.push(`${s.stock.symbol} carry: debt ${usd(p.debt)} USDG at ${pct(p.borrowRatePerYear)}, ${ofBps(p.debt, limit)} bps of the LLTV limit: ${a.reason}`);
        if (a.kind === "close") actions.push({ kind: "close_carry", what: s.stock.symbol, amount: "all", urgent: a.urgent, notBefore: 0, cost: "0", reason: a.reason });
        if (a.kind === "repay") actions.push({ kind: "repay", what: s.stock.symbol, amount: a.amount.toString(), urgent: a.urgent, notBefore: 0, cost: "0", reason: a.reason });
      } catch (e) {
        findings.push(`the ${s.stock.symbol} carry could not be checked now: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    // A repayment needs USDG in the USDG vault: redeem from a cash vault first when it is short, up to what it can pay
    // out now (a repayment then takes what is there; the rest at the next run).
    const repays = actions.filter((x) => x.kind === "repay" || x.kind === "close_carry");
    const need = repays.reduce((sum, x) => {
      const debt = h.stocks.find((s) => s.stock.symbol === x.what)?.position?.debt ?? 0n;
      // The whole debt with twice the repayment's buffer: the interest of the delay before it runs fits in the second.
      return sum + (x.amount === "all" ? debt + (2n * debt * BORRO_REPAY_BUFFER_BPS) / BPS + 1n : BigInt(x.amount));
    }, 0n);
    if (need > h.usdg) {
      let short = need - h.usdg;
      for (const c of h.cash) {
        if (short === 0n || c.shares === 0n || c.value === 0n || actions.some((x) => x.kind === "redeem_cash" && x.vault === c.vault)) continue;
        const take = min(min(short, c.value), withdrawable.get(c.vault) ?? c.value);
        if (take === 0n) continue;
        const shares = take === c.value ? c.shares : min((c.shares * take) / c.value + 1n, c.shares);
        actions.push({ kind: "redeem_cash", what: "USDG", vault: c.vault, amount: shares.toString(), urgent: repays.some((x) => x.urgent), notBefore: 0, cost: "0", reason: "USDG for the carry's repayment" });
        short -= take;
      }
      if (short > 0n) findings.push(`the repayments need ${usd(need)} USDG; the USDG vault and what the cash vaults can pay out now hold ${usd(need - short)}: what is there is repaid now, the rest at the next run`);
    }
    // Urgent first; within each, the redemptions (leaving a vault, the cash for a repayment) before the repayments.
    actions.sort((x, y) => Number(y.urgent) - Number(x.urgent) || Number(x.kind !== "redeem_cash") - Number(y.kind !== "redeem_cash"));
    const results = [];
    if (o.execute === true) {
      for (const st of actions.filter((x) => x.urgent)) {
        try {
          results.push({ kind: st.kind, what: st.what, ...(await this.#runStep(st, await this.#measure(st), 0n, o)) });
        } catch (e) {
          results.push({ kind: st.kind, what: st.what, error: (e as Error).message });
        }
      }
    }
    let plan: string | null = null;
    const later = actions.filter((x) => !x.urgent);
    if (later.length > 0) {
      const t = Number(now) + randomInt(0, JITTER_MAX_SECONDS);
      const kept: Plan = {
        id: `${Number(now)}-${randomInt(0, 2 ** 30)}`,
        profile: "check",
        at: Number(now),
        steps: later.map((x) => ({ ...x, notBefore: t })),
        keep: "0",
        expected30d: "0",
        cashApy: pct(cashApy ?? 0n),
        trading: null,
        risks: [],
        stopWhen: [],
        breaker: "",
      };
      const dir = this.#p.folder.folder(PLANS_DIR);
      await dir.ensure();
      await dir.write(`${kept.id}.json`, JSON.stringify(kept));
      plan = kept.id;
    }
    await this.#p.folder.append(RUNS_FILE, `${JSON.stringify(record)}\n`);
    return { findings, actions, plan, results };
  }

  /**
   * The MCP's sweep, each minute (decided by Edu on 25 Oct 2026, for a vault the breaker does not watch, and alongside
   * it for one it does): only when the USDG vault holds cash vault shares, the cash checks check() runs, and a cash vault
   * with a problem or an exit reason is left at once (an urgent redeem of what it can pay out, minAssets 0). Nothing is
   * kept. Nothing else of check() runs here (the carry ladder runs with the agent's own runs).
   */
  async exitCheck(): Promise<{ held: number; left: { vault: Address; reasons: string[]; landed?: boolean; skipped?: string; note?: string; error?: string }[] }> {
    const buyer = getAddress(await this.#p.buyer.vaultAddress());
    const held: { vault: Address; shares: bigint; value: bigint }[] = [];
    for (const v of CASH_VAULTS) {
      const shares = (await this.#p.client.readContract({ address: v, abi: vaultV2Abi, functionName: "balanceOf", args: [buyer] })) as bigint;
      if (shares === 0n) continue;
      const value = (await this.#p.client.readContract({ address: v, abi: vaultV2Abi, functionName: "previewRedeem", args: [shares] })) as bigint;
      held.push({ vault: v, shares, value });
    }
    if (held.length === 0) return { held: 0, left: [] };
    const checks = await this.cashVaults(0n);
    const left = [];
    for (const h of held) {
      const c = checks.find((x) => x.vault === h.vault);
      if (c === undefined) continue;
      const reasons = [...c.problems, ...c.exitReasons];
      if (reasons.length === 0) continue;
      const payable = min(c.withdrawable, h.value);
      const shares = payable === h.value ? h.shares : h.value === 0n ? 0n : (h.shares * payable) / h.value;
      if (shares === 0n) {
        left.push({ vault: h.vault, reasons, skipped: "it can pay out nothing now" });
        continue;
      }
      const step: Step = { kind: "redeem_cash", what: "USDG", vault: h.vault, amount: shares.toString(), urgent: true, notBefore: 0, cost: "0", reason: `leave ${h.vault}: ${reasons.join("; ")}` };
      // What it can pay out now must cover the redeem's gas, or each minute would spend a key for dust. A cost that
      // cannot be priced now (the ETH / USD feed, the relayer) does not stop an exit: it is sent, and the reason noted.
      let unpriced: string | undefined;
      try {
        const gas = await this.#cost("USDG", VAULT_ACTION.REDEEM, redeemParams({ vault: h.vault, shares, minAssets: 0n }), "the cash exit", false);
        if (payable <= gas) {
          left.push({ vault: h.vault, reasons, skipped: `it can pay out ${usd(payable)} USDG now, not more than the redeem's gas of ${usd(gas)}` });
          continue;
        }
      } catch (e) {
        unpriced = `the redeem's gas could not be priced (${(e as Error).message.split("\n")[0]}): sent anyway`;
      }
      try {
        const done = await this.#runStep(step, await this.#measure(step), 0n, {});
        left.push({ vault: h.vault, reasons, ...done, ...(unpriced === undefined ? {} : { note: done.note === undefined ? unpriced : `${done.note}; ${unpriced}` }) });
      } catch (e) {
        left.push({ vault: h.vault, reasons, error: (e as Error).message });
      }
    }
    return { held: held.length, left };
  }

  /** The runs recorded here, oldest first; a line that cannot be parsed is skipped. */
  async #runs(): Promise<RunRecord[]> {
    const text = await this.#p.folder.read(RUNS_FILE);
    if (text === undefined) return [];
    const out: RunRecord[] = [];
    for (const l of text.split("\n")) {
      if (l.trim() === "") continue;
      try {
        out.push(JSON.parse(l) as RunRecord);
      } catch {
        // a line cut by a crash
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------------------------------------------------

  /** Yield per day by route at the rates now, the share growth realized since the first run that held each cash vault, and each carry's distance to liquidation. */
  async report(): Promise<{
    routes: { route: string; value: string; apy: string; perDay: string }[];
    carries: { symbol: string; debt: string; ofLltvLimit: string; priceDropToLiquidation: string }[];
    realized: { vault: Address; since: string; growth: string }[];
  }> {
    await this.gate();
    const h = await this.holdings();
    const checks = await this.cashVaults();
    const routes = [];
    for (const c of h.cash) {
      if (c.shares === 0n) continue;
      const apy = checks.find((x) => x.vault === c.vault)?.modelApy ?? 0n;
      routes.push({ route: `cash ${c.vault}`, value: usd(c.value), apy: pct(apy), perDay: usd(yieldOver(c.value, apy, DAY)) });
    }
    const carries = [];
    for (const s of h.stocks) {
      const p = s.position;
      if (p === null || p.debt === 0n) continue;
      const ltv = ofBps(p.debt, fullLimit(p));
      routes.push({ route: `${s.stock.symbol} carry loan`, value: usd(p.debt), apy: pct(-p.borrowRatePerYear), perDay: `-${usd(yieldOver(p.debt, p.borrowRatePerYear, DAY))}` });
      // Liquidation when the debt reaches the full limit, which moves with the price: a fall of 1 - debt/limit.
      carries.push({ symbol: s.stock.symbol, debt: usd(p.debt), ofLltvLimit: `${(Number(ltv) / 100).toFixed(2)}%`, priceDropToLiquidation: `${(Math.max(0, 10_000 - Number(ltv)) / 100).toFixed(2)}%` });
    }
    const runs = await this.#runs();
    const realized = [];
    for (const c of h.cash) {
      const first = runs.find((r) => r.cash.some((x) => x.vault === c.vault && x.held !== "0"));
      const f = first?.cash.find((x) => x.vault === c.vault);
      const nowPrice = checks.find((x) => x.vault === c.vault)?.sharePrice;
      if (first === undefined || f === undefined || nowPrice === undefined || BigInt(f.sharePrice) === 0n) continue;
      const before = BigInt(f.sharePrice);
      realized.push({ vault: c.vault, since: new Date(first.at * 1000).toISOString(), growth: pct(((nowPrice - before) * WAD) / before) });
    }
    return { routes, carries, realized };
  }
}
