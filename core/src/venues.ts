// The venues of the agent's vaults (OstraVault version 4, OstraVaultModuleV4): SetVenue, Enter, Exit and Forward
// spends, the breaker (tripVenue, anyone's), and what a venue holds for a vault (venueOf, the venue's own reads, and
// the breaker's view, read from the vault's storage as the module reads it: sdk venues.ts, which the keeper's venue
// breaker reads with too). The venues are the design's first release (decided by Edu, 30 Oct to 1 Nov 2026): Spark
// Savings USDG (ERC4626, the liquid tier), Raeto's USDG vault (RAETO_USDG, the owner's AI budget) and Raeto's stock
// vaults (RAETO_STOCK); Steakhouse stays the version 3 core, reached through Lend and Redeem (borro.ts).
//
// Every spend is refused before it is signed while the vault does not run version 4 on chain, and when the module would
// refuse it: the checks it makes are read first (the vault's token, the venue in force, the amounts), then the spend is
// run with a throwaway key (sdk simulateVaultSpend) and refused when it would revert or land as VenueFailed. It is sent
// with the gas floor of its kind left (sdk spendFloorGas), which the relayer keeps in its gas limit without pricing it
// for these venues, the ones of sdk VENUE_CATALOG (decided 2 Nov 2026: such a spend costs the gas it uses plus the
// relayer's margin), and the price the relayer's rule gives it (BorroService.spendCostAt, sdk pricedFloorGas) is kept
// in the strategy's ledger for strategy_report; the treasury's break-evens and refill fees are priced the same way.
//
// Realized rates (the treasury's, never an advertised APY) are read from the chain's own events: Spark's Drip (its rate
// accumulator chi), Raeto's Accrued (accPerPrincipal, accPerShare), and Steakhouse's Deposit (assets for shares).

import { BaseError, ContractFunctionRevertedError, encodeFunctionData, getAddress, isAddress, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import {
  BORRO_STOCKS,
  QuoteError,
  RAETO_AAPL_VAULT,
  RAETO_GOOGL_VAULT,
  RAETO_NVDA_VAULT,
  RAETO_SPCX_VAULT,
  RAETO_TSLA_VAULT,
  RAETO_USDG_VAULT,
  SPARK_SAVINGS_USDG,
  STEAKHOUSE_USDG,
  USDG,
  VAULT_ACTION,
  VAULT_V4,
  VENUE_KIND,
  enterParams,
  exitParams,
  failedModuleSpends,
  forwardParams,
  getLogsChunked,
  moduleFailureText,
  ostraVaultAbi,
  ostraVaultModuleV4Abi,
  readVault,
  readVaultGuard,
  setVenueParams,
  signVaultSpend,
  simulateVaultSpend,
  pricedFloorGas,
  spendFloorGas,
  usdgAbi,
  PARTIAL_TRIP_GAS_MULTIPLE,
  VENUE_TRIP_GAS,
  chainlinkEthUsd,
  partialTripAmount,
  partialTripMinimum,
  readVenueRecord,
  sourcePayout,
  venueHeldUnits,
  venueInLoss,
  venuePayableUnits,
  venueUnitsOfUsdg,
  weiToTokenUnits,
  venuePosition,
  venueReasonNames,
  venueReasons,
  type VenueKind,
  type VenueRecord,
} from "@ostraagent/sdk";
import { formatUnitsAmount, parseUnitsAmount, TOKEN_DECIMALS } from "./amount.ts";
import { BORRO_PREVIEW_SLIPPAGE_BPS, type BorroService } from "./borro.ts";
import { chainTime, tokenBalance } from "./chain.ts";
import type { Config } from "./config.ts";
import { VAULT_SPEND_GAS, type Sender } from "./relay.ts";
import type { Folder } from "./storage.ts";
import { REALIZED_LONG, REALIZED_SHORT, accRate, growthRate, lowerRate, WAD, YEAR } from "./strategy-rules.ts";
import { spendCall, type VaultOperationResult, type VaultService } from "./vault.ts";

/** A venue the tools and the treasury know: its name, kind, address, the token it takes and the stock's symbol (USDG for USDG). */
export type VenueDef = { name: string; kind: VenueKind; address: Address; token: Address; symbol: string; title: string };

const stockToken = (symbol: string): Address => {
  const s = BORRO_STOCKS.find((x) => x.symbol === symbol);
  if (s === undefined) throw new Error(`no Borro stock ${symbol}`);
  return getAddress(s.token);
};

/** The venues of the first release (constants.ts addresses, read on chain 1 Nov 2026). */
export const VENUES: readonly VenueDef[] = [
  { name: "spark", kind: VENUE_KIND.ERC4626, address: SPARK_SAVINGS_USDG, token: USDG, symbol: "USDG", title: "Spark Savings USDG" },
  { name: "raeto_usdg", kind: VENUE_KIND.RAETO_USDG, address: RAETO_USDG_VAULT, token: USDG, symbol: "USDG", title: "Raeto's USDG vault" },
  ...(
    [
      ["NVDA", RAETO_NVDA_VAULT],
      ["TSLA", RAETO_TSLA_VAULT],
      ["GOOGL", RAETO_GOOGL_VAULT],
      ["AAPL", RAETO_AAPL_VAULT],
      ["SPCX", RAETO_SPCX_VAULT],
    ] as const
  ).map(([symbol, address]) => ({ name: `raeto_${symbol.toLowerCase()}`, kind: VENUE_KIND.RAETO_STOCK, address, token: stockToken(symbol), symbol, title: `Raeto's ${symbol} vault` })),
];

/** The venue named `name` (spark, raeto_usdg, raeto_nvda, ...). */
export function venueByName(name: string): VenueDef {
  const v = VENUES.find((x) => x.name === name.toLowerCase());
  if (v === undefined) throw new RangeError(`${name} is not a venue (${VENUES.map((x) => x.name).join(", ")})`);
  return v;
}

/** Raeto's stock vault for `symbol`, or undefined. */
export function stockVenue(symbol: string): VenueDef | undefined {
  return VENUES.find((x) => x.kind === VENUE_KIND.RAETO_STOCK && x.symbol === symbol.toUpperCase());
}

/**
 * The gas a venue spend used on a fork of Robinhood Chain mainnet, every venue's storage read cold (the receipts' gas,
 * measured 1 Nov 2026 by mcp/test/treasury.fork.test.ts, without the L1 data part): what a step that cannot be run now
 * (an Enter into a venue whose enable has not landed yet, an Exit of a position not held yet) is priced at, with the
 * L1 data part added as the relayer adds it (and no floor: the relayer prices none for these venues).
 */
export const MEASURED_VENUE_GAS: Readonly<Record<VenueKind, { enter: bigint; exit: bigint }>> = {
  [VENUE_KIND.ERC4626]: { enter: 350_000n, exit: 290_000n },
  [VENUE_KIND.RAETO_USDG]: { enter: 1_100_000n, exit: 830_000n },
  [VENUE_KIND.RAETO_STOCK]: { enter: 860_000n, exit: 980_000n },
};
/** A SetVenue spend's gas on the same fork (it reads the venue and writes the vault's record of it). */
export const MEASURED_SET_VENUE_GAS = 280_000n;
const SPEND_GAS_HEADROOM = 100_000n;
/** The shortest span a realized rate is read over (a venue younger than its window): a day. */
const REALIZED_MIN_SPAN = 86_400n;
/** After a partial trip of a position, the next one waits this long (the keeper's PARTIAL_RETRY_MS). */
const PARTIAL_TRIP_WAIT_MS = 5 * 60_000;


const raetoVaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function source() view returns (address)",
  "function queuedSourceEta() view returns (uint256)",
  "function SOURCE_GRACE() view returns (uint256)",
  "function dustTolerance() view returns (uint256)",
  "function principalOf(address) view returns (uint256)",
  "function earned(address) view returns (uint256)",
  "function inLoss() view returns (bool)",
  "function totalPrincipal() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function pendingYield() view returns (uint256)",
  "function accPerPrincipal() view returns (uint256)",
  "function depositCap() view returns (uint256)",
  "function minDeposit() view returns (uint256)",
  "function depositsPaused() view returns (bool)",
  "function previewWithdraw(address user, uint256 amount) view returns (uint256)",
]);
const raetoStockAbi = parseAbi([
  "function stock() view returns (address)",
  "function sink() view returns (address)",
  "function oracle() view returns (address)",
  "function stockOf(address) view returns (uint256)",
  "function sharesOf(address) view returns (uint256)",
  "function sharesToStock(uint256) view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function collateral() view returns (uint256)",
  "function debt() view returns (uint256)",
  "function ltv() view returns (uint256)",
  "function maxLtv() view returns (uint256)",
  "function targetLtv() view returns (uint256)",
  "function inLoss() view returns (bool)",
  "function earned(address) view returns (uint256)",
  "function liquidationOwed(address) view returns (uint256)",
  "function accPerShare() view returns (uint256)",
  "function depositCap() view returns (uint256)",
  "function minDeposit() view returns (uint256)",
  "function depositsPaused() view returns (bool)",
  "function reserve() view returns (uint256)",
  "function usdgAssets() view returns (uint256)",
]);
const erc4626Abi = parseAbi([
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function nowChi() view returns (uint256)",
]);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
const dripEvent = parseAbiItem("event Drip(uint256 chi, uint256 diff)");
const accruedEvent = parseAbiItem("event Accrued(uint256 yield, uint256 acc)");
const vaultV2DepositEvent = parseAbiItem("event Deposit(address indexed sender, address indexed onBehalf, uint256 assets, uint256 shares)");
const enteredEvent = parseAbiItem("event Entered(uint8 indexed kind, address indexed venue, uint256 amount, uint256 positionGain)");
const exitedEvent = parseAbiItem("event Exited(uint8 indexed kind, address indexed venue, uint256 amount, uint256 received, address indexed by)");


/** What a venue holds for a vault, and what the breaker finds there. Amounts in the venue token's base units. */
export type VenueState = {
  venue: string;
  title: string;
  kind: VenueKind;
  address: Address;
  vault: Address;
  /** OstraVault.venueOf: the owner's last SetVenue, an Enter landed once, in force now, from when (unix seconds). */
  enabled: boolean;
  entered: boolean;
  inForce: boolean;
  from: string;
  /** The position the vault reads (RAETO_USDG principal; RAETO_STOCK stock; ERC4626 assets), and its shares (ERC4626, RAETO_STOCK). */
  position: bigint;
  shares: bigint;
  /** What the venue can pay out now, in its token (USDG for RAETO_STOCK: what it can raise to repay its loan). */
  payout: bigint;
  /** The venue reports a loss (Raeto inLoss(); ERC4626: a share price below the vault's mark). */
  inLoss: boolean;
  /** The breaker's reasons now (code, implementation, source, ltv); empty: healthy. */
  breaker: string[];
  /** Raeto: the credits the position earned (earned(vault), USDG base units), and for a stock vault the USDG a liquidation owes it. */
  credits: bigint | null;
  liquidationOwed: bigint | null;
};

/** A realized rate: the 7-day and 30-day rates, per year (WAD), the lower used, and from when each was read. */
export type RealizedRate = { rate7: bigint | null; rate30: bigint | null; rate: bigint | null; since7: string | null; since30: string | null; note: string | null };

export type VenueParts = {
  client: PublicClient;
  /** Serves eth_getLogs over long windows (the realized rates and the accounting). */
  logsClient: PublicClient;
  config: Config;
  buyer: VaultService;
  tokenVault: (token: Address) => VaultService;
  sender: Sender;
  borro: BorroService;
  /** The strategy's folder: the ledger of venue spends (their price) is kept there for strategy_report. */
  folder: Folder;
};

/** The ledger of venue spends sent from here: what each moved and what the relayer's rule priced it at. */
export const TREASURY_LEDGER = "treasury.jsonl";
export type LedgerEntry = { at: number; vault: Address; venue: string; action: string; amount: string; cost: string; tx: Hex };

/** What the module's errors mean for the owner (OstraVaultModuleV4, OstraVaultV3's OverDailyLimit). */
const WHY: Readonly<Record<string, string>> = {
  NotEnabled: "the venue is not enabled and in force for this vault (venue_set enables it; under the withdrawal lock an enable takes effect after the lock's delay)",
  VenueChanged: "the venue changed since it was enabled (its code, implementation or source): no Enter; the breaker brings a position home (venue_trip)",
  InsufficientOutput: "the venue would pay or credit less than the minimum (or, under the lock, less than the position falls by)",
  Locked: "a guardian recovery waits under the withdrawal lock, or a forward under the lock goes to a link that is not locked",
  OverDailyLimit: "under the withdrawal lock a Raeto Enter, and an Enter into a venue that names no implementation, counts against the daily limit",
  ZeroAmount: "nothing to move",
  WrongToken: "the venue does not take this vault's token",
  BadVenue: "the venue is not one this kind accepts",
  BadParams: "the module refuses these params",
  NotLinked: "the vault has no linked vault to forward to",
  InLoss: "the venue reports a loss",
  Healthy: "the breaker finds nothing to act on",
};

function moduleError(e: unknown): string | null {
  if (!(e instanceof BaseError)) return null;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  return r?.data?.errorName ?? null;
}

function isoTime(unix: bigint): string {
  return new Date(Number(unix) * 1000).toISOString();
}

function less(x: bigint, bps: bigint): bigint {
  return (x * (10_000n - bps)) / 10_000n;
}

export class VenueService {
  readonly #p: VenueParts;
  #rates = new Map<string, { at: number; value: RealizedRate }>();
  /** When a partial trip of each position (vault:kind:venue) was sent from here (unix ms). */
  #partials = new Map<string, number>();
  /** The first block at or after a time (rounded down to 10 minutes): the realized rates of every venue read their windows from the same blocks. */
  #blocks = new Map<bigint, bigint>();

  constructor(p: VenueParts) {
    this.#p = p;
  }

  /** The agent's vault that holds `def`'s token: the USDG vault, or its vault of that stock. */
  vaultFor(def: VenueDef): VaultService {
    return getAddress(def.token) === getAddress(this.#p.config.deployment.token) ? this.#p.buyer : this.#p.tokenVault(def.token);
  }

  /** The vault's OstraVault VERSION, or 0 when it does not exist. */
  async version(vault: Address): Promise<number> {
    if ((await readVault(this.#p.client, this.#p.config.deployment, vault)) === null) return 0;
    return Number(await this.#p.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "VERSION" }));
  }

  /** Throws unless `vault` runs version 4 on chain: before the upgrade executes, nothing of the venues is signed. */
  async requireV4(vault: Address, what: string): Promise<void> {
    const version = await this.version(vault);
    if (version === 0) throw new Error(`${vault} is not an Ostra vault yet; nothing was signed`);
    if (version < VAULT_V4) throw new Error(`the vault ${vault} runs version ${version}; ${what} opens once the vaults run version ${VAULT_V4} (the upgrade waits its public delay in OstraUpgradeOwner, executable from 2026-11-04T00:03:19Z); nothing was signed`);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------------------------------

  /** The vault's record of `def` (OstraVaultV4.Venue at its ERC-7201 slot, packed as Solidity packs it: sdk readVenueRecord). */
  async record(vault: Address, def: VenueDef): Promise<VenueRecord> {
    return readVenueRecord(this.#p.client, vault, def.kind, def.address);
  }

  /** What the breaker finds now for the vault's record `r` of `def` (sdk venueReasons, as OstraVaultModuleV4._reasons): code, implementation, source, ltv. */
  async reasons(def: VenueDef, r: VenueRecord): Promise<string[]> {
    return venueReasonNames(await venueReasons(this.#p.client, def.kind, def.address, r));
  }

  /** OstraVault.venueOf: the owner's last SetVenue, an Enter landed once, in force now, and from when (unix seconds). */
  async venueOf(def: VenueDef, vault: Address): Promise<{ enabled: boolean; entered: boolean; inForce: boolean; from: bigint }> {
    const [enabled, entered, inForce, from] = (await this.#p.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "venueOf", args: [def.kind, def.address] })) as readonly [boolean, boolean, boolean, bigint];
    return { enabled, entered, inForce, from };
  }

  /** The position `vault` holds in `def` as the module reads it (RAETO_USDG principal; RAETO_STOCK stock; ERC4626 assets). */
  async position(def: VenueDef, vault: Address): Promise<bigint> {
    return venuePosition(this.#p.client, def.kind, def.address, vault);
  }

  /** Whether `def` reports a loss for `vault` (Raeto inLoss(); ERC4626 a share price below the vault's mark), as the module reads it. */
  async inLoss(def: VenueDef, vault: Address): Promise<boolean> {
    return venueInLoss(this.#p.client, def.kind, def.address, await this.record(vault, def));
  }

  /** The Raeto credits `vault` earned in `def` (earned(), as the design's accounts count them; USDG base units); 0 for another kind. */
  async credits(def: VenueDef, vault: Address): Promise<bigint> {
    if (def.kind === VENUE_KIND.RAETO_USDG) return this.#p.client.readContract({ address: def.address, abi: raetoVaultAbi, functionName: "earned", args: [vault] });
    if (def.kind === VENUE_KIND.RAETO_STOCK) return this.#p.client.readContract({ address: def.address, abi: raetoStockAbi, functionName: "earned", args: [vault] });
    return 0n;
  }

  /** A Raeto stock vault's LTV (WAD), what its deleverage brings down. */
  async ltv(def: VenueDef): Promise<bigint> {
    return this.#p.client.readContract({ address: def.address, abi: raetoStockAbi, functionName: "ltv" });
  }

  /** The USDG a Raeto stock vault's liquidation owes `vault` (liquidationOwed). */
  async liquidationOwed(def: VenueDef, vault: Address): Promise<bigint> {
    return this.#p.client.readContract({ address: def.address, abi: raetoStockAbi, functionName: "liquidationOwed", args: [vault] });
  }

  /** A Raeto stock vault's book: collateral, loan, deposit cap and its oracle's price (1e36 scale), for the treasury's cap. */
  async stockBook(def: VenueDef): Promise<{ collateral: bigint; debt: bigint; depositCap: bigint; price: bigint; minDeposit: bigint }> {
    const c = this.#p.client;
    const [collateral, debt, depositCap, oracle, minDeposit] = await Promise.all([
      c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "collateral" }),
      c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "debt" }),
      c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "depositCap" }),
      c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "oracle" }),
      c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "minDeposit" }),
    ]);
    const price = await c.readContract({ address: oracle, abi: oracleAbi, functionName: "price" });
    return { collateral, debt, depositCap, price, minDeposit };
  }

  /** Raeto USDG's whole principal (totalPrincipal), what its 5% cap is read against. */
  async raetoPrincipal(): Promise<bigint> {
    return this.#p.client.readContract({ address: RAETO_USDG_VAULT, abi: raetoVaultAbi, functionName: "totalPrincipal" });
  }

  /** What the breaker finds for `vault` in `def` now: its reasons while it holds a position there (empty: nothing). */
  async breakerOf(def: VenueDef, vault: Address): Promise<{ entered: boolean; position: bigint; reasons: string[]; inLoss: boolean }> {
    const vf = await this.venueOf(def, vault);
    if (!vf.entered) return { entered: false, position: 0n, reasons: [], inLoss: false };
    const position = await this.position(def, vault);
    if (position === 0n) return { entered: true, position, reasons: [], inLoss: false };
    return { entered: true, position, reasons: await this.reasons(def, await this.record(vault, def)), inLoss: await this.inLoss(def, vault) };
  }

  /** What `holder` can take out of the Morpho vault `source` now (sdk sourcePayout, which the keeper's breaker reads with too). */
  async #sourcePayout(holder: Address, source: Address): Promise<bigint> {
    return sourcePayout(this.#p.client, holder, source);
  }

  /** What `def` holds for `vault` now, and what the breaker finds there. */
  async state(def: VenueDef, vault: Address): Promise<VenueState> {
    const c = this.#p.client;
    const [enabled, entered, inForce, from] = (await c.readContract({ address: vault, abi: ostraVaultAbi, functionName: "venueOf", args: [def.kind, def.address] })) as readonly [boolean, boolean, boolean, bigint];
    const rec = await this.record(vault, def);
    let position = 0n;
    let shares = 0n;
    let payout = 0n;
    let inLoss = false;
    let credits: bigint | null = null;
    let liquidationOwed: bigint | null = null;
    if (def.kind === VENUE_KIND.ERC4626) {
      shares = await c.readContract({ address: def.address, abi: erc4626Abi, functionName: "balanceOf", args: [vault] });
      position = shares === 0n ? 0n : await c.readContract({ address: def.address, abi: erc4626Abi, functionName: "convertToAssets", args: [shares] });
      payout = await tokenBalance(c, def.token, def.address);
      inLoss = await venueInLoss(c, def.kind, def.address, rec);
    } else if (def.kind === VENUE_KIND.RAETO_USDG) {
      position = await c.readContract({ address: def.address, abi: raetoVaultAbi, functionName: "principalOf", args: [vault] });
      shares = position;
      const source = getAddress(await c.readContract({ address: def.address, abi: raetoVaultAbi, functionName: "source" }));
      payout = (await tokenBalance(c, def.token, def.address)) + (source === "0x0000000000000000000000000000000000000000" ? 0n : await this.#sourcePayout(def.address, source));
      inLoss = await c.readContract({ address: def.address, abi: raetoVaultAbi, functionName: "inLoss" });
      credits = await c.readContract({ address: def.address, abi: raetoVaultAbi, functionName: "earned", args: [vault] });
    } else {
      shares = await c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "sharesOf", args: [vault] });
      position = await c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "stockOf", args: [vault] });
      const sink = getAddress(await c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "sink" }));
      const [idle, reserve] = await Promise.all([tokenBalance(c, USDG, def.address), c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "reserve" })]);
      payout = (idle > reserve ? idle - reserve : 0n) + (await this.#sourcePayout(def.address, sink));
      inLoss = await c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "inLoss" });
      credits = await c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "earned", args: [vault] });
      liquidationOwed = await c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "liquidationOwed", args: [vault] });
    }
    const breaker = entered && position > 0n ? await this.reasons(def, rec) : [];
    return { venue: def.name, title: def.title, kind: def.kind, address: def.address, vault, enabled, entered, inForce, from: from.toString(), position, shares, payout, inLoss, breaker, credits, liquidationOwed };
  }

  /**
   * Every venue of the agent's vaults that run version 4 (the USDG vault's, and each stock vault's that exists), or of
   * `other`, any Ostra vault (a guardian watching the vault it guards). Vaults below version 4 are listed with why.
   */
  async states(other?: string): Promise<{ vault: Address; version: number; venues: (VenueState & { realized: RealizedRate })[] }[]> {
    const out = [];
    const vaults: Address[] = [];
    if (other !== undefined) {
      if (!isAddress(other, { strict: false })) throw new RangeError(`${other} is not an address`);
      const v = await readVault(this.#p.client, this.#p.config.deployment, getAddress(other));
      if (v === null) throw new Error(`${other} is not an Ostra vault`);
      vaults.push(v.vault);
    } else {
      vaults.push(getAddress(await this.#p.buyer.vaultAddress()));
      for (const def of VENUES) if (def.kind === VENUE_KIND.RAETO_STOCK) vaults.push(getAddress(await this.#p.tokenVault(def.token).vaultAddress()));
    }
    for (const vault of vaults) {
      const v = await readVault(this.#p.client, this.#p.config.deployment, vault);
      if (v === null) continue;
      const version = await this.version(vault);
      const venues = [];
      if (version >= VAULT_V4) {
        for (const def of VENUES) {
          if (getAddress(def.token) !== v.token) continue;
          venues.push({ ...(await this.state(def, vault)), realized: await this.realized(def) });
        }
      }
      out.push({ vault, version, venues });
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Realized rates
  // -------------------------------------------------------------------------------------------------------------------

  /** The first block whose time is at least `time` rounded down to 10 minutes (bisection over block times, kept). */
  async #blockAt(at: bigint): Promise<bigint> {
    const time = at - (at % 600n);
    const kept = this.#blocks.get(time);
    if (kept !== undefined) return kept;
    const head = await this.#p.client.getBlock({ blockTag: "latest" });
    let lo = 0n;
    let hi = head.number;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const b = await this.#p.client.getBlock({ blockNumber: mid });
      if (b.timestamp < time) lo = mid + 1n;
      else hi = mid;
    }
    if (this.#blocks.size > 64) this.#blocks.clear();
    this.#blocks.set(time, lo);
    return lo;
  }

  /**
   * The log a window's rate is read from: the last of `event` at `address` at or before `atBlock` (windows growing back
   * from 100,000 blocks to block 0); for a venue younger than the window, its first one after `atBlock` (the rate is then
   * read over its whole life, shorter than the window); with its block time; null when there is none at all.
   */
  async #lastLog<E extends typeof dripEvent | typeof accruedEvent | typeof vaultV2DepositEvent>(address: Address, event: E, atBlock: bigint, accept: (args: Record<string, unknown>) => boolean = () => true): Promise<{ args: Record<string, unknown>; at: bigint } | null> {
    let to = atBlock;
    let span = 100_000n;
    for (;;) {
      const from = to + 1n > span ? to + 1n - span : 0n;
      const logs = await getLogsChunked(this.#p.logsClient, { address, event, fromBlock: from, toBlock: to });
      const hit = logs.filter((l) => accept(l.args as Record<string, unknown>)).at(-1);
      if (hit !== undefined) {
        const b = await this.#p.client.getBlock({ blockNumber: hit.blockNumber });
        return { args: hit.args as Record<string, unknown>, at: b.timestamp };
      }
      if (from === 0n) break;
      to = from - 1n;
      span = span * 4n > 4_000_000n ? 4_000_000n : span * 4n;
    }
    const head = await this.#p.logsClient.getBlockNumber({ cacheTime: 0 });
    let from = atBlock + 1n;
    span = 100_000n;
    while (from <= head) {
      const end = from + span - 1n > head ? head : from + span - 1n;
      const logs = await getLogsChunked(this.#p.logsClient, { address, event, fromBlock: from, toBlock: end });
      const hit = logs.find((l) => accept(l.args as Record<string, unknown>));
      if (hit !== undefined) {
        const b = await this.#p.client.getBlock({ blockNumber: hit.blockNumber });
        return { args: hit.args as Record<string, unknown>, at: b.timestamp };
      }
      from = end + 1n;
      span = span * 4n > 4_000_000n ? 4_000_000n : span * 4n;
    }
    return null;
  }

  /**
   * `def`'s realized rate over the last 7 and 30 days, read from the chain: Spark from its rate accumulator (the last
   * Drip at or before each window's start against nowChi), Raeto from its accumulator (the last Accrued at or before it
   * against now; for the USDG vault with the interest an accrue would credit now), Steakhouse from its share price (the
   * last Deposit of at least 1 USDG at or before it against convertToAssets now). An accumulator holds its value from
   * one event to the next, and a Deposit gives Steakhouse's share price at its own block (its assets for its shares;
   * the price grows between Deposits), so each rate is exact over the time from that event to now, which spans the
   * whole window and may be longer (since7 and since30 say from when, and a note names the span when it is more than a
   * day longer than the window). A venue younger than the window is read from its first event, but never over less than
   * REALIZED_MIN_SPAN (a day): a rate of minutes says nothing, and is not known (the venue then takes no new money).
   * For Raeto it is the credits' rate: on principal for the USDG vault, on the stock's value at the oracle's price for a
   * stock vault. Kept for 10 minutes.
   */
  async realized(def: VenueDef | "steakhouse"): Promise<RealizedRate> {
    const name = def === "steakhouse" ? def : def.name;
    const kept = this.#rates.get(name);
    if (kept !== undefined && Date.now() - kept.at < 600_000) return kept.value;
    const c = this.#p.client;
    const now = await chainTime(c);
    const out: RealizedRate = { rate7: null, rate30: null, rate: null, since7: null, since30: null, note: null };
    const notes: string[] = [];
    for (const [window, key] of [[REALIZED_SHORT, "7"], [REALIZED_LONG, "30"]] as const) {
      const from = await this.#blockAt(now - window);
      let rate: bigint | null = null;
      let since: bigint | null = null;
      if (def === "steakhouse") {
        const unit = 10n ** BigInt(await c.readContract({ address: STEAKHOUSE_USDG, abi: erc4626Abi, functionName: "decimals" }));
        const priceNow = await c.readContract({ address: STEAKHOUSE_USDG, abi: erc4626Abi, functionName: "convertToAssets", args: [unit] });
        const first = await this.#lastLog(STEAKHOUSE_USDG, vaultV2DepositEvent, from, (a) => (a.assets as bigint) >= 1_000_000n && (a.shares as bigint) > 0n);
        if (first !== null) {
          rate = growthRate(((first.args.assets as bigint) * unit) / (first.args.shares as bigint), priceNow, now - first.at);
          since = first.at;
        }
      } else if (def.kind === VENUE_KIND.ERC4626) {
        const chiNow = await c.readContract({ address: def.address, abi: erc4626Abi, functionName: "nowChi" });
        const first = await this.#lastLog(def.address, dripEvent, from);
        if (first !== null) {
          rate = growthRate(first.args.chi as bigint, chiNow, now - first.at);
          since = first.at;
        }
      } else if (def.kind === VENUE_KIND.RAETO_USDG) {
        const [acc, tp, assets, pending] = await Promise.all([
          c.readContract({ address: def.address, abi: raetoVaultAbi, functionName: "accPerPrincipal" }),
          c.readContract({ address: def.address, abi: raetoVaultAbi, functionName: "totalPrincipal" }),
          c.readContract({ address: def.address, abi: raetoVaultAbi, functionName: "totalAssets" }),
          c.readContract({ address: def.address, abi: raetoVaultAbi, functionName: "pendingYield" }),
        ]);
        // As RaetoVault.earnedIncludingPending: the interest an accrue would credit now.
        const accNow = tp > 0n && assets > tp + pending ? acc + ((assets - tp - pending) * 10n ** 36n) / tp : acc;
        const first = await this.#lastLog(def.address, accruedEvent, from);
        if (first !== null) {
          rate = accRate(first.args.acc as bigint, accNow, now - first.at);
          since = first.at;
        }
      } else {
        const [acc, ts, coll, oracle] = await Promise.all([
          c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "accPerShare" }),
          c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "totalShares" }),
          c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "collateral" }),
          c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "oracle" }),
        ]);
        const price = await c.readContract({ address: oracle, abi: oracleAbi, functionName: "price" });
        const first = await this.#lastLog(def.address, accruedEvent, from);
        if (first !== null && ts > 0n && coll > 0n && price > 0n && now > first.at) {
          // USDG units per share over the window, per USDG of the stock a share holds (collateral / totalShares at the price / 1e36).
          const perShare = (first.args.acc as bigint) <= acc ? acc - (first.args.acc as bigint) : 0n;
          rate = (perShare * ts * WAD * YEAR) / (price * coll * (now - first.at));
          since = first.at;
        }
      }
      if (since !== null && now - since < REALIZED_MIN_SPAN) {
        notes.push(`the ${key}-day rate would be read over ${now - since} s only (the venue's first event): not known under a day`);
        rate = null;
        since = null;
      } else if (rate === null) notes.push(`no ${def === "steakhouse" ? "Deposit" : def.kind === VENUE_KIND.ERC4626 ? "Drip" : "Accrued"} event to read the ${key}-day rate from`);
      else if (since !== null && now - since > window + 86_400n) notes.push(`the ${key}-day rate is read over ${(now - since) / 86_400n} days (from the last event at or before the window's start, ${isoTime(since)})`);
      if (key === "7") [out.rate7, out.since7] = [rate, since === null ? null : isoTime(since)];
      else [out.rate30, out.since30] = [rate, since === null ? null : isoTime(since)];
    }
    out.rate = lowerRate(out.rate7, out.rate30);
    if (notes.length > 0) out.note = notes.join("; ");
    this.#rates.set(name, { at: Date.now(), value: out });
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Spends
  // -------------------------------------------------------------------------------------------------------------------

  /** Runs the spend with a throwaway key (sdk simulateVaultSpend): refused when it reverts or lands as VenueFailed. Its gas used. */
  async #simulate(vault: Address, action: number, params: Hex, what: string): Promise<bigint> {
    let sim: Awaited<ReturnType<typeof simulateVaultSpend>>;
    try {
      sim = await simulateVaultSpend(this.#p.client, this.#p.config.deployment, { relayer: await this.#p.sender.payer(), vault, action, params });
    } catch (err) {
      if (err instanceof QuoteError) throw new QuoteError(err.code, `${what}: ${err.message}; nothing was signed`);
      throw err;
    }
    const first = failedModuleSpends(sim.logs, [vault])[0];
    if (first !== undefined) {
      const name = moduleFailureText(first.reason);
      throw new QuoteError("spend_fails", `${what} fails now: ${name}${WHY[name] === undefined ? "" : ` (${WHY[name]})`}; nothing was signed`);
    }
    return sim.gasUsed;
  }

  /** What a spend of `action` with `params` from the vault holding `def`'s token costs through the relayer now (USDG base units), at `gasUsed` (simulated or measured). */
  async costAt(def: VenueDef, action: number, params: Hex, gasUsed: bigint): Promise<bigint> {
    return (await this.#p.borro.spendCostAt(def.symbol, action, params, gasUsed)).usdg;
  }

  /**
   * What `action` would cost now: simulated when it can run now, else at the gas measured for its kind. `withFloor`:
   * the price of its gas with its whole floor, which its relayer channel holds for it (the spend is reserved for it)
   * though the relayer prices a venue spend of sdk VENUE_CATALOG without it: what a refill keeps for the relayer
   * channels that pay its exit and its payment (strategy.ts REFILL_FEE_MULTIPLE).
   */
  async cost(def: VenueDef, action: number, params: Hex, measured: bigint, withFloor = false): Promise<bigint> {
    const vault = await this.vaultFor(def).vaultAddress();
    let gas = measured;
    try {
      gas = await this.#simulate(vault, action, params, "the venue spend");
    } catch {
      // Not possible now (it runs after a step before it): priced at the gas measured for its kind.
    }
    return this.costAt(def, action, params, withFloor ? gas + spendFloorGas(action, params) - pricedFloorGas(action, params) : gas);
  }

  /**
   * Simulates the spend to size its gas, then, inside the vault's queue (a spend signed earlier sent first), simulates it
   * again right before it is signed and sends it alone (a failed Enter or Exit lands only as a transaction's own call).
   * Its price by the relayer's rule is kept in the ledger once it is sent.
   */
  async #spend(def: VenueDef, action: number, params: Hex, what: string, ledger: { action: string; amount: bigint }, moves = 0n): Promise<VaultOperationResult> {
    const vault = this.vaultFor(def);
    const address = getAddress(await vault.vaultAddress());
    await this.requireV4(address, what);
    const gasUsed = await this.#simulate(address, action, params, what);
    const floor = spendFloorGas(action, params);
    let gas = (gasUsed * 5n) / 4n + SPEND_GAS_HEADROOM + floor;
    if (gas < VAULT_SPEND_GAS + floor) gas = VAULT_SPEND_GAS + floor;
    let cost = 0n;
    const r = await vault.operate({
      gas,
      moves,
      what,
      build: async ({ v, vault: at, keychain, chainId }) => {
        const again = await this.#simulate(at, action, params, what);
        if (again + SPEND_GAS_HEADROOM + floor > gas) throw new QuoteError("spend_fails", `${what} needs more gas now than it was reserved for; call again; nothing was signed`);
        cost = await this.costAt(def, action, params, again).catch(() => 0n);
        return [spendCall(at, await signVaultSpend(keychain, v, { chainId, action: action as never, params }))];
      },
    });
    if (r.status === "sent") {
      const e: LedgerEntry = { at: Number(await chainTime(this.#p.client)), vault: address, venue: def.name, action: ledger.action, amount: ledger.amount.toString(), cost: cost.toString(), tx: r.txHash };
      await this.#p.folder.ensure();
      await this.#p.folder.append(TREASURY_LEDGER, `${JSON.stringify(e)}\n`);
    }
    return r;
  }

  /** The vault of `def`, existing, running version 4, and not frozen by USDG's issuer when it holds or receives USDG. */
  async #ready(def: VenueDef, what: string): Promise<Address> {
    const vault = getAddress(await this.vaultFor(def).vaultAddress());
    if ((await readVault(this.#p.client, this.#p.config.deployment, vault)) === null) throw new Error(`this agent has no ${def.symbol} vault yet; nothing was signed`);
    await this.requireV4(vault, what);
    if ((await this.#p.client.readContract({ address: USDG, abi: usdgAbi, functionName: "isFrozen", args: [vault] })) as boolean) throw new Error(`the vault ${vault} is frozen by USDG's issuer; nothing was signed`);
    return vault;
  }

  /** SetVenue: enables `name` for the vault of its token (at once, or under the withdrawal lock after the lock's delay), or disables it (at once; it stops only new Enters). */
  async setVenue(name: string, enabled: boolean): Promise<VaultOperationResult & { effectiveAt?: string; note?: string }> {
    const def = venueByName(name);
    const what = `${enabled ? "enable" : "disable"} ${def.title}`;
    const vault = await this.#ready(def, what);
    const [on, entered, inForce, from] = (await this.#p.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "venueOf", args: [def.kind, def.address] })) as readonly [boolean, boolean, boolean, bigint];
    if (!enabled && !on) throw new Error(`${def.title} is not enabled for ${vault}; nothing was signed`);
    if (enabled && inForce) throw new Error(`${def.title} is enabled and in force for ${vault} already; nothing was signed`);
    if (enabled && on && !inForce && from > (await chainTime(this.#p.client))) throw new Error(`${def.title} is enabled already and takes effect at ${isoTime(from)} (the lock's delay); nothing was signed`);
    if (enabled && entered) {
      const reasons = await this.reasons(def, await this.record(vault, def));
      const st = await this.state(def, vault);
      if (reasons.length > 0 && st.position > 0n) throw new Error(`${def.title} changed since the vault enabled it (${reasons.join(", ")}) and the vault holds a position there: bring it home first (venue_trip, or venue_exit); a re-enable cannot switch the breaker off; nothing was signed`);
    }
    const r = await this.#spend(def, VAULT_ACTION.SET_VENUE, setVenueParams({ kind: def.kind, venue: def.address, enabled }), what, { action: enabled ? "enable" : "disable", amount: 0n });
    if (r.status !== "sent" || !enabled) return r;
    const [, , now, at] = (await this.#p.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "venueOf", args: [def.kind, def.address] })) as readonly [boolean, boolean, boolean, bigint];
    return now ? { ...r, effectiveAt: isoTime(at) } : { ...r, effectiveAt: isoTime(at), note: `under the withdrawal lock the enable takes effect at ${isoTime(at)}; the owner, a guardian or the withdrawal address can drop it meanwhile` };
  }

  /** Enter: `amountText` of the vault's token into `name`, in force for it. */
  async enter(name: string, amountText: string): Promise<VaultOperationResult & { venue: string }> {
    const def = venueByName(name);
    const decimals = def.token === USDG ? TOKEN_DECIMALS : 18;
    const amount = parseUnitsAmount(amountText, decimals);
    if (amount === 0n) throw new RangeError("the amount must be greater than zero");
    return this.enterUnits(def, amount);
  }

  /** enter, in base units (the treasury sizes its steps itself). */
  async enterUnits(def: VenueDef, amount: bigint): Promise<VaultOperationResult & { venue: string }> {
    const c = this.#p.client;
    const what = `Enter of ${formatUnitsAmount(amount, def.token === USDG ? TOKEN_DECIMALS : 18)} ${def.symbol} into ${def.title}`;
    const vault = await this.#ready(def, what);
    const [, , inForce, from] = (await c.readContract({ address: vault, abi: ostraVaultAbi, functionName: "venueOf", args: [def.kind, def.address] })) as readonly [boolean, boolean, boolean, bigint];
    if (!inForce) throw new Error(`${def.title} is not in force for ${vault}${from > (await chainTime(c)) ? ` until ${isoTime(from)} (the lock's delay)` : " (venue_set enables it)"}; nothing was signed`);
    const balance = await tokenBalance(c, def.token, vault);
    if (balance < amount) throw new Error(`the vault holds ${formatUnitsAmount(balance, def.token === USDG ? TOKEN_DECIMALS : 18)} ${def.symbol}, less than the Enter; nothing was signed`);
    const reasons = await this.reasons(def, await this.record(vault, def));
    if (reasons.length > 0) throw new Error(`${def.title} changed since the vault enabled it (${reasons.join(", ")}): no Enter (${WHY.VenueChanged}); nothing was signed`);
    if (def.kind === VENUE_KIND.RAETO_USDG || def.kind === VENUE_KIND.RAETO_STOCK) {
      const abi = def.kind === VENUE_KIND.RAETO_USDG ? raetoVaultAbi : raetoStockAbi;
      const [paused, min, loss] = await Promise.all([
        c.readContract({ address: def.address, abi, functionName: "depositsPaused" }) as Promise<boolean>,
        c.readContract({ address: def.address, abi, functionName: "minDeposit" }) as Promise<bigint>,
        c.readContract({ address: def.address, abi, functionName: "inLoss" }) as Promise<boolean>,
      ]);
      if (paused) throw new Error(`${def.title} has paused deposits; nothing was signed`);
      if (amount < min) throw new Error(`${def.title} takes at least ${formatUnitsAmount(min, def.token === USDG ? TOKEN_DECIMALS : 18)} ${def.symbol} a deposit; nothing was signed`);
      if (loss) throw new Error(`${def.title} reports a loss: it takes no deposit; nothing was signed`);
      // Under the lock a Raeto Enter counts against the daily limit.
      const g = await readVaultGuard(c, vault);
      if (g.outflowAvailable !== null && amount > g.outflowAvailable) throw new Error(`under the withdrawal lock a Raeto Enter counts against the daily limit: ${formatUnitsAmount(g.outflowAvailable, def.token === USDG ? TOKEN_DECIMALS : 18)} may go out now; nothing was signed`);
    } else {
      const max = await c.readContract({ address: def.address, abi: erc4626Abi, functionName: "maxDeposit", args: [vault] });
      if (amount > max) throw new Error(`${def.title} takes at most ${formatUnitsAmount(max, TOKEN_DECIMALS)} USDG now (its deposit cap); nothing was signed`);
    }
    const r = await this.#spend(def, VAULT_ACTION.ENTER, enterParams({ kind: def.kind, venue: def.address, amount, minPosition: 0n }), what, { action: "enter", amount }, def.token === USDG ? amount : 0n);
    return { ...r, venue: def.name };
  }

  /**
   * Exit: `amountText` of the position in `name` back into the vault (in its token: USDG, or the stock; "all": the whole
   * position; "liquidation" for a stock vault: the USDG a liquidation left it, which stays there for venue_forward).
   * Refused while the venue reports a loss unless `acceptLoss` (the owner's decision: an exit then makes the loss
   * permanent; under the withdrawal lock the vault refuses an Exit from a Raeto venue in loss anyway, since it pays less
   * than the principal falls).
   */
  async exit(name: string, amountText: string, acceptLoss = false): Promise<VaultOperationResult & { venue: string }> {
    const def = venueByName(name);
    const c = this.#p.client;
    const decimals = def.token === USDG ? TOKEN_DECIMALS : 18;
    const vault = await this.#ready(def, `Exit from ${def.title}`);
    const st = await this.state(def, vault);
    if (!st.entered && !st.inForce) throw new Error(`${def.title} was never entered by ${vault} nor is it in force; nothing was signed`);
    if (amountText === "liquidation") {
      if (def.kind !== VENUE_KIND.RAETO_STOCK) throw new RangeError("liquidation is a stock vault's: the USDG a liquidation left it");
      if ((st.liquidationOwed ?? 0n) === 0n) throw new Error(`${def.title} owes ${vault} nothing from a liquidation; nothing was signed`);
      const params = exitParams({ kind: def.kind, venue: def.address, amount: 0n, minOut: 0n });
      return { ...(await this.#spend(def, VAULT_ACTION.EXIT, params, `claim of the USDG ${def.title} owes from a liquidation`, { action: "claim", amount: st.liquidationOwed ?? 0n })), venue: def.name };
    }
    if (st.inLoss && !acceptLoss) throw new Error(`${def.title} reports a loss: an exit now makes it permanent, so nothing is taken out without the owner (acceptLoss: true; under the withdrawal lock the vault refuses an Exit from a Raeto venue in loss, which pays less than its principal falls); nothing was signed`);
    if (st.position === 0n) throw new Error(`${vault} holds nothing in ${def.title}; nothing was signed`);
    const all = amountText === "all";
    const wanted = all ? st.position : parseUnitsAmount(amountText, decimals);
    if (wanted === 0n) throw new RangeError("the amount must be greater than zero");
    if (wanted > st.position) throw new Error(`the position in ${def.title} is ${formatUnitsAmount(st.position, decimals)} ${def.symbol}, less than ${amountText}; nothing was signed`);
    return { ...(await this.exitUnits(def, all ? null : wanted, vault)), venue: def.name };
  }

  /** exit, in the token's base units (null: the whole position), for the treasury's own steps. */
  async exitUnits(def: VenueDef, amount: bigint | null, at?: Address): Promise<VaultOperationResult> {
    const c = this.#p.client;
    const vault = at ?? (await this.#ready(def, `Exit from ${def.title}`));
    let shares: bigint;
    let minOut: bigint;
    if (def.kind === VENUE_KIND.ERC4626) {
      const held = await c.readContract({ address: def.address, abi: erc4626Abi, functionName: "balanceOf", args: [vault] });
      // Rounded up, at most every share: the vault gets at least what was asked.
      shares = amount === null ? held : (await c.readContract({ address: def.address, abi: erc4626Abi, functionName: "convertToShares", args: [amount] })) + 1n;
      if (shares > held) shares = held;
      minOut = less(await c.readContract({ address: def.address, abi: erc4626Abi, functionName: "convertToAssets", args: [shares] }), BORRO_PREVIEW_SLIPPAGE_BPS);
    } else if (def.kind === VENUE_KIND.RAETO_USDG) {
      const held = await c.readContract({ address: def.address, abi: raetoVaultAbi, functionName: "principalOf", args: [vault] });
      shares = amount === null || amount > held ? held : amount;
      minOut = less(await c.readContract({ address: def.address, abi: raetoVaultAbi, functionName: "previewWithdraw", args: [vault, shares] }), BORRO_PREVIEW_SLIPPAGE_BPS);
    } else {
      const held = await c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "sharesOf", args: [vault] });
      const stock = await c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "stockOf", args: [vault] });
      shares = amount === null || stock === 0n ? held : (held * amount + stock - 1n) / stock;
      if (shares > held) shares = held;
      minOut = less(await c.readContract({ address: def.address, abi: raetoStockAbi, functionName: "sharesToStock", args: [shares] }), BORRO_PREVIEW_SLIPPAGE_BPS);
    }
    if (shares === 0n) throw new Error(`${vault} holds nothing in ${def.title}; nothing was signed`);
    const decimals = def.token === USDG ? TOKEN_DECIMALS : 18;
    return this.#spend(def, VAULT_ACTION.EXIT, exitParams({ kind: def.kind, venue: def.address, amount: shares, minOut }), `Exit from ${def.title}${amount === null ? " (the whole position)" : ` of ${formatUnitsAmount(amount, decimals)} ${def.symbol}`}`, { action: "exit", amount: amount ?? shares });
  }

  /**
   * Forward: `amountText` ("all": what it holds) of the USDG the agent's `symbol` vault holds (a liquidation's, claimed
   * with venue_exit liquidation) to its linked vault, which must be the agent's USDG vault and, under the stock vault's
   * lock, a locked link.
   */
  async forward(symbol: string, amountText: string): Promise<VaultOperationResult & { to: Address }> {
    const def = stockVenue(symbol);
    if (def === undefined) throw new RangeError(`${symbol} has no Raeto stock vault (${VENUES.filter((x) => x.kind === VENUE_KIND.RAETO_STOCK).map((x) => x.symbol).join(", ")})`);
    const c = this.#p.client;
    const vault = await this.#ready(def, `Forward from the ${def.symbol} vault`);
    const g = await readVaultGuard(c, vault);
    const buyer = getAddress(await this.#p.buyer.vaultAddress());
    if (g.linkedVault !== buyer) throw new Error(`the ${def.symbol} vault's linked vault is ${g.linkedVault ?? "none"}, not the USDG vault ${buyer}: link it first (vault_link, asset ${def.symbol}); nothing was signed`);
    const held = await tokenBalance(c, USDG, vault);
    const amount = amountText === "all" ? held : parseUnitsAmount(amountText, TOKEN_DECIMALS);
    if (amount === 0n) throw new Error(`the ${def.symbol} vault holds no USDG to forward; nothing was signed`);
    if (amount > held) throw new Error(`the ${def.symbol} vault holds ${formatUnitsAmount(held, TOKEN_DECIMALS)} USDG, less than ${amountText}; nothing was signed`);
    const r = await this.#spend(def, VAULT_ACTION.FORWARD, forwardParams({ token: USDG, amount }), `Forward of ${formatUnitsAmount(amount, TOKEN_DECIMALS)} USDG to ${buyer}`, { action: "forward", amount });
    return { ...r, to: buyer };
  }

  /**
   * The breaker (OstraVault.tripVenue, anyone's): when `name`'s code, implementation or source is no longer what `vault`
   * (default: the agent's vault of its token) pinned, the position comes home (all of it, or what the venue can pay now);
   * for a stock vault above its max LTV, the venue's own deleverage(). Simulated first: refused when the vault would
   * refuse it (Healthy, InLoss, NotEnabled). No key is used.
   */
  async trip(name: string, vaultText?: string): Promise<{ status: "sent"; txHash: Hex; vault: Address; venue: string; reasons: string[]; amount: string }> {
    const def = venueByName(name);
    let vault: Address;
    if (vaultText === undefined) vault = getAddress(await this.vaultFor(def).vaultAddress());
    else {
      if (!isAddress(vaultText, { strict: false })) throw new RangeError(`${vaultText} is not an address`);
      vault = getAddress(vaultText);
    }
    await this.requireV4(vault, "the venue breaker");
    const reasons = await this.reasons(def, await this.record(vault, def));
    const account = await this.#p.sender.payer();
    const simulate = (amount: bigint) =>
      this.#p.client.simulateContract({ address: vault, abi: [...ostraVaultAbi, ...ostraVaultModuleV4Abi.filter((x) => x.type === "error")], functionName: "tripVenue", args: [def.kind, def.address, amount], account });
    const refused = (e: unknown) => {
      const n = moduleError(e);
      return new QuoteError("spend_fails", `the breaker does not act on ${def.title} for ${vault} now: ${n ?? (e as Error).message.split("\n")[0]}${n !== null && WHY[n] !== undefined ? ` (${WHY[n]})` : ""}; nothing was sent`);
    };
    // The whole position (amount 0); when the venue cannot pay all of it now, what it can (sdk venuePayableUnits, in the
    // venue's units), when that is at least sdk partialTripMinimum (a tenth of the position, or several trips' gas,
    // whichever is less) and no partial trip of this position was sent in the last PARTIAL_TRIP_WAIT_MS: the rest comes
    // home on a later trip, before a Raeto source change can apply.
    let amount = 0n;
    const k = `${vault}:${def.kind}:${def.address}`;
    try {
      await simulate(0n);
    } catch (e) {
      const n = moduleError(e);
      if (n === "Healthy" || n === "InLoss" || n === "NotEnabled") throw refused(e);
      const last = this.#partials.get(k) ?? 0;
      if (Date.now() - last < PARTIAL_TRIP_WAIT_MS) throw new QuoteError("spend_fails", `the venue cannot pay ${def.title}'s whole position for ${vault} now, and a partial trip of it was sent at ${new Date(last).toISOString()}: the next waits ${PARTIAL_TRIP_WAIT_MS / 60_000} minutes; nothing was sent`);
      const c = this.#p.client;
      const held = await venueHeldUnits(c, def.kind, def.address, vault);
      let gasWorth: bigint | null = null;
      try {
        gasWorth = await venueUnitsOfUsdg(c, def.kind, def.address, weiToTokenUnits(VENUE_TRIP_GAS[def.kind] * PARTIAL_TRIP_GAS_MULTIPLE * (await c.getGasPrice()), await chainlinkEthUsd(c)(), TOKEN_DECIMALS));
      } catch {
        // no price now: the share of the position alone
      }
      const partial = partialTripAmount(held, await venuePayableUnits(c, def.kind, def.address, vault), partialTripMinimum(held, gasWorth));
      if (partial === null) throw refused(e);
      try {
        await simulate(partial);
      } catch (e2) {
        throw refused(e2);
      }
      amount = partial;
    }
    const data = encodeFunctionData({ abi: ostraVaultAbi, functionName: "tripVenue", args: [def.kind, def.address, amount] });
    await this.#p.buyer.requireEth(SPEND_GAS_HEADROOM * 30n, "send the breaker's trip", this.#p.sender);
    const txHash = await this.#p.sender.send([{ to: vault, data }]);
    if (amount !== 0n) this.#partials.set(k, Date.now());
    return { status: "sent", txHash, vault, venue: def.name, reasons, amount: amount.toString() };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Accounting
  // -------------------------------------------------------------------------------------------------------------------

  /** The ledger of venue spends sent from here (oldest first); a line that cannot be parsed is skipped. */
  async ledger(): Promise<LedgerEntry[]> {
    const text = await this.#p.folder.read(TREASURY_LEDGER);
    if (text === undefined) return [];
    const out: LedgerEntry[] = [];
    for (const l of text.split("\n")) {
      if (l.trim() === "") continue;
      try {
        out.push(JSON.parse(l) as LedgerEntry);
      } catch {
        // a line cut by a crash
      }
    }
    return out;
  }

  /** What `vault` put into `def` and took out of it, from its own Entered and Exited events (the module's, at the vault's address). */
  async flows(def: VenueDef, vault: Address): Promise<{ in: bigint; out: bigint; claimed: bigint }> {
    const to = await this.#p.logsClient.getBlockNumber({ cacheTime: 0 });
    const from = BigInt(this.#p.config.deployment.fromBlock);
    const entered = await getLogsChunked(this.#p.logsClient, { address: vault, event: enteredEvent, args: { kind: def.kind, venue: def.address }, fromBlock: from, toBlock: to });
    const exited = await getLogsChunked(this.#p.logsClient, { address: vault, event: exitedEvent, args: { kind: def.kind, venue: def.address }, fromBlock: from, toBlock: to });
    let into = 0n;
    for (const l of entered) into += (l.args as { amount: bigint }).amount;
    let out = 0n;
    let claimed = 0n;
    for (const l of exited) {
      const a = l.args as { amount: bigint; received: bigint };
      // RAETO_STOCK with amount 0: a liquidation's USDG, not the stock.
      if (def.kind === VENUE_KIND.RAETO_STOCK && a.amount === 0n) claimed += a.received;
      else out += a.received;
    }
    return { in: into, out, claimed };
  }
}
