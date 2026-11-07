// Ostrapad private jobs (src/pad-private.ts): every derivation is checked against Node's own HKDF and AES-256-GCM
// (an independent implementation), the file format round-trips and refuses every malformed, cut, extended, reordered or
// forged byte, and a wrap opens only for its recipient's key.

import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { test } from "node:test";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { bytesToHex, encodeAbiParameters, getAddress, keccak256, recoverMessageAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  PAD_ENC_KIND,
  PAD_ENC_MAX_HEADER,
  PAD_ENC_SEGMENT,
  PAD_KEM_DOMAIN,
  PAD_PANEL_ROUND,
  PAD_WRAP_BYTES,
  padCheckKemPublicKey,
  padDecryptFile,
  padEncodeHeader,
  padEncryptFile,
  padEncryptedLength,
  padFileKey,
  padHeaderLength,
  padJobByteAllowance,
  padKemKeys,
  padKemMessage,
  padKemSeed,
  padKeyCommit,
  padKeyMatches,
  padManifestLength,
  padNewJobKey,
  padNewSalt,
  padParseHeader,
  padParseManifest,
  padPlaintextPrefix,
  padPostingAccount,
  padReserveMessage,
  padSafeAttachmentName,
  padSegmentCount,
  padUnwrapKey,
  padUploadMessage,
  padWrapBytes,
  padWrapFromBytes,
  padWrapKey,
  padWrapMessage,
  type PadEncHeader,
} from "../src/index.ts";

const CHAIN = 4663;
const PAD: Address = "0x1BE28c4F08a548598fE0AA9b16DFD564C82E8055";
const ALICE: Address = getAddress("0x00000000000000000000000000000000000a11ce");
const BOB: Address = getAddress("0x0000000000000000000000000000000000000b0b");
const EVE: Address = getAddress("0x0000000000000000000000000000000000000e5e");
const JOB = `0x${"22".repeat(32)}` as const;
const CTX = { chainId: CHAIN, pad: PAD, jobId: JOB, round: 1 };
const nodeSha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const nodeHkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, n: number) => new Uint8Array(hkdfSync("sha256", ikm, salt, info, n));
const u = (s: string) => new TextEncoder().encode(s);
const cat = (...p: Uint8Array[]) => Uint8Array.from(Buffer.concat(p));
const chain32 = () => Buffer.from(BigInt(CHAIN).toString(16).padStart(64, "0"), "hex");
const addr20 = (a: Address) => Buffer.from(a.slice(2), "hex");

function kem(i: number) {
  return padKemKeys(padKemSeed(new Uint8Array(32).fill(i), PAD_KEM_DOMAIN.mcp, CHAIN, PAD));
}

test("keyCommit, the KEM seed, the posting key and the file key are the HKDFs the design names", () => {
  const k = new Uint8Array(32).fill(7);
  assert.deepEqual(padKeyCommit(k), nodeSha(nodeHkdf(k, new Uint8Array(0), u("OSTRA/PAD/KEY-COMMIT/v1"), 32)));
  assert.ok(padKeyMatches(k, padKeyCommit(k)));
  assert.ok(!padKeyMatches(new Uint8Array(32).fill(8), padKeyCommit(k)));

  const ikm = new Uint8Array(32).fill(3);
  for (const d of [PAD_KEM_DOMAIN.mcp, PAD_KEM_DOMAIN.keeper]) {
    assert.deepEqual(padKemSeed(ikm, d, CHAIN, PAD), nodeHkdf(ikm, new Uint8Array(0), cat(u(d), chain32(), addr20(PAD)), 64));
  }
  assert.notDeepEqual(padKemSeed(ikm, PAD_KEM_DOMAIN.mcp, CHAIN, PAD), padKemSeed(ikm, PAD_KEM_DOMAIN.keeper, CHAIN, PAD));
  assert.notDeepEqual(padKemSeed(ikm, PAD_KEM_DOMAIN.mcp, CHAIN, PAD), padKemSeed(ikm, PAD_KEM_DOMAIN.mcp, 1, PAD));

  const posting = padPostingAccount(ikm, CHAIN, PAD);
  const secret = nodeHkdf(ikm, new Uint8Array(0), cat(u("OSTRA/MCP/PAD-POST/EVM/v1"), chain32(), addr20(PAD), Uint8Array.of(0)), 32);
  assert.equal(posting.address, padPostingAccount(ikm, CHAIN, PAD).address);
  assert.notEqual(posting.address, padPostingAccount(new Uint8Array(32).fill(4), CHAIN, PAD).address);
  assert.equal(posting.address, privateKeyToAccount(bytesToHex(secret)).address);

  const salt = new Uint8Array(32).fill(9);
  for (const kind of [1, 2, 3] as const) assert.deepEqual(padFileKey(k, salt, kind), nodeHkdf(k, salt, cat(u("OSTRA/PAD/FILE/v1"), Uint8Array.of(kind)), 32));
});

test("the KEM keys come from the seed deterministically and the seed is wiped", () => {
  const seed = padKemSeed(new Uint8Array(32).fill(1), PAD_KEM_DOMAIN.mcp, CHAIN, PAD);
  const copy = seed.slice();
  const a = padKemKeys(seed);
  assert.deepEqual(seed, new Uint8Array(64), "seed wiped");
  const b = padKemKeys(copy);
  assert.deepEqual(a.publicKey, b.publicKey);
  assert.equal(a.publicKey.length, 1184);
  padCheckKemPublicKey(a.publicKey);
  const bad = a.publicKey.slice();
  bad[0] = 0xff;
  bad[1] = 0xff; // a coefficient of 4095 > q fails FIPS 203's modulus check
  assert.throws(() => padCheckKemPublicKey(bad), /modulus/);
  assert.throws(() => padCheckKemPublicKey(a.publicKey.subarray(1)), /1184/);
});

test("a wrap opens for its recipient's key only, and its kek and AES-GCM are the design's bytes", () => {
  const k = padNewJobKey();
  const bob = kem(2);
  const eve = kem(5);
  const w = padWrapKey(k, CTX, BOB, bob.publicKey);
  assert.equal(padWrapBytes(w).length, PAD_WRAP_BYTES);
  assert.deepEqual(padWrapFromBytes(padWrapBytes(w)), w);
  assert.deepEqual(padUnwrapKey(w, BOB, bob, padKeyCommit(k)), k);
  assert.equal(padUnwrapKey(w, EVE, bob, padKeyCommit(k)), null, "another recipient");
  assert.equal(padUnwrapKey(w, BOB, eve, padKeyCommit(k)), null, "another key");
  assert.equal(padUnwrapKey({ ...w, recipient: EVE }, EVE, bob, padKeyCommit(k)), null, "recipient swapped into the wrap");
  for (const field of ["ct", "wrapped"] as const) {
    const t = { ...w, [field]: w[field].slice() };
    t[field][7]! ^= 1;
    assert.equal(padUnwrapKey(t, BOB, bob, padKeyCommit(k)), null, `tampered ${field}`);
  }
  // Independent check: Node's HKDF and AES-256-GCM open the same wrap from the decapsulated secret.
  const ss = ml_kem768.decapsulate(w.ct, bob.secretKey);
  const pkHash = nodeSha(bob.publicKey);
  const kek = nodeHkdf(ss, nodeSha(w.ct), cat(u("OSTRA/PAD/WRAP/v1"), addr20(BOB), pkHash), 32);
  const d = createDecipheriv("aes-256-gcm", kek, new Uint8Array(12));
  d.setAAD(cat(addr20(BOB), pkHash));
  d.setAuthTag(w.wrapped.subarray(32));
  assert.deepEqual(new Uint8Array(Buffer.concat([d.update(w.wrapped.subarray(0, 32)), d.final()])), k);
});

function orderHeader(k: Uint8Array, n: number, wraps = 2): PadEncHeader {
  const recipients = [ALICE, BOB, EVE, "0x000000000000000000000000000000000000dEaD" as Address];
  return {
    kind: PAD_ENC_KIND.order,
    salt: padNewSalt(),
    plaintextLength: n,
    order: { keyCommit: padKeyCommit(k), clientPosting: ALICE, providerPosting: BOB, wraps: recipients.slice(0, wraps).map((r, i) => padWrapKey(k, { ...CTX, round: 0 }, r, kem(i + 1).publicKey)) },
  };
}

test("a file round-trips at every segment boundary, and Node's AES-GCM opens its segments", () => {
  const k = padNewJobKey();
  for (const n of [0, 1, PAD_ENC_SEGMENT - 1, PAD_ENC_SEGMENT, PAD_ENC_SEGMENT + 1, 3 * PAD_ENC_SEGMENT]) {
    const plain = crypto.getRandomValues(new Uint8Array(Math.min(n, 65_536)));
    const full = new Uint8Array(n);
    for (let o = 0; o < n; o += plain.length) full.set(plain.subarray(0, Math.min(plain.length, n - o)), o);
    for (const h of [orderHeader(k, n), { kind: PAD_ENC_KIND.delivery, salt: padNewSalt(), plaintextLength: n, order: null } satisfies PadEncHeader]) {
      const file = padEncryptFile(k, h, full);
      const { header, length } = padParseHeader(file);
      assert.equal(file.length, padEncryptedLength(length, n));
      assert.equal(padSegmentCount(n), n === 0 ? 1 : Math.ceil(n / PAD_ENC_SEGMENT));
      const out = padDecryptFile(k, padKeyCommit(k), file);
      assert.deepEqual(out.plaintext, full);
      assert.equal(out.header.kind, h.kind);
      // segment 0 through Node: nonce 0 || last flag, aad = sha256(header)
      const last = padSegmentCount(n) === 1;
      const plain0 = last ? n : PAD_ENC_SEGMENT;
      const d = createDecipheriv("aes-256-gcm", padFileKey(k, header.salt, header.kind), cat(new Uint8Array(11), Uint8Array.of(last ? 1 : 0)));
      d.setAAD(nodeSha(file.subarray(0, length)));
      d.setAuthTag(file.subarray(length + plain0, length + plain0 + 16));
      assert.deepEqual(new Uint8Array(Buffer.concat([d.update(file.subarray(length, length + plain0)), d.final()])), full.subarray(0, plain0));
    }
  }
});

test("a file refuses a flipped byte anywhere, a cut, an extension, a swap of segments and the wrong key or kind", () => {
  const k = padNewJobKey();
  const n = 2 * PAD_ENC_SEGMENT + 100;
  const plain = new Uint8Array(n).map((_, i) => i & 0xff);
  const file = padEncryptFile(k, orderHeader(k, n), plain);
  const { length } = padParseHeader(file);
  for (const at of [0, 13, 20, 50, 55, 60, 100, length - 1, length, length + PAD_ENC_SEGMENT + 3, file.length - 1]) {
    const t = file.slice();
    t[at]! ^= 0x01;
    assert.throws(() => padDecryptFile(k, padKeyCommit(k), t), Error, `byte ${at}`);
  }
  assert.throws(() => padDecryptFile(k, padKeyCommit(k), file.subarray(0, file.length - 1)), /length/);
  assert.throws(() => padDecryptFile(k, padKeyCommit(k), cat(file, Uint8Array.of(0))), /length/);
  const seg = PAD_ENC_SEGMENT + 16;
  const swapped = cat(file.subarray(0, length), file.subarray(length + seg, length + 2 * seg), file.subarray(length, length + seg), file.subarray(length + 2 * seg));
  assert.throws(() => padDecryptFile(k, padKeyCommit(k), swapped), /authenticate/);
  assert.throws(() => padDecryptFile(padNewJobKey(), padKeyCommit(k), file), /keyCommit/);
  // the last flag: a file cut to whole segments (header claiming the shorter length) does not authenticate either
  const h2 = orderHeader(k, 2 * PAD_ENC_SEGMENT);
  const two = padEncryptFile(k, h2, plain.subarray(0, 2 * PAD_ENC_SEGMENT));
  const l2 = padParseHeader(two).length;
  const oneHeader = padEncodeHeader({ ...h2, plaintextLength: PAD_ENC_SEGMENT });
  assert.throws(() => padDecryptFile(k, padKeyCommit(k), cat(oneHeader, two.subarray(l2, l2 + seg))), /authenticate/);
});

test("the header refuses another magic, kind, segment size, a wrap count out of range, a duplicate recipient and an oversized plaintext", () => {
  const k = padNewJobKey();
  const head = padEncodeHeader(orderHeader(k, 10));
  assert.equal(padHeaderLength(head), head.length);
  assert.equal(padHeaderLength(head.subarray(0, 20)), null);
  assert.ok(head.length <= PAD_ENC_MAX_HEADER);
  assert.equal(padEncodeHeader(orderHeader(k, 10, 4)).length, PAD_ENC_MAX_HEADER);
  const t = (i: number, v: number) => {
    const c = head.slice();
    c[i] = v;
    return c;
  };
  assert.throws(() => padParseHeader(t(0, 0x41)), /magic/);
  assert.throws(() => padParseHeader(t(13, 4)), /kind/);
  assert.throws(() => padParseHeader(t(55, 0)), /segment/);
  assert.throws(() => padParseHeader(t(58 + 72, 0)), /wraps/);
  assert.throws(() => padParseHeader(t(58 + 72, 5)), /wraps/);
  const big = head.slice();
  new DataView(big.buffer).setBigUint64(46, 100_000_001n, false);
  assert.throws(() => padParseHeader(big), /limit/);
  const w = padWrapKey(k, CTX, BOB, kem(2).publicKey);
  assert.throws(() => padEncodeHeader({ ...orderHeader(k, 1), order: { keyCommit: padKeyCommit(k), clientPosting: ALICE, providerPosting: BOB, wraps: [w, w] } }), /two wraps/);
  assert.throws(() => padEncodeHeader({ kind: PAD_ENC_KIND.delivery, salt: padNewSalt(), plaintextLength: 1, order: orderHeader(k, 1).order }), /only an order/);
  assert.throws(() => padParseHeader(head.subarray(0, head.length - 1)), /cut short/);
});

test("the manifest's attachments are checked: safe distinct names, sizes that add up, no public files", () => {
  const atts = [
    { name: "brief.md", size: 3, sha256: bytesToHex(nodeSha(u("abc"))), type: "text" },
    { name: "Data.csv", size: 2, sha256: bytesToHex(nodeSha(u("xy"))), type: "binary" },
  ];
  const m = { format: "ostrapad-order-v1", attachments: atts };
  const prefix = padPlaintextPrefix(m);
  const total = prefix.length + 5;
  const len = padManifestLength(prefix.subarray(0, 4));
  assert.equal(len, prefix.length - 4);
  const parsed = padParseManifest(total, prefix.subarray(4));
  assert.equal(parsed.attachments.length, 2);
  assert.throws(() => padParseManifest(total + 1, prefix.subarray(4)), /add up/);
  const again = (a: unknown[], extra: Record<string, unknown> = {}) => padPlaintextPrefix({ ...m, ...extra, attachments: a }).subarray(4);
  assert.throws(() => padParseManifest(total, again([...atts.slice(0, 1), { ...atts[1], name: "BRIEF.md" }])), /two attachments/);
  for (const bad of ["../x", "a/b", ".hidden", "", "a..b", "x".repeat(202), "naïve.txt", "a b"]) {
    assert.equal(padSafeAttachmentName(bad), false, bad);
  }
  assert.throws(() => padParseManifest(total, again(atts, { files: ["ipfs://x"] })), /public files/);
  assert.throws(() => padParseManifest(total, again([{ ...atts[0], type: "exe" }, atts[1]])), /type/);
});

test("the signed messages are keccak256 of the abi encodings the design lists, and EIP-191 recovers the signer", async () => {
  const jobId = `0x${"11".repeat(32)}` as const;
  const k = padNewJobKey();
  const w = padWrapKey(k, CTX, BOB, kem(2).publicKey);
  const wrapHash = padWrapMessage({ chainId: CHAIN, pad: PAD, jobId, round: PAD_PANEL_ROUND, wrap: w, seq: 5n });
  assert.equal(
    wrapHash,
    keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }],
        ["OSTRAPAD-WRAP-v1", 4663n, PAD, jobId, 256, BOB, bytesToHex(w.pkHash), keccak256(cat(w.ct, w.wrapped)), 5n],
      ),
    ),
  );
  const posting = padPostingAccount(new Uint8Array(32).fill(1), CHAIN, PAD);
  const sig = await posting.signMessage({ message: { raw: wrapHash } });
  assert.equal(await recoverMessageAddress({ message: { raw: wrapHash }, signature: sig }), posting.address);
  const sha = bytesToHex(nodeSha(u("f")));
  assert.equal(
    padUploadMessage({ chainId: CHAIN, pad: PAD, jobId, kind: 2, sha256: sha, size: 9n }),
    keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }, { type: "uint64" }], ["OSTRAPAD-UPLOAD-v1", 4663n, PAD, jobId, 2, sha, 9n])),
  );
  assert.equal(
    padKemMessage({ chainId: CHAIN, pad: PAD, member: ALICE, pkHash: w.pkHash, posting: BOB, issuedAt: 77n }),
    keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint64" }], ["OSTRAPAD-KEM-v1", 4663n, PAD, ALICE, bytesToHex(w.pkHash), BOB, 77n])),
  );
  assert.equal(
    padReserveMessage({ chainId: CHAIN, pad: PAD, jobId, bytes: 10n, seq: 2n }),
    keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }], ["OSTRAPAD-RESERVE-v1", 4663n, PAD, jobId, 10n, 2n])),
  );
});

test("a job's byte allowance is 20 MB per USDG, at least 5 MB and at most 300 MB", () => {
  assert.equal(padJobByteAllowance(0n), 5_000_000);
  assert.equal(padJobByteAllowance(1_000_000n), 20_000_000);
  assert.equal(padJobByteAllowance(2_500_000n), 50_000_000);
  assert.equal(padJobByteAllowance(100_000_000n), 300_000_000);
});

test("Node's AES-GCM and the SDK agree on a segment sealed by Node", () => {
  const k = padNewJobKey();
  const h: PadEncHeader = { kind: PAD_ENC_KIND.reason, salt: padNewSalt(), plaintextLength: 5, order: null };
  const head = padEncodeHeader(h);
  const c = createCipheriv("aes-256-gcm", padFileKey(k, h.salt, h.kind), cat(new Uint8Array(11), Uint8Array.of(1)));
  c.setAAD(nodeSha(head));
  const body = Buffer.concat([c.update(u("hello")), c.final(), c.getAuthTag()]);
  assert.deepEqual(new TextDecoder().decode(padDecryptFile(k, padKeyCommit(k), cat(head, body)).plaintext), "hello");
});

test("a listing carries kem and post together, checked; a binary offer must be judged by the client", async () => {
  const { padListingFromFile, padServiceEntry, padKemBase64, padListingKem, padOffer } = await import("../src/index.ts");
  const k = kem(3);
  const b64 = padKemBase64(k.publicKey);
  assert.deepEqual(padListingKem(b64), k.publicKey);
  const offer = { id: "logo", title: "Logo", description: "A logo", input: "Brand name", price: "5", hours: 24, evaluator: "client", binary: true };
  const entry = padServiceEntry({ provider: BOB, offers: [padOffer(offer)], kem: b64, post: ALICE }, PAD, CHAIN);
  const parsed = padListingFromFile({ services: [entry] }, PAD, CHAIN);
  assert.equal(parsed?.listing.kem, b64);
  assert.equal(parsed?.listing.post, ALICE);
  assert.equal(parsed?.listing.offers[0]?.binary, true);
  assert.deepEqual(parsed?.problems, []);
  assert.throws(() => padOffer({ ...offer, evaluator: "pool" }), /client judges/);
  // a malformed key: the listing still parses for public orders, without kem and post, and says why
  const bad = padListingFromFile({ services: [{ ...entry, kem: b64.replace(/^..../, "////") }] }, PAD, CHAIN);
  assert.equal(bad?.listing.kem, undefined);
  assert.match(bad?.problems[0] ?? "", /private orders/);
  const half = padListingFromFile({ services: [{ ...entry, post: undefined }] }, PAD, CHAIN);
  assert.equal(half?.listing.kem, undefined);
  assert.throws(() => padServiceEntry({ provider: BOB, offers: [padOffer(offer)], kem: b64 }, PAD, CHAIN), /together/);
});

test("a wrap is deterministic for its job, round and recipient: the panel recomputes it, and a junk wrap does not pass", async () => {
  const { padVerifyWrap } = await import("../src/index.ts");
  const k = padNewJobKey();
  const bob = kem(2);
  const w = padWrapKey(k, CTX, BOB, bob.publicKey);
  assert.deepEqual(padWrapKey(k, CTX, BOB, bob.publicKey), w, "same inputs, same wrap");
  assert.ok(padVerifyWrap(k, padKeyCommit(k), w, BOB, bob.publicKey, CTX));
  assert.notDeepEqual(padWrapKey(k, { ...CTX, round: 2 }, BOB, bob.publicKey).ct, w.ct, "another round, another wrap");
  assert.ok(!padVerifyWrap(k, padKeyCommit(k), w, BOB, bob.publicKey, { ...CTX, round: 2 }));
  assert.ok(!padVerifyWrap(k, padKeyCommit(k), w, BOB, kem(5).publicKey, CTX), "another key");
  const other = padNewJobKey();
  assert.ok(!padVerifyWrap(other, padKeyCommit(k), w, BOB, bob.publicKey, CTX), "K that is not committed");
  // a junk wrap: right size and recipient, random ct, opens for nobody and does not recompute
  const junk = { ...w, ct: crypto.getRandomValues(new Uint8Array(1088)) };
  assert.equal(padUnwrapKey(junk, BOB, bob, padKeyCommit(k)), null);
  assert.ok(!padVerifyWrap(k, padKeyCommit(k), junk, BOB, bob.publicKey, CTX));
  // a wrap of another K for the right recipient opens, but unwrap refuses a K that does not match keyCommit
  const forged = padWrapKey(other, CTX, BOB, bob.publicKey);
  assert.equal(padUnwrapKey(forged, BOB, bob, padKeyCommit(k)), null);
  assert.deepEqual(padUnwrapKey(forged, BOB, bob, padKeyCommit(other)), other);
});

test("the streaming reader and writer give the in-memory bytes, with the same checks", async () => {
  const { padOpenFile, padSealFile, padBytesSource } = await import("../src/index.ts");
  const k = padNewJobKey();
  const n = 2 * PAD_ENC_SEGMENT + 77;
  const plain = new Uint8Array(n).map((_, i) => (i * 7) & 0xff);
  const h = orderHeader(k, n);
  const parts: Uint8Array[] = [];
  for await (const p of padSealFile(k, h, padBytesSource(plain))) parts.push(p);
  const file = cat(...parts);
  assert.deepEqual(padDecryptFile(k, padKeyCommit(k), file).plaintext, plain);
  const opened = await padOpenFile(k, padKeyCommit(k), padBytesSource(file));
  const out: Uint8Array[] = [];
  for await (const seg of opened.segments()) out.push(seg);
  assert.deepEqual(cat(...out), plain);
  await assert.rejects(() => padOpenFile(k, padKeyCommit(k), padBytesSource(file.subarray(0, file.length - 1))), /length/);
  await assert.rejects(() => padOpenFile(padNewJobKey(), padKeyCommit(k), padBytesSource(file)), /keyCommit/);
  const t = file.slice();
  t[t.length - 5]! ^= 1;
  const bad = await padOpenFile(k, padKeyCommit(k), padBytesSource(t));
  await assert.rejects(async () => {
    for await (const _ of bad.segments());
  }, /authenticate/);
});

test("salts differ within a job; manifests are bound to their job and kind; a pool job takes text attachments only", async () => {
  const { padCheckSalts, padCheckManifest, padCheckText } = await import("../src/index.ts");
  const a = padNewSalt();
  padCheckSalts([a, padNewSalt()]);
  assert.throws(() => padCheckSalts([a, padNewSalt(), a.slice()]), /share a salt/);
  const job = { id: JOB, client: ALICE, provider: BOB, chainId: CHAIN };
  padCheckManifest({ type: "ostrapad-order-v1", client: `eip155:${CHAIN}:${ALICE}`, provider: `eip155:${CHAIN}:${BOB}` }, PAD_ENC_KIND.order, job);
  assert.throws(() => padCheckManifest({ type: "ostrapad-order-v1", client: `eip155:${CHAIN}:${EVE}`, provider: `eip155:${CHAIN}:${BOB}` }, PAD_ENC_KIND.order, job), /another client/);
  padCheckManifest({ type: "ostrapad-delivery-v1", chain: `eip155:${CHAIN}`, job: JOB }, PAD_ENC_KIND.delivery, job);
  assert.throws(() => padCheckManifest({ type: "ostrapad-delivery-v1", chain: `eip155:${CHAIN}`, job: `0x${"33".repeat(32)}` }, PAD_ENC_KIND.delivery, job), /another job/);
  assert.throws(() => padCheckManifest({ type: "ostrapad-decision-v1", job: JOB }, PAD_ENC_KIND.delivery, job), /not a delivery/);
  padCheckManifest({ type: "ostrapad-decision-v1", job: JOB }, PAD_ENC_KIND.reason, job);
  const atts = [{ name: "x.bin", size: 1, sha256: bytesToHex(nodeSha(Uint8Array.of(0xff))), type: "binary" }];
  const prefix = padPlaintextPrefix({ type: "ostrapad-order-v1", attachments: atts });
  padParseManifest(prefix.length + 1, prefix.subarray(4));
  assert.throws(() => padParseManifest(prefix.length + 1, prefix.subarray(4), { pool: true }), /text attachments only/);
  padCheckText(u("héllo"), "a.txt");
  assert.throws(() => padCheckText(Uint8Array.of(0xff, 0xfe), "a.txt"), /UTF-8/);
});
