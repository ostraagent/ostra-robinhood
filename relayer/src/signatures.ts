// The WOTS signature escrow (design: WOTS signatures in the browser, escrowed
// at the relayer; details decided 17 Oct 2026). Two signatures of one
// WOTS key over two different messages let anyone forge a third, and a web
// app whose browser data was wiped could sign again with a key whose first
// signature is still in flight. So before a relay request is simulated or
// sent, the relayer stores every WOTS signature in it:
//
//   OstraVault.spend       message rebuilt as the vault builds it, at the
//                          vault's on-chain nonce: "OSTRA/VAULT/EVM/v1" ||
//                          chainid || vault || nonce || nextKeyRoot || action
//                          || params (sdk vaultSpendMessage)
//   OstraPool.spendLeaf    "OSTRA/LEAF/EVM/v1" || chainid || pool || batchId ||
//                          leafIndex || destination || the pool's leafAmount
//   OstraPool.approveBatch "OSTRA/APPROVE/EVM/v1" || chainid || pool || key ||
//                          batchId || state || nextKeyRoot, all from the call
//
// keyed by the key root the relayer recovers itself (wotsRecoverKeyRoot), and
// only when that is the key root the chain holds now (read at the latest
// block), or, for a vault, the new key root of the guardian recovery waiting
// in its current round (its first spend finishes that recovery, OstraVault):
// any other signature can never pass the contract, so it is not
// stored and the request goes on to be refused by its simulation. A key root
// holds one message; a request signing another one with it is refused with
// the stored record, which the client sends again instead. GET
// /v1/signatures/<key root> returns that record.
//
// A record stays until the chain shows its key used: the vault's nonce or key
// root moved on, the deposit's approval key root changed or the deposit is no
// longer pending, the leaf was spent. The pruner reads that from the
// finalized block at or after the block the record was checked at.
// Signatures are not secret once sent, so nothing here is.
//
// The records are one JSON file in OSTRA_RELAYER_DATA, written atomically
// (temporary file, fsync, rename) under one lock, like the ledger.

import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { bytesToHex, getAddress, hexToBytes, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  DEPOSIT_STATUS,
  SPEND_PARAMS_LENGTHS,
  VAULT_ACTION,
  WOTS_SIGNATURE_LEN,
  approvalMessage,
  decodeSwapParams,
  leafMessage,
  ostraPoolAbi,
  ostraVaultAbi,
  vaultAddress,
  vaultSpendMessage,
  wotsRecoverKeyRoot,
  type Deployment,
  type VaultAction,
} from "@ostraagent/sdk";
import type { ParsedCall } from "./calls.ts";

/** Largest number of keys one multicall read covers (the Solana getMultipleAccounts limit, kept). */
const MAX_KEYS_PER_READ = 100;
/** Time between two prunes: 10 minutes (the Solana sweep period, kept; decided 17 Oct 2026). */
export const PRUNE_SWEEP_MS = 600_000;

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export type WotsKind = "vault" | "approval" | "leaf";

/** A WOTS signature in a request, with what its message is built from. */
export type WotsClaim = (
  | { kind: "vault"; account: Address; nextKeyRoot: Hex; action: VaultAction; params: Hex }
  | { kind: "approval"; account: Address; key: Hex; batchId: bigint; state: Hex; nextKeyRoot: Hex }
  | { kind: "leaf"; account: Address; batchId: bigint; leafIndex: number; destination: Address }
) & { call: { to: Address; data: Hex }; signature: Hex };

/** The on-chain key a claim must be signed with now. */
export type KeyState =
  /** recoveryKeyRoot: the new key root of a recovery waiting in the vault's current round, which may sign too. */
  | { kind: "vault"; keyRoot: Hex; nonce: bigint; recoveryKeyRoot?: Hex }
  | { kind: "approval"; keyRoot: Hex; pending: boolean }
  | { kind: "leaf"; keyRoot: Hex; leafAmount: bigint; spent: boolean };

/** An escrowed signature: enough to send the signed call again. Bytes are 0x hex. */
export type SignatureRecord = {
  keyRoot: string;
  kind: WotsKind;
  /** The vault (vault) or the pool (approval, leaf). */
  account: string;
  /** The vault's nonce the spend was checked at. */
  nonce?: string;
  /** The deposit key (approval). */
  depositKey?: string;
  batchId?: string;
  leafIndex?: number;
  message: string;
  signature: string;
  /** The call that carries the signature, as the request had it. */
  call: { to: string; data: string };
  /** The block whose state showed this key current. */
  block: string;
  at: number;
};

const lower = (h: string) => h.toLowerCase();

/**
 * The WOTS signatures in a request's calls: OstraVault spends (on any
 * address: the chain read decides whether it is an Ostra vault), and leaf
 * spends and approvals sent to the deployment's pool. Throws for a malformed
 * one.
 */
export function wotsClaims(parsed: readonly ParsedCall[], calls: readonly { to: Address; data: Hex }[], d: Deployment): WotsClaim[] {
  const out: WotsClaim[] = [];
  parsed.forEach((c, i) => {
    const call = calls[i] as { to: Address; data: Hex };
    const sig = (signature: Hex, what: string) => {
      if ((signature.length - 2) / 2 !== WOTS_SIGNATURE_LEN) throw new Error(`calls[${i}]: the ${what} signature is not ${WOTS_SIGNATURE_LEN} bytes`);
      return signature;
    };
    if (c.fn === "spend") {
      const lengths = SPEND_PARAMS_LENGTHS[c.action as VaultAction];
      if (lengths === undefined) throw new Error(`calls[${i}]: unknown vault action ${c.action}`);
      if (!lengths.includes((c.params.length - 2) / 2)) throw new Error(`calls[${i}]: action ${c.action} params must be ${lengths.join(" or ")} bytes`);
      // A referred Swap whose referrer word the vault would refuse could never land: refuse it before escrow.
      if (c.action === VAULT_ACTION.SWAP) {
        try {
          decodeSwapParams(c.params);
        } catch (err) {
          throw new Error(`calls[${i}]: malformed Swap params: ${(err as Error).message}`);
        }
      }
      out.push({ kind: "vault", account: c.to, nextKeyRoot: c.nextKeyRoot, action: c.action as VaultAction, params: c.params, call, signature: sig(c.signature, "spend") });
    } else if (c.fn === "spendLeaf" && c.to === d.pool) {
      out.push({ kind: "leaf", account: c.to, batchId: c.batchId, leafIndex: c.leafIndex, destination: c.destination, call, signature: sig(c.signature, "leaf") });
    } else if (c.fn === "approveBatch" && c.to === d.pool) {
      out.push({ kind: "approval", account: c.to, key: c.key, batchId: c.batchId, state: c.state, nextKeyRoot: c.nextKeyRoot, call, signature: sig(c.signature, "approval") });
    }
  });
  return out;
}

/** The message `claim` signs given the chain's `state` of its key. */
function claimMessage(claim: WotsClaim, state: KeyState, chainId: number): Uint8Array {
  if (claim.kind !== state.kind) throw new Error(`a ${claim.kind} signature read against ${state.kind} state`);
  if (claim.kind === "vault" && state.kind === "vault") {
    return vaultSpendMessage({ chainId, vault: claim.account, nonce: state.nonce, nextKeyRoot: claim.nextKeyRoot, action: claim.action, params: claim.params });
  }
  if (claim.kind === "leaf" && state.kind === "leaf") {
    return leafMessage({ chainId, pool: claim.account, batchId: claim.batchId, leafIndex: claim.leafIndex, destination: claim.destination, leafAmount: state.leafAmount });
  }
  if (claim.kind === "approval") {
    return approvalMessage({ chainId, pool: claim.account, key: claim.key, batchId: claim.batchId, state: claim.state, nextKeyRoot: claim.nextKeyRoot });
  }
  throw new Error("unreachable");
}

/**
 * The record to escrow for `claim`, or null when it is not by the key the
 * chain holds now (no such vault, deposit or leaf; the deposit is not pending
 * or the leaf is spent; another key root): such a signature can never pass
 * the contract.
 */
export function escrowRecord(claim: WotsClaim, state: KeyState | null, block: bigint, now: number, chainId: number): SignatureRecord | null {
  if (state === null) return null;
  if (state.kind === "approval" && !state.pending) return null;
  if (state.kind === "leaf" && state.spent) return null;
  let message: Uint8Array;
  try {
    message = claimMessage(claim, state, chainId);
  } catch {
    return null;
  }
  const recovered = bytesToHex(wotsRecoverKeyRoot(hexToBytes(claim.signature), message));
  if (!liveRoot(state, recovered)) return null;
  return {
    keyRoot: lower(recovered),
    kind: claim.kind,
    account: getAddress(claim.account),
    ...(state.kind === "vault" ? { nonce: state.nonce.toString() } : {}),
    ...(claim.kind === "approval" ? { depositKey: lower(claim.key), batchId: claim.batchId.toString() } : {}),
    ...(claim.kind === "leaf" ? { batchId: claim.batchId.toString(), leafIndex: claim.leafIndex } : {}),
    message: bytesToHex(message),
    signature: lower(claim.signature),
    call: { to: getAddress(claim.call.to), data: lower(claim.call.data) },
    block: block.toString(),
    at: now,
  };
}

/** True when `keyRoot` may sign for `state` now: its key root, or a vault's waiting recovery root. */
function liveRoot(state: KeyState, keyRoot: string): boolean {
  if (lower(state.keyRoot) === lower(keyRoot)) return true;
  return state.kind === "vault" && state.recoveryKeyRoot !== undefined && lower(state.recoveryKeyRoot) === lower(keyRoot);
}

/** True when the chain's `state` shows the record's key used (or the account gone). */
export function keyUsed(record: SignatureRecord, state: KeyState | null): boolean {
  if (state === null || state.kind !== record.kind) return true;
  if (!liveRoot(state, record.keyRoot)) return true;
  if (state.kind === "vault") return state.nonce.toString() !== record.nonce;
  if (state.kind === "approval") return !state.pending;
  return state.spent;
}

/** What to read for a claim or a record. */
export type KeyTarget =
  | { kind: "vault"; account: Address }
  | { kind: "approval"; account: Address; depositKey: Hex }
  | { kind: "leaf"; account: Address; batchId: bigint; leafIndex: number };

export function claimTarget(c: WotsClaim): KeyTarget {
  if (c.kind === "vault") return { kind: "vault", account: c.account };
  if (c.kind === "approval") return { kind: "approval", account: c.account, depositKey: c.key };
  return { kind: "leaf", account: c.account, batchId: c.batchId, leafIndex: c.leafIndex };
}

export function recordTarget(r: SignatureRecord): KeyTarget {
  const account = getAddress(r.account);
  if (r.kind === "vault") return { kind: "vault", account };
  if (r.kind === "approval") return { kind: "approval", account, depositKey: r.depositKey as Hex };
  return { kind: "leaf", account, batchId: BigInt(r.batchId ?? "0"), leafIndex: r.leafIndex ?? 0 };
}

/**
 * The key state of each target at `blockNumber`, read in multicalls of at
 * most MAX_KEYS_PER_READ keys. A vault is only an Ostra vault when the
 * deployment's factory derives its address from its own initial parameters
 * (sdk readVault's rule); anything else reads as null.
 */
export async function readKeyStates(client: PublicClient, d: Deployment, targets: readonly KeyTarget[], blockNumber: bigint): Promise<(KeyState | null)[]> {
  const out: (KeyState | null)[] = [];
  for (let i = 0; i < targets.length; i += MAX_KEYS_PER_READ) {
    const chunk = targets.slice(i, i + MAX_KEYS_PER_READ);
    const contracts: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }[] = [];
    const spans: number[] = [];
    for (const t of chunk) {
      const before = contracts.length;
      if (t.kind === "vault") {
        for (const fn of ["token", "initialKeyRoot", "initialCrank", "keyRoot", "nonce", "recoveryRound", "pendingRecovery"]) contracts.push({ address: t.account, abi: ostraVaultAbi, functionName: fn });
      } else if (t.kind === "approval") {
        contracts.push({ address: t.account, abi: ostraPoolAbi, functionName: "getDeposit", args: [t.depositKey] });
      } else {
        contracts.push({ address: t.account, abi: ostraPoolAbi, functionName: "leaf", args: [t.batchId, t.leafIndex] });
        contracts.push({ address: t.account, abi: ostraPoolAbi, functionName: "leafAmount" });
      }
      spans.push(contracts.length - before);
    }
    const results = (await client.multicall({ contracts: contracts as never, allowFailure: true, blockNumber })) as unknown as readonly { status: string; result?: unknown }[];
    if (results.length !== contracts.length) throw new Error("the RPC answered a different number of reads");
    let at = 0;
    chunk.forEach((t, j) => {
      const r = results.slice(at, at + (spans[j] as number));
      at += spans[j] as number;
      if (r.some((x) => x.status !== "success")) {
        out.push(null);
        return;
      }
      if (t.kind === "vault") {
        const [token, initialKeyRoot, initialCrank, keyRoot, nonce, round, pending] = r.map((x) => x.result) as [Address, Hex, Address, Hex, bigint, number, readonly [number, bigint, Hex]];
        const expected = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot, initialCrank });
        const [pendingRound, executableAt, newKeyRoot] = pending;
        const recovery = executableAt !== 0n && pendingRound === round ? { recoveryKeyRoot: newKeyRoot } : {};
        out.push(expected === getAddress(t.account) && getAddress(token) !== zeroAddress ? { kind: "vault", keyRoot, nonce, ...recovery } : null);
      } else if (t.kind === "approval") {
        const dep = r[0]?.result as { status: number; approvalKeyRoot: Hex };
        const status = DEPOSIT_STATUS[dep.status];
        out.push(status === "none" || status === undefined ? null : { kind: "approval", keyRoot: dep.approvalKeyRoot, pending: status === "pending" });
      } else {
        const [keyRoot, spent] = r[0]?.result as readonly [Hex, boolean];
        const leafAmount = r[1]?.result as bigint;
        out.push(/^0x0{64}$/.test(keyRoot) ? null : { kind: "leaf", keyRoot, leafAmount, spent });
      }
    });
  }
  return out;
}

/** The record to escrow for each claim (null: not by the current key), read at the latest block. */
export async function escrowRecords(client: PublicClient, d: Deployment, claims: readonly WotsClaim[], now: number): Promise<(SignatureRecord | null)[]> {
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const states = await readKeyStates(client, d, claims.map(claimTarget), block);
  return claims.map((c, i) => escrowRecord(c, states[i] ?? null, block, now, d.chainId));
}

type EscrowData = { version: 1; records: Record<string, SignatureRecord> };

export class SignatureEscrow {
  readonly #path: string;
  #data: EscrowData;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(path: string, data: EscrowData) {
    this.#path = path;
    this.#data = data;
  }

  /** Opens (or creates) the escrow in `dir`, which must be private to its owner. */
  static async open(dir: string): Promise<SignatureEscrow> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const mode = (await stat(dir)).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error(`${dir} is accessible by other users (mode ${mode.toString(8)}); chmod 700 it`);
    const path = join(dir, "relayer-signatures.json");
    try {
      const data = JSON.parse(await readFile(path, "utf8")) as EscrowData;
      if (data.version !== 1) throw new Error(`${path}: unknown escrow version ${String(data.version)}`);
      return new SignatureEscrow(path, data);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return new SignatureEscrow(path, { version: 1, records: {} });
  }

  /** The record escrowed for `keyRoot` (0x hex), if any. */
  get(keyRoot: string): SignatureRecord | undefined {
    const record = this.#data.records[lower(keyRoot)];
    return record === undefined ? undefined : structuredClone(record);
  }

  /** Every escrowed record. */
  records(): SignatureRecord[] {
    return structuredClone(Object.values(this.#data.records));
  }

  /**
   * Stores `records`, all or none, and saves before resolving. When a key
   * root holds (or `records` gives it) another message, nothing is stored and
   * the record it holds is returned as `conflict`. `added`: the key roots
   * stored now (a record already held with the same message stays as it is).
   */
  put(records: readonly SignatureRecord[]): Promise<{ conflict: SignatureRecord | null; added: string[] }> {
    return this.#locked<{ conflict: SignatureRecord | null; added: string[] }>(() => {
      const next = structuredClone(this.#data);
      const added: string[] = [];
      for (const r of records) {
        const held = next.records[r.keyRoot];
        if (held !== undefined) {
          if (held.message !== r.message) return { next: null, result: { conflict: structuredClone(held), added: [] } };
          continue;
        }
        next.records[r.keyRoot] = structuredClone(r);
        added.push(r.keyRoot);
      }
      return { next: added.length > 0 ? next : null, result: { conflict: null, added } };
    });
  }

  /** Drops the records of `keyRoots` and saves before resolving. */
  remove(keyRoots: readonly string[]): Promise<void> {
    return this.#locked(() => {
      const next = structuredClone(this.#data);
      let changed = false;
      for (const k of keyRoots) {
        if (next.records[k] !== undefined) {
          delete next.records[k];
          changed = true;
        }
      }
      return { next: changed ? next : null, result: undefined };
    });
  }

  /** Runs `change` under the lock; the data it returns (null: unchanged) is saved before it takes effect. */
  #locked<T>(change: () => { next: EscrowData | null; result: T }): Promise<T> {
    const run = async (): Promise<T> => {
      const { next, result } = change();
      if (next !== null) {
        await this.#save(next);
        this.#data = next;
      }
      return result;
    };
    const p = this.#tail.then(run, run);
    this.#tail = p.catch(() => undefined);
    return p;
  }

  async #save(data: EscrowData): Promise<void> {
    const tmp = `${this.#path}.tmp`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 1)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.#path);
  }
}

/** Drops escrowed records whose key the chain shows used, every PRUNE_SWEEP_MS. */
export class SignaturePruner {
  readonly #client: PublicClient;
  readonly #d: Deployment;
  readonly #escrow: SignatureEscrow;
  readonly #log: Log;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;

  constructor(o: { client: PublicClient; deployment: Deployment; escrow: SignatureEscrow; log: Log }) {
    this.#client = o.client;
    this.#d = o.deployment;
    this.#escrow = o.escrow;
    this.#log = o.log;
  }

  /** Sweeps now and then every PRUNE_SWEEP_MS. */
  start(): void {
    const run = () => {
      if (this.#running !== undefined) return;
      this.#running = this.sweep()
        .then(() => undefined)
        .catch((err: unknown) => this.#log("signature_sweep_failed", { error: err instanceof Error ? err.message : String(err) }))
        .finally(() => {
          this.#running = undefined;
        });
    };
    run();
    this.#timer = setInterval(run, PRUNE_SWEEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Drops the records whose key the finalized block shows used, reading only
   * records checked at or before that block. Returns the key roots dropped.
   */
  async sweep(): Promise<string[]> {
    const records = this.#escrow.records();
    if (records.length === 0) return [];
    const finalized = (await this.#client.getBlock({ blockTag: "finalized" })).number;
    const due = records.filter((r) => BigInt(r.block) <= finalized);
    if (due.length === 0) return [];
    const states = await readKeyStates(this.#client, this.#d, due.map(recordTarget), finalized);
    const used = due.filter((r, i) => keyUsed(r, states[i] ?? null)).map((r) => r.keyRoot);
    if (used.length === 0) return [];
    await this.#escrow.remove(used);
    this.#log("signatures_pruned", { count: used.length, left: records.length - used.length });
    return used;
  }
}
