import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bytesToHex, concatHex, keccak256, stringToHex, toHex, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FACILITATOR_KEY_FILE, MERCHANT_KEY_FILE, MerchantKeys, closeRequestMessage, isPrivateKey } from "../src/keys.ts";

test("keys are created private, reopen unchanged and sign close requests the keeper verifies", async () => {
  const root = await mkdtemp(join(tmpdir(), "ostra-merchant-keys-"));
  try {
    const dir = join(root, "secrets");
    const keys = await MerchantKeys.open(dir);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    for (const name of [MERCHANT_KEY_FILE, FACILITATOR_KEY_FILE]) {
      assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600);
      assert.match(await readFile(join(dir, name), "utf8"), /^[0-9a-f]{64}\n$/);
    }
    const again = await MerchantKeys.open(dir);
    assert.equal(again.merchant, keys.merchant);
    assert.equal(again.facilitator.address, keys.facilitator.address);
    assert.notEqual(keys.facilitator.address, keys.merchant);
    const key = `0x${(await readFile(join(dir, MERCHANT_KEY_FILE), "utf8")).trim()}` as const;
    assert.equal(privateKeyToAccount(key).address, keys.merchant);

    const channel = keccak256(stringToHex("channel"));
    const message = closeRequestMessage(4663, channel);
    // The keeper's message (keeper/src/keys.ts): "OSTRA/KEEPER/CLOSE/EVM/v1" || chainid (32) || channel id.
    assert.equal(bytesToHex(message), concatHex([stringToHex("OSTRA/KEEPER/CLOSE/EVM/v1"), toHex(4663n, { size: 32 }), channel]));
    const signature = await keys.signCloseRequest(4663, channel);
    assert.equal(await verifyMessage({ address: keys.merchant, message: { raw: message }, signature }), true);
    assert.equal(await verifyMessage({ address: keys.merchant, message: { raw: closeRequestMessage(1, channel) }, signature }), false);
    assert.throws(() => closeRequestMessage(4663, "0x12"), /32 bytes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keys readable by other users or malformed are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "ostra-merchant-keys-"));
  try {
    const dir = join(root, "secrets");
    await MerchantKeys.open(dir);
    await chmod(join(dir, MERCHANT_KEY_FILE), 0o644);
    await assert.rejects(MerchantKeys.open(dir), /accessible by other users/);
    await chmod(join(dir, MERCHANT_KEY_FILE), 0o600);
    await writeFile(join(dir, FACILITATOR_KEY_FILE), "not hex\n", { mode: 0o600 });
    await assert.rejects(MerchantKeys.open(dir), /32 bytes of hex/);
    await writeFile(join(dir, FACILITATOR_KEY_FILE), `${"00".repeat(32)}\n`, { mode: 0o600 });
    await assert.rejects(MerchantKeys.open(dir), /not a valid secp256k1 private key/);
    await chmod(dir, 0o755);
    await assert.rejects(MerchantKeys.open(dir), /accessible by other users/);
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
