// shield: tokens of the vault into the shielded pool (design v0.3, decided 15
// Oct 2026; on Robinhood Chain, design v0.4).
//
// A shield deposit has its own one-time depositor key, derived from the master
// seed and the deposit's number, like a session key:
//   1. the vault sends the deposit amount to the depositor key with one WOTS
//      transfer (withdraw);
//   2. the deposit: the depositor key signs an EIP-3009
//      ReceiveWithAuthorization of exactly that amount to the pool, whose
//      nonce binds every field of the deposit (OstraPool.depositNonce), and
//      the sender (the relayer, or the local fee payer) submits
//      depositWithAuthorization, so the depositor key needs no ETH. The
//      deposit names the vault as its refund owner and nothing about its
//      leaves (OstraPool version 2), so nothing on-chain ties it to them;
//   3. the leaves (standard 10-token leaves, one WOTS key each) go to the
//      aggregator signed by the depositor key, and every sweep polls it with
//      an EIP-191 signature of that key. Once the deposit is in a complete
//      batch whose leaves on-chain are all standard leaves and include all of
//      its own, at the state hash given, the deposit approves that batch with
//      its next approval key. A batch that does not seal has published its
//      leaves, so the aggregator then asks for new ones ("rekey"): leaf set
//      `attempt` uses leaf keys attempt * LEAF_KEYS_PER_ATTEMPT + j. Before
//      sending a set, the sweep also reads the aggregator's batches created
//      since the set was first sent: one other than the aggregator's current
//      open batch that holds a leaf of the set means the set is public, and
//      the deposit moves to the next set itself. So no leaf is offered to two
//      batches, whatever the aggregator remembers. Only the aggregator's own
//      batches count (only its key appends to them): anyone may copy public
//      leaves into a batch of their own, which must not make a deposit drop
//      out of the batch it is in. Batches are read through the agent's own
//      RPC, which must be honest: the pool does not check a deposit's leaves;
//   4. once the batch is sealed, the deposit is closed (closeDeposit marks it,
//      so an old approval can never be replayed into it). The leaves stay in
//      the pool until they are spent (unshield).
// A deposit no batch took within DEPOSIT_TIMEOUT_SECONDS (48 hours) is
// cancelled: the pool refunds it in full to the vault. Every key comes from
// the master seed: the seed and a record's attempt recover its leaves.
//
// On Solana the depositor key was the refund owner and gave back the deposit
// rent and its token account at the end; an EVM chain has no rent, and with
// the vault as refund owner a refund lands in the vault directly, where the
// depositor key, which holds no ETH, could not move it on its own.
//
// Entries, in the agent's `shield` folder (on disk OSTRA_HOME/shield, 0700):
// <chain>-<token>-<index>.json, records without secrets. Every vault of the
// agent in that token (the buyer vault, the creator vault) shields through its
// own ShieldService into the same records: a record names the vault it
// refunds to, deposit numbers are shared (a new record is created
// exclusively), each service moves on only its own vault's deposits, and list
// shows them all, so unshield takes the leaves of any of them.
//
// Auto-shield (design v0.4: the creator's share of a launch, optionally into
// the shielded pool when the quote is USDG): when it is on for this service's
// vault, every sweep shields as many leaves as the vault's balance above
// `keep` pays for (within the pool's limits), once no earlier deposit of the
// vault is still being funded. It is meant for the creator vault, which holds
// nothing but the creator's payouts. `keep` (default RELAYER_CHANNEL_DEPOSIT)
// stays in the vault to pay the relayer for the shield's own transactions.
// Setting: auto-shield-<chain>-<token>-<vault>.json in the same folder.

import { bytesToHex, encodeFunctionData, getAddress, hexToBytes, parseSignature, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import {
  DEPOSIT_TIMEOUT_SECONDS,
  LEAF_DENOMINATION,
  approvalMessage,
  batchContainsLeaves,
  batchLeavesStandard,
  batchStateOf,
  depositAuthorizationTypedData,
  depositForLeaves,
  depositKey,
  leafToWire,
  MAX_LEAF_ATTEMPTS,
  maxLeavesPerDeposit,
  ostraPoolAbi,
  readBatch,
  readDeposit,
  readPool,
  signAggregatorLeaves,
  signAggregatorPoll,
  signApproveBatch,
  toHex,
  type AggregatorDepositView,
  type DepositState,
  type Leaf,
  type WotsKeychain,
} from "@ostraagent/sdk";
import { formatTokenAmount, parseTokenAmount } from "./amount.ts";
import { chainTime, tokenBalance } from "./chain.ts";
import { RELAYER_CHANNEL_DEPOSIT, type Config } from "./config.ts";
import type { Keys } from "./keys.ts";
import type { Sender } from "./relay.ts";
import type { Folder } from "./storage.ts";
import type { VaultService } from "./vault.ts";

export const SHIELD_DIR = "shield";
/** How long one request to the aggregator may take. */
const AGGREGATOR_TIMEOUT_MS = 30_000;
/** How long a deposit authorization the depositor key signs stays valid (it is signed again when it ran out unsent). */
const AUTHORIZATION_TTL_SECONDS = 3_600n;
/** Gas of a relayed deposit, for the local fee payer's ETH check: depositWithAuthorization measured at 198,687 on the fork (OstraPool version 2), rounded up with room. */
const DEPOSIT_GAS = 350_000n;
/** approvalMessage: "OSTRA/APPROVE/EVM/v1" (20) || chain ID (32) || pool (20) || key (32) || batch (u64) || state (32) || next key root (32). */
const APPROVE_MESSAGE_LEN = 20 + 32 + 20 + 32 + 8 + 32 + 32;
/** Leaf keys per leaf set: leaf j of attempt a is leaf key a * LEAF_KEYS_PER_ATTEMPT + j (a deposit holds at most MAX_LEAVES_PER_BATCH leaves). */
export const LEAF_KEYS_PER_ATTEMPT = 256;
/** Batches the sweep reads per deposit to check that its leaf set is not public (see the header); the rest wait for the next sweep. */
const LEAF_SCAN_BATCHES = 32n;

export type ShieldStatus =
  /** The record exists; the depositor key may already hold the tokens. */
  | "funding"
  /** The deposit is on-chain and pending: waiting for a batch. */
  | "pending"
  /** The batch is sealed: the leaves are in the pool; the deposit is being closed. */
  | "sealed"
  /** No batch took it in time: cancelled, its tokens back in the vault. */
  | "refunding"
  /** Done: sealed and closed (the leaves are in the pool), or refunded to the vault. */
  | "closed";

export type ShieldRecord = {
  version: 1;
  chainId: number;
  token: string;
  index: number;
  /** The vault the deposit is funded from and refunds to; absent on records made before 18 Oct 2026 (the buyer vault's). */
  vault?: string;
  depositor: string;
  /** The deposit key (OstraPool.depositKey of the depositor and the deposit id). */
  deposit: string;
  leaves: number;
  /** Deposit amount in base units: the leaves plus the pool fee. */
  amount: string;
  status: ShieldStatus;
  /** The leaf set the deposit offers (see the header); absent on records made before 19 Oct 2026, which are attempt 0. */
  attempt?: number;
  /** The first batch (decimal) that may hold the current leaf set and is not yet known to be over without it; absent until the set is first sent. */
  leafScanFrom?: string;
  /** Every aggregator account this deposit's leaves were sent to: their batches all count in the check that a leaf set is not public. */
  aggregators?: string[];
  /** True once the aggregator accepted the leaves. */
  registered: boolean;
  /** The sealed batch and where this deposit's leaves are in it (in leaf order). */
  batch: string | null;
  leafIndexes: number[] | null;
  /** True when the deposit was refunded instead of sealed. */
  refunded: boolean;
  createdAt: number;
  closedAt: number | null;
};

export type ShieldResult = {
  index: number;
  deposit: string;
  depositor: string;
  leaves: number;
  amount: string;
  status: ShieldStatus;
  aggregator: AggregatorDepositView | { status: "unreachable"; error: string };
  note: string;
};

export type ShieldView = {
  index: number;
  /** The vault it was shielded from (null: the buyer vault, on records made before 18 Oct 2026). */
  vault: string | null;
  deposit: string;
  leaves: number;
  amount: string;
  status: ShieldStatus;
  batch: string | null;
  /** The deposit's leaves in the pool, once sealed (`key`: the leaf key index): spent ones are gone from the pool. */
  leavesInPool: { batch: string; leafIndex: number; key: number; amount: string; spent: boolean }[];
};

/** Auto-shield of a vault (see the header). */
export type AutoShieldSetting = { vault: Address; enabled: boolean; keep: string };

/** The leaf key of leaf j of leaf set `attempt`. */
export function leafKeyIndex(attempt: number, j: number): number {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= MAX_LEAF_ATTEMPTS) throw new RangeError(`leaf set ${String(attempt)} is out of range`);
  if (!Number.isInteger(j) || j < 0 || j >= LEAF_KEYS_PER_ATTEMPT) throw new RangeError(`leaf ${String(j)} is out of range`);
  return attempt * LEAF_KEYS_PER_ATTEMPT + j;
}

function recordName(chainId: number, token: string, index: number): string {
  return `${chainId}-${getAddress(token)}-${index}.json`;
}

/** Reads a signed approval message back into its parts (sdk approvalMessage); throws unless it re-encodes to the same bytes. */
export function decodeApproveMessage(message: Uint8Array): { chainId: number; pool: Address; key: Hex; batchId: bigint; state: Hex; nextKeyRoot: Hex } {
  if (message.length !== APPROVE_MESSAGE_LEN) throw new Error("not an approval message");
  const chainId = Number(BigInt(bytesToHex(message.subarray(20, 52))));
  const pool = getAddress(bytesToHex(message.subarray(52, 72)));
  const key = bytesToHex(message.subarray(72, 104));
  const batchId = BigInt(bytesToHex(message.subarray(104, 112)));
  const state = bytesToHex(message.subarray(112, 144));
  const nextKeyRoot = bytesToHex(message.subarray(144, 176));
  const again = approvalMessage({ chainId, pool, key, batchId, state, nextKeyRoot });
  if (again.length !== message.length || !again.every((x, i) => x === message[i])) throw new Error("not an approval message");
  return { chainId, pool, key, batchId, state, nextKeyRoot };
}

export class ShieldService {
  readonly #client: PublicClient;
  readonly #config: Config;
  readonly #keys: Keys;
  readonly #vault: VaultService;
  readonly #sender: Sender;
  readonly #folder: Folder;
  #queue: Promise<unknown> = Promise.resolve();

  /** `keys`: the agent's own keys (its records go to the `shield` folder in the agent's folder). */
  constructor(client: PublicClient, config: Config, keys: Keys, vault: VaultService, sender: Sender) {
    this.#client = client;
    this.#config = config;
    this.#keys = keys;
    this.#vault = vault;
    this.#sender = sender;
    this.#folder = keys.folder.folder(SHIELD_DIR);
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #token(): Address {
    return this.#config.deployment.token;
  }

  #pool(): Address {
    return this.#config.deployment.pool;
  }

  // ---------------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------------

  async #records(): Promise<ShieldRecord[]> {
    await this.#folder.ensure();
    const prefix = `${this.#config.chainId}-${this.#token()}-`;
    const out: ShieldRecord[] = [];
    for (const name of await this.#folder.list()) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      const text = await this.#folder.read(name);
      if (text !== undefined) out.push(JSON.parse(text) as ShieldRecord);
    }
    return out.sort((a, b) => a.index - b.index);
  }

  async #save(record: ShieldRecord): Promise<void> {
    await this.#folder.ensure();
    await this.#folder.write(recordName(record.chainId, record.token, record.index), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** True when `record` belongs to this service's vault. */
  async #mine(record: ShieldRecord): Promise<boolean> {
    if (record.vault === undefined) return this.#vault.kind === "buyer";
    return getAddress(record.vault) === (await this.#vault.vaultAddress());
  }

  /** A new record under the first free deposit number (created exclusively: another vault's service may be creating one too). */
  async #createRecord(make: (index: number) => ShieldRecord): Promise<ShieldRecord> {
    await this.#folder.ensure();
    for (let attempt = 0; attempt < 8; attempt++) {
      const index = (await this.#records()).reduce((n, r) => Math.max(n, r.index + 1), 0);
      const record = make(index);
      try {
        await this.#folder.create(recordName(record.chainId, record.token, record.index), `${JSON.stringify(record, null, 2)}\n`);
        return record;
      } catch (err) {
        if ((await this.#folder.read(recordName(record.chainId, record.token, record.index))) === undefined) throw err;
      }
    }
    throw new Error("could not take a free shield deposit number");
  }

  async #autoShieldName(): Promise<string> {
    return `auto-shield-${this.#config.chainId}-${this.#token()}-${await this.#vault.vaultAddress()}.json`;
  }

  /** This vault's auto-shield setting (off unless set). */
  autoShield(): Promise<AutoShieldSetting> {
    return this.#serial(() => this.#autoShieldSetting());
  }

  async #autoShieldSetting(): Promise<AutoShieldSetting> {
    const vault = await this.#vault.vaultAddress();
    const text = await this.#folder.read(await this.#autoShieldName());
    if (text === undefined) return { vault, enabled: false, keep: formatTokenAmount(RELAYER_CHANNEL_DEPOSIT) };
    const r = JSON.parse(text) as { enabled?: unknown; keep?: unknown };
    if (typeof r.enabled !== "boolean" || typeof r.keep !== "string") throw new Error(`${await this.#autoShieldName()} is not an auto-shield setting`);
    return { vault, enabled: r.enabled, keep: formatTokenAmount(parseTokenAmount(r.keep)) };
  }

  /** Turns auto-shield of this vault on or off; `keep` (tokens, default RELAYER_CHANNEL_DEPOSIT) stays in the vault. */
  setAutoShield(enabled: boolean, keep?: string): Promise<AutoShieldSetting> {
    return this.#serial(async () => {
      if (enabled) this.#aggregatorUrl();
      const kept = keep === undefined ? RELAYER_CHANNEL_DEPOSIT : parseTokenAmount(keep);
      if (kept < 0n) throw new RangeError("keep must not be negative");
      await this.#folder.ensure();
      await this.#folder.write(await this.#autoShieldName(), `${JSON.stringify({ enabled, keep: formatTokenAmount(kept) })}\n`);
      return this.#autoShieldSetting();
    });
  }

  /**
   * One auto-shield step (in the sweep): the leaves the vault's balance above
   * `keep` pays for, within the pool's largest deposit and total. Null when
   * it is off, nothing is due, or an earlier deposit of the vault is still
   * being funded.
   */
  async #autoShieldStep(): Promise<ShieldResult | null> {
    const setting = await this.#autoShieldSetting();
    if (!setting.enabled) return null;
    for (const r of await this.#records()) if (r.status === "funding" && (await this.#mine(r))) return null;
    const status = await this.#vault.status();
    if (!status.vaultExists) return null;
    const p = await readPool(this.#client, this.#pool());
    if (p.maxDeposit === 0n) return null;
    const vault = await this.#vault.vaultAddress();
    const available = (await tokenBalance(this.#client, this.#token(), vault)) - parseTokenAmount(setting.keep);
    const room = await this.#room(p.maxTotal);
    const most = maxLeavesPerDeposit(p.maxDeposit, p.feeBps);
    let leaves = 0;
    while (leaves < most && depositForLeaves(leaves + 1, p.feeBps) <= available && depositForLeaves(leaves + 1, p.feeBps) <= room) leaves += 1;
    if (leaves === 0) return null;
    return this.#shieldLocked(leaves);
  }

  #signer(record: ShieldRecord): PrivateKeyAccount {
    return this.#keys.shieldSigner(this.#config.chainId, this.#token(), BigInt(record.index));
  }

  #leafKeys(record: ShieldRecord): WotsKeychain {
    return this.#keys.shieldLeafKeychain(this.#config.chainId, this.#token(), BigInt(record.index));
  }

  #approvalKeys(record: ShieldRecord): WotsKeychain {
    return this.#keys.shieldApprovalKeychain(this.#config.chainId, this.#token(), BigInt(record.index));
  }

  /** The deposit's leaves in leaf set `attempt` (default: the record's): standard leaves, leaf j with leaf key attempt * LEAF_KEYS_PER_ATTEMPT + j. */
  #leaves(record: ShieldRecord, attempt = record.attempt ?? 0): Leaf[] {
    const keys = this.#leafKeys(record);
    return Array.from({ length: record.leaves }, (_, j) => ({ keyRoot: keys.keyRoot(BigInt(leafKeyIndex(attempt, j))), amount: LEAF_DENOMINATION }));
  }

  #readDeposit(record: ShieldRecord): Promise<DepositState> {
    return readDeposit(this.#client, this.#pool(), record.deposit as Hex);
  }

  // ---------------------------------------------------------------------------
  // Aggregator
  // ---------------------------------------------------------------------------

  #aggregatorUrl(): string {
    if (this.#config.aggregatorUrl === null) throw new Error("shield needs the Ostra aggregator: set OSTRA_AGGREGATOR_URL");
    return this.#config.aggregatorUrl;
  }

  async #aggregator(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.#aggregatorUrl()}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(AGGREGATOR_TIMEOUT_MS),
    });
    let parsed: Record<string, unknown>;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error(`the aggregator answered ${res.status} without JSON`);
    }
    if (!res.ok) throw new Error(`the aggregator refused (${res.status} ${String(parsed.error)}): ${String(parsed.message)}`);
    return parsed;
  }

  /** Sends the deposit's current leaf set, signed by the depositor key; a "rekey" answer moves to the leaf set asked for and sends that. */
  async #register(record: ShieldRecord): Promise<AggregatorDepositView> {
    // The depositor and deposit id let the aggregator check the deposit key without reading event logs.
    const depositId = this.#keys.shieldDepositId(this.#config.chainId, this.#token(), BigInt(record.index));
    const signer = this.#signer(record);
    for (let round = 0; round < 2; round++) {
      const attempt = record.attempt ?? 0;
      const leaves = this.#leaves(record);
      if (record.leafScanFrom === undefined) {
        // No batch created before the set is first sent can hold it: the aggregator learns it from this request.
        // A record sent before leafScanFrom existed (registered, without it) is checked from the first batch.
        record.leafScanFrom = record.registered ? "0" : (await readPool(this.#client, this.#pool())).batchCount.toString();
        await this.#save(record);
      }
      const signature = await signAggregatorLeaves(signer, { chainId: this.#config.chainId, pool: this.#pool(), deposit: record.deposit as Hex, attempt }, leaves);
      const view = (await this.#aggregator("POST", "/v1/deposits", { deposit: record.deposit, depositor: signer.address, depositId, attempt, leaves: leaves.map(leafToWire), signature })) as AggregatorDepositView;
      if (view.status === "rekey") {
        await this.#rekey(record, view.attempt);
        continue;
      }
      if (!record.registered) {
        record.registered = true;
        await this.#save(record);
      }
      return view;
    }
    throw new Error("the aggregator asked for a new leaf set twice in a row");
  }

  /** Moves the deposit to leaf set `attempt`: only forward, so a leaf set once offered is never offered again. */
  async #rekey(record: ShieldRecord, attempt: number): Promise<void> {
    const current = record.attempt ?? 0;
    if (!Number.isInteger(attempt) || attempt <= current || attempt >= MAX_LEAF_ATTEMPTS) {
      throw new Error(`the aggregator asked for leaf set ${String(attempt)}; this deposit is at ${current} (at most ${MAX_LEAF_ATTEMPTS - 1})`);
    }
    record.attempt = attempt;
    record.registered = false;
    delete record.leafScanFrom;
    await this.#save(record);
  }

  /**
   * Moves to the next leaf set when a batch of the aggregator other than its
   * current open batch holds a leaf of the current set (closed, sealed while
   * this deposit is still pending, or left open): that set is public. The
   * current open batch is read again next time; every other batch is passed
   * for good, as the aggregator appends only to its current open batch (a
   * batch of another account never counts: anyone may copy public leaves
   * into one).
   */
  async #retireIfPublished(record: ShieldRecord): Promise<void> {
    if (record.leafScanFrom === undefined) {
      // A record sent before leafScanFrom existed is checked from the first batch; one never sent has nothing to check.
      if (!record.registered) return;
      record.leafScanFrom = "0";
    }
    // The batch count first: a batch created after it is not read now, and one created before it is the
    // aggregator's current batch in the health read after it, unless it is over already.
    const { batchCount } = await readPool(this.#client, this.#pool());
    const health = await this.#aggregator("GET", "/v1/health");
    if (typeof health.aggregator !== "string") throw new Error("the aggregator's health names no aggregator account");
    const aggregator = getAddress(health.aggregator);
    // An aggregator that changed its account (and with it, its state) must not hide the old account's batches.
    const accounts = new Set([...(record.aggregators ?? []).map((a) => getAddress(a)), aggregator]);
    if (accounts.size !== (record.aggregators ?? []).length) {
      record.aggregators = [...accounts];
      await this.#save(record);
    }
    const open = health.open as { batch?: unknown } | null;
    const current = open !== null && typeof open === "object" && typeof open.batch === "string" ? BigInt(open.batch) : null;
    const mine = new Set(this.#leaves(record).map((l) => `0x${toHex(l.keyRoot)}`));
    const from = BigInt(record.leafScanFrom);
    let next = from;
    for (let id = from; id < batchCount && id < from + LEAF_SCAN_BATCHES; id++) {
      const b = await readBatch(this.#client, this.#pool(), id);
      if (!accounts.has(b.aggregator)) {
        if (next === id) next = id + 1n;
        continue;
      }
      const holds = b.leaves.some((l) => mine.has(l.keyRoot.toLowerCase()));
      const isCurrent = b.aggregator === aggregator && b.status === "open" && id === current;
      // The aggregator appends only to the batch it has saved as its open batch.
      if (holds && !isCurrent) {
        await this.#rekey(record, (record.attempt ?? 0) + 1);
        return;
      }
      // The aggregator's current open batch may still get this set's leaves: it is read again next time.
      if (!isCurrent && next === id) next = id + 1n;
    }
    if (next !== from) {
      record.leafScanFrom = next.toString();
      await this.#save(record);
    }
  }

  async #poll(record: ShieldRecord): Promise<AggregatorDepositView> {
    const at = BigInt(Math.floor(Date.now() / 1000));
    const signature = await signAggregatorPoll(this.#signer(record), { chainId: this.#config.chainId, pool: this.#pool(), deposit: record.deposit as Hex }, at);
    return (await this.#aggregator("GET", `/v1/deposits/${record.deposit}?at=${at}&signature=${signature}`)) as AggregatorDepositView;
  }

  // ---------------------------------------------------------------------------
  // shield
  // ---------------------------------------------------------------------------

  /** Puts `leaves` standard leaves of the vault's tokens into the shielded pool. */
  shield(leaves: number): Promise<ShieldResult> {
    return this.#serial(() => this.#shieldLocked(leaves));
  }

  async #shieldLocked(leaves: number): Promise<ShieldResult> {
    this.#aggregatorUrl();
    if (!Number.isInteger(leaves) || leaves < 1) throw new RangeError("leaves must be a positive whole number");
    if (leaves > LEAF_KEYS_PER_ATTEMPT) throw new RangeError(`one deposit holds at most ${LEAF_KEYS_PER_ATTEMPT} leaves`);
    const pool = this.#pool();
    const p = await readPool(this.#client, pool);
    if (p.token !== this.#token()) throw new Error(`the pool ${pool} holds ${p.token}, not ${this.#token()}`);
    if (p.maxDeposit === 0n) throw new Error("the pool does not accept deposits (no deposit limit)");
    const most = maxLeavesPerDeposit(p.maxDeposit, p.feeBps);
    if (leaves > most) throw new RangeError(`one deposit holds at most ${most} leaves (the pool's largest deposit is ${formatTokenAmount(p.maxDeposit)})`);
    const amount = depositForLeaves(leaves, p.feeBps);
    // The pool counts every token it holds against maxTotal: a deposit it has no room for would revert after the
    // vault funded the depositor key, so it is refused here, before anything is signed or moved.
    const room = await this.#room(p.maxTotal);
    if (amount > room) throw new RangeError(`the pool has room for ${formatTokenAmount(room)} more, and a deposit of ${leaves} leaves is ${formatTokenAmount(amount)}; nothing was signed`);
    const terms = await this.#aggregator("GET", "/v1/terms");
    if (terms.chainId !== this.#config.chainId || typeof terms.pool !== "string" || getAddress(terms.pool) !== pool || typeof terms.token !== "string" || getAddress(terms.token) !== this.#token()) {
      throw new Error(`the aggregator serves pool ${String(terms.pool)} on chain ${String(terms.chainId)}, not ${pool} on ${this.#config.chainId}`);
    }
    if (typeof terms.aggregator !== "string") throw new Error("the aggregator's terms name no aggregator account");
    const aggregatorAccount = getAddress(terms.aggregator);
    const status = await this.#vault.status();
    if (!status.vaultExists) throw new Error("open the vault and fund it first (open_vault)");

    const vault = await this.#vault.vaultAddress();
    // The record comes first: whatever happens next, the sweep finds the depositor key again.
    const record = await this.#createRecord((index) => {
      const signer = this.#keys.shieldSigner(this.#config.chainId, this.#token(), BigInt(index));
      return {
        version: 1,
        chainId: this.#config.chainId,
        token: this.#token(),
        index,
        vault,
        depositor: signer.address,
        deposit: depositKey(signer.address, this.#keys.shieldDepositId(this.#config.chainId, this.#token(), BigInt(index))),
        leaves,
        amount: amount.toString(),
        status: "funding",
        registered: false,
        batch: null,
        leafIndexes: null,
        refunded: false,
        aggregators: [aggregatorAccount],
        createdAt: Math.floor(Date.now() / 1000),
        closedAt: null,
      };
    });
    const { index, depositor, deposit: key } = record;
    await this.#fundAndDeposit(record);
    let view: ShieldResult["aggregator"];
    try {
      await this.#register(record);
      view = await this.#poll(record);
    } catch (err) {
      view = { status: "unreachable", error: (err as Error).message };
    }
    return {
      index,
      deposit: key,
      depositor,
      leaves,
      amount: formatTokenAmount(amount),
      status: record.status,
      aggregator: view,
      note:
        "the deposit waits for a batch of at least 8 deposits; this server approves the batch when it is ready (every 5 minutes it checks), " +
        "and a deposit no batch took within 48 hours is refunded in full to the vault",
    };
  }

  /** What the pool can still take under its total limit: maxTotal less every token it holds (OstraPool._recordDeposit). */
  async #room(maxTotal: bigint): Promise<bigint> {
    const held = await tokenBalance(this.#client, this.#token(), this.#pool());
    return held >= maxTotal ? 0n : maxTotal - held;
  }

  /**
   * Steps 1 and 2: the depositor key gets the tokens from the vault, then the deposit is submitted with its EIP-3009 authorization.
   * Neither step runs while the pool has no room for the deposit: nothing leaves the vault, and tokens the key already holds
   * wait there; the sweep tries again.
   */
  async #fundAndDeposit(record: ShieldRecord): Promise<void> {
    const signer = this.#signer(record);
    const amount = BigInt(record.amount);
    if ((await this.#readDeposit(record)).status === "none") {
      const room = await this.#room((await readPool(this.#client, this.#pool())).maxTotal);
      if (amount > room) throw new Error(`the pool has room for ${formatTokenAmount(room)} more, and deposit ${record.index} is ${formatTokenAmount(amount)}; it waits until there is room`);
      const held = await tokenBalance(this.#client, this.#token(), signer.address);
      if (held < amount) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const r = await this.#vault.withdraw(signer.address, formatTokenAmount(amount - held));
          if (r.status === "sent") break;
          // An earlier vault operation that had not landed was sent instead: once more for this one.
          if (attempt === 1) throw new Error("the vault sent an earlier pending operation twice; call shield again");
        }
      }
      await this.#vault.requireEth(DEPOSIT_GAS, "submit the shield deposit", this.#sender);
      const index = BigInt(record.index);
      const deposit = {
        depositor: signer.address,
        depositId: this.#keys.shieldDepositId(this.#config.chainId, this.#token(), index),
        amount,
        refundOwner: await this.#vault.vaultAddress(),
        approvalKeyRoot: bytesToHex(this.#approvalKeys(record).keyRoot(0n)),
      };
      if (depositKey(deposit.depositor, deposit.depositId) !== record.deposit) throw new Error("the deposit key does not match the record");
      const validAfter = 0n;
      const validBefore = (await chainTime(this.#client)) + AUTHORIZATION_TTL_SECONDS;
      const signature = await signer.signTypedData(depositAuthorizationTypedData({ ...deposit, chainId: this.#config.chainId, pool: this.#pool(), validAfter, validBefore }));
      const { v, yParity, r, s } = parseSignature(signature);
      const data = encodeFunctionData({
        abi: ostraPoolAbi,
        functionName: "depositWithAuthorization",
        args: [deposit.depositor, deposit.depositId, deposit.amount, deposit.refundOwner, deposit.approvalKeyRoot, validAfter, validBefore, v === undefined ? yParity + 27 : Number(v), r, s],
      });
      await this.#sender.send([{ to: this.#pool(), data }]);
    }
    record.status = "pending";
    await this.#save(record);
  }

  // ---------------------------------------------------------------------------
  // The sweep
  // ---------------------------------------------------------------------------

  /**
   * Moves every shield deposit of this vault on: registers, polls, approves,
   * closes, cancels; then the auto-shield step. Returns one message per
   * deposit (or auto-shield) that failed.
   */
  sweep(): Promise<string[]> {
    return this.#serial(async () => {
      const failures: string[] = [];
      if (this.#config.aggregatorUrl === null) return failures;
      for (const record of await this.#records()) {
        if (record.status === "closed" || !(await this.#mine(record))) continue;
        try {
          await this.#advance(record);
        } catch (err) {
          failures.push(`shield deposit ${record.index}: ${(err as Error).message}`);
        }
      }
      try {
        await this.#autoShieldStep();
      } catch (err) {
        failures.push(`auto-shield: ${(err as Error).message}`);
      }
      return failures;
    });
  }

  async #advance(record: ShieldRecord): Promise<void> {
    if (record.status === "funding") await this.#fundAndDeposit(record);
    if (record.status === "pending") {
      const d = await this.#readDeposit(record);
      if (d.status === "consumed" || d.status === "closed") await this.#sealed(record, d);
      else if (d.status === "cancelled") {
        record.status = "refunding";
        record.refunded = true;
        await this.#save(record);
      } else if (d.status === "pending") await this.#waiting(record, d);
      else throw new Error(`deposit ${record.deposit} is not on-chain while pending`);
    }
    if (record.status === "sealed" || record.status === "refunding") await this.#closeOut(record);
  }

  /** A pending deposit: registered and polled; approves a ready batch; cancelled once DEPOSIT_TIMEOUT_SECONDS have passed. */
  async #waiting(record: ShieldRecord, d: DepositState): Promise<void> {
    if ((await chainTime(this.#client)) >= d.createdAt + DEPOSIT_TIMEOUT_SECONDS) {
      await this.#sender.send([{ to: this.#pool(), data: encodeFunctionData({ abi: ostraPoolAbi, functionName: "cancelDeposit", args: [record.deposit as Hex] }) }]);
      record.status = "refunding";
      record.refunded = true;
      await this.#save(record);
      return;
    }
    await this.#retireIfPublished(record);
    await this.#register(record);
    let view = await this.#poll(record);
    if (view.status === "rekey") {
      // A batch with this leaf set did not seal since the leaves were sent: the next set goes now.
      await this.#rekey(record, view.attempt);
      await this.#register(record);
      view = await this.#poll(record);
    }
    if (view.status !== "batched") return;
    await this.#approve(record, d, BigInt(view.batch), view.stateHash.toLowerCase() as Hex);
  }

  /**
   * approveBatch for `batchId` at `state`, only after checking on-chain that
   * the batch is complete, is at that state, holds only standard leaves, and
   * holds every leaf of this deposit. An approval signed earlier that never
   * landed is sent first: it rotates the key, and a signed approval always
   * lands (the pool never reads the batch in approveBatch).
   */
  async #approve(record: ShieldRecord, d: DepositState, batchId: bigint, state: Hex): Promise<void> {
    if (d.approvedBatch === batchId && d.approvedState !== null && d.approvedState.toLowerCase() === state) return;
    const b = await readBatch(this.#client, this.#pool(), batchId);
    if (b.status !== "open") return;
    if (b.leafCount !== b.capacity) return;
    if (batchStateOf(b).toLowerCase() !== state) throw new Error(`batch ${batchId} is not at the state the aggregator gave; not approved`);
    if (!batchLeavesStandard(b)) throw new Error(`batch ${batchId} holds a leaf that is not ${formatTokenAmount(LEAF_DENOMINATION)}; not approved`);
    if (!batchContainsLeaves(b, this.#leaves(record))) throw new Error(`batch ${batchId} does not hold every leaf of this deposit; not approved`);

    const keys = this.#approvalKeys(record);
    const approve = (a: { batchId: bigint; state: Hex; nextKeyRoot: Hex; signature: Hex }) => ({
      to: this.#pool(),
      data: encodeFunctionData({ abi: ostraPoolAbi, functionName: "approveBatch", args: [record.deposit as Hex, a.batchId, a.state, a.nextKeyRoot, a.signature] }),
    });
    let current = d;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Every approval this deposit ever signed moved its key one step; 64 batches abandoned is far more than a deposit sees.
      let index = -1n;
      for (let i = 0n; i < 64n; i++) {
        if (bytesToHex(keys.keyRoot(i)) === current.approvalKeyRoot.toLowerCase()) {
          index = i;
          break;
        }
      }
      if (index < 0n) throw new Error("the deposit's approval key is not one of this machine's");
      const stored = await keys.signed(index);
      if (stored !== undefined) {
        const earlier = decodeApproveMessage(hexToBytes(`0x${stored.message}`));
        if (earlier.batchId !== batchId || earlier.state.toLowerCase() !== state) {
          // That approval was signed and never landed: it goes first.
          await this.#sender.send([approve({ ...earlier, signature: `0x${stored.signature}` })]);
          const after = await this.#readDeposit(record);
          if (after.status !== "pending") return;
          current = after;
          continue;
        }
      }
      const signed = await signApproveBatch(keys, { index, currentKeyRoot: current.approvalKeyRoot }, { chainId: this.#config.chainId, pool: this.#pool(), key: record.deposit as Hex, batchId, state });
      await this.#sender.send([approve(signed)]);
      return;
    }
  }

  /**
   * The batch is sealed: where the leaves are, then the deposit closes. The
   * batch holds the leaf set the deposit approved it with, the record's own
   * unless the record moved on after approving: earlier sets are looked for too.
   */
  async #sealed(record: ShieldRecord, d: DepositState): Promise<void> {
    const batchId = d.approvedBatch;
    if (batchId === null) throw new Error("a consumed deposit without its batch");
    const b = await readBatch(this.#client, this.#pool(), batchId);
    if (b.status === "none") throw new Error(`the sealed batch ${batchId} is not on-chain`);
    for (let attempt = record.attempt ?? 0; attempt >= 0; attempt--) {
      const leaves = this.#leaves(record, attempt);
      const indexes = leaves.map((l) => b.leaves.findIndex((x) => x.keyRoot.toLowerCase() === `0x${toHex(l.keyRoot)}` && x.amount === l.amount));
      if (indexes.some((i) => i < 0)) continue;
      record.attempt = attempt;
      record.batch = batchId.toString();
      record.leafIndexes = indexes;
      record.status = "sealed";
      await this.#save(record);
      return;
    }
    throw new Error(`the sealed batch ${batchId} does not show every leaf of this deposit`);
  }

  /**
   * Step 4 (or the refund): closes a consumed deposit (closeDeposit marks it,
   * so no old approval can be replayed into it). A refunded deposit is back
   * in the vault already (the vault is its refund owner).
   */
  async #closeOut(record: ShieldRecord): Promise<void> {
    const d = await this.#readDeposit(record);
    if (d.status === "consumed") {
      await this.#sender.send([{ to: this.#pool(), data: encodeFunctionData({ abi: ostraPoolAbi, functionName: "closeDeposit", args: [record.deposit as Hex] }) }]);
    } else if (d.status === "pending") {
      throw new Error(`deposit ${record.deposit} is still pending`);
    }
    record.status = "closed";
    record.closedAt = Math.floor(Date.now() / 1000);
    await this.#save(record);
  }

  // ---------------------------------------------------------------------------
  // balance
  // ---------------------------------------------------------------------------

  /** Every shield deposit in this token (of every vault of the agent), with its leaves in the pool once sealed. */
  list(): Promise<ShieldView[]> {
    return this.#serial(async () => {
      const out: ShieldView[] = [];
      for (const r of await this.#records()) {
        const leavesInPool: ShieldView["leavesInPool"] = [];
        if (r.batch !== null && r.leafIndexes !== null) {
          const b = await readBatch(this.#client, this.#pool(), BigInt(r.batch));
          r.leafIndexes.forEach((i, j) => {
            const leaf = b.leaves[i];
            leavesInPool.push({ batch: r.batch as string, leafIndex: i, key: leafKeyIndex(r.attempt ?? 0, j), amount: formatTokenAmount(LEAF_DENOMINATION), spent: b.status === "none" || leaf === undefined || leaf.spent });
          });
        }
        out.push({ index: r.index, vault: r.vault === undefined ? null : getAddress(r.vault), deposit: r.deposit, leaves: r.leaves, amount: formatTokenAmount(BigInt(r.amount)), status: r.status, batch: r.batch, leavesInPool });
      }
      return out;
    });
  }
}
