// Ostra Swap end to end through the MCP server and the Ostra relayer, as an agent runs it, against the configured
// chain: the server (src/server.ts, or an installed npm package's bundle named by OSTRA_CHECK_MCP) is spawned over
// stdio on OSTRA_CHECK_HOME, and the relayer sends every transaction: the vault operations paid from the vault's
// relayer channel, the private spends paid from their notes. Nothing is simulated: every step is a real transaction.
//
//   1. The server lists the Ostra Swap tools, runs with the relayer and proves (private_recover runs), and the agent
//      holds no notes yet; the relayer prices private spends in USDG and WETH for the pool the server uses (GET
//      /v1/private/price).
//   2. open_vault (created before payment, or found), and a quote of 1 USDG to WETH. The run's amounts follow from
//      the relayer's fees, the gas price and that quote (amounts()); the script prints
//      `FUND <vault> <base units> <USDG>` and waits until the vault holds that much USDG, sent by whoever funds the run;
//      once funded the amounts are worked out again at the prices then (a second FUND line if they need more).
//   3. ostra_swap 1 USDG to WETH (an escrow order paying the agent's WETH vault's address; a swap that answers pending
//      is followed through ostra_swap_orders, as an agent follows it), then all of that WETH
//      back to USDG (the WETH vault is created first, paid by the vault's relayer channel).
//   4. private_shield: the pool holds that much more USDG.
//   5. private_swap of USDG into a WETH note: the relayer's fee comes out of the note and the change stays a note; the
//      pool holds the amount and the fee less USDG and the swap's output more WETH.
//   6. private_unshield of the WETH note to the agent's WETH vault, less twice the fee quoted (a small WETH note stays),
//      and of 1 USDG to the agent's vault (the rest of that note stays); then the WETH vault's WETH back to USDG.
//   7. A new OSTRA_HOME holding the seed alone (master.key, fee-payer.key) finds the same private notes on first use
//      (private_balance) and with private_recover.
//   8. Each transaction: its status, gas used, the L1 part of it and its calldata size (a private spend carries its
//      proof); then what the run leaves in the vaults, the relayer channels and the notes (kept in OSTRA_CHECK_HOME).
// What each transaction moved is checked by its Transfer logs (exact, whatever else happens on chain and however far
// behind the script's RPC is); a balance it needs is read at the block the last transaction landed in.
//
// Environment:
//   OSTRA_CHECK_HOME          the agent's OSTRA_HOME (made 0700 when missing), new for each run (an agent with notes is
//                             refused). Keep it: it holds the agent's seed, and what the run leaves in its vaults and
//                             notes is spent with it
//   OSTRA_RELAYER_URL         the Ostra relayer (required)
//   OSTRA_CHECK_MCP           the server's entry (default ../src/server.ts)
//   OSTRA_CHECK_FUND_SECONDS  how long to wait for the funding (default 3600)
// and what the server reads (OSTRA_DEPLOYMENT, OSTRA_SWAP_DEPLOYMENT, OSTRA_RPC_URL or OSTRA_RPC_URL_FILE,
// OSTRA_LOGS_RPC_URL, OSTRA_KEEPER_URL, OSTRA_AGGREGATOR_URL), passed on as they are; OSTRA_PRIVATE_LOCAL_SPENDS is
// not passed on. The script reads the chain through the same RPC; its URL is never printed.

import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, formatUnits, getAddress, http, parseAbi, parseEventLogs, parseUnits, type Address, type Hash, type PublicClient, type TransactionReceipt } from "viem";
import { redact } from "@ostraagent/sdk";
import { ROBINHOOD_PUBLIC_RPC, USDG, WETH, erc20Abi } from "@ostraagent/swap";

/** One USDG in base units. */
const USDG_UNIT = 1_000_000n;
/** Amounts are rounded up to a cent. */
const CENT = 10_000n;
/** Gas of the run's relayed vault operations at their caps, with room: the vault's creation, the relayer channels' opens, the WETH vault's creation, three escrow swaps and the shield. */
const RELAY_GAS_RESERVE = 20_000_000n;
/** The private swap is at least this much USDG, and at least PRIVATE_SWAP_FEE_MULTIPLE times the WETH unshield's fee in USDG: its WETH note pays that fee. */
const MIN_PRIVATE_SWAP = 2n * USDG_UNIT;
const PRIVATE_SWAP_FEE_MULTIPLE = 4n;
/** Unshielded from the USDG note to the vault, and left in that note at least. */
const UNSHIELD_USDG = USDG_UNIT;
const KEEP_USDG = USDG_UNIT;
const TOOL_TIMEOUT_MS = 600_000;
const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

const toJson = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const roundUp = (x: bigint, step: bigint) => ((x + step - 1n) / step) * step;
const max = (a: bigint, b: bigint) => (a > b ? a : b);

let failures = 0;
function check(ok: boolean, what: string, detail: unknown = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === "" ? "" : ` (${typeof detail === "string" ? detail : toJson(detail)})`}`);
  if (!ok) throw new Error(`stopped at: ${what}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`set ${name}`);
  return value;
}

/** The RPC the server is given (OSTRA_RPC_URL, or OSTRA_RPC_URL_FILE, a 0600 file), else Robinhood Chain's public RPC. */
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

/** The MCP server on `home`, with the environment passed on (see the file comment). */
async function connect(entry: string, home: string): Promise<{ client: Client; stderr: () => string }> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith("OSTRA_CHECK_") || name === "OSTRA_PRIVATE_LOCAL_SPENDS") continue;
    env[name] = value;
  }
  env.OSTRA_HOME = home;
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-20_000);
  });
  const client = new Client({ name: "ostra-swap-check", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

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

/**
 * ostra_swap as an agent runs it from 0.1.12: a swap not done within OSTRA_SWAP_ANSWER_MS answers "pending" and goes
 * on in the server; ostra_swap_orders then tells how it ended (every 2 s here, for up to TOOL_TIMEOUT_MS). Answers
 * with the swap's own result either way.
 */
async function swap(client: Client, args: Record<string, unknown>): Promise<Answer> {
  const first = await call(client, "ostra_swap", args);
  if (!first.ok || first.json.status !== "pending") return first;
  const id = first.json.swap as string;
  for (const until = Date.now() + TOOL_TIMEOUT_MS; Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, 2_000));
    const now = await call(client, "ostra_swap_orders");
    if (!now.ok) return now;
    const mine = (now.json.pending as { swap: string; state: string; result?: Record<string, unknown>; error?: string }[] | undefined)?.find((x) => x.swap === id);
    if (mine === undefined) return { ok: false, text: `ostra_swap_orders does not list swap ${id}: ${now.text}`, json: {} };
    if (mine.state === "ended") return { ok: true, text: JSON.stringify(mine.result), json: mine.result ?? {} };
    if (mine.state === "failed") return { ok: false, text: `swap ${id} failed after answering pending: ${mine.error ?? ""}`, json: {} };
  }
  return { ok: false, text: `swap ${id} still running after ${TOOL_TIMEOUT_MS / 1_000} s`, json: {} };
}

type Price = { fee: bigint; pool: Address; gasPrice: bigint };

/** The relayer's fee for a private spend of `kind` in `token` now (GET /v1/private/price). */
async function price(relayer: string, token: Address, kind: "swap" | "unshield"): Promise<Price> {
  const res = await fetch(`${relayer}/v1/private/price?token=${token}&kind=${kind}`, { signal: AbortSignal.timeout(60_000) });
  const body = (await res.json()) as { fee?: string; pool?: string; gasPrice?: string; error?: string; message?: string };
  if (res.status !== 200 || body.fee === undefined || body.pool === undefined || body.gasPrice === undefined) throw new Error(`the relayer prices no ${kind} in ${token}: ${res.status} ${toJson(body)}`);
  return { fee: BigInt(body.fee), pool: getAddress(body.pool), gasPrice: BigInt(body.gasPrice) };
}

/**
 * The run's amounts in USDG base units: the private swap pays for the WETH note's unshield fee several times over;
 * the shield covers it, the USDG unshield, what stays in the note, and twice both USDG fees; the vault gets 1 USDG for
 * its own swap, the shield, and its relayer channel's deposit (1 USDG) plus twice RELAY_GAS_RESERVE at the gas price.
 */
export function amounts(p: { feeSwapUsdg: bigint; feeUnshieldUsdg: bigint; feeUnshieldWeth: bigint; wethPerUsdg: bigint; gasPrice: bigint }): { privateSwap: bigint; shield: bigint; fund: bigint } {
  if (p.wethPerUsdg <= 0n) throw new Error("the quote of 1 USDG in WETH is zero");
  const privateSwap = max(MIN_PRIVATE_SWAP, roundUp((PRIVATE_SWAP_FEE_MULTIPLE * p.feeUnshieldWeth * USDG_UNIT) / p.wethPerUsdg, CENT));
  const shield = roundUp(privateSwap + UNSHIELD_USDG + KEEP_USDG + 2n * (p.feeSwapUsdg + p.feeUnshieldUsdg), CENT);
  const relay = USDG_UNIT + roundUp((RELAY_GAS_RESERVE * p.gasPrice * 2n * USDG_UNIT) / p.wethPerUsdg, CENT);
  return { privateSwap, shield, fund: USDG_UNIT + shield + relay };
}

type Sent = { what: string; hash: Hash };

/** The RPC URLs the script and the server use (an API key may be in one): never printed. */
const secrets: string[] = [];
const hide = (text: string) => secrets.reduce((t, u) => (u === "" ? t : redact(t, u)), text);

/** What `who` got (positive) or gave (negative) of `token` in a transaction: its Transfer logs. */
function moved(receipt: TransactionReceipt, token: Address, who: Address): bigint {
  let net = 0n;
  for (const t of parseEventLogs({ abi: transferAbi, logs: receipt.logs, eventName: "Transfer" })) {
    if (getAddress(t.address) !== getAddress(token)) continue;
    if (getAddress(t.args.to) === who) net += t.args.value;
    if (getAddress(t.args.from) === who) net -= t.args.value;
  }
  return net;
}

/** Tokens of private_balance in one order, to compare two answers. */
const sorted = (tokens: unknown) => toJson([...((tokens as { token: string }[] | undefined) ?? [])].sort((a, b) => a.token.localeCompare(b.token)));

async function main(): Promise<void> {
  const home = required("OSTRA_CHECK_HOME");
  const relayer = required("OSTRA_RELAYER_URL").replace(/\/+$/, "");
  if (relayer === "off") throw new Error("OSTRA_RELAYER_URL must name the relayer: the run goes through it");
  const entry = process.env.OSTRA_CHECK_MCP || fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const fundSeconds = Number(process.env.OSTRA_CHECK_FUND_SECONDS || "3600");
  const url = await rpcUrl();
  secrets.push(url, process.env.OSTRA_LOGS_RPC_URL ?? "");
  const chain = createPublicClient({ transport: http(url, { retryCount: 5, retryDelay: 2_000, timeout: 60_000 }) }) as PublicClient;
  /** A balance at a block (the block a transaction landed in: an RPC behind the server's would read an older one at "latest"). */
  const balanceAt = (token: Address, who: Address, blockNumber?: bigint) =>
    chain.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who], ...(blockNumber === undefined ? {} : { blockNumber }) }) as Promise<bigint>;
  const landed = (hash: unknown) => chain.waitForTransactionReceipt({ hash: hash as Hash, timeout: 300_000 });
  const sent: Sent[] = [];
  const usdg = (x: bigint) => formatUnits(x, 6);
  const weth = (x: bigint) => formatUnits(x, 18);
  const prices = async () => {
    const [swapUsdg, unshieldUsdg, unshieldWeth] = await Promise.all([price(relayer, USDG, "swap"), price(relayer, USDG, "unshield"), price(relayer, WETH, "unshield")]);
    return { swapUsdg, unshieldUsdg, unshieldWeth };
  };

  await mkdir(home, { recursive: true, mode: 0o700 });
  const mode = (await stat(home)).mode & 0o777;
  if (mode !== 0o700) throw new Error(`${home} must have mode 0700 (it has ${mode.toString(8)})`);

  let { client, stderr } = await connect(entry, home);
  try {
    // 1. The tools, the relayer, the prover, its prices.
    const tools = (await client.listTools()).tools.map((t) => t.name);
    check(["open_vault", "ostra_swap_quote", "ostra_swap", "private_shield", "private_balance", "private_swap", "private_unshield", "private_recover"].every((n) => tools.includes(n)), "the server lists the Ostra Swap tools", `${tools.length} tools`);
    const status = await call(client, "balance");
    check(status.ok && status.json.relayer === true, "the server sends through the Ostra relayer", status.ok ? "" : status.text);
    // private_recover needs the prover (private_balance does not): checked before anything is funded.
    const recovered0 = await call(client, "private_recover");
    check(recovered0.ok && typeof recovered0.json.pool === "string", "the server proves (private_recover runs)", recovered0.ok ? { pool: recovered0.json.pool, tokens: recovered0.json.tokens } : recovered0.text);
    // The checks below size every spend from fresh notes: a home with notes left by an earlier run is not used again.
    check(Array.isArray(recovered0.json.tokens) && (recovered0.json.tokens as unknown[]).length === 0, "the agent holds no private notes yet (a new OSTRA_CHECK_HOME for each run)", recovered0.json.tokens);
    const pool = getAddress(recovered0.json.pool as string);
    const p0 = await prices();
    check(p0.swapUsdg.pool === pool && p0.unshieldUsdg.pool === pool && p0.unshieldWeth.pool === pool, "the relayer relays private spends of the server's pool", { pool, feeSwapUsdg: usdg(p0.swapUsdg.fee), feeUnshieldUsdg: usdg(p0.unshieldUsdg.fee), feeUnshieldWeth: weth(p0.unshieldWeth.fee), gasPriceWei: p0.swapUsdg.gasPrice });

    // 2. The vault, the quote, the amounts, the funding; the amounts again once funded (prices move while it waits).
    const opened = await call(client, "open_vault");
    check(opened.ok && typeof opened.json.vault === "string", "open_vault through the relayer", opened.ok ? { vault: opened.json.vault, created: opened.json.created } : opened.text);
    const vault = getAddress(opened.json.vault as string);
    const planNow = async (p: Awaited<ReturnType<typeof prices>>) => {
      const quote = await call(client, "ostra_swap_quote", { tokenIn: "USDG", tokenOut: "ETH", amount: "1" });
      check(quote.ok && Number(quote.json.expectedOut) > 0 && getAddress(quote.json.from as string) === vault, "a quote of 1 USDG to WETH, nothing signed", quote.ok ? { expectedOut: quote.json.expectedOut, minOut: quote.json.minOut, fee: quote.json.fee } : quote.text);
      const plan = amounts({ feeSwapUsdg: p.swapUsdg.fee, feeUnshieldUsdg: p.unshieldUsdg.fee, feeUnshieldWeth: p.unshieldWeth.fee, wethPerUsdg: parseUnits(quote.json.expectedOut as string, 18), gasPrice: await chain.getGasPrice() });
      console.log(`PLAN private swap ${usdg(plan.privateSwap)} USDG, shield ${usdg(plan.shield)} USDG, vault funding ${usdg(plan.fund)} USDG`);
      return { plan, wethVault: getAddress(quote.json.to as string) };
    };
    let { plan, wethVault } = await planNow(p0);
    const waitFunds = async (): Promise<bigint> => {
      let held = await balanceAt(USDG, vault);
      if (held >= plan.fund) return held;
      console.log(`FUND ${vault} ${plan.fund} ${usdg(plan.fund)} USDG: send at least ${usdg(plan.fund - held)} USDG to the vault ${vault} on Robinhood Chain; waiting up to ${fundSeconds} s`);
      const deadline = Date.now() + fundSeconds * 1000;
      while (held < plan.fund && Date.now() < deadline) {
        await sleep(10_000);
        held = await balanceAt(USDG, vault);
      }
      return held;
    };
    let held = await waitFunds();
    check(held >= plan.fund, "the vault holds the run's USDG", { vault, holds: usdg(held), needs: usdg(plan.fund) });
    ({ plan, wethVault } = await planNow(await prices()));
    held = await waitFunds();
    check(held >= plan.fund, "the vault holds the run's USDG at the prices now", { vault, holds: usdg(held), needs: usdg(plan.fund) });

    // 3. Vault to vault: 1 USDG to WETH and all of it back. Amounts are checked by the Transfer logs of each transaction.
    const toWeth = await swap(client, { tokenIn: "USDG", tokenOut: "ETH", amount: "1" });
    check(toWeth.ok && toWeth.json.status === "sent" && toWeth.json.swapped === true && getAddress(toWeth.json.to as string) === wethVault, "ostra_swap 1 USDG to the WETH vault (escrow order, relayed)", toWeth.ok ? { amountOut: toWeth.json.amountOut, minOut: toWeth.json.minOut, txHash: toWeth.json.txHash } : toWeth.text);
    sent.push({ what: "escrow swap USDG to WETH", hash: toWeth.json.txHash as Hash });
    const r1 = await landed(toWeth.json.txHash);
    check(moved(r1, USDG, vault) === -USDG_UNIT && moved(r1, WETH, wethVault) === parseUnits(toWeth.json.amountOut as string, 18), "the vault paid 1 USDG and the WETH vault got the output", { weth: toWeth.json.amountOut });
    const wethHeld = await balanceAt(WETH, wethVault, r1.blockNumber);
    const back = await swap(client, { tokenIn: "WETH", tokenOut: "USDG", amount: weth(wethHeld) });
    check(back.ok && back.json.status === "sent" && back.json.swapped === true, "ostra_swap all of the WETH vault back to USDG (its spend paid by the vault's channel)", back.ok ? { amountIn: back.json.amountIn, amountOut: back.json.amountOut, txHash: back.json.txHash } : back.text);
    sent.push({ what: "escrow swap WETH to USDG", hash: back.json.txHash as Hash });
    const r2 = await landed(back.json.txHash);
    check(moved(r2, WETH, wethVault) === -wethHeld && moved(r2, USDG, vault) === parseUnits(back.json.amountOut as string, 6) && (await balanceAt(WETH, wethVault, r2.blockNumber)) === 0n, "the WETH vault paid all of it and the vault got the USDG", { usdg: back.json.amountOut });

    // 4. Shield.
    const shielded = await call(client, "private_shield", { token: "USDG", amount: usdg(plan.shield) });
    check(shielded.ok && shielded.json.status === "sent" && shielded.json.amount === usdg(plan.shield), `private_shield ${usdg(plan.shield)} USDG (relayed)`, shielded.ok ? { txHash: shielded.json.txHash } : shielded.text);
    sent.push({ what: "shield USDG", hash: shielded.json.txHash as Hash });
    const r3 = await landed(shielded.json.txHash);
    check(moved(r3, USDG, pool) === plan.shield && moved(r3, USDG, vault) === -plan.shield, "the pool got the shield from the vault");

    // 5. Private swap USDG to a WETH note.
    const pswap = await call(client, "private_swap", { tokenIn: "USDG", tokenOut: "ETH", amount: usdg(plan.privateSwap) });
    check(pswap.ok && pswap.json.status === "sent" && Number(pswap.json.fee) > 0 && Number(pswap.json.amountOut) > 0, `private_swap ${usdg(plan.privateSwap)} USDG to a WETH note (relayed, its fee from the note)`, pswap.ok ? { fee: pswap.json.fee, amountOut: pswap.json.amountOut, change: pswap.json.change, txHash: pswap.json.txHash } : pswap.text);
    sent.push({ what: "private swap USDG to WETH", hash: pswap.json.txHash as Hash });
    const r4 = await landed(pswap.json.txHash);
    check(
      moved(r4, USDG, pool) === -(plan.privateSwap + parseUnits(pswap.json.fee as string, 6)) && moved(r4, WETH, pool) === parseUnits(pswap.json.amountOut as string, 18),
      "the pool paid the amount and the fee in USDG and holds the output in WETH",
    );
    const b2 = await call(client, "private_balance");
    const wethNote = (b2.json.tokens as { token: string; amount: string; largestNote: string }[] | undefined)?.find((t) => getAddress(t.token) === getAddress(WETH));
    check(b2.ok && wethNote !== undefined && wethNote.largestNote === pswap.json.amountOut, "private_balance shows the WETH note", b2.ok ? b2.json.tokens : b2.text);

    // 6. Unshield WETH to the WETH vault and USDG to the vault, then the WETH vault's WETH back to USDG.
    const feeWeth = (await price(relayer, WETH, "unshield")).fee;
    const wethOut = parseUnits(wethNote!.largestNote, 18) - 2n * feeWeth;
    check(wethOut > 0n, "the WETH note pays out more than twice its unshield fee", { note: wethNote!.largestNote, fee: weth(feeWeth) });
    const outWeth = await call(client, "private_unshield", { token: "ETH", amount: weth(wethOut) });
    check(outWeth.ok && outWeth.json.status === "sent" && Number(outWeth.json.fee) > 0 && getAddress(outWeth.json.recipient as string) === wethVault, `private_unshield ${weth(wethOut)} WETH to the WETH vault (relayed)`, outWeth.ok ? { fee: outWeth.json.fee, change: outWeth.json.change, txHash: outWeth.json.txHash } : outWeth.text);
    sent.push({ what: "unshield WETH", hash: outWeth.json.txHash as Hash });
    const r5 = await landed(outWeth.json.txHash);
    check(moved(r5, WETH, wethVault) === wethOut && moved(r5, WETH, pool) === -(wethOut + parseUnits(outWeth.json.fee as string, 18)), "the WETH vault got it and the pool paid it and the fee");
    const outUsdg = await call(client, "private_unshield", { token: "USDG", amount: usdg(UNSHIELD_USDG) });
    check(outUsdg.ok && outUsdg.json.status === "sent" && Number(outUsdg.json.fee) > 0 && getAddress(outUsdg.json.recipient as string) === vault, `private_unshield ${usdg(UNSHIELD_USDG)} USDG to the vault (relayed)`, outUsdg.ok ? { fee: outUsdg.json.fee, change: outUsdg.json.change, txHash: outUsdg.json.txHash } : outUsdg.text);
    sent.push({ what: "unshield USDG", hash: outUsdg.json.txHash as Hash });
    const r6 = await landed(outUsdg.json.txHash);
    check(parseUnits(outUsdg.json.change as string, 6) >= KEEP_USDG, "the USDG note keeps its change", { change: outUsdg.json.change });
    check(moved(r6, USDG, vault) === UNSHIELD_USDG && moved(r6, USDG, pool) === -(UNSHIELD_USDG + parseUnits(outUsdg.json.fee as string, 6)), "the vault got it and the pool paid it and the fee");
    const wethLeft = await balanceAt(WETH, wethVault, r6.blockNumber);
    const sweep = await swap(client, { tokenIn: "WETH", tokenOut: "USDG", amount: weth(wethLeft) });
    check(sweep.ok && sweep.json.status === "sent" && sweep.json.swapped === true, "ostra_swap the unshielded WETH back to USDG", sweep.ok && sweep.json.status === "sent" ? { amountIn: sweep.json.amountIn, amountOut: sweep.json.amountOut, txHash: sweep.json.txHash } : sweep.text);
    sent.push({ what: "escrow swap WETH to USDG", hash: sweep.json.txHash as Hash });
    const r7 = await landed(sweep.json.txHash);
    check(moved(r7, WETH, wethVault) === -wethLeft && moved(r7, USDG, vault) === parseUnits(sweep.json.amountOut as string, 6), "the WETH vault paid all of it and the vault got the USDG");
  } catch (err) {
    console.log(`server log (end): ${hide(stderr().slice(-3_000))}`);
    throw err;
  } finally {
    await client.close();
  }

  // 7. The seed alone finds the same notes.
  ({ client, stderr } = await connect(entry, home));
  let notesHere: unknown;
  try {
    const b = await call(client, "private_balance");
    check(b.ok, "the notes kept on this machine", b.ok ? b.json.tokens : b.text);
    notesHere = b.json.tokens;
  } finally {
    await client.close();
  }
  const restored = await mkdtemp(join(tmpdir(), "ostra-swap-check-seed-"));
  try {
    for (const f of ["master.key", "fee-payer.key"]) await copyFile(join(home, f), join(restored, f));
    ({ client, stderr } = await connect(entry, restored));
    try {
      const found = await call(client, "private_balance");
      check(found.ok && sorted(found.json.tokens) === sorted(notesHere), "a new OSTRA_HOME with the seed alone finds the same notes on first use", found.ok ? found.json.tokens : found.text);
      const recovered = await call(client, "private_recover");
      check(recovered.ok && Number(recovered.json.shields) === 1 && sorted(recovered.json.tokens) === sorted(notesHere), "private_recover finds them from the seed and the pool's events", recovered.ok ? { shields: recovered.json.shields, followed: recovered.json.followed, notes: recovered.json.notes } : recovered.text);
    } finally {
      await client.close();
    }
  } finally {
    await rm(restored, { recursive: true, force: true });
  }

  // 8. The transactions, and what the run leaves.
  for (const s of sent) {
    const receipt = (await chain.request({ method: "eth_getTransactionReceipt", params: [s.hash] } as never)) as { status: string; gasUsed: string; gasUsedForL1?: string } | null;
    const tx = await chain.getTransaction({ hash: s.hash });
    check(receipt !== null && receipt.status === "0x1", `TX ${s.what}`, { hash: s.hash, gasUsed: receipt === null ? null : BigInt(receipt.gasUsed), l1Gas: receipt?.gasUsedForL1 === undefined ? null : BigInt(receipt.gasUsedForL1), calldataBytes: (tx.input.length - 2) / 2 });
  }
  ({ client, stderr } = await connect(entry, home));
  try {
    const left = await call(client, "balance");
    const notes = await call(client, "private_balance");
    console.log(`LEFT vault ${toJson(left.json.vault ?? {})}; relayer channels ${toJson(left.json.relayerChannels)}; private notes ${toJson(notes.json.tokens)}`);
  } finally {
    await client.close();
  }
}

main().then(
  () => {
    console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
    process.exitCode = failures === 0 ? 0 : 1;
  },
  (err: unknown) => {
    console.log(`STOPPED: ${hide(err instanceof Error ? err.message : String(err))}`);
    process.exitCode = 1;
  },
);
