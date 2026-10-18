// Passkey backups: writes signed by real secp256k1 backup keys with the SDK's
// message, kept on disk and read back as the server serves them. The HTTP
// routes run against the relayer process in core's chain check.

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BACKUP_OP_DELETE, BACKUP_OP_PUT, BACKUP_SIGNATURE_WINDOW_SECONDS, MAX_BACKUP_BLOB_CHARS, signBackupWrite } from "@ostraagent/sdk";
import { BACKUPS_PER_IP, BackupStore } from "../src/backups.ts";

const CHAIN = 4663;
const owner = privateKeyToAccount(keccak256(stringToHex("OSTRA/RELAYER/TEST/backup-owner")));
const other = privateKeyToAccount(keccak256(stringToHex("OSTRA/RELAYER/TEST/backup-other")));
const nameOf = (n: number) => keccak256(stringToHex(`OSTRA/RELAYER/TEST/credential-${n}`));
const NOW = 1_800_000_000_000;
const sec = Math.floor(NOW / 1000);

async function put(account: typeof owner, name: Hex, blob: string, at: number, chainId = CHAIN) {
  return { op: "put", owner: account.address, blob, at, signature: await signBackupWrite(account, { op: BACKUP_OP_PUT, chainId, name, blob, at: BigInt(at) }) };
}

async function del(account: typeof owner, name: Hex, at: number) {
  return { op: "delete", owner: account.address, at, signature: await signBackupWrite(account, { op: BACKUP_OP_DELETE, chainId: CHAIN, name, blob: null, at: BigInt(at) }) };
}

test("a backup is bound to its first backup key; later writes must be by that key and later than the last", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ostra-relayer-backups-"));
  try {
    const store = await BackupStore.open(join(dir, "data"), CHAIN);
    const name = nameOf(1);
    assert.equal(store.get(name), undefined);
    const first = await store.write(name, await put(owner, name, "Zmlyc3Q", sec), "1.1.1.1", NOW);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(store.get(name), { name, owner: owner.address, blob: "Zmlyc3Q", updatedAt: sec });
    assert.equal(((await stat(join(dir, "data", "relayer-backups.json"))).mode & 0o777).toString(8), "600");

    // The same write again, or an older one: replayed.
    assert.equal((await store.write(name, await put(owner, name, "Zmlyc3Q", sec), "1.1.1.1", NOW)).body.error, "replayed");
    // Another key cannot take the name.
    assert.equal((await store.write(name, await put(other, name, "b3RoZXI", sec + 1), "1.1.1.1", NOW)).body.error, "owner_mismatch");
    // A signature by another key for this owner, a blob that is not the one signed, a write for another chain.
    const forged = { ...(await put(other, name, "c2Vjb25k", sec + 1)), owner: owner.address };
    assert.equal((await store.write(name, forged, "1.1.1.1", NOW)).body.error, "bad_signature");
    const swapped = { ...(await put(owner, name, "c2Vjb25k", sec + 1)), blob: "dGhpcmQ" };
    assert.equal((await store.write(name, swapped, "1.1.1.1", NOW)).body.error, "bad_signature");
    assert.equal((await store.write(name, await put(owner, name, "c2Vjb25k", sec + 1, 1), "1.1.1.1", NOW)).body.error, "bad_signature");
    // Too far from the relayer's clock.
    assert.equal((await store.write(name, await put(owner, name, "c2Vjb25k", sec + BACKUP_SIGNATURE_WINDOW_SECONDS + 1), "1.1.1.1", NOW)).body.error, "stale_signature");
    // Malformed requests.
    assert.equal((await store.write(name, { ...(await put(owner, name, "c2Vjb25k", sec + 1)), blob: "not base64url!" }, "1.1.1.1", NOW)).body.error, "bad_request");
    assert.equal((await store.write(name, await put(owner, name, "A".repeat(MAX_BACKUP_BLOB_CHARS), sec + 1), "1.1.1.1", NOW)).status, 200);
    assert.equal((await store.write(name, { ...(await put(owner, name, "c2Vjb25k", sec + 2)), blob: "A".repeat(MAX_BACKUP_BLOB_CHARS + 1) }, "1.1.1.1", NOW)).body.error, "bad_request");
    assert.equal((await store.write("0x1234", await put(owner, name, "c2Vjb25k", sec + 2), "1.1.1.1", NOW)).body.error, "bad_request");

    // The owner replaces it.
    assert.equal((await store.write(name, await put(owner, name, "c2Vjb25k", sec + 2), "1.1.1.1", NOW)).status, 200);
    assert.equal(store.get(name)?.blob, "c2Vjb25k");

    // A delete leaves the binding: no older write comes back, no other key takes the name, the owner writes again.
    const removed = await store.write(name, await del(owner, name, sec + 3), "1.1.1.1", NOW);
    assert.deepEqual(removed, { status: 200, body: { name, owner: owner.address, updatedAt: sec + 3, deleted: true } });
    assert.equal(store.get(name), undefined);
    assert.equal(store.lastWrite(name), sec + 3);
    assert.equal(store.lastWrite(nameOf(98)), undefined);
    assert.equal((await store.write(name, await put(owner, name, "c2Vjb25k", sec + 2), "1.1.1.1", NOW)).body.error, "replayed");
    assert.equal((await store.write(name, await put(other, name, "b3RoZXI", sec + 4), "1.1.1.1", NOW)).body.error, "owner_mismatch");
    assert.equal((await store.write(name, await put(owner, name, "YWdhaW4", sec + 4), "1.1.1.1", NOW)).status, 200);
    assert.equal((await store.write(nameOf(99), await del(owner, nameOf(99), sec), "1.1.1.1", NOW)).body.error, "no_backup");

    // Kept on disk.
    const reopened = await BackupStore.open(join(dir, "data"), CHAIN);
    assert.deepEqual(reopened.get(name), { name, owner: owner.address, blob: "YWdhaW4", updatedAt: sec + 4 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("at most BACKUPS_PER_IP new names per client IP address in 24 hours; writes to its own names are not counted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ostra-relayer-backups-"));
  try {
    const store = await BackupStore.open(join(dir, "data"), CHAIN);
    for (let i = 0; i < BACKUPS_PER_IP; i++) assert.equal((await store.write(nameOf(10 + i), await put(owner, nameOf(10 + i), "eA", sec), "2.2.2.2", NOW)).status, 200);
    assert.equal((await store.write(nameOf(30), await put(owner, nameOf(30), "eA", sec), "2.2.2.2", NOW)).body.error, "backup_limit");
    assert.equal((await store.write(nameOf(10), await put(owner, nameOf(10), "eQ", sec + 1), "2.2.2.2", NOW)).status, 200);
    assert.equal((await store.write(nameOf(30), await put(owner, nameOf(30), "eA", sec), "3.3.3.3", NOW)).status, 200);
    const later = NOW + 24 * 60 * 60 * 1000;
    const laterSec = Math.floor(later / 1000);
    assert.equal((await store.write(nameOf(31), await put(owner, nameOf(31), "eA", laterSec), "2.2.2.2", later)).status, 200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
