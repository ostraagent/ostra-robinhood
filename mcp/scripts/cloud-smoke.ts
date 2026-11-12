// Ostra Cloud's smoke check (cloud/compose.yml running): an agent session through the front, as a connector would
// reach it, on Robinhood Chain mainnet (reads only: nothing is signed, nothing sent to the chain).
//
//   node scripts/cloud-smoke.ts <front URL> <bearer token> <vault>
//   node scripts/cloud-smoke.ts latest-vault     the newest USDG vault the factory made (OSTRA_DEPLOYMENT, and
//                                                OSTRA_RPC_URL_FILE: the chain's RPC); a vault to be the agent of
//
// The session's server holds no seed: its agent key's roots come from the signer (agent_key_request: a new root is
// handed out and kept as issued, never installed), the chain and Ostra's services through the egress (v5_status,
// balance). pay reaches a public host through the egress (https://example.com/, no payment asked: TLS checked end
// to end with the image's certificate authorities); the egress refuses a name that resolves to 127.0.0.1; the
// server itself refuses the cloud metadata address and plain HTTP. Prints CLOUD_SMOKE_OK at the end; any failure exits
// 1 with what failed.

import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPublicClient, getAddress, http, isAddress, type PublicClient } from "viem";
import { listOstraVaults, parseDeployment, robinhoodChain } from "@ostraagent/sdk";

if (process.argv[2] === "latest-vault") {
  const d = parseDeployment(JSON.parse(await readFile(process.env.OSTRA_DEPLOYMENT ?? "", "utf8")));
  const rpc = (await readFile(process.env.OSTRA_RPC_URL_FILE ?? "", "utf8")).trim();
  const client = createPublicClient({ chain: robinhoodChain, transport: http(rpc, { retryCount: 3, timeout: 30_000 }) }) as PublicClient;
  const vaults = await listOstraVaults(client, d.vaultFactory, BigInt(d.fromBlock), await client.getBlockNumber(), d.token);
  const newest = vaults.at(-1);
  if (newest === undefined) {
    process.stderr.write("the factory made no USDG vault\n");
    process.exit(1);
  }
  process.stdout.write(`${newest.vault}\n`);
  process.exit(0);
}

const [url, token, vaultText] = process.argv.slice(2);
if (url === undefined || token === undefined || vaultText === undefined || !isAddress(vaultText, { strict: false })) {
  process.stderr.write("usage: node scripts/cloud-smoke.ts <front URL> <bearer token> <vault>\n");
  process.exit(2);
}
const vault = getAddress(vaultText);

function fail(what: string): never {
  process.stderr.write(`CLOUD_SMOKE_FAILED: ${what}\n`);
  process.exit(1);
}

/** A tool's answer: its text, and whether it is an error. */
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]?.text ?? "";
  return { text, error: r.isError === true };
}

const client = new Client({ name: "ostra-cloud-smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${url.replace(/\/+$/, "")}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
try {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ["agent_key_request", "withdraw", "v5_status", "balance", "pay"]) if (!names.includes(n)) fail(`tools/list has no ${n}`);
  console.log(`  tools/list: ${names.length} tools`);

  const v5 = await call(client, "v5_status", {});
  if (v5.error) fail(`v5_status: ${v5.text}`);
  const status = JSON.parse(v5.text) as { role?: unknown; version?: unknown; vault?: unknown };
  if (status.role !== "agent" || typeof status.version !== "number" || status.version < 5 || status.vault !== vault) fail(`v5_status answered role ${String(status.role)}, version ${String(status.version)}, vault ${String(status.vault)}`);
  console.log(`  v5_status: agent of ${vault}, version ${status.version} (the chain read through the egress)`);

  const bal = await call(client, "balance", {});
  if (bal.error) fail(`balance: ${bal.text}`);
  const b = JSON.parse(bal.text) as { creatorVault?: unknown; tokenVaults?: unknown; keys?: unknown; vault?: { vault?: unknown } };
  if (b.creatorVault !== null || !Array.isArray(b.tokenVaults) || b.tokenVaults.length !== 0) fail("balance shows vaults of the agent's own");
  if (!/Ostra Cloud/.test(String(b.keys))) fail("balance does not say the seed is in Ostra Cloud's signer");
  console.log("  balance: the owner's vault only, the seed in the signer");

  const key = await call(client, "agent_key_request", {});
  if (key.error) fail(`agent_key_request: ${key.text}`);
  const root = (JSON.parse(key.text) as { root?: unknown }).root;
  if (typeof root !== "string" || !/^0x[0-9a-f]{64}$/.test(root)) fail("agent_key_request gave no root");
  console.log(`  agent_key_request: a root from the signer (${root.slice(0, 10)}…), nothing installed`);

  // pay to a public host, through the egress: its answer (no 402, so nothing is paid).
  const ok = await call(client, "pay", { url: "https://example.com/", maxPrice: "0.01" });
  if (ok.error) fail(`pay https://example.com/: ${ok.text.slice(0, 200)}`);
  const okStatus = (JSON.parse(ok.text) as { status?: unknown; paid?: unknown }).status;
  if (typeof okStatus !== "number" || okStatus >= 500) fail(`pay https://example.com/ answered ${String(okStatus)}`);
  console.log(`  pay https://example.com/: status ${okStatus} through the egress, nothing paid`);

  // pay: refused before anything is paid. localtest.me resolves to 127.0.0.1 in public DNS (checked here first): the
  // egress refuses it.
  const local = await lookup("localtest.me", { all: true }).catch(() => []);
  if (local.length === 0 || !local.every((a) => a.address === "127.0.0.1")) fail(`localtest.me does not resolve to 127.0.0.1 only here (${JSON.stringify(local)}): the egress check needs another such name`);
  for (const [target, why] of [
    ["https://localtest.me/", /not a public address/],
    ["https://169.254.169.254/latest/meta-data/", /not a public address/],
    ["http://example.com/", /https requests only/],
  ] as const) {
    const r = await call(client, "pay", { url: target, maxPrice: "0.01" });
    if (!r.error || !why.test(r.text)) fail(`pay ${target} was not refused as it should be: ${r.text.slice(0, 200)}`);
    console.log(`  pay ${target}: refused (${r.text.slice(0, 90)})`);
  }
} finally {
  await client.close().catch(() => {});
}
console.log("CLOUD_SMOKE_OK");
