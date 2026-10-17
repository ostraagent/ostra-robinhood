// The aggregator state, one JSON file (state.json) in OSTRA_AGGREGATOR_DATA
// (0700). No secrets, but it does hold which leaves belong to which deposit
// until their batch is sealed; a sealed batch's deposits are deleted from it
// at once (design v0.3: the aggregator forgets that mapping after the seal).
//
// The file is written to a temporary file and renamed, so a crash leaves
// either the old or the new state. Saves run one at a time and always write
// the latest state.
//
// On Robinhood Chain (design v0.4) a sealed batch is not kept: on Solana it was
// closed for its rent once every leaf was spent, and an EVM batch has no rent.

import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WireLeaf } from "@ostraagent/sdk";

export const STATE_FILE = "state.json";

export type DepositRecord = {
  /** The OstraPool deposit key (0x, lowercase hex). */
  deposit: string;
  /** The depositor (from the deposit's DepositCreated event): the one-time key whose EIP-191 signature polls it. */
  depositor: string;
  leaves: WireLeaf[];
  /** Unix seconds; the queue order (a deposit that let a batch expire goes to the back). */
  queuedAt: number;
  /** Unix seconds of the latest signed poll, or null until the depositor polls (again). */
  polledAt: number | null;
  /** Polls signed at or before this time are ignored: set when a batch expired without this deposit's approval. */
  pollNotBefore: number;
};

export type OpenBatch = {
  /** The batch id on the pool (decimal), known once createBatch landed; null before. */
  batch: string | null;
  /**
   * The pool's batch counter when this batch was built (decimal): a batch of
   * this aggregator created at or after it, empty and of this capacity, is
   * this one, found again after a crash between createBatch and the save.
   */
  searchFrom: string;
  deposits: string[];
  /** Every leaf of the batch in its shuffled on-chain order. */
  leaves: WireLeaf[];
  /** Leaves appended on-chain so far. */
  appended: number;
  /** State hash of the complete batch (0x hex): what every deposit must approve. */
  stateHash: string;
  /** Unix seconds by which every deposit must have approved; null until the batch is complete. */
  approveBy: number | null;
  createdAt: number;
};

export type AggregatorState = {
  version: 1;
  /** Every registered pending deposit, including those of the open batch until it is sealed. */
  deposits: Record<string, DepositRecord>;
  open: OpenBatch | null;
};

export function emptyState(): AggregatorState {
  return { version: 1, deposits: {}, open: null };
}

export class StateStore {
  readonly path: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, STATE_FILE);
  }

  async load(): Promise<AggregatorState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw err;
    }
    const state = JSON.parse(text) as AggregatorState;
    if (state.version !== 1) throw new Error(`${this.path}: unknown state version ${String(state.version)}`);
    return state;
  }

  /** Writes `state` as it is when this write runs (later changes to the object are picked up). */
  save(state: AggregatorState): Promise<void> {
    const next = this.#writes
      .catch(() => undefined)
      .then(async () => {
        const tmp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
        try {
          await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
          await rename(tmp, this.path);
        } catch (err) {
          await rm(tmp, { force: true });
          throw err;
        }
      });
    this.#writes = next;
    return next;
  }
}
