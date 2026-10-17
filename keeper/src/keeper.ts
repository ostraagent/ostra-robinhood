// The keeper (design v0.3, core service 2; on Robinhood Chain, design v0.4).
// It guards x402 batch-settlement channels paid to Ostra seller vaults whose
// crank it holds. In such a channel the seller vault is the receiverAuthorizer
// and the seller's OstraSplit is the receiver:
//   * sellers forward their buyers' vouchers; the keeper keeps the highest one
//     per channel and claims it by the settle threshold (policy.ts), with the
//     crank through OstraVault.claim;
//   * every WATCH_INTERVAL_MS it reads its channels; a channel whose buyer
//     asked to close (initiateWithdraw) is claimed at once with the last
//     voucher and its unclaimed escrow is refunded to the buyer
//     (OstraVault.refund), before the withdraw delay ends;
//   * a seller's server may ask it to close a channel (an idle close or a
//     buyer's close), signed with the seller's merchant key: claim, refund;
//   * a channel with no unclaimed escrow left is paid out: x402BatchSettlement
//     settle moves the claimed amount to the split, OstraSplit distribute
//     divides it by the fixed shares (the keeper fee, the rest to the seller
//     vault), and release pays each share.
// This is the Solana keeper's settle, seal and distribute on the x402
// contract: a claim is the settle, claim plus refund is the seal, and settle,
// distribute and release are the distribution.
//
// The crank can only claim vouchers and refund escrow on channels paid to its
// vault; the keeper never holds a key that moves a seller's or a buyer's funds.

import { getAddress, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import {
  ostraSplitAbi,
  ostraSplitFactoryAbi,
  ostraVaultAbi,
  readChannel,
  readVault,
  usdgAbi,
  x402BatchSettlementAbi,
  type ChannelConfig,
  type ChannelState,
  type Deployment,
} from "@ostraagent/sdk";
import type { Sender } from "./chain.ts";
import {
  KEEPER_FEE_BPS,
  MIN_GRACE_SECONDS,
  NEW_CHANNELS_PER_SECOND,
  SETTLE_MAX_AGE_SECONDS,
  SETTLE_THRESHOLD_TOKENS,
  VOUCHERS_PER_SECOND_PER_CHANNEL,
  WATCH_INTERVAL_MS,
  type Config,
} from "./config.ts";
import { verifyCloseRequest, type KeeperKeys } from "./keys.ts";
import { KeyedLimiter, TokenBucket } from "./limits.ts";
import { guardProblem, settleReason, voucherUsable } from "./policy.ts";
import type { ChannelRecord, ChannelStore } from "./store.ts";
import {
  boundChannelId,
  parseChannelConfig,
  parseSignature,
  parseSplits,
  parseVoucher,
  verifyVoucher,
  type ChannelRecipient,
  type Voucher,
} from "./voucher.ts";

/** Upper bound on chain steps in one pass over a channel. */
const MAX_STEPS = 8;

/** An error the HTTP layer returns to the caller with `status` and `code`. */
export class KeeperError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "KeeperError";
    this.status = status;
    this.code = code;
  }
}

export type VoucherResult = { channel: string; accepted: boolean; reason?: "not_newer"; cumulative: string };
export type CloseResult = { channel: string; status: string; tx: string; steps: { step: string; tx: string }[] };
export type Terms = { chainId: number; token: string; feeRecipient: string; feeBps: number; minGraceSeconds: number };
export type Health = {
  chainId: number;
  token: string;
  feePayer: string;
  feePayerWei: string;
  guarded: number;
  lastPassAt: string | null;
  lastPassError: string | null;
};

/** A channel's state as the keeper reads it: "none" never funded, "closed" no unclaimed escrow left. */
type Phase = "none" | "open" | "closing" | "closed";

function phaseOf(ch: ChannelState): Phase {
  if (ch.balance === 0n && ch.totalClaimed === 0n) return "none";
  if (ch.balance === ch.totalClaimed) return "closed";
  return ch.pendingWithdrawal === null ? "open" : "closing";
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof KeeperError) throw err;
    throw new KeeperError(400, "invalid_request", (err as Error).message);
  }
}

function parseMerchant(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new KeeperError(400, "invalid_request", "merchant must be an address");
  return getAddress(value);
}

function heldVoucher(record: ChannelRecord): bigint | null {
  return record.voucher === null ? null : BigInt(record.voucher.maxClaimableAmount);
}

export type KeeperOptions = {
  client: PublicClient;
  config: Config;
  keys: KeeperKeys;
  store: ChannelStore;
  sender: Sender;
  /** Token decimals (USDG: 6). */
  decimals: number;
  /** Redacts secrets (the RPC URL) from logged text. */
  redact: (text: string) => string;
};

export class Keeper {
  readonly #client: PublicClient;
  readonly #config: Config;
  readonly #d: Deployment;
  readonly #keys: KeeperKeys;
  readonly #store: ChannelStore;
  readonly #sender: Sender;
  readonly #threshold: bigint;
  readonly #redact: (text: string) => string;
  readonly #records = new Map<string, ChannelRecord>();
  readonly #channels = new Map<string, ChannelState>();
  readonly #creating = new Map<string, Promise<ChannelRecord>>();
  readonly #ops = new Map<string, Promise<unknown>>();
  readonly #perChannel = new KeyedLimiter(VOUCHERS_PER_SECOND_PER_CHANNEL);
  readonly #newChannels = new TokenBucket(NEW_CHANNELS_PER_SECOND);
  #timer: NodeJS.Timeout | undefined;
  #passRunning = false;
  #lastPassAt: number | null = null;
  #lastPassError: string | null = null;

  private constructor(o: KeeperOptions) {
    this.#client = o.client;
    this.#config = o.config;
    this.#d = o.config.deployment;
    this.#keys = o.keys;
    this.#store = o.store;
    this.#sender = o.sender;
    this.#threshold = SETTLE_THRESHOLD_TOKENS * 10n ** BigInt(o.decimals);
    this.#redact = o.redact;
  }

  /** Loads the channel records; `run` starts the watch loop. */
  static async open(o: KeeperOptions): Promise<Keeper> {
    const keeper = new Keeper(o);
    for (const record of await o.store.loadAll()) keeper.#records.set(record.channel, record);
    return keeper;
  }

  /** Starts the watch loop: one pass now, then every WATCH_INTERVAL_MS. */
  run(): void {
    if (this.#timer !== undefined) return;
    void this.pass();
    this.#timer = setInterval(() => void this.pass(), WATCH_INTERVAL_MS);
  }

  /** Stops the watch loop and waits for the chain steps in progress. */
  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await Promise.allSettled([...this.#ops.values()]);
  }

  /** Waits until every queued chain step has finished. */
  async idle(): Promise<void> {
    while (this.#ops.size > 0) await Promise.allSettled([...this.#ops.values()]);
  }

  log(event: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    console.log(this.#redact(line));
  }

  #logError(event: string, err: unknown, fields: Record<string, unknown> = {}): void {
    this.log(event, { ...fields, error: this.#redact(err instanceof Error ? err.message : String(err)) });
  }

  /** The crank key a seller holding `merchant` installs on its vault. */
  crankFor(merchant: unknown): { merchant: string; crank: string } {
    const key = parseMerchant(merchant);
    return { merchant: key, crank: this.#keys.crankFor(key).address };
  }

  /** What a seller's offer must contain for the keeper to guard its channels. */
  terms(): Terms {
    return {
      chainId: this.#d.chainId,
      token: this.#d.token,
      feeRecipient: this.#config.feeRecipient,
      feeBps: KEEPER_FEE_BPS,
      minGraceSeconds: MIN_GRACE_SECONDS,
    };
  }

  async health(): Promise<Health> {
    return {
      chainId: this.#d.chainId,
      token: this.#d.token,
      feePayer: this.#keys.feePayer.address,
      feePayerWei: (await this.#client.getBalance({ address: this.#keys.feePayer.address })).toString(),
      guarded: [...this.#records.values()].filter((r) => !r.done).length,
      lastPassAt: this.#lastPassAt === null ? null : new Date(this.#lastPassAt).toISOString(),
      lastPassError: this.#lastPassError,
    };
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /** POST /v1/vouchers: { merchant, channelConfig, voucher, splits? }. */
  async acceptVoucher(body: unknown): Promise<VoucherResult> {
    if (!isRecord(body)) throw new KeeperError(400, "invalid_request", "body must be { merchant, channelConfig, voucher, splits? }");
    const merchant = parseMerchant(body.merchant);
    const config = invalid(() => parseChannelConfig(body.channelConfig));
    const voucher = invalid(() => parseVoucher(body.voucher));
    const channel = invalid(() => boundChannelId(config, this.#d.chainId, this.#d.batchSettlement, voucher.channelId));
    const splits = body.splits === undefined ? null : invalid(() => parseSplits(body.splits));
    if (!this.#perChannel.take(channel)) throw new KeeperError(429, "rate_limited", "too many requests for this channel");
    const record = await this.#recordFor(channel, config, merchant, splits, false);
    return this.#takeVoucher(record, voucher);
  }

  /** POST /v1/close: { merchant, channelConfig, signature, voucher?, splits? }, signed by the merchant key. */
  async close(body: unknown): Promise<CloseResult> {
    if (!isRecord(body)) throw new KeeperError(400, "invalid_request", "body must be { merchant, channelConfig, signature, voucher?, splits? }");
    const merchant = parseMerchant(body.merchant);
    const config = invalid(() => parseChannelConfig(body.channelConfig));
    const channel = invalid(() => boundChannelId(config, this.#d.chainId, this.#d.batchSettlement));
    const signature = invalid(() => parseSignature(body.signature, "signature"));
    const voucher = body.voucher === undefined ? null : invalid(() => parseVoucher(body.voucher));
    if (voucher !== null && voucher.channelId !== channel) throw new KeeperError(400, "invalid_request", "the voucher is for another channel");
    const splits = body.splits === undefined ? null : invalid(() => parseSplits(body.splits));
    if (!this.#perChannel.take(channel)) throw new KeeperError(429, "rate_limited", "too many requests for this channel");
    if (!(await verifyCloseRequest(merchant, this.#d.chainId, channel as Hex, signature))) {
      throw new KeeperError(403, "bad_signature", "the close request is not signed by the merchant key");
    }
    const record = await this.#recordFor(channel, config, merchant, splits, true);
    if (voucher !== null) await this.#takeVoucher(record, voucher);
    return this.#withOps(record.channel, () => this.#closeNow(record));
  }

  /**
   * The record of `channel`, created after checking on-chain that its
   * receiverAuthorizer is an Ostra vault in the keeper's token whose crank is
   * the one derived from `merchant`, that its receiver is that vault's
   * OstraSplit with the given shares, that its withdraw delay is at least
   * MIN_GRACE_SECONDS, and that the shares pay the keeper fee.
   */
  async #recordFor(channel: string, config: ChannelConfig, merchant: Address, splits: ChannelRecipient[] | null, closing: boolean): Promise<ChannelRecord> {
    let record = this.#records.get(channel);
    if (record === undefined) {
      let creating = this.#creating.get(channel);
      if (creating === undefined) {
        if (!this.#newChannels.take()) throw new KeeperError(429, "rate_limited", "too many new channels; retry shortly");
        creating = this.#createRecord(channel, config, merchant, splits, closing);
        this.#creating.set(channel, creating);
        void creating.finally(() => this.#creating.delete(channel)).catch(() => undefined);
      }
      record = await creating;
    }
    if (record.merchant !== merchant) throw new KeeperError(403, "wrong_merchant", "this channel is guarded for another merchant key");
    if (splits !== null) await this.#checkSplits(record.config, splits);
    return record;
  }

  async #splitAddress(vault: Address, recipients: readonly ChannelRecipient[]): Promise<Address> {
    return this.#client.readContract({
      address: this.#d.splitFactory,
      abi: ostraSplitFactoryAbi,
      functionName: "splitAddress",
      args: [this.#d.token, vault, recipients.map((r) => r.recipient), recipients.map((r) => r.bps)],
    });
  }

  async #checkSplits(config: ChannelConfig, splits: ChannelRecipient[]): Promise<void> {
    if ((await this.#splitAddress(config.receiverAuthorizer, splits)) !== getAddress(config.receiver)) {
      throw new KeeperError(400, "wrong_splits", "the splits do not give the channel's receiver (the seller's OstraSplit)");
    }
  }

  async #createRecord(channel: string, config: ChannelConfig, merchant: Address, splits: ChannelRecipient[] | null, closing: boolean): Promise<ChannelRecord> {
    if (getAddress(config.token) !== this.#d.token) throw new KeeperError(403, "wrong_mint", `the keeper serves token ${this.#d.token} only`);
    const ch = await readChannel(this.#client, this.#d.batchSettlement, channel as Hex);
    const phase = phaseOf(ch);
    if (phase === "none") throw new KeeperError(404, "not_found", `channel ${channel} does not exist`);
    if (!closing && phase === "closed") throw new KeeperError(409, "channel_closed", `channel ${channel} holds no unclaimed escrow`);
    const vault = await readVault(this.#client, this.#d, config.receiverAuthorizer);
    if (vault === null) throw new KeeperError(403, "not_ostra_vault", `the channel's receiverAuthorizer ${config.receiverAuthorizer} is not an Ostra vault`);
    const crank = this.#keys.crankFor(merchant);
    if (vault.crank !== crank.address) {
      throw new KeeperError(403, "not_keeper_crank", `the crank of vault ${vault.vault} is not the keeper crank of merchant key ${merchant}`);
    }
    if (vault.token !== this.#d.token) throw new KeeperError(403, "wrong_mint", "the vault and the channel are in different tokens");
    let recipients: ChannelRecipient[];
    if (splits !== null) {
      await this.#checkSplits(config, splits);
      recipients = splits;
    } else if ((await this.#splitAddress(vault.vault, [])) === getAddress(config.receiver)) {
      recipients = [];
    } else {
      throw new KeeperError(400, "splits_required", "send the channel's splits with the first request for it");
    }
    const problem = guardProblem({
      gracePeriod: config.withdrawDelay,
      recipients,
      feeRecipient: this.#config.feeRecipient,
      feeBps: KEEPER_FEE_BPS,
      minGraceSeconds: MIN_GRACE_SECONDS,
    });
    if (problem === "grace_too_short") {
      throw new KeeperError(403, problem, `the channel withdraw delay is ${config.withdrawDelay} s; the keeper guards channels with at least ${MIN_GRACE_SECONDS} s`);
    }
    if (problem === "keeper_fee_missing") {
      throw new KeeperError(403, problem, `the channel split must pay at least ${KEEPER_FEE_BPS} bps to the keeper fee recipient ${this.#config.feeRecipient}`);
    }
    const record: ChannelRecord = {
      version: 1,
      channel,
      config,
      merchant,
      vault: vault.vault,
      split: getAddress(config.receiver),
      token: this.#d.token,
      recipients: recipients.map((r) => ({ recipient: r.recipient, bps: r.bps })),
      voucher: null,
      unsettledSince: null,
      steps: [],
      done: false,
      createdAt: nowSeconds(),
    };
    await this.#store.save(record);
    this.#records.set(channel, record);
    this.#channels.set(channel, ch);
    this.log("guard", { channel, vault: vault.vault, split: record.split, merchant, phase });
    return record;
  }

  async #refresh(record: ChannelRecord): Promise<ChannelState> {
    const ch = await readChannel(this.#client, this.#d.batchSettlement, record.channel as Hex);
    this.#channels.set(record.channel, ch);
    return ch;
  }

  async #takeVoucher(record: ChannelRecord, voucher: Voucher): Promise<VoucherResult> {
    let ch = this.#channels.get(record.channel) ?? (await this.#refresh(record));
    // A top-up raises the balance; re-read once before refusing a voucher above it.
    if (voucher.maxClaimableAmount > ch.balance) ch = await this.#refresh(record);
    const phase = phaseOf(ch);
    if (phase === "none") throw new KeeperError(409, "channel_closed", `channel ${record.channel} no longer exists`);
    if (phase === "closed") throw new KeeperError(409, "channel_closed", `channel ${record.channel} holds no unclaimed escrow`);
    if (!(await verifyVoucher(voucher, record.config, this.#d.chainId, this.#d.batchSettlement))) {
      throw new KeeperError(400, "bad_voucher_signature", "the voucher is not signed by the channel's payerAuthorizer");
    }
    if (voucher.maxClaimableAmount > ch.balance) throw new KeeperError(400, "over_deposit", "the voucher is above the channel balance");
    const held = heldVoucher(record);
    const floor = held !== null && held > ch.totalClaimed ? held : ch.totalClaimed;
    if (voucher.maxClaimableAmount <= floor) return { channel: record.channel, accepted: false, reason: "not_newer", cumulative: floor.toString() };
    record.voucher = { maxClaimableAmount: voucher.maxClaimableAmount.toString(), signature: voucher.signature };
    // The age rule compares chain time with chain time (block timestamps), never the server clock.
    if (record.unsettledSince === null) record.unsettledSince = Number(await this.#chainNow());
    // A paid-out channel funded again (x402 channels can be): guard it again.
    if (record.done) record.done = false;
    await this.#store.save(record);
    this.log("voucher", { channel: record.channel, cumulative: voucher.maxClaimableAmount, claimed: ch.totalClaimed });
    this.#schedule(record.channel);
    return { channel: record.channel, accepted: true, cumulative: voucher.maxClaimableAmount.toString() };
  }

  // -------------------------------------------------------------------------
  // Chain work, one channel at a time
  // -------------------------------------------------------------------------

  #withOps<T>(channel: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#ops.get(channel) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#ops.set(channel, next);
    void next.finally(() => {
      if (this.#ops.get(channel) === next) this.#ops.delete(channel);
    }).catch(() => undefined);
    return next;
  }

  /** Queues a check of `channel` (claim, refund or pay out as its state requires). */
  #schedule(channel: string): void {
    void this.#withOps(channel, async () => {
      const record = this.#records.get(channel);
      if (record === undefined || record.done) return;
      try {
        await this.#advance(record);
      } catch (err) {
        this.#logError("step_failed", err, { channel });
      }
    });
  }

  async #chainNow(): Promise<bigint> {
    return (await this.#client.getBlock({ blockTag: "latest" })).timestamp;
  }

  /** One watch pass: reads every guarded channel and queues those that need a step. */
  async pass(): Promise<void> {
    if (this.#passRunning) return;
    this.#passRunning = true;
    try {
      const now = await this.#chainNow();
      const active = [...this.#records.values()].filter((r) => !r.done);
      const states = await Promise.all(active.map((r) => readChannel(this.#client, this.#d.batchSettlement, r.channel as Hex)));
      active.forEach((record, i) => {
        const ch = states[i] as ChannelState;
        this.#channels.set(record.channel, ch);
        if (this.#needsStep(record, ch, now)) this.#schedule(record.channel);
      });
      this.#perChannel.prune();
      this.#lastPassAt = Date.now();
      this.#lastPassError = null;
    } catch (err) {
      this.#lastPassError = this.#redact(err instanceof Error ? err.message : String(err));
      this.#logError("pass_failed", err);
    } finally {
      this.#passRunning = false;
    }
  }

  #settleDue(record: ChannelRecord, ch: ChannelState, now: bigint): boolean {
    return (
      settleReason({
        claimed: ch.totalClaimed,
        voucher: heldVoucher(record),
        unsettledSince: record.unsettledSince,
        now,
        threshold: this.#threshold,
        maxAgeSeconds: SETTLE_MAX_AGE_SECONDS,
      }) !== null
    );
  }

  #needsStep(record: ChannelRecord, ch: ChannelState, now: bigint): boolean {
    switch (phaseOf(ch)) {
      case "open":
        return this.#settleDue(record, ch, now);
      case "none":
      case "closing":
      case "closed":
        return true;
    }
  }

  /** Takes the steps the channel's current state calls for (an open channel is only claimed, never closed). */
  async #advance(record: ChannelRecord): Promise<void> {
    for (let i = 0; i < MAX_STEPS; i++) {
      const ch = await this.#refresh(record);
      switch (phaseOf(ch)) {
        case "none":
          return this.#finish(record, "gone");
        case "open":
          if (this.#settleDue(record, ch, await this.#chainNow())) await this.#claim(record, ch);
          return;
        case "closing":
          // The buyer asked to close: claim the last voucher before the withdraw delay ends, then refund the rest at once.
          if (voucherUsable(heldVoucher(record), ch.totalClaimed)) await this.#claim(record, ch);
          else await this.#refund(record, ch);
          break;
        case "closed":
          await this.#payOut(record);
          return this.#finish(record, "paid_out");
      }
    }
  }

  /** Claims the last voucher, refunds the rest and pays out: the seller's close request. */
  async #closeNow(record: ChannelRecord): Promise<CloseResult> {
    const before = record.steps.length;
    let status: string = "closed";
    for (let i = 0; i < MAX_STEPS; i++) {
      const ch = await this.#refresh(record);
      const phase = phaseOf(ch);
      status = phase;
      if (phase === "none") {
        // A channel refunded in full by this request, with nothing claimed, is empty: it was closed.
        if (record.steps.length > before) status = "closed";
        await this.#finish(record, "gone");
        break;
      }
      if (phase === "open" || phase === "closing") {
        if (voucherUsable(heldVoucher(record), ch.totalClaimed)) await this.#claim(record, ch);
        else await this.#refund(record, ch);
        continue;
      }
      await this.#payOut(record);
      await this.#finish(record, "paid_out");
      status = "closed";
      break;
    }
    const closeStep = [...record.steps].reverse().find((s) => s.step === "refund" || s.step === "claim");
    const last = closeStep ?? record.steps[record.steps.length - 1];
    if (last === undefined) throw new KeeperError(409, "channel_closed", `channel ${record.channel} was closed without the keeper`);
    return {
      channel: record.channel,
      status,
      tx: last.tx,
      steps: record.steps.slice(before).map((s) => ({ step: s.step, tx: s.tx })),
    };
  }

  async #finish(record: ChannelRecord, why: string): Promise<void> {
    record.done = true;
    await this.#store.save(record);
    this.#channels.delete(record.channel);
    this.log("done", { channel: record.channel, why });
  }

  async #step(record: ChannelRecord, step: string, tx: string, fields: Record<string, unknown> = {}): Promise<void> {
    record.steps.push({ step, tx, at: nowSeconds() });
    await this.#store.save(record);
    this.log(step, { channel: record.channel, tx, ...fields });
  }

  /** The crank of the record's merchant, refused when the seller moved its vault's crank away from the keeper. */
  async #crank(record: ChannelRecord): Promise<PrivateKeyAccount> {
    const crank = this.#keys.crankFor(getAddress(record.merchant));
    const vault = await readVault(this.#client, this.#d, getAddress(record.vault));
    if (vault === null || vault.crank !== crank.address) {
      throw new Error(`the crank of vault ${record.vault} is no longer the keeper's; the seller settles this channel itself`);
    }
    return crank;
  }

  /** OstraVault.claim with the held voucher, from the crank. */
  async #claim(record: ChannelRecord, ch: ChannelState): Promise<void> {
    const held = heldVoucher(record);
    if (record.voucher === null || !voucherUsable(held, ch.totalClaimed)) return;
    const crank = await this.#crank(record);
    const claims = [
      {
        voucher: { channel: record.config, maxClaimableAmount: held },
        signature: record.voucher.signature as Hex,
        totalClaimed: held,
      },
    ];
    const sent = await this.#sender.fromCrank(crank, { address: getAddress(record.vault), abi: ostraVaultAbi, functionName: "claim", args: [claims] });
    // A newer voucher that arrived while this one was being claimed starts its own age.
    const newer = heldVoucher(record);
    record.unsettledSince = newer !== null && newer > held ? Number(await this.#chainNow()) : null;
    await this.#step(record, "claim", sent.hash, { claimed: held });
  }

  /** OstraVault.refund of the unclaimed escrow to the buyer, from the crank. */
  async #refund(record: ChannelRecord, ch: ChannelState): Promise<void> {
    const available = ch.balance - ch.totalClaimed;
    if (available <= 0n) return;
    const crank = await this.#crank(record);
    const sent = await this.#sender.fromCrank(crank, { address: getAddress(record.vault), abi: ostraVaultAbi, functionName: "refund", args: [record.config, available] });
    await this.#step(record, "refund", sent.hash, { refunded: available });
  }

  /**
   * Pays the claimed amount out: x402BatchSettlement.settle to the split,
   * creating the split first if it does not exist yet, OstraSplit.distribute,
   * then release to every share holder. All permissionless, from the fee
   * payer. A release the token refuses stays owed in the split (anyone may
   * release it later) and does not hold the others up.
   */
  async #payOut(record: ChannelRecord): Promise<void> {
    const split = getAddress(record.split);
    const token = getAddress(record.token);
    const [claimed, settled] = await this.#client.readContract({
      address: this.#d.batchSettlement,
      abi: x402BatchSettlementAbi,
      functionName: "receivers",
      args: [split, token],
    });
    if (claimed > settled) {
      const sent = await this.#sender.fromFeePayer({ address: this.#d.batchSettlement, abi: x402BatchSettlementAbi, functionName: "settle", args: [split, token] });
      await this.#step(record, "settle", sent.hash, { amount: claimed - settled });
    }
    const code = await this.#client.getCode({ address: split });
    if (code === undefined || code === "0x") {
      const sent = await this.#sender.fromFeePayer({
        address: this.#d.splitFactory,
        abi: ostraSplitFactoryAbi,
        functionName: "createSplit",
        args: [token, getAddress(record.vault), record.recipients.map((r) => getAddress(r.recipient)), record.recipients.map((r) => r.bps)],
      });
      await this.#step(record, "create_split", sent.hash);
    }
    const [balance, totalOwed] = await Promise.all([
      this.#client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [split] }),
      this.#client.readContract({ address: split, abi: ostraSplitAbi, functionName: "totalOwed" }),
    ]);
    if (balance > totalOwed) {
      const sent = await this.#sender.fromFeePayer({ address: split, abi: ostraSplitAbi, functionName: "distribute", args: [] });
      await this.#step(record, "distribute", sent.hash, { amount: balance - totalOwed });
    }
    const accounts = [getAddress(record.vault), ...record.recipients.map((r) => getAddress(r.recipient))];
    for (const account of accounts) {
      const owed = await this.#client.readContract({ address: split, abi: ostraSplitAbi, functionName: "owed", args: [account] });
      if (owed === 0n) continue;
      try {
        const sent = await this.#sender.fromFeePayer({ address: split, abi: ostraSplitAbi, functionName: "release", args: [account] });
        await this.#step(record, "release", sent.hash, { account, amount: owed });
      } catch (err) {
        this.#logError("release_failed", err, { channel: record.channel, account });
      }
    }
  }
}
