// What Ostra's strategy planner reads from the chain (the planner itself is core's StrategyService):
//   * Strategy 1, the validated cash router: a Morpho Vault V2 of USDG qualifies only while every check of
//     checkCashVault holds (asset, factory, gates, worst case from absolute caps over accepted markets only, timelocks,
//     a full redeem, Ostra's share of what can be withdrawn), and cashVaultModel gives its modelled yield;
//   * the agent's ERC-8004 identity (Identity Registry): its owner and agentWallet;
//   * every Ostra vault (the factory's VaultCreated events), for the capacity all Ostra agents share;
//   * USDe's price, from Chainlink's USDe / USD feed on Ethereum mainnet (Steakhouse's largest market lends against
//     USDe, and Robinhood Chain has no usable USDe price).
// Every rule here is the design document's ("Strategi (versi 2)", decided 24 Oct 2026); numbers that are not read on
// chain are named constants below with where they come from.

import { decodeAbiParameters, getAddress, keccak256, parseAbi, parseAbiItem, toFunctionSelector, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { ERC8004_IDENTITY_REGISTRY, MORPHO_VAULT_V2_FACTORY, USDG } from "./constants.ts";
import type { MarketParams } from "./messages.ts";
import {
  WAD,
  decodeCapIdData,
  getLogsChunked,
  isRevert,
  readVaultV2,
  readVaultV2CapsOf,
  simulateVaultV2Redeem,
  supplyRate,
  vaultV2FactoryAbi,
  vaultV2GatesAllow,
  vaultV2ReadAbi,
  withdrawableNow,
  worstCaseExposure,
  type VaultCap,
  type VaultV2State,
} from "./morpho.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Strategy 1: the validated cash vaults
// ---------------------------------------------------------------------------------------------------------------------

/** Steakhouse USDG (Robinhood Earn), the Morpho Vault V2 that passed every check on 24 Oct 2026. */
export const STEAKHOUSE_USDG: Address = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
/** The vaults Strategy 1 considers; each is checked again (checkCashVault) whenever the planner runs. */
export const CASH_VAULTS: readonly Address[] = [STEAKHOUSE_USDG];

/**
 * The markets a cash vault may be exposed to: collateral and oracle. Decided by Edu on 24 Oct 2026: the markets
 * Steakhouse USDG caps (USDe, syrupUSDG, spUSDG, mGLO, WETH and Robinhood stock tokens), read from its cap events and
 * absoluteCap at block 96,675,780. A cap on any other collateral, or the same collateral behind another oracle, fails
 * the check until it is reviewed and added here. Added on 25 Oct 2026 (decided by Edu, after review): the second mGLO
 * market Steakhouse's curator submitted on 23 Oct, whose oracle reads Midas's mGLO / USD NAV feed (MGLO_NAV_FEED, the
 * same feed as the first mGLO market's oracle) through an immutable "mGLO/USD PriceLowered" feed at 98% of it
 * (0x713bA6049D09AB6E82A3d96a31e89B284F69C2f0; the first market's takes 94%), within CASH_COLLATERAL_LIMITS.
 */
export const ACCEPTED_CASH_MARKETS: readonly { symbol: string; collateral: Address; oracle: Address }[] = [
  { symbol: "USDe", collateral: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", oracle: "0xE64849bd4AD03DfaBbe02bb521de19997a19055f" },
  { symbol: "syrupUSDG", collateral: "0x40858070814a57FdF33a613ae84fE0a8b4a874f7", oracle: "0x152c638fad68913739Ee19Ba8eF47fAEB09DCa91" },
  { symbol: "spUSDG", collateral: "0xde770c84FE66E063336b31737cFE9790f18c4087", oracle: "0xe694c531F65c4BaBc88A52d7178476e095e51574" },
  { symbol: "mGLO", collateral: "0xFEd493F38c1aAcb4EA4e6A11F8b9287849EE0096", oracle: "0xCb6EdD02FDB9b0f2893e590eBeD889214F4Df650" },
  { symbol: "mGLO", collateral: "0xFEd493F38c1aAcb4EA4e6A11F8b9287849EE0096", oracle: "0xD32146a0C1E4B79fD8D9ebcd4Adc66b2B7397D4d" },
  { symbol: "WETH", collateral: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", oracle: "0x5E3645eD6ace5b212Ad7CF51c75154897e2f80AD" },
  { symbol: "NVDA", collateral: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", oracle: "0x418dA8bE2D981f152fd9Fc64ED42BE2Cdea52c5A" },
  { symbol: "SPY", collateral: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", oracle: "0xae67AE490E82F186F34977Cb6ed117b2585ECf6F" },
  { symbol: "AAPL", collateral: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", oracle: "0xc03399C6b3179859f0104Be26AeE6F20F83589f3" },
  { symbol: "GOOGL", collateral: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", oracle: "0x75e5f0E2Fa72E6633371868EC62Ddeaf534914D0" },
  { symbol: "TSLA", collateral: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", oracle: "0x21167CE53F2cD12Be8bC8525e0Fda8474B042158" },
  { symbol: "SPCX", collateral: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", oracle: "0xb9BdE79161100a218D8B036CBf69cbcdFb71440a" },
];

/** Midas Fasanara Global Open (mGLO): a tokenised private credit fund (short-duration trade receivables), valued monthly. */
export const MGLO: Address = "0xFEd493F38c1aAcb4EA4e6A11F8b9287849EE0096";
/** Midas's mGLO / USD NAV feed (an upgradeable proxy Midas runs), behind both accepted mGLO oracles. */
export const MGLO_NAV_FEED: Address = "0x49D9Dd1Fa6EA3709aB8A5d5f16a1cf207eb91dd0";

/**
 * Limits on collateral a cash vault may lend against, beyond being an accepted market (decided by Edu on 25 Oct 2026
 * for mGLO): what the vault's absolute caps let an allocator put against it is at most `maxShareBps` of its total
 * assets, and its NAV feed answered within `maxNavAge`. Neither is a reason to leave the vault: while one does not
 * hold, the vault takes no new deposit (cashCollateralHolds). mGLO's NAV is set monthly (its feed's longest gap was 58
 * days, 24 Jun to 21 Aug 2026; then 23 Sep, 24 Sep, 25 Sep and 23 Oct): 35 days is a month and a margin, so a NAV
 * that stopped being published stops new money going where it cannot be valued. 20% bounds what a NAV that misses a
 * loss could cost the vault (worst case under the caps Steakhouse submitted on 23 Oct: 18.4%).
 */
export const CASH_COLLATERAL_LIMITS: readonly { symbol: string; collateral: Address; maxShareBps: bigint; navFeed: Address; maxNavAge: bigint }[] = [
  { symbol: "mGLO", collateral: MGLO, maxShareBps: 2_000n, navFeed: MGLO_NAV_FEED, maxNavAge: 35n * 86_400n },
];

const navFeedAbi = parseAbi(["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"]);

/**
 * Why a cash vault takes no new deposit under CASH_COLLATERAL_LIMITS, for its caps `caps` (now, or after its pending
 * changes: capsAfterPending) with `totalAssets` in it: a limited collateral its caps let an allocator reach beyond its
 * share, or whose NAV feed is older than its limit or cannot be read. Empty: none. Read at the vault state's block.
 */
export async function cashCollateralHolds(client: PublicClient, v: VaultV2State, caps: readonly VaultCap[], totalAssets: bigint): Promise<string[]> {
  const out: string[] = [];
  const worst = worstCaseExposure(v, [...caps], totalAssets);
  for (const l of CASH_COLLATERAL_LIMITS) {
    const c = worst.collaterals.find((x) => getAddress(x.token) === getAddress(l.collateral));
    if (c === undefined || c.max === 0n) continue;
    if (c.max * 10_000n > totalAssets * l.maxShareBps) out.push(`its caps let ${c.max} go against ${l.symbol}, more than ${l.maxShareBps} bps of its ${totalAssets} total assets`);
    try {
      const [, answer, , updatedAt] = await client.readContract({ address: l.navFeed, abi: navFeedAbi, functionName: "latestRoundData", blockNumber: v.at.blockNumber });
      const age = v.at.timestamp - updatedAt;
      if (answer <= 0n) out.push(`${l.symbol}'s NAV feed answers ${answer}`);
      else if (age > l.maxNavAge) out.push(`${l.symbol}'s NAV was last published ${age} s ago, more than ${l.maxNavAge} s`);
    } catch (e) {
      out.push(`${l.symbol}'s NAV feed could not be read: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return out;
}

/** The shortest timelock accepted on the powers that change what a cash vault can lose (design: 3 days). */
export const CASH_MIN_TIMELOCK = 3n * 86_400n;
/** The vault's powers that add exposure (addAdapter, absolute and relative caps) and the market adapter's burnShares. */
export const CASH_TIMELOCKED_VAULT_POWERS = ["addAdapter(address)", "increaseAbsoluteCap(bytes,uint256)", "increaseRelativeCap(bytes,uint256)"] as const;
export const CASH_TIMELOCKED_ADAPTER_POWERS = ["burnShares(bytes32)"] as const;
/**
 * The gate setters that must be abdicated: each of these gates can lock depositors out of exiting (VaultV2's own
 * comments: receiveSharesGate, sendSharesGate, receiveAssetsGate).
 */
export const CASH_EXIT_GATE_SETTERS = ["setReceiveSharesGate(address)", "setSendSharesGate(address)", "setReceiveAssetsGate(address)"] as const;
/**
 * The deposit gate's setter: abdicated, or timelocked at least CASH_MIN_TIMELOCK (decided by Edu on 24 Oct 2026,
 * following VaultV2's comment that sendAssetsGate "is not critical (cannot block users' funds)"; it can only close new
 * deposits, and a change to it submitted is a pending change the planner leaves the vault on).
 */
export const CASH_DEPOSIT_GATE_SETTER = "setSendAssetsGate(address)";
/** All Ostra vaults together hold at most this share of what the vault can pay out now (design: 5%). */
export const OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS = 500n;

const vaultSharesAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function abdicated(bytes4 selector) view returns (bool)",
]);

/** A cash vault's check: every problem found (empty: it qualifies now), and what the check read. */
export type CashVaultCheck = {
  vault: Address;
  /** No problem and within the share limit: a deposit of `planned` may go in now. */
  ok: boolean;
  /** What is wrong with the vault itself (a reason to leave it). */
  problems: string[];
  /** Set when all Ostra vaults with `planned` would hold more than OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS of what it can pay out. */
  shareProblem: string | null;
  state: VaultV2State;
  caps: VaultCap[];
  /** What it can pay out in this block (idle + its liquidity market, at most that market's free liquidity). */
  withdrawable: bigint;
  /** What all Ostra vaults hold in it (USDG base units at its share price), and the planned deposit. */
  ostraHeld: bigint;
  planned: bigint;
  /** The vault's yield modelled from its markets (per year, WAD, simple), and its share price (assets of 1e18 shares). */
  modelApy: bigint;
  sharePrice: bigint;
};

/**
 * The yield a Vault V2 pays its depositors now, modelled from its markets as VaultV2.accrueInterestView distributes
 * it: what each market adapter's supply earns at the market's rate (Morpho's supply rate at the accrued state), over
 * the vault's total assets, at most maxRate (0 distributes nothing), then less the performance fee on that and the
 * management fee. Per year, simple, WAD.
 */
export function cashVaultModel(v: VaultV2State): bigint {
  if (v.accruedTotalAssets === 0n) return 0n;
  let earned = 0n; // assets per second, WAD-scaled
  for (const a of v.adapters) {
    if (a.kind !== "market") continue;
    for (const m of a.markets) {
      if (m.expected === null) continue;
      earned += m.supplyAssets * supplyRate(m.expected, m.instantBorrowRate);
    }
  }
  let rate = earned / v.accruedTotalAssets; // per second, WAD
  if (rate > v.maxRate) rate = v.maxRate;
  rate = (rate * (WAD - v.performanceFee)) / WAD;
  rate = rate > v.managementFee ? rate - v.managementFee : 0n;
  return rate * 31_536_000n;
}

/** Whether a market is one a cash vault may be exposed to: its collateral and oracle in ACCEPTED_CASH_MARKETS. */
export function isAcceptedCashMarket(p: Pick<MarketParams, "collateralToken" | "oracle">): boolean {
  return ACCEPTED_CASH_MARKETS.some((x) => getAddress(x.collateral) === getAddress(p.collateralToken) && getAddress(x.oracle) === getAddress(p.oracle));
}

const sel = (sig: string) => toFunctionSelector(`function ${sig}`);
/** VaultV2's functions that run only through its timelock (they call timelocked()); a Submit of anything else can never be executed. */
const VAULT_TIMELOCKED = new Map<Hex, string>(
  [
    "setIsAllocator(address,bool)",
    "setReceiveSharesGate(address)",
    "setSendSharesGate(address)",
    "setReceiveAssetsGate(address)",
    "setSendAssetsGate(address)",
    "setAdapterRegistry(address)",
    "addAdapter(address)",
    "removeAdapter(address)",
    "increaseTimelock(bytes4,uint256)",
    "decreaseTimelock(bytes4,uint256)",
    "abdicate(bytes4)",
    "setPerformanceFee(uint256)",
    "setManagementFee(uint256)",
    "setPerformanceFeeRecipient(address)",
    "setManagementFeeRecipient(address)",
    "increaseAbsoluteCap(bytes,uint256)",
    "increaseRelativeCap(bytes,uint256)",
    "setForceDeallocatePenalty(address,uint256)",
  ].map((x) => [sel(x), x]),
);
/**
 * MorphoMarketV1AdapterV2's functions that run only through its timelock. MARKET_ADAPTER_POWERS (morpho.ts) names
 * burnShares and setSkimRecipient; the adapter's own timelock functions are read the same way as the vault's.
 */
const MARKET_ADAPTER_TIMELOCKED = new Map<Hex, string>(["burnShares(bytes32)", "setSkimRecipient(address)", "increaseTimelock(bytes4,uint256)", "decreaseTimelock(bytes4,uint256)", "abdicate(bytes4)"].map((x) => [sel(x), x]));
/**
 * The selectors whose timelock lowered under CASH_MIN_TIMELOCK by a pending decreaseTimelock counts: the powers the check
 * needs at 3 days or more, and those whose pending changes count (fee raises, the adapter registry), which a lowered
 * timelock would let through unseen.
 */
const GUARDED_TIMELOCKS = new Set<Hex>(
  [...CASH_TIMELOCKED_VAULT_POWERS, CASH_DEPOSIT_GATE_SETTER, ...CASH_TIMELOCKED_ADAPTER_POWERS, "setPerformanceFee(uint256)", "setManagementFee(uint256)", "setAdapterRegistry(address)"].map(sel),
);

export type PendingChange = { target: Address; selector: Hex; data: Hex; executableAt: bigint; abdicated: boolean };

/**
 * Which of a cash vault's pending changes (still pending, as readPendingChanges reads them) would make it fail
 * Strategy 1's check once executed (decided by Edu on 24 Oct 2026: only those count). Anyone can execute a timelocked
 * change once its time comes, so a change counts from the moment it is submitted:
 *   * on the vault: an adapter added; a fee raised; a deposit gate set; an adapter registry set; a timelock this check
 *     needs at 3 days or more lowered under it; absolute cap increases (all of them together) that let an allocator
 *     reach a market outside ACCEPTED_CASH_MARKETS;
 *   * on a market adapter: burnShares; a lowered burnShares timelock under 3 days.
 * Abdicated changes and data of functions that are not timelocked (VaultV2's Submit accepts any data) can never be
 * executed and are listed as ignored. Everything else (cap increases within accepted markets, allocators, recipients,
 * removals, raised timelocks, abdications) is listed as fine.
 */
export function pendingChangeProblems(v: VaultV2State, caps: readonly VaultCap[], pending: readonly PendingChange[]): { problems: string[]; fine: string[]; ignored: string[] } {
  const problems: string[] = [];
  const fine: string[] = [];
  const ignored: string[] = [];
  const when = (p: PendingChange) => `executable at ${new Date(Number(p.executableAt) * 1000).toISOString()}`;
  const args = (p: PendingChange, types: readonly { type: string }[]) => decodeAbiParameters(types, `0x${p.data.slice(10)}` as Hex);
  const raised = new Map<string, bigint>();
  for (const p of pending) {
    const onVault = getAddress(p.target) === getAddress(v.address);
    const name = onVault ? VAULT_TIMELOCKED.get(p.selector) : MARKET_ADAPTER_TIMELOCKED.get(p.selector);
    if (name === undefined || p.abdicated) {
      ignored.push(`${p.selector} on ${p.target}: ${p.abdicated ? "abdicated" : "not a timelocked function"}, it cannot be executed`);
      continue;
    }
    const label = `${name.slice(0, name.indexOf("("))} on ${p.target}, ${when(p)}`;
    let bad: string | null = null;
    try {
      if (name === "addAdapter(address)") bad = "an adapter would be added";
      else if (name === "setAdapterRegistry(address)") bad = "the adapter registry would be set";
      else if (name === "setSendAssetsGate(address)") {
        if ((args(p, [{ type: "address" }])[0] as Address) !== zeroAddress) bad = "a deposit gate would be set";
      } else if (name === "setReceiveSharesGate(address)" || name === "setSendSharesGate(address)" || name === "setReceiveAssetsGate(address)") {
        if ((args(p, [{ type: "address" }])[0] as Address) !== zeroAddress) bad = "an exit gate would be set";
      } else if (name === "setPerformanceFee(uint256)") {
        if ((args(p, [{ type: "uint256" }])[0] as bigint) > v.performanceFee) bad = "the performance fee would rise";
      } else if (name === "setManagementFee(uint256)") {
        if ((args(p, [{ type: "uint256" }])[0] as bigint) > v.managementFee) bad = "the management fee would rise";
      } else if (name === "decreaseTimelock(bytes4,uint256)") {
        const [what, seconds] = args(p, [{ type: "bytes4" }, { type: "uint256" }]) as [Hex, bigint];
        if (GUARDED_TIMELOCKS.has(what.toLowerCase() as Hex) && seconds < CASH_MIN_TIMELOCK) bad = `the timelock of ${what} would drop to ${seconds} s`;
      } else if (name === "burnShares(bytes32)") bad = "the adapter would burn shares (a loss for the vault)";
      else if (name === "increaseAbsoluteCap(bytes,uint256)") {
        const [idData, cap] = args(p, [{ type: "bytes" }, { type: "uint256" }]) as [Hex, bigint];
        const id = keccak256(idData).toLowerCase();
        raised.set(`${id}|${idData}`, (raised.get(`${id}|${idData}`) ?? 0n) > cap ? (raised.get(`${id}|${idData}`) as bigint) : cap);
      }
    } catch {
      // VaultV2's submit takes any bytes; data its function cannot decode reverts when executed, so it never can be.
      ignored.push(`${p.selector} on ${p.target}: its data cannot be decoded, it cannot be executed`);
      continue;
    }
    if (bad === null) fine.push(label);
    else problems.push(`a submitted change: ${bad} (${label})`);
  }
  if (raised.size > 0) {
    for (const m of worstCaseExposure(v, capsAfterPending(v, caps, pending)).markets) {
      if (!isAcceptedCashMarket(m.params)) problems.push(`a submitted change: once its cap increases are executed, its caps reach a market of collateral ${m.params.collateralToken} with oracle ${m.params.oracle}, which is not an accepted market`);
    }
  }
  return { problems, fine, ignored };
}

/**
 * A cash vault's caps once every absolute cap increase still pending (and not abdicated) is executed: each id at the
 * larger of its cap now and the largest submitted for it, new ids added. Data that cannot be decoded is left out (it
 * can never be executed).
 */
export function capsAfterPending(v: VaultV2State, caps: readonly VaultCap[], pending: readonly PendingChange[]): VaultCap[] {
  const after: VaultCap[] = caps.map((c) => ({ ...c }));
  const increase = sel("increaseAbsoluteCap(bytes,uint256)");
  for (const p of pending) {
    if (p.abdicated || getAddress(p.target) !== getAddress(v.address) || p.selector.toLowerCase() !== increase) continue;
    let idData: Hex;
    let cap: bigint;
    try {
      [idData, cap] = decodeAbiParameters([{ type: "bytes" }, { type: "uint256" }], `0x${p.data.slice(10)}` as Hex) as [Hex, bigint];
    } catch {
      continue;
    }
    const id = keccak256(idData).toLowerCase();
    const c = after.find((x) => x.id.toLowerCase() === id);
    if (c !== undefined) c.absoluteCap = c.absoluteCap > cap ? c.absoluteCap : cap;
    else after.push({ id: id as Hex, idData, what: decodeCapIdData(idData), absoluteCap: cap, relativeCap: 0n, allocation: 0n });
  }
  return after;
}

/**
 * Strategy 1's check of a cash vault, at the latest block:
 *   * the asset is USDG and the Morpho VaultV2Factory made it;
 *   * the setters of the gates that can lock depositors out are abdicated, the deposit gate's setter is abdicated or
 *     waits at least CASH_MIN_TIMELOCK, and the gates let each of `holders` deposit and redeem;
 *   * every market its absolute caps let an allocator reach (worstCaseExposure) is an accepted market, and it has no
 *     adapter other than market adapters;
 *   * addAdapter, both cap increases and every market adapter's burnShares wait at least CASH_MIN_TIMELOCK (or are
 *     abdicated);
 *   * each holder's shares redeem in full in a simulation now;
 *   * what all Ostra vaults hold there plus `planned` is at most OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS of what it can pay
 *     out now.
 * `capIds`: the vault's cap ids from its cap events (morpho.ts capIdsFromEvents), kept by the caller.
 * `ostraVaults`: every Ostra vault of USDG (listOstraVaults), whose shares count against the share limit.
 */
export async function checkCashVault(
  client: PublicClient,
  vault: Address,
  a: { capIds: ReadonlyMap<string, Hex>; holders: readonly Address[]; ostraVaults: readonly Address[]; planned: bigint },
): Promise<CashVaultCheck> {
  const address = getAddress(vault);
  const problems: string[] = [];
  const v = await readVaultV2(client, address);
  const bn = v.at.blockNumber;
  const caps = await readVaultV2CapsOf(client, v, a.capIds);
  if (getAddress(v.asset) !== USDG) problems.push(`its asset is ${v.asset}, not USDG`);
  const fromFactory = (await client.readContract({ address: MORPHO_VAULT_V2_FACTORY, abi: vaultV2FactoryAbi, functionName: "isVaultV2", args: [address], blockNumber: bn })) as boolean;
  if (!fromFactory) problems.push("the Morpho VaultV2Factory did not make it");
  for (const setter of CASH_EXIT_GATE_SETTERS) {
    const ab = await client.readContract({ address, abi: vaultSharesAbi, functionName: "abdicated", args: [toFunctionSelector(`function ${setter}`)], blockNumber: bn });
    if (!ab) problems.push(`${setter.split("(")[0]} is not abdicated: a gate could lock depositors out later`);
  }
  const depositGate = v.timelocks[CASH_DEPOSIT_GATE_SETTER.slice(0, CASH_DEPOSIT_GATE_SETTER.indexOf("("))];
  if (depositGate === undefined) problems.push(`its ${CASH_DEPOSIT_GATE_SETTER} timelock was not read`);
  else if (!depositGate.abdicated && depositGate.seconds < CASH_MIN_TIMELOCK) problems.push(`setSendAssetsGate waits ${depositGate.seconds} s, less than ${CASH_MIN_TIMELOCK} s, and is not abdicated`);
  for (const h of a.holders) {
    const g = await vaultV2GatesAllow(client, v, h);
    if (!g.deposit || !g.redeem) problems.push(`its gates do not let ${h} ${g.deposit ? "redeem" : "deposit"}`);
  }
  const worst = worstCaseExposure(v, caps, v.accruedTotalAssets + a.planned);
  for (const o of worst.opaque) problems.push(`adapter ${o} is not a Morpho market adapter: what it holds cannot be read`);
  for (const m of worst.markets) {
    if (!isAcceptedCashMarket(m.params)) problems.push(`its caps reach a market of collateral ${m.params.collateralToken} with oracle ${m.params.oracle}, which is not an accepted market`);
  }
  for (const power of CASH_TIMELOCKED_VAULT_POWERS) {
    const t = v.timelocks[power.slice(0, power.indexOf("("))];
    if (t === undefined) problems.push(`its ${power} timelock was not read`);
    else if (!t.abdicated && t.seconds < CASH_MIN_TIMELOCK) problems.push(`${power.split("(")[0]} waits ${t.seconds} s, less than ${CASH_MIN_TIMELOCK} s`);
  }
  for (const ad of v.adapters) {
    if (ad.kind !== "market") continue;
    for (const power of CASH_TIMELOCKED_ADAPTER_POWERS) {
      const t = ad.timelocks[power.slice(0, power.indexOf("("))];
      if (t === undefined) problems.push(`adapter ${ad.address}: its ${power} timelock was not read`);
      else if (!t.abdicated && t.seconds < CASH_MIN_TIMELOCK) problems.push(`adapter ${ad.address}: ${power.split("(")[0]} waits ${t.seconds} s, less than ${CASH_MIN_TIMELOCK} s`);
    }
  }
  for (const h of a.holders) {
    const shares = (await client.readContract({ address, abi: vaultSharesAbi, functionName: "balanceOf", args: [h], blockNumber: bn })) as bigint;
    if (shares === 0n) continue;
    const r = await simulateVaultV2Redeem(client, address, h, shares);
    if (!r.ok) problems.push(`${h} cannot redeem its ${shares} shares now: ${r.reason}`);
  }
  const unit = 10n ** BigInt(v.decimals);
  const sharePrice = (await client.readContract({ address, abi: vaultSharesAbi, functionName: "convertToAssets", args: [unit], blockNumber: bn })) as bigint;
  let ostraShares = 0n;
  for (const o of a.ostraVaults) ostraShares += (await client.readContract({ address, abi: vaultSharesAbi, functionName: "balanceOf", args: [o], blockNumber: bn })) as bigint;
  const ostraHeld = (ostraShares * sharePrice) / unit;
  const withdrawable = withdrawableNow(v);
  const shareProblem =
    (ostraHeld + a.planned) * 10_000n > withdrawable * OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS
      ? `Ostra vaults would hold ${ostraHeld + a.planned} of the ${withdrawable} it can pay out now, more than ${OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS} bps`
      : null;
  return { vault: address, ok: problems.length === 0 && shareProblem === null, problems, shareProblem, state: v, caps, withdrawable, ostraHeld, planned: a.planned, modelApy: cashVaultModel(v), sharePrice };
}

/** The most `planned` can be under the share limit: what Ostra may still add to a cash vault (0 when it is full). */
export function cashVaultRoom(c: Pick<CashVaultCheck, "withdrawable" | "ostraHeld">): bigint {
  const cap = (c.withdrawable * OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS) / 10_000n;
  return cap > c.ostraHeld ? cap - c.ostraHeld : 0n;
}

// ---------------------------------------------------------------------------------------------------------------------
// ERC-8004 identity
// ---------------------------------------------------------------------------------------------------------------------

/** The ERC-8004 Identity Registry (erc-8004 IdentityRegistryUpgradeable): an ERC-721 of agents. */
export const identityRegistryAbi = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
]);
export const agentRegisteredEvent = parseAbiItem("event Registered(uint256 indexed agentId, string agentURI, address indexed owner)");

/** Agent `agentId`'s owner and agentWallet (zero when unset), or null when no such agent exists. */
export async function readAgentIdentity(client: PublicClient, agentId: bigint): Promise<{ owner: Address; wallet: Address } | null> {
  let owner: Address;
  try {
    owner = getAddress((await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] })) as Address);
  } catch (e) {
    if (isRevert(e)) return null;
    throw e;
  }
  const wallet = getAddress((await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "getAgentWallet", args: [agentId] })) as Address);
  return { owner, wallet };
}

/** The agent ids registered by `owner` (Registered events) between two blocks, oldest first. */
export async function agentIdsRegisteredBy(logsClient: PublicClient, owner: Address, fromBlock: bigint, toBlock: bigint): Promise<bigint[]> {
  const logs = await getLogsChunked(logsClient, { address: ERC8004_IDENTITY_REGISTRY, event: agentRegisteredEvent, args: { owner: getAddress(owner) }, fromBlock, toBlock });
  return logs.map((l) => (l.args as { agentId: bigint }).agentId);
}

// ---------------------------------------------------------------------------------------------------------------------
// Every Ostra vault
// ---------------------------------------------------------------------------------------------------------------------

export const vaultCreatedEvent = parseAbiItem("event VaultCreated(address indexed vault, address indexed token, bytes32 initialKeyRoot, address initialCrank)");

/** The vaults `factory` created between two blocks (VaultCreated), of `token` when given. */
export async function listOstraVaults(logsClient: PublicClient, factory: Address, fromBlock: bigint, toBlock: bigint, token?: Address): Promise<{ vault: Address; token: Address; block: bigint }[]> {
  const logs = await getLogsChunked(logsClient, { address: factory, event: vaultCreatedEvent, args: token === undefined ? undefined : { token: getAddress(token) }, fromBlock, toBlock });
  return logs.map((l) => {
    const a = l.args as { vault: Address; token: Address };
    return { vault: getAddress(a.vault), token: getAddress(a.token), block: l.blockNumber };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// USDe's price: Chainlink's USDe / USD feed on Ethereum mainnet
// ---------------------------------------------------------------------------------------------------------------------
//
// Robinhood Chain has no usable USDe price (decided by Edu on 24 Oct 2026, from what was read that day): its USDe/USDG
// Uniswap v3 pools hold under $0.20 in all (a few cents move them; the deepest read 0.951), and the oracle of
// Steakhouse USDG's USDe market is a 45-byte contract that always answers 1.0. Chainlink's USDe / USD feed on Ethereum
// mainnet is read instead, found by its ENS name (Chainlink's canonical name for it), through an Ethereum RPC.

export const USDE: Address = "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34";
/** Chainlink's ENS name of the USDe / USD feed on Ethereum mainnet, and the description it must answer. */
export const USDE_USD_FEED_ENS = "usde-usd.data.eth";
export const USDE_USD_FEED_DESCRIPTION = "USDe / USD";
/**
 * Below this USDe price (in US dollars, WAD) a cash vault lending against USDe is left: 0.99 (decided by Edu on
 * 30 Oct 2026, with USDe at 0.9944482; 0.995 until MCP 0.1.14).
 */
export const USDE_EXIT_PRICE = 990_000_000_000_000_000n;
/**
 * A USDe / USD answer older than this is stale. Measured on 24 Oct 2026 from the VPS: usde-usd.data.eth is
 * 0xa569d910839Ae8865Da8F8e70FfFb0cBA869F961 ("USDe / USD", 8 decimals); over its last 300 gaps (from 9 Jan 2026) the
 * longest was 82,872 s (median 82,824 s, a heartbeat of about 23 hours; answers 0.99781 to 1.00034). Plus one hour.
 */
export const USDE_FEED_MAX_AGE = 82_872n + 3_600n;

const chainlinkFeedAbi = parseAbi([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/**
 * USDe's price in US dollars (WAD) from Chainlink's USDe / USD feed on Ethereum mainnet, `ethClient` an Ethereum
 * mainnet client: the feed's address from its ENS name, its description checked, its answer and age. `stale` when the
 * answer is older than USDE_FEED_MAX_AGE (Ethereum's latest block time against the answer's).
 */
export async function readUsdeUsd(ethClient: PublicClient): Promise<{ feed: Address; price: bigint; updatedAt: bigint; age: bigint; stale: boolean }> {
  const chainId = await ethClient.getChainId();
  if (chainId !== 1) throw new Error(`the Ethereum RPC serves chain ${chainId}, not 1`);
  const feed = await ethClient.getEnsAddress({ name: USDE_USD_FEED_ENS });
  if (feed === null) throw new Error(`${USDE_USD_FEED_ENS} resolves to no address`);
  const [description, decimals, round, block] = await Promise.all([
    ethClient.readContract({ address: feed, abi: chainlinkFeedAbi, functionName: "description" }),
    ethClient.readContract({ address: feed, abi: chainlinkFeedAbi, functionName: "decimals" }),
    ethClient.readContract({ address: feed, abi: chainlinkFeedAbi, functionName: "latestRoundData" }),
    ethClient.getBlock(),
  ]);
  if (description !== USDE_USD_FEED_DESCRIPTION) throw new Error(`${USDE_USD_FEED_ENS} (${feed}) describes itself as "${description}", not "${USDE_USD_FEED_DESCRIPTION}"`);
  const answer = round[1];
  const updatedAt = round[3];
  if (answer <= 0n || updatedAt === 0n) throw new Error(`${USDE_USD_FEED_ENS} has no answer`);
  const price = decimals <= 18 ? answer * 10n ** BigInt(18 - decimals) : answer / 10n ** BigInt(decimals - 18);
  const age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0n;
  return { feed: getAddress(feed), price, updatedAt, age, stale: age > USDE_FEED_MAX_AGE };
}
