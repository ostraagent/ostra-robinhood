// An Ostra seller's x402 batch-settlement method (design v0.3, decided 14 Oct
// 2026; on Robinhood Chain, design v0.4): the standard x402 batch-settlement
// scheme (@x402/evm/batch-settlement/server), with
//   * receiverAuthorizer = the seller's Ostra vault, whose crank is the keeper
//     crank of the seller's merchant key (checked on-chain at start-up), and
//     payTo = the seller's OstraSplit: the keeper fee the keeper's terms name
//     (30 bps to the Ostra operator vault), any splits the seller adds, and
//     the rest to the vault;
//   * withdraw delay = at least the keeper's minimum (15 minutes), so a
//     voucher outlasts a buyer's close;
//   * no receiver-authorizer key: the vault cannot sign, so claims and
//     refunds go through the keeper (OstraVault.claim and refund from the
//     crank). A buyer's x402 refund, and a channel idle for 300 seconds
//     (lifecycle.ts), are closed through the keeper's close request;
//   * every paid voucher forwarded to the keeper (forwarder.ts);
//   * the paid route runs only for a request whose verification charged the
//     channel the price (a voucher, or a deposit with its voucher); a refund
//     is answered by the method itself, and a voucher that already paid for a
//     request is answered 409;
//   * this server's own facilitator (facilitator.ts), which verifies vouchers
//     and sends buyers' EIP-3009 deposits;
//   * channels an Ostra buyer opened from its own vault (design v0.3: the
//     seller server also accepts channels a vault opened on-chain, verified
//     from on-chain state, so payments between Ostra agents stay vault to
//     vault). Such a channel carries no x402 deposit; its first voucher names
//     a channel the store does not know, which is read on-chain and adopted
//     only when it is exactly what this seller's offer asks for
//     (vaultChannelProblem), with what is already claimed on-chain as the
//     charge floor. From then on it is an ordinary channel.
// Any x402 batch-settlement client can pay it; nothing on the buyer side is
// Ostra-specific.

import type { IncomingMessage } from "node:http";
import { createPublicClient, getAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  USDG_EIP712_DOMAIN,
  X402_MAX_WITHDRAW_DELAY,
  assertRobinhoodChain,
  channelId as computeChannelId,
  checkDeployment,
  ostraSplitFactoryAbi,
  readChannel,
  readVault,
  retryingHttp,
  robinhoodChain,
  usdgAbi,
  type ChannelState,
  type Deployment,
  type VaultState,
} from "@ostraagent/sdk";
import { decodePaymentSignatureHeader, x402HTTPResourceServer, type HTTPAdapter, type HTTPResponseInstructions } from "@x402/core/http";
import { x402ResourceServer, type SettleContext, type VerifyContext } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { isBatchSettlementDepositPayload, isBatchSettlementRefundPayload, isBatchSettlementVoucherPayload } from "@x402/evm";
import { BatchSettlementEvmScheme, type Channel } from "@x402/evm/batch-settlement/server";
import { createFacilitator, X402_NETWORK } from "./facilitator.ts";
import { VoucherForwarder, chargeRaised, paidVoucher, wireChannelConfig, type Log } from "./forwarder.ts";
import { KeeperClient, KeeperRequestError, type KeeperTerms, type Split } from "./keeper-client.ts";
import type { MerchantKeys } from "./keys.ts";
import { IDLE_TIMEOUT_SECONDS, createLifecycle } from "./lifecycle.ts";
import type { FileChannelStorage } from "./store.ts";

const BPS_DENOMINATOR = 10_000;
/** OstraSplit.MAX_RECIPIENTS. */
const MAX_SPLITS = 32;
const ZERO = zeroAddress;

/** x402 batch-settlement error codes this method answers with (errors.ts of @x402/evm 2.28.0). */
const ERR_REFUND_NO_BALANCE = "invalid_batch_settlement_evm_refund_no_balance";
const ERR_REFUND_PAYLOAD = "invalid_batch_settlement_evm_refund_payload";
/** Ostra's own refusals (no x402 code covers them). */
export const ERR_VAULT_CHANNEL_REFUSED = "ostra_vault_channel_refused";
export const ERR_PARTIAL_REFUND = "ostra_partial_refund_unsupported";
export const ERR_DEPOSIT_BELOW_MINIMUM = "ostra_deposit_below_minimum";
export const ERR_KEEPER_CLOSE_FAILED = "ostra_keeper_close_failed";

const REFUND_NONCE_ABI = [
  { type: "function", name: "refundNonce", stateMutability: "view", inputs: [{ name: "channelId", type: "bytes32" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

export type OstraMerchantOptions = {
  rpcUrl: string;
  deployment: Deployment;
  /** The seller's Ostra vault: the channels' receiverAuthorizer. */
  vault: Address;
  keeperUrl: string;
  keys: MerchantKeys;
  storage: FileChannelStorage;
  /** Price per paid request, in base units of the token. */
  price: bigint;
  /** Deposit suggested to buyers, in base units (x402 extra.minDeposit). */
  suggestedDeposit?: bigint;
  /** Smallest deposit accepted, in base units (deposits, and adopted vault channels). */
  minimumDeposit?: bigint;
  /** Splits the seller adds after the keeper fee (for example a marketplace fee). */
  extraSplits?: readonly Split[];
  /** Withdraw delay of new channels; defaults to the keeper's minimum. */
  gracePeriodSeconds?: number;
  /** Seconds without a paid request after which a channel is closed; defaults to IDLE_TIMEOUT_SECONDS (as the Solana session() parameter). */
  idleTimeoutSeconds?: number;
  log: Log;
};

/** What a request to a paid route comes to. */
export type PaymentOutcome =
  | {
      kind: "paid";
      channelId: string;
      payer: string;
      amount: bigint;
      /** Settles the payment once the resource is ready; resolves with the PAYMENT-RESPONSE headers, or the answer to send instead. */
      complete(): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; response: HTTPResponseInstructions }>;
      /** Releases the channel when the resource could not be produced (nothing is charged). */
      cancel(): Promise<void>;
    }
  | { kind: "respond"; response: HTTPResponseInstructions };

export type OstraMerchant = {
  terms: KeeperTerms;
  crank: Address;
  splits: readonly Split[];
  /** The seller's OstraSplit: the channels' receiver (payTo). */
  split: Address;
  gracePeriodSeconds: number;
  decimals: number;
  token: Address;
  /** Handles a request to a paid route priced `amount` (default: the configured price). */
  payment(req: IncomingMessage, route: { description: string; amount?: bigint }): Promise<PaymentOutcome>;
  forwarder: VoucherForwarder;
  stop(): void;
};

/** Checks the splits follow OstraSplit's rules (1..10000 bps each, 10000 in total at most, no repeats, no zero address, at most 32). */
export function checkSplits(splits: readonly Split[]): void {
  if (splits.length > MAX_SPLITS) throw new Error(`at most ${MAX_SPLITS} splits`);
  const seen = new Set<string>();
  let total = 0;
  for (const s of splits) {
    if (getAddress(s.recipient) === ZERO) throw new Error("a split recipient must not be the zero address");
    if (!Number.isInteger(s.bps) || s.bps < 1 || s.bps > BPS_DENOMINATOR) throw new Error(`split ${s.recipient}: bps must be 1..10000`);
    const key = s.recipient.toLowerCase();
    if (seen.has(key)) throw new Error(`split ${s.recipient} is listed twice`);
    seen.add(key);
    total += s.bps;
  }
  if (total > BPS_DENOMINATOR) throw new Error(`splits add up to ${total} bps (at most 10000)`);
}

/** What an adopted vault channel must match: this seller's offer. */
export type VaultChannelOffer = {
  vault: Address;
  split: Address;
  token: Address;
  gracePeriodSeconds: number;
  minimumDeposit?: bigint | undefined;
};

/** A channel config as the x402 payload carries it. */
type WireConfig = Channel["channelConfig"];

/**
 * Why the on-chain channel `ch` of `config`, whose payer is `payerVault`
 * (null when the payer is not an Ostra vault of this deployment), cannot be
 * adopted for `offer`, or null when it can: it must be open (no withdrawal
 * started), pay this seller's split with this vault as receiverAuthorizer in
 * the offer's token, from an Ostra vault in the same token, with the offer's
 * withdraw delay, unclaimed escrow left, a balance of at least the minimum
 * deposit, and a voucher key (payerAuthorizer).
 */
export function vaultChannelProblem(config: WireConfig, ch: ChannelState, payerVault: VaultState | null, offer: VaultChannelOffer): string | null {
  if (ch.pendingWithdrawal !== null) return "the buyer asked to close the channel";
  if (getAddress(config.receiver) !== offer.split) return `the channel pays ${config.receiver}, not this seller's split ${offer.split}`;
  if (getAddress(config.receiverAuthorizer) !== offer.vault) return `the channel's receiverAuthorizer is ${config.receiverAuthorizer}, not this seller's vault ${offer.vault}`;
  if (getAddress(config.token) !== offer.token) return `the channel is in token ${config.token}, not ${offer.token}`;
  if (payerVault === null) return `the channel payer ${config.payer} is not an Ostra vault`;
  if (payerVault.token !== offer.token) return `the payer vault holds token ${payerVault.token}, not ${offer.token}`;
  if (Number(config.withdrawDelay) !== offer.gracePeriodSeconds) return `the channel withdraw delay is ${config.withdrawDelay} s, not the offer's ${offer.gracePeriodSeconds} s`;
  if (ch.balance <= ch.totalClaimed) return "the channel has no unclaimed escrow";
  if (offer.minimumDeposit !== undefined && ch.balance < offer.minimumDeposit) return `the channel balance ${ch.balance} is below the minimum deposit ${offer.minimumDeposit}`;
  if (getAddress(config.payerAuthorizer) === ZERO) return "the channel has no voucher key (payerAuthorizer)";
  return null;
}

/**
 * The channel record of an adopted channel: what the x402 scheme records for
 * a verified channel, with what is already claimed on-chain as the charge
 * floor and no voucher of this server's yet. The on-chain state was read just
 * now, so a first voucher is verified against it without the facilitator.
 */
export function adoptedChannel(channelId: string, config: WireConfig, ch: ChannelState, refundNonce: bigint, now: number): Channel {
  return {
    channelId: channelId.toLowerCase(),
    channelConfig: config,
    chargedCumulativeAmount: ch.totalClaimed.toString(),
    signedMaxClaimable: ch.totalClaimed.toString(),
    signature: "",
    balance: ch.balance.toString(),
    totalClaimed: ch.totalClaimed.toString(),
    withdrawRequestedAt: ch.pendingWithdrawal === null ? 0 : Number(ch.pendingWithdrawal.initiatedAt),
    refundNonce: Number(refundNonce),
    onchainSyncedAt: now,
    lastRequestTimestamp: now,
  };
}

/** A voucher that already paid for a request: the channel's last paid voucher, sent again. */
export function isReplayedVoucher(payload: PaymentPayload, channel: Channel | undefined): boolean {
  const raw = payload.payload;
  if (channel === undefined || !isBatchSettlementVoucherPayload(raw) || channel.signature === "") return false;
  return BigInt(raw.voucher.maxClaimableAmount) === BigInt(channel.chargedCumulativeAmount) && raw.voucher.signature.toLowerCase() === channel.signature.toLowerCase();
}

/** The x402 server scheme with the seller vault as receiverAuthorizer; the vault never signs (claims and refunds go through the keeper). */
class OstraSellerScheme extends BatchSettlementEvmScheme {
  constructor(split: Address, vault: Address, storage: FileChannelStorage, withdrawDelay: number) {
    super(split, {
      storage,
      withdrawDelay,
      receiverAuthorizerSigner: {
        address: vault,
        signTypedData: () => Promise.reject(new Error("an Ostra vault authorizes claims and refunds through its crank (the keeper), never by signature")),
      },
    });
    const enrich = this.enrichPaymentRequiredResponse;
    // A channel adopted from the chain has no voucher of this server's yet: its
    // corrective 402 carries the on-chain state only, so the buyer resyncs from
    // the chain (client/recovery.ts recoverFromOnChainState).
    this.enrichPaymentRequiredResponse = async (ctx) => {
      const result = await enrich(ctx);
      for (const accept of ctx.requirements) {
        const voucherState = accept.extra?.voucherState as { signature?: unknown } | undefined;
        if (voucherState !== undefined && voucherState.signature === "") {
          const { voucherState: _dropped, ...extra } = accept.extra;
          void _dropped;
          (accept as { extra: Record<string, unknown> }).extra = extra;
        }
      }
      return result;
    };
  }
}

/** An x402 HTTP adapter over a node request. */
function nodeAdapter(req: IncomingMessage): HTTPAdapter {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return {
    getHeader: (name) => {
      const value = req.headers[name.toLowerCase()];
      return Array.isArray(value) ? value.join(", ") : value;
    },
    getMethod: () => req.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => req.headers.accept ?? "",
    getUserAgent: () => req.headers["user-agent"] ?? "",
  };
}

function json409(): HTTPResponseInstructions {
  return {
    status: 409,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: { error: "voucher_replayed", message: "this voucher already paid for a request; sign the next one" },
  };
}

export async function createOstraMerchant(o: OstraMerchantOptions): Promise<OstraMerchant> {
  if (o.price <= 0n) throw new Error("the price must be positive");
  const d = o.deployment;
  const token = d.token;
  const transport = retryingHttp(o.rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
  await assertRobinhoodChain(client);
  await checkDeployment(client, d);
  const keeper = new KeeperClient(o.keeperUrl, o.keys, d.chainId);
  const terms = await keeper.terms();
  if (terms.chainId !== d.chainId) throw new Error(`the keeper serves chain ${terms.chainId}, not ${d.chainId}`);
  if (getAddress(terms.token) !== token) throw new Error(`the keeper serves token ${terms.token}, not ${token}`);
  const gracePeriodSeconds = o.gracePeriodSeconds ?? terms.minGraceSeconds;
  if (!Number.isInteger(gracePeriodSeconds) || gracePeriodSeconds < terms.minGraceSeconds || gracePeriodSeconds > X402_MAX_WITHDRAW_DELAY) {
    throw new Error(`the withdraw delay must be at least ${terms.minGraceSeconds} seconds (the keeper's minimum) and at most ${X402_MAX_WITHDRAW_DELAY}`);
  }

  // The vault must be an Ostra vault of this deployment in its token whose
  // crank is the keeper crank of this merchant key; otherwise the keeper
  // cannot claim or refund.
  const crank = getAddress(await keeper.crank());
  const vaultAddress = getAddress(o.vault);
  const vault = await readVault(client, d, vaultAddress);
  if (vault === null) throw new Error(`${vaultAddress} is not an Ostra vault`);
  if (vault.token !== token) throw new Error(`vault ${vaultAddress} is not in token ${token}`);
  if (vault.crank !== crank) {
    const current = vault.crank === null ? "no crank" : `crank ${vault.crank}`;
    throw new Error(`vault ${vaultAddress} has ${current}, not the keeper crank ${crank} of merchant key ${o.keys.merchant}; install it with SetCrankKey first`);
  }
  const decimals = await client.readContract({ address: token, abi: usdgAbi, functionName: "decimals" });

  const splits: Split[] = [{ recipient: getAddress(terms.feeRecipient), bps: terms.feeBps }, ...(o.extraSplits ?? []).map((s) => ({ recipient: getAddress(s.recipient), bps: s.bps }))];
  checkSplits(splits);
  const split = await client.readContract({
    address: d.splitFactory,
    abi: ostraSplitFactoryAbi,
    functionName: "splitAddress",
    args: [token, vaultAddress, splits.map((s) => s.recipient), splits.map((s) => s.bps)],
  });

  const storage = o.storage;
  /** The keeper reports the channel closed: the on-chain mirror is stale until the next facilitator check. */
  const markClosed = async (channelId: string) => {
    const now = Date.now();
    await storage.updateMeta(channelId, (channel, meta) => ({ meta: { ...meta, closedAt: now }, channel: { ...channel, onchainSyncedAt: undefined } }));
  };
  const forwarder = new VoucherForwarder(keeper, splits, o.log, (channelId) => {
    void markClosed(channelId).catch((err: unknown) => o.log("store_failed", { channel: channelId, error: (err as Error).message }));
  });

  /** Closes a channel through the keeper with this server's last paid voucher. */
  const closeThroughKeeper = async (channel: Channel, why: string) => {
    const config = wireChannelConfig(channel.channelConfig);
    const id = channel.channelId.toLowerCase() as Hex;
    try {
      const reply = await keeper.close(config, id, paidVoucher(channel), splits);
      await markClosed(id);
      o.log("channel_closed_by_keeper", { channel: id, why, status: reply.status, tx: reply.tx });
      return reply;
    } catch (err) {
      if (err instanceof KeeperRequestError && err.status === 409 && err.code === "channel_closed") {
        await markClosed(id);
        o.log("channel_already_closed", { channel: id, why, keeper: err.message });
        return null;
      }
      throw err;
    }
  };

  const lifecycle = createLifecycle(
    storage,
    async (channel) => {
      try {
        await closeThroughKeeper(channel, "idle");
      } catch (err) {
        o.log("idle_close_failed", { channel: channel.channelId, error: (err as Error).message });
      }
    },
    (o.idleTimeoutSeconds ?? IDLE_TIMEOUT_SECONDS) * 1_000,
  );
  storage.onChange((previous, next) => {
    if (chargeRaised(previous, next)) forwarder.submit(next);
    if (next !== undefined && next.lastRequestTimestamp !== previous?.lastRequestTimestamp) lifecycle.touch(next.channelId);
  });

  const offer: VaultChannelOffer = { vault: vaultAddress, split, token, gracePeriodSeconds, minimumDeposit: o.minimumDeposit };
  const scheme = new OstraSellerScheme(split, vaultAddress, storage, gracePeriodSeconds);
  const resourceServer = new x402ResourceServer(createFacilitator(client, transport, o.keys.facilitator)).register(X402_NETWORK, scheme);

  // Before the scheme verifies: refuse what Ostra does not serve, and adopt a
  // channel that exists on-chain but not in the store.
  resourceServer.onBeforeVerify(async (ctx: VerifyContext) => {
    const raw = ctx.paymentPayload.payload as PaymentPayload["payload"];
    const isDeposit = isBatchSettlementDepositPayload(raw);
    const isRefund = isBatchSettlementRefundPayload(raw);
    if (!isDeposit && !isRefund && !isBatchSettlementVoucherPayload(raw)) return;
    const config = raw.channelConfig;
    let id: string;
    try {
      id = computeChannelId(wireChannelConfig(config), d.chainId, d.batchSettlement).toLowerCase();
    } catch {
      return; // malformed: the scheme refuses it
    }
    if (id !== raw.voucher.channelId.toLowerCase()) return; // the scheme refuses the mismatch
    if (isDeposit && o.minimumDeposit !== undefined && BigInt(raw.deposit.amount) < o.minimumDeposit) {
      return { abort: true as const, reason: ERR_DEPOSIT_BELOW_MINIMUM, message: `the deposit is below the minimum deposit ${o.minimumDeposit}` };
    }
    try {
      const known = await storage.get(id);
      let ch: ChannelState | undefined;
      if (known === undefined) {
        ch = await readChannel(client, d.batchSettlement, id as Hex);
        if (ch.balance === 0n && ch.totalClaimed === 0n) return; // a new channel: only a deposit opens it
        // A deposit (a stock x402 client funding its channel again) needs no
        // Ostra vault; anything else must be a vault channel of this offer.
        const payerVault = await readVault(client, d, getAddress(config.payer));
        const problem = isDeposit ? null : vaultChannelProblem(config, ch, payerVault, offer);
        if (problem !== null) {
          o.log("vault_channel_refused", { channel: id, reason: problem });
          return { abort: true as const, reason: ERR_VAULT_CHANNEL_REFUSED, message: `channel ${id} cannot be used: ${problem}` };
        }
        const refundNonce = await client.readContract({ address: d.batchSettlement, abi: REFUND_NONCE_ABI, functionName: "refundNonce", args: [id as Hex] });
        // The existence check lives inside the store's atomic update, so two
        // first vouchers arriving together record the channel once.
        const snapshot = ch;
        let adopted = false;
        await storage.updateChannel(id, (current) => {
          if (current !== undefined) return current;
          adopted = true;
          return adoptedChannel(id, config, snapshot, refundNonce, Date.now());
        });
        if (adopted) o.log("vault_channel_adopted", { channel: id, payer: config.payer, balance: snapshot.balance, totalClaimed: snapshot.totalClaimed });
      }
      if (isRefund && raw.amount !== undefined) {
        // The keeper refunds everything not claimed; a partial refund has no Ostra path.
        const state = ch ?? (await readChannel(client, d.batchSettlement, id as Hex));
        const charged = BigInt((await storage.get(id))?.chargedCumulativeAmount ?? state.totalClaimed.toString());
        if (BigInt(raw.amount) !== state.balance - charged) {
          return { abort: true as const, reason: ERR_PARTIAL_REFUND, message: "a refund returns everything not charged; omit amount" };
        }
      }
    } catch (err) {
      o.log("adoption_failed", { channel: id, error: (err as Error).message });
      return { abort: true as const, reason: "invalid_batch_settlement_evm_verification_state_unavailable", message: "Unable to establish channel verification state" };
    }
  });

  // A refund is the keeper's close request: claim this server's last voucher,
  // refund the rest to the buyer, pay the split out.
  resourceServer.onBeforeSettle(async (ctx: SettleContext) => {
    const raw = ctx.paymentPayload.payload as PaymentPayload["payload"];
    if (!isBatchSettlementRefundPayload(raw)) return;
    const id = raw.voucher.channelId.toLowerCase();
    const channel = await storage.get(id);
    if (channel === undefined) return { abort: true as const, reason: "invalid_batch_settlement_evm_missing_channel", message: "No channel record" };
    if (BigInt(raw.voucher.maxClaimableAmount) !== BigInt(channel.chargedCumulativeAmount) || (channel.signature !== "" && raw.voucher.signature.toLowerCase() !== channel.signature.toLowerCase())) {
      return { abort: true as const, reason: ERR_REFUND_PAYLOAD, message: "the refund voucher is not this channel's last paid voucher" };
    }
    const before = await readChannel(client, d.batchSettlement, id as Hex);
    if (before.balance <= before.totalClaimed) return { abort: true as const, reason: ERR_REFUND_NO_BALANCE, message: "the channel holds no unclaimed escrow" };
    await storage.updateMeta(id, (_channel, meta) => ({ meta: { ...meta, closeRequestedAt: Date.now() } }));
    let reply;
    try {
      reply = await closeThroughKeeper(channel, "refund");
    } catch (err) {
      o.log("refund_close_failed", { channel: id, error: (err as Error).message });
      return { abort: true as const, reason: ERR_KEEPER_CLOSE_FAILED, message: "the keeper could not close the channel; try again later" };
    }
    if (reply === null) return { abort: true as const, reason: ERR_REFUND_NO_BALANCE, message: "the channel was already closed" };
    const after = await readChannel(client, d.batchSettlement, id as Hex);
    const refundNonce = await client.readContract({ address: d.batchSettlement, abi: REFUND_NONCE_ABI, functionName: "refundNonce", args: [id as Hex] });
    const result: SettleResponse = {
      success: true,
      transaction: reply.tx,
      network: X402_NETWORK,
      payer: getAddress(raw.channelConfig.payer),
      amount: (before.balance - after.balance).toString(),
      extra: {
        channelState: {
          channelId: id,
          balance: after.balance.toString(),
          totalClaimed: after.totalClaimed.toString(),
          withdrawRequestedAt: after.pendingWithdrawal === null ? 0 : Number(after.pendingWithdrawal.initiatedAt),
          refundNonce: refundNonce.toString(),
        },
      },
    };
    return { skip: true as const, result };
  });

  await resourceServer.initialize();
  forwarder.start();

  const assetExtra = { name: USDG_EIP712_DOMAIN.name, version: USDG_EIP712_DOMAIN.version };
  return {
    terms,
    crank,
    splits,
    split,
    gracePeriodSeconds,
    decimals,
    token,
    payment: async (req, route) => {
      const amount = route.amount ?? o.price;
      if (amount <= 0n) throw new Error("the price must be positive");
      const adapter = nodeAdapter(req);
      const header = adapter.getHeader("payment-signature");
      if (header !== undefined) {
        try {
          const payload = decodePaymentSignatureHeader(header);
          const raw = payload.payload;
          if (isBatchSettlementVoucherPayload(raw) && /^0x[0-9a-fA-F]{64}$/.test(raw.voucher.channelId) && isReplayedVoucher(payload, await storage.get(raw.voucher.channelId))) {
            return { kind: "respond", response: json409() };
          }
        } catch {
          // undecodable: the x402 server answers it
        }
      }
      const http = new x402HTTPResourceServer(resourceServer, {
        accepts: {
          scheme: scheme.scheme,
          network: X402_NETWORK,
          payTo: split,
          price: { amount: amount.toString(), asset: token, extra: assetExtra },
          ...(o.suggestedDeposit === undefined ? {} : { extra: { minDeposit: o.suggestedDeposit.toString() } }),
        },
        description: route.description,
        mimeType: "application/json",
      });
      const context = { adapter, path: adapter.getPath(), method: adapter.getMethod() };
      const result = await http.processHTTPRequest(context);
      if (result.type === "payment-error") return { kind: "respond", response: result.response };
      if (result.type === "no-payment-required") throw new Error("a paid route needs a payment");
      const raw = result.paymentPayload.payload as { voucher: { channelId: string } };
      const requirements: PaymentRequirements = result.paymentRequirements;
      return {
        kind: "paid",
        channelId: raw.voucher.channelId.toLowerCase(),
        payer: getAddress((result.paymentPayload.payload as { channelConfig: { payer: string } }).channelConfig.payer),
        amount,
        complete: async () => {
          const settled = await http.processSettlement(result.paymentPayload, requirements, result.declaredExtensions, { request: context }, undefined, result.beforeHandlerSettlement);
          return settled.success ? { ok: true, headers: settled.headers } : { ok: false, response: settled.response };
        },
        cancel: async () => {
          await result.cancellationDispatcher.cancel({ reason: "handler_failed" });
        },
      };
    },
    forwarder,
    stop: () => {
      forwarder.stop();
      lifecycle.shutdown();
    },
  };
}
