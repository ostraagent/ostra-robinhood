#!/usr/bin/env node
// Ostra Agent's MCP server over stdio. It reads its configuration from the
// environment (config.ts), opens the agent's keys in OSTRA_HOME (keys.ts),
// registers the tools (tools.ts) and runs the sweep every SWEEP_SECONDS.
// Logs go to stderr as JSON lines; stdout carries the MCP protocol only.
//
// With OSTRA_HOME_EXCLUSIVE=yes (the remote gateway's children, remote.ts) it holds OSTRA_HOME for itself: it refuses
// to start while another live server holds it (its one-time keys must never be signed with twice), and it exits when
// its stdin closes, so that no server outlives the gateway that started it.

import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { redact } from "@ostraagent/sdk";
import { Agent, SWEEP_SECONDS } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { packaged } from "./packaged.ts";
import { registerTools } from "./tools.ts";

const INSTRUCTIONS =
  "Ostra Agent: the agent's own post-quantum vault of USDG on Robinhood Chain (WOTS one-time keys; every spend is checked before its key signs it), " +
  "x402 payments from it, the shielded pool, guardian recovery, Ostrapad (pad_* tools: list services and be paid for jobs into the vault, hire other agents through an escrow, judge jobs as an evaluator), " +
  "and Ostra Swap (ostra_swap between the agent's vaults; private_shield, private_swap and private_unshield for private notes). The Ostra launchpad is closed: only its exits remain (sell, claims, vesting). With the Ostra relayer the agent needs no ETH: every transaction is paid in USDG from the vault. " +
  "Start with open_vault and balance; amounts are decimal strings (USDG: at most 6 decimals).";

/** The RPC URLs in use, once read: they may carry an API key, so no log line carries them. */
let rpcUrls: string[] = [];

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  process.stderr.write(`${rpcUrls.reduce((text, url) => redact(text, url), line)}\n`);
}

/** Whether process `pid` lives (one this user may not signal counts as alive). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes OSTRA_HOME for this process alone: a lock file holding its pid; one left by a dead process is taken over. */
function holdHome(home: string): void {
  const lock = join(home, "server.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      process.on("exit", () => {
        try {
          if (readFileSync(lock, "utf8").trim() === String(process.pid)) rmSync(lock);
        } catch {
          // gone already
        }
      });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = Number(readFileSync(lock, "utf8").trim());
    if (alive(holder)) throw new Error(`another server (pid ${holder}) holds ${home}`);
    // A dead holder's lock: moved aside first, so that a fresh lock another starter took meanwhile is never removed.
    const aside = `${lock}.${process.pid}`;
    try {
      renameSync(lock, aside);
    } catch {
      continue;
    }
    const moved = Number(readFileSync(aside, "utf8").trim());
    if (moved !== holder || alive(moved)) {
      try {
        linkSync(aside, lock);
      } catch {
        // another lock is in place already
      }
      rmSync(aside, { force: true });
      throw new Error(`another server holds ${home}`);
    }
    rmSync(aside, { force: true });
  }
  throw new Error(`could not take ${home}`);
}

async function main(): Promise<void> {
  const exclusive = process.env.OSTRA_HOME_EXCLUSIVE === "yes";
  if (exclusive) {
    const home = process.env.OSTRA_HOME;
    if (home === undefined || home === "") throw new Error("OSTRA_HOME_EXCLUSIVE needs OSTRA_HOME");
    holdHome(home);
    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("close", () => process.exit(0));
  }
  const config = await loadConfig();
  rpcUrls = [config.rpcUrl, config.logsRpcUrl, ...(config.ethRpcUrl === null ? [] : [config.ethRpcUrl])];
  const agent = await Agent.open(config, log);
  const server = new McpServer({ name: "ostra-agent", version: packaged?.version ?? "0.1.0" }, { instructions: INSTRUCTIONS });
  registerTools(server, agent);
  await server.connect(new StdioServerTransport());
  log("started", { chainId: config.chainId, relayer: config.relayerUrl !== null, launchpad: config.deployment.launchpad !== undefined, ostraSwap: config.swap !== null, prover: config.prover?.kind ?? null, feePayer: agent.keys.feePayer.address });
  const timer = setInterval(() => void agent.sweep(), SWEEP_SECONDS * 1000);
  timer.unref();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const urls = [process.env.OSTRA_RPC_URL, process.env.OSTRA_LOGS_RPC_URL, process.env.OSTRA_ETH_RPC_URL].filter((u): u is string => u !== undefined && u !== "" && u !== "off");
  log("fatal", { error: urls.reduce((text, url) => redact(text, url), message) });
  process.exit(1);
});
