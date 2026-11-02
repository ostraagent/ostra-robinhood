// Sets up the venue breaker keeper (src/venue-breaker-main.ts, its service ops/systemd/ostra-venue-breaker.service)
// next to a deployment record whose vaults run version 4 (sdk scripts/upgrade-vault.ts finalize): its directories, its
// fee payer key and its environment file.
//
//   OSTRA_SERVICES_DIR               the services' directory (default /etc/ostra/robinhood): venue-breaker/secrets and
//                                    venue-breaker/data (0700) and venue-breaker.env (0600) are made there
//   OSTRA_DEPLOYMENT                 the deployment record the service reads, checked on chain first
//   OSTRA_RPC_URL_FILE               file (0600) with the RPC URL the service sends through (default
//                                    /etc/ostra/robinhood-rpc.url); written into venue-breaker.env, never printed
//   OSTRA_VENUE_BREAKER_FROM_BLOCK   the first block of Entered events (default the record's fromBlock: no Entered
//                                    event is older than the version 4 upgrade, so a later block saves a long first read)
//
// The fee payer key is created on first run (the service's openFeePayer, the same file it opens) and never printed;
// its address is, with what it holds and the level (LOW_ETH_WEI) under which the service sends no trip: it is funded
// from Ostra's account by the release, as the breaker keeper's is. venue-breaker.env names no logs RPC: the service
// reads its events through Robinhood Chain's public RPC (the VPS's RPC answers eth_getLogs over 10 blocks at most).
// Run again, it changes nothing that is right: the key is kept and venue-breaker.env is rewritten only when it would
// differ. The last line is VENUE_BREAKER_SETUP_OK.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatEther, http, type Address, type PublicClient } from "viem";
import { ROBINHOOD_CHAIN_ID, checkDeployment, parseDeployment, redact, robinhoodChain } from "@ostraagent/sdk";
import { ensurePrivateDir, openFeePayer } from "../src/keys.ts";
import { LOW_ETH_WEI } from "../src/venue-breaker.ts";
import { envFile, writePrivateIfChanged } from "./setup-breaker.ts";

async function privateFile(path: string, what: string): Promise<string> {
  const mode = (await stat(path)).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${what} ${path} must have mode 0600 (it has ${mode.toString(8)})`);
  return (await readFile(path, "utf8")).split("\n")[0]!.trim();
}

export type VenueBreakerSetup = { feePayer: Address; fromBlock: bigint; envWritten: boolean; feePayerEth: bigint; funded: boolean };

export async function setupVenueBreaker(o: { servicesDir: string; deploymentPath: string; rpcUrl: string; fromBlock?: bigint; log: (event: string, fields: Record<string, unknown>) => void }): Promise<VenueBreakerSetup> {
  const client = createPublicClient({ chain: robinhoodChain, transport: http(o.rpcUrl, { retryCount: 6, retryDelay: 2_000 }) }) as PublicClient;
  const chainId = await client.getChainId();
  const d = parseDeployment(JSON.parse(await readFile(o.deploymentPath, "utf8")));
  if (d.chainId !== chainId) throw new Error(`${o.deploymentPath} is a deployment on chain ${d.chainId}, the RPC is chain ${chainId}`);
  if (d.vaultModuleV4 === undefined) throw new Error(`${o.deploymentPath} names no vaultModuleV4: finalize the version 4 upgrade first (sdk scripts/upgrade-vault.ts finalize)`);
  await checkDeployment(client, d);
  const fromBlock = o.fromBlock ?? BigInt(d.fromBlock);
  await ensurePrivateDir(o.servicesDir);
  const base = join(o.servicesDir, "venue-breaker");
  await ensurePrivateDir(base);
  const secrets = join(base, "secrets");
  const data = join(base, "data");
  await ensurePrivateDir(data);
  const feePayer = (await openFeePayer(secrets)).address;
  const env = envFile({
    OSTRA_RPC_URL: o.rpcUrl,
    OSTRA_DEPLOYMENT: o.deploymentPath,
    OSTRA_VENUE_BREAKER_FROM_BLOCK: fromBlock.toString(),
    OSTRA_VENUE_BREAKER_SECRETS: secrets,
    OSTRA_VENUE_BREAKER_DATA: data,
  });
  const envWritten = await writePrivateIfChanged(join(o.servicesDir, "venue-breaker.env"), env);
  const held = await client.getBalance({ address: feePayer });
  o.log("venue_breaker", { fromBlock, feePayer, env: join(o.servicesDir, "venue-breaker.env"), envWritten, eth: formatEther(held), low: formatEther(LOW_ETH_WEI) });
  return { feePayer, fromBlock, envWritten, feePayerEth: held, funded: held >= LOW_ETH_WEI };
}

async function main(): Promise<void> {
  const servicesDir = process.env.OSTRA_SERVICES_DIR || "/etc/ostra/robinhood";
  const deploymentPath = process.env.OSTRA_DEPLOYMENT;
  if (deploymentPath === undefined || deploymentPath === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
  const fromText = process.env.OSTRA_VENUE_BREAKER_FROM_BLOCK;
  if (fromText !== undefined && fromText !== "" && !/^[0-9]+$/.test(fromText)) throw new Error("OSTRA_VENUE_BREAKER_FROM_BLOCK is a block number");
  const rpcUrl = await privateFile(process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url", "the RPC URL file");
  const log = (event: string, fields: Record<string, unknown>) => console.log(redact(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)), rpcUrl));
  try {
    const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) });
    if ((await client.getChainId()) !== ROBINHOOD_CHAIN_ID) throw new Error("the RPC is not Robinhood Chain");
    const s = await setupVenueBreaker({ servicesDir, deploymentPath, rpcUrl, ...(fromText === undefined || fromText === "" ? {} : { fromBlock: BigInt(fromText) }), log });
    if (!s.funded) console.log(`the fee payer ${s.feePayer} holds ${formatEther(s.feePayerEth)} ETH: fund it with at least ${formatEther(LOW_ETH_WEI)} ETH, or the service sends no trip`);
    console.log("VENUE_BREAKER_SETUP_OK");
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err), rpcUrl));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`setup-venue-breaker failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
