// An Ethereum mainnet client that reads Ethereum as it was at a given time, for the fork tests pinned to an older
// Robinhood Chain block (strategy-pinned and strategy-shared): the planner reads USDe's price from Chainlink's USDe / USD
// feed on Ethereum, and a fork of 22 Oct 2026 read against today's price is a test of today's market, not of that
// day's (on 30 Oct 2026 USDe stood at 0.9944482, under the planner's 0.995, and both tests failed for it). Every read
// that names no block (or latest, pending, safe or finalized) is sent for the Ethereum block of that time instead: the
// last one at or before it. The answers are the node's own: url must serve Ethereum's old state (an archive RPC).

import { createPublicClient, custom, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { retryingHttp } from "@ostraagent/sdk";

const MOVING_TAGS = new Set(["latest", "pending", "safe", "finalized"]);
/** The position of the block parameter of each read that takes one. */
const BLOCK_PARAM: Readonly<Record<string, number>> = { eth_call: 1, eth_getBalance: 1, eth_getCode: 1, eth_getTransactionCount: 1, eth_getStorageAt: 2, eth_getBlockByNumber: 0 };

const blocks = new Map<string, Promise<bigint>>();

/** The last Ethereum block at or before `at` (seconds), by its timestamp. */
async function blockAt(base: PublicClient, at: bigint): Promise<bigint> {
  const ts = async (n: bigint) => (await base.getBlock({ blockNumber: n })).timestamp;
  const head = await base.getBlock({ blockTag: "latest" });
  if (head.timestamp <= at) throw new Error(`Ethereum's latest block (${head.timestamp}) is not after ${at}`);
  // A first guess from Ethereum's 12 s slots, widened until it brackets the time.
  let span = (head.timestamp - at) / 12n + 1_000n;
  let lo = head.number > span ? head.number - span : 0n;
  while (lo > 0n && (await ts(lo)) > at) {
    span *= 2n;
    lo = head.number > span ? head.number - span : 0n;
  }
  let hi = head.number;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await ts(mid)) <= at) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** An Ethereum mainnet client over `url` that reads Ethereum at its block of time `at` (seconds since 1970). */
export async function ethClientAt(url: string, at: bigint): Promise<{ client: PublicClient; block: bigint }> {
  const base = createPublicClient({ chain: mainnet, transport: retryingHttp(url) }) as PublicClient;
  const key = `${url}|${at}`;
  // A failed lookup is not kept: the next call asks again.
  if (!blocks.has(key)) blocks.set(key, blockAt(base, at).catch((e: unknown) => {
    blocks.delete(key);
    throw e;
  }));
  const block = await (blocks.get(key) as Promise<bigint>);
  const tag = `0x${block.toString(16)}`;
  const client = createPublicClient({
    chain: mainnet,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_blockNumber") return tag;
        const ps = [...((params ?? []) as unknown[])];
        const i = BLOCK_PARAM[method];
        if (i !== undefined && (ps[i] === undefined || (typeof ps[i] === "string" && MOVING_TAGS.has(ps[i] as string)))) {
          ps[i] = tag;
          if (method === "eth_getBlockByNumber" && ps[1] === undefined) ps[1] = false;
        }
        return base.request({ method, params: ps } as never);
      },
    }),
  }) as PublicClient;
  return { client, block };
}
