// Sends relayed transactions from the relayer's account (on Solana, Kora
// signed and send.ts resent the signed bytes while the blockhash lived).
//
// Sends run one at a time (one nonce sequence). Each send is simulated first
// at its own gas estimate (a request that reverts now is not sent and costs
// nothing), signed locally, so its hash is known before the RPC sees it, and
// then waited for:
//   * a receipt with status success: landed;
//   * a reverted receipt: the gas is spent but nothing happened; reported as
//     not sent (the gate's rule on Solana for a transaction that failed
//     on-chain);
//   * the node answering the send with a JSON-RPC error: it refused the
//     transaction (Robinhood Chain's sequencer keeps no mempool), not sent;
//   * no receipt within RECEIPT_TIMEOUT_MS, or the send failing without an
//     answer from the node (a timeout, an HTTP error): an EVM transaction has
//     no expiry, so "not sent" is proven by replacing it:
//     a zero-value transfer to the relayer itself at the same nonce. If the
//     replacement lands, the transaction never will (not sent); if the nonce
//     is already used, only the transaction can have used it, so its receipt
//     is waited for. Until one of the two is certain the outcome is unknown
//     (SendUnknownError) and nothing is credited or charged back.

import { createWalletClient, keccak256, type Address, type Hash, type Hex, type PrivateKeyAccount, type PublicClient, type Transport } from "viem";
import { robinhoodChain } from "@ostraagent/sdk";

/** Wait for a receipt before replacing the transaction (Robinhood Chain confirms in about a second). */
export const RECEIPT_TIMEOUT_MS = 60_000;
/** How long the outcome is followed after a replacement before giving up as unknown. */
export const SETTLE_TIMEOUT_MS = 600_000;
/** Gas limit = estimate + 20% (decided 17 Oct 2026): the L1 component of an estimate moves with the L1 price; unused gas is not paid. */
export const GAS_LIMIT_MARGIN_PERCENT = 20n;
const POLL_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The transaction certainly did not land and never will (reverted, refused before sending, or replaced). */
export class NotSentError extends Error {
  readonly txHash: Hash | null;
  constructor(message: string, txHash: Hash | null = null) {
    super(message);
    this.name = "NotSentError";
    this.txHash = txHash;
  }
}

/** Whether the transaction landed is not known yet; it may still land. */
export class SendUnknownError extends Error {
  readonly txHash: Hash;
  constructor(message: string, txHash: Hash) {
    super(message);
    this.name = "SendUnknownError";
    this.txHash = txHash;
  }
}

/**
 * True when the node itself answered with a JSON-RPC error (it refused the
 * transaction), not a transport failure: viem's RpcRequestError somewhere in
 * the cause chain. Read by name, since the transport may come from another
 * copy of viem (the SDK's) than this package's.
 */
export function isNodeRefusal(err: unknown): boolean {
  let e = err as { name?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; e !== null && e !== undefined && typeof e === "object" && depth < 16; depth++) {
    if (e.name === "RpcRequestError") return true;
    e = e.cause as typeof e;
  }
  return false;
}

export type Landed = { txHash: Hash; gasUsed: bigint; effectiveGasPrice: bigint; block: bigint };

export class RelaySender {
  readonly #client: PublicClient;
  readonly #transport: Transport;
  readonly #account: PrivateKeyAccount;
  readonly #receiptTimeoutMs: number;
  readonly #settleTimeoutMs: number;
  #tail: Promise<unknown> = Promise.resolve();

  /** `o` shortens the waits for tests; the service uses RECEIPT_TIMEOUT_MS and SETTLE_TIMEOUT_MS. */
  constructor(client: PublicClient, transport: Transport, account: PrivateKeyAccount, o: { receiptTimeoutMs?: number; settleTimeoutMs?: number } = {}) {
    this.#client = client;
    this.#transport = transport;
    this.#account = account;
    this.#receiptTimeoutMs = o.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
    this.#settleTimeoutMs = o.settleTimeoutMs ?? SETTLE_TIMEOUT_MS;
  }

  get address(): Address {
    return this.#account.address;
  }

  /** Sends `tx` after every earlier send has finished; resolves when it landed, throws NotSentError or SendUnknownError. */
  send(tx: { to: Address; data: Hex }): Promise<Landed> {
    const run = () => this.#send(tx);
    const p = this.#tail.then(run, run);
    this.#tail = p.catch(() => undefined);
    return p;
  }

  async #receipt(hash: Hash): Promise<Landed | "reverted" | null> {
    try {
      const r = await this.#client.getTransactionReceipt({ hash });
      if (r.status !== "success") return "reverted";
      return { txHash: hash, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, block: r.blockNumber };
    } catch {
      return null; // not found (yet)
    }
  }

  async #send(tx: { to: Address; data: Hex }): Promise<Landed> {
    const account = this.#account;
    let gas: bigint;
    try {
      gas = await this.#client.estimateGas({ account: account.address, to: tx.to, data: tx.data, value: 0n });
    } catch (err) {
      const e = err as { shortMessage?: string; message?: string };
      throw new NotSentError(`the transaction reverts now, so it was not sent: ${e.shortMessage ?? e.message ?? String(err)}`);
    }
    const nonce = await this.#client.getTransactionCount({ address: account.address, blockTag: "pending" });
    const { maxFeePerGas, maxPriorityFeePerGas } = await this.#client.estimateFeesPerGas();
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: this.#transport });
    const signed = await wallet.signTransaction({
      account,
      chain: robinhoodChain,
      to: tx.to,
      data: tx.data,
      value: 0n,
      gas: gas + (gas * GAS_LIMIT_MARGIN_PERCENT) / 100n,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const hash = keccak256(signed);
    let sendError: unknown;
    try {
      await this.#client.sendRawTransaction({ serializedTransaction: signed });
    } catch (err) {
      sendError = err;
    }
    if (sendError !== undefined && isNodeRefusal(sendError)) {
      const e = sendError as { shortMessage?: string; message?: string };
      throw new NotSentError(`the node refused transaction ${hash}: ${e.shortMessage ?? e.message ?? String(sendError)}`, hash);
    }
    if (sendError === undefined) {
      const deadline = Date.now() + this.#receiptTimeoutMs;
      while (Date.now() < deadline) {
        const r = await this.#receipt(hash);
        if (r === "reverted") throw new NotSentError(`transaction ${hash} reverted on-chain`, hash);
        if (r !== null) return r;
        await sleep(POLL_MS);
      }
    }
    // No receipt, or the RPC refused the send: prove the outcome by replacing the nonce.
    const replacement = await wallet.signTransaction({
      account,
      chain: robinhoodChain,
      to: account.address,
      value: 0n,
      gas: 21_000n,
      nonce,
      maxFeePerGas: maxFeePerGas * 2n,
      maxPriorityFeePerGas: maxPriorityFeePerGas * 2n,
    });
    const replacementHash = keccak256(replacement);
    await this.#client.sendRawTransaction({ serializedTransaction: replacement }).catch(() => undefined);
    const deadline = Date.now() + this.#settleTimeoutMs;
    while (Date.now() < deadline) {
      const r = await this.#receipt(hash);
      if (r === "reverted") throw new NotSentError(`transaction ${hash} reverted on-chain`, hash);
      if (r !== null) return r;
      if ((await this.#receipt(replacementHash)) !== null) {
        const why = sendError === undefined ? `no receipt within ${this.#receiptTimeoutMs / 1_000} s` : `the send failed without an answer from the node (${(sendError as Error).message})`;
        throw new NotSentError(`transaction ${hash} was replaced at nonce ${nonce}: ${why}`, hash);
      }
      await sleep(POLL_MS);
    }
    throw new SendUnknownError(`transaction ${hash} (nonce ${nonce}) has no receipt and its replacement did not land within ${this.#settleTimeoutMs / 1_000} s`, hash);
  }
}
