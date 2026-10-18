// The passkey backup's encryption (Web Crypto AES-256-GCM under HKDF-SHA-256
// of the PRF output). A test has no authenticator, so the PRF output is 32
// fixed bytes, the value a passkey's prf extension returns (results.first).
// The relayer side runs in core's chain check against the relayer process.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, sha256, utf8 } from "@ostraagent/sdk";
import { Keys, PASSKEY_PRF_INPUT, backupName, backupSignerOf, fromBase64Url, openSeed, sealSeed } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";

const master = new Uint8Array(32).fill(51);
const prf = sha256([utf8("OSTRA/CORE/TEST/prf-output")]);
const credentialId = utf8("OSTRA/CORE/TEST/credential-id");

test("a seed sealed under a passkey's PRF output opens only with that output, for that credential, unchanged", async () => {
  assert.equal(bytesToHex(PASSKEY_PRF_INPUT), bytesToHex(sha256([utf8("OSTRA/PASSKEY-PRF/v1")])));
  const blob = await sealSeed(master, prf, credentialId);
  assert.equal(blob.length, 124);
  assert.equal(fromBase64Url(blob)[0], 1);
  assert.deepEqual(await openSeed(blob, prf, credentialId), master);
  // A fresh salt and IV every time.
  const again = await sealSeed(master, prf, credentialId);
  assert.notEqual(again, blob);
  assert.deepEqual(await openSeed(again, prf, credentialId), master);

  const otherPrf = prf.slice();
  otherPrf[0] = (otherPrf[0] as number) ^ 1;
  await assert.rejects(openSeed(blob, otherPrf, credentialId), /does not open this backup/);
  await assert.rejects(openSeed(blob, prf, utf8("another credential")), /does not open this backup/);
  const bytes = fromBase64Url(blob);
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
  const tampered = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await assert.rejects(openSeed(tampered, prf, credentialId), /does not open this backup/);
  await assert.rejects(openSeed(blob.slice(0, 100), prf, credentialId), /not a version 1 passkey backup/);
  await assert.rejects(sealSeed(master, prf.slice(0, 31), credentialId), /32 bytes/);
});

test("the backup name hides the credential id; the backup key is the seed's, the same on every device", async () => {
  assert.equal(backupName(credentialId), bytesToHex(sha256([credentialId])));
  assert.throws(() => backupName(new Uint8Array(0)), /empty/);
  const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/TEST/fee-payer")));
  const keys = new Keys({ master, feePayer, store: new FileWotsStore("/nonexistent"), folder: new MemoryFolder(), backupExported: async () => true });
  assert.equal(keys.backupSigner().address, backupSignerOf(master).address);
  assert.notEqual(backupSignerOf(new Uint8Array(32).fill(52)).address, backupSignerOf(master).address);
  assert.deepEqual(await openSeed(await keys.passkeyBackup(prf, credentialId), prf, credentialId), master);
});
