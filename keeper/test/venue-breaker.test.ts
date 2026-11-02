// The venue breaker keeper's choice of trips (src/venue-breaker.ts selectTrips), which needs no chain: only venues of
// the first release (sdk VENUE_CATALOG), a trip only with a position and a reason, never on a venue in loss when it
// brings the position home, a deleverage once per venue, positions left alone after a revert, the rate limit, nothing
// at all while the fee payer's ETH is low; and the amount of a trip retried when the venue cannot pay it all.

import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address } from "viem";
import { RAETO_NVDA_VAULT, RAETO_USDG_VAULT, SPARK_SAVINGS_USDG, STEAKHOUSE_USDG, VENUE_CATALOG, VENUE_KIND, VENUE_REASON, inVenueCatalog, partialTripAmount, partialTripMinimum } from "@ostraagent/sdk";
import { MAX_TRIPS_PER_MINUTE, NO_EFFECT_RETRY_MS, PARTIAL_RETRY_MS, selectTrips, tripBackoffMs, type PositionRead, type VenuePosition } from "../src/venue-breaker.ts";

const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const spark = (vault: Address): VenuePosition => ({ vault, kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG });
const raeto = (vault: Address): VenuePosition => ({ vault, kind: VENUE_KIND.RAETO_USDG, venue: RAETO_USDG_VAULT });
const nvda = (vault: Address): VenuePosition => ({ vault, kind: VENUE_KIND.RAETO_STOCK, venue: RAETO_NVDA_VAULT });
const read = (r: Partial<PositionRead>): PositionRead => ({ entered: true, position: 1_000n, reasons: 0, inLoss: false, ...r });
const base = { now: 1_000_000, backoff: new Map<string, number>(), room: MAX_TRIPS_PER_MINUTE, ethOk: true };

test("a trip only for a position entered, holding something, with a reason; code, implementation and source bring it home", () => {
  const { trips, skipped } = selectTrips(
    [
      { position: spark(at(1)), read: read({ entered: false, reasons: VENUE_REASON.CODE }) },
      { position: spark(at(2)), read: read({ position: 0n, reasons: VENUE_REASON.CODE }) },
      { position: spark(at(3)), read: read({}) },
      { position: spark(at(4)), read: read({ reasons: VENUE_REASON.CODE }) },
      { position: spark(at(5)), read: read({ reasons: VENUE_REASON.IMPLEMENTATION }) },
      { position: raeto(at(6)), read: read({ reasons: VENUE_REASON.SOURCE }) },
    ],
    base,
  );
  assert.deepEqual(
    trips.map((t) => [t.position.vault, t.mode, t.reasons]),
    [
      [at(4), "home", VENUE_REASON.CODE],
      [at(5), "home", VENUE_REASON.IMPLEMENTATION],
      [at(6), "home", VENUE_REASON.SOURCE],
    ],
  );
  assert.deepEqual(skipped, [], "nothing to do is not a skip");
});

test("never home from a venue in loss (the vault refuses it); a stock vault above its max LTV is deleveraged once per venue", () => {
  const { trips, skipped } = selectTrips(
    [
      { position: raeto(at(1)), read: read({ reasons: VENUE_REASON.SOURCE, inLoss: true }) },
      { position: nvda(at(2)), read: read({ reasons: VENUE_REASON.LTV, inLoss: true }) },
      { position: nvda(at(3)), read: read({ reasons: VENUE_REASON.LTV }) },
      { position: nvda(at(4)), read: read({ reasons: VENUE_REASON.CODE }) },
    ],
    base,
  );
  assert.deepEqual(
    trips.map((t) => [t.position.vault, t.mode]),
    [
      [at(2), "deleverage"],
      [at(4), "home"],
    ],
  );
  assert.deepEqual(
    skipped.map((s) => [s.position.vault, s.why]),
    [
      [at(1), "the venue reports a loss: the vault refuses the trip (InLoss)"],
      [at(3), "the venue is deleveraged by another vault's trip in this tick"],
    ],
  );
});

test("a position whose trip reverted is left alone until its backoff ends", () => {
  const p = spark(at(1));
  const backoff = new Map([[`${p.vault.toLowerCase()}:${p.kind}:${p.venue.toLowerCase()}`, base.now + 1]]);
  const reads = [{ position: p, read: read({ reasons: VENUE_REASON.CODE }) }];
  assert.deepEqual(selectTrips(reads, { ...base, backoff }).trips, []);
  assert.equal(selectTrips(reads, { ...base, backoff }).skipped[0]?.why, "its last trip reverted: left alone for a while");
  assert.equal(selectTrips(reads, { ...base, backoff, now: base.now + 1 }).trips.length, 1);
});

test("at most the minute's room of trips; none while the fee payer's ETH is low", () => {
  const reads = Array.from({ length: MAX_TRIPS_PER_MINUTE + 3 }, (_, i) => ({ position: spark(at(i + 1)), read: read({ reasons: VENUE_REASON.CODE }) }));
  const full = selectTrips(reads, base);
  assert.equal(full.trips.length, MAX_TRIPS_PER_MINUTE);
  assert.equal(full.skipped.length, 3);
  assert.match(full.skipped[0]?.why ?? "", /trips a minute/);
  assert.equal(selectTrips(reads, { ...base, room: 2 }).trips.length, 2);
  const low = selectTrips(reads, { ...base, ethOk: false });
  assert.deepEqual(low.trips, []);
  assert.ok(low.skipped.every((s) => s.why === "the fee payer's ETH is low"));
});

test("only the first release's venues: a venue anyone deploys and a vault enables is never tripped", () => {
  assert.equal(VENUE_CATALOG.length, 7);
  assert.ok(inVenueCatalog(VENUE_KIND.ERC4626, SPARK_SAVINGS_USDG));
  assert.ok(!inVenueCatalog(VENUE_KIND.RAETO_USDG, SPARK_SAVINGS_USDG), "the kind must be the venue's own");
  assert.ok(!inVenueCatalog(VENUE_KIND.ERC4626, STEAKHOUSE_USDG));
  const fake = { vault: at(1), kind: VENUE_KIND.ERC4626, venue: at(0xfeed) };
  const { trips, skipped } = selectTrips([{ position: fake, read: read({ reasons: VENUE_REASON.IMPLEMENTATION }) }, { position: spark(at(2)), read: read({ reasons: VENUE_REASON.CODE }) }], base);
  assert.deepEqual(trips.map((t) => t.position.vault), [at(2)]);
  assert.deepEqual(skipped, []);
});

test("a trip retried with what the venue can pay: only when that is some of the position and not all of it", () => {
  assert.equal(partialTripAmount(1_000n, 400n), 400n);
  assert.equal(partialTripAmount(1_000n, 0n), null, "nothing payable: no trip");
  assert.equal(partialTripAmount(1_000n, 1_000n), null, "all of it payable: the trip of the whole position stands");
  assert.equal(partialTripAmount(0n, 0n), null);
});

test("a partial trip takes at least a tenth of the position, or several trips' gas when that is less; dust is never sent", () => {
  assert.equal(partialTripMinimum(1_000_000n, null), 100_000n, "no price: a tenth");
  assert.equal(partialTripMinimum(1_000_000n, 30_000n), 30_000n, "the gas worth less than a tenth");
  assert.equal(partialTripMinimum(1_000_000n, 500_000n), 100_000n);
  const min = partialTripMinimum(1_000_000n, null);
  assert.equal(partialTripAmount(1_000_000n, 99_999n, min), null, "under the minimum: no trip");
  assert.equal(partialTripAmount(1_000_000n, 100_000n, min), 100_000n);
  assert.equal(partialTripAmount(1_000_000n, 1_000_000n, min), null, "all of it: the whole position's trip stands");
});

test("after a trip that landed: a while when it changed nothing, a few minutes after a partial one, none after a whole one", () => {
  assert.equal(tripBackoffMs({ effect: false, partial: false }), NO_EFFECT_RETRY_MS);
  assert.equal(tripBackoffMs({ effect: false, partial: true }), NO_EFFECT_RETRY_MS);
  assert.equal(tripBackoffMs({ effect: true, partial: true }), PARTIAL_RETRY_MS);
  assert.equal(tripBackoffMs({ effect: true, partial: false }), null);
});
