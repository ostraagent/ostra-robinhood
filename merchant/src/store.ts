// Durable channel store of the seller's server: one JSON file per channel in
// OSTRA_MERCHANT_DATA/channels (0700, files 0600), so the channels this server
// charges on, their latest vouchers and their idle-close state survive a
// restart.
//
// It is the ChannelStorage of the x402 batch-settlement server scheme
// (@x402/evm/batch-settlement/server, server/storage.ts): updates of one
// channel run one at a time (atomic inspect-and-mutate), and the mutator's
// result is written as given. Beside the x402 record each file keeps this
// server's own channel state (`meta`), which the x402 scheme never sees, so
// the scheme rebuilding a record never loses it. Writes go to a temporary file
// that is renamed, so a crash leaves either the old or the new record. This is
// one process's store (the x402 file storage's cross-process lock files are
// not needed, and a crash could leave one behind).

import { randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Channel, ChannelStorage, ChannelUpdateResult } from "@x402/evm/batch-settlement/server";
import { ensurePrivateDir } from "./keys.ts";

export const CHANNELS_DIR = "channels";
const RECORD_VERSION = 1;

/** This server's own state of a channel. */
export type ChannelMeta = {
  /** Unix ms when this server last asked the keeper to close the channel (idle close or a buyer's refund). */
  closeRequestedAt?: number;
  /** Unix ms when the keeper last reported the channel closed (no unclaimed escrow left). */
  closedAt?: number;
};

type FileRecord = { version: number; channel: Channel; meta: ChannelMeta };

export type ChannelChange = (previous: Channel | undefined, next: Channel | undefined) => void;

/** x402 channel ids are bytes32; stored lowercase, which is also the file name. */
export function channelKey(channelId: string): string {
  const key = channelId.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(key)) throw new Error(`invalid channel id ${channelId}`);
  return key;
}

export class FileChannelStorage implements ChannelStorage {
  readonly dir: string;
  readonly #channels = new Map<string, Channel>();
  readonly #meta = new Map<string, ChannelMeta>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #listeners: ChannelChange[] = [];

  private constructor(dir: string) {
    this.dir = dir;
  }

  /** Opens (and creates) the store under `dataDir`, loading every record. */
  static async open(dataDir: string): Promise<FileChannelStorage> {
    const store = new FileChannelStorage(join(dataDir, CHANNELS_DIR));
    await ensurePrivateDir(store.dir);
    for (const name of await readdir(store.dir)) {
      if (!name.endsWith(".json")) continue;
      const record = JSON.parse(await readFile(join(store.dir, name), "utf8")) as FileRecord;
      if (record.version > RECORD_VERSION) throw new Error(`${name} was written by a newer version (${record.version}); refusing to load it`);
      const key = channelKey(record.channel.channelId);
      if (`${key}.json` !== name) throw new Error(`${name} holds channel ${record.channel.channelId}`);
      store.#channels.set(key, record.channel);
      store.#meta.set(key, record.meta);
    }
    return store;
  }

  /** Called after every change of a channel record (not of its meta). */
  onChange(listener: ChannelChange): void {
    this.#listeners.push(listener);
  }

  #withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.#locks.set(key, settled);
    void settled.then(() => {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    });
    return next;
  }

  async #write(key: string, channel: Channel, meta: ChannelMeta): Promise<void> {
    const path = join(this.dir, `${key}.json`);
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const record: FileRecord = { version: RECORD_VERSION, channel, meta };
    try {
      await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async get(channelId: string): Promise<Channel | undefined> {
    return this.#channels.get(channelKey(channelId));
  }

  list(): Promise<Channel[]> {
    return Promise.resolve([...this.#channels.values()].sort((a, b) => a.channelId.localeCompare(b.channelId)));
  }

  /** This server's own state of the channel (an empty object for a channel it has none for). */
  meta(channelId: string): ChannelMeta {
    return { ...(this.#meta.get(channelKey(channelId)) ?? {}) };
  }

  async updateChannel(channelId: string, update: (current: Channel | undefined) => Channel | undefined): Promise<ChannelUpdateResult> {
    const key = channelKey(channelId);
    return this.#withLock(key, async () => {
      const current = this.#channels.get(key);
      const next = update(current);
      if (next === current) return { channel: current, status: "unchanged" as const };
      if (next === undefined) {
        await rm(join(this.dir, `${key}.json`), { force: true });
        this.#channels.delete(key);
        this.#meta.delete(key);
        for (const listener of this.#listeners) listener(current, undefined);
        return { channel: undefined, status: current === undefined ? ("unchanged" as const) : ("deleted" as const) };
      }
      if (channelKey(next.channelId) !== key) throw new Error(`an update of ${key} returned channel ${next.channelId}`);
      const meta = this.#meta.get(key) ?? {};
      await this.#write(key, next, meta);
      this.#channels.set(key, next);
      this.#meta.set(key, meta);
      for (const listener of this.#listeners) listener(current, next);
      return { channel: next, status: "updated" as const };
    });
  }

  /**
   * Atomically inspects a channel and its meta and replaces the meta (and,
   * when `update` returns one, the channel record). Returns what was stored,
   * or undefined when the channel has no record.
   */
  async updateMeta(
    channelId: string,
    update: (channel: Channel, meta: ChannelMeta) => { meta: ChannelMeta; channel?: Channel } | undefined,
  ): Promise<{ channel: Channel; meta: ChannelMeta } | undefined> {
    const key = channelKey(channelId);
    return this.#withLock(key, async () => {
      const channel = this.#channels.get(key);
      if (channel === undefined) return undefined;
      const meta = this.#meta.get(key) ?? {};
      const result = update(channel, { ...meta });
      if (result === undefined) return { channel, meta };
      const nextChannel = result.channel ?? channel;
      await this.#write(key, nextChannel, result.meta);
      this.#channels.set(key, nextChannel);
      this.#meta.set(key, result.meta);
      if (nextChannel !== channel) for (const listener of this.#listeners) listener(channel, nextChannel);
      return { channel: nextChannel, meta: result.meta };
    });
  }
}
