// Reads for OstraVault version 3: a vault's withdrawal lock and linked vault, and its positions on Borro (Morpho
// Vault V2 shares, Morpho Blue collateral and debt), computed as the contracts compute them:
//   * the debt of a position is Morpho's toAssetsUp (SharesMathLib, 1 virtual asset, 1e6 virtual shares);
//   * what a Borrow may leave owed is half of what the market's LLTV allows at its oracle price
//     (OstraVaultModule._checkLtv, MAX_LTV_OF_LLTV_BPS), rounded down.
// Market totals are the market accrued to the block read (morpho.ts readMorphoMarket: the AdaptiveCurveIrm and
// Morpho's accrual, exact against the contracts), not the totals as stored: Morpho stores the interest only when the
// market is touched, so stored totals leave a debt unchanged for as long as nobody interacts. Every read here is
// taken at one block.

import { getAddress, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { ostraVaultAbi } from "./abi.ts";
import { BORRO_IRM, BORRO_ROUTER, BORRO_STOCKS, BORRO_USDG_VAULT, MORPHO_BLUE, USDG, VAULT_MAX_LTV_OF_LLTV_BPS, VAULT_V3 } from "./constants.ts";
import { marketId, type MarketParams, type WithdrawalLock } from "./messages.ts";
import { blockTime, readMorphoMarket } from "./morpho.ts";

/** What the reads call on Morpho Blue (morpho-blue src/interfaces/IMorpho.sol). */
export const morphoBlueAbi = parseAbi([
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function repay((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
]);

/** A Morpho Blue oracle (price of one collateral unit in loan units, scaled by 1e36) and an IRM's view of the borrow rate per second (WAD). */
export const morphoOracleAbi = parseAbi(["function price() view returns (uint256)"]);
export const morphoIrmAbi = parseAbi([
  "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)",
]);

/** A Morpho Vault V2 as an ERC-4626 vault. */
export const vaultV2Abi = parseAbi([
  "function asset() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);

/** BorroRouter.listed and BorroBuilders.vaults. */
export const borroRouterAbi = parseAbi(["function listed(bytes32 id) view returns (bool)"]);
export const borroBuildersAbi = parseAbi(["function vaults(address vault) view returns (bool)", "function builders(bytes32 code) view returns (address)"]);

/** A Borro stock: the stock token, its Borro vault (Morpho Vault V2 of the stock) and its USDG market. */
export type BorroStock = { symbol: string; token: Address; vault: Address; market: MarketParams; marketId: Hex; builders: boolean };

/** Borro's stocks (BORRO_STOCKS), with each USDG market's params and id. */
export function borroStocks(): BorroStock[] {
  return BORRO_STOCKS.map((s) => {
    const market: MarketParams = { loanToken: USDG, collateralToken: s.vault, oracle: s.oracle, irm: BORRO_IRM, lltv: s.lltv };
    return { symbol: s.symbol, token: getAddress(s.token), vault: getAddress(s.vault), market, marketId: marketId(market), builders: s.builders };
  });
}

/** The Borro stock of `symbolOrToken` (a ticker such as NVDA, or the stock token's address); throws for anything else. */
export function borroStock(symbolOrToken: string): BorroStock {
  const s = symbolOrToken.startsWith("0x")
    ? borroStocks().find((x) => x.token.toLowerCase() === symbolOrToken.toLowerCase())
    : borroStocks().find((x) => x.symbol === symbolOrToken.toUpperCase());
  if (s === undefined) throw new RangeError(`${symbolOrToken} is not a Borro stock; Borro lists ${BORRO_STOCKS.map((x) => x.symbol).join(", ")}`);
  return s;
}

/** Morpho's SharesMathLib.toAssetsUp. */
export function toAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  const num = shares * (totalAssets + 1n);
  const den = totalShares + 1_000_000n;
  return (num + den - 1n) / den;
}

/** What `collateral` (collateral units) may leave owed at half the LLTV, at `price` (the oracle's, 1e36-scaled), as OstraVaultModule rounds it. */
export function halfLltvMaxDebt(collateral: bigint, price: bigint, lltv: bigint): bigint {
  const value = (collateral * price) / 10n ** 36n;
  return (value * lltv * VAULT_MAX_LTV_OF_LLTV_BPS) / (10n ** 18n * 10_000n);
}

/** A vault's version 3 settings; `version` below 3 means none of them exists yet. */
export type VaultGuardState = {
  version: number;
  /** The lock in force (a change whose wait is over counts as made); withdrawal zero = off. */
  lock: WithdrawalLock;
  /** When the lock in force was turned on (unix seconds); 0 while off. */
  lockedSince: bigint;
  /** What may still go out against the daily limit now; null while the lock is off. */
  outflowAvailable: bigint | null;
  /** The linked vault in force; null = none. */
  linkedVault: Address | null;
  /** A lock change and a link change still waiting, with when each takes effect (unix seconds). */
  pendingLock: { lock: WithdrawalLock; at: bigint } | null;
  pendingLink: { vault: Address | null; at: bigint } | null;
};

export async function readVaultGuard(client: PublicClient, vault: Address): Promise<VaultGuardState> {
  const version = Number(await client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "VERSION" }));
  const off: WithdrawalLock = { withdrawal: zeroAddress, delay: 0, dailyLimit: 0n };
  if (version < VAULT_V3) return { version, lock: off, lockedSince: 0n, outflowAvailable: null, linkedVault: null, pendingLock: null, pendingLink: null };
  const [lock, lockedSince, available, linked, pending] = await Promise.all([
    client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "withdrawalLock" }) as Promise<{ withdrawal: Address; delay: number; dailyLimit: bigint }>,
    client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "lockedSince" }) as Promise<bigint>,
    client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "outflowAvailable" }) as Promise<bigint>,
    client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "linkedVault" }) as Promise<Address>,
    client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "pendingChanges" }) as Promise<
      readonly [{ withdrawal: Address; delay: number; dailyLimit: bigint }, bigint, Address, bigint]
    >,
  ]);
  const [pLock, pLockAt, pLink, pLinkAt] = pending;
  const on = lock.withdrawal !== zeroAddress;
  return {
    version,
    lock: { withdrawal: getAddress(lock.withdrawal), delay: Number(lock.delay), dailyLimit: lock.dailyLimit },
    lockedSince: BigInt(lockedSince),
    outflowAvailable: on ? available : null,
    linkedVault: linked === zeroAddress ? null : getAddress(linked),
    pendingLock: pLockAt === 0n ? null : { lock: { withdrawal: getAddress(pLock.withdrawal), delay: Number(pLock.delay), dailyLimit: pLock.dailyLimit }, at: pLockAt },
    pendingLink: pLinkAt === 0n ? null : { vault: pLink === zeroAddress ? null : getAddress(pLink), at: pLinkAt },
  };
}

/** A vault's position in a Borro stock market, and the market around it. */
export type BorroPosition = {
  stock: BorroStock;
  /** Borro vault shares the stock vault holds (lent, not posted), and what they redeem for now (stock units). */
  shares: bigint;
  sharesValue: bigint;
  /** Shares posted as collateral, and the debt in USDG base units (rounded up, as Morpho). */
  collateral: bigint;
  borrowShares: bigint;
  debt: bigint;
  /** The oracle's price (1e36 scale) and what the collateral may leave owed at half the LLTV. */
  price: bigint;
  maxDebt: bigint;
  /** The debt over what the LLTV allows, in bps (10,000 = liquidation); 0 without debt. */
  ltvOfLltvBps: bigint;
  /** USDG the market can lend now, and its borrow rate per year (WAD, simple: rate per second * seconds per year). */
  available: bigint;
  borrowRatePerYear: bigint;
  listed: boolean;
  /** The market's supply and borrows (USDG base units) and the time they are accrued to (unix seconds). */
  supply: bigint;
  borrowed: bigint;
  /** The market's borrow shares, accrued to `at` with `borrowed`: what any number of borrow shares owes now is toAssetsUp(shares, borrowed, borrowedShares). */
  borrowedShares: bigint;
  at: bigint;
};

const SECONDS_PER_YEAR = 31_536_000n;

export async function readBorroPosition(client: PublicClient, stockVault: Address, stock: BorroStock): Promise<BorroPosition> {
  const m = stock.market;
  const at = await blockTime(client);
  const blockNumber = at.blockNumber;
  const [pos, market, price, shares, listed] = await Promise.all([
    client.readContract({ address: MORPHO_BLUE, abi: morphoBlueAbi, functionName: "position", args: [stock.marketId, stockVault], blockNumber }),
    readMorphoMarket(client, stock.marketId, at),
    client.readContract({ address: m.oracle, abi: morphoOracleAbi, functionName: "price", blockNumber }),
    client.readContract({ address: stock.vault, abi: vaultV2Abi, functionName: "balanceOf", args: [stockVault], blockNumber }),
    client.readContract({ address: BORRO_ROUTER, abi: borroRouterAbi, functionName: "listed", args: [stock.marketId], blockNumber }),
  ]);
  if (market.expected === null) throw new Error(`the ${stock.symbol} market ${stock.marketId} is not on the AdaptiveCurveIrm`);
  const [, borrowShares, collateral] = pos;
  const e = market.expected;
  const sharesValue = shares === 0n ? 0n : await client.readContract({ address: stock.vault, abi: vaultV2Abi, functionName: "previewRedeem", args: [shares], blockNumber });
  const debt = borrowShares === 0n ? 0n : toAssetsUp(BigInt(borrowShares), e.totalBorrowAssets, e.totalBorrowShares);
  const fullLimit = (((BigInt(collateral) * price) / 10n ** 36n) * m.lltv) / 10n ** 18n;
  return {
    stock,
    shares,
    sharesValue,
    collateral: BigInt(collateral),
    borrowShares: BigInt(borrowShares),
    debt,
    price,
    maxDebt: halfLltvMaxDebt(BigInt(collateral), price, m.lltv),
    ltvOfLltvBps: debt === 0n ? 0n : fullLimit === 0n ? 10_000n * 10n : (debt * 10_000n) / fullLimit,
    available: market.liquidity > 0n ? market.liquidity : 0n,
    borrowRatePerYear: market.instantBorrowRate * SECONDS_PER_YEAR,
    listed,
    supply: e.totalSupplyAssets,
    borrowed: e.totalBorrowAssets,
    borrowedShares: e.totalBorrowShares,
    at: at.timestamp,
  };
}

/** The USDG a vault has lent to Borro (bUSDG shares) and what they redeem for now. */
export async function readBorroUsdg(client: PublicClient, usdgVault: Address): Promise<{ vault: Address; shares: bigint; value: bigint }> {
  const shares = await client.readContract({ address: BORRO_USDG_VAULT, abi: vaultV2Abi, functionName: "balanceOf", args: [usdgVault] });
  const value = shares === 0n ? 0n : await client.readContract({ address: BORRO_USDG_VAULT, abi: vaultV2Abi, functionName: "previewRedeem", args: [shares] });
  return { vault: BORRO_USDG_VAULT, shares, value };
}
