// Deploys Ostra's contracts to Robinhood Chain (deploy.ts: deployOstra, then
// deployLaunchpad) from the Foundry build, and writes the deployment record
// every service and client reads. One account deploys and, at deployment, owns
// everything (decided 19 Oct 2026): it is the beacons' owner, the pool's
// treasury and init authority, and the owner of the hook, the launchpad and the
// dispatcher. The beacons were then handed to OstraUpgradeOwner
// (scripts/upgrade-owner.ts).
//
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) with the deployer's 32-byte hex private
//                             key (default /etc/ostra/deployer.key); never printed
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default
//                             /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_DEPLOYMENT          where the deployment record is written (0644)
//   OSTRA_OUT_DIR             the Foundry build (default ../../out)
//
// Run again, it resumes: a record without the launchpad gets the launchpad;
// a complete record is only checked on chain. Every contract is checked on
// chain before the record is written (checkDeployment, checkLaunchpad), and
// each address is printed as it lands, so a run that stops half-way leaves a
// trail.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, formatGwei, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { redact, robinhoodChain } from "../src/chain.ts";
import { ROBINHOOD_CHAIN_ID } from "../src/constants.ts";
import { checkDeployment, checkLaunchpad, deployLaunchpad, deployOstra } from "../src/deploy.ts";
import { parseDeployment, type Deployment } from "../src/deployment.ts";

/** Gas the whole deployment uses (measured on a mainnet fork 19 Oct 2026: 31.6 million), with room. */
export const DEPLOY_GAS_BUDGET = 40_000_000n;

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

async function main(): Promise<void> {
  const keyFile = process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key";
  const rpcFile = process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url";
  const out = process.env.OSTRA_DEPLOYMENT;
  if (out === undefined || out === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
  const outDir = process.env.OSTRA_OUT_DIR || fileURLToPath(new URL("../../out", import.meta.url));
  const rpcUrl = privateFile(rpcFile, "the RPC URL file");
  const key = privateFile(keyFile, "the deployer key file");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyFile} does not hold a 32-byte hex private key`);
  const account = privateKeyToAccount(key as `0x${string}`);
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(redact(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)), rpcUrl));
  try {
    const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) }) as PublicClient;
    const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: http(rpcUrl) });
    const chainId = await publicClient.getChainId();
    if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`the RPC is chain ${chainId}, not Robinhood Chain (${ROBINHOOD_CHAIN_ID})`);
    const gasPrice = await publicClient.getGasPrice();
    const balance = await publicClient.getBalance({ address: account.address });
    log("deployer", { address: account.address, eth: formatEther(balance), gasPriceGwei: formatGwei(gasPrice) });

    let d: Deployment | undefined;
    if (existsSync(out)) {
      d = parseDeployment(JSON.parse(readFileSync(out, "utf8")));
      if (d.chainId !== chainId) throw new Error(`${out} is a deployment on chain ${d.chainId}`);
      // The beacons stay the deployer's until they are handed to OstraUpgradeOwner (scripts/upgrade-owner.ts), which
      // rewrites beaconOwner to the owner contract; the pool's treasury and init authority, checked next, stay the
      // deployer's either way. An account with an EIP-7702 delegation (code 0xef0100 followed by the delegate) is
      // still an account, not the owner contract.
      if (d.beaconOwner !== account.address) {
        const code = await publicClient.getCode({ address: d.beaconOwner });
        if (code === undefined || code.startsWith("0xef0100")) throw new Error(`${out} was deployed by ${d.beaconOwner}, not by this deployer`);
      }
      await checkDeployment(publicClient, d, { treasury: account.address, poolAuthority: account.address });
      log("found", { record: out, launchpad: d.launchpad !== undefined });
    }
    if (d === undefined || d.launchpad === undefined) {
      const need = DEPLOY_GAS_BUDGET * gasPrice;
      if (balance < need) throw new Error(`the deployer holds ${formatEther(balance)} ETH; the deployment needs up to ${formatEther(need)} ETH at ${formatGwei(gasPrice)} gwei`);
    }
    if (d === undefined) {
      d = await deployOstra({ publicClient, walletClient, outDir, beaconOwner: account.address, treasury: account.address, poolAuthority: account.address, log });
      writeRecord(out, d);
      log("written", { record: out, part: "vault, pool, split factory" });
    }
    if (d.launchpad === undefined) {
      d = await deployLaunchpad({ publicClient, walletClient, outDir, log }, d);
      writeRecord(out, d);
      log("written", { record: out, part: "launchpad" });
    }
    await checkLaunchpad(publicClient, d);
    log("checked", { deployment: d, ethLeft: formatEther(await publicClient.getBalance({ address: account.address })) });
    console.log("DEPLOYMENT_OK");
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err), rpcUrl));
  }
}

main().catch((err: unknown) => {
  console.error(`deploy failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
