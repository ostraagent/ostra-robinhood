// The payment wallet through the MCP server, as an agent runs it, against Robinhood Chain mainnet and one of
// Autonomo's gateways (decided 8 Nov 2026: a real payment of 0.01 USDG to one of them; token-price's own example,
// /price/autonomo, answers 404 since 8 Nov, $AUTONOMO having launched more than its ~13 days ago, so the default is
// new-launches): the server (src/server.ts, or an installed npm package's bundle named by OSTRA_CHECK_MCP) is spawned
// over stdio on OSTRA_CHECK_HOME, an agent whose vault holds USDG. Every payment is real.
//
//   1. The server lists the payment wallet's tools; autonomo_catalog lists Autonomo's gateways, the default call among
//      them; open_vault finds the vault and v5_status answers for it (the vaults run version 5); when the wallet has
//      less free than maxPrice, the vault holds what a top-up needs (else the script prints
//      `FUND <vault> <base units> <USDG>` and waits for it).
//   2. payment_wallet_setup, with OSTRA_CHECK_TOP_UP (default 0.05 USDG) when the wallet has less free than maxPrice:
//      the wallet has at least maxPrice free.
//   3. pay OSTRA_CHECK_URL (default Autonomo's new-launches) with maxPrice OSTRA_CHECK_MAX_PRICE (default 0.01):
//      answered 200, paid from the wallet; the settlement the seller names landed, moving the price from the wallet to
//      the payTo payment_wallet_status recorded.
//   4. With OSTRA_CHECK_WITHDRAW=on (once the relayer serves a payment wallet's withdrawal): payment_wallet_withdraw,
//      the wallet's balance back in the vault.
//
// Environment: OSTRA_CHECK_HOME (required, kept), OSTRA_CHECK_MCP, OSTRA_CHECK_URL, OSTRA_CHECK_MAX_PRICE,
// OSTRA_CHECK_TOP_UP, OSTRA_CHECK_WITHDRAW, OSTRA_CHECK_FUND_SECONDS (default 3600), OSTRA_CHECK_OWN_LIST (the list of
// Ostra's own vaults the Tide scorer reads, OSTRA_STATS_OWN: the check's vault is added to it before any spend, so its
// activity never counts as an agent's), and what the server reads
// (OSTRA_DEPLOYMENT, OSTRA_RPC_URL or OSTRA_RPC_URL_FILE, OSTRA_RELAYER_URL, ...), passed on as they are. The RPC URL
// is never printed.

import { appendFile, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, formatUnits, getAddress, http, parseEventLogs, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { ROBINHOOD_PUBLIC_RPC, USDG, redact, robinhoodChain, usdgAbi } from "@ostraagent/sdk";

const NEW_LAUNCHES = "https://autonomo.fun/x/new-launches/launches?limit=10";
/** The relayer channel a new vault opens to pay its first spend (core RELAYER_CHANNEL_DEPOSIT), and gas. */
const RELAYER_ROOM = 1_000_000n + 50_000n;
const TOOL_TIMEOUT_MS = 600_000;
/** The RPC URL, once read: never printed. */
let rpcSecret = "";

const toJson = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const usdg = (x: bigint) => formatUnits(x, 6);

function check(ok: boolean, what: string, detail: unknown = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === "" ? "" : ` (${(typeof detail === "string" ? detail : toJson(detail)).slice(0, 600)})`}`);
  if (!ok) throw new Error(`stopped at: ${what}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`set ${name}`);
  return value;
}

async function rpcUrl(): Promise<string> {
  const direct = process.env.OSTRA_RPC_URL;
  const file = process.env.OSTRA_RPC_URL_FILE;
  if (direct !== undefined && direct !== "") return direct;
  if (file === undefined || file === "") return ROBINHOOD_PUBLIC_RPC;
  const mode = (await stat(file)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${file} is accessible by other users (mode ${mode.toString(8)})`);
  return (await readFile(file, "utf8")).trim();
}

type Answer = { ok: boolean; text: string; json: Record<string, unknown> };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]?.text ?? "";
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { ok: r.isError !== true, text, json };
}

async function main(): Promise<void> {
  const home = required("OSTRA_CHECK_HOME");
  const entry = process.env.OSTRA_CHECK_MCP || fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const target = process.env.OSTRA_CHECK_URL || NEW_LAUNCHES;
  const maxPrice = process.env.OSTRA_CHECK_MAX_PRICE || "0.01";
  const topUp = process.env.OSTRA_CHECK_TOP_UP || "0.05";
  const withdraw = (process.env.OSTRA_CHECK_WITHDRAW || "off") === "on";
  const fundSeconds = Number(process.env.OSTRA_CHECK_FUND_SECONDS || "3600");
  const url = await rpcUrl();
  rpcSecret = url;
  const chain = createPublicClient({ chain: robinhoodChain, transport: http(url, { retryCount: 5, retryDelay: 2_000, timeout: 60_000 }) }) as PublicClient;
  const balance = (who: Address) => chain.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !name.startsWith("OSTRA_CHECK_")) env[name] = value;
  env.OSTRA_HOME = home;
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-20_000);
  });
  const client = new Client({ name: "ostra-autonomo-check", version: "0.0.0" });
  await client.connect(transport);
  try {
    // 1. The tools, the vault, its USDG.
    const tools = (await client.listTools()).tools.map((t) => t.name);
    check(["pay", "payment_wallet_setup", "payment_wallet_status", "payment_wallet_withdraw", "autonomo_catalog"].every((n) => tools.includes(n)), "the server lists the payment wallet's tools", `${tools.length} tools`);
    const catalog = await call(client, "autonomo_catalog");
    const listed = (catalog.json.gateways as { slug: string; example: string; priceUsdg: string }[] | undefined) ?? [];
    check(catalog.ok && listed.length > 0, "autonomo_catalog lists Autonomo's gateways", listed.map((g) => `${g.slug} ${g.priceUsdg}`));
    if (process.env.OSTRA_CHECK_URL === undefined || process.env.OSTRA_CHECK_URL === "") {
      check(listed.some((g) => g.example === NEW_LAUNCHES), "the catalog names new-launches' call", NEW_LAUNCHES);
    }
    const opened = await call(client, "open_vault");
    check(opened.ok && typeof opened.json.vault === "string", "open_vault finds the vault", opened.ok ? { vault: opened.json.vault } : opened.text);
    const vault = getAddress(opened.json.vault as string);
    // The vault's version 5 state, read through the server: answered once the vaults run version 5.
    const v5 = await call(client, "v5_status");
    check(v5.ok && v5.json.role === "owner", "v5_status answers for the vault", v5.ok ? { role: v5.json.role, version: v5.json.version, agentKey: v5.json.agentKey ?? null } : v5.text);
    const ownList = process.env.OSTRA_CHECK_OWN_LIST;
    if (ownList !== undefined && ownList !== "") {
      const listed = (await readFile(ownList, "utf8")).split("\n").some((line) => line.trim().toLowerCase().startsWith(vault.toLowerCase()));
      if (!listed) {
        const text = await readFile(ownList, "utf8");
        await appendFile(ownList, `${text === "" || text.endsWith("\n") ? "" : "\n"}${vault}\tautonomo-check (Ostra's own test vault)\n`);
      }
      const now = (await readFile(ownList, "utf8")).split("\n").some((line) => line.trim().toLowerCase().startsWith(vault.toLowerCase()));
      check(now, "the vault is on the list of Ostra's own vaults", { list: ownList, added: !listed });
    }
    // A top-up only when the wallet has less free than maxPrice (a run after an earlier one needs none).
    const before = await call(client, "payment_wallet_status");
    check(before.ok, "payment_wallet_status answers", before.ok ? { available: before.json.available, reserved: before.json.reserved } : before.text);
    const needTopUp = parseUnits(String(before.json.available ?? "0"), 6) < parseUnits(maxPrice, 6);
    const fund = needTopUp ? parseUnits(topUp, 6) + RELAYER_ROOM : 0n;
    let held = await balance(vault);
    if (held < fund) {
      console.log(`FUND ${vault} ${fund - held} ${usdg(fund - held)} USDG: send at least ${usdg(fund - held)} USDG to the vault ${vault} on Robinhood Chain; waiting up to ${fundSeconds} s`);
      const deadline = Date.now() + fundSeconds * 1000;
      while (held < fund && Date.now() < deadline) {
        await sleep(15_000);
        held = await balance(vault);
      }
    }
    check(held >= fund, "the vault holds the run's USDG", { vault, holds: usdg(held), needs: usdg(fund) });

    // 2. The wallet, topped up from the vault when it needs it.
    const setup = await call(client, "payment_wallet_setup", { amount: needTopUp ? topUp : "0" });
    check(setup.ok && typeof setup.json.address === "string", "payment_wallet_setup answers the wallet", setup.ok ? setup.json : setup.text);
    const wallet = getAddress(setup.json.address as string);
    const w0 = await balance(wallet);
    check(parseUnits(String(setup.json.available ?? "0"), 6) >= parseUnits(maxPrice, 6) && w0 >= parseUnits(maxPrice, 6), "the wallet has maxPrice free, on chain", { wallet, holds: usdg(w0), available: setup.json.available, toppedUp: setup.json.toppedUp ?? null });

    // 3. The paid call.
    const paid = await call(client, "pay", { url: target, maxPrice });
    check(paid.ok && paid.json.status === 200 && typeof paid.json.paid === "string", "pay: answered 200, paid from the wallet", paid.ok ? { status: paid.json.status, paid: paid.json.paid, wallet: paid.json.wallet, note: paid.json.note, body: String(paid.json.body).slice(0, 300) } : paid.text);
    console.log(`BODY ${String(paid.json.body).slice(0, 400)}`);
    const price = parseUnits(paid.json.paid as string, 6);
    check(price > 0n && price <= parseUnits(maxPrice, 6), "pay: the price is within maxPrice", { paid: paid.json.paid, maxPrice });
    const status = await call(client, "payment_wallet_status");
    const last = (status.json.recent as { payTo: Address; amount: string; transaction: string | null; status: number }[] | undefined)?.at(-1);
    check(status.ok && last !== undefined && last.status === 200 && typeof last.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(last.transaction), "payment_wallet_status records the payment and its settlement", last ?? status.text);
    const receipt = await chain.waitForTransactionReceipt({ hash: last!.transaction as Hex, timeout: 120_000 });
    const moved = parseEventLogs({ abi: usdgAbi, eventName: "Transfer", logs: receipt.logs }).filter((l) => getAddress(l.address) === USDG && getAddress(l.args.from) === wallet);
    check(
      receipt.status === "success" && moved.length === 1 && getAddress(moved[0]!.args.to) === getAddress(last!.payTo) && moved[0]!.args.value === price,
      "the settlement landed: the price moved from the wallet to the seller's payTo",
      { tx: last!.transaction, block: receipt.blockNumber, moved: moved.map((l) => ({ to: l.args.to, value: usdg(l.args.value) })) },
    );

    // 4. What is left, back to the vault.
    if (withdraw) {
      const v0 = await balance(vault);
      const back = await call(client, "payment_wallet_withdraw");
      check(back.ok && back.json.status === "sent", "payment_wallet_withdraw: sent", back.ok ? back.json : back.text);
      check((await balance(wallet)) === 0n && (await balance(vault)) > v0, "the wallet's balance is back in the vault", { vault: usdg(await balance(vault)) });
    } else {
      console.log(`NOTE the wallet keeps ${usdg(await balance(wallet))} USDG (OSTRA_CHECK_WITHDRAW=on sends it back once the relayer serves the withdrawal)`);
    }
    console.log(`LEFT vault ${vault} ${usdg(await balance(vault))} USDG, wallet ${wallet} ${usdg(await balance(wallet))} USDG`);
    console.log("AUTONOMO_CHECK_PASSED");
  } catch (err) {
    console.log(redact(`server log: ${stderr.slice(-3_000)}`, url));
    throw err;
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(redact(`the check failed: ${err instanceof Error ? err.message : String(err)}`, rpcSecret));
  process.exit(1);
});
