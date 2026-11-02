// The agent's reputation proofs (OstraReputation, sdk reputation.ts; specified by Edu on 2 Nov 2026): it proves that
// the OstraPad record of its USDG vault (its provider vault on Ostrapad) meets a verifier's thresholds, without
// showing which vault.
//
//   secret     the reputation secret sk is drawn once by the prover (`ostra-prove secret`), only for reputation (never
//              a private note's sk), and kept as a secret of the agent's folder (on disk a 0600 file, as every other
//              secret there); it is never logged or returned. Its identity commitment idc is public once a snapshot
//              carries it. RepKeyring keeps which secret is in force and which one a rotation waits on (keys.json).
//   rotate     a new sk is drawn and kept beside the one in force, and its idc is scheduled by the normal approved
//              snapshot (OstraReputation: it takes effect from the next epoch, and only once the idc in force has
//              been in force REP_ROTATION_COOLDOWN epochs; refused here sooner, before anything is drawn or signed).
//              Until the contract shows the new idc in force (the first snapshot from that epoch), the old sk stays
//              the one in force here and still proves for the vault's leaves; then keys.json is rewritten
//              atomically to the new one and the old file removed. Every secret is kept before it is used, and the
//              one in force is replaced only after its successor is in force on chain: a failed step loses none.
//              A folder restored without its secret draws a new one, which a snapshot schedules the same way.
//   snapshot   the digest the vault approves is built here (repSnapshotDigest, from the vault's nonce read from the
//              contract and the epoch the approval is for), never taken from anyone (MCP 0.1.13), and checked against
//              the contract's own snapshotDigest before the approval is signed. Without the withdrawal lock the
//              ApproveHash spend and the snapshot go in one relayed transaction, simulated first. Under the lock an
//              approval takes effect the lock's delay after it lands: it is given for the epoch it will be usable in
//              (repApprovalPlan), kept here, and a later call sends the snapshot once it holds (or answers when it
//              will); an approval that does not hold in its epoch (withdrawn, the lock changed) is given again.
//   prove      the epoch's tree is rebuilt from the Snapshot and Recorded events and checked against the contract
//              (treeSize, latestRoot, rootSize: reads of the whole tree, never of the agent's vault, so the RPC sees
//              nothing that ties the vault to the proof); the proof is against the latest root of the current epoch,
//              and only once REP_MIN_LATER_LEAVES (k - 1 = 4) leaves of other vaults follow the agent's own (right
//              after its own snapshot its leaf would be the newest under that root). ostra-prove verifies every proof
//              it makes natively; no eth_call of verify follows a proof (it would send the pseudonym through the RPC
//              the agent's snapshot went through). The anonymity set is
//              computed here first: the vaults of that tree whose records meet the statement, intersected with every
//              statement proven before under the same scope (kept per scope); below REP_MIN_ANONYMITY (k = 5) nothing
//              is proven. The statement needs the record to be REP_DEFAULT_MIN_AGE_DAYS (30) days old by default (the
//              vault's first snapshot that long ago). The scope is keccak256 of the verifier's scope text with the
//              epoch in it by default; the bind is (scope, recipient, challenge). Every proof is verified by an
//              eth_call to OstraReputation.verify before it is returned.
//   verify     a verifier's check: its own scope text (the current epoch in it by default), thresholds, recipient and
//              challenge, the root, pseudonym and proof given; an eth_call to OstraReputation.verify, the root's tree
//              size and the anonymity set of the statement in that tree.
//
// Records (folder `reputation`): the secret `sk`; state.json (the vault, the idc, the approval waiting, the leaves
// snapshotted); scopes.json (the statements proven, per scope hash: epoch, tree size and thresholds).

import { getAddress, hexToBytes, parseEventLogs, sha256, stringToHex, toHex, zeroAddress, type Address, type Hash, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import {
  OSTRAPAD,
  QuoteError,
  REP_DEFAULT_MIN_AGE_DAYS,
  REP_MIN_ANONYMITY,
  REP_MIN_LATER_LEAVES,
  REP_SNAPSHOT_END_MARGIN_SECONDS,
  REP_ROTATION_COOLDOWN,
  VAULT_ACTION,
  VAULT_V3,
  approveHashParams,
  ostraReputationAbi,
  ostraVaultAbi,
  padDigestFromCid,
  padListingChallenge,
  padListingEntry,
  PAD_LISTINGS_SCOPE_TEXT,
  padReputationFromEntry,
  padReputationEntry,
  padReputationProofParts,
  readRepAccount,
  readRepEpoch,
  readVault,
  readVaultGuard,
  repAnonymitySet,
  repApprovalPlan,
  repBindHash,
  repDayAt,
  repEntriesAtRoot,
  repEntriesOfLogs,
  repEpochAt,
  repEpochStart,
  repIdc,
  repIsCanonical,
  repLeaf,
  repMeets,
  repNewSecret,
  repPath,
  repProve,
  repScope,
  repSnapshotCall,
  repSnapshotDigest,
  repThresholdsProblem,
  repVerify,
  reputationOf,
  signVaultSpend,
  simulateVaultSpend,
  simulateVaultSpendThen,
  type PadReputation,
  type RepEntry,
  type RepProver,
  type RepRecord,
  type RepRecordedLog,
  type RepSnapshotLog,
  type RepThresholds,
  type ReputationDeployment,
} from "@ostraagent/sdk";
import type { Prover } from "@ostraagent/swap";
import { formatTokenAmount, parseTokenAmount } from "./amount.ts";
import type { Config } from "./config.ts";
import type { Sender } from "./relay.ts";
import type { Folder } from "./storage.ts";
import { spendCall, type VaultOperationResult, type VaultService } from "./vault.ts";

export const REPUTATION_DIR = "reputation";
const SK_SECRET = "sk";
const KEYS = "keys.json";
const STATE = "state.json";
const SCOPES = "scopes.json";
const SPEND_GAS_HEADROOM = 100_000n;
/** Time an approval is given to land and a snapshot to be sent in its epoch: an approval taking effect later in an epoch is given for the next one. */
export const REP_APPROVAL_MARGIN_SECONDS = 1_800n;
const EIP1271_MAGIC = "0x1626ba7e";
const erc1271Abi = [
  { type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ name: "", type: "bytes4" }] },
] as const;

/**
 * The swap package's Prover as the reputation's: the CLI and WebAssembly provers pass any ostra-prove command through
 * (cli-prover.ts runs `ostra-prove <command>`, wasm-prover.ts the build's prover(command, request)). A build from
 * before the reputation commands answers them with its usage line: said plainly.
 */
export function repProverOf(p: Prover): RepProver {
  const any = p as unknown as (command: string, request?: unknown) => Promise<unknown>;
  return async (command, request) => {
    try {
      return await any(command, request);
    } catch (err) {
      if (command.startsWith("rep-") && /usage: ostra-prove/.test(String((err as Error).message ?? err)) && !/rep-prove/.test(String((err as Error).message ?? err))) {
        throw new Error("this prover build has no reputation commands (rep-id, rep-record, rep-prove): a newer ostra-prove (or @ostraagent/mcp release) carries them; nothing was proven");
      }
      throw err;
    }
  };
}

/** A verifier's thresholds as the tools take them: counts as numbers, the volume in USDG (decimal), the age in days. */
export type ThresholdsInput = { minCompleted?: number; minClients?: number; minVolume?: string; maxFailPermille?: number; minTier?: number; maxFirstDay?: number; minAgeDays?: number };

type Pending = { digest: Hex; epoch: string; nonce: string; idc: Hex; txHash: string; at: number };
type SnapshotRecord = { epoch: string; index: number; leaf: Hex; root: Hex; txHash: string; idc: Hex };
type State = { version: 1; vault: Address; idc: Hex | null; pending: Pending | null; snapshots: Record<string, SnapshotRecord> };
type Statement = { epoch: string; count: number; thresholds: Record<string, string>; at: number };

/** A reputation secret as RepKeyring keeps it: its folder secret's name and its identity commitment. */
export type RepKeyRef = { secret: string; idc: Hex };
type KeyRecord = { version: 1; current: RepKeyRef; next: RepKeyRef | null };

/**
 * The agent's reputation secrets in its folder: the one in force (`current`) and, during a rotation, the one waiting
 * to be in force (`next`), named in keys.json (written atomically; the secrets themselves are created exclusively and
 * only removed once the record no longer names them). A folder from before keys.json holds the secret `sk` alone.
 */
export class RepKeyring {
  readonly #folder: Folder;
  readonly #prover: () => RepProver;

  constructor(folder: Folder, prover: () => RepProver) {
    this.#folder = folder;
    this.#prover = prover;
  }

  async #secret(name: string): Promise<Hex | null> {
    let bytes: Uint8Array;
    try {
      bytes = await this.#folder.readSecret(name);
    } catch {
      return null;
    }
    const sk = toHex(bytes);
    if (bytes.length !== 32 || !repIsCanonical(sk)) throw new Error("a reputation secret kept here is not 8 field elements");
    return sk;
  }

  /** The record, migrated from a lone `sk` (its idc computed once); null before any secret. */
  async #record(): Promise<KeyRecord | null> {
    const t = await this.#folder.read(KEYS);
    if (t !== undefined) return JSON.parse(t) as KeyRecord;
    const sk = await this.#secret(SK_SECRET);
    if (sk === null) return null;
    const r: KeyRecord = { version: 1, current: { secret: SK_SECRET, idc: await repIdc(this.#prover(), sk) }, next: null };
    await this.#folder.write(KEYS, JSON.stringify(r, null, 2));
    return r;
  }

  async #key(ref: RepKeyRef | null): Promise<{ sk: Hex; idc: Hex; secret: string } | null> {
    if (ref === null) return null;
    const sk = await this.#secret(ref.secret);
    if (sk === null) throw new Error(`the reputation secret ${ref.secret} named in ${KEYS} is missing`);
    return { sk, idc: ref.idc, secret: ref.secret };
  }

  /** The secret in force here, or null before the first. */
  async current(): Promise<{ sk: Hex; idc: Hex; secret: string } | null> {
    return this.#key((await this.#record())?.current ?? null);
  }

  /** The secret a rotation waits on, or null. */
  async next(): Promise<{ sk: Hex; idc: Hex; secret: string } | null> {
    return this.#key((await this.#record())?.next ?? null);
  }

  /** The secret whose idc is `idc` (in force here or waiting), or null. */
  async forIdc(idc: Hex): Promise<{ sk: Hex; idc: Hex; secret: string } | null> {
    const r = await this.#record();
    if (r === null) return null;
    const ref = [r.current, r.next].find((k) => k !== null && k.idc === idc.toLowerCase()) ?? null;
    return this.#key(ref);
  }

  /** A secret name not used in the folder. */
  async #freshName(): Promise<string> {
    const taken = new Set(await this.#folder.list());
    for (let n = 1; ; n++) if (!taken.has(`sk-${n}`)) return `sk-${n}`;
  }

  /** A new secret drawn by the prover, kept (exclusively) under a fresh name before anything names it. */
  async #draw(): Promise<RepKeyRef> {
    const sk = await repNewSecret(this.#prover());
    const name = (await this.#record()) === null && (await this.#secret(SK_SECRET)) === null ? SK_SECRET : await this.#freshName();
    await this.#folder.ensure();
    await this.#folder.createSecret(name, hexToBytes(sk));
    const kept = await this.#secret(name);
    if (kept !== sk) throw new Error("the reputation secret could not be kept");
    return { secret: name, idc: await repIdc(this.#prover(), sk) };
  }

  /** The secret in force, drawn and kept the first time. */
  async ensure(): Promise<{ sk: Hex; idc: Hex; secret: string }> {
    const r = await this.#record();
    if (r !== null) return (await this.#key(r.current)) as { sk: Hex; idc: Hex; secret: string };
    const ref = await this.#draw();
    await this.#folder.write(KEYS, JSON.stringify({ version: 1, current: ref, next: null } satisfies KeyRecord, null, 2));
    return (await this.#key(ref)) as { sk: Hex; idc: Hex; secret: string };
  }

  /** The secret a rotation waits on: the one drawn before, or a new one drawn and kept now (the one in force stays). */
  async beginRotation(): Promise<{ sk: Hex; idc: Hex; secret: string }> {
    const r = await this.#record();
    if (r === null) throw new Error("there is no reputation secret to rotate yet: the first snapshot draws one");
    if (r.next !== null) return (await this.#key(r.next)) as { sk: Hex; idc: Hex; secret: string };
    const ref = await this.#draw();
    await this.#folder.write(KEYS, JSON.stringify({ ...r, next: ref } satisfies KeyRecord, null, 2));
    return (await this.#key(ref)) as { sk: Hex; idc: Hex; secret: string };
  }

  /**
   * Once the contract shows `inForce` (the vault's idc in force) as the waiting secret's: that secret becomes the one
   * in force here (keys.json rewritten atomically) and the old one is removed. True when it switched.
   */
  async settle(inForce: Hex): Promise<boolean> {
    const r = await this.#record();
    if (r === null || r.next === null || r.next.idc !== inForce.toLowerCase()) return false;
    const old = r.current;
    await this.#folder.write(KEYS, JSON.stringify({ version: 1, current: r.next, next: null } satisfies KeyRecord, null, 2));
    if (old.secret !== r.next.secret) await this.#folder.remove(old.secret).catch(() => undefined);
    return true;
  }
}

export type ReputationParts = {
  client: PublicClient;
  /** For the event searches (an RPC serving wide eth_getLogs); the client by default. */
  logsClient?: PublicClient;
  config: Config;
  /** The USDG vault: the agent's provider vault on Ostrapad, whose record is proven. */
  buyer: VaultService;
  /** Who sends the vault's transactions and the snapshot (the relayer, paid from the vault). */
  sender: Sender;
  folder: Folder;
  /** ostra-prove (null: the reputation tools refuse to run). */
  prover: RepProver | null;
};

function thresholdsView(t: RepThresholds): Record<string, string | number> {
  return { minCompleted: t.minCompleted, minClients: t.minClients, minVolume: formatTokenAmount(t.minVolume), minVolumeUnits: t.minVolume.toString(), maxFailPermille: t.maxFailPermille, minTier: t.minTier, maxFirstDay: t.maxFirstDay };
}

function recordView(r: RepRecord): Record<string, string | number> {
  return { completed: r.completed, clients: r.clients, volume: formatTokenAmount(r.volume), rejected: r.rejected, expired: r.expired, tier: r.tier, firstDay: r.firstDay, epoch: r.epoch };
}

function hex32(value: string, name: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new RangeError(`${name} must be 32 bytes (0x and 64 hex digits)`);
  return value.toLowerCase() as Hex;
}

export class ReputationService {
  readonly #p: ReputationParts;
  #queue: Promise<unknown> = Promise.resolve();
  #base: bigint | null = null;
  readonly #keys: RepKeyring;

  constructor(p: ReputationParts) {
    this.#p = p;
    this.#keys = new RepKeyring(p.folder.folder(REPUTATION_DIR), () => this.#prover());
  }

  #serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(f, f);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #rep(): ReputationDeployment {
    return reputationOf(this.#p.config.deployment);
  }

  #prover(): RepProver {
    if (this.#p.prover === null) throw new Error("the prover (ostra-prove) is not installed: reputation proofs need it; nothing was signed");
    return this.#p.prover;
  }

  #logs(): PublicClient {
    return this.#p.logsClient ?? this.#p.client;
  }

  #folder(): Folder {
    return this.#p.folder.folder(REPUTATION_DIR);
  }

  async #read<T>(name: string): Promise<T | null> {
    const t = await this.#folder().read(name);
    return t === undefined ? null : (JSON.parse(t) as T);
  }

  async #write(name: string, value: unknown): Promise<void> {
    await this.#folder().ensure();
    await this.#folder().write(name, JSON.stringify(value, null, 2));
  }

  async #state(vault: Address): Promise<State> {
    const s = await this.#read<State>(STATE);
    if (s === null) return { version: 1, vault, idc: null, pending: null, snapshots: {} };
    if (getAddress(s.vault) !== vault) throw new Error(`the reputation records here are of vault ${s.vault}, not this agent's USDG vault ${vault}`);
    return s;
  }

  async #baseOf(rep: Address): Promise<bigint> {
    if (this.#base === null) this.#base = (await this.#p.client.readContract({ address: rep, abi: ostraReputationAbi, functionName: "BASE" })) as bigint;
    return this.#base;
  }

  async #head(): Promise<{ number: bigint; timestamp: bigint }> {
    const b = await this.#p.client.getBlock({ blockTag: "latest" });
    return { number: b.number, timestamp: b.timestamp };
  }

  /** The block the logs RPC and the client both have: the smaller of their heads. */
  async #logsHead(): Promise<{ number: bigint; timestamp: bigint }> {
    const head = await this.#head();
    const logsHead = this.#p.logsClient === undefined ? head.number : await this.#p.logsClient.getBlockNumber({ cacheTime: 0 });
    if (logsHead >= head.number) return head;
    const b = await this.#p.client.getBlock({ blockNumber: logsHead });
    return { number: b.number, timestamp: b.timestamp };
  }

  async #vault(): Promise<Address> {
    const vault = getAddress(await this.#p.buyer.vaultAddress());
    if ((await readVault(this.#p.client, this.#p.config.deployment, vault)) === null) throw new Error("this agent has no USDG vault yet: create it first; nothing was signed");
    const version = Number(await this.#p.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "VERSION" }));
    if (version < VAULT_V3) throw new Error(`the USDG vault runs version ${version}; a reputation snapshot needs version ${VAULT_V3} (EIP-1271); nothing was signed`);
    return vault;
  }

  async #approved(vault: Address, digest: Hex): Promise<boolean> {
    try {
      const r = await this.#p.client.readContract({ address: vault, abi: erc1271Abi, functionName: "isValidSignature", args: [digest, "0x"] });
      return r.toLowerCase() === EIP1271_MAGIC;
    } catch {
      return false;
    }
  }

  /** The digest the vault approves for its snapshot with `idc` at `nonce` in `epoch`: built here, and checked to be the contract's. */
  async #digest(rep: Address, vault: Address, idc: Hex, nonce: bigint, epoch: bigint): Promise<Hex> {
    const digest = repSnapshotDigest({ chainId: this.#p.config.chainId, reputation: rep, vault, idc, nonce, epoch });
    const theirs = ((await this.#p.client.readContract({ address: rep, abi: ostraReputationAbi, functionName: "snapshotDigest", args: [vault, idc, nonce, epoch] })) as Hex).toLowerCase();
    if (theirs !== digest.toLowerCase()) throw new Error(`the contract at ${rep} does not compute OstraReputation's snapshot digest: nothing is approved for it; nothing was signed`);
    return digest;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------------------------------------------

  /** Where the agent's reputation stands: the contract, the epoch, the vault's account and this epoch's snapshot. */
  async status(): Promise<Record<string, unknown>> {
    const d = this.#p.config.deployment.reputation;
    if (d === undefined) return { deployed: false, note: "OstraReputation is not deployed on this chain yet: reputation proofs are not available here" };
    const vault = getAddress(await this.#p.buyer.vaultAddress());
    const head = await this.#head();
    const base = await this.#baseOf(d.address);
    const epoch = repEpochAt(base, head.timestamp);
    const a = await readRepAccount(this.#p.client, d.address, vault);
    const state = await this.#state(vault);
    const zero = `0x${"00".repeat(32)}`;
    if (a.idc !== zero) await this.#keys.settle(a.idc);
    const cur = await this.#keys.current();
    const next = await this.#keys.next();
    const idc = cur === null ? null : cur.idc;
    const size = (await this.#p.client.readContract({ address: d.address, abi: ostraReputationAbi, functionName: "treeSize", args: [epoch] })) as bigint;
    return {
      deployed: true,
      reputation: d.address,
      vault,
      epoch: epoch.toString(),
      epochEndsAt: new Date(Number(repEpochStart(base, epoch + 1n)) * 1000).toISOString(),
      day: repDayAt(base, head.timestamp).toString(),
      secret: cur === null ? "none yet (the first snapshot draws it)" : "kept",
      idc,
      rotation:
        next === null
          ? null
          : { idc: next.idc, takesEffectInEpoch: a.pendingIdc === next.idc ? a.pendingFrom : null, note: a.pendingIdc === next.idc ? "scheduled: the first snapshot from that epoch puts it in force, and the secret in force now proves until then" : "drawn, not scheduled yet: reputation_snapshot with action rotate schedules it" },
      account: {
        idcInForce: a.idc === zero ? null : a.idc,
        isThisAgents: a.idc === zero ? null : idc !== null && a.idc === idc,
        pendingIdc: a.pendingIdc === zero ? null : { idc: a.pendingIdc, fromEpoch: a.pendingFrom },
        firstDay: a.lastEpochPlusOne === 0 ? null : a.firstDay,
        lastSnapshotEpoch: a.lastEpochPlusOne === 0 ? null : a.lastEpochPlusOne - 1,
      },
      snapshottedThisEpoch: a.lastEpochPlusOne === Number(epoch) + 1,
      treeSize: size.toString(),
      approvalWaiting: state.pending,
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Snapshots the USDG vault's OstraPad record into this epoch's tree: approved by the vault and sent (in one relayed
   * transaction without the withdrawal lock); under the lock, approved for the epoch it will hold in and sent by a
   * later call once it holds.
   */
  snapshot(): Promise<Record<string, unknown>> {
    return this.#serial(() => this.#snapshot());
  }

  async #snapshot(): Promise<Record<string, unknown>> {
    const rep = this.#rep();
    const vault = await this.#vault();
    const state = await this.#state(vault);
    await this.#keys.ensure();
    const head = await this.#head();
    const base = await this.#baseOf(rep.address);
    const epoch = repEpochAt(base, head.timestamp);
    const a = await readRepAccount(this.#p.client, rep.address, vault);
    const zero = `0x${"00".repeat(32)}`;
    if (a.idc !== zero) await this.#keys.settle(a.idc);
    // The idc a snapshot names: the one a rotation waits on, else the one in force here.
    const idc = ((await this.#keys.next()) ?? (await this.#keys.ensure())).idc;
    if (a.lastEpochPlusOne === Number(epoch) + 1) {
      const kept = state.snapshots[epoch.toString()];
      return { status: "snapshotted before", epoch: epoch.toString(), vault, ...(kept === undefined ? {} : { index: kept.index, leaf: kept.leaf, txHash: kept.txHash }), note: "one snapshot per vault and epoch: the next one can be made from the next epoch" };
    }
    const owner = getAddress((await this.#p.client.readContract({ address: rep.address, abi: ostraReputationAbi, functionName: "vaultOfIdc", args: [idc] })) as Address);
    if (owner !== zeroAddress && owner !== vault) throw new Error(`this agent's identity commitment is taken by another vault (${owner}): its reputation secret must be drawn again; nothing was signed`);
    // A new idc (the secret kept here is not the one in force): a rotation, from the next epoch, after the cooldown.
    let rotation: string | null = null;
    if (a.idc !== zero && a.idc !== idc) {
      // The leaves until then carry the idc in force: this agent proves for them only when that one is its own too.
      const old = (await this.#keys.forIdc(a.idc)) !== null ? "which the reputation secret in force here still proves for" : "which this agent cannot prove for (its secret is not kept here)";
      if (a.pendingIdc === idc) rotation = `this agent's new identity commitment takes effect in epoch ${a.pendingFrom}: until then this vault's leaves carry the one in force, ${old}`;
      else {
        const from = BigInt(a.idcFrom) + REP_ROTATION_COOLDOWN;
        if (epoch + 1n < from) {
          throw new Error(
            `the vault's identity commitment in force took effect in epoch ${a.idcFrom}, and a new one may take effect from epoch ${from} only (OstraReputation's ${REP_ROTATION_COOLDOWN}-epoch cooldown): it can be scheduled from epoch ${from - 1n}; nothing was signed`,
          );
        }
        rotation = `this snapshot schedules this agent's new identity commitment from epoch ${epoch + 1n}: this epoch's leaf carries the one in force, ${old}`;
      }
    }
    const nonce = (await this.#p.client.readContract({ address: rep.address, abi: ostraReputationAbi, functionName: "nonces", args: [vault] })) as bigint;
    const call = repSnapshotCall(rep.address, vault, idc);

    // An approval given before (under the lock): sent once it holds in its epoch.
    const p = state.pending;
    if (p !== null && BigInt(p.nonce) === nonce && p.idc === idc && BigInt(p.epoch) >= epoch) {
      const validFrom = (await this.#p.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "hashValidFrom", args: [p.digest] })) as bigint;
      const pe = BigInt(p.epoch);
      const until = repEpochStart(base, pe + 1n);
      if (validFrom !== 0n && validFrom < until) {
        const from = validFrom > repEpochStart(base, pe) ? validFrom : repEpochStart(base, pe);
        if (pe > epoch || head.timestamp < validFrom) {
          return { status: "approved, waiting", epoch: p.epoch, vault, sendableFrom: new Date(Number(from) * 1000).toISOString(), sendableUntil: new Date(Number(until) * 1000).toISOString(), note: "the vault's approval of its snapshot takes effect then (its withdrawal lock delays approvals): call reputation_snapshot again in that window" };
        }
        return this.#landed(rep, vault, idc, state, await this.#send(call, "reputation snapshot"), rotation);
      }
      // Withdrawn, ended by a lock turned on, or taking effect too late for its epoch: given again below.
    }

    const g = await readVaultGuard(this.#p.client, vault);
    const delay = g.lock.withdrawal === zeroAddress ? 0n : BigInt(g.lock.delay);
    const plan = repApprovalPlan({ base, now: head.timestamp, delay, margin: delay === 0n ? 0n : REP_APPROVAL_MARGIN_SECONDS });
    const digest = await this.#digest(rep.address, vault, idc, nonce, plan.epoch);
    if (plan.epoch === epoch && (await this.#approved(vault, digest))) {
      return this.#landed(rep, vault, idc, state, await this.#send(call, "reputation snapshot"), rotation, "the approval was on chain already; only the snapshot was sent");
    }
    const params = approveHashParams({ hash: digest, approved: true });
    const relayer = await this.#p.sender.payer();
    const d = this.#p.config.deployment;
    if (delay === 0n) {
      // Not in the last minutes of the epoch: landing in the next one, the approval (of this epoch) would not hold and
      // the vault's spend would be used for nothing.
      const left = repEpochStart(base, epoch + 1n) - head.timestamp;
      if (left < REP_SNAPSHOT_END_MARGIN_SECONDS) {
        throw new Error(`epoch ${epoch} ends in ${left} s: a snapshot is not approved and sent within ${REP_SNAPSHOT_END_MARGIN_SECONDS / 60n} minutes of an epoch's end; call again from ${new Date(Number(repEpochStart(base, epoch + 1n)) * 1000).toISOString()}; nothing was signed`);
      }
      // The approval and the snapshot in one transaction, simulated with a throwaway key first and again before signing.
      const sim = await simulateVaultSpendThen(this.#p.client, d, { relayer, vault, action: VAULT_ACTION.APPROVE_HASH, params, then: [call] }).catch((err: unknown) => {
        throw err instanceof QuoteError ? new QuoteError(err.code, `the reputation snapshot fails now: ${err.message}; nothing was signed`) : err;
      });
      const gas = (sim.gasUsed * 5n) / 4n + SPEND_GAS_HEADROOM;
      const r: VaultOperationResult = await this.#p.buyer.operate({
        gas,
        what: "reputation snapshot",
        build: async ({ v, vault: at, keychain, chainId }) => {
          const again = await simulateVaultSpendThen(this.#p.client, d, { relayer, vault: at, action: VAULT_ACTION.APPROVE_HASH, params, then: [call] });
          if ((again.gasUsed * 5n) / 4n > gas) throw new QuoteError("spend_fails", "the reputation snapshot needs more gas now than it was reserved for; call again; nothing was signed");
          return [spendCall(at, await signVaultSpend(keychain, v, { chainId, action: VAULT_ACTION.APPROVE_HASH, params })), call];
        },
      });
      if (r.status !== "sent") return { status: "not sent", note: `${r.note}; call reputation_snapshot again` };
      return this.#landed(rep, vault, idc, state, r.txHash, rotation);
    }
    // Under the lock: the approval alone, for the epoch it will hold in.
    const sim = await simulateVaultSpend(this.#p.client, d, { relayer, vault, action: VAULT_ACTION.APPROVE_HASH, params }).catch((err: unknown) => {
      throw err instanceof QuoteError ? new QuoteError(err.code, `the vault cannot approve its snapshot now: ${err.message}; nothing was signed`) : err;
    });
    const r = await this.#p.buyer.operate({
      gas: (sim.gasUsed * 5n) / 4n + SPEND_GAS_HEADROOM,
      what: "reputation snapshot approval",
      build: async ({ v, vault: at, keychain, chainId }) => [spendCall(at, await signVaultSpend(keychain, v, { chainId, action: VAULT_ACTION.APPROVE_HASH, params }))],
    });
    if (r.status !== "sent") return { status: "not sent", note: `${r.note}; call reputation_snapshot again` };
    state.pending = { digest, epoch: plan.epoch.toString(), nonce: nonce.toString(), idc, txHash: r.txHash, at: Math.floor(Date.now() / 1000) };
    await this.#write(STATE, state);
    const validFrom = (await this.#p.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "hashValidFrom", args: [digest] })) as bigint;
    const from = validFrom > repEpochStart(base, plan.epoch) ? validFrom : repEpochStart(base, plan.epoch);
    return {
      status: "approved, waiting",
      epoch: plan.epoch.toString(),
      vault,
      approvalTx: r.txHash,
      sendableFrom: new Date(Number(from) * 1000).toISOString(),
      sendableUntil: new Date(Number(plan.sendableUntil) * 1000).toISOString(),
      note: `the vault is under the withdrawal lock: its approval takes effect ${Math.round(Number(delay) / 3600)} hours after it lands, so it was given for epoch ${plan.epoch}; call reputation_snapshot again in that window to send the snapshot`,
      ...(rotation === null ? {} : { rotation }),
    };
  }

  /** Sends the snapshot alone (its approval holds on chain), checked with an eth_call first. */
  async #send(call: { to: Address; data: Hex }, what: string): Promise<Hash> {
    try {
      await this.#p.client.call({ account: await this.#p.sender.payer(), to: call.to, data: call.data });
    } catch (err) {
      throw new QuoteError("spend_fails", `the ${what} fails now: ${String((err as { shortMessage?: string }).shortMessage ?? (err as Error).message).split("\n")[0]}; nothing was sent`);
    }
    return this.#p.sender.send([call]);
  }

  /** The snapshot's leaf from its receipt, checked to be this agent's (or noted as the previous idc's), kept. */
  async #landed(rep: ReputationDeployment, vault: Address, idc: Hex, state: State, txHash: Hash, rotation: string | null, note?: string): Promise<Record<string, unknown>> {
    const receipt: TransactionReceipt = await this.#p.client.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`the snapshot transaction ${txHash} reverted`);
    const events = parseEventLogs({ abi: ostraReputationAbi, logs: receipt.logs.filter((l) => getAddress(l.address) === rep.address) });
    const snaps = events.filter((e) => e.eventName === "Snapshot") as unknown as RepSnapshotLog[];
    const recs = events.filter((e) => e.eventName === "Recorded") as unknown as RepRecordedLog[];
    const entry = repEntriesOfLogs(snaps, recs).find((e) => e.vault === vault);
    if (entry === undefined) throw new Error(`the transaction ${txHash} holds no snapshot of ${vault}`);
    const a = await readRepAccount(this.#p.client, rep.address, vault, receipt.blockNumber);
    // The leaf carries the idc in force after it (a rotation's new idc from its epoch on): provable when it is one of
    // this agent's secrets; that secret is the one in force here from now on.
    const mineKey = await this.#keys.forIdc(a.idc);
    const own = mineKey !== null && (await repLeaf(this.#prover(), entry.record, a.idc)).leaf === entry.leaf;
    if (!own && mineKey !== null) throw new Error("the snapshot's leaf is not the one this agent's record and identity commitment make");
    const switched = await this.#keys.settle(a.idc);
    const epoch = entry.epoch.toString();
    state.pending = null;
    state.snapshots[epoch] = { epoch, index: entry.index, leaf: entry.leaf, root: entry.root, txHash, idc: a.idc };
    await this.#write(STATE, state);
    return {
      status: "snapshotted",
      epoch,
      vault,
      index: entry.index,
      leaf: entry.leaf,
      root: entry.root,
      record: recordView(entry.record),
      txHash,
      provable: own,
      ...(rotation === null ? {} : { rotation }),
      ...(switched ? { rotated: `the new identity commitment is in force from epoch ${epoch}: the new reputation secret is the one in force here, the old one is removed` } : {}),
      ...(note === undefined ? {} : { note }),
    };
  }

  /**
   * Rotates the reputation secret: a new one is drawn and kept beside the one in force, and its idc is scheduled with
   * this epoch's snapshot (approved by the vault as any snapshot). It takes effect from the next epoch (under the
   * withdrawal lock, from the epoch after the one its approval holds in), and only once the idc in force has been in
   * force REP_ROTATION_COOLDOWN epochs; until then the secret in force proves for the vault's leaves. Called again, it
   * carries on with the secret drawn before.
   */
  rotate(): Promise<Record<string, unknown>> {
    return this.#serial(async () => {
      const rep = this.#rep();
      const vault = await this.#vault();
      const zero = `0x${"00".repeat(32)}`;
      const cur = await this.#keys.current();
      const a = await readRepAccount(this.#p.client, rep.address, vault);
      if (cur === null || a.idc === zero) throw new Error("this vault has no identity commitment in force yet: its first snapshot takes this agent's (reputation_snapshot); there is nothing to rotate; nothing was drawn");
      await this.#keys.settle(a.idc);
      const waiting = await this.#keys.next();
      const inForce = await this.#keys.current();
      if (waiting !== null && a.pendingIdc === waiting.idc) {
        return { status: "scheduled before", idc: waiting.idc, takesEffectInEpoch: a.pendingFrom, note: "the rotation is scheduled: the first snapshot from that epoch puts the new identity commitment in force; the secret in force proves until then" };
      }
      if (inForce === null || a.idc !== inForce.idc) {
        throw new Error("the vault's identity commitment in force is not this agent's secret's: reputation_snapshot schedules this agent's (after the cooldown); nothing was drawn");
      }
      const head = await this.#head();
      const base = await this.#baseOf(rep.address);
      const epoch = repEpochAt(base, head.timestamp);
      const from = BigInt(a.idcFrom) + REP_ROTATION_COOLDOWN;
      if (epoch + 1n < from) {
        throw new Error(
          `the identity commitment in force took effect in epoch ${a.idcFrom}; OstraReputation lets a new one take effect from epoch ${from} only (${REP_ROTATION_COOLDOWN} epochs later), and a rotation takes effect in the epoch after its snapshot: rotate from epoch ${from - 1n} (it is epoch ${epoch}); nothing was drawn or signed`,
        );
      }
      if (a.lastEpochPlusOne === Number(epoch) + 1) {
        throw new Error(`the vault was snapshotted in epoch ${epoch} already, and a rotation goes with a snapshot (one per epoch): rotate from epoch ${epoch + 1n} (it then takes effect in epoch ${epoch + 2n}); nothing was drawn or signed`);
      }
      const state = await this.#state(vault);
      if (state.pending !== null && state.pending.idc !== (waiting?.idc ?? "") && BigInt(state.pending.epoch) >= epoch) {
        throw new Error(`a snapshot approval for epoch ${state.pending.epoch} is waiting (the withdrawal lock): send it with reputation_snapshot first, then rotate from the next epoch; nothing was drawn or signed`);
      }
      const next = await this.#keys.beginRotation();
      const snap = await this.#snapshot();
      return {
        status: snap.status === "snapshotted" ? "scheduled" : String(snap.status),
        idc: next.idc,
        takesEffectInEpoch: snap.status === "snapshotted" ? (epoch + 1n).toString() : `the epoch after ${String(snap.epoch)}`,
        snapshot: snap,
        note: "the new reputation secret is kept beside the one in force, which proves for this vault's leaves until the new identity commitment is in force (the first snapshot from that epoch); then the old secret is removed. Calling rotate again carries on with the same new secret",
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Prove
  // -------------------------------------------------------------------------------------------------------------

  /** The thresholds of `t` (the age in days turned into maxFirstDay at `day`). */
  static thresholds(t: ThresholdsInput, day: bigint): RepThresholds {
    const age = t.minAgeDays ?? REP_DEFAULT_MIN_AGE_DAYS;
    if (!Number.isSafeInteger(age) || age < 0) throw new RangeError("minAgeDays is a whole number of days");
    let maxFirstDay: number;
    if (t.maxFirstDay !== undefined) maxFirstDay = t.maxFirstDay;
    else {
      const m = day - BigInt(age);
      if (m < 0n) throw new RangeError(`no record is ${age} days old yet: OstraReputation's first day is ${day} days ago (ask a smaller minAgeDays, or prove later); nothing was proven`);
      maxFirstDay = Number(m);
    }
    const out: RepThresholds = {
      minCompleted: t.minCompleted ?? 0,
      minClients: t.minClients ?? 0,
      minVolume: t.minVolume === undefined ? 0n : parseTokenAmount(t.minVolume),
      maxFailPermille: t.maxFailPermille ?? 1000,
      minTier: t.minTier ?? 0,
      maxFirstDay,
    };
    const problem = repThresholdsProblem(out);
    if (problem !== null) throw new RangeError(`thresholds out of range: ${problem}`);
    return out;
  }

  /**
   * Proves that the USDG vault's record of this epoch meets `thresholds`, for `recipient` and `challenge` under the
   * verifier's `scope` (the epoch in it unless includeEpoch is false). Refused below the anonymity set's minimum.
   */
  prove(a: { scope: string; includeEpoch?: boolean; recipient: Address; challenge: string; thresholds?: ThresholdsInput }): Promise<Record<string, unknown>> {
    return this.#serial(() => this.#proveNow(a));
  }

  async #proveNow(a: { scope: string; includeEpoch?: boolean; recipient: Address; challenge: string; thresholds?: ThresholdsInput }): Promise<Record<string, unknown> & { proof: Hex; root: Hex; pseudonym: Hex; epoch: string; thresholds: RepThresholds; anonymitySet: number }> {
    const rep = this.#rep();
    const prover = this.#prover();
    const challenge = hex32(a.challenge, "challenge");
    const recipient = getAddress(a.recipient);
    const vault = getAddress(await this.#p.buyer.vaultAddress());
    // No read of the vault's own state here (its account, its approvals): the keys were settled by snapshot and status.
    if ((await this.#keys.current()) === null) throw new Error("this agent has no reputation secret yet: reputation_snapshot first; nothing was proven");
    const head = await this.#logsHead();
    const base = await this.#baseOf(rep.address);
    const epoch = repEpochAt(base, head.timestamp);
    const day = repDayAt(base, head.timestamp);
    const t = ReputationService.thresholds(a.thresholds ?? {}, day);
    const entries = await readRepEpoch(this.#p.client, this.#logs(), rep, epoch, head.number);
    const mine = entries.find((e) => e.vault === vault);
    if (mine === undefined) throw new Error(`this agent's USDG vault ${vault} has no snapshot in epoch ${epoch}: reputation_snapshot first; nothing was proven`);
    // The secret whose idc the leaf carries: the one in force here, or (a rotation's) the one waiting.
    let sk: Hex | null = null;
    for (const k of [await this.#keys.current(), await this.#keys.next()]) {
      if (k !== null && (await repLeaf(prover, mine.record, k.idc)).leaf === mine.leaf) {
        sk = k.sk;
        break;
      }
    }
    if (sk === null) throw new Error(`the vault's leaf of epoch ${epoch} carries another identity commitment than this agent's secrets (a new one takes effect from the epoch after its snapshot; reputation_snapshot status settles a rotation): nothing was proven`);
    const later = entries.length - 1 - mine.index;
    if (later < REP_MIN_LATER_LEAVES) {
      throw new Error(
        `only ${later} vault${later === 1 ? "" : "s"} snapshotted after this one in epoch ${epoch}: a proof waits for ${REP_MIN_LATER_LEAVES} (${REP_MIN_LATER_LEAVES - later} more), or its leaf would be among the newest under the root it proves against, which points to it; prove later this epoch; nothing was proven`,
      );
    }
    if (!repMeets(mine.record, t)) {
      throw new RangeError(`the vault's record of epoch ${epoch} (${JSON.stringify(recordView(mine.record))}) does not meet the thresholds (${JSON.stringify(thresholdsView(t))}); nothing was proven`);
    }
    const last = entries[entries.length - 1] as RepEntry;
    const root = last.root;
    const size = (await this.#p.client.readContract({ address: rep.address, abi: ostraReputationAbi, functionName: "rootSize", args: [root], blockNumber: head.number })) as bigint;
    if (size !== BigInt(entries.length)) throw new Error(`OstraReputation counts ${size} leaves under the latest root, the logs ${entries.length}`);
    const scope = repScope(a.scope, a.includeEpoch === false ? null : epoch);
    // The anonymity set: this statement, and every one proven before under this scope.
    const all = (await this.#read<Record<string, Statement[]>>(SCOPES)) ?? {};
    const before = all[scope] ?? [];
    const statements: { entries: readonly RepEntry[]; thresholds: RepThresholds }[] = [{ entries, thresholds: t }];
    const trees = new Map<string, RepEntry[]>([[epoch.toString(), entries]]);
    for (const s of before) {
      let tree = trees.get(s.epoch);
      if (tree === undefined) {
        tree = await readRepEpoch(this.#p.client, this.#logs(), rep, BigInt(s.epoch), head.number);
        trees.set(s.epoch, tree);
      }
      statements.push({ entries: tree.slice(0, s.count), thresholds: thresholdsOf(s.thresholds) });
    }
    const set = repAnonymitySet(statements);
    if (!set.includes(vault)) throw new Error("this vault is not in its own statement's anonymity set (an earlier statement of this scope it did not meet): nothing was proven");
    if (set.length < REP_MIN_ANONYMITY) {
      throw new Error(
        `only ${set.length} vault${set.length === 1 ? "" : "s"} in epoch ${epoch}'s tree meet${set.length === 1 ? "s" : ""} this statement${before.length === 0 ? "" : ` and the ${before.length} proven before under this scope`}: a proof needs at least ${REP_MIN_ANONYMITY} (k), or it would show which vault; ask less, or prove later when more vaults have snapshotted; nothing was proven`,
      );
    }
    const bindHash = repBindHash(scope, recipient, challenge);
    const { root: pathRoot, path } = await repPath(prover, entries.map((e) => e.leaf), mine.index);
    if (pathRoot !== root) throw new Error("the tree rebuilt here does not lead to the root OstraReputation recorded");
    const proof = await repProve(prover, { sk, record: mine.record, index: mine.index, path, root, scope, thresholds: t, bindHash, epoch });
    all[scope] = [...before, { epoch: epoch.toString(), count: entries.length, thresholds: thresholdsRecord(t), at: Math.floor(Date.now() / 1000) }];
    await this.#write(SCOPES, all);
    return {
      scope: a.scope,
      includeEpoch: a.includeEpoch !== false,
      scopeHash: scope,
      epoch: epoch.toString(),
      recipient,
      challenge,
      root,
      pseudonym: proof.pseudonym,
      thresholds: t,
      thresholdsShown: thresholdsView(t),
      anonymitySet: set.length,
      rootSize: entries.length,
      statementsInScope: before.length + 1,
      verifiedByProver: true,
      publicValues: proof.publicValues.map(String),
      proof: proof.proof,
      validUntil: new Date(Number(repEpochStart(base, epoch + 1n)) * 1000).toISOString(),
    };
  }

  /**
   * The reputation proof backing the agent's Ostrapad listing `file` (its registration file with the Ostrapad entry,
   * before the proof is put in it): the one listings scope `ostrapad:listings` in this epoch, recipient the provider
   * vault (the USDG vault), challenge the listing's content (padListingChallenge). It shows "backed by an Ostra record
   * meeting these thresholds that backs no other listing this epoch": the index shows it only while this record's
   * pseudonym backs that one listing. The proof is pinned in parts with `upload`;
   * the entry to put in the listing's Ostrapad entry (as `reputation`) is returned.
   */
  listingProof(a: { agentId: bigint; file: Record<string, unknown>; thresholds?: ThresholdsInput; upload: (file: Record<string, unknown>) => Promise<string>; pad?: Address }): Promise<{ entry: PadReputation; anonymitySet: number; epoch: string; thresholds: Record<string, string | number> }> {
    return this.#serial(async () => {
      const rep = this.#rep();
      const pad = getAddress(a.pad ?? OSTRAPAD);
      const vault = getAddress(await this.#p.buyer.vaultAddress());
      const challenge = padListingChallenge(a.file, pad, this.#p.config.chainId);
      const p = await this.#proveNow({ scope: PAD_LISTINGS_SCOPE_TEXT, recipient: vault, challenge, ...(a.thresholds === undefined ? {} : { thresholds: a.thresholds }) });
      const uris: string[] = [];
      for (const part of padReputationProofParts(p.proof)) {
        const uri = await a.upload(part);
        // The uploader pins the bytes JSON.stringify writes: its CID must name them.
        if (padDigestFromCid(uri) !== sha256(stringToHex(JSON.stringify(part)))) throw new Error(`the uploader answered ${uri} for a part of the proof, not the CID of its bytes; nothing was published`);
        uris.push(uri);
      }
      return {
        entry: padReputationEntry({ reputation: rep.address, chainId: this.#p.config.chainId, epoch: BigInt(p.epoch), root: p.root, pseudonym: p.pseudonym, thresholds: p.thresholds, proofParts: uris, proof: p.proof, anonymitySet: p.anonymitySet }),
        anonymitySet: p.anonymitySet,
        epoch: p.epoch,
        thresholds: thresholdsView(p.thresholds),
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Verify
  // -------------------------------------------------------------------------------------------------------------

  /**
   * A verifier's check of a proof: the scope text (the current epoch in it unless includeEpoch is false), thresholds,
   * recipient and challenge are the verifier's own; root, pseudonym and proof the prover's. Answers whether
   * OstraReputation verifies it now, how many leaves the root's tree held and how many of their vaults meet the
   * statement (its anonymity set).
   */
  async verify(a: { scope: string; includeEpoch?: boolean; recipient: Address; challenge: string; thresholds: ThresholdsInput; root: string; pseudonym: string; proof: string }): Promise<Record<string, unknown>> {
    const rep = this.#rep();
    if (!/^0x([0-9a-fA-F]{2})+$/.test(a.proof)) throw new RangeError("proof must be 0x and hex bytes");
    const root = hex32(a.root, "root");
    const pseudonym = hex32(a.pseudonym, "pseudonym");
    const challenge = hex32(a.challenge, "challenge");
    const head = await this.#logsHead();
    const base = await this.#baseOf(rep.address);
    const epoch = repEpochAt(base, head.timestamp);
    const t = ReputationService.thresholds(a.thresholds, repDayAt(base, head.timestamp));
    const scope = repScope(a.scope, a.includeEpoch === false ? null : epoch);
    const v = await repVerify(this.#p.client, rep.address, { root, pseudonym, scope, recipient: getAddress(a.recipient), challenge, thresholds: t, proof: a.proof as Hex }, head.number);
    // No verdict (too little gas for the verifier, a halted verifier, a failed read) is neither valid nor invalid.
    const out: Record<string, unknown> = {
      valid: v.unverifiable === null ? v.valid : null,
      ...(v.reverted === null ? {} : { refused: v.reverted }),
      ...(v.unverifiable === null ? {} : { couldNotVerify: v.unverifiable }),
      epoch: epoch.toString(),
      scopeHash: scope,
      thresholds: thresholdsView(t),
    };
    const rootEpoch = (await this.#p.client.readContract({ address: rep.address, abi: ostraReputationAbi, functionName: "rootEpochPlusOne", args: [root], blockNumber: head.number })) as bigint;
    if (rootEpoch !== 0n) {
      const entries = repEntriesAtRoot(await readRepEpoch(this.#p.client, this.#logs(), rep, rootEpoch - 1n, head.number), root);
      out.rootSize = entries.length;
      out.anonymitySet = repAnonymitySet([{ entries, thresholds: t }]).length;
    }
    out.note = v.unverifiable !== null
      ? "OstraReputation could not verify the proof now (no verdict either way): ask again"
      : v.valid
      ? "the proof holds now: a vault of this tree whose OstraPad record meets these thresholds made it for this recipient and challenge; keep its pseudonym per scope to refuse a second claim"
      : "the proof does not hold for these inputs now (a proof holds only in the epoch it was made in, against a root of that epoch's tree)";
    return out;
  }
}

function thresholdsRecord(t: RepThresholds): Record<string, string> {
  return { minCompleted: String(t.minCompleted), minClients: String(t.minClients), minVolume: t.minVolume.toString(), maxFailPermille: String(t.maxFailPermille), minTier: String(t.minTier), maxFirstDay: String(t.maxFirstDay) };
}

function thresholdsOf(r: Record<string, string>): RepThresholds {
  return { minCompleted: Number(r.minCompleted), minClients: Number(r.minClients), minVolume: BigInt(r.minVolume as string), maxFailPermille: Number(r.maxFailPermille), minTier: Number(r.minTier), maxFirstDay: Number(r.maxFirstDay) };
}

/** What became of a listing's reputation proof when its registration file was published again. */
export type CarriedReputation = { status: "none" | "regenerated" | "dropped"; epoch?: string; anonymitySet?: number; note: string };

/**
 * The listing's reputation proof carried into a new registration file (publish_profile rebuilds the file around
 * the kept Ostrapad entry, so the old proof's challenge no longer matches): when `file`'s Ostrapad entry carries a
 * proof of this deployment's OstraReputation made in the current epoch, the same statement (its thresholds exactly)
 * is proven again for the new content, same scope and epoch; when it cannot be (the record no longer meets it, fewer
 * than 5 vaults would, no prover), or the proof is of an epoch that ended, the file is published without it and the
 * answer says so. Returns the file to publish (`file` is not changed) and what happened.
 */
export async function carryListingReputation(p: {
  file: Record<string, unknown>;
  agentId: bigint | null;
  config: Config;
  client: PublicClient;
  prove: ((a: { agentId: bigint; file: Record<string, unknown>; thresholds: Record<string, unknown> }) => Promise<Record<string, unknown>>) | null;
  pad?: Address;
}): Promise<{ file: Record<string, unknown>; reputation: CarriedReputation }> {
  const pad = getAddress(p.pad ?? OSTRAPAD);
  const entry = padListingEntry(p.file, pad, p.config.chainId);
  if (entry === null || entry.reputation === undefined) return { file: p.file, reputation: { status: "none", note: "the listing carries no reputation proof" } };
  // The file without the proof: what is published when it is not carried, and what a new proof is made for.
  const bare = { ...entry };
  delete bare.reputation;
  const file = { ...p.file, services: (p.file.services as unknown[]).map((s) => (s === entry ? bare : s)) };
  const dropped = (note: string) => ({ file, reputation: { status: "dropped" as const, note: `${note}: the listing is published without a reputation proof (pad_publish with reputation proves it again)` } });
  const rep = p.config.deployment.reputation;
  const r = rep === undefined ? null : padReputationFromEntry(entry, rep.address, p.config.chainId);
  if (rep === undefined || r === null) return dropped("the listing's reputation proof is not one of this chain's OstraReputation");
  if (p.agentId === null) return dropped("the agent is not registered, so its listing's scope has no agent id");
  if (p.prove === null) return dropped("reputation proofs cannot be made here (no prover)");
  const epoch = (await p.client.readContract({ address: rep.address, abi: ostraReputationAbi, functionName: "currentEpoch" })) as bigint;
  if (r.parsed.epoch !== epoch) return dropped(`the listing's reputation proof was made for epoch ${r.parsed.epoch}, which ended (it is epoch ${epoch})`);
  const t = r.parsed.thresholds;
  try {
    const made = await p.prove({
      agentId: p.agentId,
      file,
      thresholds: { minCompleted: t.minCompleted, minClients: t.minClients, minVolume: formatTokenAmount(t.minVolume), maxFailPermille: t.maxFailPermille, minTier: t.minTier, maxFirstDay: t.maxFirstDay },
    });
    if (made.epoch !== epoch.toString()) return dropped(`the reputation proof made again is of epoch ${String(made.epoch)}, not ${epoch}`);
    const proven = { ...bare, reputation: made };
    return {
      file: { ...p.file, services: (p.file.services as unknown[]).map((s) => (s === entry ? proven : s)) },
      reputation: { status: "regenerated", epoch: epoch.toString(), ...(typeof made.anonymitySet === "number" ? { anonymitySet: made.anonymitySet } : {}), note: "the listing's reputation proof was made again for the new file (same statement, scope and epoch)" },
    };
  } catch (err) {
    return dropped(`the listing's reputation statement cannot be proven again now (${(err as Error).message.split("\n")[0]?.slice(0, 300)})`);
  }
}
