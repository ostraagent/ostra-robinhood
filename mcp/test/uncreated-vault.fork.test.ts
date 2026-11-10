// A token vault that holds tokens but was never created (MCP 0.1.22), through the MCP server as an agent's client runs
// it: spawned over stdio, on a fork of Robinhood Chain mainnet with Ostra and the launchpad deployed, without a relayer
// (the fee payer in OSTRA_HOME pays gas). WETH sent to the agent's WETH vault address by a plain transfer, before that
// vault exists: balance lists it (exists false, with a note on what creates it), token_vault shows it, and
// transfer_token sends part of it at once, creating the vault first; balance then shows the vault created with the
// rest. The other tools that create such a vault, and the other ways tokens arrive, run in core's
// uncreated-vault.fork.test.ts and uncreated-vault-v5.fork.test.ts and keeper's tide-link-uncreated.fork.test.ts.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAddress, parseAbi, type Address } from "viem";
import { WETH, usdgAbi, type Deployment } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";

const wethAbi = parseAbi(["function deposit() payable", "function transfer(address to, uint256 amount) returns (bool)"]);
const RECIPIENT = getAddress("0x00000000000000000000000000000000000D0D2A");

let fork: Fork;
let d: Deployment;
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-mcp-uncreated-"));
  fork = await startFork();
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  await writeFile(join(root, "deployment.json"), JSON.stringify(d));
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function connect(home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [process.env.OSTRA_MCP_ENTRY ?? fileURLToPath(new URL("../src/server.ts", import.meta.url))],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      OSTRA_HOME: home,
      OSTRA_DEPLOYMENT: join(root, "deployment.json"),
      OSTRA_RPC_URL: fork.url,
      OSTRA_RELAYER_URL: "off",
      OSTRA_KEEPER_URL: "off",
      OSTRA_AGGREGATOR_URL: "off",
      OSTRA_ETH_RPC_URL: "off",
      OSTRA_RAETO_URL: "off",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "ostra-mcp-uncreated-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

type Answer = { ok: boolean; text: string; json: Record<string, unknown> };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]?.text ?? "";
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { ok: r.isError !== true, text, json };
}

const weth = (who: Address) => fork.client.readContract({ address: WETH, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
type Row = { token: string; symbol: string | null; vault: string; balance: string; exists: boolean };

test("WETH sent to a vault not created yet: balance and token_vault show it, transfer_token sends it at once", { timeout: 900_000 }, async () => {
  const home = join(root, "agent");
  const client = await connect(home);
  try {
    const first = await call(client, "balance");
    assert.ok(first.ok, first.text);
    assert.deepEqual(first.json.tokenVaults, []);
    assert.equal(first.json.tokenVaultsNote, undefined);
    await fork.setBalance((first.json.vault as { feePayer: Address }).feePayer, 10n ** 18n);
    const opened = await call(client, "open_vault");
    assert.ok(opened.ok, opened.text);

    const info = await call(client, "token_vault", { token: WETH });
    assert.ok(info.ok, info.text);
    const vault = getAddress(info.json.vault as string);
    assert.equal(info.json.exists, false);

    const from = fork.accounts[1]!;
    const w = fork.wallet(from);
    const amount = 3n * 10n ** 15n;
    await fork.client.waitForTransactionReceipt({ hash: await w.writeContract({ account: from, chain: null, address: WETH, abi: wethAbi, functionName: "deposit", value: amount }) });
    await fork.client.waitForTransactionReceipt({ hash: await w.writeContract({ account: from, chain: null, address: WETH, abi: wethAbi, functionName: "transfer", args: [vault, amount] }) });

    const listed = await call(client, "balance");
    assert.ok(listed.ok, listed.text);
    const rows = listed.json.tokenVaults as Row[];
    assert.deepEqual(rows, [{ token: getAddress(WETH), symbol: "WETH", vault, balance: "0.003", exists: false }]);
    assert.match(String(listed.json.tokenVaultsNote), /transfer_token/);
    const shown = await call(client, "token_vault", { token: WETH });
    assert.equal(shown.json.balance, "0.003");
    assert.equal(shown.json.exists, false);

    // Before 0.1.22: "this agent has no vault in ...". Now the vault is created first, then the transfer.
    const sent = await call(client, "transfer_token", { token: WETH, destination: RECIPIENT, amount: "0.001" });
    assert.ok(sent.ok, sent.text);
    assert.equal(sent.json.status, "sent", sent.text);
    assert.equal(await weth(RECIPIENT), 10n ** 15n);
    assert.equal(await weth(vault), 2n * 10n ** 15n);

    const after = await call(client, "balance");
    assert.deepEqual(after.json.tokenVaults, [{ token: getAddress(WETH), symbol: "WETH", vault, balance: "0.002", exists: true }]);
    assert.equal(after.json.tokenVaultsNote, undefined);
  } finally {
    await client.close();
  }
});
