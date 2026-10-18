// The relayer's WOTS signature escrow, as this agent uses it (relayer
// signatures.ts; design v0.4, recovery when a device is lost). A WOTS key
// may sign one message only. The relayer keeps every WOTS signature it
// receives until the chain shows its key used, so:
//
//   * lookup (GET /v1/signatures/<key root>): before any key with no local
//     record signs, the keychain asks the escrow (sdk WotsKeychain); a device
//     restored from the seed then sends the signature still in flight again
//     instead of signing a second message with that key. When the escrow
//     cannot be read, nothing is signed;
//   * escrow (POST /v1/escrow): before the agent's own fee payer sends calls
//     that carry WOTS signatures (LocalSender), they are escrowed the same
//     way the relayer escrows the calls it relays.
//
// Without a relayer URL there is no escrow: records stay on this device only.

import type { RelayCall, WotsSignatureLookup } from "@ostraagent/sdk";
import { RelayerError, RelayerUnavailableError } from "./relay.ts";

/** A request to the escrow waits at most this long (the relayer reads the chain for an escrow). */
export const ESCROW_TIMEOUT_MS = 30_000;

const HEX = /^(0x)?[0-9a-fA-F]*$/;

export class SignatureEscrowClient {
  readonly url: string;

  constructor(url: string) {
    this.url = url.replace(/\/+$/, "");
  }

  async #fetch(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, { ...init, signal: AbortSignal.timeout(ESCROW_TIMEOUT_MS) });
    } catch (err) {
      throw new RelayerUnavailableError(`the relayer's signature escrow at ${this.url} cannot be reached (${(err as Error).message}); nothing was signed or sent`);
    }
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(text);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) body = value as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  /** WotsSignatureLookup: the signature the escrow holds for `keyRoot`, null when none. Throws when it cannot tell. */
  readonly lookup: WotsSignatureLookup = async (keyRoot: string) => {
    if (!/^0x[0-9a-f]{64}$/.test(keyRoot)) throw new RangeError("a key root is 32 bytes of lowercase 0x hex");
    const { status, body } = await this.#fetch(`/v1/signatures/${keyRoot}`, { headers: { accept: "application/json" } });
    if (status === 404 && body?.error === "no_signature") return null;
    if (status >= 500) throw new RelayerUnavailableError(`GET /v1/signatures/${keyRoot} answered ${status}; nothing was signed`);
    if (status !== 200 || body === null) throw new RelayerError(status, "signatures", `GET /v1/signatures/${keyRoot} answered ${status}; nothing was signed`);
    const { message, signature } = body;
    if (typeof message !== "string" || typeof signature !== "string" || !HEX.test(message) || !HEX.test(signature)) {
      throw new RelayerError(status, "signatures", `GET /v1/signatures/${keyRoot} answered a record without a message and signature in hex`);
    }
    // The keychain checks the signature against its own key before it trusts it.
    return { message, signature };
  };

  /**
   * The call the escrow holds for `keyRoot` (as the request that carried the
   * signature had it), null when none: what sends again a signature whose
   * call is not a plain spend of the key's own contract (a vault-funded
   * launch's DevBuy). The caller checks it against the signed message.
   */
  async call(keyRoot: string): Promise<{ to: string; data: string; message: string; signature: string } | null> {
    if (!/^0x[0-9a-f]{64}$/.test(keyRoot)) throw new RangeError("a key root is 32 bytes of lowercase 0x hex");
    const { status, body } = await this.#fetch(`/v1/signatures/${keyRoot}`, { headers: { accept: "application/json" } });
    if (status === 404 && body?.error === "no_signature") return null;
    if (status >= 500) throw new RelayerUnavailableError(`GET /v1/signatures/${keyRoot} answered ${status}`);
    if (status !== 200 || body === null) throw new RelayerError(status, "signatures", `GET /v1/signatures/${keyRoot} answered ${status}`);
    const call = body.call as { to?: unknown; data?: unknown } | undefined;
    const { message, signature } = body;
    if (typeof call?.to !== "string" || typeof call.data !== "string" || !HEX.test(call.data) || typeof message !== "string" || typeof signature !== "string" || !HEX.test(message) || !HEX.test(signature)) {
      throw new RelayerError(status, "signatures", `GET /v1/signatures/${keyRoot} answered a record without its call, message and signature`);
    }
    return { to: call.to, data: call.data, message, signature };
  }

  /** Escrows the WOTS signatures in `calls` before this agent sends them itself; resolves once they are held. */
  async escrow(calls: readonly RelayCall[]): Promise<void> {
    const { status, body } = await this.#fetch("/v1/escrow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ calls: calls.map((c) => ({ to: c.to, data: c.data })) }),
    });
    if (status === 200) return;
    if (status === 400 && body?.error === "no_signatures") return;
    const message = typeof body?.message === "string" ? body.message : `POST /v1/escrow answered ${status}`;
    if (status >= 500) throw new RelayerUnavailableError(`${message}; nothing was sent`);
    throw new RelayerError(status, typeof body?.error === "string" ? body.error : "escrow", `${message}; nothing was sent`);
  }
}
