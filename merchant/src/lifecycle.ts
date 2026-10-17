// Idle close (design v0.3: a channel with no paid request for 300 seconds is
// closed through the keeper). A port of the idle watchdog of the Solana
// session method (@solana/mpp server/session/lifecycle.ts, with the Ostra
// change that a keeper's "already closed" ends quietly): a timer per channel,
// restored from the store at start, and the activity rechecked atomically
// before a close begins. x402 channels can be funded again after a close, so
// a channel counts as idle again only after activity newer than its last
// close request.

import type { Channel } from "@x402/evm/batch-settlement/server";
import type { ChannelMeta, FileChannelStorage } from "./store.ts";

/** Idle timeout of channels: the Solana session method's default (server/Session.ts, `idleTimeoutSeconds = 300`). */
export const IDLE_TIMEOUT_SECONDS = 300;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface Lifecycle {
  /** Re-reads the channel's activity and resets its idle timer. */
  touch(channelId: string): void;
  /** Cancels every timer. */
  shutdown(): void;
}

/** True when `meta` shows a close request at or after the channel's last activity. */
export function closeRequestedSince(channel: Channel, meta: ChannelMeta): boolean {
  return meta.closeRequestedAt !== undefined && meta.closeRequestedAt >= channel.lastRequestTimestamp;
}

/**
 * Creates the idle watchdog of `store`: a channel whose last activity is
 * `idleTimeoutMs` old, with no close requested since, is marked
 * (closeRequestedAt) and handed to `closeOnIdle`.
 */
export function createLifecycle(store: FileChannelStorage, closeOnIdle: (channel: Channel) => Promise<void>, idleTimeoutMs: number): Lifecycle {
  const timers = new Map<string, NodeJS.Timeout>();

  function clear(key: string): void {
    const handle = timers.get(key);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(key);
    }
  }

  async function closeIfIdle(key: string): Promise<void> {
    timers.delete(key);
    let close: Channel | undefined;
    let nextDeadline: number | undefined;
    const now = Date.now();
    await store.updateMeta(key, (channel, meta) => {
      if (closeRequestedSince(channel, meta)) return undefined;
      const deadline = channel.lastRequestTimestamp + idleTimeoutMs;
      // A request in flight is activity: look again once its reservation ends.
      const pending = channel.pendingRequest !== undefined && channel.pendingRequest.expiresAt > now ? channel.pendingRequest.expiresAt : 0;
      if (now < deadline || pending > now) {
        nextDeadline = Math.max(deadline, pending);
        return undefined;
      }
      close = channel;
      return { meta: { ...meta, closeRequestedAt: now } };
    });
    if (nextDeadline !== undefined) schedule(key, nextDeadline);
    else if (close !== undefined) await closeOnIdle(close);
  }

  function schedule(key: string, deadlineMs: number): void {
    clear(key);
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      void closeIfIdle(key).catch(() => undefined);
      return;
    }
    const handle = setTimeout(
      () => {
        if (Date.now() < deadlineMs) schedule(key, deadlineMs);
        else void closeIfIdle(key).catch(() => undefined);
      },
      Math.min(remainingMs, MAX_TIMER_DELAY_MS),
    );
    handle.unref();
    timers.set(key, handle);
  }

  function scheduleFromStore(channelId: string): void {
    void store
      .get(channelId)
      .then((channel) => {
        if (channel === undefined) return clear(channelId.toLowerCase());
        if (closeRequestedSince(channel, store.meta(channelId))) return;
        schedule(channel.channelId.toLowerCase(), channel.lastRequestTimestamp + idleTimeoutMs);
      })
      .catch(() => undefined);
  }

  void store
    .list()
    .then((channels) => {
      for (const channel of channels) scheduleFromStore(channel.channelId);
    })
    .catch(() => undefined);

  return {
    touch(channelId) {
      scheduleFromStore(channelId);
    },
    shutdown() {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    },
  };
}
