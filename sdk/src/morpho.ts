// Morpho on Robinhood Chain, read and computed as the contracts compute it, for the strategy planner:
//   * Morpho Blue math (morpho-blue src/libraries/MathLib.sol, SharesMathLib.sol) and interest accrual
//     (Morpho._accrueInterest, AdaptiveCurveIrmLib.expectedMarketBalances), in bigint with the contracts' rounding;
//   * the AdaptiveCurveIrm (morpho-blue-irm src/adaptive-curve-irm: _borrowRate, _curve, _newRateAtTarget, ExpLib.wExp,
//     MathLib's round-toward-zero signed arithmetic, UtilsLib.bound), so a rate computed here equals borrowRateView;
//   * Morpho Vault V2 (vault-v2 src/VaultV2.sol) and its MorphoMarketV1AdapterV2: configuration, the timelock and
//     abdication of every curator power, caps (from their events, confirmed by reads), what an allocator may move a
//     vault into without a timelock (the worst case allowed by the caps), and what a depositor can withdraw now;
//   * oracles (MorphoChainlinkOracleV2-style getters and their Chainlink feeds) and log reads in spans the RPC accepts.
// Nothing here signs or sends; the planner decides what passes.

import {
  BaseError,
  ContractFunctionRevertedError,
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  toFunctionSelector,
  zeroAddress,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { MORPHO_ADAPTIVE_CURVE_IRM, MORPHO_BLUE, MORPHO_MARKET_V1_ADAPTER_V2_FACTORY, MORPHO_VAULT_V2_FACTORY } from "./constants.ts";
import { marketId, type MarketParams } from "./messages.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Morpho Blue math
// ---------------------------------------------------------------------------------------------------------------------

export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 31_536_000n;
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;
const UINT128_MAX = (1n << 128n) - 1n;

export function mulDivDown(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y) / d;
}
export function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  return (x * y + (d - 1n)) / d;
}
export function wMulDown(x: bigint, y: bigint): bigint {
  return mulDivDown(x, y, WAD);
}
export function wDivDown(x: bigint, y: bigint): bigint {
  return mulDivDown(x, WAD, y);
}
/** MathLib.wTaylorCompounded: e^(x*n) - 1, three terms. */
export function wTaylorCompounded(x: bigint, n: bigint): bigint {
  const first = x * n;
  const second = mulDivDown(first, first, 2n * WAD);
  const third = mulDivDown(second, first, 3n * WAD);
  return first + second + third;
}
/** SharesMathLib (1 virtual asset, 1e6 virtual shares). */
export function sharesToAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}
export function sharesToAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
}
export function assetsToSharesDown(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivDown(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
}
export function assetsToSharesUp(assets: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return mulDivUp(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
}

/** A Morpho Blue market's stored state (IMorpho.Market). */
export type MarketState = {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
};

// ---------------------------------------------------------------------------------------------------------------------
// AdaptiveCurveIrm
// ---------------------------------------------------------------------------------------------------------------------

/** AdaptiveCurveIrm's ConstantsLib, per second and WAD-scaled, with Solidity's integer division. */
export const ADAPTIVE_CURVE_IRM = {
  CURVE_STEEPNESS: 4n * WAD,
  ADJUSTMENT_SPEED: (50n * WAD) / SECONDS_PER_YEAR,
  TARGET_UTILIZATION: (9n * WAD) / 10n,
  INITIAL_RATE_AT_TARGET: (4n * WAD) / 100n / SECONDS_PER_YEAR,
  MIN_RATE_AT_TARGET: WAD / 1000n / SECONDS_PER_YEAR,
  MAX_RATE_AT_TARGET: (2n * WAD) / SECONDS_PER_YEAR,
} as const;

const LN_2_INT = 693_147_180_559_945_309n;
const LN_WEI_INT = -41_446_531_673_892_822_312n;
const WEXP_UPPER_BOUND = 93_859_467_695_000_404_319n;
const WEXP_UPPER_VALUE = 57_716_089_161_558_943_949_701_069_502_944_508_345_128_422_502_756_744_429_568n;

/** ExpLib.wExp. BigInt division truncates toward zero, as Solidity's signed division does. */
export function wExp(x: bigint): bigint {
  if (x < LN_WEI_INT) return 0n;
  if (x >= WEXP_UPPER_BOUND) return WEXP_UPPER_VALUE;
  const roundingAdjustment = x < 0n ? -(LN_2_INT / 2n) : LN_2_INT / 2n;
  const q = (x + roundingAdjustment) / LN_2_INT;
  const r = x - q * LN_2_INT;
  const expR = WAD + r + (r * r) / WAD / 2n;
  return q >= 0n ? expR << q : expR >> -q;
}
const wMulToZero = (x: bigint, y: bigint) => (x * y) / WAD;
const wDivToZero = (x: bigint, y: bigint) => (x * WAD) / y;
/** UtilsLib.bound: min(x, high), then max(that, low). */
const bound = (x: bigint, low: bigint, high: bigint) => {
  const z = x > high ? high : x;
  return z < low ? low : z;
};

function curve(rateAtTarget: bigint, err: bigint): bigint {
  const { CURVE_STEEPNESS } = ADAPTIVE_CURVE_IRM;
  const coeff = err < 0n ? WAD - wDivToZero(WAD, CURVE_STEEPNESS) : CURVE_STEEPNESS - WAD;
  return wMulToZero(wMulToZero(coeff, err) + WAD, rateAtTarget);
}
function newRateAtTarget(start: bigint, linearAdaptation: bigint): bigint {
  return bound(wMulToZero(start, wExp(linearAdaptation)), ADAPTIVE_CURVE_IRM.MIN_RATE_AT_TARGET, ADAPTIVE_CURVE_IRM.MAX_RATE_AT_TARGET);
}

/** The utilisation the IRM uses: totalBorrowAssets.wDivDown(totalSupplyAssets), 0 for an empty market (WAD). */
export function utilization(m: Pick<MarketState, "totalSupplyAssets" | "totalBorrowAssets">): bigint {
  return m.totalSupplyAssets > 0n ? wDivDown(m.totalBorrowAssets, m.totalSupplyAssets) : 0n;
}

/**
 * AdaptiveCurveIrm._borrowRate at time `now` for a market in state `m` whose stored rate at target is
 * `rateAtTarget`: the average borrow rate per second Morpho would apply since m.lastUpdate, and the rate at target
 * the IRM would store. Equal to borrowRateView when `now` is that block's timestamp.
 */
export function adaptiveCurveBorrowRate(m: MarketState, rateAtTarget: bigint, now: bigint): { avgRate: bigint; endRateAtTarget: bigint } {
  const { TARGET_UTILIZATION, ADJUSTMENT_SPEED, INITIAL_RATE_AT_TARGET } = ADAPTIVE_CURVE_IRM;
  const u = utilization(m);
  const errNormFactor = u > TARGET_UTILIZATION ? WAD - TARGET_UTILIZATION : TARGET_UTILIZATION;
  const err = wDivToZero(u - TARGET_UTILIZATION, errNormFactor);
  let avg: bigint;
  let end: bigint;
  if (rateAtTarget === 0n) {
    avg = INITIAL_RATE_AT_TARGET;
    end = INITIAL_RATE_AT_TARGET;
  } else {
    const speed = wMulToZero(ADJUSTMENT_SPEED, err);
    const elapsed = now - m.lastUpdate;
    const linearAdaptation = speed * elapsed;
    if (linearAdaptation === 0n) {
      avg = rateAtTarget;
      end = rateAtTarget;
    } else {
      end = newRateAtTarget(rateAtTarget, linearAdaptation);
      const mid = newRateAtTarget(rateAtTarget, linearAdaptation / 2n);
      avg = (rateAtTarget + end + 2n * mid) / 4n;
    }
  }
  return { avgRate: curve(avg, err), endRateAtTarget: end };
}

/** The borrow rate per second right after an interaction at `now`, at the market's utilisation then (rate at target `endRateAtTarget`, elapsed 0). */
export function instantBorrowRate(m: Pick<MarketState, "totalSupplyAssets" | "totalBorrowAssets">, rateAtTarget: bigint): bigint {
  const { TARGET_UTILIZATION, INITIAL_RATE_AT_TARGET } = ADAPTIVE_CURVE_IRM;
  const u = utilization(m);
  const errNormFactor = u > TARGET_UTILIZATION ? WAD - TARGET_UTILIZATION : TARGET_UTILIZATION;
  const err = wDivToZero(u - TARGET_UTILIZATION, errNormFactor);
  return curve(rateAtTarget === 0n ? INITIAL_RATE_AT_TARGET : rateAtTarget, err);
}

/**
 * The market as Morpho would leave it after accruing interest at `now` (AdaptiveCurveIrmLib.expectedMarketBalances,
 * which mirrors Morpho._accrueInterest): interest = totalBorrowAssets.wMulDown(rate.wTaylorCompounded(elapsed)) added to
 * both totals, the fee minted as supply shares. Also the IRM's new rate at target.
 */
export function expectedMarket(m: MarketState, rateAtTarget: bigint, now: bigint): { market: MarketState; borrowRate: bigint; rateAtTarget: bigint } {
  const elapsed = now - m.lastUpdate;
  if (elapsed < 0n) throw new RangeError("now is before the market's last update");
  if (elapsed === 0n) return { market: { ...m }, borrowRate: instantBorrowRate(m, rateAtTarget), rateAtTarget };
  const { avgRate, endRateAtTarget } = adaptiveCurveBorrowRate(m, rateAtTarget, now);
  if (m.totalBorrowAssets === 0n) return { market: { ...m, lastUpdate: now }, borrowRate: avgRate, rateAtTarget: endRateAtTarget };
  const interest = wMulDown(m.totalBorrowAssets, wTaylorCompounded(avgRate, elapsed));
  const next: MarketState = { ...m, totalBorrowAssets: m.totalBorrowAssets + interest, totalSupplyAssets: m.totalSupplyAssets + interest, lastUpdate: now };
  if (m.fee !== 0n) {
    const feeAmount = wMulDown(interest, m.fee);
    const feeShares = assetsToSharesDown(feeAmount, next.totalSupplyAssets - feeAmount, next.totalSupplyShares);
    next.totalSupplyShares += feeShares;
  }
  if (next.totalBorrowAssets > UINT128_MAX || next.totalSupplyAssets > UINT128_MAX || next.totalSupplyShares > UINT128_MAX) throw new RangeError("market totals above uint128");
  return { market: next, borrowRate: avgRate, rateAtTarget: endRateAtTarget };
}

/** Supply rate per second (WAD) at borrow rate `borrowRate`: borrowRate * utilisation * (1 - fee). */
export function supplyRate(m: Pick<MarketState, "totalSupplyAssets" | "totalBorrowAssets" | "fee">, borrowRate: bigint): bigint {
  return wMulDown(wMulDown(borrowRate, utilization(m)), WAD - m.fee);
}

/** A per-second WAD rate as a simple yearly rate (WAD), and as a number (0.05 = 5%). */
export function ratePerYear(ratePerSecond: bigint): bigint {
  return ratePerSecond * SECONDS_PER_YEAR;
}
export function rateToNumber(wad: bigint): number {
  return Number(wad) / 1e18;
}

/** A market after a supply or a borrow of `supply` / `borrow` assets (positive adds, negative removes), shares at the market's price. */
export function marketAfter(m: MarketState, change: { supply?: bigint; borrow?: bigint }): MarketState {
  const next = { ...m };
  const s = change.supply ?? 0n;
  const b = change.borrow ?? 0n;
  if (s !== 0n) {
    const shares = s > 0n ? assetsToSharesDown(s, m.totalSupplyAssets, m.totalSupplyShares) : -assetsToSharesUp(-s, m.totalSupplyAssets, m.totalSupplyShares);
    next.totalSupplyAssets += s;
    next.totalSupplyShares += shares;
  }
  if (b !== 0n) {
    const shares = b > 0n ? assetsToSharesUp(b, m.totalBorrowAssets, m.totalBorrowShares) : -assetsToSharesDown(-b, m.totalBorrowAssets, m.totalBorrowShares);
    next.totalBorrowAssets += b;
    next.totalBorrowShares += shares;
  }
  if (next.totalSupplyAssets < 0n || next.totalBorrowAssets < 0n || next.totalBorrowAssets > next.totalSupplyAssets) throw new RangeError("the change leaves the market with more borrowed than supplied");
  return next;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------------

export const morphoMarketAbi = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);
export const adaptiveCurveIrmAbi = parseAbi([
  "function rateAtTarget(bytes32 id) view returns (int256)",
  "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)",
]);

type ReadOpts = { blockNumber?: bigint };

/** The timestamp of `opts.blockNumber`, or of the latest block. */
export async function blockTime(client: PublicClient, opts: ReadOpts = {}): Promise<{ blockNumber: bigint; timestamp: bigint }> {
  const b = opts.blockNumber === undefined ? await client.getBlock() : await client.getBlock({ blockNumber: opts.blockNumber });
  return { blockNumber: b.number, timestamp: b.timestamp };
}

/** Whether `e` is a contract revert (as opposed to a network or RPC failure, which callers must not mistake for an answer). */
export function isRevert(e: unknown): boolean {
  return e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) !== null;
}
async function orNullOnRevert<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (isRevert(e)) return null;
    throw e;
  }
}

/** A Morpho Blue market at a block: params, stored state, the IRM's stored rate at target, and the state accrued to that block. */
export type MorphoMarket = {
  id: Hex;
  params: MarketParams;
  stored: MarketState;
  /** Only markets on the AdaptiveCurveIrm are computed; others have adaptive false and no expected state. */
  adaptive: boolean;
  rateAtTarget: bigint;
  at: bigint;
  expected: MarketState | null;
  /** Average borrow rate per second since the last update (what accrual at `at` applies), and the rate right after. */
  borrowRate: bigint;
  instantBorrowRate: bigint;
  /** The rate at target the IRM will store at the next interaction. */
  nextRateAtTarget: bigint;
  /** Free liquidity at `at`: expected supply minus expected borrow. */
  liquidity: bigint;
};

export async function readMorphoMarket(client: PublicClient, id: Hex, at: { blockNumber: bigint; timestamp: bigint }): Promise<MorphoMarket> {
  const [m, p] = await Promise.all([
    client.readContract({ address: MORPHO_BLUE, abi: morphoMarketAbi, functionName: "market", args: [id], blockNumber: at.blockNumber }),
    client.readContract({ address: MORPHO_BLUE, abi: morphoMarketAbi, functionName: "idToMarketParams", args: [id], blockNumber: at.blockNumber }),
  ]);
  const stored: MarketState = { totalSupplyAssets: m[0], totalSupplyShares: m[1], totalBorrowAssets: m[2], totalBorrowShares: m[3], lastUpdate: m[4], fee: m[5] };
  const params: MarketParams = { loanToken: getAddress(p[0]), collateralToken: getAddress(p[1]), oracle: getAddress(p[2]), irm: getAddress(p[3]), lltv: p[4] };
  if (params.loanToken === zeroAddress) throw new Error(`no Morpho Blue market ${id}`);
  const adaptive = params.irm.toLowerCase() === MORPHO_ADAPTIVE_CURVE_IRM.toLowerCase();
  if (!adaptive) {
    return { id, params, stored, adaptive, rateAtTarget: 0n, at: at.timestamp, expected: null, borrowRate: 0n, instantBorrowRate: 0n, nextRateAtTarget: 0n, liquidity: stored.totalSupplyAssets - stored.totalBorrowAssets };
  }
  const rateAtTarget = await client.readContract({ address: params.irm, abi: adaptiveCurveIrmAbi, functionName: "rateAtTarget", args: [id], blockNumber: at.blockNumber });
  const e = expectedMarket(stored, rateAtTarget, at.timestamp);
  return {
    id,
    params,
    stored,
    adaptive,
    rateAtTarget,
    at: at.timestamp,
    expected: e.market,
    borrowRate: e.borrowRate,
    instantBorrowRate: instantBorrowRate(e.market, e.rateAtTarget),
    nextRateAtTarget: e.rateAtTarget,
    liquidity: e.market.totalSupplyAssets - e.market.totalBorrowAssets,
  };
}

/** A position's supply and debt in assets at the market's expected state (supply rounded down, debt up, as Morpho does). */
export async function readMorphoPosition(client: PublicClient, market: MorphoMarket, user: Address, opts: ReadOpts = {}) {
  const p = await client.readContract({ address: MORPHO_BLUE, abi: morphoMarketAbi, functionName: "position", args: [market.id, user], blockNumber: opts.blockNumber });
  const m = market.expected ?? market.stored;
  return {
    supplyShares: p[0],
    borrowShares: BigInt(p[1]),
    collateral: BigInt(p[2]),
    supplyAssets: sharesToAssetsDown(p[0], m.totalSupplyAssets, m.totalSupplyShares),
    borrowAssets: sharesToAssetsUp(BigInt(p[1]), m.totalBorrowAssets, m.totalBorrowShares),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Morpho Vault V2
// ---------------------------------------------------------------------------------------------------------------------

export const vaultV2ReadAbi = parseAbi([
  "function asset() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function accrueInterestView() view returns (uint256, uint256, uint256)",
  "function owner() view returns (address)",
  "function curator() view returns (address)",
  "function isAllocator(address) view returns (bool)",
  "function isSentinel(address) view returns (bool)",
  "function receiveSharesGate() view returns (address)",
  "function sendSharesGate() view returns (address)",
  "function receiveAssetsGate() view returns (address)",
  "function sendAssetsGate() view returns (address)",
  "function canReceiveShares(address) view returns (bool)",
  "function canSendShares(address) view returns (bool)",
  "function canReceiveAssets(address) view returns (bool)",
  "function canSendAssets(address) view returns (bool)",
  "function adapterRegistry() view returns (address)",
  "function adaptersLength() view returns (uint256)",
  "function adapters(uint256) view returns (address)",
  "function isAdapter(address) view returns (bool)",
  "function absoluteCap(bytes32 id) view returns (uint256)",
  "function relativeCap(bytes32 id) view returns (uint256)",
  "function allocation(bytes32 id) view returns (uint256)",
  "function forceDeallocatePenalty(address) view returns (uint256)",
  "function liquidityAdapter() view returns (address)",
  "function liquidityData() view returns (bytes)",
  "function timelock(bytes4) view returns (uint256)",
  "function abdicated(bytes4) view returns (bool)",
  "function executableAt(bytes) view returns (uint256)",
  "function performanceFee() view returns (uint96)",
  "function performanceFeeRecipient() view returns (address)",
  "function managementFee() view returns (uint96)",
  "function managementFeeRecipient() view returns (address)",
  "function maxRate() view returns (uint64)",
  "function lastUpdate() view returns (uint64)",
  "function _totalAssets() view returns (uint128)",
  "function virtualShares() view returns (uint256)",
  "function redeem(uint256 shares, address receiver, address onBehalf) returns (uint256)",
]);
export const marketAdapterAbi = parseAbi([
  "function adapterId() view returns (bytes32)",
  "function parentVault() view returns (address)",
  "function asset() view returns (address)",
  "function morpho() view returns (address)",
  "function adaptiveCurveIrm() view returns (address)",
  "function marketIdsLength() view returns (uint256)",
  "function marketIds(uint256) view returns (bytes32)",
  "function supplyShares(bytes32) view returns (uint256)",
  "function expectedSupplyAssets(bytes32) view returns (uint256)",
  "function realAssets() view returns (uint256)",
  "function timelock(bytes4) view returns (uint256)",
  "function abdicated(bytes4) view returns (bool)",
  "function skimRecipient() view returns (address)",
]);
export const vaultV2FactoryAbi = parseAbi(["function isVaultV2(address) view returns (bool)", "event CreateVaultV2(address indexed owner, address indexed asset, bytes32 salt, address indexed newVaultV2)"]);

/** The curator powers of a Vault V2 that can hurt depositors, each timelocked by the vault (VaultV2.sol, timelocked()). */
export const VAULT_V2_CURATOR_POWERS = [
  "addAdapter(address)",
  "removeAdapter(address)",
  "increaseAbsoluteCap(bytes,uint256)",
  "increaseRelativeCap(bytes,uint256)",
  "setIsAllocator(address,bool)",
  "setPerformanceFee(uint256)",
  "setManagementFee(uint256)",
  "setPerformanceFeeRecipient(address)",
  "setManagementFeeRecipient(address)",
  "setReceiveSharesGate(address)",
  "setSendSharesGate(address)",
  "setReceiveAssetsGate(address)",
  "setSendAssetsGate(address)",
  "setAdapterRegistry(address)",
  "setForceDeallocatePenalty(address,uint256)",
] as const;
/** The timelocked powers of a MorphoMarketV1AdapterV2 (burnShares lowers the vault's share price). */
export const MARKET_ADAPTER_POWERS = ["burnShares(bytes32)", "setSkimRecipient(address)"] as const;

export type Timelocks = Record<string, { seconds: bigint; abdicated: boolean }>;

export type VaultV2Market = MorphoMarket & {
  /** The adapter's supply shares and what they are worth at `at` (as expectedSupplyAssets), the vault's allocation for the market id. */
  supplyShares: bigint;
  supplyAssets: bigint;
  allocation: bigint;
};

export type VaultV2Adapter =
  | { kind: "market"; address: Address; adapterId: Hex; timelocks: Timelocks; markets: VaultV2Market[]; realAssets: bigint }
  | { kind: "other"; address: Address; realAssets: bigint | null };

export type VaultV2State = {
  address: Address;
  at: { blockNumber: bigint; timestamp: bigint };
  asset: Address;
  name: string;
  symbol: string;
  decimals: number;
  /**
   * _totalAssets (stored at the last interaction), and the total after accrual now (accrueInterestView, which is also
   * what totalAssets() returns); totalSupply as stored, and the fee shares accrual would mint now (so a share's value
   * is previewRedeem's: accruedTotalAssets + 1 over totalSupply + feeShares + virtual shares).
   */
  storedTotalAssets: bigint;
  accruedTotalAssets: bigint;
  totalSupply: bigint;
  feeShares: bigint;
  virtualShares: bigint;
  performanceFee: bigint;
  managementFee: bigint;
  maxRate: bigint;
  owner: Address;
  curator: Address;
  gates: { receiveShares: Address; sendShares: Address; receiveAssets: Address; sendAssets: Address };
  adapterRegistry: Address;
  timelocks: Timelocks;
  idle: bigint;
  adapters: VaultV2Adapter[];
  liquidityAdapter: Address;
  liquidityData: Hex;
  /** The liquidity market (liquidityData decoded as MarketParams), when the liquidity adapter is a market adapter. */
  liquidityMarket: MorphoMarket | null;
  liquidityMarketSupply: bigint;
};

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const MARKET_TUPLE = {
  type: "tuple",
  components: [
    { name: "loanToken", type: "address" },
    { name: "collateralToken", type: "address" },
    { name: "oracle", type: "address" },
    { name: "irm", type: "address" },
    { name: "lltv", type: "uint256" },
  ],
} as const;

/** MarketParams from liquidityData or a market id's data, or null when it is not one. */
export function decodeMarketParams(data: Hex): MarketParams | null {
  if (data.length !== 2 + 64 * 5) return null;
  const [m] = decodeAbiParameters([MARKET_TUPLE], data);
  // Solidity's abi.decode (the adapter's allocate and deallocate) reverts on dirty upper bytes of an address word;
  // viem keeps the low 20 bytes. Only data that re-encodes to itself is what the adapter would accept.
  if (encodeAbiParameters([MARKET_TUPLE], [m]).toLowerCase() !== data.toLowerCase()) return null;
  return { loanToken: getAddress(m.loanToken), collateralToken: getAddress(m.collateralToken), oracle: getAddress(m.oracle), irm: getAddress(m.irm), lltv: m.lltv };
}

async function timelocksOf(client: PublicClient, address: Address, powers: readonly string[], abi: typeof vaultV2ReadAbi | typeof marketAdapterAbi, blockNumber: bigint): Promise<Timelocks> {
  const out: Timelocks = {};
  await Promise.all(
    powers.map(async (p) => {
      const sel = toFunctionSelector(`function ${p}`);
      const [seconds, ab] = await Promise.all([
        client.readContract({ address, abi: abi as typeof vaultV2ReadAbi, functionName: "timelock", args: [sel], blockNumber }),
        client.readContract({ address, abi: abi as typeof vaultV2ReadAbi, functionName: "abdicated", args: [sel], blockNumber }),
      ]);
      out[p.slice(0, p.indexOf("("))] = { seconds, abdicated: ab };
    }),
  );
  return out;
}

const adapterFactoryAbi = parseAbi(["function isMorphoMarketV1AdapterV2(address) view returns (bool)", "function morpho() view returns (address)", "function adaptiveCurveIrm() view returns (address)"]);

/**
 * Whether `adapter` is a MorphoMarketV1AdapterV2 that MORPHO_MARKET_V1_ADAPTER_V2_FACTORY created (whose morpho and
 * IRM are Morpho Blue and the AdaptiveCurveIrm; checked in the fork test) for `vault`. RPC failures throw.
 */
async function isMarketAdapter(client: PublicClient, adapter: Address, vault: Address, blockNumber: bigint): Promise<boolean> {
  const made = await client.readContract({ address: MORPHO_MARKET_V1_ADAPTER_V2_FACTORY, abi: adapterFactoryAbi, functionName: "isMorphoMarketV1AdapterV2", args: [adapter], blockNumber });
  if (!made) return false;
  const parent = await client.readContract({ address: adapter, abi: marketAdapterAbi, functionName: "parentVault", blockNumber });
  return parent.toLowerCase() === vault.toLowerCase();
}

/** The vault id of a market behind a market adapter (MorphoMarketV1AdapterV2.ids()[2]). */
export function marketAdapterMarketCapId(adapter: Address, params: MarketParams): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "address" }, MARKET_TUPLE], ["this/marketParams", adapter, { ...params }]),
  );
}
/** The vault id of a collateral token (ids()[1]) and of an adapter (ids()[0], also adapterId). */
export function collateralCapId(token: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }], ["collateralToken", token]));
}
export function adapterCapId(adapter: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "address" }], ["this", adapter]));
}

/** A Morpho Vault V2 at a block (default: the latest), with every market of its market adapters computed to that block. */
export async function readVaultV2(client: PublicClient, vault: Address, opts: ReadOpts = {}): Promise<VaultV2State> {
  const at = await blockTime(client, opts);
  const bn = at.blockNumber;
  const r = <T>(functionName: string, args: unknown[] = []) => client.readContract({ address: vault, abi: vaultV2ReadAbi, functionName: functionName as never, args: args as never, blockNumber: bn }) as Promise<T>;
  const [asset, name, symbol, decimals, storedTotalAssets, accrued, totalSupply, perf, mgmt, maxRate, owner, curator, rsg, ssg, rag, sag, registry, len, la, ld] = await Promise.all([
    r<Address>("asset"),
    orNullOnRevert(r<string>("name")).then((x) => x ?? ""),
    orNullOnRevert(r<string>("symbol")).then((x) => x ?? ""),
    r<number>("decimals"),
    r<bigint>("_totalAssets"),
    r<readonly [bigint, bigint, bigint]>("accrueInterestView"),
    r<bigint>("totalSupply"),
    r<bigint>("performanceFee"),
    r<bigint>("managementFee"),
    r<bigint>("maxRate"),
    r<Address>("owner"),
    r<Address>("curator"),
    r<Address>("receiveSharesGate"),
    r<Address>("sendSharesGate"),
    r<Address>("receiveAssetsGate"),
    r<Address>("sendAssetsGate"),
    r<Address>("adapterRegistry"),
    r<bigint>("adaptersLength"),
    r<Address>("liquidityAdapter"),
    r<Hex>("liquidityData"),
  ]);
  const virtualShares = await r<bigint>("virtualShares");
  const [timelocks, idle] = await Promise.all([
    timelocksOf(client, vault, VAULT_V2_CURATOR_POWERS, vaultV2ReadAbi, bn),
    client.readContract({ address: asset, abi: erc20, functionName: "balanceOf", args: [vault], blockNumber: bn }),
  ]);
  const adapters: VaultV2Adapter[] = [];
  for (let i = 0n; i < len; i++) {
    const a = getAddress(await r<Address>("adapters", [i]));
    if (!(await isMarketAdapter(client, a, vault, bn))) {
      const ra = await orNullOnRevert(client.readContract({ address: a, abi: marketAdapterAbi, functionName: "realAssets", blockNumber: bn }));
      adapters.push({ kind: "other", address: a, realAssets: ra });
      continue;
    }
    const ra = (fn: string, args: unknown[] = []) => client.readContract({ address: a, abi: marketAdapterAbi, functionName: fn as never, args: args as never, blockNumber: bn }) as Promise<never>;
    const [adapterId, n, tl, real] = await Promise.all([ra("adapterId") as Promise<Hex>, ra("marketIdsLength") as Promise<bigint>, timelocksOf(client, a, MARKET_ADAPTER_POWERS, marketAdapterAbi, bn), ra("realAssets") as Promise<bigint>]);
    const markets: VaultV2Market[] = [];
    for (let k = 0n; k < n; k++) {
      const id = (await ra("marketIds", [k])) as Hex;
      const [m, shares] = await Promise.all([readMorphoMarket(client, id, at), ra("supplyShares", [id]) as Promise<bigint>]);
      const e = m.expected ?? m.stored;
      const allocation = await r<bigint>("allocation", [marketAdapterMarketCapId(a, m.params)]);
      markets.push({ ...m, supplyShares: shares, supplyAssets: sharesToAssetsDown(shares, e.totalSupplyAssets, e.totalSupplyShares), allocation });
    }
    adapters.push({ kind: "market", address: a, adapterId, timelocks: tl, markets, realAssets: real });
  }
  let liquidityMarket: MorphoMarket | null = null;
  let liquidityMarketSupply = 0n;
  const lp = decodeMarketParams(ld);
  const laAdapter = adapters.find((x) => x.address.toLowerCase() === la.toLowerCase());
  // An allocator sets liquidityData without a timelock, to anything: a market that does not exist, or one the adapter
  // cannot enter (another loan token or IRM), leaves exit with the idle assets only (deallocate reverts).
  if (lp !== null && laAdapter?.kind === "market" && lp.loanToken.toLowerCase() === asset.toLowerCase() && lp.irm.toLowerCase() === MORPHO_ADAPTIVE_CURVE_IRM.toLowerCase()) {
    const id = marketId(lp);
    const created = await client.readContract({ address: MORPHO_BLUE, abi: morphoMarketAbi, functionName: "market", args: [id], blockNumber: bn });
    if (created[4] !== 0n) {
      liquidityMarket = await readMorphoMarket(client, id, at);
      const shares = await client.readContract({ address: laAdapter.address, abi: marketAdapterAbi, functionName: "supplyShares", args: [id], blockNumber: bn });
      const e = liquidityMarket.expected ?? liquidityMarket.stored;
      liquidityMarketSupply = sharesToAssetsDown(shares, e.totalSupplyAssets, e.totalSupplyShares);
    }
  }
  return {
    address: getAddress(vault),
    at,
    asset: getAddress(asset),
    name,
    symbol,
    decimals: Number(decimals),
    storedTotalAssets,
    accruedTotalAssets: accrued[0],
    totalSupply,
    feeShares: accrued[1] + accrued[2],
    virtualShares,
    performanceFee: perf,
    managementFee: mgmt,
    maxRate,
    owner: getAddress(owner),
    curator: getAddress(curator),
    gates: { receiveShares: getAddress(rsg), sendShares: getAddress(ssg), receiveAssets: getAddress(rag), sendAssets: getAddress(sag) },
    adapterRegistry: getAddress(registry),
    timelocks,
    idle,
    adapters,
    liquidityAdapter: getAddress(la),
    liquidityData: ld,
    liquidityMarket,
    liquidityMarketSupply,
  };
}

/**
 * What a depositor can withdraw now (VaultV2.exit): the vault's idle assets, then the liquidity adapter's position in
 * its liquidity market, at most that market's free liquidity. A redeem larger than this reverts. It holds for this
 * block only: an allocator can, without a timelock, point the liquidity adapter elsewhere, deallocate the liquidity
 * market or move funds within caps, so the next block can leave the idle assets alone.
 */
export function withdrawableNow(v: VaultV2State): bigint {
  if (v.liquidityMarket === null) return v.idle;
  const fromMarket = v.liquidityMarketSupply < v.liquidityMarket.liquidity ? v.liquidityMarketSupply : v.liquidityMarket.liquidity;
  return v.idle + (fromMarket > 0n ? fromMarket : 0n);
}

/** Whether `account` may deposit into and redeem from the vault now (all four gates), read at the vault's block. */
export async function vaultV2GatesAllow(client: PublicClient, v: VaultV2State, account: Address): Promise<{ deposit: boolean; redeem: boolean }> {
  const r = (fn: "canReceiveShares" | "canSendShares" | "canReceiveAssets" | "canSendAssets") => client.readContract({ address: v.address, abi: vaultV2ReadAbi, functionName: fn, args: [account], blockNumber: v.at.blockNumber });
  const [rs, ss, ra, sa] = await Promise.all([r("canReceiveShares"), r("canSendShares"), r("canReceiveAssets"), r("canSendAssets")]);
  return { deposit: rs && sa, redeem: ss && ra };
}

/** Simulates `holder` redeeming `shares` to itself at the latest block: the assets, or why it reverts. */
export async function simulateVaultV2Redeem(client: PublicClient, vault: Address, holder: Address, shares: bigint): Promise<{ ok: true; assets: bigint } | { ok: false; reason: string }> {
  try {
    const { result } = await client.simulateContract({ address: vault, abi: vaultV2ReadAbi, functionName: "redeem", args: [shares, holder, holder], account: holder });
    return { ok: true, assets: result };
  } catch (e) {
    // A revert is an answer (with the contract's reason, a custom error's name or the panic); anything else throws.
    if (!(e instanceof BaseError)) throw e;
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r === null) throw e;
    return { ok: false, reason: r.reason ?? r.data?.errorName ?? r.signature ?? r.shortMessage };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Logs, caps and pending changes
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Logs of `event` from `address` between two blocks, in spans the RPC accepts: a span refused or timed out is cut by 4
 * and tried again, and grows back after a success. Throws only when even `minSpan` is refused.
 */
export async function getLogsChunked<E extends AbiEvent>(
  client: PublicClient,
  q: { address: Address; event: E; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint; maxSpan?: bigint; minSpan?: bigint; pauseMs?: number },
): Promise<Log<bigint, number, false, E, true>[]> {
  const maxSpan = q.maxSpan ?? 4_000_000n;
  const minSpan = q.minSpan ?? 10_000n;
  if (minSpan < 1n || maxSpan < minSpan) throw new RangeError("getLogsChunked needs 1 <= minSpan <= maxSpan");
  const out: Log<bigint, number, false, E, true>[] = [];
  let from = q.fromBlock;
  let span = maxSpan;
  while (from <= q.toBlock) {
    const to = from + span - 1n > q.toBlock ? q.toBlock : from + span - 1n;
    try {
      const logs = (await client.getLogs({ address: q.address, event: q.event, args: q.args as never, fromBlock: from, toBlock: to, strict: true } as never)) as unknown as Log<bigint, number, false, E, true>[];
      out.push(...logs);
      from = to + 1n;
      span = span * 2n > maxSpan ? maxSpan : span * 2n;
      if (q.pauseMs) await new Promise((res) => setTimeout(res, q.pauseMs));
    } catch (e) {
      if (span === minSpan) throw e;
      span = span / 4n < minSpan ? minSpan : span / 4n;
    }
  }
  return out;
}

/** The block the factory created `vault` in (its CreateVaultV2 event), or null when the factory did not create it. */
export async function vaultV2CreationBlock(client: PublicClient, vault: Address, toBlock: bigint): Promise<bigint | null> {
  const ev = parseAbiItem("event CreateVaultV2(address indexed owner, address indexed asset, bytes32 salt, address indexed newVaultV2)");
  const logs = await getLogsChunked(client, { address: MORPHO_VAULT_V2_FACTORY, event: ev, args: { newVaultV2: vault }, fromBlock: 0n, toBlock });
  return logs[0]?.blockNumber ?? null;
}

const capEvents = {
  increaseAbsolute: parseAbiItem("event IncreaseAbsoluteCap(bytes32 indexed id, bytes idData, uint256 newAbsoluteCap)"),
  decreaseAbsolute: parseAbiItem("event DecreaseAbsoluteCap(address indexed sender, bytes32 indexed id, bytes idData, uint256 newAbsoluteCap)"),
  increaseRelative: parseAbiItem("event IncreaseRelativeCap(bytes32 indexed id, bytes idData, uint256 newRelativeCap)"),
  decreaseRelative: parseAbiItem("event DecreaseRelativeCap(address indexed sender, bytes32 indexed id, bytes idData, uint256 newRelativeCap)"),
};

/** What a cap id stands for (MorphoMarketV1AdapterV2.ids, or anything else an adapter returned). */
export type CapIdKind =
  | { kind: "adapter"; adapter: Address }
  | { kind: "collateral"; token: Address }
  | { kind: "market"; adapter: Address; params: MarketParams }
  | { kind: "unknown" };

export function decodeCapIdData(idData: Hex): CapIdKind {
  try {
    const [tag] = decodeAbiParameters([{ type: "string" }], idData);
    if (tag === "this") return { kind: "adapter", adapter: getAddress(decodeAbiParameters([{ type: "string" }, { type: "address" }], idData)[1]) };
    if (tag === "collateralToken") return { kind: "collateral", token: getAddress(decodeAbiParameters([{ type: "string" }, { type: "address" }], idData)[1]) };
    if (tag === "this/marketParams") {
      const [, adapter, m] = decodeAbiParameters([{ type: "string" }, { type: "address" }, MARKET_TUPLE], idData);
      return { kind: "market", adapter: getAddress(adapter), params: { loanToken: getAddress(m.loanToken), collateralToken: getAddress(m.collateralToken), oracle: getAddress(m.oracle), irm: getAddress(m.irm), lltv: m.lltv } };
    }
  } catch {
    // not a shape the market adapter uses
  }
  return { kind: "unknown" };
}

export type VaultCap = { id: Hex; idData: Hex; what: CapIdKind; absoluteCap: bigint; relativeCap: bigint; allocation: bigint };

/** Every cap id the vault's curator ever set (from the cap events), with the cap and allocation in force read at `at`. */
export async function readVaultV2Caps(client: PublicClient, v: VaultV2State, fromBlock: bigint): Promise<VaultCap[]> {
  const ids = new Map<string, Hex>();
  for (const event of Object.values(capEvents)) {
    const logs = await getLogsChunked(client, { address: v.address, event, fromBlock, toBlock: v.at.blockNumber });
    for (const l of logs) {
      const a = l.args as { id: Hex; idData: Hex };
      ids.set(a.id.toLowerCase(), a.idData);
    }
  }
  const out: VaultCap[] = [];
  for (const [id, idData] of ids) {
    if (keccak256(idData).toLowerCase() !== id) throw new Error(`cap event id ${id} does not match its idData`);
    const r = (fn: "absoluteCap" | "relativeCap" | "allocation") => client.readContract({ address: v.address, abi: vaultV2ReadAbi, functionName: fn, args: [id as Hex], blockNumber: v.at.blockNumber });
    const [absoluteCap, relativeCap, allocation] = await Promise.all([r("absoluteCap"), r("relativeCap"), r("allocation")]);
    out.push({ id: id as Hex, idData, what: decodeCapIdData(idData), absoluteCap, relativeCap, allocation });
  }
  return out;
}

/**
 * The most each market and each collateral could hold of this vault after allocator moves that need no timelock
 * (VaultV2.allocateInternal and deallocate; setLiquidityAdapterAndData). Only absolute caps bind for good: a relative
 * cap is checked against firstTotalAssets at allocation time only, so deposits before and withdrawals after an
 * allocation let it exceed its share; the bound is then the vault's total assets. Per market: the largest of what it
 * holds now (interest and cap decreases leave positions above their caps) and min(the absolute caps of its three ids
 * (MorphoMarketV1AdapterV2.ids), total assets). Per collateral: the sum of its markets, at most its own absolute cap or
 * what its markets hold now if more. Markets whose ids lack a non-zero absolute cap cannot be entered, and the adapter
 * only enters markets in the vault's asset on the AdaptiveCurveIrm. `opaque`: adapters that are not market adapters,
 * whose exposure cannot be known.
 */
export function worstCaseExposure(v: VaultV2State, caps: VaultCap[], totalAssets: bigint = v.accruedTotalAssets) {
  // `totalAssets`: the vault's total assets to bound by; pass the total after a planned deposit, which an allocator
  // can then move too.
  const ta = totalAssets;
  const byId = new Map(caps.map((c) => [c.id.toLowerCase(), c]));
  const abs = (id: Hex) => byId.get(id.toLowerCase())?.absoluteCap ?? 0n;
  const min = (xs: bigint[]) => xs.reduce((a, b) => (a < b ? a : b));
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  type Exposure = { id: Hex; adapter: Address; params: MarketParams; now: bigint; max: bigint };
  const found = new Map<string, Exposure>();
  for (const c of caps) {
    if (c.what.kind !== "market") continue;
    const adapter = c.what.adapter;
    const p = c.what.params;
    if (!v.adapters.some((a) => a.kind === "market" && a.address.toLowerCase() === adapter.toLowerCase())) continue;
    if (p.loanToken.toLowerCase() !== v.asset.toLowerCase() || p.irm.toLowerCase() !== MORPHO_ADAPTIVE_CURVE_IRM.toLowerCase()) continue;
    const enterable = min([abs(c.id), abs(collateralCapId(p.collateralToken)), abs(adapterCapId(adapter)), ta]);
    found.set(`${adapter.toLowerCase()}:${marketId(p).toLowerCase()}`, { id: marketId(p), adapter, params: p, now: 0n, max: enterable });
  }
  for (const a of v.adapters) {
    if (a.kind !== "market") continue;
    for (const m of a.markets) {
      const k = `${a.address.toLowerCase()}:${m.id.toLowerCase()}`;
      const e = found.get(k) ?? { id: m.id, adapter: a.address, params: m.params, now: 0n, max: 0n };
      e.now = m.supplyAssets;
      e.max = max(e.max, m.supplyAssets);
      found.set(k, e);
    }
  }
  const markets = [...found.values()].filter((m) => m.max > 0n);
  const collaterals = new Map<string, { token: Address; now: bigint; max: bigint; markets: Exposure[] }>();
  for (const m of markets) {
    const k = m.params.collateralToken.toLowerCase();
    const e = collaterals.get(k) ?? { token: m.params.collateralToken, now: 0n, max: 0n, markets: [] };
    e.markets.push(m);
    e.now += m.now;
    collaterals.set(k, e);
  }
  for (const e of collaterals.values()) {
    const sum = e.markets.reduce((s, m) => s + m.max, 0n);
    e.max = max(e.now, min([sum, abs(collateralCapId(e.token)), ta]));
  }
  const opaque = v.adapters.filter((a) => a.kind === "other").map((a) => a.address);
  return { totalAssets: ta, markets, collaterals: [...collaterals.values()], opaque };
}

const submitEvent = parseAbiItem("event Submit(bytes4 indexed selector, bytes data, uint256 executableAt)");

/** Changes a vault's curator (and its market adapters' curator) submitted and that are still pending: their data, and when they become executable. */
export async function readPendingChanges(client: PublicClient, v: VaultV2State, fromBlock: bigint): Promise<{ target: Address; selector: Hex; data: Hex; executableAt: bigint; abdicated: boolean }[]> {
  // Market adapters have the vault's timelock system; other adapters are read the same way, and a target without it
  // simply has no Submit events.
  const targets: Address[] = [v.address, ...v.adapters.map((a) => a.address)];
  const out: { target: Address; selector: Hex; data: Hex; executableAt: bigint; abdicated: boolean }[] = [];
  for (const target of targets) {
    const logs = await getLogsChunked(client, { address: target, event: submitEvent, fromBlock, toBlock: v.at.blockNumber });
    const seen = new Set<string>();
    for (const l of logs) {
      const a = l.args as { selector: Hex; data: Hex };
      if (seen.has(a.data)) continue;
      seen.add(a.data);
      const at = await orNullOnRevert(client.readContract({ address: target, abi: vaultV2ReadAbi, functionName: "executableAt", args: [a.data], blockNumber: v.at.blockNumber }) as Promise<bigint>);
      if (at === null || at === 0n) continue;
      const abdicated = (await orNullOnRevert(client.readContract({ address: target, abi: vaultV2ReadAbi, functionName: "abdicated", args: [a.selector], blockNumber: v.at.blockNumber }))) === true;
      out.push({ target, selector: a.selector, data: a.data, executableAt: at, abdicated });
    }
  }
  return out;
}

const allocatorEvent = parseAbiItem("event SetIsAllocator(address indexed account, bool newIsAllocator)");

/** The vault's allocators now: every account a SetIsAllocator event named, confirmed by isAllocator. */
export async function readAllocators(client: PublicClient, v: VaultV2State, fromBlock: bigint): Promise<Address[]> {
  const logs = await getLogsChunked(client, { address: v.address, event: allocatorEvent, fromBlock, toBlock: v.at.blockNumber });
  const named = [...new Set(logs.map((l) => getAddress((l.args as { account: Address }).account)))];
  const live = await Promise.all(named.map((a) => client.readContract({ address: v.address, abi: vaultV2ReadAbi, functionName: "isAllocator", args: [a], blockNumber: v.at.blockNumber })));
  return named.filter((_, i) => live[i]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Oracles
// ---------------------------------------------------------------------------------------------------------------------

const chainlinkOracleAbi = parseAbi([
  "function price() view returns (uint256)",
  "function BASE_FEED_1() view returns (address)",
  "function BASE_FEED_2() view returns (address)",
  "function QUOTE_FEED_1() view returns (address)",
  "function QUOTE_FEED_2() view returns (address)",
  "function BASE_VAULT() view returns (address)",
  "function QUOTE_VAULT() view returns (address)",
  "function SCALE_FACTOR() view returns (uint256)",
]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)", "function description() view returns (string)"]);

/** A feed's last round; null fields: the feed reverted on that getter. */
export type OracleFeed = { address: Address; description: string; decimals: number | null; answer: bigint | null; updatedAt: bigint | null };
export type OracleInfo = {
  address: Address;
  price: bigint | null;
  /** chainlink: answers every MorphoChainlinkOracleV2 getter with a non-zero scale factor; unknown: anything else. */
  kind: "chainlink" | "unknown";
  baseFeeds: OracleFeed[];
  quoteFeeds: OracleFeed[];
  baseVault: Address | null;
  quoteVault: Address | null;
  scaleFactor: bigint | null;
};

async function readFeed(client: PublicClient, address: Address, blockNumber: bigint): Promise<OracleFeed> {
  const [round, decimals, description] = await Promise.all([
    orNullOnRevert(client.readContract({ address, abi: feedAbi, functionName: "latestRoundData", blockNumber })),
    orNullOnRevert(client.readContract({ address, abi: feedAbi, functionName: "decimals", blockNumber })),
    orNullOnRevert(client.readContract({ address, abi: feedAbi, functionName: "description", blockNumber })),
  ]);
  return { address: getAddress(address), description: description ?? "", decimals: decimals === null ? null : Number(decimals), answer: round?.[1] ?? null, updatedAt: round?.[3] ?? null };
}

/** An oracle's price and, when it is a MorphoChainlinkOracleV2, its feeds (with their last update) and vaults. */
export async function readOracle(client: PublicClient, oracle: Address, opts: ReadOpts = {}): Promise<OracleInfo> {
  const at = await blockTime(client, opts);
  const r = (fn: string) => orNullOnRevert(client.readContract({ address: oracle, abi: chainlinkOracleAbi, functionName: fn as never, blockNumber: at.blockNumber }) as Promise<unknown>);
  const [price, b1, b2, q1, q2, bv, qv, sf] = (await Promise.all(["price", "BASE_FEED_1", "BASE_FEED_2", "QUOTE_FEED_1", "QUOTE_FEED_2", "BASE_VAULT", "QUOTE_VAULT", "SCALE_FACTOR"].map(r))) as unknown as [
    bigint | null,
    Address | null,
    Address | null,
    Address | null,
    Address | null,
    Address | null,
    Address | null,
    bigint | null,
  ];
  // The getters decide the kind; a price that reverts is reported as null without hiding the feeds.
  const getters = [b1, b2, q1, q2, bv, qv, sf];
  const kind = getters.every((g) => g !== null) && sf !== null && sf > 0n ? "chainlink" : "unknown";
  const feeds = async (xs: (Address | null)[]) => Promise.all(xs.filter((x): x is Address => x !== null && x !== zeroAddress).map((x) => readFeed(client, x, at.blockNumber)));
  return {
    address: getAddress(oracle),
    price,
    kind,
    baseFeeds: kind === "chainlink" ? await feeds([b1, b2]) : [],
    quoteFeeds: kind === "chainlink" ? await feeds([q1, q2]) : [],
    baseVault: bv !== null && bv !== zeroAddress ? getAddress(bv) : null,
    quoteVault: qv !== null && qv !== zeroAddress ? getAddress(qv) : null,
    scaleFactor: sf,
  };
}
