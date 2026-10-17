import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bytesToHex, concatHex, keccak256, stringToHex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CRANK_MASTER_FILE, FEE_PAYER_FILE, KeeperKeys, closeRequestMessage, isPrivateKey, verifyCloseRequest } from "../src/keys.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ostra-keeper-keys-"));
}

const account = (name: string) => privateKeyToAccount(keccak256(stringToHex(name)));

test("keys are created once, private, and read back unchanged", async () => {
  const root = await tempDir();
  try {
    const dir = join(root, "secrets");
    const keys = await KeeperKeys.open(dir, 4663);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    for (const file of [CRANK_MASTER_FILE, FEE_PAYER_FILE]) {
      assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
      assert.match(await readFile(join(dir, file), "utf8"), /^[0-9a-f]{64}\n$/);
    }
    const again = await KeeperKeys.open(dir, 4663);
    assert.equal(again.feePayer.address, keys.feePayer.address);
    const merchant = account("merchant").address;
    assert.equal(again.crankFor(merchant).address, keys.crankFor(merchant).address);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a key file other users can read is refused", async () => {
  const root = await tempDir();
  try {
    const dir = join(root, "secrets");
    await KeeperKeys.open(dir, 4663);
    await chmod(join(dir, FEE_PAYER_FILE), 0o644);
    await assert.rejects(KeeperKeys.open(dir, 4663), /accessible by other users/);
    await chmod(join(dir, FEE_PAYER_FILE), 0o600);
    await chmod(dir, 0o755);
    await assert.rejects(KeeperKeys.open(dir, 4663), /accessible by other users/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each merchant key gets its own crank, separate per chain and per keeper", async () => {
  const root = await tempDir();
  try {
    const keys = await KeeperKeys.open(join(root, "a"), 4663);
    const otherChain = await KeeperKeys.open(join(root, "a"), 1);
    const otherKeeper = await KeeperKeys.open(join(root, "b"), 4663);
    const m1 = account("m1").address;
    const m2 = account("m2").address;
    const c1 = keys.crankFor(m1).address;
    assert.notEqual(keys.crankFor(m2).address, c1);
    assert.notEqual(otherChain.crankFor(m1).address, c1);
    assert.notEqual(otherKeeper.crankFor(m1).address, c1);
    assert.notEqual(c1, keys.feePayer.address);
    // The same key whatever the address case.
    assert.equal(keys.crankFor(m1.toLowerCase() as `0x${string}`).address, c1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only keys in 1..n-1 are secp256k1 private keys", () => {
  assert.equal(isPrivateKey(new Uint8Array(32)), false);
  assert.equal(isPrivateKey(new Uint8Array(32).fill(0xff)), false);
  assert.equal(isPrivateKey(new Uint8Array(31).fill(1)), false);
  assert.equal(isPrivateKey(new Uint8Array(32).fill(1)), true);
});

test("a close request verifies only for the merchant key, the chain and the channel it was signed for", async () => {
  const merchant = account("merchant");
  const channel = keccak256(stringToHex("channel"));
  const message = closeRequestMessage(4663, channel);
  assert.equal(bytesToHex(message), concatHex([stringToHex("OSTRA/KEEPER/CLOSE/EVM/v1"), toHex(4663n, { size: 32 }), channel]));
  const signature = await merchant.signMessage({ message: { raw: message } });
  assert.equal(await verifyCloseRequest(merchant.address, 4663, channel, signature), true);
  assert.equal(await verifyCloseRequest(merchant.address, 4663, keccak256(stringToHex("other")), signature), false);
  assert.equal(await verifyCloseRequest(merchant.address, 1, channel, signature), false);
  assert.equal(await verifyCloseRequest(account("other").address, 4663, channel, signature), false);
  assert.equal(await verifyCloseRequest(merchant.address, 4663, channel, signature.slice(0, -2) as `0x${string}`), false);
});
