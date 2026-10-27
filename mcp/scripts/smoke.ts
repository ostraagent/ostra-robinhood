// Runs the npm package as an MCP client does, through npx, in a fresh
// OSTRA_HOME and npm cache: the tools are listed, `tokens` reads the
// launchpad from the chain, `balance` answers, `ostra_ai_credit` reaches Ostra
// AI (no payment), `private_recover` reads the private pool's whole history
// (its events against its trees: a fresh seed holds no notes), `borro_markets`
// reads Borro's markets on Morpho (NVDA among them, listed), and `backup`
// without arguments prints its usage. Run on the packed tarball before publishing and on the
// published version after:
//
//   node scripts/smoke.ts ./release/ostraagent-mcp-0.1.0.tgz
//   node scripts/smoke.ts @ostraagent/mcp@0.1.0
//
// The environment is passed on (npm's proxy settings among it) but for HOME,
// OSTRA_HOME and the npm cache, and without OSTRA_DEPLOYMENT and
// OSTRA_RPC_URL_FILE: the package runs on what it carries. OSTRA_RPC_URL and
// the service URLs are passed on when set. npx runs in the scratch directory:
// in mcp/, whose package.json is @ostraagent/mcp itself, it would run this
// workspace's bin instead of the package's.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const arg = process.argv[2];
if (arg === undefined) throw new Error("usage: node scripts/smoke.ts <tarball | package@version>");
// npx runs a tarball's command by name (--package); a published version as an MCP client's config does.
const npx = arg.endsWith(".tgz") ? ["-y", `--package=${resolve(arg)}`, "ostra-mcp"] : ["-y", arg];
const source = await readFile(new URL("../src/tools.ts", import.meta.url), "utf8");
const expected = new Set([...source.matchAll(/tool\(\s*"([a-z_]+)"/g)].map((m) => m[1] as string));

const root = await mkdtemp(join(tmpdir(), "ostra-mcp-smoke-"));
const env: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) if (value !== undefined && name !== "OSTRA_DEPLOYMENT" && name !== "OSTRA_RPC_URL_FILE") env[name] = value;
Object.assign(env, { HOME: root, OSTRA_HOME: join(root, "home"), npm_config_cache: join(root, "npm-cache") });

let stderr = "";
try {
  // First `backup` without arguments, which installs the package into the fresh npm cache (no MCP request waits on it).
  const usage = await promisify(execFile)("npx", [...npx, "backup"], { env, cwd: root }).then(
    () => "",
    (err: { stderr?: string }) => err.stderr ?? "",
  );
  assert.match(usage, /usage: npx -y @ostraagent\/mcp backup export <file> \| import <file>/, usage);
  const transport = new StdioClientTransport({ command: "npx", args: npx, env, cwd: root, stderr: "pipe" });
  transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const client = new Client({ name: "ostra-mcp-smoke", version: "0.0.0" });
  await client.connect(transport);
  const info = client.getServerVersion();
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  assert.deepEqual([...names].sort(), [...expected].sort(), "the tools listed are the tools in src/tools.ts");
  // Past the MCP client's default 60 s: borro_markets reads Borro's 12 markets, over 60 s through a busy RPC.
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as { isError?: boolean; content: { text: string }[] };
    return { ok: r.isError !== true, text: r.content[0]?.text ?? "" };
  };
  const tokens = await call("tokens", { limit: 1 });
  assert.ok(tokens.ok, tokens.text);
  const balance = await call("balance", {});
  assert.ok(balance.ok, balance.text);
  const credit = await call("ostra_ai_credit", {});
  assert.ok(credit.ok, credit.text);
  assert.match(credit.text, /"credit": "[0-9.]+"/, credit.text);
  const recovered = await call("private_recover", {});
  assert.ok(recovered.ok, recovered.text);
  const found = JSON.parse(recovered.text) as { pool?: string; notes?: number; tokens?: unknown[]; privateVaults?: unknown[] };
  assert.ok(typeof found.pool === "string" && found.notes === 0 && Array.isArray(found.tokens) && found.tokens.length === 0, recovered.text);
  assert.ok(Array.isArray(found.privateVaults) && found.privateVaults.length === 0, recovered.text);
  const markets = await call("borro_markets", {});
  assert.ok(markets.ok, markets.text);
  const rows = JSON.parse(markets.text) as { symbol: string; listed: boolean }[];
  assert.ok(rows.some((m) => m.symbol === "NVDA" && m.listed), markets.text);
  await client.close();
  const started = stderr.split("\n").find((l) => l.includes('"event":"started"'));
  assert.ok(started !== undefined, "the server logged its start");
  process.stdout.write(
    `${info?.name}@${info?.version}: ${names.size} tools; tokens: ${tokens.text.slice(0, 160).replace(/\s+/g, " ")}...; ${started}\nbalance: ${balance.text.slice(0, 400).replace(/\s+/g, " ")}\nostra_ai_credit: ${credit.text.replace(/\s+/g, " ")}\nprivate_recover: ${recovered.text.replace(/\s+/g, " ")}\nborro_markets: ${rows.length} markets, listed: ${rows.filter((m) => m.listed).map((m) => m.symbol).join(" ")}\nSMOKE_OK\n`,
  );
} catch (err) {
  process.stderr.write(`${stderr.slice(-3000)}\n`);
  throw err;
} finally {
  await rm(root, { recursive: true, force: true });
}
