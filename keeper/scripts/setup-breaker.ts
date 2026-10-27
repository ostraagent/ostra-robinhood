// Sets up the breaker keeper (src/breaker-main.ts, its service ops/systemd/ostra-breaker.service) next to a deployment
// record that has OstraBreaker (sdk/scripts/deploy-breaker.ts): its directories, its fee payer key, its environment
// file, and the ETH its trips are paid with.
//
//   OSTRA_SERVICES_DIR        the services' directory (default /etc/ostra/robinhood): breaker/secrets and
//                             breaker/data (0700) and breaker.env (0600) are made there
//   OSTRA_DEPLOYMENT          the deployment record the service reads (its `breaker`), checked on chain first
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL the service sends through (default
//                             /etc/ostra/robinhood-rpc.url); written into breaker.env, never printed
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) with the 32-byte hex private key that funds the fee payer (default
//                             /etc/ostra/deployer.key); never printed
//
// The fee payer key is created on first run (the service's openFeePayer, the same file it opens) and never printed;
// its address is. It is topped up to FEE_PAYER_TARGET_WEI when it holds less than LOW_ETH_WEI (the level under which
// the service logs low_eth). OSTRA_BREAKER_FROM_BLOCK is the record's fromBlock: the breaker was deployed after it, so
// no event of it is older (the service reads that span once, in 4,000,000-block windows, then keeps a cursor).
// breaker.env names no logs RPC: the service reads its events through Robinhood Chain's public RPC, which
// keeps every block's logs (the VPS's RPC answers eth_getLogs over 10 blocks at most, proven 25 Oct 2026).
//
// Run again, it changes nothing that is right: the key is kept, breaker.env is rewritten only when it would differ,
// and the fee payer is funded only below LOW_ETH_WEI. The top-up's nonce is recorded (breaker/funding.json) before it
// is sent and removed once it landed: a run that stopped in between sends at that same nonce, so at most one top-up
// lands. The last line is BREAKER_SETUP_OK.

import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROBINHOOD_CHAIN_ID, checkDeployment, parseDeployment, redact, robinhoodChain } from "@ostraagent/sdk";
import { LOW_ETH_WEI } from "../src/breaker.ts";
import { ensurePrivateDir, openFeePayer } from "../src/keys.ts";

/** What the fee payer is topped up to: twice the low_eth level, about 236 trips of a whole position at 0.020056 gwei. */
export const FEE_PAYER_TARGET_WEI = 2n * LOW_ETH_WEI;

async function privateFile(path: string, what: string): Promise<string> {
  const mode = (await stat(path)).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${what} ${path} must have mode 0600 (it has ${mode.toString(8)})`);
  return (await readFile(path, "utf8")).split("\n")[0]!.trim();
}

/** An environment file as systemd's EnvironmentFile reads it (KEY=value lines; no value here holds a newline). */
export function envFile(vars: Record<string, string>): string {
  for (const [k, v] of Object.entries(vars)) if (/[\n\r]/.test(v)) throw new Error(`${k} holds a line break`);
  return `${Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
}

async function writePrivateIfChanged(path: string, text: string): Promise<boolean> {
  try {
    if ((await readFile(path, "utf8")) === text) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const tmp = `${path}.tmp-${process.pid}`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  return true;
}

export type BreakerSetup = { breaker: Address; feePayer: Address; fromBlock: bigint; envWritten: boolean; funded: bigint; feePayerEth: bigint };

export async function setupBreaker(o: {
  servicesDir: string;
  deploymentPath: string;
  rpcUrl: string;
  deployerKey: `0x${string}`;
  log: (event: string, fields: Record<string, unknown>) => void;
}): Promise<BreakerSetup> {
  const client = createPublicClient({ chain: robinhoodChain, transport: http(o.rpcUrl, { retryCount: 6, retryDelay: 2_000 }) }) as PublicClient;
  const chainId = await client.getChainId();
  const d = parseDeployment(JSON.parse(await readFile(o.deploymentPath, "utf8")));
  if (d.chainId !== chainId) throw new Error(`${o.deploymentPath} is a deployment on chain ${d.chainId}, the RPC is chain ${chainId}`);
  if (d.breaker === undefined) throw new Error(`${o.deploymentPath} has no breaker (sdk scripts/deploy-breaker.ts first)`);
  await checkDeployment(client, d);
  const breaker = d.breaker;
  const fromBlock = BigInt(d.fromBlock);
  await ensurePrivateDir(o.servicesDir);
  const base = join(o.servicesDir, "breaker");
  await ensurePrivateDir(base);
  const secrets = join(base, "secrets");
  const data = join(base, "data");
  await ensurePrivateDir(data);
  const feePayer = (await openFeePayer(secrets)).address;
  const env = envFile({
    OSTRA_RPC_URL: o.rpcUrl,
    OSTRA_DEPLOYMENT: o.deploymentPath,
    OSTRA_BREAKER_FROM_BLOCK: fromBlock.toString(),
    OSTRA_BREAKER_SECRETS: secrets,
    OSTRA_BREAKER_DATA: data,
  });
  const envWritten = await writePrivateIfChanged(join(o.servicesDir, "breaker.env"), env);
  o.log("breaker", { breaker, fromBlock, feePayer, env: join(o.servicesDir, "breaker.env"), envWritten });
  let held = await client.getBalance({ address: feePayer });
  let funded = 0n;
  if (held < LOW_ETH_WEI) {
    const funder = privateKeyToAccount(o.deployerKey);
    const need = FEE_PAYER_TARGET_WEI - held;
    const wallet = createWalletClient({ account: funder, chain: robinhoodChain, transport: http(o.rpcUrl) });
    const has = await client.getBalance({ address: funder.address });
    o.log("funder", { address: funder.address, eth: formatEther(has) });
    if (has < need + parseEther("0.0005")) throw new Error(`the funder ${funder.address} holds ${formatEther(has)} ETH; the fee payer needs ${formatEther(need)} ETH and the gas`);
    // The nonce first: an earlier run's (it may still land, and then this one cannot), else the funder's next.
    const fundingFile = join(base, "funding.json");
    let nonce: number;
    try {
      const kept = JSON.parse(await readFile(fundingFile, "utf8")) as { nonce?: unknown };
      if (typeof kept.nonce !== "number" || !Number.isSafeInteger(kept.nonce)) throw new Error(`${fundingFile} holds no nonce`);
      nonce = kept.nonce;
      o.log("funding_again", { nonce });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      nonce = await client.getTransactionCount({ address: funder.address, blockTag: "pending" });
      await writePrivateIfChanged(fundingFile, `${JSON.stringify({ nonce, feePayer, at: new Date().toISOString() })}\n`);
    }
    const mined = await client.getTransactionCount({ address: funder.address, blockTag: "latest" });
    if (mined > nonce) {
      // That nonce is spent: by the earlier top-up (its ETH is there, or is being read late) or by something else.
      held = await client.getBalance({ address: feePayer });
      if (held < LOW_ETH_WEI) throw new Error(`the funder's nonce ${nonce} recorded in ${fundingFile} is spent, and the fee payer ${feePayer} holds ${formatEther(held)} ETH: look at the funder's transaction at that nonce before removing ${fundingFile}`);
    } else {
      const hash = await wallet.sendTransaction({ to: feePayer, value: need, account: funder, chain: robinhoodChain, nonce });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 300_000 });
      if (receipt.status !== "success") throw new Error(`the transfer to the fee payer reverted (${hash})`);
      funded = need;
      held = await client.getBalance({ address: feePayer, blockNumber: receipt.blockNumber });
      o.log("funded", { feePayer, value: formatEther(need), tx: hash });
    }
    await rm(fundingFile);
  }
  if (held < LOW_ETH_WEI) throw new Error(`the fee payer ${feePayer} holds ${formatEther(held)} ETH, under ${formatEther(LOW_ETH_WEI)}`);
  o.log("fee_payer", { feePayer, eth: formatEther(held) });
  return { breaker, feePayer, fromBlock, envWritten, funded, feePayerEth: held };
}

async function main(): Promise<void> {
  const servicesDir = process.env.OSTRA_SERVICES_DIR || "/etc/ostra/robinhood";
  const deploymentPath = process.env.OSTRA_DEPLOYMENT;
  if (deploymentPath === undefined || deploymentPath === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
  const rpcUrl = await privateFile(process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url", "the RPC URL file");
  const log = (event: string, fields: Record<string, unknown>) => console.log(redact(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)), rpcUrl));
  try {
    const key = await privateFile(process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key", "the deployer key file");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("the deployer key file does not hold a 32-byte hex private key");
    const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) });
    if ((await client.getChainId()) !== ROBINHOOD_CHAIN_ID) throw new Error("the RPC is not Robinhood Chain");
    await setupBreaker({ servicesDir, deploymentPath, rpcUrl, deployerKey: key as `0x${string}`, log });
    console.log("BREAKER_SETUP_OK");
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err), rpcUrl));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`setup-breaker failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
