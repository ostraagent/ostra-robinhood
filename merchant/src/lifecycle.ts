// Idle close (design v0.3: a channel with no paid request for 300 seconds is
// closed through the keeper). A port of the idle watchdog of the Solana
// session method (@solana/mpp server/session/lifecycle.ts, with the Ostra
// change that a keeper's "already closed" ends quietly): a timer per channel,
// restored from the store at start, and the activity rechecked atomically
// before a close begins. x402 channels can be funded again after a close, so
// a channel counts as idle again only after activity newer than its last
// close request. A close that was requested and did not happen (the keeper
// could not close it: no closedAt since the request, as after a failed idle
// close or a failed buyer refund) is requested again one idle timeout later,
// also after a restart, until it is closed; otherwise the channel's unspent
// deposit would wait for the buyer.

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

/** True when `meta` shows the channel closed at or after its last close request. */
export function closedSinceRequest(meta: ChannelMeta): boolean {
  return meta.closeRequestedAt !== undefined && meta.closedAt !== undefined && meta.closedAt >= meta.closeRequestedAt;
}

/**
 * Creates the idle watchdog of `store`: a channel whose last activity is
 * `idleTimeoutMs` old, with no close requested since (or one requested
 * `idleTimeoutMs` ago and not closed: no closedAt since), is marked
 * (closeRequestedAt) and handed to `closeOnIdle`, which sets closedAt when
 * the keeper closed it.
 */
export function createLifecycle(store: FileChannelStorage, closeOnIdle: (channel: Channel) => Promise<void>, idleTimeoutMs: number): Lifecycle {
  const timers = new Map<string, NodeJS.Timeout>();
  /** Set by shutdown: no timer is made after it, not even by a close that was under way. */
  let stopped = false;

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
    // A store that cannot be read or written now is looked at again a timeout later.
    const looked = store.updateMeta(key, (channel, meta) => {
      if (closeRequestedSince(channel, meta)) {
        // Closed since: nothing to do until new activity. Requested and not closed: requested again a timeout later.
        if (closedSinceRequest(meta)) return undefined;
        const again = (meta.closeRequestedAt as number) + idleTimeoutMs;
        if (now < again) {
          nextDeadline = again;
          return undefined;
        }
      }
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
    try {
      await looked;
    } catch (err) {
      schedule(key, Date.now() + idleTimeoutMs);
      throw err;
    }
    if (nextDeadline !== undefined) schedule(key, nextDeadline);
    else if (close !== undefined) {
      try {
        await closeOnIdle(close);
      } finally {
        // Looked at again a timeout later (also when closeOnIdle threw): a close that did not happen is requested again.
        schedule(key, Date.now() + idleTimeoutMs);
      }
    }
  }

  function schedule(key: string, deadlineMs: number): void {
    clear(key);
    if (stopped) return;
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
        const meta = store.meta(channelId);
        if (closeRequestedSince(channel, meta)) {
          if (!closedSinceRequest(meta)) schedule(channel.channelId.toLowerCase(), (meta.closeRequestedAt as number) + idleTimeoutMs);
          return;
        }
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
      stopped = true;
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    },
  };
}
