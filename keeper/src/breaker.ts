// The breaker keeper (decided by Edu on 25 Oct 2026): OstraBreaker's trip can be sent by anyone, but an agent runs
// only from time to time, so Ostra watches every vault the breaker watches and sends the trip itself, paying its gas,
// the moment a limit is crossed on chain.
//
//   * The watched pairs (vault, Vault V2) are the breaker's Watched and Unwatched events, read on from a cursor kept in
//     the data directory every PAIRS_INTERVAL_MS (the last event of a pair decides: Watched keeps it, Unwatched drops it).
//   * Every TICK_INTERVAL_MS each pair is read with the breaker's own view, check(vault, target): when it reports a
//     limit crossed and the vault holds shares, trip(vault, target) is simulated and sent from the fee payer. The
//     breaker judges ASSETS, UTILIZATION and LIQUIDITY only on state settled before the current second, so a crossing
//     shows a second after it happens; a trip that no longer holds when sent (Healthy, NothingPayable) is a race, not
//     an error. A pair whose trip reverted is left alone for RETRY_AFTER_MS. Before a trip, the vault must be locked
//     with the breaker as its guardian (the vault refuses the trip otherwise): a pair that is not is left alone for
//     NOT_ARMED_RETRY_MS (a vault armed without turning its lock on, for one), except that a vault left alone for its
//     lock being off is read again each tick for that lock alone, and tripped as soon as the lock is on.
//   * Trips are sent one after the other from one account; the client polls receipts every 250 ms (breaker-main.ts),
//     so many vaults tripping in one crisis are each a fraction of a second apart.
//   * The fee payer's ETH is checked every PAIRS_INTERVAL_MS: under LOW_ETH_WEI it is logged (low_eth), so it is topped
//     up before a trip cannot be paid.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BaseError, ContractFunctionRevertedError, getAddress, parseAbiItem, type Address, type Hash, type PublicClient } from "viem";
import { getLogsChunked, ostraBreakerAbi, ostraVaultAbi, readVaultGuard } from "@ostraagent/sdk";

/** How often each pair is checked: Robinhood Chain makes about 9.5 blocks a second (measured 24 Oct 2026), and a settled crossing shows a second after it happens. */
export const TICK_INTERVAL_MS = 2_000;
/** How often new Watched and Unwatched events and the fee payer's ETH are read. */
export const PAIRS_INTERVAL_MS = 30_000;
/** A pair whose trip reverted is not tried again for this long. */
export const RETRY_AFTER_MS = 10_000;
/** A pair whose vault is not locked, or does not have the breaker as its guardian, is not looked at again for this long. */
export const NOT_ARMED_RETRY_MS = 10 * 60_000;

/** The custom error a revert carries (Healthy, NothingPayable, ...), or its first line. */
export function revertName(err: unknown): string {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError && r.data?.errorName !== undefined) return r.data.errorName;
  }
  return ((err as Error).message ?? String(err)).split("\n")[0] as string;
}
/**
 * The fee payer's ETH under which low_eth is logged: about 118 trips of 844,930 gas (a whole position redeemed, measured
 * on a mainnet fork on 25 Oct 2026) at 0.020056 gwei (Robinhood Chain's gas price that day).
 */
export const LOW_ETH_WEI = 2_000_000_000_000_000n;
/** Blocks the event cursor stays behind the head (a node may answer getLogs late for its newest blocks). */
export const RESCAN_BLOCKS = 3_000n;

const watchedEvent = parseAbiItem("event Watched(address indexed vault, address indexed target, (uint16 priceDropBps, uint16 assetsDropBps, uint16 maxUtilizationBps, uint32 minLiquidityBps, uint128 assetsMarkCap) limits, uint256 assetsMark, uint64 nonce)");
const unwatchedEvent = parseAbiItem("event Unwatched(address indexed vault, address indexed target, uint64 nonce)");

export type BreakerPair = { vault: Address; target: Address };
type Kept = { toBlock: string; pairs: BreakerPair[] };

export type BreakerKeeperParts = {
  client: PublicClient;
  /** Serves eth_getLogs over long windows (the public RPC). */
  logsClient: PublicClient;
  breaker: Address;
  /** The first block to read events from (the breaker was deployed after the deployment's fromBlock). */
  fromBlock: bigint;
  /** The fee payer's address (its ETH is watched) and how a trip is sent (simulated first). */
  feePayer: Address;
  trip: (pair: BreakerPair) => Promise<{ hash: Hash; gasUsed: bigint }>;
  dataDir: string;
  log: (event: string, fields: Record<string, unknown>) => void;
};

const key = (p: BreakerPair) => `${p.vault.toLowerCase()}:${p.target.toLowerCase()}`;

export class BreakerKeeper {
  readonly #p: BreakerKeeperParts;
  #kept: Kept;
  readonly #backoff = new Map<string, number>();
  /** Pairs left alone because their vault's lock was off (with the breaker its guardian): the lock is read each tick. */
  readonly #unlocked = new Set<string>();
  #timers: NodeJS.Timeout[] = [];
  #ticking = false;
  #reading = false;

  private constructor(p: BreakerKeeperParts, kept: Kept) {
    this.#p = p;
    this.#kept = kept;
  }

  static async open(p: BreakerKeeperParts): Promise<BreakerKeeper> {
    await mkdir(p.dataDir, { recursive: true, mode: 0o700 });
    let kept: Kept = { toBlock: (p.fromBlock - 1n).toString(), pairs: [] };
    try {
      kept = JSON.parse(await readFile(join(p.dataDir, "breaker-pairs.json"), "utf8")) as Kept;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return new BreakerKeeper(p, kept);
  }

  get pairs(): readonly BreakerPair[] {
    return this.#kept.pairs;
  }

  /** Reads the breaker's Watched and Unwatched events since the cursor, in chain order, and keeps the pairs watched. */
  async refreshPairs(): Promise<void> {
    if (this.#reading) return;
    this.#reading = true;
    try {
      const to = await this.#p.logsClient.getBlockNumber({ cacheTime: 0 });
      const from = BigInt(this.#kept.toBlock) + 1n;
      if (from > to) return;
      const watched = await getLogsChunked(this.#p.logsClient, { address: this.#p.breaker, event: watchedEvent, fromBlock: from, toBlock: to });
      const unwatched = await getLogsChunked(this.#p.logsClient, { address: this.#p.breaker, event: unwatchedEvent, fromBlock: from, toBlock: to });
      const events = [...watched.map((l) => ({ l, on: true })), ...unwatched.map((l) => ({ l, on: false }))].sort((a, b) =>
        a.l.blockNumber === b.l.blockNumber ? a.l.logIndex - b.l.logIndex : a.l.blockNumber < b.l.blockNumber ? -1 : 1,
      );
      const pairs = new Map(this.#kept.pairs.map((p) => [key(p), p]));
      for (const { l, on } of events) {
        const a = l.args as { vault: Address; target: Address };
        const p = { vault: getAddress(a.vault), target: getAddress(a.target) };
        if (on) pairs.set(key(p), p);
        else pairs.delete(key(p));
      }
      const cursor = to - RESCAN_BLOCKS > BigInt(this.#kept.toBlock) ? to - RESCAN_BLOCKS : BigInt(this.#kept.toBlock);
      this.#kept = { toBlock: cursor.toString(), pairs: [...pairs.values()] };
      for (const k of [...this.#unlocked]) if (!pairs.has(k)) this.#unlocked.delete(k);
      const file = join(this.#p.dataDir, "breaker-pairs.json");
      await writeFile(`${file}.tmp`, JSON.stringify(this.#kept), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      const eth = await this.#p.client.getBalance({ address: this.#p.feePayer });
      if (eth < LOW_ETH_WEI) this.#p.log("low_eth", { feePayer: this.#p.feePayer, wei: eth.toString() });
    } finally {
      this.#reading = false;
    }
  }

  /** Checks every pair once and trips those with a limit crossed and shares to redeem. */
  async tick(): Promise<{ pair: BreakerPair; reasons: number; tx?: Hash; error?: string }[]> {
    if (this.#ticking) return [];
    this.#ticking = true;
    const out: { pair: BreakerPair; reasons: number; tx?: Hash; error?: string }[] = [];
    try {
      const now = Date.now();
      for (const pair of this.#kept.pairs) {
        if ((this.#backoff.get(key(pair)) ?? 0) > now) {
          if (!this.#unlocked.has(key(pair))) continue;
          // Left alone for its lock being off: one read of the lock; once it is on, the pair is checked now.
          try {
            if ((await readVaultGuard(this.#p.client, pair.vault)).lockedSince === 0n) continue;
          } catch {
            continue;
          }
          this.#backoff.delete(key(pair));
          this.#unlocked.delete(key(pair));
        }
        let s: { shares: bigint; reasons: number };
        try {
          s = (await this.#p.client.readContract({ address: this.#p.breaker, abi: ostraBreakerAbi, functionName: "check", args: [pair.vault, pair.target] })) as { shares: bigint; reasons: number };
        } catch (err) {
          out.push({ pair, reasons: 0, error: (err as Error).message.split("\n")[0] as string });
          continue;
        }
        if (s.reasons === 0 || s.shares === 0n) continue;
        try {
          const g = await readVaultGuard(this.#p.client, pair.vault);
          const guardian = (await this.#p.client.readContract({ address: pair.vault, abi: ostraVaultAbi, functionName: "isGuardian", args: [this.#p.breaker] })) as boolean;
          if (g.lockedSince === 0n || !guardian) {
            this.#backoff.set(key(pair), now + NOT_ARMED_RETRY_MS);
            if (g.lockedSince === 0n && guardian) this.#unlocked.add(key(pair));
            else this.#unlocked.delete(key(pair));
            this.#p.log("not_armed", { vault: pair.vault, target: pair.target, reasons: s.reasons, locked: g.lockedSince !== 0n, guardian });
            out.push({ pair, reasons: Number(s.reasons), error: g.lockedSince === 0n ? "not locked" : "the breaker is not its guardian" });
            continue;
          }
        } catch (err) {
          out.push({ pair, reasons: Number(s.reasons), error: revertName(err) });
          continue;
        }
        try {
          const sent = await this.#p.trip(pair);
          this.#p.log("tripped", { vault: pair.vault, target: pair.target, reasons: s.reasons, tx: sent.hash, gasUsed: sent.gasUsed.toString() });
          out.push({ pair, reasons: Number(s.reasons), tx: sent.hash });
        } catch (err) {
          const error = revertName(err);
          this.#backoff.set(key(pair), now + RETRY_AFTER_MS);
          // Healthy and NothingPayable: the state moved between the read and the send (or nothing can be paid now).
          this.#p.log(/Healthy|NothingPayable/.test(error) ? "trip_not_needed" : "trip_failed", { vault: pair.vault, target: pair.target, reasons: s.reasons, error });
          out.push({ pair, reasons: Number(s.reasons), error });
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
    void safe("pairs", () => this.refreshPairs())();
    this.#timers.push(setInterval(safe("pairs", () => this.refreshPairs()), PAIRS_INTERVAL_MS));
    this.#timers.push(setInterval(safe("tick", () => this.tick()), TICK_INTERVAL_MS));
  }

  stop(): void {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
  }
}
