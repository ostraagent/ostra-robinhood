// Channel records, one JSON file per channel in OSTRA_KEEPER_DATA/channels
// (0700). No secrets: the best voucher is a signature the buyer already gave
// the seller, and it can only add to what the seller is paid.
//
// Records are written to a temporary file and renamed, so a crash leaves
// either the old or the new record. Saves of one channel run one at a time and
// always write the latest state.

import { randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelConfig } from "@ostraagent/sdk";
import { ensurePrivateDir } from "./keys.ts";

export const CHANNELS_DIR = "channels";

export type StoredVoucher = {
  /** Cumulative ceiling (uint128, decimal). */
  maxClaimableAmount: string;
  /** 65-byte signature of the channel's payerAuthorizer, hex. */
  signature: string;
};

export type KeeperStep = { step: string; tx: string; at: number };

export type ChannelRecord = {
  version: 1;
  /** x402 channel id (lowercase hex). */
  channel: string;
  /** The channel's config, exactly as x402BatchSettlement hashes it. */
  config: ChannelConfig;
  /** The seller's merchant key; the vault's crank is derived from it. */
  merchant: string;
  /** The seller vault (the channel's receiverAuthorizer). */
  vault: string;
  /** The seller's OstraSplit (the channel's receiver). */
  split: string;
  token: string;
  /** The split's shares other than the seller vault, checked against the split's address. */
  recipients: { recipient: string; bps: number }[];
  /** Highest voucher received. */
  voucher: StoredVoucher | null;
  /** Chain time (block timestamp, unix seconds) when the oldest voucher not yet claimed on-chain arrived. */
  unsettledSince: number | null;
  steps: KeeperStep[];
  /** True once the channel holds no unclaimed escrow and its claims are paid out: nothing is left to guard. */
  done: boolean;
  createdAt: number;
};

export class ChannelStore {
  readonly dir: string;
  readonly #writes = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, CHANNELS_DIR);
  }

  async init(): Promise<void> {
    await ensurePrivateDir(this.dir);
  }

  #path(channel: string): string {
    if (!/^0x[0-9a-f]{64}$/.test(channel)) throw new Error("a channel id is 32 bytes of lowercase hex");
    return join(this.dir, `${channel}.json`);
  }

  async load(channel: string): Promise<ChannelRecord | null> {
    try {
      return JSON.parse(await readFile(this.#path(channel), "utf8")) as ChannelRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async loadAll(): Promise<ChannelRecord[]> {
    const out: ChannelRecord[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json")) continue;
      out.push(JSON.parse(await readFile(join(this.dir, name), "utf8")) as ChannelRecord);
    }
    return out;
  }

  /** Writes `record` as it is when this write runs (later changes to the object are picked up). */
  save(record: ChannelRecord): Promise<void> {
    const previous = this.#writes.get(record.channel) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const path = this.#path(record.channel);
        const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
        try {
          await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
          await rename(tmp, path);
        } catch (err) {
          await rm(tmp, { force: true });
          throw err;
        }
      });
    this.#writes.set(record.channel, next);
    void next.finally(() => {
      if (this.#writes.get(record.channel) === next) this.#writes.delete(record.channel);
    }).catch(() => undefined);
    return next;
  }
}
