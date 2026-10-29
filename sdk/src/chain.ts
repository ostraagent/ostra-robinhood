// Robinhood Chain as a viem chain, and the check every service runs at start:
// the RPC must serve chain 4663 (on Solana the genesis hash was checked).

import { BaseError, createPublicClient, defineChain, http, type PublicClient, type Transport } from "viem";
import { MULTICALL3, ROBINHOOD_CHAIN_ID, ROBINHOOD_PUBLIC_RPC } from "./constants.ts";

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_PUBLIC_RPC] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

/**
 * Reads that only look at the chain, so asking again cannot change anything. The public RPC answers them with
 * -32602 "Missing or invalid parameters" now and then: an eth_call of Morpho Vault V2 reads on 24 Oct 2026, which
 * succeeded the three times it was asked again, and, the same day, eth_calls at a block number the RPC itself had
 * just returned ("unsupported block number"), twice still refused after 3 s of retries: a node behind it had not
 * reached that block yet. A keyed RPC (Alchemy, seen by an agent on 29 Oct 2026) answers the same lag with -32000
 * "unsupported block number". viem retries neither code. eth_getLogs is left out: some RPCs answer a span too large
 * with -32602, and getLogsChunked (morpho.ts) shrinks the span at once instead.
 */
const IDEMPOTENT_READS = new Set(["eth_call", "eth_getCode", "eth_getStorageAt", "eth_getBalance", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_blockNumber", "eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getTransactionCount", "eth_gasPrice"]);
/** How often an idempotent read answered so is asked again, and the wait before each time (doubling). */
export const INVALID_PARAMS_RETRIES = 4;
const INVALID_PARAMS_WAIT_MS = 1_000;

/** -32602, or -32000 "unsupported block number": answers a node behind the one that gave the block number gives. */
function laggingRead(e: unknown): boolean {
  const lag = (x: unknown) => {
    const o = x as { code?: unknown; details?: unknown; message?: unknown };
    if (o.code === -32602) return true;
    return o.code === -32000 && /unsupported block number/i.test(`${String(o.details ?? "")} ${String(o.message ?? "")}`);
  };
  return e instanceof BaseError ? e.walk(lag) !== null : lag(e);
}

/** One retry of a request by retryingHttp with `onRetry`: the method, which retry it is, the wait before it, why. */
export type RpcRetry = { method: string; retry: number; waitMs: number; error: string };

/** Retries of a transient failure, as viem's http transport makes them, unless retryingHttp is given another count. */
export const RPC_RETRIES = 8;
const RPC_RETRY_WAIT_MS = 1_000;
const RPC_TIMEOUT_MS = 30_000;
const RETRY_AFTER_MAX_MS = 10_000;

/**
 * A failure viem's http transport retries (viem 2.57.2 buildRequest shouldRetry, followed here): an RPC error with
 * code -1, -32005 (limit exceeded), -32603 (internal), 429 or -32007 (QuickNode's limit); an HTTP error 403, 408, 413,
 * 429, 500, 502, 503 or 504; any other failure without a code or status (a timeout, the network), but not an abort.
 */
function transient(e: unknown): boolean {
  const o = e as { name?: unknown; code?: unknown; status?: unknown } | null;
  if (o === null || typeof o !== "object") return true;
  if (o.name === "AbortError") return false;
  if (typeof o.code === "number") return [-1, -32005, -32603, 429, -32007].includes(o.code);
  if (typeof o.status === "number" && o.status !== 0) return [403, 408, 413, 429, 500, 502, 503, 504].includes(o.status);
  return true;
}

/** Why a request failed, in a line without its URL (viem's shortMessage, its RPC code or HTTP status, its details). */
function failureText(e: unknown, url: string): string {
  const o = e as { shortMessage?: string; name?: string; code?: unknown; status?: unknown; details?: string } | null;
  const parts = [o?.shortMessage ?? o?.name ?? String(e)];
  if (typeof o?.code === "number") parts.push(`code ${o.code}`);
  if (typeof o?.status === "number" && o.status !== 0) parts.push(`HTTP ${o.status}`);
  if (typeof o?.details === "string" && o.details !== "" && o.details !== parts[0]) parts.push(o.details);
  return redact(parts.join("; "), url).slice(0, 300);
}

/**
 * HTTP transport that retries rate limits (429) and server errors (5xx), at
 * most 8 times: viem waits 1 s, then doubles the wait each retry, or follows a
 * Retry-After header. An idempotent read answered -32602, or -32000
 * "unsupported block number", is asked again INVALID_PARAMS_RETRIES times
 * (after 1, 2, 4 and 8 s), see IDEMPOTENT_READS.
 *
 * With `o` (the relayer, decided 29 Oct 2026: a quote waited 261 s on these retries while the agent gave up at
 * 240 s): the transient failures are retried here instead, `retryCount` times (1, 2, 4 ... s apart, or Retry-After),
 * each attempt given `timeoutMs` (a Retry-After followed up to 10 s), and `onRetry` is told of each retry and why.
 */
export function retryingHttp(url: string, o?: { retryCount?: number; timeoutMs?: number; onRetry?: (r: RpcRetry) => void }): Transport {
  const own = o !== undefined;
  const base = own ? http(url, { retryCount: 0, timeout: o.timeoutMs ?? RPC_TIMEOUT_MS }) : http(url, { retryCount: RPC_RETRIES, retryDelay: RPC_RETRY_WAIT_MS, timeout: RPC_TIMEOUT_MS });
  const retries = o?.retryCount ?? RPC_RETRIES;
  return ((params: Parameters<typeof base>[0]) => {
    const t = base(params);
    const request = (async (args: { method: string; params?: unknown }, options?: unknown) => {
      let lagging = 0;
      let failed = 0;
      for (;;) {
        try {
          return await (t.request as (a: unknown, b?: unknown) => Promise<unknown>)(args, options);
        } catch (e) {
          let wait: number;
          if (lagging < INVALID_PARAMS_RETRIES && IDEMPOTENT_READS.has(args.method) && laggingRead(e)) {
            wait = INVALID_PARAMS_WAIT_MS * 2 ** lagging;
            lagging++;
          } else if (own && failed < retries && transient(e)) {
            const after = (e as { headers?: { get?: (n: string) => string | null } }).headers?.get?.("Retry-After");
            // A Retry-After is followed up to RETRY_AFTER_MAX_MS: these retries are for requests that are waited for.
            wait = after !== null && after !== undefined && /^[0-9]+$/.test(after) ? Math.min(Number(after) * 1_000, RETRY_AFTER_MAX_MS) : RPC_RETRY_WAIT_MS * 2 ** failed;
            failed++;
          } else throw e;
          o?.onRetry?.({ method: args.method, retry: lagging + failed, waitMs: wait, error: failureText(e, url) });
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }) as typeof t.request;
    return { ...t, request };
  }) as Transport;
}

/** A public client on `url` for Robinhood Chain. Its errors may contain `url`: pass them through redact() before logging. */
export function robinhoodClient(url: string): PublicClient {
  return createPublicClient({ chain: robinhoodChain, transport: retryingHttp(url) }) as PublicClient;
}

/** Throws unless the RPC behind `client` serves chain 4663. */
export async function assertRobinhoodChain(client: PublicClient): Promise<void> {
  const id = await client.getChainId();
  if (id !== ROBINHOOD_CHAIN_ID) throw new Error(`the RPC serves chain ${id}, not Robinhood Chain (${ROBINHOOD_CHAIN_ID})`);
}

/** Replaces every occurrence of `secret` (an RPC URL that may carry an API key) in `text`. */
export function redact(text: string, secret: string): string {
  return secret === "" ? text : text.split(secret).join("<rpc>");
}
