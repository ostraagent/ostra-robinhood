import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STATE_FILE, StateStore, emptyState } from "../src/store.ts";

test("the state round-trips, is private, and leaves no temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ostra-aggregator-store-"));
  try {
    const store = new StateStore(root);
    assert.deepEqual(await store.load(), emptyState());
    const state = emptyState();
    state.deposits.d1 = { deposit: "d1", depositor: "0x00000000000000000000000000000000000000aa", leaves: [{ keyRoot: "ab".repeat(32), amount: "10000000" }], attempt: 2, minAttempt: 1, queuedAt: 1, polledAt: null, pollNotBefore: 0 };
    state.open = { batch: null, searchFrom: "3", deposits: ["d1"], leaves: [{ keyRoot: "ab".repeat(32), amount: "10000000" }], appended: 0, stateHash: `0x${"cd".repeat(32)}`, approveBy: null, createdAt: 2 };
    await Promise.all([store.save(state), store.save(state), store.save(state)]);
    assert.deepEqual(await store.load(), state);
    assert.equal((await stat(join(root, STATE_FILE))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), [STATE_FILE]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a version 1 state loads with every deposit at leaf set 0", async () => {
  const root = await mkdtemp(join(tmpdir(), "ostra-aggregator-store-"));
  try {
    const record = { deposit: "d1", depositor: "0x00000000000000000000000000000000000000aa", leaves: [{ keyRoot: "ab".repeat(32), amount: "10000000" }], queuedAt: 1, polledAt: 5, pollNotBefore: 0 };
    await writeFile(join(root, STATE_FILE), JSON.stringify({ version: 1, deposits: { d1: record }, open: null }));
    assert.deepEqual(await new StateStore(root).load(), { version: 2, deposits: { d1: { ...record, attempt: 0, minAttempt: 0 } }, open: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown state version is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "ostra-aggregator-store-"));
  try {
    await writeFile(join(root, STATE_FILE), JSON.stringify({ version: 3 }));
    await assert.rejects(new StateStore(root).load(), /unknown state version/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
