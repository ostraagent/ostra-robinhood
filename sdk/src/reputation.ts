// The reputation proof of an Ostra vault's OstraPad record (ostra-swap src/OstraReputation.sol, specified by Edu on
// 2 Nov 2026): an agent proves that the provider record of one of the Ostra vaults it controls meets a verifier's
// public thresholds, without showing which vault.
//
//   snapshot  the vault approves snapshotDigest(vault, idc, nonce, epoch) with an ApproveHash spend (EIP-1271) for the
//             epoch the approval is usable in, and anyone sends OstraReputation.snapshot(vault, idc): the contract reads
//             OstraPad's record of the vault and appends the leaf P(record || idc) to the tree of the current epoch,
//             once per vault and epoch. idc = P(sk || D_IDC..) is the vault's identity commitment from a
//             reputation-only secret sk (`ostra-prove secret`, never a private note's sk).
//   prove     `ostra-prove rep-prove` from the agent's sk, its leaf's record, its Merkle path in the epoch's tree
//             (rebuilt from the Snapshot and Recorded events, in index order) and the verifier's scope, thresholds and
//             bind; the epoch is the current one and the root a root of the current epoch's tree (latestRoot).
//   verify    OstraReputation.verify, a view: an eth_call answers whether a proof holds.
//
// Everything here is computed exactly as the contract computes it (the snapshot digest, the tier, the clamped
// record, the scope elements, the bind and the 43 public values; sdk/test/reputation.test.ts checks them against a
// vector from the Foundry build), so that nothing the agent approves or proves is taken from someone else. Poseidon2
// (idc, record, leaf, the tree and the proof) is the prover's: the RepProver runs ostra-prove's commands, as the CLI
// binary or its WebAssembly build (@ostraagent/swap cli-prover.ts and wasm-prover.ts, whose Prover passes any command
// through).
//
// The scope a verifier names is text: its bytes32 is keccak256 of that text, and by default the epoch is part of it
// (repScope(text, epoch) = keccak256(`${text}:${epoch}`)), so a vault has exactly one pseudonym per scope and epoch.
// The bind ties a proof to who it is for and the verifier's fresh challenge: keccak256(abi.encode(scope, recipient,
// challenge)).

import { decodeErrorResult, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, stringToHex, toHex, type Address, type Hex, type PublicClient } from "viem";
import type { ReputationDeployment } from "./deployment.ts";
import { getLogsChunked } from "./morpho.ts";
import { ostraReputationAbi } from "./reputation-abi.ts";

export { ostraReputationAbi } from "./reputation-abi.ts";

/** KoalaBear, the field of the reputation circuit (the spend circuit's). */
export const REP_FIELD_P = 2130706433n;
/** Leaves per epoch tree (CommitmentTree): depth 20. */
export const REP_TREE_DEPTH = 20;
/** OstraReputation.SNAPSHOT_DOMAIN. */
export const REP_SNAPSHOT_DOMAIN: Hex = keccak256(stringToHex("OstraReputation.snapshot.v1"));
/** OstraReputation.EPOCH_LENGTH and DAY, in seconds. */
export const REP_EPOCH_SECONDS = 604_800n;
export const REP_DAY_SECONDS = 86_400n;
/** OstraReputation.COUNT_MAX (completed and clients are clamped to it) and FAIL_LIMIT (a record with as many rejected or expired jobs is refused). */
export const REP_COUNT_MAX = (1 << 19) - 1;
export const REP_FAIL_LIMIT = 1 << 16;
/** OstraReputation.ROTATION_COOLDOWN: epochs an idc stays in force before another may take effect. */
export const REP_ROTATION_COOLDOWN = 4n;
/** Reputation.THRESHOLD_LIMIT (minCompleted, minClients and maxFirstDay are below it), PERMILLE and MAX_TIER. */
export const REP_THRESHOLD_LIMIT = 1 << 29;
export const REP_PERMILLE = 1000;
export const REP_MAX_TIER = 3;
/** Reputation's widths of firstDay and epoch. */
export const REP_DAY_LIMIT = 1 << 29;
export const REP_EPOCH_LIMIT = 1 << 30;
/** The domain constants of the identity commitment, the scope and the record (RepConstants.sol, circuit/src/rep.rs). */
export const REP_D_IDC = 0x20494443n;
export const REP_D_SCOPE = 0x20534350n;
export const REP_D_REC = 0x20524543n;
/** The public values of a reputation proof. */
export const REP_PUBLIC_VALUES = 43;
/**
 * The smallest anonymity set an agent proves with (k): fewer vaults than this in the tree that meet the statement (and
 * every earlier statement of the same scope) and the proof is refused before it is made.
 */
export const REP_MIN_ANONYMITY = 5;
/**
 * Leaves of other vaults an agent waits for after its own leaf in the epoch's tree before it proves (k - 1): proving
 * right after its own snapshot, its leaf would be the newest under the latest root, which points to it.
 */
export const REP_MIN_LATER_LEAVES = REP_MIN_ANONYMITY - 1;
/** The time before an epoch's end within which an approval and a snapshot are not sent together (they could land in the next epoch, where the approval no longer holds). */
export const REP_SNAPSHOT_END_MARGIN_SECONDS = 600n;
/** The record age an agent's statement requires by default: its vault's first snapshot at least this many days old. */
export const REP_DEFAULT_MIN_AGE_DAYS = 30;

const MAX_UINT128 = (1n << 128n) - 1n;

// ---------------------------------------------------------------------------------------------
// Digests (8 field elements in a bytes32, element i in bits [32 i, 32 i + 32), as Notes.sol packs them)
// ---------------------------------------------------------------------------------------------

export type RepDigest = Hex;

export function repPackDigest(elements: readonly (string | number | bigint)[]): RepDigest {
  if (elements.length !== 8) throw new Error("a digest has 8 field elements");
  let v = 0n;
  elements.forEach((e, i) => {
    const x = BigInt(e);
    if (x < 0n || x >= REP_FIELD_P) throw new Error("a digest element is not below P");
    v |= x << BigInt(32 * i);
  });
  return toHex(v, { size: 32 });
}

/** The 8 elements of a digest, as the decimal strings ostra-prove takes. */
export function repUnpackDigest(d: RepDigest): string[] {
  if (!/^0x[0-9a-fA-F]{64}$/.test(d)) throw new Error("a digest is 32 bytes");
  const v = BigInt(d);
  return Array.from({ length: 8 }, (_, i) => {
    const x = (v >> BigInt(32 * i)) & 0xffffffffn;
    if (x >= REP_FIELD_P) throw new Error("a digest element is not below P");
    return x.toString();
  });
}

/** Poseidon2.isCanonical: every element of the packed digest below P. */
export function repIsCanonical(d: Hex): boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(d)) return false;
  const v = BigInt(d);
  for (let i = 0; i < 8; i++) if (((v >> BigInt(32 * i)) & 0xffffffffn) >= REP_FIELD_P) return false;
  return true;
}

function word(value: Hex, name: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new RangeError(`${name} must be 32 bytes (0x and 64 hex digits)`);
  return value.toLowerCase() as Hex;
}

// ---------------------------------------------------------------------------------------------
// What the contract computes
// ---------------------------------------------------------------------------------------------

/** OstraReputation.snapshotDigest(vault, idc, nonce, epoch) on `chainId` at `reputation`: what the vault approves. */
export function repSnapshotDigest(p: { chainId: number; reputation: Address; vault: Address; idc: Hex; nonce: bigint; epoch: bigint }): Hex {
  if (p.nonce < 0n || p.epoch < 0n) throw new RangeError("the nonce and the epoch are not negative");
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [REP_SNAPSHOT_DOMAIN, BigInt(p.chainId), getAddress(p.reputation), getAddress(p.vault), word(p.idc, "idc"), p.nonce, p.epoch],
    ),
  );
}

/** OstraReputation.currentEpoch at block time `timestamp`, for a contract deployed at `base` (its BASE). */
export function repEpochAt(base: bigint, timestamp: bigint): bigint {
  if (timestamp < base) throw new RangeError("the time is before OstraReputation's BASE");
  return (timestamp - base) / REP_EPOCH_SECONDS;
}

/** The day (since BASE) of block time `timestamp`: what a first snapshot writes as firstDay. */
export function repDayAt(base: bigint, timestamp: bigint): bigint {
  if (timestamp < base) throw new RangeError("the time is before OstraReputation's BASE");
  return (timestamp - base) / REP_DAY_SECONDS;
}

/** The first second of `epoch`; the epoch ends (exclusive) at repEpochStart(base, epoch + 1). */
export function repEpochStart(base: bigint, epoch: bigint): bigint {
  if (epoch < 0n) throw new RangeError("an epoch is not negative");
  return base + epoch * REP_EPOCH_SECONDS;
}

/**
 * When a snapshot approved now can be sent, for a vault whose ApproveHash approvals take effect `delay` seconds after
 * they land (its withdrawal lock's delay, 0 without the lock): the approval is for `epoch`, the epoch it is usable in
 * once it takes effect plus `margin` seconds (time for the approval to land, and for the snapshot to be sent before
 * that epoch ends), and the snapshot can be sent from `sendableFrom` (the later of the approval taking effect and that
 * epoch's start) until `sendableUntil` (exclusive, that epoch's end). `now` is the latest block's time.
 */
export function repApprovalPlan(p: { base: bigint; now: bigint; delay: bigint; margin: bigint }): { epoch: bigint; validFrom: bigint; sendableFrom: bigint; sendableUntil: bigint } {
  if (p.delay < 0n || p.margin < 0n) throw new RangeError("the delay and the margin are not negative");
  const validFrom = p.now + p.delay;
  const epoch = repEpochAt(p.base, validFrom + p.margin);
  const start = repEpochStart(p.base, epoch);
  return { epoch, validFrom, sendableFrom: validFrom > start ? validFrom : start, sendableUntil: repEpochStart(p.base, epoch + 1n) };
}

/** OstraPad's provider record as OstraReputation reads it (provider(address)). */
export type RepPadRecord = { completed: number | bigint; clients: number | bigint; volume: bigint; rejected: number | bigint; expired: number | bigint };

/** OstraReputation.tierOf: OstraPad's limitOf tier without the bond (3: 500 USDG, 2: 100, 1: 25, 0: 5). */
export function repTierOf(r: RepPadRecord): number {
  const completed = BigInt(r.completed);
  const clients = BigInt(r.clients);
  const rejected = BigInt(r.rejected);
  const done = completed + rejected;
  const v = r.volume;
  if (completed >= 200n && clients >= 50n && v >= 10_000_000_000n && rejected * 100n < done * 5n) return 3;
  if (completed >= 50n && clients >= 20n && v >= 1_000_000_000n && rejected * 100n < done * 10n) return 2;
  if (completed >= 10n && clients >= 5n && v >= 100_000_000n && rejected * 100n < done * 20n) return 1;
  return 0;
}

/** A record as OstraReputation writes it into a leaf (clamped), and as rep-record and rep-prove take it. */
export type RepRecord = { completed: number; clients: number; volume: bigint; rejected: number; expired: number; tier: number; firstDay: number; epoch: number };

/**
 * The record OstraReputation writes for OstraPad's record `r` (OstraReputation._record): completed and clients clamped
 * to REP_COUNT_MAX, the tier without the bond. Throws as the contract reverts (RecordTooLarge) when rejected or expired
 * is REP_FAIL_LIMIT or more.
 */
export function repRecordOf(r: RepPadRecord, firstDay: number | bigint, epoch: number | bigint): RepRecord {
  const rejected = BigInt(r.rejected);
  const expired = BigInt(r.expired);
  if (rejected >= BigInt(REP_FAIL_LIMIT) || expired >= BigInt(REP_FAIL_LIMIT)) throw new RangeError(`a record with ${REP_FAIL_LIMIT} or more rejected or expired jobs is refused (RecordTooLarge)`);
  const clamp = (x: number | bigint) => (BigInt(x) > BigInt(REP_COUNT_MAX) ? REP_COUNT_MAX : Number(x));
  if (r.volume < 0n || r.volume > MAX_UINT128) throw new RangeError("the volume is a uint128");
  const out: RepRecord = { completed: clamp(r.completed), clients: clamp(r.clients), volume: r.volume, rejected: Number(rejected), expired: Number(expired), tier: repTierOf(r), firstDay: Number(firstDay), epoch: Number(epoch) };
  if (out.firstDay < 0 || out.firstDay >= REP_DAY_LIMIT || out.epoch < 0 || out.epoch >= REP_EPOCH_LIMIT) throw new RangeError("firstDay or epoch is out of range");
  return out;
}

/** Why a record is not one OstraReputation writes (Reputation.recordHash's ranges), or null. */
export function repRecordProblem(r: RepRecord): string | null {
  const int = (x: number) => Number.isSafeInteger(x) && x >= 0;
  if (![r.completed, r.clients, r.rejected, r.expired, r.tier, r.firstDay, r.epoch].every(int)) return "every record field is a whole number";
  if (r.completed > REP_COUNT_MAX || r.clients > REP_COUNT_MAX) return "completed and clients are at most 2^19 - 1";
  if (r.rejected >= REP_FAIL_LIMIT || r.expired >= REP_FAIL_LIMIT) return "rejected and expired are below 2^16";
  if (r.tier > REP_MAX_TIER) return "the tier is 0 to 3";
  if (r.firstDay >= REP_DAY_LIMIT || r.epoch >= REP_EPOCH_LIMIT) return "firstDay is below 2^29 and the epoch below 2^30";
  if (r.volume < 0n || r.volume > MAX_UINT128) return "the volume is a uint128";
  return null;
}

/** What a verifier asks of a record (Reputation.Thresholds). */
export type RepThresholds = { minCompleted: number; minClients: number; minVolume: bigint; maxFailPermille: number; minTier: number; maxFirstDay: number };

/** Why `t` is outside the ranges where the circuit's comparisons are exact (Reputation.thresholdsInRange), or null. */
export function repThresholdsProblem(t: RepThresholds): string | null {
  const int = (x: number) => Number.isSafeInteger(x) && x >= 0;
  if (![t.minCompleted, t.minClients, t.maxFailPermille, t.minTier, t.maxFirstDay].every(int)) return "every threshold is a whole number, not negative";
  if (t.minCompleted >= REP_THRESHOLD_LIMIT || t.minClients >= REP_THRESHOLD_LIMIT || t.maxFirstDay >= REP_THRESHOLD_LIMIT) return "minCompleted, minClients and maxFirstDay are below 2^29";
  if (t.maxFailPermille > REP_PERMILLE) return "maxFailPermille is at most 1000";
  if (t.minTier > REP_MAX_TIER) return "minTier is 0 to 3";
  if (t.minVolume < 0n || t.minVolume > MAX_UINT128) return "minVolume is a uint128";
  return null;
}

/** maxFailPermille (completed + f) - 1000 f - 1 over the integers, f = rejected + expired (the circuit's strict fail ratio). */
export function repFailMargin(r: RepRecord, t: RepThresholds): bigint {
  const f = BigInt(r.rejected) + BigInt(r.expired);
  return BigInt(t.maxFailPermille) * (BigInt(r.completed) + f) - BigInt(REP_PERMILLE) * f - 1n;
}

/**
 * Whether `r` meets `t` (circuit/src/rep.rs meets). The fail ratio is strict: a record with no counted job (no
 * completed, rejected or expired job) meets no thresholds at all.
 */
export function repMeets(r: RepRecord, t: RepThresholds): boolean {
  return r.completed >= t.minCompleted && r.clients >= t.minClients && r.volume >= t.minVolume && repFailMargin(r, t) >= 0n && r.tier >= t.minTier && r.firstDay <= t.maxFirstDay;
}

/**
 * The bytes32 scope of a verifier's scope text: keccak256 of the text, with `:<epoch>` appended when `epoch` is given
 * (the default of the tools: one pseudonym per vault, scope and epoch). Text of 1 to 200 characters, no control characters.
 */
export function repScope(text: string, epoch: bigint | number | null): Hex {
  if (typeof text !== "string" || text.length === 0 || text.length > 200) throw new RangeError("a scope is 1 to 200 characters");
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new RangeError("a scope must not hold control characters");
  if (epoch === null) return keccak256(stringToHex(text));
  const e = BigInt(epoch);
  if (e < 0n) throw new RangeError("an epoch is not negative");
  return keccak256(stringToHex(`${text}:${e.toString()}`));
}

/** Reputation.scopeElements: D_SCOPE, then bits [30 (i - 1), 30 i) of keccak256(abi.encode(scope)), i = 1..7. */
export function repScopeElements(scope: Hex): bigint[] {
  const h = BigInt(keccak256(word(scope, "scope")));
  return [REP_D_SCOPE, ...Array.from({ length: 7 }, (_, i) => (h >> BigInt(30 * i)) & 0x3fffffffn)];
}

/** OstraReputation.bindHash(scope, recipient, challenge) (Reputation.bindHash). */
export function repBindHash(scope: Hex, recipient: Address, challenge: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }], [word(scope, "scope"), getAddress(recipient), word(challenge, "challenge")]));
}

/** Notes.amountLimbs: five 26-bit limbs, limb 0 lowest. */
export function repAmountLimbs(a: bigint): bigint[] {
  if (a < 0n || a > MAX_UINT128) throw new RangeError("an amount is a uint128");
  return Array.from({ length: 5 }, (_, i) => (a >> BigInt(26 * i)) & ((1n << 26n) - 1n));
}

/**
 * Reputation.publicValues: the 43 public values OstraReputation hands RepVerifier, in the circuit's order: root (8),
 * pseudonym (8), scope (8), bind (8), epoch, minCompleted, minClients, minVolume (5), maxFailPermille, minTier, maxFirstDay.
 */
export function repPublicValues(root: Hex, pseudonym: Hex, scope: Hex, bindHash: Hex, epoch: bigint, t: RepThresholds): bigint[] {
  const problem = repThresholdsProblem(t);
  if (problem !== null) throw new RangeError(`thresholds out of range: ${problem}`);
  if (epoch < 0n || epoch >= BigInt(REP_EPOCH_LIMIT)) throw new RangeError("epoch out of range");
  const words = (d: Hex) => Array.from({ length: 8 }, (_, i) => (BigInt(word(d, "digest")) >> BigInt(32 * i)) & 0xffffffffn);
  const b = BigInt(word(bindHash, "bindHash"));
  return [
    ...words(root),
    ...words(pseudonym),
    ...repScopeElements(scope),
    ...Array.from({ length: 8 }, (_, i) => (b >> BigInt(32 * i)) & 0x3fffffffn),
    epoch,
    BigInt(t.minCompleted),
    BigInt(t.minClients),
    ...repAmountLimbs(t.minVolume),
    BigInt(t.maxFailPermille),
    BigInt(t.minTier),
    BigInt(t.maxFirstDay),
  ];
}

// ---------------------------------------------------------------------------------------------
// The prover
// ---------------------------------------------------------------------------------------------

/** The ostra-prove commands a reputation needs. */
export type RepProverCommand = "secret" | "path" | "rep-id" | "rep-record" | "rep-prove";
/** One ostra-prove command: its JSON request (none for `secret`) and its JSON answer. */
export type RepProver = (command: RepProverCommand, request?: unknown) => Promise<unknown>;

function digestOf(v: unknown, what: string): RepDigest {
  if (!Array.isArray(v)) throw new Error(`ostra-prove gave no ${what}`);
  return repPackDigest(v as string[]);
}

function recordJson(r: RepRecord): Record<string, unknown> {
  const problem = repRecordProblem(r);
  if (problem !== null) throw new RangeError(`the record is not one OstraReputation writes: ${problem}`);
  return { completed: r.completed, clients: r.clients, volume: r.volume.toString(), rejected: r.rejected, expired: r.expired, tier: r.tier, first_day: r.firstDay, epoch: r.epoch };
}

function thresholdsJson(t: RepThresholds): Record<string, unknown> {
  const problem = repThresholdsProblem(t);
  if (problem !== null) throw new RangeError(`thresholds out of range: ${problem}`);
  return { min_completed: t.minCompleted, min_clients: t.minClients, min_volume: t.minVolume.toString(), max_fail_permille: t.maxFailPermille, min_tier: t.minTier, max_first_day: t.maxFirstDay };
}

/** A fresh random digest from the operating system: a reputation secret sk (`ostra-prove secret`). */
export async function repNewSecret(prover: RepProver): Promise<RepDigest> {
  return digestOf(((await prover("secret")) as { digest?: unknown }).digest, "digest");
}

/** The identity commitment of the reputation secret `sk` (`ostra-prove rep-id`). */
export async function repIdc(prover: RepProver, sk: RepDigest): Promise<RepDigest> {
  return digestOf(((await prover("rep-id", { sk: repUnpackDigest(sk) })) as { idc?: unknown }).idc, "idc");
}

/** The record digest and the leaf OstraReputation appends for `record` and `idc` (`ostra-prove rep-record`). */
export async function repLeaf(prover: RepProver, record: RepRecord, idc: RepDigest): Promise<{ record: RepDigest; leaf: RepDigest }> {
  const r = (await prover("rep-record", { record: recordJson(record), idc: repUnpackDigest(idc) })) as { record?: unknown; leaf?: unknown };
  return { record: digestOf(r.record, "record"), leaf: digestOf(r.leaf, "leaf") };
}

/** The root of `leaves` (in index order) and the Merkle path of leaf `index` (`ostra-prove path`, CommitmentTree's). */
export async function repPath(prover: RepProver, leaves: readonly RepDigest[], index: number): Promise<{ root: RepDigest; path: string[][] }> {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new RangeError("the index is beyond the leaves");
  const r = (await prover("path", { leaves: leaves.map(repUnpackDigest), index })) as { root?: unknown; path?: unknown };
  const root = digestOf(r.root, "root");
  if (!Array.isArray(r.path) || r.path.length !== REP_TREE_DEPTH) throw new Error("ostra-prove gave no path");
  return { root, path: r.path as string[][] };
}

/** A reputation proof and what it shows. */
export type RepProof = { proof: Hex; publicValues: bigint[]; pseudonym: RepDigest; idc: RepDigest; root: RepDigest; epoch: bigint; scope: Hex; bindHash: Hex; thresholds: RepThresholds };

/**
 * Proves that the leaf at `index` of the tree whose root is `root` holds `record` and the idc of `sk`, and that the
 * record meets `thresholds`, for `scope` and `bindHash` (`ostra-prove rep-prove`). The proof's public values are
 * checked to be the ones OstraReputation hands the verifier (repPublicValues).
 */
export async function repProve(
  prover: RepProver,
  q: { sk: RepDigest; record: RepRecord; index: number; path: string[][]; root: RepDigest; scope: Hex; thresholds: RepThresholds; bindHash: Hex; epoch: bigint },
): Promise<RepProof> {
  if (BigInt(q.record.epoch) !== q.epoch) throw new RangeError("the record is not of the proof's epoch");
  if (!repMeets(q.record, q.thresholds)) throw new RangeError("the record does not meet the thresholds");
  const out = (await prover("rep-prove", {
    sk: repUnpackDigest(q.sk),
    record: recordJson(q.record),
    epoch: Number(q.epoch),
    index: q.index,
    path: q.path,
    root: repUnpackDigest(q.root),
    scope: word(q.scope, "scope"),
    thresholds: thresholdsJson(q.thresholds),
    bind_hash: word(q.bindHash, "bindHash"),
  })) as { proof?: unknown; public_values?: unknown; pseudonym?: unknown; idc?: unknown };
  if (typeof out.proof !== "string" || !/^0x[0-9a-f]*$/.test(out.proof) || !Array.isArray(out.public_values) || out.public_values.length !== REP_PUBLIC_VALUES) throw new Error("ostra-prove gave no reputation proof");
  const pseudonym = digestOf(out.pseudonym, "pseudonym");
  const pv = (out.public_values as string[]).map((x) => BigInt(x));
  const want = repPublicValues(q.root, pseudonym, q.scope, q.bindHash, q.epoch, q.thresholds);
  if (want.some((x, i) => x !== pv[i])) throw new Error("the proof's public values are not the ones OstraReputation hands the verifier");
  return { proof: out.proof as Hex, publicValues: pv, pseudonym, idc: digestOf(out.idc, "idc"), root: q.root, epoch: q.epoch, scope: word(q.scope, "scope"), bindHash: word(q.bindHash, "bindHash"), thresholds: q.thresholds };
}

// ---------------------------------------------------------------------------------------------
// The epoch trees, from the contract's events
// ---------------------------------------------------------------------------------------------

/** One leaf of an epoch's tree: the vault it is, its index, the leaf, the root after it and the record it holds. */
export type RepEntry = { vault: Address; epoch: bigint; index: number; leaf: RepDigest; root: RepDigest; record: RepRecord; blockNumber: bigint; logIndex: number };

/** A Snapshot log and a Recorded log as read (viem's decoded args). */
export type RepSnapshotLog = { args: { vault: Address; epoch: bigint; leaf: Hex; index: bigint; root: Hex }; transactionHash: Hex; blockNumber: bigint; logIndex: number };
export type RepRecordedLog = {
  args: { vault: Address; epoch: bigint; completed: bigint; clients: bigint; volume: bigint; rejected: bigint; expired: bigint; tier: bigint; firstDay: bigint };
  transactionHash: Hex;
  blockNumber: bigint;
  logIndex: number;
};

const snapshotEvent = ostraReputationAbi.find((x) => x.type === "event" && x.name === "Snapshot") as Extract<(typeof ostraReputationAbi)[number], { type: "event"; name: "Snapshot" }>;
const recordedEvent = ostraReputationAbi.find((x) => x.type === "event" && x.name === "Recorded") as Extract<(typeof ostraReputationAbi)[number], { type: "event"; name: "Recorded" }>;

/**
 * The entries of epoch trees from their Snapshot and Recorded logs: each Snapshot paired with the Recorded log the same
 * snapshot emitted right after it (same transaction, next log, same vault and epoch), in index order per epoch, every
 * index from 0 on present once (a log given twice is taken once). Throws on logs that do not add up to that.
 */
export function repEntriesFromLogs(snapshots: readonly RepSnapshotLog[], recorded: readonly RepRecordedLog[]): Map<bigint, RepEntry[]> {
  const epochs = new Map<bigint, Map<number, RepEntry>>();
  for (const e of repEntriesOfLogs(snapshots, recorded)) {
    const index = e.index;
    let m = epochs.get(e.epoch);
    if (m === undefined) epochs.set(e.epoch, (m = new Map()));
    const seen = m.get(index);
    if (seen !== undefined) {
      if (seen.leaf !== e.leaf || seen.root !== e.root || seen.vault !== e.vault) throw new Error(`two different leaves at index ${index} of epoch ${e.epoch}`);
      continue;
    }
    m.set(index, e);
  }
  const out = new Map<bigint, RepEntry[]>();
  for (const [epoch, m] of epochs) {
    const list = [...m.values()].sort((a, b) => a.index - b.index);
    list.forEach((e, i) => {
      if (e.index !== i) throw new Error(`epoch ${epoch}: leaf ${i} is missing from the logs`);
    });
    if (new Set(list.map((e) => e.vault)).size !== list.length) throw new Error(`epoch ${epoch}: a vault has two leaves (one snapshot per vault and epoch)`);
    out.set(epoch, list);
  }
  return out;
}

/**
 * Each Snapshot log with the Recorded log the same snapshot emitted right after it (same transaction, next log, same
 * vault and epoch), as entries in the order of `snapshots` (a transaction's receipt gives them too). Throws when one
 * has no such Recorded log.
 */
export function repEntriesOfLogs(snapshots: readonly RepSnapshotLog[], recorded: readonly RepRecordedLog[]): RepEntry[] {
  const byPlace = new Map<string, RepRecordedLog>();
  for (const r of recorded) byPlace.set(`${r.transactionHash.toLowerCase()}:${r.logIndex}`, r);
  return snapshots.map((s) => {
    const r = byPlace.get(`${s.transactionHash.toLowerCase()}:${s.logIndex + 1}`);
    if (r === undefined) throw new Error(`no Recorded log follows the Snapshot of ${s.args.vault} in ${s.transactionHash}`);
    if (getAddress(r.args.vault) !== getAddress(s.args.vault) || r.args.epoch !== s.args.epoch) throw new Error(`the Recorded log after the Snapshot in ${s.transactionHash} is another vault's or epoch's`);
    const record: RepRecord = {
      completed: Number(r.args.completed),
      clients: Number(r.args.clients),
      volume: r.args.volume,
      rejected: Number(r.args.rejected),
      expired: Number(r.args.expired),
      tier: Number(r.args.tier),
      firstDay: Number(r.args.firstDay),
      epoch: Number(r.args.epoch),
    };
    return { vault: getAddress(s.args.vault), epoch: s.args.epoch, index: Number(s.args.index), leaf: word(s.args.leaf, "leaf"), root: word(s.args.root, "root"), record, blockNumber: s.blockNumber, logIndex: s.logIndex };
  });
}

/** The entries of the tree when its root was `root`: the prefix up to the leaf whose Snapshot gave that root. */
export function repEntriesAtRoot(entries: readonly RepEntry[], root: Hex): RepEntry[] {
  const at = entries.findIndex((e) => e.root === root.toLowerCase());
  if (at < 0) throw new Error(`no leaf of the tree gave the root ${root}`);
  return entries.slice(0, at + 1);
}

/**
 * The anonymity set of a proof: the vaults of an epoch tree (up to the root proven against) whose records meet the
 * statement, intersected, for every earlier statement proven under the same scope, with the vaults that met that one
 * in its own tree (up to its root): a verifier that sees the same pseudonym twice in a scope knows the vault meets
 * both. Vaults are matched by address (each Snapshot names its vault).
 */
export function repAnonymitySet(statements: readonly { entries: readonly RepEntry[]; thresholds: RepThresholds }[]): Address[] {
  const [first, ...rest] = statements;
  if (first === undefined) return [];
  const meeting = (s: { entries: readonly RepEntry[]; thresholds: RepThresholds }): Set<Address> => new Set(s.entries.filter((e) => repMeets(e.record, s.thresholds)).map((e) => getAddress(e.vault)));
  let set = meeting(first);
  for (const s of rest) {
    const meet = meeting(s);
    set = new Set([...set].filter((v) => meet.has(v)));
  }
  return [...set].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
}

/** OstraReputation's state as an agent reads it. */
export type RepAccount = { idc: Hex; pendingIdc: Hex; pendingFrom: number; lastEpochPlusOne: number; firstDay: number; idcFrom: number };

export async function readRepAccount(client: PublicClient, rep: Address, vault: Address, blockNumber?: bigint): Promise<RepAccount> {
  const a = (await client.readContract({ address: rep, abi: ostraReputationAbi, functionName: "account", args: [getAddress(vault)], ...(blockNumber === undefined ? {} : { blockNumber }) })) as {
    idc: Hex;
    pendingIdc: Hex;
    pendingFrom: number;
    lastEpochPlusOne: number;
    firstDay: number;
    idcFrom: number;
  };
  return { idc: a.idc.toLowerCase() as Hex, pendingIdc: a.pendingIdc.toLowerCase() as Hex, pendingFrom: Number(a.pendingFrom), lastEpochPlusOne: Number(a.lastEpochPlusOne), firstDay: Number(a.firstDay), idcFrom: Number(a.idcFrom) };
}

/**
 * The tree of `epoch` as the logs of `rep` build it up to block `toBlock` (`logsClient`: an RPC serving wide
 * eth_getLogs), checked against the contract at that block (`client`): its treeSize and latestRoot.
 */
export async function readRepEpoch(client: PublicClient, logsClient: PublicClient, rep: ReputationDeployment, epoch: bigint, toBlock: bigint): Promise<RepEntry[]> {
  const q = { address: rep.address, args: { epoch }, fromBlock: BigInt(rep.fromBlock), toBlock, minSpan: 1_000n };
  const [snaps, recs] = await Promise.all([getLogsChunked(logsClient, { ...q, event: snapshotEvent }), getLogsChunked(logsClient, { ...q, event: recordedEvent })]);
  const entries = repEntriesFromLogs(snaps as unknown as RepSnapshotLog[], recs as unknown as RepRecordedLog[]).get(epoch) ?? [];
  const [size, latest] = await Promise.all([
    client.readContract({ address: rep.address, abi: ostraReputationAbi, functionName: "treeSize", args: [epoch], blockNumber: toBlock }) as Promise<bigint>,
    client.readContract({ address: rep.address, abi: ostraReputationAbi, functionName: "latestRoot", args: [epoch], blockNumber: toBlock }) as Promise<Hex>,
  ]);
  if (BigInt(entries.length) !== size) throw new Error(`OstraReputation's tree of epoch ${epoch} holds ${size} leaves at block ${toBlock}, the logs gave ${entries.length}`);
  const last = entries[entries.length - 1];
  if (last !== undefined && last.root !== latest.toLowerCase()) throw new Error(`OstraReputation's latest root of epoch ${epoch} is not the one the logs give`);
  return entries;
}

/** The snapshot call (anyone may send it once the vault's approval holds). */
export function repSnapshotCall(rep: Address, vault: Address, idc: Hex): { to: Address; data: Hex } {
  return { to: getAddress(rep), data: encodeFunctionData({ abi: ostraReputationAbi, functionName: "snapshot", args: [getAddress(vault), word(idc, "idc")] }) };
}

/** The name of OstraReputation's custom error in a failed call's revert data, or undefined. */
function revertName(err: unknown): string | undefined {
  for (let e = err as { data?: unknown; cause?: unknown } | undefined, i = 0; e !== undefined && e !== null && i < 8; e = e.cause as typeof e, i++) {
    const d = e.data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8}/.test(d)) {
      try {
        return decodeErrorResult({ abi: ostraReputationAbi, data: d as Hex }).errorName;
      } catch {
        return undefined;
      }
    }
    if (typeof d === "object" && d !== null && typeof (d as { errorName?: unknown }).errorName === "string") return (d as { errorName: string }).errorName;
  }
  return undefined;
}

/**
 * The execution gas every eth_call of OstraReputation.verify is given at least: above its VERIFY_GAS (12,000,000),
 * under which it reverts InsufficientGas. The call's gas is this plus the most its calldata can cost (21,000 and 16
 * a byte: a proof is about 81 KB), which the node takes before execution.
 */
export const REP_VERIFY_CALL_GAS = 13_000_000n;

/** The gas of an eth_call of OstraReputation.verify with calldata `data`: REP_VERIFY_CALL_GAS of execution and the most its calldata costs. */
export function repVerifyCallGas(data: Hex): bigint {
  return REP_VERIFY_CALL_GAS + 21_000n + 16n * BigInt((data.length - 2) / 2);
}

/**
 * OstraReputation.verify as an eth_call with repVerifyCallGas (or `gas`), one of:
 *   valid         the proof holds for these public inputs now;
 *   invalid       RepVerifier rejects the proof (valid false, both reasons null);
 *   refused       the contract refuses the inputs (`reverted`: UnknownRoot, not a root of the current epoch's tree;
 *                 NotCanonical; BadThresholds): a verdict on the inputs;
 *   unverifiable  no verdict at all (`unverifiable`: InsufficientGas, VerifierHalted, or a failed read): never to be
 *                 taken, shown or kept as invalid; ask again.
 */
export async function repVerify(
  client: PublicClient,
  rep: Address,
  q: { root: Hex; pseudonym: Hex; scope: Hex; recipient: Address; challenge: Hex; thresholds: RepThresholds; proof: Hex },
  blockNumber?: bigint,
  gas?: bigint,
): Promise<{ valid: boolean; reverted: string | null; unverifiable: string | null }> {
  const problem = repThresholdsProblem(q.thresholds);
  if (problem !== null) return { valid: false, reverted: `BadThresholds (${problem})`, unverifiable: null };
  const t = q.thresholds;
  const data = encodeFunctionData({
    abi: ostraReputationAbi,
    functionName: "verify",
    args: [
      word(q.root, "root"),
      word(q.pseudonym, "pseudonym"),
      word(q.scope, "scope"),
      getAddress(q.recipient),
      word(q.challenge, "challenge"),
      { minCompleted: BigInt(t.minCompleted), minClients: BigInt(t.minClients), minVolume: t.minVolume, maxFailPermille: BigInt(t.maxFailPermille), minTier: BigInt(t.minTier), maxFirstDay: BigInt(t.maxFirstDay) },
      q.proof,
    ],
  });
  try {
    // eth_call with an explicit gas (readContract takes none): the verifier's run needs VERIFY_GAS.
    const r = await client.call({ to: getAddress(rep), data, gas: gas ?? repVerifyCallGas(data), ...(blockNumber === undefined ? {} : { blockNumber }) });
    const ok = decodeFunctionResult({ abi: ostraReputationAbi, functionName: "verify", data: r.data ?? "0x" }) as boolean;
    return { valid: ok === true, reverted: null, unverifiable: null };
  } catch (err) {
    const e = err as { shortMessage?: string; message?: string };
    const name = revertName(err);
    if (name === "InsufficientGas" || name === "VerifierHalted") return { valid: false, reverted: null, unverifiable: name };
    if (name === "UnknownRoot" || name === "NotCanonical" || name === "BadThresholds") return { valid: false, reverted: name, unverifiable: null };
    // Anything else (a failed read, a revert this SDK does not know, out of gas in the call itself): no verdict.
    const text = String(e.shortMessage ?? e.message ?? err).split("\n")[0]?.slice(0, 200) ?? "the read failed";
    return { valid: false, reverted: null, unverifiable: name ?? text };
  }
}
