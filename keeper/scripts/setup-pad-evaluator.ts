// Prepares Ostrapad's evaluator bot (src/pad-evaluator-main.ts, its service ops/systemd/ostra-pad-evaluator.service):
// its directories, its fee payer key, its own Raeto account, and a read of what it starts from. Nothing is sent on chain
// and nothing is spent.
//
//   OSTRA_SERVICES_DIR        the services' directory (default /etc/ostra/robinhood): pad-evaluator/secrets and
//                             pad-evaluator/data (0700) are made there
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_PAD_EVALUATOR_KEYS  the evaluator accounts' key files, comma-separated (default /etc/ostra/pad-evaluator-1.key
//                             to -5.key, made by the earlier step and recorded in /etc/ostra/pad-evaluators.json)
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) of the account that funds the bot later (default /etc/ostra/deployer.key):
//                             only its address and balances are read here
//   OSTRA_RAETO_URL           Raeto's API (default https://api.raeto.cc)
//
// What it does:
//   1. the directories (0700) and the fee payer key (created on first run by the service's openFeePayer, the same file
//      it opens; never printed, its address is);
//   2. the evaluator keys: each 0600, a private key, the addresses those recorded in /etc/ostra/pad-evaluators.json;
//      with each one's ETH and USDG and its OstraPad pool state (bond, in the pool);
//   3. the fee payer's and the funding account's ETH and USDG;
//   4. the bot's Raeto account, opened with the fee payer's wallet (POST /v1/agents/challenge, then /v1/agents/login
//      with personal_sign of Raeto's agent login message, checked first: its first line, the wallet, a nonce, and an
//      expiry within 15 minutes): its API key is written once to pad-evaluator/secrets/raeto.key (0600) and never
//      printed; a run that finds the key keeps it. Its credits (GET /v1/me), with the key replaced wherever it appears;
//      Raeto's payTo for credits checked against the one pinned in core (RAETO_PAY_TO);
//   5. Raeto's models (GET /v1/models), saved whole to pad-evaluator/data/raeto-models.json, and the text models of
//      the main vendors printed with their prices per million tokens, for the judge and the panel to be chosen from.
// The last line is PAD_EVALUATOR_PREPARED.

import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicClient, erc20Abi, formatEther, formatUnits, getAddress, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { OSTRAPAD, USDG, assertRobinhoodChain, readPadEvaluator, redact, retryingHttp, robinhoodChain } from "@ostraagent/sdk";
import { ensurePrivateDir, openFeePayer } from "../src/keys.ts";

/** Where Raeto takes USDG for credits, as core/src/raeto.ts pins it (read 25 Oct 2026). */
const RAETO_PAY_TO: Address = "0xF0Cc2FE5A90a3BB784De818f6E2061fd99c236Bf";
const CHALLENGE_FIRST_LINE = "Sign in to raeto as an agent";
const CHALLENGE_MAX_MS = 15 * 60_000;
const VENDORS = ["openai", "anthropic", "google", "x-ai", "deepseek", "mistralai", "meta-llama", "qwen", "moonshotai", "z-ai"];
const PER_VENDOR = 15;
/** Secrets read while running (the RPC URL, the Raeto key), replaced in every line printed, errors included. */
const secretsSeen: string[] = [];
function scrubAll(text: string): string {
  return secretsSeen.reduce((t, s) => (s === "" ? t : redact(t, s).split(s).join("<secret>")), text);
}

async function privateText(path: string, what: string): Promise<string> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${what} ${path} must be readable by its owner alone (it has mode ${mode.toString(8)})`);
  return (await readFile(path, "utf8")).split("\n")[0]!.trim();
}

async function main(): Promise<void> {
  const servicesDir = process.env.OSTRA_SERVICES_DIR || "/etc/ostra/robinhood";
  const rpcUrl = await privateText(process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url", "the RPC URL file");
  const raeto = (process.env.OSTRA_RAETO_URL || "https://api.raeto.cc").replace(/\/+$/, "");
  secretsSeen.push(rpcUrl);
  let raetoKey = "";
  const say = (line: string) => console.log(scrubAll(line));

  // 1. Directories and the fee payer.
  const base = join(servicesDir, "pad-evaluator");
  await ensurePrivateDir(base);
  const secrets = join(base, "secrets");
  const data = join(base, "data");
  await ensurePrivateDir(secrets);
  await ensurePrivateDir(data);
  const feePayer = await openFeePayer(secrets);
  say(`directories: ${secrets}, ${data} (0700)`);
  say(`fee payer: ${feePayer.address}`);

  const client = createPublicClient({ chain: robinhoodChain, transport: retryingHttp(rpcUrl) }) as PublicClient;
  await assertRobinhoodChain(client);
  const eth = async (a: Address) => formatEther(await client.getBalance({ address: a }));
  const usdg = async (a: Address) => formatUnits((await client.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [a] })) as bigint, 6);

  // 2. The evaluator accounts.
  const files = (process.env.OSTRA_PAD_EVALUATOR_KEYS || [1, 2, 3, 4, 5].map((n) => `/etc/ostra/pad-evaluator-${n}.key`).join(","))
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f !== "");
  const recorded = JSON.parse(await readFile("/etc/ostra/pad-evaluators.json", "utf8")) as { n: number; address: string }[];
  const accounts: Address[] = [];
  for (const file of files) {
    const key = await privateText(file, "the evaluator key");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${file} is not a 0x-prefixed private key`);
    accounts.push(getAddress(privateKeyToAccount(key as `0x${string}`).address));
  }
  if (new Set(accounts).size !== accounts.length) throw new Error("two evaluator key files hold the same account");
  const recordedSet = new Set(recorded.map((r) => getAddress(r.address)));
  for (const a of accounts) if (!recordedSet.has(a)) throw new Error(`${a} is not among the accounts recorded in /etc/ostra/pad-evaluators.json`);
  for (const [i, a] of accounts.entries()) {
    const e = await readPadEvaluator(client, a, OSTRAPAD);
    say(`evaluator ${i + 1}: ${a} ETH ${await eth(a)} USDG ${await usdg(a)} pool bond ${formatUnits(e.bond, 6)} inPool ${e.inPool} exitAt ${e.exitAt}`);
  }

  // 3. The fee payer and the funding account.
  const deployerKey = await privateText(process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key", "the funding key");
  if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) throw new Error("the funding key file does not hold a 32-byte hex private key");
  const deployer = getAddress(privateKeyToAccount(deployerKey as `0x${string}`).address);
  say(`fee payer ${feePayer.address}: ETH ${await eth(feePayer.address)} USDG ${await usdg(feePayer.address)}`);
  say(`funding account ${deployer}: ETH ${await eth(deployer)} USDG ${await usdg(deployer)}`);

  // 4. The bot's Raeto account.
  const call = async (method: "GET" | "POST", path: string, body?: unknown, key?: string): Promise<unknown> => {
    const res = await fetch(`${raeto}${path}`, {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key === undefined ? {} : { authorization: `Bearer ${key}` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Raeto answered ${res.status} to ${method} ${path}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as unknown;
  };
  const terms = (await call("GET", "/v1/agents")) as { chainId?: unknown; usdg?: { token?: unknown; payTo?: unknown } };
  if (terms.chainId !== 4663 || typeof terms.usdg?.payTo !== "string" || getAddress(terms.usdg.payTo) !== RAETO_PAY_TO || typeof terms.usdg.token !== "string" || getAddress(terms.usdg.token) !== USDG) {
    throw new Error(`Raeto's terms are not USDG on chain 4663 to ${RAETO_PAY_TO}: ${JSON.stringify(terms).slice(0, 300)}`);
  }
  say(`Raeto credits: USDG sent from ${feePayer.address} to ${RAETO_PAY_TO} (checked against its terms)`);
  const keyFile = join(secrets, "raeto.key");
  try {
    raetoKey = await privateText(keyFile, "the Raeto key");
    secretsSeen.push(raetoKey);
    say(`Raeto account: the key in ${keyFile} kept`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const c = (await call("POST", "/v1/agents/challenge", { address: feePayer.address })) as { message?: unknown; expiresAt?: unknown };
    const expires = typeof c.expiresAt === "string" ? Date.parse(c.expiresAt) : Number.NaN;
    if (typeof c.message !== "string" || !c.message.startsWith(CHALLENGE_FIRST_LINE) || !c.message.toLowerCase().includes(`wallet: ${feePayer.address.toLowerCase()}`) || !/\nNonce: [0-9a-f]{16,}\n/.test(c.message)) {
      throw new Error("Raeto's challenge is not its agent login message for the fee payer; nothing was signed");
    }
    if (!Number.isFinite(expires) || expires - Date.now() > CHALLENGE_MAX_MS || expires <= Date.now()) throw new Error(`Raeto's challenge expires at ${String(c.expiresAt)}, not within 15 minutes; nothing was signed`);
    const signature = await feePayer.signMessage({ message: c.message });
    const answer = (await call("POST", "/v1/agents/login", { address: feePayer.address, signature, name: "Ostrapad evaluator" })) as Record<string, unknown>;
    const inner = typeof answer.data === "object" && answer.data !== null ? (answer.data as Record<string, unknown>) : {};
    const key = [answer.apiKey, answer.api_key, answer.key, inner.apiKey, inner.api_key, inner.key].find((x): x is string => typeof x === "string" && x.length > 0);
    if (key === undefined) throw new Error(`Raeto signed the fee payer in but its answer carries no API key (fields: ${Object.keys(answer).join(", ")})`);
    raetoKey = key;
    secretsSeen.push(key);
    await writeFile(keyFile, `${key}\n`, { mode: 0o600, flag: "wx" });
    say(`Raeto account: opened for ${feePayer.address}, its key written to ${keyFile} (0600)`);
  }
  const me = await call("GET", "/v1/me", undefined, raetoKey);
  say(`Raeto /v1/me: ${JSON.stringify(me).slice(0, 600)}`);

  // 5. Raeto's models.
  const m = (await call("GET", "/v1/models")) as { data?: unknown };
  const list = (Array.isArray(m.data) ? m.data : []) as { id?: unknown; context_length?: unknown; architecture?: { input_modalities?: unknown; output_modalities?: unknown }; pricing?: { prompt?: unknown; completion?: unknown } }[];
  await writeFile(join(data, "raeto-models.json"), JSON.stringify(list), { mode: 0o600 });
  const text = list.filter(
    (x) =>
      typeof x.id === "string" &&
      Array.isArray(x.architecture?.input_modalities) &&
      x.architecture.input_modalities.includes("text") &&
      Array.isArray(x.architecture?.output_modalities) &&
      x.architecture.output_modalities.length === 1 &&
      x.architecture.output_modalities[0] === "text",
  );
  const perMillion = (v: unknown) => (typeof v === "string" || typeof v === "number" ? Number(v) * 1_000_000 : Number.NaN);
  say(`Raeto models: ${list.length} in all, ${text.length} text in and text out (saved to ${join(data, "raeto-models.json")})`);
  for (const vendor of VENDORS) {
    const rows = text
      .filter((x) => (x.id as string).startsWith(`${vendor}/`))
      .map((x) => ({ id: x.id as string, input: perMillion(x.pricing?.prompt), output: perMillion(x.pricing?.completion), ctx: x.context_length }))
      .filter((x) => Number.isFinite(x.input) && Number.isFinite(x.output))
      .sort((a, b) => a.output - b.output || a.id.localeCompare(b.id));
    say(`${vendor}: ${rows.length} text models`);
    for (const r of rows.slice(0, PER_VENDOR)) say(`  ${r.id} in $${r.input.toFixed(3)} out $${r.output.toFixed(3)} per 1M tokens, context ${String(r.ctx)}`);
  }
  say("PAD_EVALUATOR_PREPARED");
}

main().catch((err: unknown) => {
  console.error(scrubAll(`STOPPED: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
