// The disk folder and the seed backup: private modes, atomic writes,
// exclusive creates, secrets, a folder other users can read refused; the
// passphrase backup opens with its passphrase only.

import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { openSeedBackup, sealSeedBackup } from "@ostraagent/core";
import { openSeedWithPassphrase, sealSeedWithPassphrase } from "../src/backup-cli.ts";
import { DiskFolder } from "../src/disk.ts";
import { openKeys } from "../src/keys.ts";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-mcp-disk-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a disk folder: 0700 folders, 0600 entries, atomic writes, exclusive creates, secrets", async () => {
  const f = new DiskFolder(join(root, "a"));
  assert.equal(await f.read("x.json"), undefined);
  await f.write("x.json", "one");
  await f.write("x.json", "two");
  assert.equal(await f.read("x.json"), "two");
  assert.equal(((await stat(join(root, "a"))).mode & 0o777).toString(8), "700");
  assert.equal(((await stat(join(root, "a", "x.json"))).mode & 0o777).toString(8), "600");
  await f.create("y.json", "1");
  await assert.rejects(f.create("y.json", "2"), /EEXIST/);
  await f.append("log", "a\n");
  await f.append("log", "b\n");
  assert.equal(await f.read("log"), "a\nb\n");
  const s = new Uint8Array(32).fill(7);
  await f.createSecret("k.key", s);
  assert.deepEqual(await f.readSecret("k.key"), s);
  await assert.rejects(f.createSecret("k.key", s), /EEXIST/);
  assert.deepEqual(await f.list(), ["k.key", "log", "x.json", "y.json"]);
  assert.ok((await readdir(join(root, "a"))).every((n) => !n.endsWith(".tmp")));
  await f.remove("y.json");
  assert.equal(await f.read("y.json"), undefined);
  assert.throws(() => f.folder("../escape"), /invalid record name/);
  await assert.rejects(f.read("../x"), /invalid record name/);
  const shared = join(root, "shared");
  await new DiskFolder(shared).ensure();
  await chmod(shared, 0o755);
  await assert.rejects(new DiskFolder(shared).ensure(), /accessible by other users/);
});

test("the agent's keys: created once in OSTRA_HOME, the same on the next open", async () => {
  const home = join(root, "home");
  const a = await openKeys(home, null);
  assert.equal(a.masterCreated, true);
  const b = await openKeys(home, null);
  assert.equal(b.masterCreated, false);
  assert.equal(a.feePayer.address, b.feePayer.address);
  assert.equal(a.merchantKey(4663, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"), b.merchantKey(4663, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"));
  assert.equal(await a.backupExported(), false);
  assert.equal(((await stat(join(home, "master.key"))).mode & 0o777).toString(8), "600");
});

test("the seed backup opens with its passphrase only", async () => {
  const seed = new Uint8Array(32).map((_, i) => i);
  const sealed = await sealSeedWithPassphrase(seed, "correct horse battery");
  assert.deepEqual(await openSeedWithPassphrase(sealed, "correct horse battery"), seed);
  await assert.rejects(openSeedWithPassphrase(sealed, "wrong passphrase!!"), /does not open/);
  const b = JSON.parse(sealed) as { ciphertext: string };
  const tampered = JSON.stringify({ ...JSON.parse(sealed), ciphertext: (b.ciphertext[0] === "0" ? "1" : "0") + b.ciphertext.slice(1) });
  await assert.rejects(openSeedWithPassphrase(tampered, "correct horse battery"), /does not open/);
});

test("the web app's seed backup (core seed-backup.ts) and this package's open each other's files", async () => {
  const seed = new Uint8Array(32).map((_, i) => 255 - i);
  const fromWeb = await sealSeedBackup(seed, "correct horse battery");
  assert.deepEqual(await openSeedWithPassphrase(fromWeb, "correct horse battery"), seed);
  const fromMcp = await sealSeedWithPassphrase(seed, "correct horse battery");
  assert.deepEqual(await openSeedBackup(fromMcp, "correct horse battery"), seed);
  assert.deepEqual(Object.keys(JSON.parse(fromWeb) as object), Object.keys(JSON.parse(fromMcp) as object));
  await assert.rejects(openSeedBackup(fromMcp, "wrong passphrase!!"), /does not open/);
  await assert.rejects(openSeedWithPassphrase(fromWeb, "wrong passphrase!!"), /does not open/);
  await assert.rejects(sealSeedBackup(seed, "too short"), /at least 12/);
  await assert.rejects(openSeedBackup("{}", "correct horse battery"), /not an Ostra seed backup/);
});
