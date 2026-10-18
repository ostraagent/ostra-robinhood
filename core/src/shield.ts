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
//      deposit commits to its leaves (standard 10-token leaves, one WOTS key
//      each) and names the vault as its refund owner;
//   3. the leaves go to the aggregator, and every sweep polls it with an
//      EIP-191 signature of the depositor key. Once the deposit is in a
//      complete batch whose leaves on-chain are all standard leaves and
//      include all of its own, at the state hash given, the deposit approves
//      that batch with its next approval key;
//   4. once the batch is sealed, the deposit is closed (closeDeposit marks it,
//      so an old approval can never be replayed into it). The leaves stay in
//      the pool until they are spent (unshield).
// A deposit no batch took within DEPOSIT_TIMEOUT_SECONDS (48 hours) is
// cancelled: the pool refunds it in full to the vault. Every key comes from
// the master seed, so the seed alone recovers every deposit and leaf.
//
// On Solana the depositor key was the refund owner and gave back the deposit
// rent and its token account at the end; an EVM chain has no rent, and with
// the vault as refund owner a refund lands in the vault directly, where the
// depositor key, which holds no ETH, could not move it on its own.
//
// Entries, in the agent's `shield` folder (on disk OSTRA_HOME/shield, 0700):
// <chain>-<token>-<index>.json, records without secrets.

import { bytesToHex, encodeFunctionData, getAddress, hexToBytes, parseSignature, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import {
  DEPOSIT_TIMEOUT_SECONDS,
  LEAF_DENOMINATION,
  approvalMessage,
  batchContainsLeaves,
  batchLeavesStandard,
  batchStateOf,
  depositAuthorizationTypedData,
  depositCommitment,
  depositForLeaves,
  depositKey,
  leafToWire,
  maxLeavesPerDeposit,
  ostraPoolAbi,
  readBatch,
  readDeposit,
  readPool,
  signAggregatorPoll,
  signApproveBatch,
  toHex,
  type AggregatorDepositView,
  type DepositState,
  type Leaf,
  type WotsKeychain,
} from "@ostraagent/sdk";
import { formatTokenAmount } from "./amount.ts";
import { chainTime, tokenBalance } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Keys } from "./keys.ts";
import type { Sender } from "./relay.ts";
import type { Folder } from "./storage.ts";
import type { VaultService } from "./vault.ts";

export const SHIELD_DIR = "shield";
/** How long one request to the aggregator may take. */
const AGGREGATOR_TIMEOUT_MS = 30_000;
/** How long a deposit authorization the depositor key signs stays valid (it is signed again when it ran out unsent). */
const AUTHORIZATION_TTL_SECONDS = 3_600n;
/** Gas of a relayed deposit, for the local fee payer's ETH check: depositWithAuthorization measured at 273,995 on the fork, rounded up. */
const DEPOSIT_GAS = 350_000n;
/** approvalMessage: "OSTRA/APPROVE/EVM/v1" (20) || chain ID (32) || pool (20) || key (32) || batch (u64) || state (32) || next key root (32). */
const APPROVE_MESSAGE_LEN = 20 + 32 + 20 + 32 + 8 + 32 + 32;

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
  depositor: string;
  /** The deposit key (OstraPool.depositKey of the depositor and the deposit id). */
  deposit: string;
  leaves: number;
  /** Deposit amount in base units: the leaves plus the pool fee. */
  amount: string;
  status: ShieldStatus;
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
  deposit: string;
  leaves: number;
  amount: string;
  status: ShieldStatus;
  batch: string | null;
  /** The deposit's leaves in the pool, once sealed: spent ones are gone from the pool. */
  leavesInPool: { batch: string; leafIndex: number; amount: string; spent: boolean }[];
};

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

  #signer(record: ShieldRecord): PrivateKeyAccount {
    return this.#keys.shieldSigner(this.#config.chainId, this.#token(), BigInt(record.index));
  }

  #leafKeys(record: ShieldRecord): WotsKeychain {
    return this.#keys.shieldLeafKeychain(this.#config.chainId, this.#token(), BigInt(record.index));
  }

  #approvalKeys(record: ShieldRecord): WotsKeychain {
    return this.#keys.shieldApprovalKeychain(this.#config.chainId, this.#token(), BigInt(record.index));
  }

  /** The deposit's leaves: standard leaves, leaf j with leaf key j. */
  #leaves(record: ShieldRecord): Leaf[] {
    const keys = this.#leafKeys(record);
    return Array.from({ length: record.leaves }, (_, j) => ({ keyRoot: keys.keyRoot(BigInt(j)), amount: LEAF_DENOMINATION }));
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

  async #register(record: ShieldRecord): Promise<void> {
    // The depositor and deposit id let the aggregator check the deposit key without reading event logs.
    const depositId = this.#keys.shieldDepositId(this.#config.chainId, this.#token(), BigInt(record.index));
    await this.#aggregator("POST", "/v1/deposits", { deposit: record.deposit, depositor: this.#signer(record).address, depositId, leaves: this.#leaves(record).map(leafToWire) });
    if (!record.registered) {
      record.registered = true;
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
    return this.#serial(async () => {
      this.#aggregatorUrl();
      if (!Number.isInteger(leaves) || leaves < 1) throw new RangeError("leaves must be a positive whole number");
      const pool = this.#pool();
      const p = await readPool(this.#client, pool);
      if (p.token !== this.#token()) throw new Error(`the pool ${pool} holds ${p.token}, not ${this.#token()}`);
      if (p.maxDeposit === 0n) throw new Error("the pool does not accept deposits (no deposit limit)");
      const most = maxLeavesPerDeposit(p.maxDeposit, p.feeBps);
      if (leaves > most) throw new RangeError(`one deposit holds at most ${most} leaves (the pool's largest deposit is ${formatTokenAmount(p.maxDeposit)})`);
      const terms = await this.#aggregator("GET", "/v1/terms");
      if (terms.chainId !== this.#config.chainId || typeof terms.pool !== "string" || getAddress(terms.pool) !== pool || typeof terms.token !== "string" || getAddress(terms.token) !== this.#token()) {
        throw new Error(`the aggregator serves pool ${String(terms.pool)} on chain ${String(terms.chainId)}, not ${pool} on ${this.#config.chainId}`);
      }
      const amount = depositForLeaves(leaves, p.feeBps);
      const status = await this.#vault.status();
      if (!status.vaultExists) throw new Error("open the vault and fund it first (open_vault)");

      const index = (await this.#records()).reduce((n, r) => Math.max(n, r.index + 1), 0);
      const signer = this.#keys.shieldSigner(this.#config.chainId, this.#token(), BigInt(index));
      const key = depositKey(signer.address, this.#keys.shieldDepositId(this.#config.chainId, this.#token(), BigInt(index)));
      const record: ShieldRecord = {
        version: 1,
        chainId: this.#config.chainId,
        token: this.#token(),
        index,
        depositor: signer.address,
        deposit: key,
        leaves,
        amount: amount.toString(),
        status: "funding",
        registered: false,
        batch: null,
        leafIndexes: null,
        refunded: false,
        createdAt: Math.floor(Date.now() / 1000),
        closedAt: null,
      };
      // The record comes first: whatever happens next, the sweep finds the depositor key again.
      await this.#save(record);
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
        depositor: signer.address,
        leaves,
        amount: formatTokenAmount(amount),
        status: record.status,
        aggregator: view,
        note:
          "the deposit waits for a batch of at least 8 deposits; this server approves the batch when it is ready (every 5 minutes it checks), " +
          "and a deposit no batch took within 48 hours is refunded in full to the vault",
      };
    });
  }

  /** Steps 1 and 2: the depositor key gets the tokens from the vault, then the deposit is submitted with its EIP-3009 authorization. */
  async #fundAndDeposit(record: ShieldRecord): Promise<void> {
    const signer = this.#signer(record);
    const amount = BigInt(record.amount);
    if ((await this.#readDeposit(record)).status === "none") {
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
        commitment: depositCommitment(this.#leaves(record)),
      };
      if (depositKey(deposit.depositor, deposit.depositId) !== record.deposit) throw new Error("the deposit key does not match the record");
      const validAfter = 0n;
      const validBefore = (await chainTime(this.#client)) + AUTHORIZATION_TTL_SECONDS;
      const signature = await signer.signTypedData(depositAuthorizationTypedData({ ...deposit, chainId: this.#config.chainId, pool: this.#pool(), validAfter, validBefore }));
      const { v, yParity, r, s } = parseSignature(signature);
      const data = encodeFunctionData({
        abi: ostraPoolAbi,
        functionName: "depositWithAuthorization",
        args: [deposit.depositor, deposit.depositId, deposit.amount, deposit.refundOwner, deposit.approvalKeyRoot, bytesToHex(deposit.commitment), validAfter, validBefore, v === undefined ? yParity + 27 : Number(v), r, s],
      });
      await this.#sender.send([{ to: this.#pool(), data }]);
    }
    record.status = "pending";
    await this.#save(record);
  }

  // ---------------------------------------------------------------------------
  // The sweep
  // ---------------------------------------------------------------------------

  /** Moves every shield deposit on: registers, polls, approves, closes, cancels. Returns one message per deposit that failed. */
  sweep(): Promise<string[]> {
    return this.#serial(async () => {
      const failures: string[] = [];
      if (this.#config.aggregatorUrl === null) return failures;
      for (const record of await this.#records()) {
        if (record.status === "closed") continue;
        try {
          await this.#advance(record);
        } catch (err) {
          failures.push(`shield deposit ${record.index}: ${(err as Error).message}`);
        }
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
    await this.#register(record);
    const view = await this.#poll(record);
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
      const stored = await this.#keys.store.load(keys.keychainId, index);
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

  /** The batch is sealed: where the leaves are, then the deposit closes. */
  async #sealed(record: ShieldRecord, d: DepositState): Promise<void> {
    const batchId = d.approvedBatch;
    if (batchId === null) throw new Error("a consumed deposit without its batch");
    const b = await readBatch(this.#client, this.#pool(), batchId);
    const leaves = this.#leaves(record);
    const indexes = leaves.map((l) => b.leaves.findIndex((x) => x.keyRoot.toLowerCase() === `0x${toHex(l.keyRoot)}` && x.amount === l.amount));
    if (b.status === "none" || indexes.some((i) => i < 0)) throw new Error(`the sealed batch ${batchId} does not show every leaf of this deposit`);
    record.batch = batchId.toString();
    record.leafIndexes = indexes;
    record.status = "sealed";
    await this.#save(record);
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

  /** Every shield deposit of this vault's token, with its leaves in the pool once sealed. */
  list(): Promise<ShieldView[]> {
    return this.#serial(async () => {
      const out: ShieldView[] = [];
      for (const r of await this.#records()) {
        const leavesInPool: ShieldView["leavesInPool"] = [];
        if (r.batch !== null && r.leafIndexes !== null) {
          const b = await readBatch(this.#client, this.#pool(), BigInt(r.batch));
          for (const i of r.leafIndexes) {
            const leaf = b.leaves[i];
            leavesInPool.push({ batch: r.batch, leafIndex: i, amount: formatTokenAmount(LEAF_DENOMINATION), spent: b.status === "none" || leaf === undefined || leaf.spent });
          }
        }
        out.push({ index: r.index, deposit: r.deposit, leaves: r.leaves, amount: formatTokenAmount(BigInt(r.amount)), status: r.status, batch: r.batch, leavesInPool });
      }
      return out;
    });
  }
}
