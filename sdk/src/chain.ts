// Robinhood Chain as a viem chain, and the check every service runs at start:
// the RPC must serve chain 4663 (on Solana the genesis hash was checked).

import { createPublicClient, defineChain, http, type PublicClient, type Transport } from "viem";
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
 * HTTP transport that retries rate limits (429) and server errors (5xx), at
 * most 8 times: viem waits 1 s, then doubles the wait each retry, or follows a
 * Retry-After header.
 */
export function retryingHttp(url: string): Transport {
  return http(url, { retryCount: 8, retryDelay: 1_000, timeout: 30_000 });
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
