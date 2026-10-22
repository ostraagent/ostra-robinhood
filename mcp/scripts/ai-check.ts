// Ostra AI through the MCP server, as an agent runs it, against the configured chain and Ostra AI: the server
// (src/server.ts, or an installed npm package's bundle named by OSTRA_CHECK_MCP) is spawned over stdio on
// OSTRA_CHECK_HOME, an agent whose vault holds USDG. Every payment is real: a channel of the vault to Ostra AI's vault.
//
//   1. The server lists ostra_ai, ostra_ai_job and ostra_ai_credit; open_vault finds the vault; it holds the run's
//      USDG (else the script prints `FUND <vault> <base units> <USDG>` and waits for it).
//   2. A text task (cheapest, at most TEXT_MAX_PRICE): answered 200, paid from a channel of the vault opened with
//      CHANNEL_DEPOSIT, the answer naming the model and what it charged, cost and credited; no upstream is named.
//   3. The same task again: paid from the same channel, the vault's credit paying part of it.
//   4. An image task (cheapest, at most IMAGE_MAX_PRICE): the image saved as a file in OSTRA_CHECK_HOME/ai, a PNG,
//      JPEG or WebP.
//   5. A video task (cheapest, VIDEO_DURATION s at VIDEO_RESOLUTION, at most VIDEO_MAX_PRICE; OSTRA_CHECK_VIDEO=off
//      skips it): a job, followed with ostra_ai_job until it completes; the video saved as a file (an MP4).
//   6. ostra_ai_credit: the vault's credit is what the tasks did not cost, less what the second task used.
//   7. The channel: Ostra AI's server closes it once idle (5 minutes) through the Ostra keeper, which refunds its
//      unused deposit to the vault; the script waits up to CLOSE_WAIT_MS for that and checks the vault got it.
//
// Environment: OSTRA_CHECK_HOME (required, kept), OSTRA_CHECK_MCP, OSTRA_CHECK_VIDEO, OSTRA_CHECK_FUND_SECONDS (default
// 3600), OSTRA_CHECK_DEPLOYMENT (the record the script reads the channel's contract from), and what the server reads (OSTRA_DEPLOYMENT, OSTRA_SWAP_DEPLOYMENT, OSTRA_RPC_URL or OSTRA_RPC_URL_FILE,
// OSTRA_RELAYER_URL, OSTRA_AI_URL, ...), passed on as they are. The RPC URL is never printed.

import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, formatUnits, getAddress, http, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { readChannel, redact, robinhoodChain } from "@ostraagent/sdk";
import { ROBINHOOD_PUBLIC_RPC, USDG, erc20Abi } from "@ostraagent/swap";

const TEXT_MAX_PRICE = "0.03";
const IMAGE_MAX_PRICE = "0.02";
const VIDEO_MAX_PRICE = "0.3";
const VIDEO_DURATION = 5;
const VIDEO_RESOLUTION = "480p";
const CHANNEL_DEPOSIT = "1";
/** What the run may spend at most, and the deposit it locks for a while (USDG base units). */
const FUND = 1_000_000n + 2n * 30_000n + 20_000n + 300_000n + 200_000n;
const TEXT_PROMPT = "In one short sentence: why does the sky look blue?";
const IMAGE_PROMPT = "A small red apple on a white table, simple flat illustration";
const VIDEO_PROMPT = "A red fox running through fresh snow in a pine forest, cinematic, natural light";
const TOOL_TIMEOUT_MS = 600_000;
const VIDEO_WAIT_MS = 20 * 60_000;
const CLOSE_WAIT_MS = 15 * 60_000;
/** Ostra AI's answers never name where a model runs. */
const UPSTREAM = /openrouter|open router/i;
/** A task whose upstream failed (424, all it was charged credited) is sent again, up to this many times. */
const UPSTREAM_TRIES = 3;
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

type Paid = { charged: string; from_voucher?: string; from_credit: string; cost: string | null; credited: string | null; credit: string; channel?: string };

/** ostra_ai, sent again while Ostra AI answers 424 (the upstream failed; what it was charged is the vault's credit). */
async function aiTask(client: Client, args: Record<string, unknown>): Promise<Answer> {
  for (let attempt = 1; ; attempt++) {
    const r = await call(client, "ostra_ai", args);
    if (!(r.ok && r.json.status === 424) || attempt >= UPSTREAM_TRIES) return r;
    console.log(`NOTE ${String(args.task)} task: the upstream failed (attempt ${attempt}); sent again in 20 s`);
    await sleep(20_000);
  }
}

async function main(): Promise<void> {
  const home = required("OSTRA_CHECK_HOME");
  const entry = process.env.OSTRA_CHECK_MCP || fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const video = (process.env.OSTRA_CHECK_VIDEO || "on") === "on";
  const fundSeconds = Number(process.env.OSTRA_CHECK_FUND_SECONDS || "3600");
  const url = await rpcUrl();
  rpcSecret = url;
  const chain = createPublicClient({ chain: robinhoodChain, transport: http(url, { retryCount: 5, retryDelay: 2_000, timeout: 60_000 }) }) as PublicClient;
  const balance = (who: Address) => chain.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
  // The record the script reads the channel's contract from: OSTRA_CHECK_DEPLOYMENT (not passed to the server, which then
  // runs on what an installed package carries, its service URLs among it), else OSTRA_DEPLOYMENT.
  const recordPath = process.env.OSTRA_CHECK_DEPLOYMENT || process.env.OSTRA_DEPLOYMENT;
  if (recordPath === undefined || recordPath === "") throw new Error("set OSTRA_CHECK_DEPLOYMENT (or OSTRA_DEPLOYMENT) to Ostra's deployment record");
  const deployment = JSON.parse(await readFile(recordPath, "utf8")) as { batchSettlement: Address };

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !name.startsWith("OSTRA_CHECK_")) env[name] = value;
  env.OSTRA_HOME = home;
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-20_000);
  });
  const client = new Client({ name: "ostra-ai-check", version: "0.0.0" });
  await client.connect(transport);
  try {
    // 1. The tools, the vault, its USDG.
    const tools = (await client.listTools()).tools.map((t) => t.name);
    check(["ostra_ai", "ostra_ai_job", "ostra_ai_credit"].every((n) => tools.includes(n)), "the server lists the Ostra AI tools", `${tools.length} tools`);
    const opened = await call(client, "open_vault");
    check(opened.ok && typeof opened.json.vault === "string", "open_vault finds the vault", opened.ok ? { vault: opened.json.vault } : opened.text);
    const vault = getAddress(opened.json.vault as string);
    let held = await balance(vault);
    if (held < FUND) {
      console.log(`FUND ${vault} ${FUND - held} ${usdg(FUND - held)} USDG: send at least ${usdg(FUND - held)} USDG to the vault ${vault} on Robinhood Chain; waiting up to ${fundSeconds} s`);
      const deadline = Date.now() + fundSeconds * 1000;
      while (held < FUND && Date.now() < deadline) {
        await sleep(15_000);
        held = await balance(vault);
      }
    }
    check(held >= FUND, "the vault holds the run's USDG", { vault, holds: usdg(held), needs: usdg(FUND) });
    const credit0 = await call(client, "ostra_ai_credit");
    check(credit0.ok && getAddress(credit0.json.payer as string) === vault, "ostra_ai_credit names the vault", credit0.json);

    // 2. A text task: a channel opened, the task paid from it.
    const textRequest = { messages: [{ role: "user", content: TEXT_PROMPT }], max_tokens: 600, quality: "cheapest" };
    const one = await aiTask(client, { task: "text", request: textRequest, maxPrice: TEXT_MAX_PRICE, deposit: CHANNEL_DEPOSIT });
    check(one.ok && one.json.status === 200 && !UPSTREAM.test(one.text), "text task 1: answered 200 through the server, no upstream named", one.ok ? { status: one.json.status, paid: one.json.paid, note: one.json.note } : one.text);
    const a1 = one.json.answer as { error?: string; model?: string; message?: { content?: string; reasoning?: string }; paid?: Paid };
    check(a1.error === undefined, "text task 1: the model's answer came whole (no error in the closing event)", a1.error === undefined ? {} : { error: a1.error, message: a1.message, paid: a1.paid });
    const said = [a1.message?.content, a1.message?.reasoning].filter((x) => typeof x === "string" && x.length > 0).join(" | ");
    check(said.length > 0 && typeof a1.model === "string", "text task 1: the model answered", { model: a1.model, answer: said.slice(0, 160) });
    const channel = one.json.channel as Hex;
    const voucher1 = BigInt(a1.paid?.from_voucher ?? "0");
    check(/^0x[0-9a-f]{64}$/.test(channel) && a1.paid?.channel === channel && voucher1 > 0n && voucher1 + BigInt(a1.paid.from_credit) === BigInt(a1.paid.charged), "text task 1: paid by a voucher of the vault's channel (and its credit, if it had any)", a1.paid);
    check(typeof one.json.paid === "string" && parseUnits(one.json.paid, 6) === voucher1, "text task 1: what the tool says it paid is what the voucher paid", { tool: one.json.paid, fromVoucher: a1.paid?.from_voucher });

    let lastCredit = BigInt(a1.paid?.credit ?? "0");

    // 3. Again: the same channel, the credit paying part (when task 1 left any).
    const two = await aiTask(client, { task: "text", request: textRequest, maxPrice: TEXT_MAX_PRICE });
    const a2 = two.json.answer as { error?: string; message?: unknown; paid?: Paid };
    check(two.ok && two.json.status === 200 && two.json.channel === channel && a2.error === undefined, "text task 2: answered whole, paid from the same channel", two.ok ? { paid: a2.paid, channelLeft: two.json.channelLeft } : two.text);
    if (lastCredit > 0n) check(BigInt(a2.paid?.from_credit ?? "0") > 0n, "text task 2: the vault's credit paid part of it", a2.paid);
    lastCredit = BigInt(a2.paid?.credit ?? "0");

    // 4. An image, saved as a file.
    const four = await aiTask(client, { task: "image", request: { prompt: IMAGE_PROMPT, quality: "cheapest" }, maxPrice: IMAGE_MAX_PRICE });
    const a4 = four.json.answer as { model?: string; images?: { media_type?: string; file?: string | null; bytes?: number }[]; paid?: Paid };
    check(four.ok && four.json.status === 200 && !UPSTREAM.test(four.text), "image task: answered 200, no upstream named", four.ok ? { model: a4.model, images: a4.images, paid: a4.paid } : four.text);
    const img = a4.images?.[0];
    const file = typeof img?.file === "string" ? await readFile(img.file) : null;
    const magic = file === null ? "" : file.subarray(0, 12).toString("latin1");
    check(file !== null && (magic.startsWith("\x89PNG") || magic.startsWith("\xff\xd8\xff") || (magic.startsWith("RIFF") && magic.slice(8, 12) === "WEBP")), "image task: the image saved as a file (PNG, JPEG or WebP)", { file: img?.file, bytes: file?.length });
    lastCredit = BigInt(a4.paid?.credit ?? "0");
    // The vault's USDG once its last paid task is sent: the channel's refund comes after it.
    let paidUntil = await balance(vault);

    // 5. A video job, followed to its end.
    if (video) {
      const five = await aiTask(client, { task: "video", request: { prompt: VIDEO_PROMPT, duration: VIDEO_DURATION, resolution: VIDEO_RESOLUTION, quality: "cheapest" }, maxPrice: VIDEO_MAX_PRICE });
      const a5 = five.json.answer as { job?: string; model?: string; paid?: Paid };
      check(five.ok && five.json.status === 200 && typeof a5.job === "string" && !UPSTREAM.test(five.text), "video task: a job, paid", five.ok ? { job: a5.job, model: a5.model, paid: a5.paid } : five.text);
      paidUntil = await balance(vault);
      const deadline = Date.now() + VIDEO_WAIT_MS;
      let last: Answer = { ok: false, text: "", json: {} };
      // Read until final and, when completed, saved: a failed read (or a download that did not finish) is tried again.
      let downloads = 0;
      while (Date.now() < deadline) {
        last = await call(client, "ostra_ai_job", { job: a5.job });
        if (!last.ok) console.log(`NOTE ostra_ai_job failed, asked again in 15 s: ${last.text.slice(0, 200)}`);
        else if (last.json.final === true && (last.json.status !== "completed" || typeof last.json.file === "string")) break;
        else if (last.json.final === true && ++downloads >= 3) break;
        else if (last.json.final === true) console.log(`NOTE the video was not saved (${String(last.json.note)}), asked again in 15 s`);
        await sleep(15_000);
      }
      check(last.ok && last.json.status === "completed" && typeof last.json.file === "string" && !UPSTREAM.test(last.text), "video task: the job completed, the video saved as a file", last.ok ? { status: last.json.status, file: last.json.file, bytes: last.json.bytes, paid: last.json.paid } : last.text);
      const mp4 = await readFile(last.json.file as string);
      check(mp4.subarray(4, 8).toString("ascii") === "ftyp", "video task: the file is an MP4", { bytes: mp4.length });
      lastCredit = BigInt((last.json.paid as Paid | undefined)?.credit ?? "0");
    }

    // 6. The credit.
    const credit1 = await call(client, "ostra_ai_credit");
    check(credit1.ok && typeof credit1.json.credit === "string" && parseUnits(credit1.json.credit, 6) === lastCredit, "ostra_ai_credit: the vault's credit is what the last task's answer said", { before: credit0.json.credit, after: credit1.json.credit, last: usdg(lastCredit) });

    // 7. The channel closed by Ostra AI once idle; its unused deposit back to the vault.
    const before = paidUntil;
    const deadline = Date.now() + CLOSE_WAIT_MS;
    let state = await readChannel(chain, deployment.batchSettlement, channel);
    while (state.balance > state.totalClaimed && Date.now() < deadline) {
      await sleep(30_000);
      state = await readChannel(chain, deployment.batchSettlement, channel);
    }
    const after = await balance(vault);
    check(state.balance <= state.totalClaimed && after > before, "the channel: closed by Ostra AI once idle, its unused deposit back to the vault", { claimed: usdg(state.totalClaimed), refundedToVault: usdg(after - before) });
    console.log(`LEFT vault ${vault} ${usdg(after)} USDG, credit ${String(credit1.json.credit)} USDG with Ostra AI; files in ${home}/ai`);
    console.log("ALL CHECKS PASSED");
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
