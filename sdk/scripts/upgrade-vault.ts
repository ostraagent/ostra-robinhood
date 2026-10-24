// Prepares and records the upgrade of every vault to OstraVault version 3 (the withdrawal lock, linked vaults, the
// Morpho and Borro spends, EIP-1271 and Guard; src/OstraVault.sol, which runs its version 3 spends in
// src/OstraVaultModule.sol), through the vault beacon, which OstraUpgradeOwner owns: the upgrade itself is a
// WOTS-signed call that waits 72 hours in public (scripts/upgrade-owner.ts). Versions 1 and 2's storage is unchanged
// and version 3's state sits at its own ERC-7201 slot, so every vault keeps its token, key, nonce, crank, guardians
// and channels; the live OstraRegistry carries over.
//
//   node scripts/upgrade-vault.ts prepare   deploys OstraVaultModule (bound to the live factory, Morpho Blue,
//                                            Morpho's VaultV2Factory, BorroBuilders, BorroRouter and Ostra's Borro
//                                            code) and the version 3 implementation (bound to the live registry and
//                                            the module; the deployer key pays gas, it authorizes nothing), checks
//                                            both on chain and prints the upgrade to schedule; run again, it resumes
//   node scripts/upgrade-vault.ts finalize  once the scheduled upgrade has run: checks the beacon and writes the
//                                            record's vaultImplementation and vaultModule
//
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) with the deployer's 32-byte hex private key (default
//                             /etc/ostra/deployer.key); never printed
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_DEPLOYMENT          the deployment record; finalize rewrites it
//   OSTRA_OUT_DIR             the Foundry build (default ../../out)
//
// What prepare deployed is kept next to the record (<record>.vault-v3.json) until finalize, so a run that stops
// half-way never deploys twice.

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, formatGwei, getAddress, http, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ostraVaultAbi, ostraVaultModuleAbi, upgradeableBeaconAbi } from "../src/abi.ts";
import { redact, robinhoodChain } from "../src/chain.ts";
import {
  BORRO_BUILDERS,
  BORRO_CODE,
  BORRO_ROUTER,
  ERC8004_IDENTITY_REGISTRY,
  MORPHO_BLUE,
  MORPHO_VAULT_V2_FACTORY,
  ROBINHOOD_CHAIN_ID,
  UNISWAP_V4_POOL_MANAGER,
  VAULT_V3,
  X402_BATCH_SETTLEMENT,
} from "../src/constants.ts";
import { checkDeployment, checkVaultModule } from "../src/deploy.ts";
import { parseDeployment, type Deployment } from "../src/deployment.ts";

/** Gas prepare may use, for the balance check before anything is sent: the implementation is about 23 KB of code and the module about 17 KB (about 9 million gas together), with room for the chain's data fee. */
export const PREPARE_GAS_BUDGET = 14_000_000n;

type Prepared = { module: Address; implementation: Address };

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

/** Throws unless `implementation` is a version 3 vault bound to the chain's contracts, to `registry` and to `module`, itself bound to `factory`. */
async function checkPrepared(client: PublicClient, p: Prepared, registry: Address, factory: Address): Promise<void> {
  const read = (address: Address, abi: Abi, functionName: string) => client.readContract({ address, abi, functionName });
  const same = (what: string, got: unknown, want: unknown) => {
    const norm = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : x);
    if (norm(got) !== norm(want)) throw new Error(`${what} is ${String(got)}, expected ${String(want)}`);
  };
  same("implementation version", await read(p.implementation, ostraVaultAbi, "VERSION"), VAULT_V3);
  same("implementation registry", await read(p.implementation, ostraVaultAbi, "REGISTRY"), registry);
  same("implementation identity registry", await read(p.implementation, ostraVaultAbi, "IDENTITY_REGISTRY"), ERC8004_IDENTITY_REGISTRY);
  same("implementation settlement", await read(p.implementation, ostraVaultAbi, "BATCH_SETTLEMENT"), X402_BATCH_SETTLEMENT);
  same("implementation pool manager", await read(p.implementation, ostraVaultAbi, "POOL_MANAGER"), UNISWAP_V4_POOL_MANAGER);
  await checkVaultModule(client, p.implementation, p.module, factory);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "prepare" && command !== "finalize") throw new Error("usage: upgrade-vault.ts prepare | finalize");
  const keyFile = process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key";
  const rpcFile = process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url";
  const recordPath = process.env.OSTRA_DEPLOYMENT;
  if (recordPath === undefined || recordPath === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
  const statePath = `${recordPath}.vault-v3.json`;
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

    if (d.registry === undefined) throw new Error("the record has no registry: the vaults run version 1 (upgrade to version 2 first)");
    const registry = d.registry;
    if (command === "finalize") {
      if (d.vaultModule !== undefined) {
        await checkDeployment(client, d);
        log("checked", { vaultImplementation: d.vaultImplementation, vaultModule: d.vaultModule });
        console.log("VAULT_V3_RECORDED");
        return;
      }
      if (!existsSync(statePath)) throw new Error(`no ${statePath}: run prepare first`);
      const p = JSON.parse(readFileSync(statePath, "utf8")) as Prepared;
      await checkPrepared(client, p, registry, d.vaultFactory);
      const now = await beaconImplementation();
      if (now !== getAddress(p.implementation)) throw new Error(`the vault beacon still points at ${now}: the scheduled upgrade to ${p.implementation} has not run`);
      const next: Deployment = { ...d, vaultImplementation: getAddress(p.implementation), vaultModule: getAddress(p.module) };
      await checkDeployment(client, next);
      writeJson(recordPath, next);
      unlinkSync(statePath);
      log("written", { record: recordPath, vaultImplementation: next.vaultImplementation, vaultModule: next.vaultModule, previous: d.vaultImplementation });
      console.log("VAULT_V3_RECORDED");
      return;
    }

    // prepare
    if (d.vaultModule !== undefined) throw new Error("the record has a vault module already: the vaults run version 3");
    await checkDeployment(client, d);
    const key = privateFile(keyFile, "the deployer key file");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyFile} does not hold a 32-byte hex private key`);
    const account = privateKeyToAccount(key as Hex);
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(rpcUrl) });
    const p: Partial<Prepared> = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Partial<Prepared>) : {};
    const has = async (a: Address | undefined) => a !== undefined && (await client.getCode({ address: a })) !== undefined;
    if (!(await has(p.module)) || !(await has(p.implementation))) {
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
    if (!(await has(p.module))) {
      p.module = await deploy("OstraVaultModule", ostraVaultModuleAbi, creationCode(outDir, "OstraVaultModule.sol", "OstraVaultModule"), [
        d.vaultFactory,
        MORPHO_BLUE,
        MORPHO_VAULT_V2_FACTORY,
        BORRO_BUILDERS,
        BORRO_ROUTER,
        BORRO_CODE,
      ]);
      delete p.implementation;
      writeJson(statePath, p);
    }
    if (!(await has(p.implementation))) {
      p.implementation = await deploy("OstraVault", ostraVaultAbi, creationCode(outDir, "OstraVault.sol", "OstraVault"), [
        {
          batchSettlement: X402_BATCH_SETTLEMENT,
          poolManager: UNISWAP_V4_POOL_MANAGER,
          registry,
          identityRegistry: ERC8004_IDENTITY_REGISTRY,
          module: p.module,
        },
      ]);
      writeJson(statePath, p);
    }
    const prepared = p as Prepared;
    await checkPrepared(client, prepared, registry, d.vaultFactory);
    const owner = getAddress((await client.readContract({ address: d.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "owner" })) as Address);
    log("prepared", { module: prepared.module, implementation: prepared.implementation, beacon: d.vaultBeacon, beaconOwner: owner, beaconImplementation: await beaconImplementation() });
    console.log(`next: node scripts/upgrade-owner.ts schedule-upgrade ${d.vaultBeacon} ${prepared.implementation}`);
    console.log("VAULT_V3_PREPARED");
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err), rpcUrl));
  }
}

main().catch((err: unknown) => {
  console.error(`upgrade-vault failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
