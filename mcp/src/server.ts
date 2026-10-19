#!/usr/bin/env node
// Ostra Agent's MCP server over stdio. It reads its configuration from the
// environment (config.ts), opens the agent's keys in OSTRA_HOME (keys.ts),
// registers the tools (tools.ts) and runs the sweep every SWEEP_SECONDS.
// Logs go to stderr as JSON lines; stdout carries the MCP protocol only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { redact } from "@ostraagent/sdk";
import { Agent, SWEEP_SECONDS } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { packaged } from "./packaged.ts";
import { registerTools } from "./tools.ts";

const INSTRUCTIONS =
  "Ostra Agent: the agent's own post-quantum vault of USDG on Robinhood Chain (WOTS one-time keys; every spend is checked before its key signs it), " +
  "x402 payments from it, the shielded pool, guardian recovery, and the Ostra launchpad (buy and sell launched tokens, launch a token with a dev buy, " +
  "pool settings, creator shares, airdrops, vesting). With the Ostra relayer the agent needs no ETH: every transaction is paid in USDG from the vault. " +
  "Start with open_vault and balance; amounts are decimal strings (USDG: at most 6 decimals).";

/** The RPC URL in use, once read: it may carry an API key, so no log line carries it. */
let rpcUrl: string | null = null;

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  process.stderr.write(`${rpcUrl === null ? line : redact(line, rpcUrl)}\n`);
}

async function main(): Promise<void> {
  const config = await loadConfig();
  rpcUrl = config.rpcUrl;
  const agent = await Agent.open(config, log);
  const server = new McpServer({ name: "ostra-agent", version: packaged?.version ?? "0.1.0" }, { instructions: INSTRUCTIONS });
  registerTools(server, agent);
  await server.connect(new StdioServerTransport());
  log("started", { chainId: config.chainId, relayer: config.relayerUrl !== null, launchpad: config.deployment.launchpad !== undefined, feePayer: agent.keys.feePayer.address });
  const timer = setInterval(() => void agent.sweep(), SWEEP_SECONDS * 1000);
  timer.unref();
}

main().catch((err: unknown) => {
  const url = process.env.OSTRA_RPC_URL;
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log("fatal", { error: url === undefined || url === "" ? message : redact(message, url) });
  process.exit(1);
});
