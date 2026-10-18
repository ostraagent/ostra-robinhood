// Ostra RPC proxy (design: RPC proxy, an Ostra server for the web app): the
// web app reads the chain and simulates through it, so the private RPC URL
// (OSTRA_RPC_URL) stays on the server. Only reads and simulations are
// forwarded (policy.ts), at OSTRA_RPC_PROXY_PER_IP requests a second per
// client IP address and OSTRA_RPC_PROXY_TOTAL in all (http.ts).
// Configuration: config.ts. Stops cleanly on SIGINT and SIGTERM.

import { ROBINHOOD_CHAIN_ID } from "@ostraagent/sdk";
import { loadProxyConfig } from "./config.ts";
import { createRpcProxyServer } from "./http.ts";
import { RateLimiter } from "./policy.ts";

/** The upstream's chain id, asked once at start (it replaces Solana's genesis hash check). */
async function chainId(rpcUrl: string): Promise<number> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "chain", method: "eth_chainId", params: [] }),
  });
  if (!response.ok) throw new Error(`the upstream RPC answered ${response.status} to eth_chainId`);
  const body = (await response.json()) as { result?: unknown };
  if (typeof body.result !== "string" || !/^0x[0-9a-f]+$/i.test(body.result)) throw new Error("the upstream RPC did not return a chain id");
  return Number(BigInt(body.result));
}

async function main(): Promise<void> {
  const config = loadProxyConfig();
  const redact = (text: string) => text.split(config.rpcUrl).join("<rpc>");
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    console.log(redact(JSON.stringify({ at: new Date().toISOString(), event, ...fields })));
  };
  const id = await chainId(config.rpcUrl);
  if (id !== ROBINHOOD_CHAIN_ID) throw new Error(`the RPC is chain ${id}, not Robinhood Chain (${ROBINHOOD_CHAIN_ID})`);

  const server = createRpcProxyServer({ rpcUrl: config.rpcUrl, limiter: new RateLimiter(config.perIp, config.total), clientIp: config.clientIp, log });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => resolve());
  });
  log("started", { chainId: id, listen: `${config.listen.host}:${config.listen.port}`, perIp: config.perIp, total: config.total, clientIp: config.clientIp });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("stopping", { signal });
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  const url = process.env.OSTRA_RPC_URL;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`rpc proxy failed to start: ${url === undefined || url === "" ? message : message.split(url).join("<rpc>")}`);
  process.exit(1);
});
