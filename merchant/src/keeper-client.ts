// Client for the Ostra keeper's HTTP endpoint (keeper/src/http.ts).

import type { Address, Hex } from "viem";
import type { ChannelConfig } from "@ostraagent/sdk";
import type { MerchantKeys } from "./keys.ts";

/** Request timeout. A close request claims, refunds and pays out on-chain, which takes several confirmations. */
const CLOSE_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 30_000;

export type KeeperTerms = { chainId: number; token: string; feeRecipient: Address; feeBps: number; minGraceSeconds: number };

export type Split = { recipient: Address; bps: number };

/** A voucher in the x402 batch-settlement wire shape, which the keeper accepts unchanged. */
export type WireVoucher = { channelId: Hex; maxClaimableAmount: string; signature: Hex };

/** What the keeper answers a close request with. */
export type KeeperClose = { channel: string; status: string; tx: Hex; steps: { step: string; tx: Hex }[] };

export class KeeperRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(`keeper ${status} ${code}: ${message}`);
    this.name = "KeeperRequestError";
    this.status = status;
    this.code = code;
  }
}

export class KeeperClient {
  readonly #base: string;
  readonly #keys: MerchantKeys;
  readonly #chainId: number;

  constructor(baseUrl: string, keys: MerchantKeys, chainId: number) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#keys = keys;
    this.#chainId = chainId;
  }

  async #call<T>(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<T> {
    const res = await fetch(`${this.#base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      throw new KeeperRequestError(res.status, String(json?.error ?? "unknown"), String(json?.message ?? res.statusText));
    }
    if (json === null) throw new KeeperRequestError(res.status, "invalid_json", "the keeper did not answer with JSON");
    return json as T;
  }

  terms(): Promise<KeeperTerms> {
    return this.#call("GET", "/v1/terms", undefined, REQUEST_TIMEOUT_MS);
  }

  /** The crank the keeper derives for this seller's merchant key. */
  async crank(): Promise<Address> {
    const reply = await this.#call<{ crank: Address }>("GET", `/v1/crank?merchant=${encodeURIComponent(this.#keys.merchant)}`, undefined, REQUEST_TIMEOUT_MS);
    return reply.crank;
  }

  /** Forwards a buyer's voucher; resolves with the keeper's verdict. */
  forwardVoucher(channelConfig: ChannelConfig, voucher: WireVoucher, splits: readonly Split[]): Promise<{ accepted: boolean; reason?: string }> {
    return this.#call("POST", "/v1/vouchers", { merchant: this.#keys.merchant, channelConfig, voucher, splits }, REQUEST_TIMEOUT_MS);
  }

  /**
   * Asks the keeper to claim, refund and pay out the channel now, with the
   * final voucher when there is one. Resolves with the keeper's result (`tx`:
   * the last claim or refund transaction).
   */
  async close(channelConfig: ChannelConfig, channelId: Hex, voucher: WireVoucher | undefined, splits: readonly Split[]): Promise<KeeperClose> {
    const signature = await this.#keys.signCloseRequest(this.#chainId, channelId);
    return this.#call(
      "POST",
      "/v1/close",
      { merchant: this.#keys.merchant, channelConfig, signature, splits, ...(voucher === undefined ? {} : { voucher }) },
      CLOSE_TIMEOUT_MS,
    );
  }
}
