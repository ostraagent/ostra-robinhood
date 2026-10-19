// Upgrades the shielded pool to OstraPool version 2 through its beacon, with
// the beacon owner's key: version 1 recorded each deposit's LtHash commitment
// on-chain, from which anyone could match every deposit to its leaves;
// version 2 records nothing about a deposit's leaves (src/OstraPool.sol). The
// storage layout is the same, so the pool proxy keeps every setting, batch and
// deposit.
//
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) with the beacon owner's 32-byte hex
//                             private key (default /etc/ostra/deployer.key); never printed
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default
//                             /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_DEPLOYMENT          the deployment record; its poolImplementation is
//                             rewritten once the upgrade is checked on chain
//   OSTRA_OUT_DIR             the Foundry build (default ../../out)
//
// Only an empty pool is upgraded (no tokens in it: no pending deposit and no
// unspent leaf), checked just before the new implementation is deployed. A
// version 1 deposit that lands between that check and upgradeTo stays
// pending under version 2 (its commitment public); its funds are safe, as its
// client approves only a batch holding its leaves, and it is refunded after
// the timeout. The new implementation is deployed and checked, the beacon's
// upgradeTo is simulated and sent, and every pool setting is compared before
// and after. Run again after a completed upgrade, it only checks the record
// against the chain.

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, formatGwei, getAddress, http, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ostraPoolAbi, upgradeableBeaconAbi } from "../src/abi.ts";
import { redact, robinhoodChain } from "../src/chain.ts";
import { ROBINHOOD_CHAIN_ID } from "../src/constants.ts";
import { checkDeployment } from "../src/deploy.ts";
import { parseDeployment, type Deployment } from "../src/deployment.ts";
import { usdgAbi } from "../src/external-abi.ts";

/** The implementation version this script installs (OstraPool.VERSION). */
export const POOL_VERSION = 2;
/** Gas the upgrade may use, for the balance check before anything is sent: the implementation is 12.6 KB of code (about 2.8 million gas), upgradeTo about 30,000; with room for the chain's data fee. */
export const UPGRADE_GAS_BUDGET = 6_000_000n;

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

/** Every pool setting the upgrade must leave as it was. */
async function poolSettings(client: PublicClient, pool: Address): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of ["token", "feeBps", "treasury", "initAuthority", "leafAmount", "maxDeposit", "maxTotal", "batchCount", "feesOwed"]) {
    out[name] = String(await client.readContract({ address: pool, abi: ostraPoolAbi as Abi, functionName: name }));
  }
  return out;
}

/** OstraPool.VERSION of the implementation behind `address`, or 1 for version 1, which has no VERSION. */
async function versionOf(client: PublicClient, address: Address): Promise<number> {
  try {
    return Number(await client.readContract({ address, abi: ostraPoolAbi, functionName: "VERSION" }));
  } catch {
    return 1;
  }
}

async function main(): Promise<void> {
  const keyFile = process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key";
  const rpcFile = process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url";
  const recordPath = process.env.OSTRA_DEPLOYMENT;
  if (recordPath === undefined || recordPath === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
  const outDir = process.env.OSTRA_OUT_DIR || fileURLToPath(new URL("../../out", import.meta.url));
  const rpcUrl = privateFile(rpcFile, "the RPC URL file");
  const key = privateFile(keyFile, "the beacon owner key file");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyFile} does not hold a 32-byte hex private key`);
  const account = privateKeyToAccount(key as Hex);
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(redact(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)), rpcUrl));
  try {
    const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) }) as PublicClient;
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(rpcUrl) });
    const chainId = await client.getChainId();
    if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`the RPC is chain ${chainId}, not Robinhood Chain (${ROBINHOOD_CHAIN_ID})`);
    const d = parseDeployment(JSON.parse(readFileSync(recordPath, "utf8")));
    if (d.chainId !== chainId) throw new Error(`${recordPath} is a deployment on chain ${d.chainId}`);
    const owner = getAddress((await client.readContract({ address: d.poolBeacon, abi: upgradeableBeaconAbi, functionName: "owner" })) as Address);
    if (owner !== account.address) throw new Error(`the pool beacon is owned by ${owner}, not by this key's ${account.address}`);
    const current = getAddress((await client.readContract({ address: d.poolBeacon, abi: upgradeableBeaconAbi, functionName: "implementation" })) as Address);

    if ((await versionOf(client, d.pool)) === POOL_VERSION) {
      // Upgraded already; a run that stopped after upgradeTo had not written the record yet.
      const next: Deployment = { ...d, poolImplementation: current };
      await checkDeployment(client, next);
      if (current !== d.poolImplementation) {
        writeRecord(recordPath, next);
        log("written", { record: recordPath, poolImplementation: current, previous: d.poolImplementation });
      }
      log("checked", { pool: d.pool, version: POOL_VERSION, poolImplementation: current });
      console.log("POOL_UPGRADE_OK");
      return;
    }
    await checkDeployment(client, d);
    const held = (await client.readContract({ address: d.token, abi: usdgAbi, functionName: "balanceOf", args: [d.pool] })) as bigint;
    if (held !== 0n) throw new Error(`the pool holds ${held} base units: only an empty pool is upgraded (no pending deposit, no unspent leaf)`);
    const gasPrice = await client.getGasPrice();
    const balance = await client.getBalance({ address: account.address });
    log("owner", { address: account.address, eth: formatEther(balance), gasPriceGwei: formatGwei(gasPrice) });
    if (balance < UPGRADE_GAS_BUDGET * gasPrice) throw new Error(`the owner holds ${formatEther(balance)} ETH; the upgrade needs up to ${formatEther(UPGRADE_GAS_BUDGET * gasPrice)} ETH`);
    const before = await poolSettings(client, d.pool);

    const artifact = JSON.parse(readFileSync(`${outDir}/OstraPool.sol/OstraPool.json`, "utf8")) as { bytecode: { object: string } };
    if (!/^0x[0-9a-f]+$/.test(artifact.bytecode.object)) throw new Error("OstraPool: no creation code in the build");
    const deployHash = await wallet.deployContract({ abi: ostraPoolAbi, bytecode: artifact.bytecode.object as Hex, args: [], account, chain: robinhoodChain });
    const deployed = await client.waitForTransactionReceipt({ hash: deployHash });
    if (deployed.status !== "success" || deployed.contractAddress === null || deployed.contractAddress === undefined) throw new Error(`OstraPool: deployment ${deployHash} failed`);
    const implementation = getAddress(deployed.contractAddress);
    log("deployed", { name: "OstraPool", address: implementation, tx: deployHash, gasUsed: deployed.gasUsed });
    if ((await versionOf(client, implementation)) !== POOL_VERSION) throw new Error(`the new implementation ${implementation} is not version ${POOL_VERSION}`);

    const { request } = await client.simulateContract({ address: d.poolBeacon, abi: upgradeableBeaconAbi, functionName: "upgradeTo", args: [implementation], account });
    const upgradeHash = await wallet.writeContract(request);
    const upgraded = await client.waitForTransactionReceipt({ hash: upgradeHash });
    if (upgraded.status !== "success") throw new Error(`upgradeTo ${upgradeHash} reverted`);
    log("upgraded", { beacon: d.poolBeacon, implementation, tx: upgradeHash, gasUsed: upgraded.gasUsed });

    const now = getAddress((await client.readContract({ address: d.poolBeacon, abi: upgradeableBeaconAbi, functionName: "implementation" })) as Address);
    if (now !== implementation) throw new Error(`the beacon points at ${now}, not at ${implementation}`);
    if ((await versionOf(client, d.pool)) !== POOL_VERSION) throw new Error(`the pool does not report version ${POOL_VERSION}`);
    const after = await poolSettings(client, d.pool);
    for (const name of Object.keys(before)) {
      if (before[name] !== after[name]) throw new Error(`the pool's ${name} changed in the upgrade: ${before[name]} then ${after[name]}`);
    }
    const next: Deployment = { ...d, poolImplementation: implementation };
    await checkDeployment(client, next);
    writeRecord(recordPath, next);
    log("written", { record: recordPath, poolImplementation: implementation, previous: current, settings: after });
    console.log("POOL_UPGRADE_OK");
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err), rpcUrl));
  }
}

main().catch((err: unknown) => {
  console.error(`upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
