import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Channel } from "@x402/evm/batch-settlement/server";
import { IDLE_TIMEOUT_SECONDS, closeRequestedSince, closedSinceRequest, createLifecycle } from "../src/lifecycle.ts";
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
    // A close that happens marks the channel closed, as the server's closeThroughKeeper does.
    const lc = createLifecycle(
      store,
      async (c: Channel) => {
        closed.push(c.channelId);
        await store.updateMeta(c.channelId, (_c, meta) => ({ meta: { ...meta, closedAt: Date.now() } }));
      },
      600,
    );
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

test("a close that did not happen is requested again a timeout later, also after a restart, until it is closed", async () => {
  assert.equal(closedSinceRequest({}), false);
  assert.equal(closedSinceRequest({ closeRequestedAt: 100 }), false);
  assert.equal(closedSinceRequest({ closeRequestedAt: 100, closedAt: 99 }), false);
  assert.equal(closedSinceRequest({ closeRequestedAt: 100, closedAt: 100 }), true);
  const root = await mkdtemp(join(tmpdir(), "ostra-merchant-retry-"));
  const running: { shutdown: () => void }[] = [];
  try {
    let store = await FileChannelStorage.open(root);
    const tries: number[] = [];
    let works = false;
    // The keeper cannot close it (closeThroughKeeper's failures are logged and swallowed by the server) until `works`;
    // a close marks the channel closed in the store the running server uses.
    const closeOnIdle = async (c: Channel) => {
      tries.push(Date.now());
      if (!works) return;
      await store.updateMeta(c.channelId, (_c, meta) => ({ meta: { ...meta, closedAt: Date.now() } }));
    };
    const ch = channelRecord("stuck", { lastRequestTimestamp: Date.now() - 10_000 });
    await store.updateChannel(ch.channelId, () => ch);
    const first = createLifecycle(store, closeOnIdle, 400);
    running.push(first);
    await sleep(150);
    assert.equal(tries.length, 1, "closed once at start");
    await sleep(500);
    assert.equal(tries.length, 2, "requested again a timeout later");
    // A restart: the close requested and not done is requested again from the store.
    first.shutdown();
    store = await FileChannelStorage.open(root);
    const second = createLifecycle(store, closeOnIdle, 400);
    running.push(second);
    await sleep(600);
    assert.ok(tries.length >= 3, `requested again after a restart (${tries.length})`);
    works = true;
    await sleep(500);
    const n = tries.length;
    assert.ok(closedSinceRequest(store.meta(ch.channelId)), "closed at last");
    await sleep(1_000);
    assert.equal(tries.length, n, "not requested again once closed");
  } finally {
    for (const l of running) l.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
