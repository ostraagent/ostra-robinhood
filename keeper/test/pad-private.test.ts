// The evaluator bot's reading of private jobs (src/pad-private.ts), on real encrypted files written to a directory as
// the uploader keeps them: a file is read only when its bytes hash to its name, decrypted under the job's K, bound to
// its job, its attachments checked and their text kept up to the limit; everything else is absent, no answer, or the
// fault of the party that made the file. The rule for a rejection "for no K" upholds only without a provider wrap that
// recomputes under K.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bytesToHex, getAddress, sha256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  OSTRAPAD,
  PAD_ENC_KIND,
  PAD_ENC_SEGMENT,
  PAD_KEM_DOMAIN,
  PAD,
  padEncodeHeader,
  padEncryptFile,
  padKemKeys,
  padKemSeed,
  padKeyCommit,
  padNewJobKey,
  padNewSalt,
  padPlaintextPrefix,
  padWrapBytes,
  padWrapKey,
  type PadEncHeader,
  type PadKemKeys,
} from "@ostraagent/sdk";
import { encFileName, encHeader, encPresence, healthyMs, keyFromText, keyFromWraps, keyToText, openEncFile, registrationBody, sealReason, upholdFromRecords, upholdNoKey, type KemRegistration, type PrivateJobRecord, type StoredWrap, type UpholdSnapshot } from "../src/pad-private.ts";

const CHAIN = 4663;
const JOB: Hex = `0x${"ab".repeat(32)}`;
const CLIENT = getAddress("0x1111111111111111111111111111111111111111");
const PROVIDER = getAddress("0x2222222222222222222222222222222222222222");
const caip = (a: Address) => `eip155:${CHAIN}:${a}`;
const enc = (t: string) => new TextEncoder().encode(t);

function kemOf(seedByte: number): PadKemKeys {
  return padKemKeys(padKemSeed(new Uint8Array(32).fill(seedByte), PAD_KEM_DOMAIN.keeper, CHAIN, OSTRAPAD));
}

type Att = { name: string; bytes: Uint8Array; type?: "text" | "binary"; sha?: Hex };
function plaintext(manifest: Record<string, unknown>, atts: Att[]): Uint8Array {
  const prefix = padPlaintextPrefix({ ...manifest, attachments: atts.map((a) => ({ name: a.name, size: a.bytes.length, sha256: a.sha ?? sha256(a.bytes), type: a.type ?? "text" })) });
  const all = new Uint8Array(prefix.length + atts.reduce((n, a) => n + a.bytes.length, 0));
  all.set(prefix, 0);
  let o = prefix.length;
  for (const a of atts) {
    all.set(a.bytes, o);
    o += a.bytes.length;
  }
  return all;
}

async function put(dir: string, file: Uint8Array): Promise<Hex> {
  const digest = sha256(file);
  await writeFile(join(dir, encFileName(digest)), file);
  return digest;
}

/** A job's order (wraps for the client's and provider's keys) and its K. */
function makeOrder(k: Uint8Array, client: PadKemKeys, provider: PadKemKeys, atts: Att[] = [], manifest: Record<string, unknown> = {}) {
  const ctx = { chainId: CHAIN, pad: OSTRAPAD, jobId: `0x${"00".repeat(32)}` as Hex, round: 0 };
  const header: PadEncHeader = {
    kind: PAD_ENC_KIND.order,
    salt: padNewSalt(),
    plaintextLength: 0,
    order: { keyCommit: padKeyCommit(k), clientPosting: CLIENT, providerPosting: PROVIDER, wraps: [padWrapKey(k, ctx, CLIENT, client.publicKey), padWrapKey(k, ctx, PROVIDER, provider.publicKey)] },
  };
  const plain = plaintext({ type: "ostrapad-order-v1", agent: `eip155:${CHAIN}:7`, offer: "summary", client: caip(CLIENT), provider: caip(PROVIDER), input: "Summarise the attached notes.", ...manifest }, atts);
  header.plaintextLength = plain.length;
  return { header, file: padEncryptFile(k, header, plain) };
}

function makeDelivery(k: Uint8Array, atts: Att[], o: { job?: Hex; salt?: Uint8Array; kind?: 2 | 3 } = {}): Uint8Array {
  const plain = plaintext({ type: "ostrapad-delivery-v1", chain: `eip155:${CHAIN}`, job: o.job ?? JOB, output: "Done: see summary.txt." }, atts);
  return padEncryptFile(k, { kind: o.kind ?? PAD_ENC_KIND.delivery, salt: o.salt ?? padNewSalt(), plaintextLength: plain.length, order: null }, plain);
}

const ref = { id: JOB, client: CLIENT, provider: PROVIDER, chainId: CHAIN };

test("an order and a delivery are read from the store, bound to their job, their text kept up to the limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pad-private-"));
  try {
    const k = padNewJobKey();
    const { header, file } = makeOrder(k, kemOf(1), kemOf(2), [{ name: "notes.md", bytes: enc("Line one.\nLine two.") }]);
    const od = await put(dir, file);
    const h = await encHeader(dir, od);
    assert.equal(h.state, "ok");
    const keyCommit = padKeyCommit(k);
    const order = await openEncFile({ dir, digest: od, kind: PAD_ENC_KIND.order, k, keyCommit, job: ref, textBytes: 262_144 });
    assert.equal(order.state, "ok");
    if (order.state !== "ok") return;
    assert.equal(order.plain.offer, "summary");
    assert.deepEqual(order.plain.attachments, [{ name: "notes.md", size: 19, sha256: sha256(enc("Line one.\nLine two.")), type: "text", text: "Line one.\nLine two." }]);
    // A delivery across segment boundaries, with multi-byte characters, cut at the limit (at a character).
    const big = enc("é".repeat(PAD_ENC_SEGMENT)); // 2 MiB: three segments
    const dd = await put(dir, makeDelivery(k, [{ name: "empty.txt", bytes: new Uint8Array(0) }, { name: "summary.txt", bytes: big }, { name: "tail.txt", bytes: enc("ok") }]));
    const d = await openEncFile({ dir, digest: dd, kind: PAD_ENC_KIND.delivery, k, keyCommit, job: ref, orderSalt: header.salt, textBytes: 786_432 });
    assert.equal(d.state, "ok");
    if (d.state !== "ok") return;
    assert.equal(d.plain.output, "Done: see summary.txt.");
    const [e, s, t] = d.plain.attachments;
    assert.deepEqual(e, { name: "empty.txt", size: 0, sha256: sha256(new Uint8Array(0)), type: "text", text: "" });
    assert.equal(s!.truncated, true);
    assert.equal(s!.text, "é".repeat(786_432 / 2));
    assert.equal(t!.text, "");
    assert.equal(t!.truncated, true);
    // A reason (kind 3) the bot seals is read back the same way.
    const rd = await put(dir, sealReason(k, JOB, false, "The summary misses the second line."));
    const r = await openEncFile({ dir, digest: rd, kind: PAD_ENC_KIND.reason, k, keyCommit, job: ref, orderSalt: header.salt, textBytes: 1 });
    assert.equal(r.state, "ok");
    if (r.state === "ok") assert.deepEqual({ approve: r.plain.approve, reason: r.plain.reason, job: r.plain.job }, { approve: false, reason: "The summary misses the second line.", job: JOB });
    // Presence: hashed, and absent only when not there.
    assert.deepEqual(await encPresence(dir, dd), { state: "present", size: (await import("node:fs")).statSync(join(dir, encFileName(dd))).size });
    assert.deepEqual(await encPresence(dir, `0x${"77".repeat(32)}`), { state: "absent" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("absent, no answer, and the maker's fault are told apart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pad-private-"));
  try {
    const k = padNewJobKey();
    const keyCommit = padKeyCommit(k);
    const { header } = makeOrder(k, kemOf(1), kemOf(2));
    const open = (digest: Hex, o: { k?: Uint8Array; kind?: 1 | 2 | 3 } = {}) => openEncFile({ dir, digest, kind: o.kind ?? PAD_ENC_KIND.delivery, k: o.k ?? k, keyCommit, job: ref, orderSalt: header.salt, textBytes: 786_432 });
    assert.deepEqual(await open(`0x${"55".repeat(32)}`), { state: "absent" });
    // Bytes that do not hash to the name: no answer (the operator's disk), flagged.
    const good = makeDelivery(k, [{ name: "a.txt", bytes: enc("a") }]);
    const wrongName = sha256(enc("another file"));
    await writeFile(join(dir, encFileName(wrongName)), good);
    const mm = await open(wrongName);
    assert.equal(mm.state, "unknown");
    assert.equal(mm.state === "unknown" && mm.mismatch, true);
    assert.equal((await encPresence(dir, wrongName)).state, "unknown");
    // Bytes the job names but that do not decrypt (a flipped ciphertext byte, a different K): the maker's fault.
    const flipped = good.slice();
    flipped[flipped.length - 5]! ^= 1;
    assert.equal((await open(await put(dir, flipped))).state, "bad");
    assert.equal((await open(await put(dir, good), { k: padNewJobKey() })).state, "bad");
    // Bound to its job, its kind, and a salt of its own.
    assert.equal((await open(await put(dir, makeDelivery(k, [], { job: `0x${"cd".repeat(32)}` })))).state, "bad");
    assert.equal((await open(await put(dir, makeDelivery(k, [], { salt: header.salt })))).state, "bad");
    assert.equal((await open(await put(dir, makeDelivery(k, [], { kind: 3 })))).state, "bad");
    // Attachments: text only on a pool job, valid UTF-8, the sha256 the manifest gives.
    assert.equal((await open(await put(dir, makeDelivery(k, [{ name: "a.bin", bytes: enc("x"), type: "binary" }])))).state, "bad");
    assert.equal((await open(await put(dir, makeDelivery(k, [{ name: "a.txt", bytes: Uint8Array.of(0xc3, 0x28) }])))).state, "bad");
    const lie = await open(await put(dir, makeDelivery(k, [{ name: "a.txt", bytes: enc("abc"), sha: sha256(enc("abd")) }])));
    assert.equal(lie.state, "bad");
    assert.match(lie.state === "bad" ? lie.why : "", /sha256/);
    assert.equal((await open(await put(dir, good))).state, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("K opens from a wrap to one of the bot's accounts only, and is kept with the order's commitment", () => {
  const k = padNewJobKey();
  const keyCommit = padKeyCommit(k);
  const mine = privateKeyToAccount(`0x${"0a".repeat(32)}`).address;
  const other = privateKeyToAccount(`0x${"0b".repeat(32)}`).address;
  const keys = new Map([[getAddress(mine), kemOf(3)]]);
  const stored = (w: ReturnType<typeof padWrapKey>): StoredWrap => ({ sender: PROVIDER, recipient: w.recipient, round: 1, seq: "1", wrap: Buffer.from(padWrapBytes(w)).toString("base64"), signature: "0x", arrivedAt: 0, arrivedBlock: "0" });
  const ctx = { chainId: CHAIN, pad: OSTRAPAD, jobId: JOB, round: 1 };
  const toOther = stored(padWrapKey(k, ctx, other, kemOf(4).publicKey));
  const toMine = stored(padWrapKey(k, ctx, mine, kemOf(3).publicKey));
  assert.equal(keyFromWraps([toOther], keys, keyCommit), null);
  assert.equal(bytesToHex(keyFromWraps([toOther, toMine], keys, keyCommit) as Uint8Array), bytesToHex(k));
  // A wrap of another K (one the client did not commit to) is refused.
  assert.equal(keyFromWraps([stored(padWrapKey(padNewJobKey(), ctx, mine, kemOf(3).publicKey))], keys, keyCommit), null);
  const text = keyToText({ k, keyCommit, orderSalt: new Uint8Array(32).fill(9), providerPosting: PROVIDER });
  const back = keyFromText(text);
  assert.equal(bytesToHex(back!.k), bytesToHex(k));
  assert.equal(back!.providerPosting, PROVIDER);
  assert.equal(keyFromText("{}"), null);
});

test("the rule for a rejection for no K upholds only without a provider wrap that recomputes under K", () => {
  const k = padNewJobKey();
  const keyCommit = padKeyCommit(k);
  const evaluator = getAddress(privateKeyToAccount(`0x${"0c".repeat(32)}`).address);
  const kem = kemOf(5);
  const ctx = { chainId: CHAIN, pad: OSTRAPAD, jobId: JOB, round: 2, evaluator };
  const good = Buffer.from(padWrapBytes(padWrapKey(k, { chainId: CHAIN, pad: OSTRAPAD, jobId: JOB, round: 2 }, evaluator, kem.publicKey))).toString("base64");
  const otherRound = Buffer.from(padWrapBytes(padWrapKey(k, { chainId: CHAIN, pad: OSTRAPAD, jobId: JOB, round: 1 }, evaluator, kem.publicKey))).toString("base64");
  const pk = Buffer.from(kem.publicKey).toString("base64");
  const snap = (wraps: string[], base = true): UpholdSnapshot => ({ base, why: base ? "" : "the rejection came before the evaluator's late point (evalStart + 42 h)", pk: base ? pk : null, wraps });
  assert.deepEqual(upholdNoKey(snap([], false), k, keyCommit, ctx), { uphold: false, why: "the rejection came before the evaluator's late point (evalStart + 42 h)" });
  assert.equal(upholdNoKey(snap([]), k, keyCommit, ctx).uphold, true);
  assert.equal(upholdNoKey(snap([good]), k, keyCommit, ctx).uphold, false);
  // A wrap made for another round, or one the panel cannot check (no K from the appellant), counts as none.
  assert.equal(upholdNoKey(snap([otherRound]), k, keyCommit, ctx).uphold, true);
  assert.equal(upholdNoKey(snap([good]), null, null, ctx).uphold, true);
  assert.equal(upholdNoKey(snap(["AAAA"]), k, keyCommit, ctx).uphold, true);
});

test("the index's healthy time is the union of its spans within the window", () => {
  assert.equal(healthyMs([], 0, 100), 0);
  assert.equal(healthyMs([[10, 20], [15, 30], [50, 60]], 0, 100), 30);
  assert.equal(healthyMs([[0, 1000]], 100, 400), 300);
  assert.equal(healthyMs([[500, 600]], 100, 400), 0);
});

test("the rule's records: each condition the index holds is required, and only the provider's timely wraps are kept", async () => {
  const evaluatorAccount = privateKeyToAccount(`0x${"0d".repeat(32)}`);
  const evaluator = getAddress(evaluatorAccount.address);
  const kem = kemOf(6);
  const k = padNewJobKey();
  const order = makeOrder(k, kemOf(1), kemOf(2));
  const header = Buffer.from(padEncodeHeader(order.header)).toString("base64");
  const evalStart = 2_000_000_000n;
  const assignedAt = evalStart;
  const decidedAt = evalStart + PAD.EVAL_WINDOW - 6n * 3600n + 60n;
  const assignedMs = Number(assignedAt) * 1000;
  const decidedMs = Number(decidedAt) * 1000;
  const body = await registrationBody(evaluatorAccount, kem, 123n, CHAIN, OSTRAPAD);
  const reg: KemRegistration = { member: evaluator, pk: body.pk as string, pkHash: sha256(kem.publicKey), posting: evaluator, issuedAt: "123", signature: body.signature as Hex, vault: false, arrivedAt: assignedMs - 2 * 3600_000, arrivedBlock: "1" };
  const wrap = (sender: Address, round: number, arrivedAt: number): StoredWrap => ({ sender, recipient: evaluator, round, seq: "1", wrap: Buffer.from(padWrapBytes(padWrapKey(k, { chainId: CHAIN, pad: OSTRAPAD, jobId: JOB, round }, evaluator, kem.publicKey))).toString("base64"), signature: "0x", arrivedAt, arrivedBlock: "1" });
  const timely = wrap(PROVIDER, 3, decidedMs - 3600_000);
  const record: PrivateJobRecord = { header, headerAt: assignedMs - 60_000, fromCreation: true, wraps: [timely, wrap(PROVIDER, 2, decidedMs - 3600_000), wrap(CLIENT, 3, decidedMs - 3600_000), wrap(PROVIDER, 3, decidedMs - 5 * 60_000)] };
  const spans: [number, number][] = [[assignedMs, assignedMs + 3600_000]];
  let vaultAsked = 0;
  const base: Parameters<typeof upholdFromRecords>[0] = { chainId: CHAIN, pad: OSTRAPAD, round: 3, evaluator, assignedAt, evalStart, decidedAt, record, regs: [reg], spans, vaultApproved: async () => (vaultAsked++, true) };
  const ok = await upholdFromRecords(base);
  assert.equal(ok?.base, true, ok?.why);
  assert.deepEqual(ok?.wraps, [timely.wrap], "only the provider's wrap for this round, arrived 10 minutes before the decision or earlier");
  assert.equal(vaultAsked, 0, "an account's registration is checked by its signature");
  const why = async (over: Partial<typeof base>) => (await upholdFromRecords({ ...base, ...over }))?.why;
  // An order header read after the assignment (R9-B1, R10-B1): the healthy hour counts from it.
  const late = { ...record, headerAt: assignedMs + 15 * 60_000 };
  assert.match((await why({ record: late })) ?? "", /healthy less than an hour/, "the hour after the assignment held only 45 minutes after the header");
  assert.equal((await upholdFromRecords({ ...base, record: late, spans: [[assignedMs, assignedMs + 2 * 3600_000]] }))?.base, true, "an hour healthy after the late header");
  assert.match((await why({ record: { ...record, headerAt: null } })) ?? "", /no time for the job's order header/);
  assert.match((await why({ record: "public" })) ?? "", /not know the job as private/);
  assert.match((await why({ decidedAt: decidedAt - 3600n })) ?? "", /late point/);
  assert.match((await why({ regs: [{ ...reg, arrivedAt: assignedMs - 30 * 60_000 }] })) ?? "", /an hour before its assignment/);
  assert.match((await why({ regs: [reg, { ...reg, pkHash: sha256(kemOf(7).publicKey), pk: Buffer.from(kemOf(7).publicKey).toString("base64"), arrivedAt: decidedMs - 1 }] })) ?? "", /changed before the decision/);
  assert.equal((await upholdFromRecords({ ...base, regs: [reg, { ...reg, arrivedAt: decidedMs + 1 }] }))?.base, true, "a change after the decision does not count");
  assert.match((await why({ regs: [{ ...reg, signature: (await evaluatorAccount.signMessage({ message: "another" })) as Hex }] })) ?? "", /not signed by the evaluator/);
  assert.match((await why({ spans: [[assignedMs, assignedMs + 3000_000]] })) ?? "", /healthy less than an hour/);
  // A vault's registration: its approval at the block it arrived in; no answer gives no snapshot (read again).
  assert.equal((await upholdFromRecords({ ...base, regs: [{ ...reg, vault: true, signature: null }], vaultApproved: async () => true }))?.base, true);
  assert.match((await why({ regs: [{ ...reg, vault: true, signature: null }], vaultApproved: async () => false })) ?? "", /not approved/);
  assert.equal(await upholdFromRecords({ ...base, regs: [{ ...reg, vault: true, signature: null }], vaultApproved: async () => null }), null);
});
