// unshield: leaves of the shielded pool into private vaults (design v0.3,
// decided 15 Oct 2026; on Robinhood Chain, design v0.4).
//
// Each leaf goes to its own new vault: several leaves in one vault could be
// matched with the public deposit amounts. Private vault `index` has its own
// keychain derived from the master seed and the index (keys.ts
// privateVaultKeychainId), its own relayer channels and records
// (keys.forPrivateVault), and is used by pay and withdraw like the main vault.
//
// A leaf is spent at a random time, uniform within the window the caller
// chooses (UNSHIELD_DEFAULT_WINDOW_HOURS by default, at most
// UNSHIELD_MAX_WINDOW_HOURS, the most a payment session lives; 0 spends it
// now). One transaction creates the vault and spends the leaf into it (the
// vault holds its tokens itself; on Solana, its token account); with the
// relayer paying, both are the new vault's debt, paid with
// the first voucher of its own channel to the relayer, so no other vault of
// this agent pays for it. The sweep (every 5 minutes) spends the leaves whose
// time has come, so a leaf goes out at most one sweep after its time.
//
// Entries, in the agent's `unshield` folder (on disk OSTRA_HOME/unshield,
// 0700): <chain>-<token>-<vault index>.json, records without secrets.

import { encodeFunctionData, getAddress, type Address, type Hash, type PublicClient } from "viem";
import { ostraPoolAbi, readBatch, readVault, signSpendLeaf, type RelayCall } from "@ostraagent/sdk";
import { formatTokenAmount } from "./amount.ts";
import type { Config } from "./config.ts";
import type { Keys } from "./keys.ts";
import { randomInt } from "./random.ts";
import type { Sender } from "./relay.ts";
import type { ShieldService } from "./shield.ts";
import type { Folder } from "./storage.ts";
import type { VaultService } from "./vault.ts";

export const UNSHIELD_DIR = "unshield";
/** Window a leaf is spent in when the caller names none (design v0.3, decided 15 Oct 2026). */
export const UNSHIELD_DEFAULT_WINDOW_HOURS = 6;
/** The longest window: the most a payment session lives (design v0.3, decided 15 Oct 2026). */
export const UNSHIELD_MAX_WINDOW_HOURS = 24;
/** Gas of a spendLeaf, for the local fee payer's ETH check: 229,898 measured on the fork, rounded up. */
const LEAF_SPEND_GAS = 300_000n;

/** What unshield needs of a private vault: its vault service and who pays its transactions. */
export type PrivateVaultContext = { vault: VaultService; sender: Sender };

export type UnshieldRecord = {
  version: 1;
  chainId: number;
  token: string;
  /** The private vault's number. */
  index: number;
  vault: string;
  /** The shield deposit the leaf came from, and the leaf's key index in its leaf keychain (shield.ts leafKeyIndex). */
  shieldIndex: number;
  leaf: number;
  batch: string;
  leafIndex: number;
  amount: string;
  /** Unix seconds from which the sweep spends the leaf. */
  dueAt: number;
  status: "scheduled" | "spent";
  txHash: Hash | null;
  createdAt: number;
  spentAt: number | null;
};

export type UnshieldView = {
  index: number;
  vault: string;
  amount: string;
  batch: string;
  leafIndex: number;
  status: "scheduled" | "spent";
  dueAt: string;
  txHash: Hash | null;
};

function recordName(chainId: number, token: string, index: number): string {
  return `${chainId}-${getAddress(token)}-${index}.json`;
}

/** Seconds from now until a leaf is spent: uniform over the window (whole seconds, both ends included). */
export function unshieldDelaySeconds(windowHours: number): number {
  if (!Number.isFinite(windowHours) || windowHours < 0 || windowHours > UNSHIELD_MAX_WINDOW_HOURS) {
    throw new RangeError(`windowHours must be from 0 to ${UNSHIELD_MAX_WINDOW_HOURS}`);
  }
  const most = Math.floor(windowHours * 3600);
  return most === 0 ? 0 : randomInt(0, most + 1);
}

function view(r: UnshieldRecord): UnshieldView {
  return {
    index: r.index,
    vault: r.vault,
    amount: formatTokenAmount(BigInt(r.amount)),
    batch: r.batch,
    leafIndex: r.leafIndex,
    status: r.status,
    dueAt: new Date(r.dueAt * 1000).toISOString(),
    txHash: r.txHash,
  };
}

export class UnshieldService {
  readonly #client: PublicClient;
  readonly #config: Config;
  readonly #keys: Keys;
  readonly #shield: ShieldService;
  readonly #context: (index: bigint) => Promise<PrivateVaultContext>;
  readonly #folder: Folder;
  #queue: Promise<unknown> = Promise.resolve();

  /** `keys`: the agent's own keys (its records go to the `unshield` folder in the agent's folder). */
  constructor(client: PublicClient, config: Config, keys: Keys, shield: ShieldService, context: (index: bigint) => Promise<PrivateVaultContext>) {
    this.#client = client;
    this.#config = config;
    this.#keys = keys;
    this.#shield = shield;
    this.#context = context;
    this.#folder = keys.folder.folder(UNSHIELD_DIR);
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #records(): Promise<UnshieldRecord[]> {
    await this.#folder.ensure();
    const prefix = `${this.#config.chainId}-${this.#config.deployment.token}-`;
    const out: UnshieldRecord[] = [];
    for (const name of await this.#folder.list()) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      const text = await this.#folder.read(name);
      if (text !== undefined) out.push(JSON.parse(text) as UnshieldRecord);
    }
    return out.sort((a, b) => a.index - b.index);
  }

  async #save(record: UnshieldRecord): Promise<void> {
    await this.#folder.ensure();
    await this.#folder.write(recordName(record.chainId, record.token, record.index), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** The private vaults created so far (their leaf spent), by index. */
  vaults(): Promise<{ index: bigint; vault: Address }[]> {
    return this.#serial(async () => (await this.#records()).filter((r) => r.status === "spent").map((r) => ({ index: BigInt(r.index), vault: getAddress(r.vault) })));
  }

  /** The number of the private vault at `vault`, or throws when it is none of this agent's. */
  async indexOf(vault: string): Promise<bigint> {
    const found = (await this.vaults()).find((v) => v.vault.toLowerCase() === vault.toLowerCase());
    if (found === undefined) throw new Error(`${vault} is not a private vault of this agent (balance lists them under privateVaults)`);
    return found.index;
  }

  /** Every leaf scheduled or spent, with its private vault. */
  list(): Promise<UnshieldView[]> {
    return this.#serial(async () => (await this.#records()).map(view));
  }

  /**
   * Schedules `leaves` unspent leaves of sealed shield deposits (oldest
   * first), each into a new private vault at a random time within
   * `windowHours`; with 0, spends them now.
   */
  unshield(leaves: number, windowHours: number): Promise<{ leaves: UnshieldView[]; note: string }> {
    return this.#serial(async () => {
      if (!Number.isInteger(leaves) || leaves < 1) throw new RangeError("leaves must be a positive whole number");
      unshieldDelaySeconds(windowHours);
      const records = await this.#records();
      const taken = new Set(records.map((r) => `${r.batch}:${r.leafIndex}`));
      const available: { shieldIndex: number; leaf: number; batch: string; leafIndex: number }[] = [];
      for (const d of await this.#shield.list()) {
        if (d.status !== "closed" || d.batch === null) continue;
        for (const l of d.leavesInPool) {
          if (!l.spent && !taken.has(`${l.batch}:${l.leafIndex}`)) available.push({ shieldIndex: d.index, leaf: l.key, batch: l.batch, leafIndex: l.leafIndex });
        }
      }
      if (available.length < leaves) {
        throw new Error(`${available.length} leaf(s) can be unshielded now (sealed in a batch, not spent, not scheduled); asked for ${leaves}`);
      }
      let index = records.reduce((n, r) => Math.max(n, r.index + 1), 0);
      const now = Math.floor(Date.now() / 1000);
      const created: UnshieldRecord[] = [];
      for (const leaf of available.slice(0, leaves)) {
        const ctx = await this.#context(BigInt(index));
        const batch = await readBatch(this.#client, this.#config.deployment.pool, BigInt(leaf.batch));
        const onChain = batch.leaves[leaf.leafIndex];
        if (batch.status !== "sealed" || onChain === undefined || onChain.spent) throw new Error(`leaf ${leaf.leafIndex} of batch ${leaf.batch} is no longer in the pool`);
        const record: UnshieldRecord = {
          version: 1,
          chainId: this.#config.chainId,
          token: this.#config.deployment.token,
          index,
          vault: await ctx.vault.vaultAddress(),
          shieldIndex: leaf.shieldIndex,
          leaf: leaf.leaf,
          batch: leaf.batch,
          leafIndex: leaf.leafIndex,
          amount: onChain.amount.toString(),
          dueAt: now + unshieldDelaySeconds(windowHours),
          status: "scheduled",
          txHash: null,
          createdAt: now,
          spentAt: null,
        };
        await this.#save(record);
        created.push(record);
        index++;
      }
      const failures: string[] = [];
      for (const r of created) {
        if (r.dueAt > now) continue;
        try {
          await this.#spend(r);
        } catch (err) {
          failures.push(`leaf into private vault ${r.index}: ${(err as Error).message}`);
        }
      }
      const note =
        "each leaf goes into its own new private vault at its time (dueAt): one transaction creates the vault and spends the leaf into it, " +
        "and this server sends it at the first sweep (every 5 minutes) after that time; a private vault is then used by pay and withdraw with privateVault, " +
        "and balance lists it under privateVaults" +
        (failures.length === 0 ? "" : `; not spent now, retried by the sweep: ${failures.join("; ")}`);
      return { leaves: created.map(view), note };
    });
  }

  /** Spends the leaves whose time has come. Returns one message per leaf that failed (retried at the next sweep). */
  sweep(): Promise<string[]> {
    return this.#serial(async () => {
      const failures: string[] = [];
      const now = Math.floor(Date.now() / 1000);
      for (const r of await this.#records()) {
        if (r.status !== "scheduled" || r.dueAt > now) continue;
        try {
          await this.#spend(r);
        } catch (err) {
          failures.push(`leaf into private vault ${r.index}: ${(err as Error).message}`);
        }
      }
      return failures;
    });
  }

  /**
   * Creates private vault `r.index` and spends the leaf into it in one
   * transaction; when the vault exists already (an earlier send landed its
   * creation only, or the leaf was spent), only what is left is done.
   */
  async #spend(r: UnshieldRecord): Promise<void> {
    const ctx = await this.#context(BigInt(r.index));
    const vault = await ctx.vault.vaultAddress();
    if (vault !== getAddress(r.vault)) throw new Error(`private vault ${r.index} is ${vault}, not the recorded ${r.vault}`);
    const pool = this.#config.deployment.pool;
    const batch = await readBatch(this.#client, pool, BigInt(r.batch));
    const leaf = batch.leaves[r.leafIndex];
    if (batch.status === "none" || leaf === undefined) throw new Error(`batch ${r.batch} or its leaf ${r.leafIndex} is gone`);
    const exists = (await readVault(this.#client, this.#config.deployment, vault)) !== null;
    if (leaf.spent) {
      // Spent by an earlier send of this same transaction (or of the leaf alone): the vault holds it.
      if (!exists) throw new Error(`leaf ${r.leafIndex} of batch ${r.batch} was spent, but private vault ${vault} does not exist`);
      r.status = "spent";
      r.spentAt = Math.floor(Date.now() / 1000);
      await this.#save(r);
      return;
    }
    const calls: RelayCall[] = [];
    if (!exists) {
      await ctx.vault.requireEth(ctx.vault.createGas() + LEAF_SPEND_GAS, "create a private vault and spend the leaf into it", ctx.sender);
      calls.push(await ctx.vault.createCall());
    }
    const signed = await signSpendLeaf(
      this.#keys.shieldLeafKeychain(this.#config.chainId, this.#config.deployment.token, BigInt(r.shieldIndex)),
      { index: BigInt(r.leaf), leafKeyRoot: leaf.keyRoot },
      { chainId: this.#config.chainId, pool, batchId: BigInt(r.batch), leafIndex: r.leafIndex, destination: vault, leafAmount: leaf.amount },
    );
    calls.push({ to: pool, data: encodeFunctionData({ abi: ostraPoolAbi, functionName: "spendLeaf", args: [signed.batchId, signed.leafIndex, signed.destination, signed.signature] }) });
    r.txHash = await ctx.sender.send(calls);
    r.status = "spent";
    r.spentAt = Math.floor(Date.now() / 1000);
    await this.#save(r);
  }
}
