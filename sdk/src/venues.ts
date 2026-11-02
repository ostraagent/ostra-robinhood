// The venue breaker's view of a vault (OstraVault version 4, OstraVaultModuleV4): the vault's record of a venue
// (OstraVaultV4.Venue at its ERC-7201 slot, packed as Solidity packs it), what the breaker finds there now (the module's
// _reasons: the venue's code hash, its implementation, Raeto's source, a Raeto stock vault's LTV), the position the
// module reads, and whether the venue reports a loss (_inLoss). One implementation for the agent's MCP (core
// venues.ts) and the keeper that trips positions while their agents are offline (keeper venue-breaker.ts).

import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, encodeAbiParameters, getAddress, keccak256, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { MORPHO_VAULT_V2_FACTORY, RAETO_AAPL_VAULT, RAETO_GOOGL_VAULT, RAETO_NVDA_VAULT, RAETO_SPCX_VAULT, RAETO_TSLA_VAULT, RAETO_USDG_VAULT, SPARK_SAVINGS_USDG, USDG, VENUE_KIND } from "./constants.ts";
import type { VenueKind } from "./messages.ts";
import { readVaultV2, vaultV2FactoryAbi, withdrawableNow } from "./morpho.ts";

/** OstraVaultV4.SLOT, the ERC-7201 slot of the version 4 state: its first field is the venues mapping. */
export const VENUE_V4_SLOT = 0x041142257ce3186a412fed729b7a3ab63ef6a55d4358e7ac1bc4b2f6a8b54400n;
/** OstraVaultModuleV4's breaker reasons (a bit each). */
export const VENUE_REASON = { CODE: 1, IMPLEMENTATION: 2, SOURCE: 4, LTV: 8 } as const;
/** OstraVaultModuleV4.PRICE_SCALE: an ERC4626 venue's price is the assets of this many whole shares. */
export const VENUE_PRICE_SCALE = 1_000_000_000n;
const U64 = (1n << 64n) - 1n;
const U160 = (1n << 160n) - 1n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";

/**
 * The venues of the design's first release (decided by Edu, 30 Oct to 1 Nov 2026), as (kind, venue): Spark Savings
 * USDG as ERC4626, Raeto's USDG vault, and Raeto's stock vaults. The keeper's breaker acts on these alone: a venue
 * anyone deploys and a vault enables could make each trip land and do nothing, at the keeper's gas.
 */
export const VENUE_CATALOG: readonly { kind: VenueKind; venue: Address }[] = [
  { kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG },
  { kind: VENUE_KIND.RAETO_USDG, venue: RAETO_USDG_VAULT },
  ...[RAETO_NVDA_VAULT, RAETO_TSLA_VAULT, RAETO_GOOGL_VAULT, RAETO_AAPL_VAULT, RAETO_SPCX_VAULT].map((venue) => ({ kind: VENUE_KIND.RAETO_STOCK, venue })),
];

/** Whether (kind, venue) is one of VENUE_CATALOG's. */
export function inVenueCatalog(kind: number, venue: Address): boolean {
  return VENUE_CATALOG.some((x) => x.kind === kind && getAddress(x.venue) === getAddress(venue));
}

/** OstraVaultV4's Entered event: emitted at the vault's own address (the module runs in its context). */
export const venueEnteredEvent = parseAbiItem("event Entered(uint8 indexed kind, address indexed venue, uint256 amount, uint256 positionGain)");
/** OstraVaultV4's VenueTripped event (the breaker's trip): reasons, what came home, and who sent it. */
export const venueTrippedEvent = parseAbiItem("event VenueTripped(uint8 indexed kind, address indexed venue, uint8 reasons, uint256 amount, address indexed by)");

const raetoAbi = parseAbi([
  "function source() view returns (address)",
  "function queuedSourceEta() view returns (uint256)",
  "function SOURCE_GRACE() view returns (uint256)",
  "function principalOf(address) view returns (uint256)",
  "function inLoss() view returns (bool)",
]);
const raetoStockAbi = parseAbi([
  "function stockOf(address) view returns (uint256)",
  "function sharesOf(address) view returns (uint256)",
  "function ltv() view returns (uint256)",
  "function maxLtv() view returns (uint256)",
  "function inLoss() view returns (bool)",
  "function sink() view returns (address)",
  "function reserve() view returns (uint256)",
  "function debt() view returns (uint256)",
]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const erc4626Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function getImplementation() view returns (address)",
  "function maxRedeem(address) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
]);

/** The vault's own record of a venue (OstraVaultV4.Venue), read from its storage. */
export type VenueRecord = { enabled: boolean; entered: boolean; from: bigint; epoch: bigint; codeHash: Hex; pinned: Address; tolerance: bigint; priceMark: bigint };

/** `vault`'s record of (kind, venue): the mapping value at keccak256(abi.encode(keccak256(abi.encode(kind, venue)), SLOT)). */
export async function readVenueRecord(client: PublicClient, vault: Address, kind: VenueKind, venue: Address): Promise<VenueRecord> {
  const key = keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "address" }], [kind, venue]));
  const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [key, VENUE_V4_SLOT])));
  const word = async (i: bigint) => BigInt((await client.getStorageAt({ address: vault, slot: `0x${(base + i).toString(16).padStart(64, "0")}` as Hex })) ?? "0x0");
  const [s0, s1, s2, s3] = await Promise.all([word(0n), word(1n), word(2n), word(3n)]);
  return {
    enabled: (s0 & 0xffn) !== 0n,
    entered: ((s0 >> 8n) & 0xffn) !== 0n,
    from: (s0 >> 16n) & U64,
    epoch: (s0 >> 80n) & U64,
    codeHash: `0x${s1.toString(16).padStart(64, "0")}` as Hex,
    pinned: getAddress(`0x${(s2 & U160).toString(16).padStart(40, "0")}`),
    tolerance: (s2 >> 160n) & U64,
    priceMark: s3,
  };
}

/**
 * What an ERC4626 venue names as its implementation (getImplementation), the zero address when it does not answer one
 * (it reverts or returns nothing, as the module's staticcall reads it). Anything else (the RPC failing) is thrown: it
 * must not read as another implementation.
 */
export async function venueImplementation(client: PublicClient, venue: Address): Promise<Address> {
  try {
    return getAddress(await client.readContract({ address: venue, abi: erc4626Abi, functionName: "getImplementation" }));
  } catch (err) {
    if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null) return ZERO;
    throw err;
  }
}

/** An ERC4626 venue's price as the module reads it: the assets of VENUE_PRICE_SCALE whole shares. */
export async function venuePrice(client: PublicClient, venue: Address): Promise<bigint> {
  const decimals = await client.readContract({ address: venue, abi: erc4626Abi, functionName: "decimals" });
  return client.readContract({ address: venue, abi: erc4626Abi, functionName: "convertToAssets", args: [VENUE_PRICE_SCALE * 10n ** BigInt(decimals)] });
}

/**
 * The breaker's reasons for the record `r` of (kind, venue) now, as OstraVaultModuleV4._reasons computes them: CODE
 * alone when the venue's code hash is not the pinned one; otherwise SOURCE (RAETO_USDG: a queued source within its
 * grace, or a source other than the pinned one), LTV (RAETO_STOCK: above its max) or IMPLEMENTATION (ERC4626: another
 * implementation than the pinned one). The time is the latest block's (the trip runs in the next one).
 */
export async function venueReasons(client: PublicClient, kind: VenueKind, venue: Address, r: VenueRecord): Promise<number> {
  const code = (await client.getCode({ address: venue })) ?? "0x";
  if (keccak256(code).toLowerCase() !== r.codeHash.toLowerCase()) return VENUE_REASON.CODE;
  if (kind === VENUE_KIND.RAETO_USDG) {
    const [eta, grace, source] = await Promise.all([
      client.readContract({ address: venue, abi: raetoAbi, functionName: "queuedSourceEta" }),
      client.readContract({ address: venue, abi: raetoAbi, functionName: "SOURCE_GRACE" }),
      client.readContract({ address: venue, abi: raetoAbi, functionName: "source" }),
    ]);
    const now = (await client.getBlock({ blockTag: "latest" })).timestamp;
    return (eta !== 0n && now <= eta + grace) || getAddress(source) !== r.pinned ? VENUE_REASON.SOURCE : 0;
  }
  if (kind === VENUE_KIND.RAETO_STOCK) {
    const [ltv, max] = await Promise.all([client.readContract({ address: venue, abi: raetoStockAbi, functionName: "ltv" }), client.readContract({ address: venue, abi: raetoStockAbi, functionName: "maxLtv" })]);
    return ltv > max ? VENUE_REASON.LTV : 0;
  }
  return (await venueImplementation(client, venue)) !== r.pinned ? VENUE_REASON.IMPLEMENTATION : 0;
}

/** The names of a reasons bitmask (code, implementation, source, ltv). */
export function venueReasonNames(reasons: number): string[] {
  const out: string[] = [];
  if ((reasons & VENUE_REASON.CODE) !== 0) out.push("code");
  if ((reasons & VENUE_REASON.IMPLEMENTATION) !== 0) out.push("implementation");
  if ((reasons & VENUE_REASON.SOURCE) !== 0) out.push("source");
  if ((reasons & VENUE_REASON.LTV) !== 0) out.push("ltv");
  return out;
}

/** The position `vault` holds in (kind, venue) as the module reads it (_position): RAETO_USDG principal; RAETO_STOCK stock; ERC4626 assets. */
export async function venuePosition(client: PublicClient, kind: VenueKind, venue: Address, vault: Address): Promise<bigint> {
  if (kind === VENUE_KIND.RAETO_USDG) return client.readContract({ address: venue, abi: raetoAbi, functionName: "principalOf", args: [vault] });
  if (kind === VENUE_KIND.RAETO_STOCK) return client.readContract({ address: venue, abi: raetoStockAbi, functionName: "stockOf", args: [vault] });
  const shares = await client.readContract({ address: venue, abi: erc4626Abi, functionName: "balanceOf", args: [vault] });
  return shares === 0n ? 0n : client.readContract({ address: venue, abi: erc4626Abi, functionName: "convertToAssets", args: [shares] });
}

/** Whether (kind, venue) reports a loss for the record `r` (_inLoss): Raeto's inLoss(); ERC4626 a price below the vault's mark. */
export async function venueInLoss(client: PublicClient, kind: VenueKind, venue: Address, r: VenueRecord): Promise<boolean> {
  if (kind === VENUE_KIND.RAETO_USDG) return client.readContract({ address: venue, abi: raetoAbi, functionName: "inLoss" });
  if (kind === VENUE_KIND.RAETO_STOCK) return client.readContract({ address: venue, abi: raetoStockAbi, functionName: "inLoss" });
  return (await venuePrice(client, venue)) < r.priceMark;
}

/**
 * What the breaker finds for `vault` in (kind, venue) now: whether it entered, its position, the reasons (0 while it
 * holds nothing there: the module has nothing to bring home) and the loss.
 */
export async function readVenueBreaker(client: PublicClient, vault: Address, kind: VenueKind, venue: Address): Promise<{ entered: boolean; position: bigint; reasons: number; inLoss: boolean }> {
  const r = await readVenueRecord(client, vault, kind, venue);
  if (!r.entered) return { entered: false, position: 0n, reasons: 0, inLoss: false };
  const position = await venuePosition(client, kind, venue, vault);
  if (position === 0n) return { entered: true, position, reasons: 0, inLoss: false };
  return { entered: true, position, reasons: await venueReasons(client, kind, venue, r), inLoss: await venueInLoss(client, kind, venue, r) };
}

/** What `holder` can take out of the Morpho vault `source` now: its position, at most what it can pay out (a Vault V2's withdrawable, else maxWithdraw). */
export async function sourcePayout(client: PublicClient, holder: Address, source: Address): Promise<bigint> {
  const shares = await client.readContract({ address: source, abi: erc4626Abi, functionName: "balanceOf", args: [holder] });
  const value = shares === 0n ? 0n : await client.readContract({ address: source, abi: erc4626Abi, functionName: "convertToAssets", args: [shares] });
  if ((await client.readContract({ address: MORPHO_VAULT_V2_FACTORY, abi: vaultV2FactoryAbi, functionName: "isVaultV2", args: [source] })) as boolean) {
    const w = withdrawableNow(await readVaultV2(client, source));
    return value < w ? value : w;
  }
  return client.readContract({ address: source, abi: erc4626Abi, functionName: "maxWithdraw", args: [holder] });
}

/**
 * The position `vault` holds in (kind, venue) in the units tripVenue's amount takes: ERC4626 shares (balanceOf), Raeto
 * USDG principal (principalOf), Raeto stock vault shares (sharesOf).
 */
export async function venueHeldUnits(client: PublicClient, kind: VenueKind, venue: Address, vault: Address): Promise<bigint> {
  if (kind === VENUE_KIND.RAETO_USDG) return client.readContract({ address: venue, abi: raetoAbi, functionName: "principalOf", args: [vault] });
  if (kind === VENUE_KIND.RAETO_STOCK) return client.readContract({ address: venue, abi: raetoStockAbi, functionName: "sharesOf", args: [vault] });
  return client.readContract({ address: venue, abi: erc4626Abi, functionName: "balanceOf", args: [vault] });
}

/**
 * What of `vault`'s position the venue can pay now, in tripVenue's units: ERC4626 maxRedeem(vault); Raeto USDG the USDG
 * it holds and its source pays out (principal is 1:1 USDG; as core venues.ts reads its payout); a Raeto stock vault the share of the vault's shares the
 * USDG it can raise now (its idle USDG over its reserve, and what its sink pays out) covers of its loan, all of them
 * with no loan. Never more than the position.
 */
export async function venuePayableUnits(client: PublicClient, kind: VenueKind, venue: Address, vault: Address): Promise<bigint> {
  const held = await venueHeldUnits(client, kind, venue, vault);
  const cap = (x: bigint) => (x < held ? x : held);
  if (kind === VENUE_KIND.ERC4626) return cap(await client.readContract({ address: venue, abi: erc4626Abi, functionName: "maxRedeem", args: [vault] }));
  if (kind === VENUE_KIND.RAETO_USDG) {
    const idle = await client.readContract({ address: USDG, abi: tokenAbi, functionName: "balanceOf", args: [venue] });
    const source = getAddress(await client.readContract({ address: venue, abi: raetoAbi, functionName: "source" }));
    return cap(idle + (source === ZERO ? 0n : await sourcePayout(client, venue, source)));
  }
  const [debt, reserve, sink] = await Promise.all([
    client.readContract({ address: venue, abi: raetoStockAbi, functionName: "debt" }),
    client.readContract({ address: venue, abi: raetoStockAbi, functionName: "reserve" }),
    client.readContract({ address: venue, abi: raetoStockAbi, functionName: "sink" }),
  ]);
  if (debt === 0n) return held;
  const idle = await client.readContract({ address: USDG, abi: tokenAbi, functionName: "balanceOf", args: [venue] });
  const payout = (idle > reserve ? idle - reserve : 0n) + (await sourcePayout(client, venue, getAddress(sink)));
  return payout >= debt ? held : cap((held * payout) / debt);
}

/**
 * The gas a trip used on a mainnet fork (1 Nov 2026), by kind: Spark's position home 148,329; Raeto USDG's 761,293; for
 * a Raeto stock vault, whose trip was not measured, its Exit spend's 988,518 (the same withdrawal from the venue).
 */
export const VENUE_TRIP_GAS: Readonly<Record<VenueKind, bigint>> = {
  [VENUE_KIND.ERC4626]: 148_329n,
  [VENUE_KIND.RAETO_USDG]: 761_293n,
  [VENUE_KIND.RAETO_STOCK]: 988_518n,
};
/** A partial trip is at least this share of the position (basis points), unless several trips' gas is worth less. */
export const PARTIAL_TRIP_MIN_BPS = 1_000n;
/** ... or worth at least this many times the trip's gas. */
export const PARTIAL_TRIP_GAS_MULTIPLE = 5n;

/**
 * The least a partial trip takes, in tripVenue's units: PARTIAL_TRIP_MIN_BPS of the position, or, when smaller, what
 * PARTIAL_TRIP_GAS_MULTIPLE times the trip's gas is worth in the venue's units (`gasWorth`; null when it cannot be told,
 * a stock vault's shares: then the share alone). A dust partial would land every tick, the position falling a few
 * units each time, at the sender's gas.
 */
export function partialTripMinimum(held: bigint, gasWorth: bigint | null): bigint {
  const share = (held * PARTIAL_TRIP_MIN_BPS) / 10_000n;
  return gasWorth !== null && gasWorth < share ? gasWorth : share;
}

/**
 * The amount of a trip retried after the whole position's (amount 0) reverted: what the venue can pay now, when it is
 * some of the position and not all of it (a trip for all of it is the one that reverted) and at least `minimum`
 * (partialTripMinimum); null otherwise.
 */
export function partialTripAmount(held: bigint, payable: bigint, minimum = 1n): bigint | null {
  return payable > 0n && payable < held && payable >= minimum ? payable : null;
}

/**
 * `usdg` (USDG base units) in tripVenue's units of (kind, venue): ERC4626 shares (convertToShares), Raeto USDG principal
 * (1:1); null for a Raeto stock vault (its shares are stock, priced by its own oracle).
 */
export async function venueUnitsOfUsdg(client: PublicClient, kind: VenueKind, venue: Address, usdg: bigint): Promise<bigint | null> {
  if (kind === VENUE_KIND.RAETO_USDG) return usdg;
  if (kind === VENUE_KIND.RAETO_STOCK) return null;
  return client.readContract({ address: venue, abi: erc4626Abi, functionName: "convertToShares", args: [usdg] });
}
