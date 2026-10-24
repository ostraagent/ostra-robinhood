// Deploys OstraBreaker (Strategy 3, src/OstraBreaker.sol) next to a deployment whose vaults run version 3, and adds
// it to the deployment record (deploy.ts: deployBreaker). The breaker has no owner: whoever deploys it holds no power
// over it. The record is checked on chain first (checkDeployment), the breaker after it lands (checkBreaker).
//
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) with the deployer's 32-byte hex private key (default /etc/ostra/deployer.key);
//                             never printed
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_DEPLOYMENT          the deployment record, read and written back with `breaker` (0644)
//   OSTRA_OUT_DIR             the Foundry build (default ../../out)
//   OSTRA_BREAKER             only after a run that stopped between sending the deployment and writing the record:
//                             the address it printed as "deploying"; it must be a contract this deployer created (an
//                             earlier nonce of its) with this build's code, it is checked on chain and written, and
//                             nothing is sent
//
// Run again, it only checks: a record that has a breaker is checked on chain and left as it is.

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, formatGwei, getAddress, getContractAddress, http, isAddress, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { redact, robinhoodChain } from "../src/chain.ts";
import { ROBINHOOD_CHAIN_ID } from "../src/constants.ts";
import { checkBreaker, checkBreakerCode, checkDeployment, deployBreaker } from "../src/deploy.ts";
import { parseDeployment, type Deployment } from "../src/deployment.ts";

/** Gas the deployment uses (measured on a mainnet fork 25 Oct 2026: 2,540,554), with room. */
export const BREAKER_GAS_BUDGET = 3_000_000n;

function privateFile(path: string, what: string): string {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${what} ${path} must have mode 0600 (it has ${mode.toString(8)})`);
  return readFileSync(path, "utf8").trim();
}

function writeRecord(path: string, d: Deployment): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  renameSync(tmp, path);
}

/** Whether `from` created `contract` with one of its first `sent` transactions (CREATE at nonce 0 to sent - 1). */
export function createdBy(from: Address, contract: Address, sent: number): boolean {
  const want = getAddress(contract);
  for (let nonce = 0; nonce < sent; ++nonce) if (getContractAddress({ from, nonce: BigInt(nonce) }) === want) return true;
  return false;
}

async function main(): Promise<void> {
  const keyFile = process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key";
  const rpcFile = process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url";
  const path = process.env.OSTRA_DEPLOYMENT;
  if (path === undefined || path === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
  const outDir = process.env.OSTRA_OUT_DIR || fileURLToPath(new URL("../../out", import.meta.url));
  const rpcUrl = privateFile(rpcFile, "the RPC URL file");
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(redact(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)), rpcUrl));
  try {
    const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) }) as PublicClient;
    const chainId = await publicClient.getChainId();
    if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`the RPC is chain ${chainId}, not Robinhood Chain (${ROBINHOOD_CHAIN_ID})`);
    let d = parseDeployment(JSON.parse(readFileSync(path, "utf8")));
    if (d.chainId !== chainId) throw new Error(`${path} is a deployment on chain ${d.chainId}`);
    if (d.vaultModule === undefined) throw new Error(`${path} is not a version 3 record (no vaultModule): finalize the vault upgrade first`);
    await checkDeployment(publicClient, d);
    if (d.breaker !== undefined) {
      log("found", { record: path, breaker: d.breaker });
      console.log("BREAKER_OK");
      return;
    }
    const key = privateFile(keyFile, "the deployer key file");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyFile} does not hold a 32-byte hex private key`);
    const account = privateKeyToAccount(key as `0x${string}`);
    const adopt = process.env.OSTRA_BREAKER;
    if (adopt !== undefined && adopt !== "") {
      if (!isAddress(adopt, { strict: false })) throw new Error("OSTRA_BREAKER is not an address");
      const breaker: Address = getAddress(adopt);
      // Only a contract this deployer created: an address anyone else deployed, however it answers, is never adopted.
      const sent = await publicClient.getTransactionCount({ address: account.address });
      if (!createdBy(account.address, breaker, sent)) throw new Error(`OSTRA_BREAKER ${breaker} was not created by the deployer ${account.address}`);
      await checkBreaker(publicClient, breaker, d.vaultFactory);
      await checkBreakerCode(publicClient, breaker, outDir);
      d = { ...d, breaker };
      writeRecord(path, d);
      await checkDeployment(publicClient, d);
      log("written", { record: path, breaker, adopted: true });
      console.log("BREAKER_OK");
      return;
    }
    const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: http(rpcUrl) });
    const gasPrice = await publicClient.getGasPrice();
    const balance = await publicClient.getBalance({ address: account.address });
    log("deployer", { address: account.address, eth: formatEther(balance), gasPriceGwei: formatGwei(gasPrice) });
    const need = BREAKER_GAS_BUDGET * gasPrice;
    if (balance < need) throw new Error(`the deployer holds ${formatEther(balance)} ETH; the deployment needs up to ${formatEther(need)} ETH at ${formatGwei(gasPrice)} gwei`);
    // Where it will be, printed before it is sent: a run that stops before the record is written is finished with
    // OSTRA_BREAKER set to this address, not by deploying a second breaker.
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
    log("deploying", { breaker: getContractAddress({ from: account.address, nonce: BigInt(nonce) }), nonce });
    d = await deployBreaker({ publicClient, walletClient, outDir, log }, d);
    writeRecord(path, d);
    await checkDeployment(publicClient, d);
    log("written", { record: path, breaker: d.breaker, ethLeft: formatEther(await publicClient.getBalance({ address: account.address })) });
    console.log("BREAKER_OK");
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err), rpcUrl));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`deploy-breaker failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
