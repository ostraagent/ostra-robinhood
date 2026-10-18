// The aggregator (design v0.3, core service 5, decided 15 Oct 2026; on
// Robinhood Chain, design v0.4). It builds the shielded pool's batches:
//   * a depositor sends the leaves of its pending deposit (POST
//     /v1/deposits); they are accepted only if their LtHash is the deposit's
//     on-chain commitment and they add up to its amount after the pool fee;
//   * the deposit names its one-time depositor key and deposit id; their
//     deposit key (keccak(abi.encode(depositor, depositId)), as the pool
//     derives it) must be the deposit's, so no event log is read and any RPC
//     serves the aggregator, even one that limits eth_getLogs to 10 blocks;
//   * the depositor polls its deposit with an EIP-191 signature of that key;
//     only deposits polled within FRESH_SECONDS go into a batch;
//   * with at least MIN_ANONYMITY_DEPOSITS fresh deposits, it creates a batch
//     sized to their leaves, appends the leaves shuffled, and gives every
//     depositor the batch's state hash to approve;
//   * when every deposit approved, it seals the batch (the pool checks the
//     leaves against the commitments and charges the pool fee) and forgets
//     which leaves came from which deposit; a batch not approved by all within
//     APPROVAL_SECONDS is abandoned and built again without the deposits that
//     did not approve.
// On Solana a sealed batch whose leaves were all spent was then closed for its
// rent; an EVM batch has no rent, so it is left as it is.
//
// The aggregator key can never move pool funds; it can only delay a batch.

import { bytesToHex, decodeEventLog, getAddress, isAddress, keccak256, type Address, type Hex, type PrivateKeyAccount, type PublicClient, type TransactionReceipt } from "viem";
import {
  LEAF_DENOMINATION,
  MAX_LEAVES_PER_BATCH,
  batchStateOf,
  depositCommitment,
  depositKey,
  isStandardLeaf,
  leafFromWire,
  leafToWire,
  leavesStateHash,
  ostraPoolAbi,
  poolNetAmount,
  readBatch,
  readPool,
  toHex,
  verifyAggregatorPoll,
  type AggregatorDepositView,
  type BatchState,
  type Deployment,
  type DepositState,
  type Leaf,
} from "@ostraagent/sdk";
import { readDeposits, type Sender } from "./chain.ts";
import {
  APPROVAL_SECONDS,
  FRESH_SECONDS,
  LEAVES_PER_APPEND,
  MAX_DEPOSITS_PER_BATCH,
  MIN_ANONYMITY_DEPOSITS,
  PASS_INTERVAL_MS,
  type Config,
} from "./config.ts";
import { isFresh, selectDeposits, shuffle } from "./select.ts";
import type { AggregatorState, OpenBatch, StateStore } from "./store.ts";

/** An error the HTTP layer returns to the caller with `status` and `code`. */
export class AggregatorError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AggregatorError";
    this.status = status;
    this.code = code;
  }
}

export type PoolInfo = { pool: Address; token: Address; treasury: Address; feeBps: number };

export type Terms = {
  chainId: number;
  token: string;
  pool: string;
  aggregator: string;
  leafAmount: string;
  minDeposits: number;
  maxDepositsPerBatch: number;
  maxLeavesPerBatch: number;
  freshSeconds: number;
  approvalSeconds: number;
};

export type Health = {
  chainId: number;
  token: string;
  pool: string;
  aggregator: string;
  /** The aggregator account's ETH, in wei: it pays the gas of every batch. */
  aggregatorWei: string;
  queued: number;
  fresh: number;
  open: { batch: string | null; deposits: number; leaves: number; appended: number; approveBy: number | null } | null;
  lastPassAt: string | null;
  lastPassError: string | null;
};

export type AggregatorDeps = {
  client: PublicClient;
  config: Config;
  key: PrivateKeyAccount;
  sender: Sender;
  store: StateStore;
  now?: () => number;
  /** Removes secrets (the RPC URL) from text that is logged or returned. */
  redact?: (text: string) => string;
};

const DEPOSIT_KEY = /^0x[0-9a-fA-F]{64}$/;

function parseDepositKey(value: unknown): Hex {
  if (typeof value !== "string" || !DEPOSIT_KEY.test(value)) throw new AggregatorError(400, "invalid_request", "deposit must be a 32-byte deposit key in 0x hex");
  return value.toLowerCase() as Hex;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * The depositor of `deposit`, from the depositor and deposit id the request
 * names: the pool keeps no depositor, only the key derived from both, so the
 * pair is accepted only if it derives exactly that key.
 */
function parseDepositor(deposit: Hex, depositorValue: unknown, depositIdValue: unknown): Address {
  if (typeof depositorValue !== "string" || !isAddress(depositorValue, { strict: false })) {
    throw new AggregatorError(400, "invalid_request", "depositor must be an address in 0x hex");
  }
  if (typeof depositIdValue !== "string" || !BYTES32.test(depositIdValue)) throw new AggregatorError(400, "invalid_request", "depositId must be 32 bytes in 0x hex");
  const depositor = getAddress(depositorValue);
  if (depositKey(depositor, depositIdValue as Hex).toLowerCase() !== deposit) {
    throw new AggregatorError(400, "invalid_depositor", "the depositor and deposit id do not derive this deposit key");
  }
  return depositor;
}

const wireRoot = (keyRoot: string) => `0x${keyRoot}` as Hex;

export class Aggregator {
  readonly #client: PublicClient;
  readonly #deployment: Deployment;
  readonly #key: PrivateKeyAccount;
  readonly #sender: Sender;
  readonly #store: StateStore;
  readonly #state: AggregatorState;
  readonly #pool: PoolInfo;
  readonly #now: () => number;
  readonly #redact: (text: string) => string;
  #timer: NodeJS.Timeout | undefined;
  #passing: Promise<void> | undefined;
  #lastPassAt: number | null = null;
  #lastPassError: string | null = null;

  private constructor(deps: AggregatorDeps, state: AggregatorState, pool: PoolInfo) {
    this.#client = deps.client;
    this.#deployment = deps.config.deployment;
    this.#key = deps.key;
    this.#sender = deps.sender;
    this.#store = deps.store;
    this.#state = state;
    this.#pool = pool;
    this.#now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.#redact = deps.redact ?? ((text) => text);
  }

  /** Reads the deployment's pool (it must hold the deployment's token and accept deposits) and the saved state. */
  static async open(deps: AggregatorDeps): Promise<Aggregator> {
    const d = deps.config.deployment;
    const p = await readPool(deps.client, d.pool);
    if (p.token !== getAddress(d.token)) throw new Error(`the pool ${d.pool} holds ${p.token}, not the deployment's token ${d.token}`);
    if (p.maxDeposit === 0n) throw new Error(`the pool ${d.pool} has no deposit limits yet (setLimits)`);
    return new Aggregator(deps, await deps.store.load(), { pool: p.pool, token: p.token, treasury: p.treasury, feeBps: p.feeBps });
  }

  log(event: string, fields: Record<string, unknown> = {}): void {
    console.log(this.#redact(JSON.stringify({ at: new Date().toISOString(), event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
  }

  get aggregator(): Address {
    return this.#key.address;
  }

  /** A pass now, then every PASS_INTERVAL_MS. */
  run(): void {
    const tick = () => {
      void this.pass();
    };
    tick();
    this.#timer = setInterval(tick, PASS_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#passing;
  }

  /** One pass; a pass already running is waited for instead of starting another. */
  pass(): Promise<void> {
    if (this.#passing !== undefined) return this.#passing;
    this.#passing = this.#passOnce()
      .then(() => {
        this.#lastPassError = null;
      })
      .catch((err: unknown) => {
        this.#lastPassError = this.#redact(err instanceof Error ? err.message : String(err));
        this.log("pass_failed", { error: this.#lastPassError });
      })
      .finally(() => {
        this.#lastPassAt = this.#now();
        this.#passing = undefined;
      });
    return this.#passing;
  }

  #save(): Promise<void> {
    return this.#store.save(this.#state);
  }

  #send(functionName: "createBatch" | "appendLeaves" | "sealBatch" | "closeBatch", args: readonly unknown[]): Promise<TransactionReceipt> {
    return this.#sender.send({ address: this.#pool.pool, abi: ostraPoolAbi, functionName, args });
  }

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------

  /** POST /v1/deposits { deposit, leaves }: the leaves of a pending deposit. */
  async register(body: unknown): Promise<AggregatorDepositView> {
    if (typeof body !== "object" || body === null) throw new AggregatorError(400, "invalid_request", "the body must be an object");
    const { deposit: depositValue, depositor: depositorValue, depositId: depositIdValue, leaves: leavesValue } = body as Record<string, unknown>;
    const deposit = parseDepositKey(depositValue);
    const depositor = parseDepositor(deposit, depositorValue, depositIdValue);
    if (!Array.isArray(leavesValue) || leavesValue.length === 0 || leavesValue.length > MAX_LEAVES_PER_BATCH) {
      throw new AggregatorError(400, "invalid_leaves", `leaves must be a list of 1 to ${MAX_LEAVES_PER_BATCH} leaves`);
    }
    let leaves: Leaf[];
    try {
      leaves = leavesValue.map(leafFromWire);
    } catch (err) {
      throw new AggregatorError(400, "invalid_leaves", (err as Error).message);
    }
    if (!leaves.every((l) => isStandardLeaf(l.amount))) {
      throw new AggregatorError(400, "non_standard_leaf", `every leaf must be ${LEAF_DENOMINATION} base units, the pool's only leaf amount`);
    }
    if (new Set(leaves.map((l) => toHex(l.keyRoot))).size !== leaves.length) throw new AggregatorError(400, "duplicate_leaf", "every leaf of a deposit needs its own key root");
    if (this.#state.deposits[deposit] !== undefined || this.#state.open?.deposits.includes(deposit) === true) return this.#view(deposit);

    const [d] = (await readDeposits(this.#client, this.#pool.pool, [deposit])) as [DepositState];
    if (d.status === "none") throw new AggregatorError(404, "unknown_deposit", `${deposit} is not a deposit of the pool ${this.#pool.pool}`);
    if (d.status !== "pending") throw new AggregatorError(409, "deposit_not_pending", `${deposit} is already ${d.status}`);
    if (keccak256(bytesToHex(depositCommitment(leaves))) !== d.commitmentHash.toLowerCase()) {
      throw new AggregatorError(409, "commitment_mismatch", "the leaves do not match the deposit's commitment");
    }
    const total = leaves.reduce((s, l) => s + l.amount, 0n);
    const net = poolNetAmount(d.amount, this.#pool.feeBps);
    if (net !== total) throw new AggregatorError(409, "amount_mismatch", `the deposit nets ${net} after the pool fee; the leaves add up to ${total}`);
    // The chain was read without holding anything: another request may have registered it meanwhile.
    if (this.#state.deposits[deposit] === undefined && this.#state.open?.deposits.includes(deposit) !== true) {
      this.#state.deposits[deposit] = { deposit, depositor, leaves: leaves.map(leafToWire), queuedAt: this.#now(), polledAt: null, pollNotBefore: 0 };
      await this.#save();
      this.log("deposit_registered", { deposit, leaves: leaves.length });
    }
    return this.#view(deposit);
  }

  /** GET /v1/deposits/<deposit>?at=<unix seconds>&signature=<0x hex>: a signed poll by the deposit's depositor key. */
  async poll(depositValue: string | undefined, atValue: string | null, signatureValue: string | null): Promise<AggregatorDepositView> {
    const deposit = parseDepositKey(depositValue);
    if (atValue === null || !/^[0-9]{1,12}$/.test(atValue)) throw new AggregatorError(400, "invalid_request", "at must be unix seconds");
    if (signatureValue === null) throw new AggregatorError(400, "invalid_request", "signature is required");
    if (!/^0x[0-9a-fA-F]{130}$/.test(signatureValue)) throw new AggregatorError(400, "invalid_request", "signature must be 65 bytes of 0x hex");
    const at = Number(atValue);
    const record = this.#state.deposits[deposit];
    if (record === undefined) return this.#view(deposit);
    const target = { chainId: this.#deployment.chainId, pool: this.#pool.pool, deposit };
    if (!(await verifyAggregatorPoll(getAddress(record.depositor), target, BigInt(at), signatureValue as Hex))) {
      throw new AggregatorError(401, "bad_signature", "the poll is not signed by the deposit's depositor key");
    }
    // A poll counts from the time it was signed, never later than now, and
    // only after the deposit's last expired batch: replaying an old poll
    // cannot make a deposit fresh again.
    const polledAt = Math.min(at, this.#now());
    if (polledAt > record.pollNotBefore && (record.polledAt === null || polledAt > record.polledAt)) {
      record.polledAt = polledAt;
      await this.#save();
    }
    return this.#view(deposit);
  }

  #view(deposit: string): AggregatorDepositView {
    const open = this.#state.open;
    if (open !== null && open.deposits.includes(deposit)) {
      if (open.approveBy !== null && open.batch !== null) return { status: "batched", batch: open.batch, stateHash: open.stateHash, approveBy: open.approveBy };
    }
    const record = this.#state.deposits[deposit];
    if (record === undefined) return { status: "unknown" };
    return { status: "queued", leaves: record.leaves.length };
  }

  terms(): Terms {
    return {
      chainId: this.#deployment.chainId,
      token: this.#pool.token,
      pool: this.#pool.pool,
      aggregator: this.#key.address,
      leafAmount: LEAF_DENOMINATION.toString(),
      minDeposits: MIN_ANONYMITY_DEPOSITS,
      maxDepositsPerBatch: MAX_DEPOSITS_PER_BATCH,
      maxLeavesPerBatch: MAX_LEAVES_PER_BATCH,
      freshSeconds: FRESH_SECONDS,
      approvalSeconds: APPROVAL_SECONDS,
    };
  }

  async health(): Promise<Health> {
    const now = this.#now();
    const records = Object.values(this.#state.deposits);
    const open = this.#state.open;
    return {
      chainId: this.#deployment.chainId,
      token: this.#pool.token,
      pool: this.#pool.pool,
      aggregator: this.#key.address,
      aggregatorWei: (await this.#client.getBalance({ address: this.#key.address })).toString(),
      queued: records.length,
      fresh: records.filter((r) => isFresh(r, now)).length,
      open: open === null ? null : { batch: open.batch, deposits: open.deposits.length, leaves: open.leaves.length, appended: open.appended, approveBy: open.approveBy },
      lastPassAt: this.#lastPassAt === null ? null : new Date(this.#lastPassAt * 1000).toISOString(),
      lastPassError: this.#lastPassError,
    };
  }

  // ---------------------------------------------------------------------------
  // The pass
  // ---------------------------------------------------------------------------

  async #passOnce(): Promise<void> {
    if (this.#state.open !== null) await this.#advanceOpen(this.#state.open);
    if (this.#state.open === null) {
      await this.#dropGoneDeposits();
      await this.#buildBatch();
    }
  }

  /** Forgets deposits that are no longer pending in the pool (consumed, cancelled or closed). */
  async #dropGoneDeposits(): Promise<void> {
    const keys = Object.keys(this.#state.deposits) as Hex[];
    if (keys.length === 0) return;
    const deposits = await readDeposits(this.#client, this.#pool.pool, keys);
    let changed = false;
    for (const d of deposits) {
      if (d.status === "pending") continue;
      delete this.#state.deposits[d.key];
      changed = true;
      this.log("deposit_dropped", { deposit: d.key, reason: d.status === "none" ? "gone" : `not_pending_${d.status}` });
    }
    if (changed) await this.#save();
  }

  /** Builds a batch from the fresh deposits when there are at least MIN_ANONYMITY_DEPOSITS of them. */
  async #buildBatch(): Promise<void> {
    const now = this.#now();
    const picked = selectDeposits(Object.values(this.#state.deposits), now);
    if (picked === null) return;
    const { batchCount } = await readPool(this.#client, this.#pool.pool);
    const leaves = shuffle(picked.flatMap((r) => r.leaves));
    const open: OpenBatch = {
      batch: null,
      searchFrom: batchCount.toString(),
      deposits: picked.map((r) => r.deposit),
      leaves,
      appended: 0,
      stateHash: bytesToHex(leavesStateHash(leaves.map(leafFromWire))),
      approveBy: null,
      createdAt: now,
    };
    this.#state.open = open;
    await this.#save();
    this.log("batch_building", { deposits: open.deposits.length, leaves: leaves.length });
    await this.#advanceOpen(open);
  }

  /** True when `b` is this aggregator's batch for `open`. */
  #isOurs(open: OpenBatch, b: BatchState): boolean {
    return b.aggregator === this.#key.address && b.capacity === open.leaves.length;
  }

  /**
   * The id of the open batch, creating it when it does not exist yet. A batch
   * of this aggregator, empty, of this capacity, created since the batch was
   * built, is this one (createBatch landed but the id was not saved).
   */
  async #batchId(open: OpenBatch): Promise<bigint> {
    if (open.batch !== null) return BigInt(open.batch);
    const { batchCount } = await readPool(this.#client, this.#pool.pool);
    for (let id = BigInt(open.searchFrom); id < batchCount; id++) {
      const b = await readBatch(this.#client, this.#pool.pool, id);
      if (b.status === "open" && b.leafCount === 0 && this.#isOurs(open, b)) {
        open.batch = id.toString();
        await this.#save();
        return id;
      }
    }
    const receipt = await this.#send("createBatch", [open.leaves.length]);
    let created: bigint | undefined;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== this.#pool.pool) continue;
      try {
        const e = decodeEventLog({ abi: ostraPoolAbi, data: log.data, topics: log.topics });
        if (e.eventName === "BatchCreated" && getAddress(e.args.aggregator) === this.#key.address) created = e.args.batchId;
      } catch {
        // another event of the pool
      }
    }
    if (created === undefined) throw new Error(`createBatch ${receipt.transactionHash} has no BatchCreated event of this aggregator`);
    open.batch = created.toString();
    await this.#save();
    this.log("batch_created", { batch: open.batch, capacity: open.leaves.length, tx: receipt.transactionHash });
    return created;
  }

  /**
   * Moves the open batch on by one step: creates it, appends its leaves,
   * then seals it once every deposit approved or abandons it when the
   * approval time is over. Each step is checked on-chain first, so a pass
   * after a crash picks up where the last one stopped.
   */
  async #advanceOpen(open: OpenBatch): Promise<void> {
    const id = await this.#batchId(open);
    const b = await readBatch(this.#client, this.#pool.pool, id);
    if (!this.#isOurs(open, b)) {
      await this.#dropOpen(open, "not_this_batch");
      return;
    }
    if (b.status === "sealed") {
      await this.#finishSealed(open, null);
      return;
    }
    if (b.status === "closed") {
      // Abandoned on-chain, but the state was not saved after it: the deposits stay queued.
      await this.#dropOpen(open, "closed");
      return;
    }
    if (b.leafCount < open.leaves.length) {
      await this.#appendRest(open, id, b);
      return;
    }
    if (open.approveBy === null) {
      if (batchStateOf(b).toLowerCase() !== open.stateHash) {
        await this.#abandon(open, id, "state_mismatch", [], []);
        return;
      }
      open.approveBy = this.#now() + APPROVAL_SECONDS;
      await this.#save();
      this.log("batch_ready", { batch: open.batch, deposits: open.deposits.length, leaves: open.leaves.length, approveBy: open.approveBy });
      return;
    }
    const deposits = await readDeposits(this.#client, this.#pool.pool, open.deposits as Hex[]);
    const gone: string[] = [];
    const waiting: string[] = [];
    for (const d of deposits) {
      if (d.status !== "pending") gone.push(d.key);
      else if (d.approvedBatch !== id || d.approvedState === null || d.approvedState.toLowerCase() !== open.stateHash) waiting.push(d.key);
    }
    if (gone.length > 0) {
      await this.#abandon(open, id, "deposit_gone", waiting, gone);
      return;
    }
    if (waiting.length === 0) {
      await this.#seal(open, id);
      return;
    }
    if (this.#now() >= open.approveBy) await this.#abandon(open, id, "approval_expired", waiting, []);
  }

  /** Appends the leaves not yet on-chain, LEAVES_PER_APPEND per transaction. */
  async #appendRest(open: OpenBatch, id: bigint, b: BatchState): Promise<void> {
    // Leaves already on-chain must be the open batch's own, in its order.
    for (let i = 0; i < b.leafCount; i++) {
      const want = open.leaves[i];
      const have = b.leaves[i];
      if (want === undefined || have === undefined || have.keyRoot.toLowerCase() !== wireRoot(want.keyRoot) || have.amount.toString() !== want.amount) {
        await this.#abandon(open, id, "leaf_mismatch", [], []);
        return;
      }
    }
    let count = b.leafCount;
    while (count < open.leaves.length) {
      const chunk = open.leaves.slice(count, count + LEAVES_PER_APPEND);
      try {
        await this.#send("appendLeaves", [id, chunk.map((l) => wireRoot(l.keyRoot))]);
      } catch (err) {
        const now = await readBatch(this.#client, this.#pool.pool, id);
        if (now.leafCount !== count + chunk.length) throw err;
      }
      count += chunk.length;
      open.appended = count;
      await this.#save();
    }
    this.log("batch_appended", { batch: open.batch, leaves: count });
  }

  /** sealBatch with every deposit of the batch and its commitment; the pool fee goes to the treasury. */
  async #seal(open: OpenBatch, id: bigint): Promise<void> {
    const keys = open.deposits as Hex[];
    const commitments = keys.map((k) => {
      const record = this.#state.deposits[k];
      if (record === undefined) throw new Error(`deposit ${k} of the open batch has no record`);
      return bytesToHex(depositCommitment(record.leaves.map(leafFromWire)));
    });
    let tx: string | null = null;
    try {
      tx = (await this.#send("sealBatch", [id, keys, commitments])).transactionHash;
    } catch (err) {
      const now = await readBatch(this.#client, this.#pool.pool, id);
      if (now.status !== "sealed") throw err;
    }
    await this.#finishSealed(open, tx);
  }

  /** The batch is sealed: its deposits, and with them which leaf came from which deposit, are forgotten. */
  async #finishSealed(open: OpenBatch, tx: string | null): Promise<void> {
    for (const d of open.deposits) delete this.#state.deposits[d];
    this.#state.open = null;
    await this.#save();
    this.log("batch_sealed", { batch: open.batch, deposits: open.deposits.length, leaves: open.leaves.length, tx });
  }

  /**
   * Closes the unsealed batch (it can then never be sealed). Deposits that
   * did not approve go to the back of the queue and must poll again; deposits
   * that are gone are forgotten; the others stay queued as they were.
   */
  async #abandon(open: OpenBatch, id: bigint, reason: string, notApproved: string[], gone: string[]): Promise<void> {
    try {
      await this.#send("closeBatch", [id]);
    } catch (err) {
      if ((await readBatch(this.#client, this.#pool.pool, id)).status !== "closed") throw err;
    }
    const now = this.#now();
    for (const d of gone) delete this.#state.deposits[d];
    for (const d of notApproved) {
      const record = this.#state.deposits[d];
      if (record === undefined) continue;
      record.queuedAt = now;
      record.polledAt = null;
      record.pollNotBefore = now;
    }
    this.#state.open = null;
    await this.#save();
    this.log("batch_abandoned", { batch: open.batch, reason, notApproved: notApproved.length, gone: gone.length });
  }

  /** Forgets an open batch that is not (or no longer) this aggregator's open batch on-chain; its deposits stay queued. */
  async #dropOpen(open: OpenBatch, reason: string): Promise<void> {
    this.#state.open = null;
    await this.#save();
    this.log("batch_dropped", { batch: open.batch, reason });
  }
}
