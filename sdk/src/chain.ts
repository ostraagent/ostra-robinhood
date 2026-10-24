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
 * reached that block yet. viem does not retry that code. eth_getLogs is left out: some RPCs answer a span too large
 * with -32602, and getLogsChunked (morpho.ts) shrinks the span at once instead.
 */
const IDEMPOTENT_READS = new Set(["eth_call", "eth_getCode", "eth_getStorageAt", "eth_getBalance", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_blockNumber", "eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getTransactionCount", "eth_gasPrice"]);
/** How often an idempotent read answered -32602 is asked again, and the wait before each time (doubling). */
export const INVALID_PARAMS_RETRIES = 4;
const INVALID_PARAMS_WAIT_MS = 1_000;

function invalidParams(e: unknown): boolean {
  const code = (x: unknown) => (x as { code?: unknown }).code === -32602;
  return e instanceof BaseError ? e.walk(code) !== null : code(e);
}

/**
 * HTTP transport that retries rate limits (429) and server errors (5xx), at
 * most 8 times: viem waits 1 s, then doubles the wait each retry, or follows a
 * Retry-After header. An idempotent read answered -32602 is asked again
 * INVALID_PARAMS_RETRIES times (after 1, 2, 4 and 8 s), see IDEMPOTENT_READS.
 */
export function retryingHttp(url: string): Transport {
  const base = http(url, { retryCount: 8, retryDelay: 1_000, timeout: 30_000 });
  return ((params: Parameters<typeof base>[0]) => {
    const t = base(params);
    const request = (async (args: { method: string; params?: unknown }, options?: unknown) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await (t.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options);
        } catch (e) {
          if (attempt >= INVALID_PARAMS_RETRIES || !IDEMPOTENT_READS.has(args.method) || !invalidParams(e)) throw e;
          await new Promise((r) => setTimeout(r, INVALID_PARAMS_WAIT_MS * 2 ** attempt));
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
