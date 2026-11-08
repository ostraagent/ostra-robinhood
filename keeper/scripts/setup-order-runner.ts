// Sets up the standing-order and Priors-repay fallback (src/order-runner-main.ts, its service
// ops/systemd/ostra-order-runner.service) next to a deployment record whose vaults run version 5 (sdk
// scripts/upgrade-vault.ts finalize): its directories, its fee payer key and its environment file.
//
//   node scripts/setup-order-runner.ts key   only the directories and the fee payer key (no record needed), so that
//                                            the fee payer can be funded before the upgrade runs; the last line is
//                                            ORDER_RUNNER_KEY_OK
//   node scripts/setup-order-runner.ts       the key, and order-runner.env for the record; the last line is
//                                            ORDER_RUNNER_SETUP_OK
//
//   OSTRA_SERVICES_DIR              the services' directory (default /etc/ostra/robinhood): order-runner/secrets and
//                                   order-runner/data (0700) and order-runner.env (0600) are made there
//   OSTRA_DEPLOYMENT                the deployment record the service reads, checked on chain first (setup only)
//   OSTRA_RPC_URL_FILE              file (0600) with the RPC URL the service sends through (default
//                                   /etc/ostra/robinhood-rpc.url); written into order-runner.env, never printed
//   OSTRA_LOGS_RPC_URL              RPC the vault beacon's Upgraded event is found through (default Robinhood Chain's
//                                   public RPC, which serves wide block ranges)
//   OSTRA_ORDER_RUNNER_FROM_BLOCK   the first block of OrderSet and PriorsBorrowed events (default the block of the
//                                   vault beacon's Upgraded event to the record's implementation: no such event is
//                                   older than the version 5 upgrade)
//   OSTRA_ORDER_RUNNER_SEARCH_FROM  the first block that Upgraded event is looked for in (default the record's
//                                   fromBlock; it is found in the first window back from the head, the upgrade being
//                                   recent)
//
// The fee payer key is created on first run (the service's openFeePayer, the same file it opens) and never printed;
// its address is, with what it holds and FUNDING_DAYS days of the fallback's whole gas budget at twice the gas price
// now: runOrder and repayDue pay their caller nothing, so the service spends at most DAILY_GAS_BUDGET a day of it.
// order-runner.env names no logs RPC: the service reads its events through Robinhood Chain's public RPC (the VPS's RPC
// answers eth_getLogs over 10 blocks at most). Run again, it changes nothing that is right: the key is kept and
// order-runner.env is rewritten only when it would differ.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatEther, getAddress, http, type Address, type PublicClient } from "viem";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_PUBLIC_RPC, checkDeployment, parseDeployment, redact, robinhoodChain, upgradeableBeaconAbi } from "@ostraagent/sdk";
import { ensurePrivateDir, openFeePayer } from "../src/keys.ts";
import { DAILY_GAS_BUDGET } from "../src/order-runner.ts";
import { envFile, writePrivateIfChanged } from "./setup-breaker.ts";

/** The days of DAILY_GAS_BUDGET the suggested funding covers. */
export const FUNDING_DAYS = 2n;
/** The window the Upgraded event is looked for in, from the head back. */
const SPAN = 1_000_000n;
const MIN_SPAN = 10_000n;

async function privateFile(path: string, what: string): Promise<string> {
  const mode = (await stat(path)).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${what} ${path} must have mode 0600 (it has ${mode.toString(8)})`);
  return (await readFile(path, "utf8")).split("\n")[0]!.trim();
}

/** The directories and the fee payer key: what it holds, and the ETH suggested for it. */
export async function orderRunnerKey(o: { servicesDir: string; client: PublicClient }): Promise<{ feePayer: Address; secrets: string; data: string; eth: bigint; suggested: bigint }> {
  await ensurePrivateDir(o.servicesDir);
  const base = join(o.servicesDir, "order-runner");
  await ensurePrivateDir(base);
  const secrets = join(base, "secrets");
  const data = join(base, "data");
  await ensurePrivateDir(data);
  const feePayer = (await openFeePayer(secrets)).address;
  const [eth, gasPrice] = await Promise.all([o.client.getBalance({ address: feePayer }), o.client.getGasPrice()]);
  return { feePayer, secrets, data, eth, suggested: FUNDING_DAYS * DAILY_GAS_BUDGET * 2n * gasPrice };
}

/** The block of the latest Upgraded event of `beacon` to `implementation`, looked for from the head back to `floor`. */
export async function upgradeBlock(logs: PublicClient, beacon: Address, implementation: Address, floor: bigint): Promise<bigint> {
  const event = upgradeableBeaconAbi.find((x) => x.type === "event" && x.name === "Upgraded");
  if (event === undefined) throw new Error("the beacon ABI has no Upgraded event");
  let to = await logs.getBlockNumber();
  let span = SPAN;
  while (to >= floor) {
    const from = to - span + 1n > floor ? to - span + 1n : floor;
    let found: { blockNumber: bigint | null }[];
    try {
      found = await logs.getLogs({ address: beacon, event, args: { implementation }, fromBlock: from, toBlock: to, strict: true });
    } catch (err) {
      if (span === MIN_SPAN) throw err;
      span = span / 4n < MIN_SPAN ? MIN_SPAN : span / 4n;
      continue;
    }
    const last = found.at(-1);
    if (last !== undefined && last.blockNumber !== null) return last.blockNumber;
    if (from === floor) break;
    to = from - 1n;
  }
  throw new Error(`no Upgraded event of the vault beacon ${beacon} to ${implementation} since block ${floor}: the record's implementation is not the one the beacon was upgraded to`);
}

export type OrderRunnerSetup = { feePayer: Address; fromBlock: bigint; envWritten: boolean; eth: bigint; suggested: bigint };

export async function setupOrderRunner(o: { servicesDir: string; deploymentPath: string; rpcUrl: string; logsUrl: string; fromBlock?: bigint; searchFrom?: bigint; log: (event: string, fields: Record<string, unknown>) => void }): Promise<OrderRunnerSetup> {
  const client = createPublicClient({ chain: robinhoodChain, transport: http(o.rpcUrl, { retryCount: 6, retryDelay: 2_000 }) }) as PublicClient;
  const chainId = await client.getChainId();
  const d = parseDeployment(JSON.parse(await readFile(o.deploymentPath, "utf8")));
  if (d.chainId !== chainId) throw new Error(`${o.deploymentPath} is a deployment on chain ${d.chainId}, the RPC is chain ${chainId}`);
  if (d.vaultModuleV5 === undefined) throw new Error(`${o.deploymentPath} names no vaultModuleV5: finalize the version 5 upgrade first (sdk scripts/upgrade-vault.ts finalize)`);
  await checkDeployment(client, d);
  const logs = createPublicClient({ chain: robinhoodChain, transport: http(o.logsUrl, { retryCount: 6, retryDelay: 2_000 }) }) as PublicClient;
  const fromBlock = o.fromBlock ?? (await upgradeBlock(logs, getAddress(d.vaultBeacon), getAddress(d.vaultImplementation), o.searchFrom ?? BigInt(d.fromBlock)));
  const k = await orderRunnerKey({ servicesDir: o.servicesDir, client });
  const env = envFile({
    OSTRA_RPC_URL: o.rpcUrl,
    OSTRA_DEPLOYMENT: o.deploymentPath,
    OSTRA_ORDER_RUNNER_FROM_BLOCK: fromBlock.toString(),
    OSTRA_ORDER_RUNNER_SECRETS: k.secrets,
    OSTRA_ORDER_RUNNER_DATA: k.data,
  });
  const envWritten = await writePrivateIfChanged(join(o.servicesDir, "order-runner.env"), env);
  o.log("order_runner", { fromBlock, feePayer: k.feePayer, env: join(o.servicesDir, "order-runner.env"), envWritten, eth: formatEther(k.eth), suggested: formatEther(k.suggested) });
  return { feePayer: k.feePayer, fromBlock, envWritten, eth: k.eth, suggested: k.suggested };
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== undefined && mode !== "key") throw new Error("usage: node scripts/setup-order-runner.ts [key]");
  const servicesDir = process.env.OSTRA_SERVICES_DIR || "/etc/ostra/robinhood";
  const fromText = process.env.OSTRA_ORDER_RUNNER_FROM_BLOCK;
  if (fromText !== undefined && fromText !== "" && !/^[0-9]+$/.test(fromText)) throw new Error("OSTRA_ORDER_RUNNER_FROM_BLOCK is a block number");
  const searchText = process.env.OSTRA_ORDER_RUNNER_SEARCH_FROM;
  if (searchText !== undefined && searchText !== "" && !/^[0-9]+$/.test(searchText)) throw new Error("OSTRA_ORDER_RUNNER_SEARCH_FROM is a block number");
  const rpcUrl = await privateFile(process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url", "the RPC URL file");
  const logsUrl = process.env.OSTRA_LOGS_RPC_URL || ROBINHOOD_PUBLIC_RPC;
  const hide = (text: string) => redact(redact(text, rpcUrl), logsUrl);
  const log = (event: string, fields: Record<string, unknown>) => console.log(hide(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v))));
  try {
    const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl, { retryCount: 6, retryDelay: 2_000 }) }) as PublicClient;
    if ((await client.getChainId()) !== ROBINHOOD_CHAIN_ID) throw new Error("the RPC is not Robinhood Chain");
    if (mode === "key") {
      const k = await orderRunnerKey({ servicesDir, client });
      log("order_runner_key", { feePayer: k.feePayer, eth: formatEther(k.eth), suggested: formatEther(k.suggested) });
      if (k.eth < k.suggested) console.log(`FUND_ORDER_RUNNER ${k.feePayer} holds ${formatEther(k.eth)} ETH: send it at least ${formatEther(k.suggested - k.eth)} ETH on Robinhood Chain`);
      console.log("ORDER_RUNNER_KEY_OK");
      return;
    }
    const deploymentPath = process.env.OSTRA_DEPLOYMENT;
    if (deploymentPath === undefined || deploymentPath === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
    const s = await setupOrderRunner({ servicesDir, deploymentPath, rpcUrl, logsUrl, ...(fromText === undefined || fromText === "" ? {} : { fromBlock: BigInt(fromText) }), ...(searchText === undefined || searchText === "" ? {} : { searchFrom: BigInt(searchText) }), log });
    if (s.eth < s.suggested) console.log(`FUND_ORDER_RUNNER ${s.feePayer} holds ${formatEther(s.eth)} ETH: send it at least ${formatEther(s.suggested - s.eth)} ETH on Robinhood Chain`);
    console.log("ORDER_RUNNER_SETUP_OK");
  } catch (err) {
    throw new Error(hide(err instanceof Error ? err.message : String(err)));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`setup-order-runner failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
