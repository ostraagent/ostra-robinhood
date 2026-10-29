// Ostrapad end to end through the MCP server and the Ostra relayer, as two agents run it, against the configured
// chain: two servers (src/server.ts, or an installed npm package's bundle named by OSTRA_CHECK_MCP) are spawned over
// stdio, a provider on OSTRA_CHECK_HOME/provider and a client on OSTRA_CHECK_HOME/client, and the relayer sends every
// transaction, paid from each vault's relayer channel. Files go to IPFS through the Ostra uploader and are read back
// through the gateways core reads through (core ipfs.ts). Nothing is simulated: every step is a real transaction,
// and the job is a real job of the smallest budget (0.1 USDG) with the client as its evaluator (no pool, no
// evaluator fee). A wait for a file on IPFS stops at once when the first gateway refuses (ipfsRefusal).
//
//   1. Both servers list the Ostrapad and identity tools and none of the closed launchpad tools, and send through the
//      relayer; Ostra's Ostrapad index answers.
//   2. open_vault for both (created before payment); the vaults are printed (`VAULTS ...`). A quote of 1 USDG to WETH
//      and the gas price give the run's amounts (amounts()); the script prints `FUND <vault> <base units> <USDG>` for
//      the provider's vault and waits until it holds what the steps still to come need, sent by whoever funds the run
//      (worked out again once funded, a second FUND line if they need more). The provider's vault then sends the
//      client's share to the client's vault.
//   3. The provider: fund_creator_vault, then publish_profile, which publishes Ostra's profile without a number,
//      registers the agent with it (its ERC-8004 identity) and publishes it again as "Ostra Agent #<id>" with the
//      agent's Ostra card (the card read back from IPFS is the SDK's card of that id, byte for byte); then pad_publish
//      of one client-judged offer at 0.1 USDG. Its listing
//      reads back from the chain (pad_search by agent id: approved, paid into the provider's vault, limit 5 USDG) and
//      from Ostra's index (by provider, and pad_search by words). A profile is published again only once the one
//      before it reads back from IPFS (publish_profile and pad_publish keep what it holds, and refuse while it cannot
//      be read).
//   4. The client: pad_order. The order file is pinned, 0.1 USDG goes from the client's vault to the job's box and
//      from the box into OstraPad, and the job is Open with the client's vault as its evaluator.
//   5. The provider finds the job (pad_jobs), reads the order file from IPFS (its sha256 is the job's description),
//      accepts, and delivers (pad_deliver: the delivery pinned and its sha256 submitted).
//   6. The client reads the delivery from IPFS and approves it with a reason (pad_evaluate decide): OstraPad pays the
//      provider's vault 0.0995 USDG and the 0.5% fee half to its burn sink and half to its treasury; the job is
//      Completed; a client-judged job counts as fixedCompleted, not in the provider's record. The reason file reads
//      back from IPFS by its digest. Ostra's index shows the job Completed and paid.
//   7. The provider unpublishes (pad_publish unpublish): the registration file its identity points at on chain reads
//      back from IPFS with no Ostrapad entry, pad_search by agent id finds no listing, and Ostra's index drops it.
//   8. Each transaction of this run: its status, gas used, the L1 part of it and its calldata size; then what the run
//      leaves in the vaults and the relayer channels (kept in OSTRA_CHECK_HOME).
// What each transaction moved is checked by its Transfer logs.
//
// Carried on: run again on the same OSTRA_CHECK_HOME, the check goes on from where it stopped. What is on chain decides
// (the identity, the job's status); the transfers and the listing are recorded in OSTRA_CHECK_HOME/progress.json as
// they are sent. A step done by an earlier run is not sent again, and its checks are not repeated. A run that stops
// while the agent is listed and no job exists yet unpublishes it before it ends (and publishes it again when carried
// on).
//
// Environment:
//   OSTRA_CHECK_HOME          a directory (made 0700 when missing) for the two agents' homes and the run's progress.
//                             Keep it: it holds the agents' seeds, and what the run leaves in their vaults is spent
//                             with them
//   OSTRA_RELAYER_URL         the Ostra relayer (required)
//   OSTRA_CHECK_MCP           the server's entry (default ../src/server.ts)
//   OSTRA_CHECK_FUND_SECONDS  how long to wait for the funding (default 3600)
//   OSTRA_CHECK_WAIT_SECONDS  how long to wait for a file to read back from IPFS, or for the index (default 1800)
// and what the server reads (OSTRA_DEPLOYMENT, OSTRA_RPC_URL or OSTRA_RPC_URL_FILE, OSTRA_LOGS_RPC_URL,
// OSTRA_PAD_INDEXER_URL, ...), passed on as they are. The script reads the chain through the same RPC; its URL is
// never printed.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, formatUnits, getAddress, http, parseAbi, parseEventLogs, parseUnits, sha256, type Address, type Hash, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { ERC8004_IDENTITY_REGISTRY, OSTRAPAD, PAD_SERVICE_NAME, USDG, agentCardSvg, ostraPadAbi, padDigestFromCid, padProviderPay, redact, usdgAbi } from "@ostraagent/sdk";
import { AGENT_DESCRIPTION, AGENT_NAME, ipfsBytes, ipfsGateways } from "@ostraagent/core";
import { ROBINHOOD_PUBLIC_RPC } from "@ostraagent/swap";

/** One USDG in base units. */
const USDG_UNIT = 1_000_000n;
/** Amounts are rounded up to a cent. */
const CENT = 10_000n;
/** What each vault's relayer channel is opened with (core RELAYER_CHANNEL_DEPOSIT): its relayed requests are paid from it. */
const CHANNEL_DEPOSIT = USDG_UNIT;
/** The job's budget: the smallest OstraPad takes. */
const BUDGET = "0.1";
const BUDGET_UNITS = 100_000n;
/**
 * Gas of each vault's relayed transactions, with room. Measured on a fork of mainnet (core test/pad.fork.test.ts, 28
 * Oct 2026): a vault's creation 240k; a USDG transfer 229k; the ERC-8004 registration 368k; a profile or registration
 * file set 195k to 201k each; the listing's approval 214k; the order's approval and create 542k; accept 281k; the
 * delivery 261k; the decision 324k. Each vault also opens a relayer channel. The provider's vault: creation, channel,
 * two transfers (the client's share, the creator vault's), the listing approval, accept, delivery, about 1.7M. The
 * creator vault: creation, channel, registration, seven file sets (two profiles, the listing, the unpublish), about
 * 2.4M. The client's vault: creation, channel, the order's transfer and create, the decision, about 1.6M. A run
 * carried on sets a few files again. Robinhood Chain's L1 part is small (under 1% of the gas of the transactions read
 * on 28 Oct 2026).
 */
const PROVIDER_GAS = 4_000_000n;
const CREATOR_GAS = 6_000_000n;
const CLIENT_GAS = 4_000_000n;
const TOOL_TIMEOUT_MS = 600_000;
const POLL_MS = 20_000;
const DEFAULT_INDEXER = "https://app.ostraagent.xyz";
const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const identityAbi = parseAbi(["function tokenURI(uint256 agentId) view returns (string)", "function ownerOf(uint256 agentId) view returns (address)", "function balanceOf(address owner) view returns (uint256)"]);
const TERMINAL = ["Completed", "Rejected", "Expired", "Cancelled"];

const OFFER = {
  id: "check",
  title: "Ostrapad check",
  description: "Ostra's own end-to-end check of Ostrapad. Not for orders: it accepts only the check's own job.",
  input: "Any short text.",
  price: BUDGET,
  hours: 1,
  evaluator: "client",
} as const;
const INPUT = "Reply with the single word pong.";
const OUTPUT = "pong";
const REASON = "The delivery is the single word the order asked for.";

const toJson = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const roundUp = (x: bigint, step: bigint) => ((x + step - 1n) / step) * step;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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

/** A tool's answer: ok, its text, its JSON when that is an object (else {}), and the JSON value itself. */
type Answer = { ok: boolean; text: string; json: Record<string, unknown>; value: unknown };

/** The MCP server on `home`, with the environment passed on (see the file comment). */
async function connect(entry: string, home: string, name: string): Promise<{ client: Client; stderr: () => string }> {
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
  const client = new Client({ name: `ostra-pad-check-${name}`, version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]?.text ?? "";
  let value: unknown = undefined;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    value = undefined;
  }
  const json = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return { ok: r.isError !== true, text, json, value };
}

/**
 * The run's amounts in USDG base units, at `gasPrice` (wei) and `wethPerUsdg` (WETH base units for 1 USDG): each vault
 * gets its relayer channel's deposit and twice its gas (above) at the gas price, the client's vault also the budget;
 * the client's and the creator vault's shares go through the provider's vault.
 */
export function amounts(p: { gasPrice: bigint; wethPerUsdg: bigint }): { creator: bigint; client: bigint; provider: bigint; providerGas: bigint } {
  if (p.wethPerUsdg <= 0n) throw new Error("the quote of 1 USDG in WETH is zero");
  const gas = (g: bigint) => roundUp((g * p.gasPrice * 2n * USDG_UNIT) / p.wethPerUsdg, CENT);
  const providerGas = gas(PROVIDER_GAS);
  return { creator: CHANNEL_DEPOSIT + gas(CREATOR_GAS), client: CHANNEL_DEPOSIT + BUDGET_UNITS + gas(CLIENT_GAS), provider: CHANNEL_DEPOSIT + providerGas, providerGas };
}

/**
 * What the provider's vault must hold for the steps still to come: the client's share and the creator vault's until
 * each is sent, and its own channel and gas (the channel opens with its first relayed spend, the client's share: once
 * that is sent, only the gas).
 */
export function fundTarget(plan: ReturnType<typeof amounts>, done: Progress): bigint {
  const share = done.shareAmount === undefined ? plan.client : BigInt(done.shareAmount);
  const creator = done.creatorAmount === undefined ? plan.creator : BigInt(done.creatorAmount);
  return (done.shareSent ? 0n : share) + (done.creatorFunded ? 0n : creator) + (done.shareSent ? plan.providerGas : plan.provider);
}

type Sent = { what: string; hash: Hash };
/**
 * Recorded in OSTRA_CHECK_HOME/progress.json: the two shares' amounts before they are first sent (a run carried on sends
 * the same amount, which the vault matches with a spend it kept, instead of a second transfer), whether each landed,
 * the second profile, the listing (recorded before it is published, so a stop unpublishes it), and the index's
 * Completed job.
 */
type Progress = { shareAmount?: string; shareSent?: boolean; creatorAmount?: string; creatorFunded?: boolean; profileAgain?: boolean; listed?: boolean; indexedCompleted?: boolean };

/** The RPC URLs the script and the servers use (an API key may be in one): never printed. */
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

/**
 * An ipfs:// file read through the gateways the server reads through, in order (core ipfs.ts: the Ostra uploader,
 * Pinata's, then ipfs.io; OSTRA_IPFS_GATEWAYS), its bytes checked again here against the CID's sha256; null until it
 * reads.
 */
async function ipfsJson(uri: string): Promise<unknown> {
  const digest = padDigestFromCid(uri);
  if (digest === null) throw new Error(`${uri} is not a CIDv1 raw sha2-256`);
  const bytes = await ipfsBytes(uri, 65_536);
  if (bytes === null) return null;
  if (sha256(bytes) !== digest) throw new Error(`a gateway served ${uri} with other bytes`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`${uri} is not JSON`);
  }
}

/** Ostra's Ostrapad index: GET `path`, its JSON, or null when it does not answer 200. */
async function index(base: string, path: string): Promise<unknown> {
  try {
    const res = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30_000) });
    if (res.status !== 200) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * `probe` again every POLL_MS until it answers something other than null or undefined, or `seconds` pass (null then).
 * `refused`, when given, is asked after each empty answer: a reason from it (a refusal that waiting would not end)
 * stops the wait at once.
 */
async function until<T>(what: string, seconds: number, probe: () => Promise<T | null | undefined>, refused?: () => Promise<string | null>): Promise<T | null> {
  const deadline = Date.now() + seconds * 1000;
  let waited = false;
  for (;;) {
    const got = await probe();
    if (got !== null && got !== undefined) return got;
    const why = refused === undefined ? null : await refused();
    if (why !== null) throw new Error(`${what}: ${why}; waiting would not end`);
    if (Date.now() >= deadline) return null;
    if (!waited) console.log(`WAIT ${what} (up to ${seconds} s)`);
    waited = true;
    await sleep(POLL_MS);
  }
}

/**
 * Whether the first gateway the server reads through refuses reads of `uri` now: 429 or 403, or the Ostra uploader's
 * 503 upstream_refused (the public gateways refuse this server and it does not keep the file). A 404 is not a
 * refusal (a file just pinned may not have reached a gateway yet).
 */
async function ipfsRefusal(uri: string | null): Promise<string | null> {
  if (uri === null || !uri.startsWith("ipfs://")) return null;
  const gateway = ipfsGateways()[0] as string;
  try {
    const res = await fetch(`${gateway}${uri.slice("ipfs://".length)}`, { signal: AbortSignal.timeout(30_000), redirect: "error" });
    const after = res.headers.get("retry-after");
    await res.body?.cancel().catch(() => {});
    return res.status === 429 || res.status === 403 || res.status === 503 ? `${new URL(gateway).host} answers ${res.status} for ${uri}${after === null ? "" : ` (retry-after ${after} s)`}` : null;
  } catch {
    return null;
  }
}

type IndexAgent = { agentId: string; provider: Address | null; approved: boolean; offers: { id: string }[]; name: string | null; jobs?: { id: Hex; status: string; paid: string | null }[] };
type JobRow = { id: string; role: string; status: string };

async function main(): Promise<void> {
  const root = required("OSTRA_CHECK_HOME");
  const relayer = required("OSTRA_RELAYER_URL").replace(/\/+$/, "");
  if (relayer === "off") throw new Error("OSTRA_RELAYER_URL must name the relayer: the run goes through it");
  const entry = process.env.OSTRA_CHECK_MCP || fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const fundSeconds = Number(process.env.OSTRA_CHECK_FUND_SECONDS || "3600");
  const waitSeconds = Number(process.env.OSTRA_CHECK_WAIT_SECONDS || "1800");
  const indexer = (process.env.OSTRA_PAD_INDEXER_URL || DEFAULT_INDEXER).replace(/\/+$/, "");
  if (indexer === "off") throw new Error("OSTRA_PAD_INDEXER_URL must name the index: the run checks it");
  const url = await rpcUrl();
  secrets.push(url, process.env.OSTRA_LOGS_RPC_URL ?? "");
  const chain = createPublicClient({ transport: http(url, { retryCount: 5, retryDelay: 2_000, timeout: 60_000 }) }) as PublicClient;
  const balanceAt = (who: Address, blockNumber?: bigint) => chain.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who], ...(blockNumber === undefined ? {} : { blockNumber }) }) as Promise<bigint>;
  const landed = (hash: unknown) => chain.waitForTransactionReceipt({ hash: hash as Hash, timeout: 300_000 });
  const sent: Sent[] = [];
  const usdg = (x: bigint) => formatUnits(x, 6);

  await mkdir(root, { recursive: true, mode: 0o700 });
  const mode = (await stat(root)).mode & 0o777;
  if (mode !== 0o700) throw new Error(`${root} must have mode 0700 (it has ${mode.toString(8)})`);
  const homes = { provider: join(root, "provider"), client: join(root, "client") };
  for (const h of Object.values(homes)) await mkdir(h, { recursive: true, mode: 0o700 });
  console.log(`HOMES provider ${homes.provider} client ${homes.client}`);
  const progressFile = join(root, "progress.json");
  const progress: Progress = existsSync(progressFile) ? (JSON.parse(await readFile(progressFile, "utf8")) as Progress) : {};
  const record = async (change: Progress) => {
    Object.assign(progress, change);
    await writeFile(`${progressFile}.tmp`, JSON.stringify(progress, null, 2), { mode: 0o600 });
    await rename(`${progressFile}.tmp`, progressFile);
  };
  if (Object.keys(progress).length > 0) console.log(`CARRIED ON from ${toJson(progress)}`);

  const source = await readFile(new URL("../src/tools.ts", import.meta.url), "utf8");
  const closedList = /CLOSED_LAUNCHPAD_TOOLS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(source);
  if (closedList === null) throw new Error("src/tools.ts has no CLOSED_LAUNCHPAD_TOOLS list");
  const closed = [...(closedList[1] as string).matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);

  const p = await connect(entry, homes.provider, "provider");
  const c = await connect(entry, homes.client, "client");
  let jobId: Hex | null = null;
  /** The agent's current profile read back from IPFS (publish_profile and pad_publish refuse while it cannot be read). */
  const profileReadable = async (what: string): Promise<void> => {
    const now = await call(p.client, "profile");
    if (!now.ok) throw new Error(`profile failed: ${now.text}`);
    const uri = now.json.profileUri;
    if (typeof uri !== "string") return;
    const file = await until(`the current profile on IPFS, before ${what}`, waitSeconds, () => ipfsJson(uri), () => ipfsRefusal(uri));
    check(file !== null, `the current profile reads back from IPFS before ${what}`, { uri });
  };
  try {
    // 1. The tools, the relayer, the index.
    for (const [who, s] of [["provider", p], ["client", c]] as const) {
      const tools = (await s.client.listTools()).tools.map((t) => t.name);
      const needed = ["open_vault", "balance", "withdraw", "ostra_swap_quote", "fund_creator_vault", "publish_profile", "profile", "pad_publish", "pad_search", "pad_order", "pad_jobs", "pad_deliver", "pad_evaluate", "pad_earnings"];
      check(needed.every((n) => tools.includes(n)) && closed.length > 0 && closed.every((n) => !tools.includes(n)), `the ${who}'s server lists the Ostrapad and identity tools and none of the ${closed.length} closed launchpad tools`, `${tools.length} tools`);
      const status = await call(s.client, "balance");
      check(status.ok && status.json.relayer === true, `the ${who}'s server sends through the Ostra relayer`, status.ok ? "" : status.text);
    }
    const stats0 = (await index(indexer, "/api/v1/pad/stats")) as { scannedTo?: string } | null;
    check(stats0 !== null && typeof stats0.scannedTo === "string", "Ostra's Ostrapad index answers", stats0 ?? "no answer");
    const pad = OSTRAPAD;
    const [treasury, burnSink] = await Promise.all([
      chain.readContract({ address: pad, abi: ostraPadAbi, functionName: "TREASURY" }) as Promise<Address>,
      chain.readContract({ address: pad, abi: ostraPadAbi, functionName: "BURN_SINK" }) as Promise<Address>,
    ]);

    // 2. The vaults, the amounts, the funding, the client's share.
    const opened = { provider: await call(p.client, "open_vault"), client: await call(c.client, "open_vault") };
    for (const [who, o] of Object.entries(opened)) check(o.ok && typeof o.json.vault === "string", `open_vault for the ${who} through the relayer`, o.ok ? { vault: o.json.vault, created: o.json.created } : o.text);
    const vault = getAddress(opened.provider.json.vault as string);
    const clientVault = getAddress(opened.client.json.vault as string);
    const b0 = await call(p.client, "balance");
    const creatorVault = getAddress(((b0.json.creatorVault ?? {}) as { vault: string }).vault);
    check(new Set([vault, clientVault, creatorVault]).size === 3, "the provider's vault, its creator vault and the client's vault are three accounts");
    console.log(`VAULTS provider ${vault} creator ${creatorVault} client ${clientVault}`);
    const planNow = async () => {
      const quote = await call(p.client, "ostra_swap_quote", { tokenIn: "USDG", tokenOut: "ETH", amount: "1" });
      check(quote.ok && Number(quote.json.expectedOut) > 0, "a quote of 1 USDG to WETH, nothing signed", quote.ok ? { expectedOut: quote.json.expectedOut } : quote.text);
      const gasPrice = await chain.getGasPrice();
      const plan = amounts({ gasPrice, wethPerUsdg: parseUnits(quote.json.expectedOut as string, 18) });
      console.log(`PLAN gas price ${gasPrice} wei; the creator vault ${usdg(plan.creator)} USDG, the client's vault ${usdg(plan.client)} USDG, the provider's vault ${usdg(plan.provider)} USDG; the provider's vault needs ${usdg(fundTarget(plan, progress))} USDG now`);
      return plan;
    };
    // A share recorded and found in its vault landed in an earlier run that stopped before recording it.
    for (const [amount, to, flag] of [[progress.shareAmount, clientVault, "shareSent"], [progress.creatorAmount, creatorVault, "creatorFunded"]] as const) {
      if (amount !== undefined && progress[flag] !== true && (await balanceAt(to)) >= BigInt(amount)) {
        console.log(`${flag}: ${usdg(BigInt(amount))} USDG landed in an earlier run`);
        await record({ [flag]: true });
      }
    }
    // Once both shares landed, every vault's relayer channel holds its deposit, which pays far more than the steps left
    // cost: no funding is asked for again.
    let plan = progress.shareSent && progress.creatorFunded ? null : await planNow();
    const waitFunds = async (plan: ReturnType<typeof amounts>): Promise<bigint> => {
      const target = fundTarget(plan, progress);
      let held = await balanceAt(vault);
      if (held >= target) return held;
      console.log(`FUND ${vault} ${target} ${usdg(target)} USDG: send at least ${usdg(target - held)} USDG to the vault ${vault} on Robinhood Chain; waiting up to ${fundSeconds} s`);
      const deadline = Date.now() + fundSeconds * 1000;
      while (held < target && Date.now() < deadline) {
        await sleep(10_000);
        held = await balanceAt(vault);
      }
      return held;
    };
    if (plan !== null) {
      let held = await waitFunds(plan);
      check(held >= fundTarget(plan, progress), "the provider's vault holds what the run needs", { vault, holds: usdg(held), needs: usdg(fundTarget(plan, progress)) });
      plan = await planNow();
      held = await waitFunds(plan);
      check(held >= fundTarget(plan, progress), "the provider's vault holds what the run needs at the prices now", { vault, holds: usdg(held), needs: usdg(fundTarget(plan, progress)) });
      if (progress.shareAmount === undefined) await record({ shareAmount: plan.client.toString() });
      if (progress.creatorAmount === undefined) await record({ creatorAmount: plan.creator.toString() });
    }
    /**
     * Sends `amount` (recorded before its first send) from the provider's vault to `to`, once: a run carried on finds
     * it landed when `to` holds it (nothing spends from `to` before it is recorded as sent).
     */
    const share = async (to: Address, amount: bigint, what: string, tool: "withdraw" | "fund_creator_vault"): Promise<void> => {
      if ((await balanceAt(to)) >= amount) {
        console.log(`${what}: ${usdg(amount)} USDG landed in an earlier run`);
        return;
      }
      const r = await call(p.client, tool, tool === "withdraw" ? { destination: to, amount: usdg(amount) } : { amount: usdg(amount) });
      check(r.ok && r.json.status === "sent", `${tool === "withdraw" ? "withdraw" : "fund_creator_vault"} ${usdg(amount)} USDG: ${what}`, r.ok ? { status: r.json.status, txHash: r.json.txHash } : r.text);
      sent.push({ what, hash: r.json.txHash as Hash });
      const rc = await landed(r.json.txHash);
      check(moved(rc, USDG, vault) === -amount && moved(rc, USDG, to) === amount, `${what}: it landed from the provider's vault`);
    };
    if (!progress.shareSent) {
      await share(clientVault, BigInt(progress.shareAmount as string), "the client's share (the provider's relayer channel opens first)", "withdraw");
      await record({ shareSent: true });
    }

    // 3. The provider's identity.
    if (!progress.creatorFunded) {
      await share(creatorVault, BigInt(progress.creatorAmount as string), "the creator vault's funding (the creator vault created first)", "fund_creator_vault");
      await record({ creatorFunded: true });
    }
    const prof = await call(p.client, "profile");
    check(prof.ok && (prof.json.agentId === null || typeof prof.json.agentId === "string"), "the provider's identity as recorded", prof.ok ? { agentId: prof.json.agentId } : prof.text);
    let agentId = prof.json.agentId as string | null;
    if (agentId === null) {
      // An identity minted by a kept registration spend that landed later is on chain with no record here.
      const owned = await chain.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityAbi, functionName: "balanceOf", args: [creatorVault] });
      check(owned === 0n, "the creator vault holds no ERC-8004 identity yet (one with no record here comes from a registration spend that landed after its run stopped: the agent's records need its id before this goes on)", { identities: owned });
      await profileReadable("publishing the profile");
      const pub = await call(p.client, "publish_profile");
      const unnumbered = (pub.json.unnumbered ?? {}) as { uri?: string; profile?: { status?: string; txHash?: Hash } };
      const registration = (pub.json.registration ?? {}) as { status?: string; txHash?: Hash; agentId?: string };
      const profile = (pub.json.profile ?? {}) as { status?: string; txHash?: Hash };
      const agentUri = (pub.json.agentUri ?? {}) as { status?: string; txHash?: Hash };
      check(
        pub.ok && unnumbered.profile?.status === "sent" && registration.status === "sent" && typeof pub.json.agentId === "string" && profile.status === "sent" && agentUri.status === "sent",
        "publish_profile: Ostra's profile pinned and set, the agent registered in ERC-8004 with it, its numbered profile set and the identity pointed at it (the creator vault's relayer channel opens first)",
        pub.ok ? { agentId: pub.json.agentId, unnumbered: unnumbered.uri, uri: pub.json.uri, registration: registration.txHash } : pub.text,
      );
      sent.push(
        { what: "the profile without a number", hash: unnumbered.profile?.txHash as Hash },
        { what: "the ERC-8004 registration", hash: registration.txHash as Hash },
        { what: "the numbered profile", hash: profile.txHash as Hash },
        { what: "the identity's file", hash: agentUri.txHash as Hash },
      );
      agentId = pub.json.agentId as string;
      await record({ profileAgain: true });
    } else console.log(`registered in an earlier run: agent ${agentId}`);
    const id = agentId;
    const owner = getAddress(await chain.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [BigInt(id)] }));
    check(owner === creatorVault, "the identity's owner on chain is the creator vault", { agentId: id, owner });
    if (!progress.profileAgain) {
      // Registered by an earlier run that stopped before its numbered profile: publish_profile publishes that one.
      await profileReadable("publishing it again");
      const again = await call(p.client, "publish_profile");
      const profile = (again.json.profile ?? {}) as { status?: string; txHash?: Hash };
      const agentUri = (again.json.agentUri ?? {}) as { status?: string; txHash?: Hash };
      check(again.ok && again.json.registration === null && profile.status === "sent" && agentUri.status === "sent", "publish_profile again: the numbered profile set, and the identity pointed at it", again.ok ? { uri: again.json.uri } : again.text);
      await record({ profileAgain: true });
      sent.push({ what: "the numbered profile", hash: profile.txHash as Hash }, { what: "the identity's file", hash: agentUri.txHash as Hash });
    }
    // The registration file the identity points at on chain: Ostra's, with this agent's number and card.
    const tokenUri = (await chain.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityAbi, functionName: "tokenURI", args: [BigInt(id)] })) as string;
    const reg = (await until("the numbered registration file on IPFS", waitSeconds, () => ipfsJson(tokenUri), () => ipfsRefusal(tokenUri))) as {
      name?: string;
      description?: string;
      image?: string;
      registrations?: { agentId: number }[];
      services?: { name: string; endpoint: string }[];
    } | null;
    check(
      reg !== null && reg.name === `${AGENT_NAME} #${id}` && reg.description === AGENT_DESCRIPTION && reg.registrations?.[0]?.agentId === Number(id) && reg.services?.some((x) => x.name === "agentWallet" && x.endpoint === `eip155:4663:${creatorVault}`) === true,
      "the file the identity points at reads back from IPFS: Ostra's name with the agent's number, Ostra's description, the registration, the creator vault as agentWallet",
      reg === null ? "not read" : { name: reg.name, image: reg.image, registrations: reg.registrations },
    );
    const card = typeof reg?.image === "string" ? await until("the agent's card on IPFS", waitSeconds, () => ipfsBytes(reg.image as string, 65_536), () => ipfsRefusal(reg.image as string)) : null;
    check(card !== null && new TextDecoder().decode(card) === agentCardSvg(id), "the profile's image reads back from IPFS as the Ostra agent card of this agent, byte for byte", card === null ? "not read" : { image: reg?.image, bytes: card.length });

    // The job: the client's own, from an earlier run, or a new one.
    const clientJobs = async (): Promise<JobRow[]> => {
      const r = await call(c.client, "pad_jobs");
      if (!r.ok) throw new Error(`pad_jobs failed: ${r.text}`);
      return ((r.json.jobs ?? []) as JobRow[]).filter((j) => j.role === "client");
    };
    const earlier = await clientJobs();
    check(earlier.filter((j) => !TERMINAL.includes(j.status)).length <= 1 && earlier.filter((j) => j.status === "Completed").length <= 1, "the client has at most one job of the check", earlier);
    const open = earlier.find((j) => !TERMINAL.includes(j.status)) ?? null;
    const done = earlier.find((j) => j.status === "Completed") ?? null;
    if (open !== null || done !== null) {
      jobId = (open ?? done)!.id as Hex;
      console.log(`the client's job from an earlier run: ${jobId} (${(open ?? done)!.status})`);
    }

    // 3 (end). The listing, when the job is still to be ordered.
    if (jobId === null) {
      if (!progress.listed) {
        await profileReadable("listing");
        await record({ listed: true });
        const listed = await call(p.client, "pad_publish", { action: "publish", offers: [OFFER] });
        const listedProfile = (listed.json.profile ?? {}) as { status?: string; txHash?: Hash };
        const listedAgentUri = (listed.json.agentUri ?? {}) as { status?: string; txHash?: Hash };
        check(
          listed.ok && listed.json.listed === true && getAddress(listed.json.provider as string) === vault && listedProfile.status === "sent" && listedAgentUri.status === "sent",
          "pad_publish: the provider's vault approves the listing (once), and the file with the offer is set",
          listed.ok ? { uri: listed.json.uri, listingApproval: listed.json.listingApproval } : listed.text,
        );
        if (typeof listed.json.listingApproval === "string") sent.push({ what: "the listing's approval", hash: listed.json.listingApproval as Hash });
        sent.push({ what: "the profile with the listing", hash: listedProfile.txHash as Hash }, { what: "the identity's file with the listing", hash: listedAgentUri.txHash as Hash });
      }
      type Listing = { approved: boolean; owner: string; limit: string; listing: { provider: string; offers: { id: string; price: string; evaluator: string }[] } };
      const found = (await until("the listing read by agent id (pad_search)", waitSeconds, async () => {
        const r = await call(c.client, "pad_search", { agentId: id });
        if (!r.ok) throw new Error(`pad_search failed: ${r.text}`);
        return (r.value ?? null) as Listing | null;
      })) as Listing | null;
      check(
        found !== null && found.approved && getAddress(found.owner) === creatorVault && getAddress(found.listing.provider) === vault && found.limit === "5" && found.listing.offers.length === 1 && found.listing.offers[0]?.id === OFFER.id && found.listing.offers[0]?.price === BUDGET && found.listing.offers[0]?.evaluator === "client",
        "the client reads the listing from the chain: approved, paid into the provider's vault, limit 5 USDG",
        found === null ? "not read" : { approved: found.approved, provider: found.listing.provider, limit: found.limit, offers: found.listing.offers },
      );
      // Until the index has read the agent's details too (its approval, its file's name and offers), not only found the
      // agent: the index lists an agent first and reads its registration file from IPFS after.
      let seen: IndexAgent | null = null;
      const inIndex = (await until("the listing in Ostra's index", waitSeconds, async () => {
        const l = (await index(indexer, `/api/v1/pad/listings?provider=${vault}`)) as { total: number; agents: IndexAgent[] } | null;
        const a = l !== null && l.total === 1 && l.agents[0]?.agentId === id ? l.agents[0] : null;
        if (a !== null) seen = a;
        return a !== null && a.approved && a.name === `${AGENT_NAME} #${id}` && a.offers[0]?.id === OFFER.id ? a : null;
      })) as IndexAgent | null;
      const last = seen as IndexAgent | null;
      check(
        inIndex !== null,
        "Ostra's index lists the agent by its provider vault, its details read",
        inIndex !== null ? { agentId: inIndex.agentId, name: inIndex.name } : last === null ? "not listed" : { listedWithout: { approved: last.approved, name: last.name, offers: last.offers.map((o) => o.id) } },
      );
      const searched = await call(c.client, "pad_search", { q: OFFER.title });
      const hits = ((searched.json.agents ?? []) as IndexAgent[]).map((a) => a.agentId);
      check(searched.ok && hits.includes(id), "pad_search by words finds it through the index", searched.ok ? { total: searched.json.total, agentIds: hits } : searched.text);

      // 4. The order.
      const ordered = await call(c.client, "pad_order", { action: "order", agentId: id, offer: OFFER.id, input: INPUT });
      const steps = (ordered.json.steps ?? {}) as { funded?: Hash; created?: Hash };
      const job0 = (ordered.json.job ?? {}) as { status?: string; evaluator?: string; budget?: string };
      if (typeof ordered.json.jobId === "string") jobId = ordered.json.jobId as Hex;
      check(
        ordered.ok && typeof ordered.json.jobId === "string" && typeof steps.funded === "string" && typeof steps.created === "string" && job0.status === "Open" && same(job0.evaluator ?? "", clientVault) && job0.budget === BUDGET && ordered.json.funding === BUDGET,
        "pad_order: the order file pinned, the budget sent to the job's box, the job created with the client as its evaluator",
        ordered.ok ? { jobId: ordered.json.jobId, orderUri: ordered.json.orderUri, box: ordered.json.box } : ordered.text,
      );
      const box = getAddress(ordered.json.box as string);
      sent.push({ what: "the order's funding", hash: steps.funded as Hash }, { what: "the order's approval and create", hash: steps.created as Hash });
      const r2 = await landed(steps.funded);
      check(moved(r2, USDG, clientVault) === -BUDGET_UNITS && moved(r2, USDG, box) === BUDGET_UNITS, "the box got the budget from the client's vault");
      const r3 = await landed(steps.created);
      check(moved(r3, USDG, box) === -BUDGET_UNITS && moved(r3, USDG, pad) === BUDGET_UNITS, "OstraPad took the budget from the box");
    } else if (open !== null && open.status === "not created") {
      // An order stopped between its funding and its create: carried on with its job id.
      const again = await call(c.client, "pad_order", { action: "order", jobId });
      const job0 = (again.json.job ?? {}) as { status?: string };
      check(again.ok && job0.status === "Open", "pad_order carries on the order stopped before its create", again.ok ? { steps: again.json.steps } : again.text);
      const created = ((again.json.steps ?? {}) as { created?: Hash }).created;
      if (typeof created === "string") sent.push({ what: "the order's approval and create", hash: created });
    }
    const job = jobId as Hex;
    const statusOf = async (): Promise<{ status: string; read: Record<string, unknown> }> => {
      const r = await call(p.client, "pad_jobs", { action: "read", jobId: job });
      if (!r.ok) throw new Error(`pad_jobs read failed: ${r.text}`);
      return { status: ((r.json.job ?? {}) as { status?: string }).status ?? "unknown", read: r.json };
    };

    // 5. The provider finds the job, reads the order, accepts, delivers.
    let st = await statusOf();
    if (st.status === "Open") {
      const seen = await until("the job among the provider's (pad_jobs)", waitSeconds, async () => {
        const r = await call(p.client, "pad_jobs");
        if (!r.ok) throw new Error(`pad_jobs failed: ${r.text}`);
        return ((r.json.jobs ?? []) as JobRow[]).find((j) => same(j.id, job) && j.role === "provider") ?? null;
      });
      check(seen !== null && seen.status === "Open", "the provider finds the job on chain", seen ?? "not found");
      // The order's URI, from the client's record of it: what the provider's read needs from IPFS.
      const mine = await call(c.client, "pad_jobs", { action: "read", jobId: job });
      const orderUri = ((mine.json.record ?? {}) as { orderUri?: string }).orderUri ?? null;
      const read = (await until(
        "the order file on IPFS (pad_jobs read)",
        waitSeconds,
        async () => {
          const r = await statusOf();
          return r.read.order === null || r.read.order === undefined ? null : r.read;
        },
        () => ipfsRefusal(orderUri),
      )) as { order: { offer: string; input: string; client: string }; orderUri: string } | null;
      check(read !== null && read.order.offer === OFFER.id && read.order.input === INPUT && read.order.client.endsWith(clientVault), "the provider reads the order file from IPFS by the job's description", read === null ? "not read" : { orderUri: read.orderUri, input: read.order.input });
      const accepted = await call(p.client, "pad_jobs", { action: "accept", jobId: job });
      check(accepted.ok && typeof accepted.json.accepted === "string" && accepted.json.pool === false, "accept (pad_jobs)", accepted.ok ? { txHash: accepted.json.accepted } : accepted.text);
      sent.push({ what: "accept", hash: accepted.json.accepted as Hash });
      st = await statusOf();
    }
    let deliveryUri: string | null = null;
    if (st.status === "Accepted") {
      const delivered = await call(p.client, "pad_deliver", { jobId: job, output: OUTPUT });
      check(delivered.ok && typeof delivered.json.submitted === "string" && typeof delivered.json.deliveryUri === "string", "pad_deliver: the delivery pinned and submitted", delivered.ok ? { deliveryUri: delivered.json.deliveryUri, txHash: delivered.json.submitted } : delivered.text);
      sent.push({ what: "the delivery", hash: delivered.json.submitted as Hash });
      deliveryUri = delivered.json.deliveryUri as string;
      st = await statusOf();
    }

    // 6. The client reads the delivery and approves it.
    const pay = padProviderPay(BUDGET_UNITS);
    if (st.status === "Submitted") {
      let deliverable: string | null = deliveryUri;
      const got = (await until(
        "the delivery file on IPFS (the client's pad_jobs read)",
        waitSeconds,
        async () => {
          const r = await call(c.client, "pad_jobs", { action: "read", jobId: job });
          if (!r.ok) throw new Error(`pad_jobs read failed: ${r.text}`);
          deliverable = ((r.json.job ?? {}) as { deliverable?: string | null }).deliverable ?? deliverable;
          return r.json.delivery === null || r.json.delivery === undefined ? null : r.json;
        },
        () => ipfsRefusal(deliverable),
      )) as { job: { status: string }; delivery: { output: string; job: string }; deliveryUri: string } | null;
      check(
        got !== null && got.job.status === "Submitted" && got.delivery.output === OUTPUT && same(got.delivery.job, job) && (deliveryUri === null || got.deliveryUri === deliveryUri),
        "the client reads the delivery from IPFS by the job's deliverable",
        got === null ? "not read" : { status: got.job.status, output: got.delivery.output },
      );
      const p0 = await balanceAt(vault);
      const decided = await call(c.client, "pad_evaluate", { action: "decide", jobId: job, approve: true, reason: REASON });
      check(decided.ok && decided.json.approved === true && typeof decided.json.decided === "string" && typeof decided.json.reasonUri === "string", "pad_evaluate decide: approved, with its reason pinned", decided.ok ? { reasonUri: decided.json.reasonUri, txHash: decided.json.decided } : decided.text);
      sent.push({ what: "the decision", hash: decided.json.decided as Hash });
      const r4 = await landed(decided.json.decided);
      const fee = BUDGET_UNITS - pay;
      check(
        moved(r4, USDG, pad) === -BUDGET_UNITS && moved(r4, USDG, vault) === pay && moved(r4, USDG, getAddress(burnSink)) === fee / 2n && moved(r4, USDG, getAddress(treasury)) === fee - fee / 2n,
        `OstraPad paid the provider's vault ${usdg(pay)} USDG and the ${usdg(fee)} USDG fee half to its burn sink, half to its treasury`,
      );
      check((await balanceAt(vault, r4.blockNumber)) >= p0 + pay, "the provider's vault holds the pay");
      const reason = (await until("the decision's reason on IPFS", waitSeconds, () => ipfsJson(decided.json.reasonUri as string), () => ipfsRefusal(decided.json.reasonUri as string))) as { approve?: boolean; reason?: string; job?: string } | null;
      check(reason !== null && reason.approve === true && reason.reason === REASON && same(reason.job ?? "", job), "the reason file reads back from IPFS by its digest", reason ?? "not read");
      st = await statusOf();
    }
    check(st.status === "Completed", "the job is Completed", st.status);
    const earned = await call(p.client, "pad_earnings");
    const prov = (earned.json.provider ?? {}) as { fixedEvaluatorCompleted?: number; completed?: number };
    check(earned.ok && prov.fixedEvaluatorCompleted === 1 && prov.completed === 0, "a client-judged job counts as fixedCompleted, not in the provider's record", earned.ok ? prov : earned.text);
    if (!progress.indexedCompleted) {
      // The index's recent jobs (not the agent's page: that lists a provider's jobs only while it is listed).
      const indexed = (await until("the job Completed in Ostra's index", waitSeconds, async () => {
        const l = (await index(indexer, "/api/v1/pad/jobs?limit=100")) as { jobs: { id: string; status: string; paid: string | null }[] } | null;
        const j = l?.jobs.find((x) => same(x.id, job));
        return j !== undefined && j.status === "Completed" ? j : null;
      })) as { status: string; paid: string | null } | null;
      check(indexed !== null && indexed.paid === usdg(pay), "Ostra's index shows the job Completed and paid", indexed ?? "not shown");
      await record({ indexedCompleted: true });
    }

    // 7. Unpublished.
    if (progress.listed) {
      await profileReadable("unpublishing");
      const unlisted = await call(p.client, "pad_publish", { action: "unpublish" });
      const unlistedProfile = (unlisted.json.profile ?? {}) as { status?: string; txHash?: Hash };
      const unlistedAgentUri = (unlisted.json.agentUri ?? {}) as { status?: string; txHash?: Hash };
      check(unlisted.ok && unlisted.json.listed === false && unlistedProfile.status === "sent" && unlistedAgentUri.status === "sent", "pad_publish unpublish: the file without the listing is set", unlisted.ok ? { uri: unlisted.json.uri } : unlisted.text);
      await record({ listed: false });
      sent.push({ what: "the profile without the listing", hash: unlistedProfile.txHash as Hash }, { what: "the identity's file without the listing", hash: unlistedAgentUri.txHash as Hash });
      await landed(unlistedAgentUri.txHash);
    }
    const uriNow = await chain.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityAbi, functionName: "tokenURI", args: [BigInt(id)] });
    const fileNow = (await until("the identity's file on IPFS", waitSeconds, () => ipfsJson(uriNow), () => ipfsRefusal(uriNow))) as { services?: { name?: string }[] } | null;
    check(fileNow !== null && Array.isArray(fileNow.services) && !fileNow.services.some((s) => s.name === PAD_SERVICE_NAME), "the file the identity points at on chain reads back from IPFS with no Ostrapad entry", { uri: uriNow, services: fileNow?.services ?? "not read" });
    const gone = await until("pad_search by agent id to find no listing", waitSeconds, async () => {
      const r = await call(c.client, "pad_search", { agentId: id });
      if (!r.ok) throw new Error(`pad_search failed: ${r.text}`);
      return r.value === null ? true : null;
    });
    check(gone === true, "pad_search by agent id finds no listing");
    const dropped = await until("Ostra's index to drop the listing", waitSeconds, async () => {
      const l = (await index(indexer, `/api/v1/pad/listings?provider=${vault}`)) as { total: number } | null;
      return l !== null && l.total === 0 ? true : null;
    });
    check(dropped === true, "Ostra's index no longer lists the agent");
  } catch (err) {
    console.log(`PROGRESS ${toJson({ ...progress, jobId })}`);
    // Listed with no job of the client's yet (not even one stopped before its create), or with its job Completed:
    // unpublished, so no one orders from a run that stopped (listed again when carried on before a job exists). With a
    // job not Completed yet, the listing stays.
    if (progress.listed) {
      try {
        const r = await call(c.client, "pad_jobs");
        const mine = r.ok ? ((r.json.jobs ?? []) as JobRow[]).filter((j) => j.role === "client") : null;
        if (mine === null || mine.some((j) => j.status !== "Completed")) throw new Error(mine === null ? `the client's jobs cannot be read (${r.text.slice(0, 200)}): left listed` : "the client has a job not Completed yet: left listed until it is");
        await profileReadable("unpublishing after the stop");
        const u = await call(p.client, "pad_publish", { action: "unpublish" });
        const done = u.ok && u.json.listed === false && ((u.json.profile ?? {}) as { status?: string }).status === "sent" && ((u.json.agentUri ?? {}) as { status?: string }).status === "sent";
        if (done) await record({ listed: false });
        console.log(done ? `UNPUBLISHED after the stop (${toJson({ uri: u.json.uri })})` : `the unpublish after the stop did not go through: ${hide(u.text.slice(0, 500))}`);
      } catch (e) {
        console.log(`not unpublished after the stop: ${hide(e instanceof Error ? e.message : String(e))}`);
      }
    }
    console.log(`provider server log (end): ${hide(p.stderr().slice(-3_000))}`);
    console.log(`client server log (end): ${hide(c.stderr().slice(-3_000))}`);
    throw err;
  } finally {
    await p.client.close();
    await c.client.close();
  }

  // 8. The transactions of this run, and what the run leaves.
  for (const s of sent) {
    const receipt = (await chain.request({ method: "eth_getTransactionReceipt", params: [s.hash] } as never)) as { status: string; gasUsed: string; gasUsedForL1?: string } | null;
    const tx = await chain.getTransaction({ hash: s.hash });
    check(receipt !== null && receipt.status === "0x1", `TX ${s.what}`, { hash: s.hash, gasUsed: receipt === null ? null : BigInt(receipt.gasUsed), l1Gas: receipt?.gasUsedForL1 === undefined ? null : BigInt(receipt.gasUsedForL1), calldataBytes: (tx.input.length - 2) / 2 });
  }
  for (const [who, home] of Object.entries(homes)) {
    const s = await connect(entry, home, who);
    try {
      const left = await call(s.client, "balance");
      console.log(`LEFT ${who}: vault ${toJson(left.json.vault ?? {})}; relayer channels ${toJson(left.json.relayerChannels)}; creator vault ${toJson(left.json.creatorVault)}`);
    } finally {
      await s.client.close();
    }
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
