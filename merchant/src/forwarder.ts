// Forwards every voucher the seller is paid with to the keeper (design v0.3:
// the seller forwards its buyers' vouchers to the keeper endpoint).
//
// The channel store reports each change of a channel record (store.ts
// onChange); a change that raises what the channel has been charged
// (chargedCumulativeAmount, committed only once a request is paid) queues the
// voucher that paid it. Only the latest voucher per channel is kept: it
// covers every earlier one. A forward that fails for a reason that may pass
// (network, rate limit, keeper error) is retried every RETRY_INTERVAL_MS; a
// refusal (4xx other than 429) is logged and dropped.

import { getAddress, type Hex } from "viem";
import type { ChannelConfig } from "@ostraagent/sdk";
import type { Channel } from "@x402/evm/batch-settlement/server";
import { KeeperRequestError, type KeeperClient, type Split, type WireVoucher } from "./keeper-client.ts";

/** Retry interval for failed forwards: the keeper's watch interval (30 s, decided 14 Oct 2026). */
export const RETRY_INTERVAL_MS = 30_000;

/** A channel's config as the keeper reads it (checksummed addresses, a numeric withdraw delay). */
export function wireChannelConfig(config: Channel["channelConfig"]): ChannelConfig {
  return {
    payer: getAddress(config.payer),
    payerAuthorizer: getAddress(config.payerAuthorizer),
    receiver: getAddress(config.receiver),
    receiverAuthorizer: getAddress(config.receiverAuthorizer),
    token: getAddress(config.token),
    withdrawDelay: Number(config.withdrawDelay),
    salt: config.salt.toLowerCase() as Hex,
  };
}

/** The voucher `channel`'s latest charge was paid with, or undefined when it has none. */
export function paidVoucher(channel: Channel): WireVoucher | undefined {
  if (channel.signature === "" || BigInt(channel.chargedCumulativeAmount) === 0n) return undefined;
  return { channelId: channel.channelId.toLowerCase() as Hex, maxClaimableAmount: channel.signedMaxClaimable, signature: channel.signature as Hex };
}

/** True when `next` was charged more than `previous`: a request was paid with `next`'s voucher. */
export function chargeRaised(previous: Channel | undefined, next: Channel | undefined): next is Channel {
  if (next === undefined || paidVoucher(next) === undefined) return false;
  return BigInt(next.chargedCumulativeAmount) > BigInt(previous?.chargedCumulativeAmount ?? "0");
}

export type Log = (event: string, fields?: Record<string, unknown>) => void;

type Pending = { config: ChannelConfig; voucher: WireVoucher };

export class VoucherForwarder {
  readonly #keeper: KeeperClient;
  readonly #splits: readonly Split[];
  readonly #log: Log;
  readonly #onClosed: (channelId: string) => void;
  readonly #pending = new Map<string, Pending>();
  readonly #sending = new Set<string>();
  #timer: NodeJS.Timeout | undefined;

  /** `onClosed` learns of a channel the keeper reports closed (no unclaimed escrow left). */
  constructor(keeper: KeeperClient, splits: readonly Split[], log: Log, onClosed: (channelId: string) => void = () => undefined) {
    this.#keeper = keeper;
    this.#splits = splits;
    this.#log = log;
    this.#onClosed = onClosed;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      for (const channel of this.#pending.keys()) void this.#flush(channel);
    }, RETRY_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Channels whose latest voucher has not reached the keeper yet. */
  get pending(): number {
    return this.#pending.size;
  }

  submit(channel: Channel): void {
    const voucher = paidVoucher(channel);
    if (voucher === undefined) return;
    this.#pending.set(voucher.channelId, { config: wireChannelConfig(channel.channelConfig), voucher });
    void this.#flush(voucher.channelId);
  }

  async #flush(channel: string): Promise<void> {
    if (this.#sending.has(channel)) return;
    this.#sending.add(channel);
    try {
      for (;;) {
        const item = this.#pending.get(channel);
        if (item === undefined) return;
        const cumulative = item.voucher.maxClaimableAmount;
        try {
          const reply = await this.#keeper.forwardVoucher(item.config, item.voucher, this.#splits);
          this.#log("voucher_forwarded", { channel, cumulative, accepted: reply.accepted, reason: reply.reason });
        } catch (err) {
          const refused = err instanceof KeeperRequestError && err.status >= 400 && err.status < 500 && err.status !== 429;
          this.#log(refused ? "voucher_refused" : "voucher_forward_failed", { channel, cumulative, error: (err as Error).message });
          if (!refused) return;
          if (err.code === "channel_closed") this.#onClosed(channel);
        }
        // A newer voucher may have arrived while this one was in flight.
        if (this.#pending.get(channel) === item) this.#pending.delete(channel);
      }
    } finally {
      this.#sending.delete(channel);
    }
  }
}
