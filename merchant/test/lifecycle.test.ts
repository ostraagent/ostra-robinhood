import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Channel } from "@x402/evm/batch-settlement/server";
import { IDLE_TIMEOUT_SECONDS, closeRequestedSince, createLifecycle } from "../src/lifecycle.ts";
import { FileChannelStorage } from "../src/store.ts";
import { channelRecord } from "./fixtures.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the idle timeout is the Solana session method's 300 seconds", () => {
  assert.equal(IDLE_TIMEOUT_SECONDS, 300);
  const c = channelRecord("x", { lastRequestTimestamp: 100 });
  assert.equal(closeRequestedSince(c, {}), false);
  assert.equal(closeRequestedSince(c, { closeRequestedAt: 99 }), false);
  assert.equal(closeRequestedSince(c, { closeRequestedAt: 100 }), true);
});

test("an idle channel is closed once, activity postpones it, and new activity after a close makes it idle again", async () => {
  const root = await mkdtemp(join(tmpdir(), "ostra-merchant-idle-"));
  const lifecycle = { shutdown: () => undefined } as { shutdown: () => void };
  try {
    const store = await FileChannelStorage.open(root);
    const closed: string[] = [];
    const now = Date.now();
    // Restored from the store at start: one idle already, one recent.
    const idle = channelRecord("idle", { lastRequestTimestamp: now - 10_000 });
    const busy = channelRecord("busy", { lastRequestTimestamp: now });
    await store.updateChannel(idle.channelId, () => idle);
    await store.updateChannel(busy.channelId, () => busy);
    const lc = createLifecycle(store, async (c: Channel) => void closed.push(c.channelId), 600);
    lifecycle.shutdown = () => lc.shutdown();
    store.onChange((_p, next) => {
      if (next !== undefined) lc.touch(next.channelId);
    });
    await sleep(200);
    assert.deepEqual(closed, [idle.channelId]);
    assert.ok(store.meta(idle.channelId).closeRequestedAt !== undefined);
    // Activity on the busy channel postpones its close.
    await sleep(300);
    await store.updateChannel(busy.channelId, (c) => ({ ...(c as Channel), lastRequestTimestamp: Date.now() }));
    await sleep(450);
    assert.deepEqual(closed, [idle.channelId]);
    await sleep(400);
    assert.deepEqual(closed, [idle.channelId, busy.channelId]);
    // Not closed twice; a paid request after the close makes it idle again.
    await sleep(700);
    assert.equal(closed.length, 2);
    await store.updateChannel(idle.channelId, (c) => ({ ...(c as Channel), lastRequestTimestamp: Date.now() }));
    await sleep(900);
    assert.deepEqual(closed, [idle.channelId, busy.channelId, idle.channelId]);
  } finally {
    lifecycle.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
