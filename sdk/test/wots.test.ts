// Checks the WOTS signer against golden vectors produced by the Solana program
// crate (ostraagent/ostra e4a4153, program-tests/tests/wots_vectors.rs), which
// src/Wots.sol also matches, and exercises the one-time safety rules against a
// real on-disk store.

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fromHex, toHex } from "../src/hash.ts";
import { FileWotsStore } from "../src/wots-file.ts";
import {
  WOTS_CHAIN_END,
  WOTS_CHAINS,
  WOTS_CHECKSUM_CHAINS,
  WOTS_MAX_VERIFIER_STEPS,
  WOTS_MSG_CHAINS,
  WOTS_N,
  WOTS_SALT_LEN,
  WOTS_SIGNATURE_LEN,
  WotsKey,
  WotsKeychain,
  WotsKeyMismatchError,
  WotsKeyReuseError,
  deriveWotsSeed,
  wotsDigits,
  wotsRecoverKeyRoot,
  wotsVerifierSteps,
  wotsVerify,
} from "../src/wots.ts";

type KeyCase = { index: string; seed: string; key_root: string };
type SigCase = {
  index: string;
  message_name: string;
  message: string;
  signature: string;
  digits: number[];
  verifier_steps: number;
};
type Vectors = {
  params: Record<string, number>;
  inputs: { master: string; keychain: string };
  raw_seed_7: { seed: string; key_root: string };
  keys: KeyCase[];
  signatures: SigCase[];
};

const v: Vectors = JSON.parse(readFileSync(new URL("./vectors/wots.json", import.meta.url), "utf8"));
const master = fromHex(v.inputs.master);
const keychainId = fromHex(v.inputs.keychain);

const dirs: string[] = [];
async function freshStore(): Promise<FileWotsStore> {
  const dir = await mkdtemp(join(tmpdir(), "ostra-wots-"));
  dirs.push(dir);
  return new FileWotsStore(dir);
}
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test("parameters match the program crate", () => {
  assert.deepEqual(v.params, {
    n: WOTS_N,
    salt_len: WOTS_SALT_LEN,
    msg_chains: WOTS_MSG_CHAINS,
    checksum_chains: WOTS_CHECKSUM_CHAINS,
    chains: WOTS_CHAINS,
    chain_end: WOTS_CHAIN_END,
    signature_len: WOTS_SIGNATURE_LEN,
    max_verifier_steps: WOTS_MAX_VERIFIER_STEPS,
  });
});

test("key roots and derived seeds match the program crate", () => {
  assert.equal(toHex(WotsKey.fromSeed(fromHex(v.raw_seed_7.seed)).keyRoot()), v.raw_seed_7.key_root);
  assert.equal(v.keys.length, 3);
  for (const k of v.keys) {
    const seed = deriveWotsSeed(master, keychainId, BigInt(k.index));
    assert.equal(toHex(seed), k.seed, `seed ${k.index}`);
    assert.equal(toHex(WotsKey.fromSeed(seed).keyRoot()), k.key_root, `key root ${k.index}`);
  }
});

test("signatures, digits and verifier cost match the program crate", async () => {
  const keychain = new WotsKeychain(master, keychainId, await freshStore());
  assert.equal(v.signatures.length, 3);
  for (const c of v.signatures) {
    const index = BigInt(c.index);
    const message = fromHex(c.message);
    const keyCase = v.keys.find((k) => k.index === c.index);
    assert.ok(keyCase);
    const keyRoot = fromHex(keyCase.key_root);

    const signature = await keychain.sign(index, message, keyRoot);
    assert.equal(toHex(signature), c.signature, `signature ${c.message_name}`);
    const salt = signature.subarray(0, WOTS_SALT_LEN);
    assert.deepEqual(Array.from(wotsDigits(salt, message)), c.digits);
    assert.equal(wotsVerifierSteps(salt, message), c.verifier_steps);
    assert.ok(c.verifier_steps <= WOTS_MAX_VERIFIER_STEPS);

    // Verifies exactly as the program does; any change breaks it.
    assert.ok(wotsVerify(fromHex(c.signature), message, keyRoot));
    const tamperedMessage = new Uint8Array([...message, 0]);
    assert.ok(!wotsVerify(signature, tamperedMessage, keyRoot));
    const tamperedSig = fromHex(c.signature);
    tamperedSig[WOTS_SALT_LEN + 5] = (tamperedSig[WOTS_SALT_LEN + 5] as number) ^ 1;
    assert.ok(!wotsVerify(tamperedSig, message, keyRoot));
    assert.notEqual(toHex(wotsRecoverKeyRoot(tamperedSig, message)), toHex(keyRoot));
  }
});

test("an index never signs two different messages, even after a restart", async () => {
  const store = await freshStore();
  const a = new TextEncoder().encode("pay 1 to alice");
  const b = new TextEncoder().encode("pay 1 to mallory");

  const first = new WotsKeychain(master, keychainId, store);
  const sigA = await first.sign(5n, a);
  // Retry of the same message: identical bytes, still one record.
  assert.equal(toHex(await first.sign(5n, a)), toHex(sigA));
  await assert.rejects(() => first.sign(5n, b), WotsKeyReuseError);

  // A new process (new keychain object, same store directory) is still bound.
  const restarted = new WotsKeychain(master, keychainId, new FileWotsStore(store.dir));
  await assert.rejects(() => restarted.sign(5n, b), WotsKeyReuseError);
  assert.equal(toHex(await restarted.sign(5n, a)), toHex(sigA));

  const files = await readdir(join(store.dir, toHex(keychainId)));
  assert.deepEqual(files, ["00000000000000000005.json"]);
});

test("concurrent signers cannot both claim one index", async () => {
  const store = await freshStore();
  const enc = new TextEncoder();
  const results = await Promise.allSettled(
    ["m0", "m1", "m2", "m3"].map((m) => new WotsKeychain(master, keychainId, store).sign(9n, enc.encode(m))),
  );
  const ok = results.filter((r) => r.status === "fulfilled");
  const reuse = results.filter((r) => r.status === "rejected" && r.reason instanceof WotsKeyReuseError);
  assert.equal(ok.length, 1);
  assert.equal(reuse.length, 3);
});

test("a key that does not match the expected key root is never used", async () => {
  const store = await freshStore();
  const keychain = new WotsKeychain(master, keychainId, store);
  const wrongRoot = keychain.keyRoot(1n);
  await assert.rejects(() => keychain.sign(0n, new Uint8Array([1]), wrongRoot), WotsKeyMismatchError);
  assert.equal(await store.load(keychainId, 0n), undefined);
});

test("input validation", async () => {
  assert.throws(() => WotsKey.fromSeed(new Uint8Array(31)), RangeError);
  assert.throws(() => deriveWotsSeed(master, keychainId, -1n), RangeError);
  assert.throws(() => wotsRecoverKeyRoot(new Uint8Array(WOTS_SIGNATURE_LEN - 1), new Uint8Array()), RangeError);
  assert.throws(() => new WotsKeychain(new Uint8Array(32), new Uint8Array(16), new FileWotsStore("/nonexistent")), RangeError);
});
