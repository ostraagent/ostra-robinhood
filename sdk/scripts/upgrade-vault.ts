// Prepares and records the upgrade of every vault to OstraVault version 2 (profile, token metadata and agent
// identity spends; src/OstraVault.sol), through the vault beacon, which OstraUpgradeOwner owns: the upgrade
// itself is a WOTS-signed call that waits 72 hours in public (scripts/upgrade-owner.ts). The storage layout is
// the same, so every vault keeps its token, key, nonce, crank, guardians and channels.
//
//   node scripts/upgrade-vault.ts prepare   deploys OstraRegistry and the version 2 implementation (the
//                                            deployer key pays gas; it authorizes nothing), checks both on
//                                            chain and prints the upgrade to schedule; run again, it resumes
//   node scripts/upgrade-vault.ts finalize  once the scheduled upgrade has run: checks the beacon and writes
//                                            the record's vaultImplementation and registry
//
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) with the deployer's 32-byte hex private key (default
//                             /etc/ostra/deployer.key); never printed
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_DEPLOYMENT          the deployment record; finalize rewrites it
//   OSTRA_OUT_DIR             the Foundry build (default ../../out)
//
// What prepare deployed is kept next to the record (<record>.vault-v2.json) until finalize, so a run that stops
// half-way never deploys twice.

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, formatGwei, getAddress, http, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ostraRegistryAbi, ostraVaultAbi, upgradeableBeaconAbi } from "../src/abi.ts";
import { redact, robinhoodChain } from "../src/chain.ts";
import { ERC8004_IDENTITY_REGISTRY, ROBINHOOD_CHAIN_ID, UNISWAP_V4_POOL_MANAGER, VAULT_MAX_URI_LENGTH, VAULT_VERSION, X402_BATCH_SETTLEMENT } from "../src/constants.ts";
import { checkDeployment } from "../src/deploy.ts";
import { parseDeployment, type Deployment } from "../src/deployment.ts";

/** Gas prepare may use, for the balance check before anything is sent: the implementation is about 18 KB of code (about 4 million gas) and OstraRegistry 2.4 KB; with room for the chain's data fee. */
export const PREPARE_GAS_BUDGET = 8_000_000n;

type Prepared = { registry: Address; implementation: Address };

function privateFile(path: string, what: string): string {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${what} ${path} must have mode 0600 (it has ${mode.toString(8)})`);
  return readFileSync(path, "utf8").trim();
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644, flag: "wx" });
  renameSync(tmp, path);
}

function creationCode(outDir: string, file: string, contract: string): Hex {
  const code = (JSON.parse(readFileSync(`${outDir}/${file}/${contract}.json`, "utf8")) as { bytecode: { object: string } }).bytecode.object;
  if (!/^0x[0-9a-f]+$/.test(code)) throw new Error(`${file}/${contract}: no creation code in the build`);
  return code as Hex;
}

/** Throws unless `implementation` is a version 2 vault bound to the chain's contracts and to `registry`. */
async function checkPrepared(client: PublicClient, p: Prepared): Promise<void> {
  const read = (address: Address, abi: Abi, functionName: string) => client.readContract({ address, abi, functionName });
  const same = (what: string, got: unknown, want: unknown) => {
    const norm = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : x);
    if (norm(got) !== norm(want)) throw new Error(`${what} is ${String(got)}, expected ${String(want)}`);
  };
  same("registry URI limit", await read(p.registry, ostraRegistryAbi, "MAX_URI_LENGTH"), VAULT_MAX_URI_LENGTH);
  same("implementation version", await read(p.implementation, ostraVaultAbi, "VERSION"), VAULT_VERSION);
  same("implementation registry", await read(p.implementation, ostraVaultAbi, "REGISTRY"), p.registry);
  same("implementation identity registry", await read(p.implementation, ostraVaultAbi, "IDENTITY_REGISTRY"), ERC8004_IDENTITY_REGISTRY);
  same("implementation settlement", await read(p.implementation, ostraVaultAbi, "BATCH_SETTLEMENT"), X402_BATCH_SETTLEMENT);
  same("implementation pool manager", await read(p.implementation, ostraVaultAbi, "POOL_MANAGER"), UNISWAP_V4_POOL_MANAGER);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "prepare" && command !== "finalize") throw new Error("usage: upgrade-vault.ts prepare | finalize");
  const keyFile = process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key";
  const rpcFile = process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url";
  const recordPath = process.env.OSTRA_DEPLOYMENT;
  if (recordPath === undefined || recordPath === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
  const statePath = `${recordPath}.vault-v2.json`;
  const outDir = process.env.OSTRA_OUT_DIR || fileURLToPath(new URL("../../out", import.meta.url));
  const rpcUrl = privateFile(rpcFile, "the RPC URL file");
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(redact(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)), rpcUrl));
  try {
    const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) }) as PublicClient;
    const chainId = await client.getChainId();
    if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`the RPC is chain ${chainId}, not Robinhood Chain (${ROBINHOOD_CHAIN_ID})`);
    const d = parseDeployment(JSON.parse(readFileSync(recordPath, "utf8")));
    if (d.chainId !== chainId) throw new Error(`${recordPath} is a deployment on chain ${d.chainId}`);
    const beaconImplementation = async () =>
      getAddress((await client.readContract({ address: d.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "implementation" })) as Address);

    if (command === "finalize") {
      if (d.registry !== undefined) {
        await checkDeployment(client, d);
        log("checked", { vaultImplementation: d.vaultImplementation, registry: d.registry });
        console.log("VAULT_V2_RECORDED");
        return;
      }
      if (!existsSync(statePath)) throw new Error(`no ${statePath}: run prepare first`);
      const p = JSON.parse(readFileSync(statePath, "utf8")) as Prepared;
      await checkPrepared(client, p);
      const now = await beaconImplementation();
      if (now !== getAddress(p.implementation)) throw new Error(`the vault beacon still points at ${now}: the scheduled upgrade to ${p.implementation} has not run`);
      const next: Deployment = { ...d, vaultImplementation: getAddress(p.implementation), registry: getAddress(p.registry) };
      await checkDeployment(client, next);
      writeJson(recordPath, next);
      unlinkSync(statePath);
      log("written", { record: recordPath, vaultImplementation: next.vaultImplementation, registry: next.registry, previous: d.vaultImplementation });
      console.log("VAULT_V2_RECORDED");
      return;
    }

    // prepare
    if (d.registry !== undefined) throw new Error("the record has a registry already: the vaults run version 2");
    await checkDeployment(client, d);
    const key = privateFile(keyFile, "the deployer key file");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyFile} does not hold a 32-byte hex private key`);
    const account = privateKeyToAccount(key as Hex);
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(rpcUrl) });
    const p: Partial<Prepared> = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Partial<Prepared>) : {};
    const has = async (a: Address | undefined) => a !== undefined && (await client.getCode({ address: a })) !== undefined;
    if (!(await has(p.registry)) || !(await has(p.implementation))) {
      const gasPrice = await client.getGasPrice();
      const balance = await client.getBalance({ address: account.address });
      log("deployer", { address: account.address, eth: formatEther(balance), gasPriceGwei: formatGwei(gasPrice) });
      if (balance < PREPARE_GAS_BUDGET * gasPrice) throw new Error(`the deployer holds ${formatEther(balance)} ETH; prepare needs up to ${formatEther(PREPARE_GAS_BUDGET * gasPrice)} ETH`);
    }
    const deploy = async (name: string, abi: Abi, bytecode: Hex, args: readonly unknown[]): Promise<Address> => {
      const hash = await wallet.deployContract({ abi, bytecode, args, account, chain: robinhoodChain });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success" || receipt.contractAddress === null || receipt.contractAddress === undefined) throw new Error(`${name}: deployment ${hash} failed`);
      const address = getAddress(receipt.contractAddress);
      log("deployed", { name, address, tx: hash, gasUsed: receipt.gasUsed });
      return address;
    };
    if (!(await has(p.registry))) {
      p.registry = await deploy("OstraRegistry", ostraRegistryAbi, creationCode(outDir, "OstraRegistry.sol", "OstraRegistry"), []);
      delete p.implementation;
      writeJson(statePath, p);
    }
    if (!(await has(p.implementation))) {
      p.implementation = await deploy("OstraVault", ostraVaultAbi, creationCode(outDir, "OstraVault.sol", "OstraVault"), [
        X402_BATCH_SETTLEMENT,
        UNISWAP_V4_POOL_MANAGER,
        p.registry,
        ERC8004_IDENTITY_REGISTRY,
      ]);
      writeJson(statePath, p);
    }
    const prepared = p as Prepared;
    await checkPrepared(client, prepared);
    const owner = getAddress((await client.readContract({ address: d.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "owner" })) as Address);
    log("prepared", { registry: prepared.registry, implementation: prepared.implementation, beacon: d.vaultBeacon, beaconOwner: owner, beaconImplementation: await beaconImplementation() });
    console.log(`next: node scripts/upgrade-owner.ts schedule-upgrade ${d.vaultBeacon} ${prepared.implementation}`);
    console.log("VAULT_V2_PREPARED");
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err), rpcUrl));
  }
}

main().catch((err: unknown) => {
  console.error(`upgrade-vault failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
