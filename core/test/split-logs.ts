// A logs client for the fork tests: eth_getLogs over blocks up to the fork block goes to the public RPC (the chain's
// history, whose log spans getLogsChunked knows), over later blocks to the fork (what the test itself made happen);
// everything else goes to the fork. Both sources are real: nothing is answered here.

import { createPublicClient, custom, numberToHex, type PublicClient } from "viem";
import { ROBINHOOD_PUBLIC_RPC, robinhoodChain } from "@ostraagent/sdk";

type Filter = { fromBlock?: string; toBlock?: string; [k: string]: unknown };

/** One JSON-RPC call; a rate limit (429, or "Too Many Requests") is waited out and asked again, 8 times at most (1 s doubling, as retryingHttp). */
async function call(url: string, method: string, params: unknown[]): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await res.text();
    const limited = res.status === 429 || /too many requests/i.test(text);
    if (limited && attempt < 8) {
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** Math.min(attempt, 5)));
      continue;
    }
    const body = JSON.parse(text) as { result?: unknown; error?: { code: number; message: string } };
    if (body.error !== undefined) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code });
    return body.result;
  }
}

export function splitLogsClient(forkUrl: string, forkBlock: bigint, historyUrl: string = process.env.OSTRA_LOGS_RPC ?? ROBINHOOD_PUBLIC_RPC): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const ps = (params ?? []) as unknown[];
        if (method !== "eth_getLogs") return call(forkUrl, method, ps);
        const f = ps[0] as Filter;
        const head = BigInt((await call(forkUrl, "eth_blockNumber", [])) as string);
        const num = (x: string | undefined, dflt: bigint) => (x === undefined || x === "latest" ? dflt : x === "earliest" ? 0n : BigInt(x));
        const from = num(f.fromBlock, head);
        const to = num(f.toBlock, head);
        const out: unknown[] = [];
        if (from <= forkBlock) out.push(...((await call(historyUrl, "eth_getLogs", [{ ...f, fromBlock: numberToHex(from), toBlock: numberToHex(to < forkBlock ? to : forkBlock) }])) as unknown[]));
        if (to > forkBlock) out.push(...((await call(forkUrl, "eth_getLogs", [{ ...f, fromBlock: numberToHex(from > forkBlock ? from : forkBlock + 1n), toBlock: numberToHex(to) }])) as unknown[]));
        return out;
      },
    }),
  }) as PublicClient;
}
