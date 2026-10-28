// Sends relayed transactions from the relayer's account (on Solana, Kora
// signed and send.ts resent the signed bytes while the blockhash lived).
//
// Sends run one at a time (one nonce sequence). Each send is simulated first
// at its own gas estimate (a request that reverts now is not sent and costs
// nothing) and, when it holds vault Swaps that must not fail, simulated once
// more for their SwapFailed (one that fails now is not sent). Its gas limit
// is the estimate + 20%, at most the cap the gate gives (what the
// transaction was priced at, relayGasCap): one that needs more now is not
// sent. It is signed locally,
// so its hash is known before the RPC sees it, with the value the gate gives
// (a vault-funded launch's fee), and then waited for:
//   * a receipt with status success: landed;
//   * a reverted receipt: the gas is spent but nothing happened; reported as
//     not sent (the gate's rule on Solana for a transaction that failed
//     on-chain), with the wei the gas cost (the gate keeps that much of what
//     was paid);
//   * the node answering the send with a JSON-RPC error: it refused the
//     transaction (Robinhood Chain's sequencer keeps no mempool), not sent,
//     once the chain agrees: an RPC provider can answer an error after
//     passing the transaction on (seen on 28 Oct 2026: a relayer channel open
//     landed while its send was answered with an error). For REFUSAL_CHECK_MS
//     its receipt and the account's nonce are read: a receipt is its outcome;
//     the nonce used by another transaction means it can never land (not
//     sent); still no receipt and the nonce free, every read having answered,
//     it was refused (not sent); reads that did not answer leave it to the
//     replacement proof below;
//   * no receipt within RECEIPT_TIMEOUT_MS, or the send failing without an
//     answer from the node (a timeout, an HTTP error): an EVM transaction has
//     no expiry, so "not sent" is proven by replacing it:
//     a zero-value transfer to the relayer itself at the same nonce. If the
//     replacement lands, the transaction never will (not sent); if the nonce
//     is already used, only the transaction can have used it, so its receipt
//     is waited for. Until one of the two is certain the outcome is unknown
//     (SendUnknownError) and nothing is credited or charged back.

import { createWalletClient, keccak256, type Address, type Hash, type Hex, type PrivateKeyAccount, type PublicClient, type Transport } from "viem";
import { failedModuleSpends, failedSwaps, moduleFailureText, robinhoodChain, simulateRelay } from "@ostraagent/sdk";

/** Wait for a receipt before replacing the transaction (Robinhood Chain confirms in about a second). */
export const RECEIPT_TIMEOUT_MS = 60_000;
/** How long the outcome is followed after a replacement before giving up as unknown. */
export const SETTLE_TIMEOUT_MS = 600_000;
/** Gas limit = estimate + 20% (decided 17 Oct 2026): the L1 component of an estimate moves with the L1 price; unused gas is not paid. */
export const GAS_LIMIT_MARGIN_PERCENT = 20n;
/** A send with a deadline (`notAfter`) is signed only while the chain's latest block is at least this many seconds before it. */
export const DEADLINE_SPARE_SECONDS = 30n;
/** How long a send answered with a JSON-RPC error is looked for on the chain before it counts as refused. */
export const REFUSAL_CHECK_MS = 20_000;
/** The longest one read of that check may take (the transport retries for longer): one that does not answer in time failed. */
const CHECK_READ_MS = 5_000;
/** Once the nonce shows used, how long at least its receipt is looked for (a node behind the one that counted the nonce). */
const USED_NONCE_RECEIPT_MS = 5_000;

/** An error's text without its URL: viem's shortMessage and details (an RPC URL may carry an API key; its message names it). */
function errorText(err: unknown): string {
  const e = err as { shortMessage?: string; details?: string; name?: string } | null;
  const short = e?.shortMessage ?? e?.name ?? "error";
  return e?.details !== undefined && e.details !== "" && e.details !== short ? `${short} (${e.details})` : short;
}
const POLL_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The transaction certainly did not land and never will (reverted, refused before sending, or replaced). */
export class NotSentError extends Error {
  readonly txHash: Hash | null;
  /** True when it was not sent because it needs more gas now than the cap it was priced for. */
  readonly overCap: boolean;
  /** Wei the relayer's account paid for it: the gas of a transaction that reverted on-chain (0 otherwise). */
  readonly spentWei: bigint;
  constructor(message: string, txHash: Hash | null = null, overCap = false, spentWei = 0n) {
    super(message);
    this.name = "NotSentError";
    this.txHash = txHash;
    this.overCap = overCap;
    this.spentWei = spentWei;
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

/** A landed transaction: its gas, its gas price and the ETH it sent (value). */
export type Landed = { txHash: Hash; gasUsed: bigint; effectiveGasPrice: bigint; block: bigint; value: bigint };

/** The service's log (gate.ts Log): what the RPC answered to a send the chain then showed taken, or could not tell. */
type SendLog = (event: string, fields?: Record<string, unknown>) => void;

/** A read of the refusal check: its value, or null when it failed or did not answer within CHECK_READ_MS. */
async function bounded<T>(read: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CHECK_READ_MS);
  });
  try {
    return await Promise.race([read.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

export type SendOptions = { refuseFailedSwaps?: readonly Address[]; maxGas?: bigint; value?: bigint; gasAtCap?: boolean; notAfter?: bigint };

export class RelaySender {
  readonly #client: PublicClient;
  readonly #transport: Transport;
  readonly #account: PrivateKeyAccount;
  readonly #receiptTimeoutMs: number;
  readonly #settleTimeoutMs: number;
  readonly #refusalCheckMs: number;
  readonly #log: SendLog;
  #tail: Promise<unknown> = Promise.resolve();

  /** `o` shortens the waits for tests; the service uses RECEIPT_TIMEOUT_MS, SETTLE_TIMEOUT_MS and REFUSAL_CHECK_MS, and passes its log. */
  constructor(
    client: PublicClient,
    transport: Transport,
    account: PrivateKeyAccount,
    o: { receiptTimeoutMs?: number; settleTimeoutMs?: number; refusalCheckMs?: number; log?: SendLog } = {},
  ) {
    this.#client = client;
    this.#transport = transport;
    this.#account = account;
    this.#receiptTimeoutMs = o.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS;
    this.#settleTimeoutMs = o.settleTimeoutMs ?? SETTLE_TIMEOUT_MS;
    this.#refusalCheckMs = o.refusalCheckMs ?? REFUSAL_CHECK_MS;
    this.#log = o.log ?? (() => undefined);
  }

  get address(): Address {
    return this.#account.address;
  }

  /**
   * Sends `tx` after every earlier send has finished; resolves when it landed,
   * throws NotSentError or SendUnknownError. `refuseFailedSwaps`: vaults whose
   * Swap in `tx` is not sent if it fails now (SwapFailed). `maxGas`: the
   * highest gas limit it is sent with; `gasAtCap`: sent with exactly that
   * limit (code that keeps gas back for a fallback, such as
   * OstraRouter.executeEscrow's refund, needs more than eth_estimateGas finds,
   * as the fallback does not revert). `notAfter`: a deadline (unix seconds)
   * the transaction reverts after; it is not signed once the latest block is
   * within DEADLINE_SPARE_SECONDS of it.
   */
  send(tx: { to: Address; data: Hex }, o: SendOptions = {}): Promise<Landed> {
    const run = () => this.#send({ ...tx, value: o.value ?? 0n }, o.refuseFailedSwaps ?? [], o.maxGas, o);
    const p = this.#tail.then(run, run);
    this.#tail = p.catch(() => undefined);
    return p;
  }

  async #receipt(hash: Hash, value: bigint): Promise<Landed | { reverted: bigint } | null> {
    try {
      const r = await this.#client.getTransactionReceipt({ hash });
      if (r.status !== "success") return { reverted: r.gasUsed * r.effectiveGasPrice };
      return { txHash: hash, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, block: r.blockNumber, value };
    } catch {
      return null; // not found (yet)
    }
  }

  /** The transaction's receipt (its outcome), "none" when the node answered that it has none, or null when the read failed. */
  async #lookup(hash: Hash, value: bigint): Promise<Landed | { reverted: bigint } | "none" | null> {
    let missing = false;
    const r = await bounded(
      this.#client.getTransactionReceipt({ hash }).catch((err: unknown) => {
        if ((err as { name?: unknown }).name === "TransactionReceiptNotFoundError") missing = true;
        throw err;
      }),
    );
    if (r === null) return missing ? "none" : null;
    if (r.status !== "success") return { reverted: r.gasUsed * r.effectiveGasPrice };
    return { txHash: hash, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, block: r.blockNumber, value };
  }

  /**
   * After a send answered with a JSON-RPC error, what the chain shows within the refusal check: the transaction's
   * outcome (its receipt), "nonce used" (another transaction holds its nonce: it can never land), "refused" (no
   * receipt and the nonce still free, every read of the last round having answered), or "unknown" (a read did not
   * answer: left to the replacement proof).
   */
  async #afterRefusal(hash: Hash, nonce: number, value: bigint): Promise<Landed | { reverted: bigint } | "nonce used" | "refused" | "unknown"> {
    const deadline = Date.now() + this.#refusalCheckMs;
    for (;;) {
      const found = await this.#lookup(hash, value);
      if (found !== null && found !== "none") return found;
      const count = await bounded(this.#client.getTransactionCount({ address: this.#account.address, blockTag: "latest" }));
      if (count !== null && count > nonce) {
        // The nonce is used for good: by this transaction (its receipt shows, give or take a node's lag) or by another.
        const until = Math.max(deadline, Date.now() + USED_NONCE_RECEIPT_MS);
        for (;;) {
          const again = await this.#lookup(hash, value);
          if (again !== null && again !== "none") return again;
          if (Date.now() >= until) return again === "none" ? "nonce used" : "unknown";
          await sleep(POLL_MS);
        }
      }
      if (Date.now() >= deadline) return found === "none" && count !== null ? "refused" : "unknown";
      await sleep(POLL_MS);
    }
  }

  async #send(tx: { to: Address; data: Hex; value: bigint }, refuseFailedSwaps: readonly Address[], maxGas: bigint | undefined, o: SendOptions): Promise<Landed> {
    const account = this.#account;
    let gas: bigint;
    try {
      gas = await this.#client.estimateGas({ account: account.address, to: tx.to, data: tx.data, value: tx.value });
    } catch (err) {
      const e = err as { shortMessage?: string; message?: string };
      throw new NotSentError(`the transaction reverts now, so it was not sent: ${e.shortMessage ?? e.message ?? String(err)}`);
    }
    let limit = gas + (gas * GAS_LIMIT_MARGIN_PERCENT) / 100n;
    if (maxGas !== undefined) {
      if (gas > maxGas) throw new NotSentError(`the transaction needs ${gas} gas now, more than the ${maxGas} it was priced for, so it was not sent; sent again, it is priced anew`, null, true);
      if (limit > maxGas || o.gasAtCap === true) limit = maxGas;
    }
    if (refuseFailedSwaps.length !== 0) {
      let failed: ReturnType<typeof failedSwaps>;
      let module: ReturnType<typeof failedModuleSpends>;
      try {
        const logs = (await simulateRelay(this.#client, { relayer: account.address, to: tx.to, data: tx.data, value: tx.value })).logs;
        failed = failedSwaps(logs, refuseFailedSwaps);
        module = failedModuleSpends(logs, refuseFailedSwaps);
      } catch (err) {
        throw new NotSentError(`its Swap could not be checked, so it was not sent: ${(err as Error).message}`);
      }
      if (failed.length !== 0) {
        throw new NotSentError(`the Swap of ${failed.map((f) => `vault ${f.vault} (${f.reason})`).join(", ")} fails now, so it was not sent`);
      }
      if (module.length !== 0) {
        throw new NotSentError(`the spend of ${module.map((f) => `vault ${f.vault} (${f.kind} ${f.action}: ${moduleFailureText(f.reason)})`).join(", ")} fails now, so it was not sent`);
      }
    }
    if (o.notAfter !== undefined) {
      const now = (await this.#client.getBlock({ blockTag: "latest" })).timestamp;
      if (now + DEADLINE_SPARE_SECONDS > o.notAfter) throw new NotSentError(`its deadline ${o.notAfter} is less than ${DEADLINE_SPARE_SECONDS} s away, so it was not sent`);
    }
    const nonce = await this.#client.getTransactionCount({ address: account.address, blockTag: "pending" });
    const { maxFeePerGas, maxPriorityFeePerGas } = await this.#client.estimateFeesPerGas();
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: this.#transport });
    const signed = await wallet.signTransaction({
      account,
      chain: robinhoodChain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: limit,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    const hash = keccak256(signed);
    let sendError: unknown;
    /** Why the replacement proof runs after a send answered with an error (in place of the transport failure's text). */
    let sendNote: string | undefined;
    try {
      await this.#client.sendRawTransaction({ serializedTransaction: signed });
    } catch (err) {
      sendError = err;
    }
    if (sendError !== undefined && isNodeRefusal(sendError)) {
      // viem's shortMessage names the error code ("Transaction creation failed."); details is the node's own reason
      // (an RPC error's message, never its URL), such as insufficient funds for gas * price + value.
      const e = sendError as { shortMessage?: string; message?: string; details?: string };
      const reason = e.shortMessage ?? e.message ?? String(sendError);
      const answered = `${reason}${e.details !== undefined && e.details !== "" && e.details !== reason ? ` (${e.details})` : ""}`;
      // Refused only if the chain agrees (REFUSAL_CHECK_MS).
      const seen = await this.#afterRefusal(hash, nonce, tx.value);
      this.#log("send_answered_error", { txHash: hash, nonce, answered, seen: typeof seen === "string" ? seen : "reverted" in seen ? "reverted" : "landed" });
      if (seen === "refused") throw new NotSentError(`the node refused transaction ${hash}: ${answered}`, hash);
      if (seen === "nonce used") throw new NotSentError(`the node refused transaction ${hash} (${answered}) and nonce ${nonce} is used by another transaction`, hash);
      if (seen !== "unknown") {
        if ("reverted" in seen) throw new NotSentError(`transaction ${hash} reverted on-chain`, hash, false, seen.reverted);
        return seen;
      }
      // Not known either way: proven below by replacing the nonce.
      sendNote = `the node answered the send with an error (${answered}) and the chain could not be read to tell`;
    }
    if (sendError === undefined) {
      const deadline = Date.now() + this.#receiptTimeoutMs;
      while (Date.now() < deadline) {
        const r = await this.#receipt(hash, tx.value);
        if (r !== null && "reverted" in r) throw new NotSentError(`transaction ${hash} reverted on-chain`, hash, false, r.reverted);
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
      const r = await this.#receipt(hash, tx.value);
      if (r !== null && "reverted" in r) throw new NotSentError(`transaction ${hash} reverted on-chain`, hash, false, r.reverted);
      if (r !== null) return r;
      if ((await this.#receipt(replacementHash, 0n)) !== null) {
        const why = sendNote ?? (sendError === undefined ? `no receipt within ${this.#receiptTimeoutMs / 1_000} s` : `the send failed without an answer from the node (${errorText(sendError)})`);
        throw new NotSentError(`transaction ${hash} was replaced at nonce ${nonce}: ${why}`, hash);
      }
      await sleep(POLL_MS);
    }
    throw new SendUnknownError(`transaction ${hash} (nonce ${nonce}) has no receipt and its replacement did not land within ${this.#settleTimeoutMs / 1_000} s`, hash);
  }
}
