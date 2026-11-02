// The venue breaker keeper (design "v4 off chain: the treasury engine in MCP": "the breaker does it when the agent is
// offline"). OstraVault.tripVenue(kind, venue, amount) can be sent by anyone: when a venue a vault entered is no longer
// what the vault pinned (its code hash, its implementation, Raeto's source, queued or made), it brings the vault's
// position home into the vault; when a Raeto stock vault is above its max LTV, it calls that venue's own deleverage()
// (the position stays). An agent's MCP trips its own positions each minute while it runs (core strategy.ts exitCheck);
// this keeper does it for every version 4 vault, whether its agent is running or not, and pays the gas.
//
//   * Positions: every (vault, kind, venue) a vault entered, from OstraVaultV4's Entered events (emitted at the vault's
//     own address), read on from a cursor kept in the data directory every POSITIONS_INTERVAL_MS; a position is kept
//     only in a venue of the design's first release (sdk VENUE_CATALOG: Spark Savings USDG, Raeto's USDG vault and
//     stock vaults), and only when the address is a vault of the deployment's factory (sdk readVault), so a contract
//     emitting the same event is never called. A venue anyone deploys and a vault enables could otherwise make each
//     trip land and do nothing (a reason that never goes away), at the keeper's gas, until the fee payer ran dry for
//     every real position.
//   * Every TICK_INTERVAL_MS each position is read as the module reads it (sdk readVenueBreaker: the vault's record,
//     the position, the reasons of OstraVaultModuleV4._reasons, the loss of _inLoss) and selectTrips decides: a trip
//     only with a position and a reason; never on a venue in loss for a trip that brings the position home (the
//     contract refuses it: no gas spent on a revert); a deleverage (LTV alone) once per venue, since the LTV is the
//     venue's and one deleverage serves every vault in it.
//   * Rate limited: at most MAX_TRIPS_PER_MINUTE trips a minute; a position whose trip reverted is left alone for
//     RETRY_AFTER_MS, one whose trip landed and changed nothing (the position did not fall, or the LTV is still above its
//     max) for NO_EFFECT_RETRY_MS; each trip's gas limit is at most TRIP_GAS_CAP of its kind. Idempotent: a position
//     brought home holds nothing, and a deleveraged venue is under its max LTV, so the next read finds nothing to send.
//   * A trip of the whole position (amount 0) that the venue cannot pay now reverts: it is tried again at once with what
//     the venue can pay (sdk venuePayableUnits, in its units), when that is at least sdk partialTripMinimum (a tenth of
//     the position, or several trips' gas, whichever is less), and the position is left alone for PARTIAL_RETRY_MS
//     after it; the rest comes home on a later tick, before a Raeto source change can apply.
//   * The fee payer's ETH is read before every tick that would send: under LOW_ETH_WEI no trip is sent (low_eth, with
//     the address and what it holds) until it is topped up.
//   * It sends tripVenue(kind, venue, amount) on an Ostra vault (amount 0, the whole position, or a partial one),
//     simulated first, and nothing else.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, type Address, type Hash, type PublicClient } from "viem";
import {
  PARTIAL_TRIP_GAS_MULTIPLE,
  VENUE_KIND,
  VENUE_REASON,
  VENUE_TRIP_GAS,
  chainlinkEthUsd,
  inVenueCatalog,
  partialTripAmount,
  partialTripMinimum,
  readVault,
  readVenueBreaker,
  venueEnteredEvent,
  venueHeldUnits,
  venuePayableUnits,
  venueReasonNames,
  venueUnitsOfUsdg,
  weiToTokenUnits,
  type Deployment,
  type VenueKind,
} from "@ostraagent/sdk";
import { revertName } from "./breaker.ts";

/** How often each position is read: a code or implementation change acts at once; a Raeto source change waits two days. */
export const TICK_INTERVAL_MS = 15_000;
/** How often new Entered events and the fee payer's ETH are read. */
export const POSITIONS_INTERVAL_MS = 60_000;
/** A position whose trip reverted is not tried again for this long. */
export const RETRY_AFTER_MS = 5 * 60_000;
/** A position whose trip landed and changed nothing is not tried again for this long. */
export const NO_EFFECT_RETRY_MS = 60 * 60_000;
/** A position after a partial trip is not tried again for this long. */
export const PARTIAL_RETRY_MS = 5 * 60_000;
/** The most gas a trip's transaction may be given, by kind: four times what one used on a mainnet fork (sdk VENUE_TRIP_GAS). */
export const TRIP_GAS_CAP: Readonly<Record<VenueKind, bigint>> = {
  [VENUE_KIND.ERC4626]: 4n * VENUE_TRIP_GAS[VENUE_KIND.ERC4626],
  [VENUE_KIND.RAETO_USDG]: 4n * VENUE_TRIP_GAS[VENUE_KIND.RAETO_USDG],
  [VENUE_KIND.RAETO_STOCK]: 4n * VENUE_TRIP_GAS[VENUE_KIND.RAETO_STOCK],
};

/** How long a position is left alone after a trip that landed: a while when it changed nothing, a few minutes after a partial one, else not at all. */
export function tripBackoffMs(t: { effect: boolean; partial: boolean }): number | null {
  if (!t.effect) return NO_EFFECT_RETRY_MS;
  return t.partial ? PARTIAL_RETRY_MS : null;
}
/** At most this many trips in any minute. */
export const MAX_TRIPS_PER_MINUTE = 10;
/**
 * The fee payer's ETH under which no trip is sent: about 60 trips of 761,293 gas (Raeto USDG's position brought home,
 * measured on a mainnet fork on 1 Nov 2026) at 0.022 gwei (Robinhood Chain's gas price was 0.020 gwei that day).
 */
export const LOW_ETH_WEI = 1_000_000_000_000_000n;
/** Blocks the event cursor stays behind the head (a node may answer getLogs late for its newest blocks). */
export const RESCAN_BLOCKS = 3_000n;
const MAX_SPAN = 4_000_000n;
const MIN_SPAN = 10_000n;

export type VenuePosition = { vault: Address; kind: VenueKind; venue: Address };
/** What the breaker finds for a position now (sdk readVenueBreaker). */
export type PositionRead = { entered: boolean; position: bigint; reasons: number; inLoss: boolean };
export type TripChoice = { position: VenuePosition; reasons: number; mode: "home" | "deleverage" };
export type TripSkip = { position: VenuePosition; reasons: number; why: string };

const key = (p: VenuePosition) => `${p.vault.toLowerCase()}:${p.kind}:${p.venue.toLowerCase()}`;

/**
 * Which positions to trip now, in the order given: a position entered, holding something, with a reason; one that
 * brings the position home not while the venue reports a loss; a deleverage (LTV alone) once per venue; none left
 * alone (`backoff`, unix ms) until then; at most `room` trips; none at all when `ethOk` is false. The others are listed
 * with why, apart from positions with nothing to do (not entered, nothing held, no reason).
 */
export function selectTrips(reads: readonly { position: VenuePosition; read: PositionRead }[], o: { now: number; backoff: ReadonlyMap<string, number>; room: number; ethOk: boolean }): { trips: TripChoice[]; skipped: TripSkip[] } {
  const trips: TripChoice[] = [];
  const skipped: TripSkip[] = [];
  const deleveraged = new Set<string>();
  for (const { position, read } of reads) {
    if (!inVenueCatalog(position.kind, position.venue)) continue;
    if (!read.entered || read.position === 0n || read.reasons === 0) continue;
    const mode = read.reasons === VENUE_REASON.LTV ? "deleverage" : "home";
    if (mode === "home" && read.inLoss) {
      skipped.push({ position, reasons: read.reasons, why: "the venue reports a loss: the vault refuses the trip (InLoss)" });
      continue;
    }
    if (mode === "deleverage" && deleveraged.has(position.venue.toLowerCase())) {
      skipped.push({ position, reasons: read.reasons, why: "the venue is deleveraged by another vault's trip in this tick" });
      continue;
    }
    if ((o.backoff.get(key(position)) ?? 0) > o.now) {
      skipped.push({ position, reasons: read.reasons, why: "its last trip reverted: left alone for a while" });
      continue;
    }
    if (!o.ethOk) {
      skipped.push({ position, reasons: read.reasons, why: "the fee payer's ETH is low" });
      continue;
    }
    if (trips.length >= o.room) {
      skipped.push({ position, reasons: read.reasons, why: `at most ${MAX_TRIPS_PER_MINUTE} trips a minute` });
      continue;
    }
    if (mode === "deleverage") deleveraged.add(position.venue.toLowerCase());
    trips.push({ position, reasons: read.reasons, mode });
  }
  return { trips, skipped };
}

type Kept = { toBlock: string; positions: VenuePosition[]; notVaults: Address[] };

export type VenueBreakerParts = {
  client: PublicClient;
  /** Serves eth_getLogs over long windows (the public RPC). */
  logsClient: PublicClient;
  deployment: Deployment;
  /** The first block to read Entered events from (the version 4 upgrade's block, or before it). */
  fromBlock: bigint;
  /** The fee payer's address (its ETH is read) and how a trip of `amount` (0: the whole position) is sent: simulated first, its gas limit at most TRIP_GAS_CAP. */
  feePayer: Address;
  trip: (p: VenuePosition, amount: bigint) => Promise<{ hash: Hash; gasUsed: bigint }>;
  dataDir: string;
  log: (event: string, fields: Record<string, unknown>) => void;
};

export type TickResult = { position: VenuePosition; reasons: string[]; mode: "home" | "deleverage"; amount?: string; tx?: Hash; error?: string };

export class VenueBreakerKeeper {
  readonly #p: VenueBreakerParts;
  #kept: Kept;
  readonly #backoff = new Map<string, number>();
  readonly #sent: number[] = [];
  #timers: NodeJS.Timeout[] = [];
  #ticking = false;
  #reading = false;

  private constructor(p: VenueBreakerParts, kept: Kept) {
    this.#p = p;
    this.#kept = kept;
  }

  static async open(p: VenueBreakerParts): Promise<VenueBreakerKeeper> {
    await mkdir(p.dataDir, { recursive: true, mode: 0o700 });
    let kept: Kept = { toBlock: (p.fromBlock - 1n).toString(), positions: [], notVaults: [] };
    try {
      kept = JSON.parse(await readFile(join(p.dataDir, "venue-positions.json"), "utf8")) as Kept;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    kept.positions = kept.positions.filter((x) => inVenueCatalog(x.kind, x.venue));
    return new VenueBreakerKeeper(p, kept);
  }

  get positions(): readonly VenuePosition[] {
    return this.#kept.positions;
  }

  /** Entered events of every address over [from, to], in spans the RPC accepts (cut by 4 when refused, grown back). */
  async #entered(from: bigint, to: bigint): Promise<{ address: Address; kind: number; venue: Address }[]> {
    const out: { address: Address; kind: number; venue: Address }[] = [];
    let a = from;
    let span = MAX_SPAN;
    while (a <= to) {
      const b = a + span - 1n > to ? to : a + span - 1n;
      try {
        const logs = await this.#p.logsClient.getLogs({ event: venueEnteredEvent, fromBlock: a, toBlock: b, strict: true });
        for (const l of logs) out.push({ address: getAddress(l.address), kind: Number(l.args.kind), venue: getAddress(l.args.venue) });
        a = b + 1n;
        span = span * 2n > MAX_SPAN ? MAX_SPAN : span * 2n;
      } catch (err) {
        if (span === MIN_SPAN) throw err;
        span = span / 4n < MIN_SPAN ? MIN_SPAN : span / 4n;
      }
    }
    return out;
  }

  /** Reads the Entered events since the cursor and keeps every new position of an Ostra vault. */
  async refreshPositions(): Promise<void> {
    if (this.#reading) return;
    this.#reading = true;
    try {
      const to = await this.#p.logsClient.getBlockNumber({ cacheTime: 0 });
      const from = BigInt(this.#kept.toBlock) + 1n;
      if (from > to) return;
      const events = await this.#entered(from, to);
      const positions = new Map(this.#kept.positions.map((p) => [key(p), p]));
      const notVaults = new Set(this.#kept.notVaults.map((a) => getAddress(a)));
      const vaults = new Set(this.#kept.positions.map((p) => getAddress(p.vault)));
      const ignored = new Set<string>();
      for (const e of events) {
        const p: VenuePosition = { vault: e.address, kind: e.kind as VenueKind, venue: e.venue };
        if (!inVenueCatalog(p.kind, p.venue)) {
          if (!ignored.has(key(p))) this.#p.log("not_in_catalog", { vault: p.vault, kind: p.kind, venue: p.venue });
          ignored.add(key(p));
          continue;
        }
        if (positions.has(key(p)) || notVaults.has(e.address)) continue;
        if (!vaults.has(e.address)) {
          if ((await readVault(this.#p.client, this.#p.deployment, e.address)) === null) {
            notVaults.add(e.address);
            this.#p.log("not_a_vault", { address: e.address });
            continue;
          }
          vaults.add(e.address);
        }
        positions.set(key(p), p);
        this.#p.log("position", { vault: p.vault, kind: p.kind, venue: p.venue });
      }
      const cursor = to - RESCAN_BLOCKS > BigInt(this.#kept.toBlock) ? to - RESCAN_BLOCKS : BigInt(this.#kept.toBlock);
      this.#kept = { toBlock: cursor.toString(), positions: [...positions.values()], notVaults: [...notVaults] };
      const file = join(this.#p.dataDir, "venue-positions.json");
      await writeFile(`${file}.tmp`, JSON.stringify(this.#kept), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    } finally {
      this.#reading = false;
    }
  }

  /**
   * The amount of a partial trip of `p`: what the venue can pay now, at least sdk partialTripMinimum (a tenth of the
   * position, or PARTIAL_TRIP_GAS_MULTIPLE trips' gas at the gas price and Chainlink's ETH/USD now, whichever is less);
   * null when there is none worth a trip.
   */
  async #partial(p: VenuePosition): Promise<bigint | null> {
    const c = this.#p.client;
    const held = await venueHeldUnits(c, p.kind, p.venue, p.vault);
    let gasWorth: bigint | null = null;
    try {
      const usdg = weiToTokenUnits(VENUE_TRIP_GAS[p.kind] * PARTIAL_TRIP_GAS_MULTIPLE * (await c.getGasPrice()), await chainlinkEthUsd(c)(), 6);
      gasWorth = await venueUnitsOfUsdg(c, p.kind, p.venue, usdg);
    } catch {
      // no price now: the share of the position alone
    }
    return partialTripAmount(held, await venuePayableUnits(c, p.kind, p.venue, p.vault), partialTripMinimum(held, gasWorth));
  }

  /** Reads every position once and trips those selectTrips chooses; the trips sent, and those that failed. */
  async tick(): Promise<TickResult[]> {
    if (this.#ticking) return [];
    this.#ticking = true;
    const out: TickResult[] = [];
    try {
      const reads: { position: VenuePosition; read: PositionRead }[] = [];
      for (const position of this.#kept.positions) {
        try {
          reads.push({ position, read: await readVenueBreaker(this.#p.client, position.vault, position.kind, position.venue) });
        } catch (err) {
          this.#p.log("read_failed", { vault: position.vault, venue: position.venue, error: (err as Error).message.split("\n")[0] });
        }
      }
      const now = Date.now();
      while (this.#sent.length > 0 && (this.#sent[0] as number) <= now - 60_000) this.#sent.shift();
      const due = reads.some((r) => r.read.entered && r.read.position > 0n && r.read.reasons !== 0);
      let ethOk = true;
      if (due) {
        const eth = await this.#p.client.getBalance({ address: this.#p.feePayer });
        ethOk = eth >= LOW_ETH_WEI;
        if (!ethOk) this.#p.log("low_eth", { feePayer: this.#p.feePayer, wei: eth.toString(), needs: LOW_ETH_WEI.toString(), note: "no trip is sent until the fee payer is topped up" });
      }
      const { trips, skipped } = selectTrips(reads, { now, backoff: this.#backoff, room: MAX_TRIPS_PER_MINUTE - this.#sent.length, ethOk });
      for (const s of skipped) this.#p.log("trip_skipped", { vault: s.position.vault, venue: s.position.venue, reasons: venueReasonNames(s.reasons), why: s.why });
      for (const t of trips) {
        const reasons = venueReasonNames(t.reasons);
        const { vault, kind, venue } = t.position;
        const before = reads.find((r) => key(r.position) === key(t.position))?.read.position ?? 0n;
        let amount = 0n;
        let sent: { hash: Hash; gasUsed: bigint };
        try {
          try {
            sent = await this.#p.trip(t.position, 0n);
          } catch (err) {
            // The whole position the venue cannot pay now: what it can, at once (sdk venuePayableUnits).
            const error = revertName(err);
            const partial = t.mode === "home" && !/Healthy|InLoss|NotEnabled|ZeroAmount/.test(error) ? await this.#partial(t.position) : null;
            if (partial === null) throw err;
            this.#p.log("trip_partial", { vault, venue, reasons, error, amount: partial.toString() });
            amount = partial;
            sent = await this.#p.trip(t.position, partial);
          }
        } catch (err) {
          const error = revertName(err);
          this.#backoff.set(key(t.position), Date.now() + RETRY_AFTER_MS);
          // Healthy, InLoss, NotEnabled: the state moved between the read and the send.
          this.#p.log(/Healthy|InLoss|NotEnabled|ZeroAmount/.test(error) ? "trip_not_needed" : "trip_failed", { vault, venue, reasons, error });
          out.push({ position: t.position, reasons, mode: t.mode, error });
          continue;
        }
        this.#sent.push(Date.now());
        this.#p.log("tripped", { vault, kind, venue, reasons, mode: t.mode, amount: amount.toString(), tx: sent.hash, gasUsed: sent.gasUsed.toString() });
        out.push({ position: t.position, reasons, mode: t.mode, amount: amount.toString(), tx: sent.hash });
        // A trip that landed and changed nothing (the position did not fall; the LTV still above its max) is not sent
        // again for a while: a venue that does nothing on a trip must not spend the fee payer's ETH tick after tick; a
        // partial one waits a few minutes before the next.
        try {
          const after = await readVenueBreaker(this.#p.client, vault, kind, venue);
          const effect = t.mode === "home" ? after.position < before : (after.reasons & VENUE_REASON.LTV) === 0;
          const wait = tripBackoffMs({ effect, partial: amount !== 0n });
          if (wait !== null) this.#backoff.set(key(t.position), Date.now() + wait);
          if (!effect) this.#p.log("trip_without_effect", { vault, venue, reasons, mode: t.mode, tx: sent.hash, position: after.position.toString() });
        } catch (err) {
          // The effect unread: a partial trip still waits its few minutes before the next.
          if (amount !== 0n) this.#backoff.set(key(t.position), Date.now() + PARTIAL_RETRY_MS);
          this.#p.log("read_failed", { vault, venue, error: (err as Error).message.split("\n")[0] });
        }
      }
    } finally {
      this.#ticking = false;
    }
    return out;
  }

  run(): void {
    const safe = (what: string, fn: () => Promise<unknown>) => () =>
      void fn().catch((err: unknown) => this.#p.log(`${what}_failed`, { error: err instanceof Error ? err.message.split("\n")[0] : String(err) }));
    void (async () => {
      await safe("positions", () => this.refreshPositions())();
      await safe("tick", () => this.tick())();
    })();
    this.#timers.push(setInterval(safe("positions", () => this.refreshPositions()), POSITIONS_INTERVAL_MS));
    this.#timers.push(setInterval(safe("tick", () => this.tick()), TICK_INTERVAL_MS));
  }

  stop(): void {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
  }
}
