import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHANNELS_DIR, FileChannelStorage, channelKey } from "../src/store.ts";
import { channelRecord } from "./fixtures.ts";

async function withDir(work: (dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ostra-merchant-store-"));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("records round-trip privately, keep their meta through scheme updates, and survive a reopen", () =>
  withDir(async (root) => {
    const store = await FileChannelStorage.open(root);
    assert.equal((await stat(store.dir)).mode & 0o777, 0o700);
    const c = channelRecord("a", { channelId: channelRecord("a").channelId.toUpperCase().replace("0X", "0x") });
    assert.equal(await store.get(c.channelId), undefined);
    const created = await store.updateChannel(c.channelId, () => c);
    assert.equal(created.status, "updated");
    const key = channelKey(c.channelId);
    assert.deepEqual(await readdir(store.dir), [`${key}.json`]);
    assert.equal((await stat(join(store.dir, `${key}.json`))).mode & 0o777, 0o600);
    await store.updateMeta(key, (_ch, meta) => ({ meta: { ...meta, closeRequestedAt: 5 } }));
    // The x402 scheme rebuilds the record without knowing the meta: it stays.
    await store.updateChannel(key, (current) => ({ ...channelRecord("a"), chargedCumulativeAmount: "300000", lastRequestTimestamp: (current?.lastRequestTimestamp ?? 0) + 1 }));
    assert.deepEqual(store.meta(key), { closeRequestedAt: 5 });
    assert.equal((await store.updateChannel(key, (current) => current)).status, "unchanged");

    const again = await FileChannelStorage.open(root);
    assert.equal((await again.get(key))?.chargedCumulativeAmount, "300000");
    assert.deepEqual(again.meta(key), { closeRequestedAt: 5 });
    assert.equal((await again.list()).length, 1);
    const deleted = await again.updateChannel(key, () => undefined);
    assert.equal(deleted.status, "deleted");
    assert.deepEqual(await readdir(again.dir), []);
    assert.deepEqual(again.meta(key), {});
    assert.equal((await again.updateChannel(key, () => undefined)).status, "unchanged");
    assert.equal(await again.updateMeta(key, () => ({ meta: { closedAt: 1 } })), undefined);
  }));

test("updates of one channel run one at a time, report each change and leave no temporary files", () =>
  withDir(async (root) => {
    const store = await FileChannelStorage.open(root);
    const changes: string[] = [];
    store.onChange((previous, next) => changes.push(`${previous?.chargedCumulativeAmount ?? "-"}>${next?.chargedCumulativeAmount ?? "-"}`));
    const c = channelRecord("b");
    await store.updateChannel(c.channelId, () => c);
    await Promise.all(
      Array.from({ length: 40 }, () => store.updateChannel(c.channelId, (current) => ({ ...(current ?? c), chargedCumulativeAmount: (BigInt(current?.chargedCumulativeAmount ?? "0") + 1n).toString() }))),
    );
    assert.equal((await store.get(c.channelId))?.chargedCumulativeAmount, "40");
    assert.equal(changes.length, 41);
    assert.equal(changes.at(-1), "39>40");
    assert.deepEqual(await readdir(store.dir), [`${channelKey(c.channelId)}.json`]);
    const record = JSON.parse(await readFile(join(store.dir, `${channelKey(c.channelId)}.json`), "utf8")) as { version: number };
    assert.equal(record.version, 1);
  }));

test("ids that are not bytes32, misnamed files and newer records are refused", () =>
  withDir(async (root) => {
    const store = await FileChannelStorage.open(root);
    await assert.rejects(store.get("../escape"), /invalid channel id/);
    await assert.rejects(store.updateChannel("0x12", () => channelRecord("c")), /invalid channel id/);
    await assert.rejects(store.updateChannel(channelRecord("c").channelId, () => channelRecord("d")), /returned channel/);
    const c = channelRecord("c");
    await writeFile(join(root, CHANNELS_DIR, `${channelKey(channelRecord("e").channelId)}.json`), JSON.stringify({ version: 1, channel: c, meta: {} }));
    await assert.rejects(FileChannelStorage.open(root), /holds channel/);
    await rm(join(root, CHANNELS_DIR), { recursive: true });
    await FileChannelStorage.open(root);
    await writeFile(join(root, CHANNELS_DIR, `${channelKey(c.channelId)}.json`), JSON.stringify({ version: 2, channel: c, meta: {} }));
    await assert.rejects(FileChannelStorage.open(root), /newer version/);
  }));
