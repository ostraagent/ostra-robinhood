// reputation.ts against what OstraReputation computes (vectors/reputation.json, scripts/reputation-vectors.ts: the
// contract's Foundry build asked by eth_call, and ostra-swap's RepVectors.sol), and its pure parts on their own: the
// epoch math, the approval plan under a withdrawal lock, the record and threshold checks, the trees rebuilt from logs
// and the anonymity set. With ostra-prove built (ostra-swap privacy/target/release/ostra-prove, or
// OSTRA_TEST_PROVER), the prover's commands too: idc, record and leaf, path, and a real proof whose public values are
// the contract's.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import {
  REP_COUNT_MAX,
  REP_D_SCOPE,
  REP_FAIL_LIMIT,
  REP_SNAPSHOT_DOMAIN,
  repAnonymitySet,
  repApprovalPlan,
  repBindHash,
  repDayAt,
  repEntriesAtRoot,
  repEntriesFromLogs,
  repEpochAt,
  repEpochStart,
  repIdc,
  repIsCanonical,
  repLeaf,
  repMeets,
  repNewSecret,
  repPackDigest,
  repPath,
  repProve,
  repPublicValues,
  repRecordOf,
  repRecordProblem,
  repScope,
  repScopeElements,
  repSnapshotDigest,
  repThresholdsProblem,
  repTierOf,
  repUnpackDigest,
  type RepEntry,
  type RepProver,
  type RepRecord,
  type RepRecordedLog,
  type RepSnapshotLog,
  type RepThresholds,
} from "../src/reputation.ts";

type Vectors = {
  chainId: number;
  reputation: Address;
  snapshotDomain: Hex;
  base: string;
  epochs: { timestamp: string; epoch: string }[];
  digests: { vault: Address; idc: Hex; nonce: string; epoch: string; digest: Hex }[];
  tiers: { completed: number; clients: number; volume: string; rejected: number; expired: number; tier: number }[];
  bind: { scope: Hex; recipient: Address; challenge: Hex; contract: Hex; vectors: Hex };
  records: { fields: string[]; idc: Hex; record: Hex; leaf: Hex }[];
  scopes: { scope: Hex; elements: string[] }[];
  publicValues: { root: Hex; pseudonym: Hex; scope: Hex; bindHash: Hex; epoch: string; thresholds: string[]; values: string[] };
};
const v = JSON.parse(readFileSync(new URL("./vectors/reputation.json", import.meta.url), "utf8")) as Vectors;

const OPEN: RepThresholds = { minCompleted: 0, minClients: 0, minVolume: 0n, maxFailPermille: 1000, minTier: 0, maxFirstDay: (1 << 29) - 1 };
const recordOf = (f: string[]): RepRecord => ({ completed: Number(f[0]), clients: Number(f[1]), volume: BigInt(f[2] as string), rejected: Number(f[3]), expired: Number(f[4]), tier: Number(f[5]), firstDay: Number(f[6]), epoch: Number(f[7]) });

test("the snapshot digest is the contract's: its domain, chain, address, vault, idc, nonce and epoch", () => {
  assert.equal(REP_SNAPSHOT_DOMAIN, v.snapshotDomain);
  assert.equal(v.digests.length, 3);
  for (const d of v.digests) {
    assert.equal(repSnapshotDigest({ chainId: v.chainId, reputation: v.reputation, vault: d.vault, idc: d.idc, nonce: BigInt(d.nonce), epoch: BigInt(d.epoch) }), d.digest);
  }
  const d = v.digests[1] as Vectors["digests"][number];
  const base = { chainId: v.chainId, reputation: v.reputation, vault: d.vault, idc: d.idc, nonce: BigInt(d.nonce), epoch: BigInt(d.epoch) };
  // Every input is in it.
  for (const other of [{ ...base, chainId: 1 }, { ...base, nonce: base.nonce + 1n }, { ...base, epoch: base.epoch + 1n }, { ...base, reputation: getAddress("0x0000000000000000000000000000000000000001") }, { ...base, idc: v.digests[0]?.idc as Hex }]) {
    assert.notEqual(repSnapshotDigest(other), d.digest);
  }
});

test("the tier is OstraPad's limitOf tier without the bond, as tierOf computes it at each bound", () => {
  assert.equal(v.tiers.length, 11);
  for (const t of v.tiers) assert.equal(repTierOf({ ...t, volume: BigInt(t.volume) }), t.tier, JSON.stringify(t));
});

test("epoch and day math: the contract's currentEpoch at an epoch boundary; the epoch's start; times before BASE refused", () => {
  const base = BigInt(v.base);
  for (const e of v.epochs) assert.equal(repEpochAt(base, BigInt(e.timestamp)), BigInt(e.epoch));
  assert.equal(repEpochStart(base, 3n), base + 3n * 604_800n);
  assert.equal(repEpochAt(base, repEpochStart(base, 3n)), 3n);
  assert.equal(repEpochAt(base, repEpochStart(base, 3n) - 1n), 2n);
  assert.equal(repDayAt(base, base + 86_399n), 0n);
  assert.equal(repDayAt(base, base + 86_400n * 31n), 31n);
  assert.throws(() => repEpochAt(base, base - 1n), RangeError);
  assert.throws(() => repDayAt(base, base - 1n), RangeError);
});

test("the approval plan under a withdrawal lock: approved for the epoch it is usable in, sendable once it takes effect", () => {
  const base = 1_000_000n;
  const week = 604_800n;
  // No lock: this epoch, sendable now.
  assert.deepEqual(repApprovalPlan({ base, now: base + 10n, delay: 0n, margin: 600n }), { epoch: 0n, validFrom: base + 10n, sendableFrom: base + 10n, sendableUntil: base + week });
  // A 2-day lock early in epoch 0: still epoch 0, sendable in 2 days.
  const p = repApprovalPlan({ base, now: base + 100n, delay: 172_800n, margin: 600n });
  assert.deepEqual(p, { epoch: 0n, validFrom: base + 100n + 172_800n, sendableFrom: base + 100n + 172_800n, sendableUntil: base + week });
  // A 2-day lock 6 days in: the approval takes effect in epoch 1, and is for epoch 1.
  const late = repApprovalPlan({ base, now: base + 6n * 86_400n, delay: 172_800n, margin: 600n });
  assert.equal(late.epoch, 1n);
  assert.equal(late.sendableFrom, base + 8n * 86_400n);
  // Taking effect within the margin of an epoch's end: the next epoch, sendable from its start.
  const edge = repApprovalPlan({ base, now: base + week - 700n, delay: 300n, margin: 600n });
  assert.equal(edge.epoch, 1n);
  assert.equal(edge.sendableFrom, base + week);
  assert.equal(edge.sendableUntil, base + 2n * week);
  // A lock longer than an epoch: an epoch ahead.
  assert.equal(repApprovalPlan({ base, now: base, delay: 9n * 86_400n, margin: 600n }).epoch, 1n);
  assert.throws(() => repApprovalPlan({ base, now: base, delay: -1n, margin: 0n }), RangeError);
});

test("the record as the contract writes it: completed and clients clamped to 2^19 - 1, 2^16 rejected or expired refused", () => {
  const r = repRecordOf({ completed: 4_000_000_000, clients: REP_COUNT_MAX + 1, volume: 5n, rejected: REP_FAIL_LIMIT - 1, expired: 0 }, 3, 7);
  assert.deepEqual(r, { completed: REP_COUNT_MAX, clients: REP_COUNT_MAX, volume: 5n, rejected: REP_FAIL_LIMIT - 1, expired: 0, tier: 0, firstDay: 3, epoch: 7 });
  assert.throws(() => repRecordOf({ completed: 1, clients: 1, volume: 0n, rejected: REP_FAIL_LIMIT, expired: 0 }, 0, 0), /RecordTooLarge/);
  assert.throws(() => repRecordOf({ completed: 1, clients: 1, volume: 0n, rejected: 0, expired: REP_FAIL_LIMIT }, 0, 0), /RecordTooLarge/);
  assert.equal(repRecordOf({ completed: 10, clients: 5, volume: 100_000_000n, rejected: 0, expired: 0 }, 0, 0).tier, 1);
  for (const rec of v.records) assert.equal(repRecordProblem(recordOf(rec.fields)), null);
  assert.match(repRecordProblem({ ...r, tier: 4 }) ?? "", /tier/);
  assert.match(repRecordProblem({ ...r, epoch: 1 << 30 }) ?? "", /epoch/);
});

test("thresholds: the contract's ranges; meets with the strict fail ratio (a record with no counted job meets nothing)", () => {
  assert.equal(repThresholdsProblem(OPEN), null);
  assert.match(repThresholdsProblem({ ...OPEN, maxFailPermille: 1001 }) ?? "", /1000/);
  assert.match(repThresholdsProblem({ ...OPEN, minTier: 4 }) ?? "", /minTier/);
  assert.match(repThresholdsProblem({ ...OPEN, maxFirstDay: 1 << 29 }) ?? "", /2\^29/);
  assert.match(repThresholdsProblem({ ...OPEN, minVolume: 1n << 128n }) ?? "", /uint128/);
  const zero: RepRecord = { completed: 0, clients: 0, volume: 0n, rejected: 0, expired: 0, tier: 0, firstDay: 0, epoch: 0 };
  assert.equal(repMeets(zero, OPEN), false, "maxFailPermille * 0 - 0 - 1 < 0");
  const one = { ...zero, completed: 1, clients: 1, volume: 1_000_000n };
  assert.equal(repMeets(one, OPEN), true);
  assert.equal(repMeets(one, { ...OPEN, maxFailPermille: 0 }), false);
  // 1 rejected in 10: 100 per mille; strict, so a limit of 100 fails and 101 holds.
  const r10 = { ...zero, completed: 9, clients: 3, rejected: 1 };
  assert.equal(repMeets(r10, { ...OPEN, maxFailPermille: 100 }), false);
  assert.equal(repMeets(r10, { ...OPEN, maxFailPermille: 101 }), true);
  // Equality at each threshold holds; one beyond fails.
  const r = { completed: 12, clients: 5, volume: 7_000_000n, rejected: 0, expired: 0, tier: 1, firstDay: 4, epoch: 6 };
  const at: RepThresholds = { minCompleted: 12, minClients: 5, minVolume: 7_000_000n, maxFailPermille: 1, minTier: 1, maxFirstDay: 4 };
  assert.equal(repMeets(r, at), true);
  for (const beyond of [{ minCompleted: 13 }, { minClients: 6 }, { minVolume: 7_000_001n }, { minTier: 2 }, { maxFirstDay: 3 }]) assert.equal(repMeets(r, { ...at, ...beyond }), false, JSON.stringify(beyond, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
});

test("scope, bind and public values are the contract's", () => {
  for (const s of v.scopes) assert.deepEqual(repScopeElements(s.scope).map(String), s.elements);
  assert.equal(repScopeElements(v.scopes[0]?.scope as Hex)[0], REP_D_SCOPE);
  assert.equal(repBindHash(v.bind.scope, v.bind.recipient, v.bind.challenge), v.bind.contract);
  assert.equal(v.bind.contract, v.bind.vectors);
  const p = v.publicValues;
  const t = p.thresholds.map(Number);
  const thresholds: RepThresholds = { minCompleted: t[0] as number, minClients: t[1] as number, minVolume: BigInt(p.thresholds[2] as string), maxFailPermille: t[3] as number, minTier: t[4] as number, maxFirstDay: t[5] as number };
  assert.deepEqual(repPublicValues(p.root, p.pseudonym, p.scope, p.bindHash, BigInt(p.epoch), thresholds).map(String), p.values);
  assert.throws(() => repPublicValues(p.root, p.pseudonym, p.scope, p.bindHash, BigInt(p.epoch), { ...thresholds, maxFailPermille: 1001 }), RangeError);
  // The scope text: keccak256 of the text, the epoch appended by default.
  assert.equal(repScope("ostrapad:listing:7", 3n), keccak256(stringToHex("ostrapad:listing:7:3")));
  assert.equal(repScope("ostrapad:listing:7:3", null), repScope("ostrapad:listing:7", 3));
  assert.notEqual(repScope("a", 1n), repScope("a", 2n));
  assert.throws(() => repScope("", 0n), RangeError);
  assert.throws(() => repScope("a\nb", 0n), RangeError);
  assert.throws(() => repScope("x".repeat(201), 0n), RangeError);
});

test("digests pack 8 field elements as Notes.sol does; non-canonical ones are refused", () => {
  const els = ["1", "2", "3", "4", "5", "6", "7", "2130706432"];
  const d = repPackDigest(els);
  assert.deepEqual(repUnpackDigest(d), els);
  assert.equal(repIsCanonical(d), true);
  assert.throws(() => repPackDigest([...els.slice(0, 7), "2130706433"]));
  assert.equal(repIsCanonical(`0x${"ff".repeat(32)}`), false);
  for (const r of v.records) assert.equal(repIsCanonical(r.leaf), true);
});

// ---------------------------------------------------------------------------------------------
// Trees from logs and the anonymity set
// ---------------------------------------------------------------------------------------------

const vault = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const dg = (n: number) => repPackDigest([n, n, n, n, n, n, n, n]);
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
function logs(epoch: bigint, records: Partial<RepRecord>[], firstTx = 1): { s: RepSnapshotLog[]; r: RepRecordedLog[] } {
  const s: RepSnapshotLog[] = [];
  const r: RepRecordedLog[] = [];
  records.forEach((rec, i) => {
    const t = tx(firstTx + i);
    const full = { completed: 1, clients: 1, volume: 1_000_000n, rejected: 0, expired: 0, tier: 0, firstDay: 0, ...rec };
    s.push({ args: { vault: vault(0xa0 + i), epoch, leaf: dg(i + 1), index: BigInt(i), root: dg(100 + i) }, transactionHash: t, blockNumber: BigInt(10 + i), logIndex: 3 });
    r.push({
      args: { vault: vault(0xa0 + i), epoch, completed: BigInt(full.completed), clients: BigInt(full.clients), volume: full.volume, rejected: BigInt(full.rejected), expired: BigInt(full.expired), tier: BigInt(full.tier), firstDay: BigInt(full.firstDay) },
      transactionHash: t,
      blockNumber: BigInt(10 + i),
      logIndex: 4,
    });
  });
  return { s, r };
}

test("epoch trees from Snapshot and Recorded logs: paired by transaction and log, in index order; gaps and conflicts refused", () => {
  const a = logs(2n, [{ completed: 3 }, { completed: 1 }, { completed: 7, clients: 2 }]);
  const b = logs(3n, [{}], 50);
  // Shuffled and one repeated: the same tree.
  const trees = repEntriesFromLogs([...a.s].reverse().concat(b.s, a.s.slice(0, 1)), [...b.r, ...a.r]);
  const e2 = trees.get(2n) as RepEntry[];
  assert.deepEqual(e2.map((e) => e.index), [0, 1, 2]);
  assert.deepEqual(e2.map((e) => e.record.completed), [3, 1, 7]);
  assert.equal(e2[2]?.record.epoch, 2);
  assert.equal(trees.get(3n)?.length, 1);
  // A Snapshot without its Recorded log, a gap, two leaves at one index, a vault twice.
  assert.throws(() => repEntriesFromLogs(a.s, a.r.slice(1)), /no Recorded log/);
  assert.throws(() => repEntriesFromLogs([a.s[0] as RepSnapshotLog, a.s[2] as RepSnapshotLog], [a.r[0] as RepRecordedLog, a.r[2] as RepRecordedLog]), /leaf 1 is missing/);
  const other = { ...(a.s[1] as RepSnapshotLog), args: { ...(a.s[1] as RepSnapshotLog).args, leaf: dg(99) }, transactionHash: tx(77) };
  assert.throws(() => repEntriesFromLogs([...a.s, other], [...a.r, { ...(a.r[1] as RepRecordedLog), transactionHash: tx(77) }]), /two different leaves/);
  const twice = logs(4n, [{}, {}]);
  (twice.s[1] as RepSnapshotLog).args.vault = vault(0xa0);
  (twice.r[1] as RepRecordedLog).args.vault = vault(0xa0);
  assert.throws(() => repEntriesFromLogs(twice.s, twice.r), /two leaves/);
  const wrong = logs(5n, [{}]);
  (wrong.r[0] as RepRecordedLog).args.vault = vault(0xff);
  assert.throws(() => repEntriesFromLogs(wrong.s, wrong.r), /another vault/);
  // The tree at a root: the prefix up to the leaf that gave it.
  assert.deepEqual(repEntriesAtRoot(e2, dg(101)).map((e) => e.index), [0, 1]);
  assert.equal(repEntriesAtRoot(e2, dg(102)).length, 3);
  assert.throws(() => repEntriesAtRoot(e2, dg(5)), /no leaf/);
});

test("the anonymity set: the vaults meeting the statement, intersected with every earlier statement of the scope", () => {
  const e = repEntriesFromLogs(...Object.values(logs(1n, [{ completed: 5, clients: 3 }, { completed: 2 }, { completed: 9, clients: 4 }, { completed: 0 }, { completed: 5, clients: 1, rejected: 5 }])) as [RepSnapshotLog[], RepRecordedLog[]]).get(1n) as RepEntry[];
  assert.deepEqual(repAnonymitySet([{ entries: e, thresholds: OPEN }]), [vault(0xa0), vault(0xa1), vault(0xa2), vault(0xa4)], "a record without a counted job is in no set");
  const five = { ...OPEN, minCompleted: 5 };
  assert.deepEqual(repAnonymitySet([{ entries: e, thresholds: five }]), [vault(0xa0), vault(0xa2), vault(0xa4)]);
  // An earlier statement of the same scope (clients >= 3) leaves only those meeting both.
  assert.deepEqual(repAnonymitySet([{ entries: e, thresholds: five }, { entries: e, thresholds: { ...OPEN, minClients: 3 } }]), [vault(0xa0), vault(0xa2)]);
  // An earlier statement against a smaller root: vaults not yet in that tree are out.
  assert.deepEqual(repAnonymitySet([{ entries: e, thresholds: five }, { entries: e.slice(0, 1), thresholds: OPEN }]), [vault(0xa0)]);
  // An earlier statement in another epoch's tree: matched by vault address.
  const other = repEntriesFromLogs(...Object.values(logs(0n, [{ completed: 1 }, {}, { completed: 1, expired: 1 }], 90)) as [RepSnapshotLog[], RepRecordedLog[]]).get(0n) as RepEntry[];
  assert.deepEqual(repAnonymitySet([{ entries: e, thresholds: OPEN }, { entries: other, thresholds: { ...OPEN, maxFailPermille: 400 } }]), [vault(0xa0), vault(0xa1)]);
  assert.deepEqual(repAnonymitySet([]), []);
});

// ---------------------------------------------------------------------------------------------
// The prover (ostra-prove, native)
// ---------------------------------------------------------------------------------------------

const PROVER = process.env.OSTRA_TEST_PROVER ?? fileURLToPath(new URL("../../../ostra-swap/privacy/target/release/ostra-prove", import.meta.url));
const noProver = existsSync(PROVER) ? false : `no ostra-prove at ${PROVER} (build ostra-swap privacy with cargo, or set OSTRA_TEST_PROVER)`;

/** ostra-prove as a child process, one per command (as @ostraagent/swap cli-prover.ts runs it). */
const cli: RepProver = (command, request) =>
  new Promise((resolve, reject) => {
    const child = spawn(PROVER, [command], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    child.stdin.on("error", () => {});
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out) as unknown) : reject(new Error(`ostra-prove ${command}: ${err.trim()}`))));
    child.stdin.end(request === undefined ? undefined : JSON.stringify(request));
  });

test("the prover: the vectors' record digests and leaves; a fresh secret's idc; paths to one root", { skip: noProver }, async () => {
  for (const r of v.records) assert.deepEqual(await repLeaf(cli, recordOf(r.fields), r.idc), { record: r.record, leaf: r.leaf });
  const sk = await repNewSecret(cli);
  const idc = await repIdc(cli, sk);
  assert.equal(repIsCanonical(idc), true);
  assert.notEqual(idc, await repIdc(cli, await repNewSecret(cli)));
  const leaves = v.records.map((r) => r.leaf);
  const roots = new Set<string>();
  for (let i = 0; i < leaves.length; i++) {
    const p = await repPath(cli, leaves, i);
    assert.equal(p.path.length, 20);
    roots.add(p.root);
  }
  assert.equal(roots.size, 1, "every leaf's path leads to the same root");
  assert.notEqual((await repPath(cli, leaves.slice(0, 2), 0)).root, [...roots][0], "the root of the first two leaves is another");
  await assert.rejects(repPath(cli, leaves, 3), RangeError);
});

test("the prover: a proof for a leaf of a real tree, its public values the contract's; a record that misses is refused before proving", { skip: noProver }, async () => {
  const sk = await repNewSecret(cli);
  const idc = await repIdc(cli, sk);
  const record: RepRecord = { completed: 3, clients: 2, volume: 3_000_000n, rejected: 0, expired: 0, tier: 0, firstDay: 1, epoch: 5 };
  const mine = (await repLeaf(cli, record, idc)).leaf;
  const leaves = [v.records[0]?.leaf as Hex, mine, v.records[2]?.leaf as Hex];
  const { root, path } = await repPath(cli, leaves, 1);
  const scope = repScope("ostra:test", 5n);
  const bindHash = repBindHash(scope, vault(0xbeef), keccak256(stringToHex("challenge")));
  const t: RepThresholds = { minCompleted: 3, minClients: 2, minVolume: 3_000_000n, maxFailPermille: 1, minTier: 0, maxFirstDay: 1 };
  const p = await repProve(cli, { sk, record, index: 1, path, root, scope, thresholds: t, bindHash, epoch: 5n });
  assert.equal(p.idc, idc);
  assert.match(p.proof, /^0x[0-9a-f]+$/);
  assert.notEqual(p.pseudonym, idc, "the pseudonym is not the idc");
  // The same sk and scope give the same pseudonym; another scope another one.
  const again = await repProve(cli, { sk, record, index: 1, path, root, scope, thresholds: OPEN, bindHash, epoch: 5n });
  assert.equal(again.pseudonym, p.pseudonym);
  const elsewhere = await repProve(cli, { sk, record, index: 1, path, root, scope: repScope("ostra:test", 6n), thresholds: OPEN, bindHash, epoch: 5n });
  assert.notEqual(elsewhere.pseudonym, p.pseudonym);
  await assert.rejects(repProve(cli, { sk, record, index: 1, path, root, scope, thresholds: { ...t, minCompleted: 4 }, bindHash, epoch: 5n }), /does not meet/);
  await assert.rejects(repProve(cli, { sk, record, index: 1, path, root, scope, thresholds: t, bindHash, epoch: 6n }), /not of the proof's epoch/);
});
