// What src/pad.ts builds for OstraPad, compared byte for byte with the live contract (OSTRAPAD) on a fork of Robinhood
// Chain mainnet: its constants, job ids, action digests (each action word as the contract hashes it, checked through
// actionDigest), the CREATE2 boxes, the fees; and the content helpers (CIDs, listings, files) that need no chain.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getAddress, keccak256, sha256, stringToHex, toHex, type Address, type Hex } from "viem";
import {
  OSTRAPAD,
  PAD,
  PAD_BOX_CODE_HASH,
  PAD_DOMAIN,
  ostraPadAbi,
  padActionDigest,
  padActionHash,
  padAppealBox,
  padAppealFee,
  padBondBox,
  padBoxAddress,
  padCidFromDigest,
  padCommit,
  padDigest,
  padDigestFromCid,
  padEvaluatorFee,
  padJobBox,
  padJobId,
  padJobSalt,
  padListingDigest,
  padListingFromFile,
  padOffer,
  padOrderFile,
  padServiceEntry,
  padTermsProblems,
  readPadJob,
  readPadProvider,
  type PadAction,
  type PadTerms,
} from "../src/pad.ts";
import { USDG } from "../src/constants.ts";
import { startFork, type Fork } from "./fork.ts";

let fork: Fork;

before(async () => {
  fork = await startFork();
});

after(async () => {
  await fork?.stop();
});

const read = (functionName: string, args: readonly unknown[] = []) => fork.client.readContract({ address: OSTRAPAD, abi: ostraPadAbi, functionName: functionName as never, args: args as never });

const A: Address = "0x1111111111111111111111111111111111111111";
const B: Address = "0x2222222222222222222222222222222222222222";
const C: Address = "0x3333333333333333333333333333333333333333";
const H1: Hex = keccak256(stringToHex("one"));
const H2: Hex = keccak256(stringToHex("two"));

test("the constants, the domain and the box code hash are the contract's", async () => {
  assert.equal(await read("DOMAIN"), PAD_DOMAIN);
  assert.equal(await read("BOX_CODE_HASH"), PAD_BOX_CODE_HASH);
  assert.equal(getAddress((await read("TOKEN")) as Address), USDG);
  for (const [name, value] of Object.entries(PAD)) assert.equal(await read(name), value, name);
});

test("job ids, boxes and fees are the contract's", async () => {
  const terms: PadTerms = { client: A, provider: B, evaluator: "0x0000000000000000000000000000000000000000", budget: 12_345_678n, description: H1, clientCommit: padCommit(H2), salt: toHex(7n, { size: 32 }) };
  const id = padJobId(terms);
  assert.equal(await read("jobId", [terms]), id);
  assert.equal(getAddress((await read("jobBox", [id])) as Address), padJobBox(id));
  assert.equal(getAddress((await read("boxAddress", [padJobSalt(id)])) as Address), padBoxAddress(padJobSalt(id)));
  assert.equal(getAddress((await read("appealBox", [id, 2, C])) as Address), padAppealBox(id, 2, C));
  for (const e of [true, false]) assert.equal(getAddress((await read("bondBox", [A, e])) as Address), padBondBox(A, e));
  for (const b of [100_000n, 4_999_999n, 5_000_000n, 12_345_678n, 500_000_000n]) {
    assert.equal(await read("evaluatorFeeFor", [b]), padEvaluatorFee(b), `evaluator fee of ${b}`);
    assert.equal(await read("appealFeeFor", [b]), padAppealFee(b), `appeal fee of ${b}`);
  }
  assert.deepEqual(padTermsProblems(terms), []);
  assert.equal(padTermsProblems({ ...terms, clientCommit: `0x${"00".repeat(32)}` }).length, 1);
  assert.equal(padTermsProblems({ ...terms, provider: A }).length, 1);
  assert.equal(padTermsProblems({ ...terms, budget: 99_999n }).length, 1);
  assert.equal(await readPadJob(fork.client, id), null);
  const p = await readPadProvider(fork.client, B);
  assert.equal(p.limit, 5_000_000n);
});

test("every action digest is actionDigest of the action word the contract hashes", async () => {
  const actions: PadAction[] = [
    { kind: "create", id: H1 },
    { kind: "cancel", id: H1 },
    { kind: "accept", id: H1, providerCommit: H2 },
    { kind: "submit", id: H1, deliverable: H2 },
    { kind: "decide", id: H1, round: 3, approve: true, reason: H2 },
    { kind: "decide", id: H1, round: 0, approve: false, reason: `0x${"00".repeat(32)}` },
    { kind: "appeal", id: H1, round: 1 },
    { kind: "vote", id: H1, round: 2, agree: false },
    { kind: "join", evaluator: A, amount: 50_000_000n, nonce: 4n },
    { kind: "leave", evaluator: A, nonce: 5n },
    { kind: "withdraw", account: A, evaluator: true, nonce: 6n },
    { kind: "withdraw", account: A, evaluator: false, nonce: 7n },
    { kind: "bond", provider: B, amount: 25_000_000n, nonce: 8n },
    { kind: "sweep job", id: H1, nonce: 9n },
    { kind: "sweep bond", account: B, evaluator: false, nonce: 10n },
  ];
  for (const a of actions) {
    const word = padActionHash(a);
    assert.equal(await read("actionDigest", [word]), padActionDigest(word), a.kind);
    assert.equal(padDigest(a), padActionDigest(word));
  }
  // The listing digest is under the same domain and names no action the contract checks.
  assert.equal(await read("actionDigest", [keccak256(stringToHex("x"))]), padActionDigest(keccak256(stringToHex("x"))));
  assert.notEqual(padListingDigest(7n, A), padListingDigest(8n, A));
});

test("CIDs: the uploader's raw sha2-256 CIDv1 round-trips through its digest; other CIDs are refused", () => {
  // A profile the uploader pinned on mainnet (OstraRegistry, block 0x5af3eb4).
  const uri = "ipfs://bafkreihsyjcyfubkfcjys6pgs3igjc3yvl3bojid75vv5gf2qvx6ux7nom";
  const d = padDigestFromCid(uri);
  assert.notEqual(d, null);
  assert.equal(padCidFromDigest(d as Hex), uri);
  const bytes = new TextEncoder().encode('{"a":1}');
  assert.equal(padDigestFromCid(padCidFromDigest(sha256(bytes))), sha256(bytes));
  assert.equal(padDigestFromCid("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"), null);
  assert.equal(padDigestFromCid("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"), null);
});

test("offers, listings and orders are checked; a listing is read back from a registration file", () => {
  const offer = { id: "token-report", title: "Token report", description: "A report on one Robinhood Chain token.", input: "The token address.", price: "2.5", hours: 24, evaluator: "pool" };
  assert.deepEqual(padOffer(offer), offer);
  assert.throws(() => padOffer({ ...offer, id: "Bad" }));
  assert.throws(() => padOffer({ ...offer, price: "0.09" }));
  assert.throws(() => padOffer({ ...offer, price: "1.1234567" }));
  assert.throws(() => padOffer({ ...offer, hours: 169 }));
  assert.throws(() => padOffer({ ...offer, evaluator: "me" }));
  const entry = padServiceEntry({ provider: A, offers: [offer as never] });
  const file = { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "x", services: [{ name: "agentWallet", endpoint: `eip155:4663:${B}` }, entry] };
  const back = padListingFromFile(file);
  assert.deepEqual(back, { listing: { provider: A, offers: [offer] }, problems: [] });
  const bad = padListingFromFile({ services: [{ ...entry, offers: [offer, { ...offer, price: "9999" }, offer] }] });
  assert.equal(bad?.listing.offers.length, 1);
  assert.equal(bad?.problems.length, 2);
  assert.equal(padListingFromFile({ services: [{ ...entry, endpoint: `eip155:4663:${C}` }] }), null);
  assert.throws(() => padServiceEntry({ provider: A, offers: [offer as never, offer as never] }));
  const order = padOrderFile({ agentId: "12", offer: "token-report", client: B, provider: A, input: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" });
  assert.equal(order.type, "ostrapad-order-v1");
  assert.throws(() => padOrderFile({ agentId: "x", offer: "a", client: B, provider: A, input: "y" }));
});
