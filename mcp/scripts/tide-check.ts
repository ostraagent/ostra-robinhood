// Ostra Tide end to end through the MCP server, Ostra's relayer and an Ostra index, as an agent runs it, against the
// configured chain: the server (src/server.ts, or an installed npm package's bundle named by OSTRA_CHECK_MCP) is
// spawned over stdio on OSTRA_CHECK_HOME, the home of an agent already registered in ERC-8004 through its creator
// vault (Ostrapad's check leaves one), and every approval is a real transaction sent by the relayer.
//
//   node scripts/tide-check.ts link     the server lists `tide`; the agent's id and creator vault (printed as
//                                       `IDENTITY <vault> <agentId>`, for the score run that follows); tide dashboard
//                                       answers the web app's page with the view key in the fragment; tide link links
//                                       every existing vault of the agent (each approval sent, the index verifies the
//                                       set), and a second call sends nothing; tide points answers that the link is
//                                       kept and not scored yet
//   node scripts/tide-check.ts points   after a score that read the link with the link's vaults left out of Ostra's
//                                       own list (an Ostra test agent's are in it): tide points answers the agent's
//                                       own week, its link verified on chain, every vault of it counted, and no key
//                                       of any link
//
// Environment: OSTRA_CHECK_HOME (required), OSTRA_CHECK_MCP (default ../src/server.ts), OSTRA_PAD_INDEXER_URL (the
// index; required), and what the server reads (OSTRA_RELAYER_URL, OSTRA_RPC_URL_FILE, ...), passed on as they are.
// The URLs are never printed. The last line is TIDE_LINK_OK or TIDE_POINTS_OK.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { ERC8004_IDENTITY_REGISTRY, ROBINHOOD_PUBLIC_RPC, redact, robinhoodChain } from "@ostraagent/sdk";

const TOOL_TIMEOUT_MS = 30 * 60_000;
const toJson = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const secrets = [process.env.OSTRA_PAD_INDEXER_URL ?? "", process.env.OSTRA_RELAYER_URL ?? ""].filter((s) => s !== "");
const hide = (text: string) => secrets.reduce((t, s) => redact(t, s), text);

function check(ok: boolean, what: string, detail: unknown = ""): void {
  console.log(hide(`${ok ? "PASS" : "FAIL"} ${what}${detail === "" ? "" : ` (${typeof detail === "string" ? detail : toJson(detail)})`}`));
  if (!ok) throw new Error(`stopped at: ${what}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`set ${name}`);
  return value;
}

type Answer = { ok: boolean; text: string; json: Record<string, unknown> };

async function connect(entry: string, home: string): Promise<{ client: Client; stderr: () => string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("OSTRA_CHECK_")) continue;
    env[k] = v;
  }
  env.OSTRA_HOME = home;
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-20_000);
  });
  const client = new Client({ name: "ostra-tide-check", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]?.text ?? "";
  let json: Record<string, unknown> = {};
  try {
    const v = JSON.parse(text) as unknown;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) json = v as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { ok: r.isError !== true, text, json };
}

async function main(): Promise<void> {
  const phase = process.argv[2];
  if (phase !== "link" && phase !== "points") throw new Error("usage: node scripts/tide-check.ts link|points");
  const home = required("OSTRA_CHECK_HOME");
  required("OSTRA_PAD_INDEXER_URL");
  const entry = process.env.OSTRA_CHECK_MCP || fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const record = join(home, "tide-check.json");
  const { client, stderr } = await connect(entry, home);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    check(tools.includes("tide"), "the server lists tide", `${tools.length} tools`);
    // The agent's id from its dashboard link; the vault holding its identity from the Identity Registry.
    const dash = await call(client, "tide", { action: "dashboard" });
    const m = typeof dash.json.url === "string" ? /^https:\/\/app\.ostraagent\.xyz\/tide#agent=([0-9]+)&key=0x[0-9a-f]{64}$/.exec(dash.json.url) : null;
    check(dash.ok && m !== null, "tide dashboard: the page with the agent and its view key in the fragment", dash.ok ? "" : dash.text.slice(0, 300));
    const agentId = m![1]!;
    const chain = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_PUBLIC_RPC) });
    const identity = getAddress((await chain.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: parseAbi(["function ownerOf(uint256) view returns (address)"]), functionName: "ownerOf", args: [BigInt(agentId)] })) as string);
    if (phase === "link") {
      console.log(`IDENTITY ${identity} ${agentId}`);
      const link = await call(client, "tide", { action: "link" });
      check(link.ok, "tide link answers", link.ok ? "" : link.text.slice(0, 500));
      const vaults = (link.json.vaults as string[] | undefined) ?? [];
      const approvals = (link.json.approvals as { vault: string; tx: string; status: string }[] | undefined) ?? [];
      console.log(`link: ${vaults.length} vaults, payee ${link.json.payee === null ? "none (no OSTRA vault)" : "its OSTRA vault"}, approvals ${toJson(approvals.map((a) => a.status))}`);
      check(link.json.linked === true && vaults.includes(identity) && approvals.length === vaults.length, "the set approved by the identity vault, one approval per vault", { linked: link.json.linked, left: link.json.leftOut ?? [] });
      check(approvals.every((a) => a.status === "sent" || a.status === "approved before"), "every approval sent or made before");
      check(link.json.verifiedByIndex === true, "the index verified the link on chain", link.json.verifyNote ?? "");
      const again = await call(client, "tide", { action: "link" });
      check(again.ok && ((again.json.approvals as { status: string }[] | undefined) ?? []).every((a) => a.status === "approved before") && toJson(again.json.vaults) === toJson(vaults), "a second link sends nothing", again.ok ? "" : again.text.slice(0, 300));
      const pts = await call(client, "tide", { action: "points" });
      check(pts.ok && typeof pts.json.note === "string" && /kept/.test(pts.json.note), "tide points: the link is kept, not scored yet", pts.ok ? pts.json.note ?? toJson(pts.json).slice(0, 200) : pts.text.slice(0, 300));
      await writeFile(record, JSON.stringify({ agentId, identity, vaults }), { mode: 0o600 });
      console.log("TIDE_LINK_OK");
    } else {
      const linked = JSON.parse(await readFile(record, "utf8")) as { agentId: string; vaults: string[] };
      check(linked.agentId === agentId, "the same agent as the link phase");
      const pts = await call(client, "tide", { action: "points", week: 1 });
      check(pts.ok, "tide points answers", pts.ok ? "" : pts.text.slice(0, 300));
      const agent = pts.json.agent as { agentId: string; link: { status: string; vaults?: string[] }; vaults: string[]; breakdown: { points: string }; viewKey?: unknown; pending?: unknown } | undefined;
      check(agent !== undefined && agent.agentId === agentId, "the agent's own week", agent === undefined ? toJson(pts.json).slice(0, 300) : "");
      const a = agent!;
      check(a.link.status === "verified" && toJson(a.link.vaults) === toJson(linked.vaults), "its link verified on chain, the vaults it linked", a.link.status);
      // The score this check follows leaves the link's vaults out of Ostra's own list: every one counts.
      check(toJson(a.vaults) === toJson(linked.vaults), "every vault of the link counted", `${a.vaults.length} of ${linked.vaults.length}`);
      check(a.viewKey === undefined && a.pending === undefined && !pts.text.includes("secret"), "no key or secret in the answer");
      console.log(`points: ${(Number(a.breakdown.points) / 1e6).toFixed(6)} (week ${String(pts.json.week)}, ${pts.json.final === true ? "final" : "not over"})`);
      console.log("TIDE_POINTS_OK");
    }
  } catch (err) {
    console.log(hide(stderr().slice(-3_000)));
    throw err;
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(hide(`STOPPED: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
