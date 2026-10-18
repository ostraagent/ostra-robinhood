// The passkey backup write the relayer checks: its message layout, its
// limits, and its EIP-191 signature by a real secp256k1 key.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BACKUP_OP_DELETE, BACKUP_OP_PUT, MAX_BACKUP_BLOB_CHARS, backupWriteMessage, isBackupBlob, isBackupName, signBackupWrite, verifyBackupWrite } from "../src/index.ts";

const name = keccak256(stringToHex("OSTRA/SDK/TEST/backup-name"));
const owner = privateKeyToAccount(keccak256(stringToHex("OSTRA/SDK/TEST/backup-owner")));

test("a backup write is domain || op || chain id || name || keccak256(blob) || at, signed EIP-191 by the backup key", async () => {
  const put = { op: BACKUP_OP_PUT, chainId: 4663, name, blob: "YmxvYg", at: 1_800_000_000n } as const;
  const m = backupWriteMessage(put);
  assert.equal(m.length, 27 + 1 + 32 + 32 + 32 + 8);
  assert.equal(new TextDecoder().decode(m.subarray(0, 27)), "OSTRA/PASSKEY-BACKUP/EVM/v1");
  assert.equal(m[27], 1);
  assert.equal(bytesToHex(m.subarray(28, 60)), `0x${(4663).toString(16).padStart(64, "0")}`);
  assert.equal(bytesToHex(m.subarray(60, 92)), name);
  assert.equal(bytesToHex(m.subarray(92, 124)), keccak256(stringToHex("YmxvYg")));
  assert.equal(bytesToHex(m.subarray(124)), `0x${(1_800_000_000).toString(16).padStart(16, "0")}`);
  const del = backupWriteMessage({ op: BACKUP_OP_DELETE, chainId: 4663, name, blob: null, at: 1_800_000_000n });
  assert.equal(del[27], 2);
  assert.equal(bytesToHex(del.subarray(92, 124)), `0x${"0".repeat(64)}`);

  const signature = await signBackupWrite(owner, put);
  assert.equal(await verifyBackupWrite(owner.address, put, signature), true);
  assert.equal(await verifyBackupWrite(owner.address, { ...put, blob: "b3RoZXI" }, signature), false);
  assert.equal(await verifyBackupWrite(owner.address, { ...put, chainId: 1 }, signature), false);
  assert.equal(await verifyBackupWrite(owner.address, put, "0x1234"), false);

  assert.throws(() => backupWriteMessage({ ...put, blob: null }), /carries a blob/);
  assert.throws(() => backupWriteMessage({ op: BACKUP_OP_DELETE, chainId: 4663, name, blob: "eA", at: 1n }), /no blob/);
  assert.throws(() => backupWriteMessage({ ...put, name: name.toUpperCase().replace("0X", "0x") as `0x${string}` }), /lowercase/);
  assert.equal(isBackupName(name), true);
  assert.equal(isBackupBlob("A".repeat(MAX_BACKUP_BLOB_CHARS)), true);
  assert.equal(isBackupBlob("A".repeat(MAX_BACKUP_BLOB_CHARS + 1)), false);
  assert.equal(isBackupBlob("a+b"), false);
  assert.equal(isBackupBlob(""), false);
});
