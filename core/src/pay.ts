// `pay`: an HTTP request to a route that answers 402 with an x402 offer,
// paid from this agent's vault (design v0.3, payment route vault to vault; on
// Robinhood Chain, design v0.4: x402 batch-settlement).
//
// The offer this agent pays is x402 batch-settlement in USDG on Robinhood
// Chain whose receiverAuthorizer is an Ostra vault (an Ostra seller: its
// keeper claims the vouchers). It is paid with a voucher of a channel from
// this vault to that seller (receiver the offer's payTo, receiverAuthorizer
// the seller's vault, withdrawDelay the offer's, at most a day): an open
// channel of an earlier payment to the same seller with enough unused deposit
// and life left, or a new one (ChannelService.open with the `pay` record, its
// deposit PAY_CHANNEL_DEPOSIT or the price when more). The voucher is signed
// by the stock x402 client (@x402/evm) with the channel's voucher key, the
// vault as payer; the voucher is recorded before the request carrying it is
// sent (it authorizes the seller whatever the seller answers). A price above
// the agent's `maxPrice` is refused before anything is signed.
//
// A channel `pay` opened lives SESSION_MAX_AGE_SECONDS; the server's sweep
// closes it after that (close_channel), and what was not claimed comes back
// to the vault.

import { getAddress, isAddress, type Address, type Hex, type PublicClient } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme, type ClientChannelStorage } from "@x402/evm/batch-settlement/client";
import { readChannel, readVault } from "@ostraagent/sdk";
import { formatTokenAmount, parseTokenAmount } from "./amount.ts";
import { BATCH_MAX_WITHDRAW_DELAY_SECONDS, SESSION_MAX_AGE_SECONDS, type Config } from "./config.ts";
import { payCapacity, type ChannelRecord, type ChannelService, type PayChannelState } from "./channels.ts";
import type { VaultService } from "./vault.ts";

/** Deposit of a channel `pay` opens to a seller, unless the price or the caller asks for more (1 USDG). */
export const PAY_CHANNEL_DEPOSIT = 1_000_000n;
/** At most this much of a paid route's answer is returned. */
export const PAY_MAX_BODY_CHARS = 65_536;
const REQUEST_TIMEOUT_MS = 120_000;
/** A channel is used for a payment only while it has at least this long to live. */
const MIN_LIFE_LEFT_SECONDS = 300;

export type PayInput = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** The most this request may cost (USDG); a higher offer is refused before anything is signed. */
  maxPrice: string;
  /** Deposit of a new channel to the seller, when one is opened (USDG; default 1, at least the price). */
  deposit?: string;
  /** At most this much of the answer is returned (default PAY_MAX_BODY_CHARS). */
  maxBodyChars?: number;
  /** How long one request may take, its answer read to the end (ms; default 120,000). */
  timeoutMs?: number;
};

export type PayResult = {
  status: number;
  /** What this request paid (USDG); null when the route did not ask for payment. */
  paid: string | null;
  channel: Hex | null;
  /** Unused deposit of the channel after this payment. */
  channelLeft: string | null;
  contentType: string | null;
  body: string;
  truncated: boolean;
  note?: string;
};

const now = () => Math.floor(Date.now() / 1000);

/** Why the offer `r` is not one this agent pays, or null. */
function offerProblem(r: PaymentRequirements, network: string, token: Address): string | null {
  if (r.scheme !== "batch-settlement") return `${r.scheme} (this agent pays batch-settlement)`;
  if (r.network !== network) return `on ${r.network} (this agent pays on ${network})`;
  if (!isAddress(r.asset, { strict: false }) || getAddress(r.asset) !== token) return `in ${r.asset} (this agent pays in ${token})`;
  return null;
}

export class PayService {
  readonly #client: PublicClient;
  readonly #config: Config;
  readonly #vault: VaultService;
  readonly #channels: ChannelService;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(client: PublicClient, config: Config, vault: VaultService, channels: ChannelService) {
    this.#client = client;
    this.#config = config;
    this.#vault = vault;
    this.#channels = channels;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #fetch(input: PayInput, headers: Record<string, string> = {}): Promise<Response> {
    try {
      return await fetch(input.url, {
        method: input.method ?? "GET",
        headers: { ...(input.headers ?? {}), ...headers },
        ...(input.body === undefined ? {} : { body: input.body }),
        signal: AbortSignal.timeout(input.timeoutMs ?? REQUEST_TIMEOUT_MS),
        redirect: "manual",
      });
    } catch (err) {
      throw new Error(`${input.url} cannot be reached: ${(err as Error).message}`);
    }
  }

  async #answer(res: Response, paid: bigint | null, record: ChannelRecord | null, note?: string, maxBodyChars = PAY_MAX_BODY_CHARS): Promise<PayResult> {
    const text = await res.text();
    const truncated = text.length > maxBodyChars;
    return {
      status: res.status,
      paid: paid === null ? null : formatTokenAmount(paid),
      channel: record === null ? null : record.channel,
      channelLeft: record === null ? null : formatTokenAmount(payCapacity(record)),
      contentType: res.headers.get("content-type"),
      body: truncated ? text.slice(0, maxBodyChars) : text,
      truncated,
      ...(note === undefined ? {} : { note }),
    };
  }

  /** A channel `pay` opened to this seller that can pay `price` now, or null. */
  async #channelFor(payee: Address, receiver: Address, withdrawDelay: number, price: bigint): Promise<ChannelRecord | null> {
    for (const r of await this.#channels.payRecords()) {
      if (r.pay === undefined || r.closeRequested) continue;
      if (getAddress(r.payee) !== payee || getAddress(r.config.receiver) !== receiver || r.gracePeriod !== withdrawDelay) continue;
      if (r.pay.expiresAt < now() + MIN_LIFE_LEFT_SECONDS || payCapacity(r) < price) continue;
      const ch = await readChannel(this.#client, this.#config.deployment.batchSettlement, r.channel);
      if (ch.pendingWithdrawal !== null || ch.balance < BigInt(r.pay.cumulative) + price) continue;
      return r;
    }
    return null;
  }

  /** The stock x402 client paying from channel record `r` (the vault as payer, the channel's voucher key signing, never depositing). */
  #x402(r: ChannelRecord & { pay: PayChannelState }): x402HTTPClient {
    const voucherKey = this.#channels.voucherSigner(r);
    if (voucherKey.address !== getAddress(r.config.payerAuthorizer)) throw new Error(`the voucher key of channel ${r.channel} is not derived from this machine's master seed`);
    const client = this.#client;
    const payer = {
      address: getAddress(r.config.payer),
      signTypedData: () => Promise.reject(new Error("a vault never signs typed data")),
      readContract: (args: Parameters<PublicClient["readContract"]>[0]) => client.readContract(args),
    };
    let context = r.pay.x402 ?? undefined;
    const storage: ClientChannelStorage = {
      get: async (key) => (key === r.channel ? context : undefined),
      set: async (key, c) => {
        if (key !== r.channel) return;
        context = c;
        await this.#channels.updatePayRecord(r.salt, (rec) => {
          rec.pay.x402 = c;
        });
      },
      delete: async (key) => {
        if (key !== r.channel) return;
        context = undefined;
        await this.#channels.updatePayRecord(r.salt, (rec) => {
          rec.pay.x402 = null;
        });
      },
    };
    const scheme = new BatchSettlementEvmScheme(payer as never, {
      voucherSigner: toClientEvmSigner(voucherKey, client as never),
      payerAuthorizer: voucherKey.address,
      salt: r.config.salt,
      storage,
      depositStrategy: () => false,
    });
    const x = new x402Client().register(this.#config.x402Network as `${string}:${string}`, scheme);
    x.setSpendControls({ allowedAssets: [{ network: this.#config.x402Network as `${string}:${string}`, asset: this.#config.deployment.token }] });
    return new x402HTTPClient(x);
  }

  /** Sends the request; when the route asks for payment, pays it from a channel of this vault to the seller. */
  pay(input: PayInput): Promise<PayResult> {
    return this.#serial(async () => {
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        throw new RangeError(`${input.url} is not a URL`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new RangeError("pay sends http(s) requests only");
      const maxPrice = parseTokenAmount(input.maxPrice);
      const first = await this.#fetch(input);
      if (first.status !== 402) return this.#answer(first, null, null, undefined, input.maxBodyChars);

      let firstBody: unknown = null;
      try {
        firstBody = JSON.parse(await first.clone().text());
      } catch {
        firstBody = null;
      }
      let required: PaymentRequired;
      try {
        required = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((name) => first.headers.get(name), firstBody);
      } catch (err) {
        throw new Error(`${input.url} answered 402 without an x402 offer this agent can read: ${(err as Error).message}; nothing was paid`);
      }
      const token = this.#config.deployment.token;
      const offer = required.accepts.find((r) => offerProblem(r, this.#config.x402Network, token) === null);
      if (offer === undefined) {
        const offered = required.accepts.map((r) => offerProblem(r, this.#config.x402Network, token)).join("; ");
        throw new Error(`${input.url} offers no payment this agent makes (${offered}); nothing was paid`);
      }
      if (!/^[1-9][0-9]*$/.test(offer.amount)) throw new Error(`the offer's amount ${offer.amount} is not a positive integer; nothing was paid`);
      const price = BigInt(offer.amount);
      if (price > maxPrice) throw new Error(`${input.url} asks ${formatTokenAmount(price)}, more than maxPrice ${input.maxPrice}; nothing was paid`);
      const extra = offer.extra ?? {};
      if (typeof extra.receiverAuthorizer !== "string" || !isAddress(extra.receiverAuthorizer, { strict: false })) throw new Error("the offer names no receiverAuthorizer; nothing was paid");
      const payee = getAddress(extra.receiverAuthorizer);
      const withdrawDelay = extra.withdrawDelay;
      if (typeof withdrawDelay !== "number" || !Number.isInteger(withdrawDelay) || withdrawDelay < 900 || withdrawDelay > BATCH_MAX_WITHDRAW_DELAY_SECONDS) {
        throw new Error(`the offer's withdrawDelay ${String(withdrawDelay)} is not 900..${BATCH_MAX_WITHDRAW_DELAY_SECONDS} s; nothing was paid`);
      }
      if (!isAddress(offer.payTo, { strict: false })) throw new Error("the offer's payTo is not an address; nothing was paid");
      const receiver = getAddress(offer.payTo);
      const payeeVault = await readVault(this.#client, this.#config.deployment, payee);
      if (payeeVault === null || payeeVault.token !== token) throw new Error(`the seller's receiverAuthorizer ${payee} is not an Ostra vault in ${token}: this agent pays Ostra sellers from its vault; nothing was paid`);
      if (payee === (await this.#vault.vaultAddress())) throw new Error("the seller is this agent's own vault");

      let record = await this.#channelFor(payee, receiver, withdrawDelay, price);
      let opened = false;
      if (record === null) {
        const asked = input.deposit === undefined ? PAY_CHANNEL_DEPOSIT : parseTokenAmount(input.deposit);
        const deposit = asked > price ? asked : price;
        const pay: PayChannelState = { url: input.url, method: input.method ?? "GET", expiresAt: now() + SESSION_MAX_AGE_SECONDS, cumulative: "0", voucher: null, closeSent: false, payments: [], x402: null };
        const o = await this.#channels.open({ payee, deposit: formatTokenAmount(deposit), gracePeriod: withdrawDelay, receiver, pay });
        if (o.status !== "open") throw new Error(`${o.note}; nothing was paid, call pay again`);
        record = (await this.#channels.payRecords()).find((r) => r.channel === o.channel) ?? null;
        if (record === null) throw new Error(`the channel ${o.channel} opened for this payment has no record`);
        opened = true;
      }
      const r = record as ChannelRecord & { pay: PayChannelState };
      let answer: Response = first;
      let required2 = required;
      /** What the vouchers sent for this request add to the channel's charge. */
      let paid = 0n;
      for (let attempt = 0; attempt < 2; attempt++) {
        const http = this.#x402(r);
        const current = required2.accepts.find((x) => offerProblem(x, this.#config.x402Network, token) === null) ?? offer;
        // A corrective 402 is a new offer: it is held to maxPrice as the first one was.
        if (!/^[1-9][0-9]*$/.test(current.amount) || BigInt(current.amount) > maxPrice) {
          throw new Error(`${input.url} asks ${current.amount} base units on its corrective offer, more than maxPrice ${input.maxPrice}; nothing more was paid`);
        }
        const payload: PaymentPayload = await http.createPaymentPayload({ ...required2, accepts: [current] });
        const voucher = (payload.payload as { voucher?: { channelId?: string; maxClaimableAmount?: string; signature?: string } }).voucher;
        if (voucher?.channelId?.toLowerCase() !== r.channel || voucher.maxClaimableAmount === undefined) throw new Error(`the x402 client signed a voucher for another channel than ${r.channel}`);
        const signed = BigInt(voucher.maxClaimableAmount);
        if (signed > BigInt(r.deposit)) throw new Error(`channel ${r.channel} cannot cover a voucher of ${signed}`);
        // What this voucher adds to the channel's charge, as this machine knows it: never more than maxPrice.
        const added = signed - BigInt(r.pay.cumulative);
        if (added > maxPrice) throw new Error(`the x402 client signed a voucher adding ${formatTokenAmount(added)} to channel ${r.channel}, more than maxPrice ${input.maxPrice}; it was not sent`);
        if (added > 0n) paid += added;
        // The signed voucher authorizes the seller whatever it answers: it is recorded first.
        const saved = await this.#channels.updatePayRecord(r.salt, (rec) => {
          if (signed > BigInt(rec.pay.cumulative)) {
            rec.pay.cumulative = signed.toString();
            rec.pay.voucher = { channelId: r.channel, maxClaimableAmount: signed.toString(), signature: (voucher.signature ?? "0x") as Hex };
          }
        });
        r.pay = saved.pay;
        answer = await this.#fetch(input, http.encodePaymentSignatureHeader(payload));
        const result = await http.processPaymentResult(payload, (name) => answer.headers.get(name), answer.status);
        if (answer.status === 402 && result.recovered && attempt === 0) {
          // The seller had charged this channel more than recorded here: resynced, paid once more.
          let body: unknown = null;
          try {
            body = JSON.parse(await answer.clone().text());
          } catch {
            body = null;
          }
          required2 = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((name) => answer.headers.get(name), body);
          continue;
        }
        break;
      }
      if (answer.status === 402) {
        return this.#answer(answer, null, r, "the seller did not take the voucher; what the voucher signed stays recorded against the channel", input.maxBodyChars);
      }
      const done = await this.#channels.updatePayRecord(r.salt, (rec) => {
        rec.pay.payments.push({ url: input.url, amount: paid.toString(), transaction: answer.headers.get("payment-response") ?? "", at: now() });
      });
      return this.#answer(answer, paid, done, opened ? `a channel to the seller was opened with a deposit of ${formatTokenAmount(BigInt(done.deposit))}; later payments to the seller use it` : undefined, input.maxBodyChars);
    });
  }
}
