// A reputation proof in an Ostrapad listing (pad-reputation.ts): the challenge (the listing's content without the
// proof), the scope text, the proof's part files and the checks on what a listing writes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, keccak256, sha256, stringToHex, toHex, type Hex } from "viem";
import {
  OSTRAPAD,
  PAD_FILE_MAX_BYTES,
  PAD_REPUTATION_FIELD,
  PAD_REPUTATION_PART_TYPE,
  canonicalJson,
  padCidFromDigest,
  padListingChallenge,
  PAD_LISTINGS_SCOPE_TEXT,
  padListingScope,
  padReputationEntry,
  padReputationFromEntry,
  padReputationProofFromParts,
  padReputationProofParts,
  padServiceEntry,
  repPackDigest,
  repScope,
} from "../src/browser.ts";

const REP = getAddress("0x00000000000000000000000000000000000ce0de");
const provider = getAddress("0x00000000000000000000000000000000000000a1");
const offers = [{ id: "report", title: "Report", description: "A report.", input: "A topic.", price: "1", hours: 24, evaluator: "pool" as const }];
const file = () => ({ type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "Ostra Agent #7", services: [{ name: "web", endpoint: "https://x" }, padServiceEntry({ provider, offers })], registrations: [{ agentId: 7, agentRegistry: "eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }] });

test("canonical JSON: keys sorted at every level, no spaces; undefined fields left out", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: "x", c: null }, 2], u: undefined }), '{"a":[{"c":null,"d":"x"},2],"b":1}');
  assert.throws(() => canonicalJson({ a: 1n }), RangeError);
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), RangeError);
});

test("the listing challenge: the file's content without the proof field, whatever the key order; any other change moves it", () => {
  const f = file();
  const c = padListingChallenge(f);
  const withProof = { ...f, services: f.services.map((s) => (s.name === "Ostrapad" ? { ...s, [PAD_REPUTATION_FIELD]: { anything: true } } : s)) };
  assert.equal(padListingChallenge(withProof), c, "the proof field is not part of what it proves");
  const reordered = JSON.parse(JSON.stringify({ registrations: f.registrations, services: f.services, name: f.name, type: f.type })) as Record<string, unknown>;
  assert.equal(padListingChallenge(reordered), c);
  assert.equal(c, keccak256(stringToHex(canonicalJson(f))));
  assert.notEqual(padListingChallenge({ ...f, name: "Ostra Agent #8" }), c);
  const cheaper = { ...f, services: f.services.map((s) => (s.name === "Ostrapad" ? { ...s, offers: [{ ...offers[0], price: "0.5" }] } : s)) };
  assert.notEqual(padListingChallenge(cheaper), c);
  // A reputation field elsewhere (another service, the top level) is content like any other.
  assert.notEqual(padListingChallenge({ ...f, reputation: 1 }), c);
  // An entry for another pad is not the listing: its field counts.
  const other = { ...f, services: [...f.services, { name: "Ostrapad", endpoint: "eip155:4663:0x0000000000000000000000000000000000000001", reputation: 1 }] };
  assert.notEqual(padListingChallenge(other), padListingChallenge({ ...f, services: [...f.services, { name: "Ostrapad", endpoint: "eip155:4663:0x0000000000000000000000000000000000000001" }] }));
});

test("the listing scope: one for every listing, ostrapad:listings:<epoch>", () => {
  assert.equal(PAD_LISTINGS_SCOPE_TEXT, "ostrapad:listings");
  assert.equal(padListingScope(3n), keccak256(stringToHex("ostrapad:listings:3")));
  assert.equal(padListingScope(3n), repScope("ostrapad:listings", 3n));
  assert.notEqual(padListingScope(3n), padListingScope(4n));
});

test("the proof in part files under the uploader's limit, and back; parts out of order, cut or altered refused", () => {
  const bytes = new Uint8Array(81_690);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  const proof = toHex(bytes);
  const parts = padReputationProofParts(proof);
  assert.equal(parts.length, 11);
  for (const p of parts) {
    assert.equal(p.type, PAD_REPUTATION_PART_TYPE);
    assert.ok(new TextEncoder().encode(JSON.stringify(p)).length <= PAD_FILE_MAX_BYTES);
  }
  const digest = sha256(bytes);
  assert.equal(padReputationProofFromParts(parts, digest), proof);
  assert.equal(padReputationProofFromParts([...parts].reverse(), digest), null);
  assert.equal(padReputationProofFromParts(parts.slice(0, -1), digest), null);
  const altered = parts.map((p, i) => (i === 3 ? { ...p, data: `${(p.data as string).slice(0, -2)}00` } : p));
  assert.equal(padReputationProofFromParts(altered, digest), null);
  assert.equal(padReputationProofFromParts(parts, `0x${"00".repeat(32)}`), null);
  assert.throws(() => padReputationProofParts("0x1" as Hex), RangeError);
});

test("a listing's reputation object: written, read back; malformed ones are none", () => {
  const thresholds = { minCompleted: 2, minClients: 1, minVolume: 1_000_000n, maxFailPermille: 100, minTier: 0, maxFirstDay: 5 };
  const proof = toHex(new Uint8Array(100).fill(9));
  const entry = padReputationEntry({ reputation: REP, chainId: 4663, epoch: 6n, root: repPackDigest([1, 2, 3, 4, 5, 6, 7, 8]), pseudonym: repPackDigest([9, 9, 9, 9, 9, 9, 9, 9]), thresholds, proofParts: [padCidFromDigest(sha256(new Uint8Array([1])))], proof, anonymitySet: 6 });
  const read = padReputationFromEntry({ reputation: entry }, REP, 4663);
  assert.notEqual(read, null);
  assert.deepEqual(read?.parsed, { epoch: 6n, thresholds });
  assert.equal(read?.proofSha256, sha256(proof));
  assert.equal(padReputationFromEntry({ reputation: entry }, OSTRAPAD, 4663), null, "another contract's");
  assert.equal(padReputationFromEntry({ reputation: entry }, REP, 1), null, "another chain's");
  for (const bad of [
    { ...entry, type: "x" },
    { ...entry, epoch: "-1" },
    { ...entry, root: `0x${"ff".repeat(32)}` },
    { ...entry, thresholds: { ...entry.thresholds, maxFailPermille: "1001" } },
    { ...entry, thresholds: { ...entry.thresholds, minTier: "4" } },
    { ...entry, proofParts: [] },
    { ...entry, proofParts: ["https://example.com/p"] },
    { ...entry, proofSha256: "0x12" },
  ]) {
    assert.equal(padReputationFromEntry({ reputation: bad }, REP, 4663), null, JSON.stringify(bad).slice(0, 120));
  }
  assert.equal(padReputationFromEntry({}, REP, 4663), null);
});
