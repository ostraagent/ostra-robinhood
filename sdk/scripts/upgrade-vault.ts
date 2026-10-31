// Prepares and records the upgrade of every vault from OstraVault version 3 to version 4 (the venues: SetVenue,
// Enter, Exit and Forward into Raeto's vaults and ERC-4626 vaults, guard ops 5 and 6 and the venue breaker;
// src/OstraVault.sol, which runs its version 4 spends in src/OstraVaultModuleV4.sol and its version 3 spends in
// src/OstraVaultModule.sol), through the vault beacon, which OstraUpgradeOwner owns: the upgrade itself is a
// WOTS-signed call that waits 72 hours in public (scripts/upgrade-owner.ts). Versions 1 to 3's storage is unchanged
// and version 4's state sits at its own ERC-7201 slot, so every vault keeps its token, key, nonce, crank, guardians,
// channels, withdrawal lock, linked vault, hash approvals and Morpho positions; the live OstraRegistry carries over.
// Version 4 comes with a new OstraVaultModule too (a failed spend lands only for a sender with no code, so not for
// an EIP-7702 account), so the record's vaultModule changes with its vaultImplementation.
//
//   node scripts/upgrade-vault.ts prepare   deploys OstraVaultModule (bound to the live factory, Morpho Blue,
//                                            Morpho's VaultV2Factory, BorroBuilders, BorroRouter and Ostra's Borro
//                                            code), OstraVaultModuleV4 (bound to the live factory, Morpho's
//                                            VaultV2Factory and the ERC-8004 Identity Registry) and the version 4
//                                            implementation (bound to the live registry and the two modules; the
//                                            deployer key pays gas, it authorizes nothing), checks all three on chain
//                                            and prints the upgrade to schedule; run again, it resumes. It refuses
//                                            to start unless the build is the one of this checkout's sources
//   node scripts/upgrade-vault.ts finalize  once the scheduled upgrade has run: checks the beacon and writes the
//                                            record's vaultImplementation, vaultModule and vaultModuleV4
//
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) with the deployer's 32-byte hex private key (default
//                             /etc/ostra/deployer.key); never printed
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_DEPLOYMENT          the deployment record; finalize rewrites it
//   OSTRA_OUT_DIR             the Foundry build (default ../../out)
//
// What prepare deploys is kept next to the record (<record>.vault-v4.json) until finalize: each deployment's name, the
// deployer, its nonce and the address that nonce creates, written before the transaction is sent, so a run that stops
// half-way never deploys twice (code at a recorded address is adopted once it passes the code check below).
//
// prepare, finalize and upgrade-owner.ts schedule-upgrade (for the vault beacon) prove the three contracts are the
// reviewed code (checkPrepared): the Foundry build is the one of the sources in this checkout (every source the
// compiler's metadata of each artifact names, OpenZeppelin's included, has the keccak-256 the compiler recorded; the
// compiler's own record, which neither forge's cache nor file times can fool), and the code at each address is
// exactly the artifact's runtime code with its immutables filled in, their values taken from the artifact's creation
// code run with the recorded constructor arguments, as the recorded deployer at the recorded nonce (eth_call with a
// state override; the build has no metadata hash, bytecode_hash = "none", so nothing else may differ).

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatEther,
  formatGwei,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ostraVaultAbi, ostraVaultModuleAbi, ostraVaultModuleV4Abi, upgradeableBeaconAbi } from "../src/abi.ts";
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
  VAULT_V4,
  X402_BATCH_SETTLEMENT,
} from "../src/constants.ts";
import { checkDeployment, checkVaultModule, checkVaultModuleV4 } from "../src/deploy.ts";
import { parseDeployment, type Deployment } from "../src/deployment.ts";

/**
 * Gas prepare may use, for the balance check before anything is sent: the implementation's creation code is 25.5 KB
 * (24.2 KB deployed), OstraVaultModule's 17.9 KB (17.3 KB) and OstraVaultModuleV4's 15.5 KB (15.1 KB): 12.4 million
 * gas together on a fork of Robinhood Chain mainnet (5.32, 3.79 and 3.33 million), with room for the chain's data fee.
 */
export const PREPARE_GAS_BUDGET = 19_000_000n;

/** OpenZeppelin 5's Initializable storage (ERC-7201 "openzeppelin.storage.Initializable"), and its value once disabled. */
const INITIALIZABLE_SLOT: Hex = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
const INITIALIZED_FOR_GOOD = (1n << 64n) - 1n;

/** The repository the reviewed sources are in (the Foundry project root): this script's checkout. */
const SOURCE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** One deployment of prepare, recorded before it is sent: the deployer, its nonce and the address that nonce creates. */
export type Deployed = { name: string; deployer: Address; nonce: number; address: Address };
/** What prepare deployed (<record>.vault-v4.json). */
export type Prepared = { module: Deployed; moduleV4: Deployed; implementation: Deployed };
type Step = keyof Prepared;

/** The artifact of each step in the Foundry build: [file, contract]. */
const ARTIFACTS: Readonly<Record<Step, readonly [string, string]>> = {
  module: ["OstraVaultModule.sol", "OstraVaultModule"],
  moduleV4: ["OstraVaultModuleV4.sol", "OstraVaultModuleV4"],
  implementation: ["OstraVault.sol", "OstraVault"],
};
const ABIS: Readonly<Record<Step, Abi>> = { module: ostraVaultModuleAbi, moduleV4: ostraVaultModuleV4Abi, implementation: ostraVaultAbi };

type Artifact = {
  bytecode: { object: string };
  deployedBytecode: { object: string; immutableReferences?: Record<string, { start: number; length: number }[]> };
  metadata: { sources: Record<string, { keccak256: string }> };
};

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

function artifact(outDir: string, step: Step): Artifact {
  const [file, contract] = ARTIFACTS[step];
  const a = JSON.parse(readFileSync(`${outDir}/${file}/${contract}.json`, "utf8")) as Artifact;
  if (!/^0x[0-9a-f]+$/.test(a.bytecode.object) || !/^0x[0-9a-f]+$/.test(a.deployedBytecode.object)) throw new Error(`${file}/${contract}: no code in the build`);
  if (typeof a.metadata?.sources !== "object") throw new Error(`${file}/${contract}: no compiler metadata in the build`);
  return a;
}

/** The constructor arguments of each step, for the live `factory` and `registry` and the modules `p` names. */
function constructorArgs(step: Step, factory: Address, registry: Address, p: Partial<Prepared>): readonly unknown[] {
  if (step === "module") return [factory, MORPHO_BLUE, MORPHO_VAULT_V2_FACTORY, BORRO_BUILDERS, BORRO_ROUTER, BORRO_CODE];
  if (step === "moduleV4") return [factory, MORPHO_VAULT_V2_FACTORY, ERC8004_IDENTITY_REGISTRY];
  if (p.module === undefined || p.moduleV4 === undefined) throw new Error("the implementation names both modules: deploy them first");
  return [
    {
      batchSettlement: X402_BATCH_SETTLEMENT,
      poolManager: UNISWAP_V4_POOL_MANAGER,
      registry,
      identityRegistry: ERC8004_IDENTITY_REGISTRY,
      module: p.module.address,
      moduleV4: p.moduleV4.address,
    },
  ];
}

/**
 * Throws unless the build in `outDir` of the three contracts is the one of the sources in this checkout: every source
 * the compiler's metadata of each artifact names has the keccak-256 the compiler recorded.
 */
export function checkBuildCurrent(outDir: string): void {
  for (const step of Object.keys(ARTIFACTS) as Step[]) {
    const [file, contract] = ARTIFACTS[step];
    for (const [path, { keccak256: recorded }] of Object.entries(artifact(outDir, step).metadata.sources)) {
      const full = join(SOURCE_ROOT, path);
      if (!existsSync(full)) throw new Error(`the build of ${contract} (${file}) names ${path}, which is not in this checkout: run forge build`);
      if (keccak256(readFileSync(full)) !== recorded.toLowerCase()) throw new Error(`the build of ${contract} (${file}) is not of the ${path} in this checkout: run forge build`);
    }
  }
}

/**
 * Throws unless the code at `d.address` is exactly the build's runtime code of `step`: the artifact's deployedBytecode
 * with each immutable reference filled in with the value the constructor writes, run here from the artifact's creation
 * code with `args`, as `d.deployer` at its nonce `d.nonce` (so address(this) and what derives from it, such as the
 * EIP-712 domain, are those of `d.address`); every use of one immutable holds the same value, and nothing outside the
 * references differs.
 */
export async function checkDeployedCode(client: PublicClient, outDir: string, step: Step, d: Deployed, args: readonly unknown[]): Promise<void> {
  const [file, contract] = ARTIFACTS[step];
  const what = `${contract} at ${d.address}`;
  if (getContractAddress({ from: d.deployer, nonce: BigInt(d.nonce) }) !== getAddress(d.address)) throw new Error(`${what}: not the address ${d.deployer} creates at nonce ${d.nonce}`);
  const a = artifact(outDir, step);
  const data = encodeDeployData({ abi: ABIS[step], bytecode: a.bytecode.object as Hex, args });
  // The address itself as it was before the deployment (no code, nonce 0), so the creation runs there again.
  const built = (
    await client.call({ account: d.deployer, data, stateOverride: [{ address: d.deployer, nonce: d.nonce }, { address: d.address, code: "0x", nonce: 0 }] })
  ).data?.toLowerCase();
  const want = a.deployedBytecode.object.toLowerCase();
  if (built === undefined || built.length !== want.length) throw new Error(`${what}: ${file}/${contract}'s creation code does not make its runtime code`);
  const filled = [...want];
  for (const [id, refs] of Object.entries(a.deployedBytecode.immutableReferences ?? {})) {
    const values = new Set(refs.map(({ start, length }) => built.slice(2 + 2 * start, 2 + 2 * (start + length))));
    if (values.size !== 1) throw new Error(`${what}: immutable ${id} is built with different values`);
    const [value] = [...values] as [string];
    for (const { start } of refs) filled.splice(2 + 2 * start, value.length, ...value);
  }
  const expected = filled.join("");
  if (expected !== built) throw new Error(`${what}: ${file}/${contract}'s creation code makes other runtime code than its deployedBytecode`);
  const code = (await client.getCode({ address: d.address }))?.toLowerCase();
  if (code !== expected) throw new Error(`${what}: the code there is not this build's ${contract}`);
}

/**
 * Throws unless `p` is what prepare deploys for the record `d` and is the reviewed code: the build is current
 * (checkBuildCurrent), each contract's code is exactly the build's (checkDeployedCode), and the implementation is a
 * version 4 vault bound to the chain's contracts, to the record's registry and to the two modules, both bound to its
 * factory.
 */
export async function checkPrepared(client: PublicClient, outDir: string, p: Prepared, d: Deployment): Promise<void> {
  if (d.registry === undefined) throw new Error("the record has no registry: the vaults run version 1");
  const registry = d.registry;
  const factory = d.vaultFactory;
  checkBuildCurrent(outDir);
  for (const step of Object.keys(ARTIFACTS) as Step[]) await checkDeployedCode(client, outDir, step, p[step], constructorArgs(step, factory, registry, p));
  const read = (address: Address, abi: Abi, functionName: string) => client.readContract({ address, abi, functionName });
  const same = (what: string, got: unknown, want: unknown) => {
    const norm = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : x);
    if (norm(got) !== norm(want)) throw new Error(`${what} is ${String(got)}, expected ${String(want)}`);
  };
  const implementation = p.implementation.address;
  same("implementation version", await read(implementation, ostraVaultAbi, "VERSION"), VAULT_V4);
  same("implementation registry", await read(implementation, ostraVaultAbi, "REGISTRY"), registry);
  same("implementation identity registry", await read(implementation, ostraVaultAbi, "IDENTITY_REGISTRY"), ERC8004_IDENTITY_REGISTRY);
  same("implementation settlement", await read(implementation, ostraVaultAbi, "BATCH_SETTLEMENT"), X402_BATCH_SETTLEMENT);
  same("implementation pool manager", await read(implementation, ostraVaultAbi, "POOL_MANAGER"), UNISWAP_V4_POOL_MANAGER);
  await checkVaultModule(client, implementation, p.module.address, factory);
  await checkVaultModuleV4(client, implementation, p.moduleV4.address, factory);
  // The implementation itself can never be initialized (its constructor's _disableInitializers): OpenZeppelin 5's
  // Initializable slot holds _initialized type(uint64).max and _initializing false, nothing else.
  const initializable = await client.getStorageAt({ address: implementation, slot: INITIALIZABLE_SLOT });
  if (initializable === undefined || BigInt(initializable) !== INITIALIZED_FOR_GOOD) throw new Error(`implementation ${implementation}: its Initializable slot is ${String(initializable)}, not disabled for good`);
}

/**
 * What prepare recorded next to `recordPath` (<record>.vault-v4.json), every deployment present and all three by one
 * deployer (the deployment record names none, so they are held to each other); throws when it is not so.
 */
export function readPrepared(recordPath: string): Prepared {
  const statePath = `${recordPath}.vault-v4.json`;
  if (!existsSync(statePath)) throw new Error(`no ${statePath}: run upgrade-vault.ts prepare first`);
  const p = JSON.parse(readFileSync(statePath, "utf8")) as Partial<Prepared>;
  for (const step of Object.keys(ARTIFACTS) as Step[]) {
    const s = p[step];
    if (s === undefined || typeof s.address !== "string" || typeof s.deployer !== "string" || !Number.isSafeInteger(s.nonce)) throw new Error(`${statePath} has no finished ${step} deployment: run upgrade-vault.ts prepare again`);
  }
  const prepared = p as Prepared;
  const deployers = new Set((Object.keys(ARTIFACTS) as Step[]).map((step) => getAddress(prepared[step].deployer)));
  if (deployers.size !== 1) throw new Error(`${statePath} names more than one deployer (${[...deployers].join(", ")}): prepare deploys all three from one account`);
  return prepared;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "prepare" && command !== "finalize") throw new Error("usage: upgrade-vault.ts prepare | finalize");
  const keyFile = process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key";
  const rpcFile = process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url";
  const recordPath = process.env.OSTRA_DEPLOYMENT;
  if (recordPath === undefined || recordPath === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
  const statePath = `${recordPath}.vault-v4.json`;
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
      if (d.vaultModuleV4 !== undefined) {
        await checkDeployment(client, d);
        log("checked", { vaultImplementation: d.vaultImplementation, vaultModule: d.vaultModule, vaultModuleV4: d.vaultModuleV4 });
        console.log("VAULT_V4_RECORDED");
        return;
      }
      const p = readPrepared(recordPath);
      await checkPrepared(client, outDir, p, d);
      const now = await beaconImplementation();
      if (now !== getAddress(p.implementation.address)) throw new Error(`the vault beacon still points at ${now}: the scheduled upgrade to ${p.implementation.address} has not run`);
      const next: Deployment = {
        ...d,
        vaultImplementation: getAddress(p.implementation.address),
        vaultModule: getAddress(p.module.address),
        vaultModuleV4: getAddress(p.moduleV4.address),
      };
      await checkDeployment(client, next);
      writeJson(recordPath, next);
      unlinkSync(statePath);
      log("written", {
        record: recordPath,
        vaultImplementation: next.vaultImplementation,
        vaultModule: next.vaultModule,
        vaultModuleV4: next.vaultModuleV4,
        previous: d.vaultImplementation,
        previousModule: d.vaultModule,
      });
      console.log("VAULT_V4_RECORDED");
      return;
    }

    // prepare
    if (d.vaultModuleV4 !== undefined) throw new Error("the record has a vault module V4 already: the vaults run version 4");
    if (d.vaultModule === undefined) throw new Error("the record has no vault module: the vaults run version 2 (upgrade to version 3 first)");
    checkBuildCurrent(outDir);
    await checkDeployment(client, d);
    const key = privateFile(keyFile, "the deployer key file");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyFile} does not hold a 32-byte hex private key`);
    const account = privateKeyToAccount(key as Hex);
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(rpcUrl) });
    const p: Partial<Prepared> = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Partial<Prepared>) : {};
    const has = async (s: Deployed | undefined) => s !== undefined && (await client.getCode({ address: s.address })) !== undefined;
    if (!(await has(p.module)) || !(await has(p.moduleV4)) || !(await has(p.implementation))) {
      const gasPrice = await client.getGasPrice();
      const balance = await client.getBalance({ address: account.address });
      log("deployer", { address: account.address, eth: formatEther(balance), gasPriceGwei: formatGwei(gasPrice) });
      if (balance < PREPARE_GAS_BUDGET * gasPrice) throw new Error(`the deployer holds ${formatEther(balance)} ETH; prepare needs up to ${formatEther(PREPARE_GAS_BUDGET * gasPrice)} ETH`);
    }
    /**
     * The contract of `step`: adopted when its recorded address has code that passes checkDeployedCode, else deployed
     * at the deployer's next nonce, recorded (name, deployer, nonce, address) before the transaction is sent.
     */
    const ensure = async (step: Step): Promise<void> => {
      const [file, contract] = ARTIFACTS[step];
      const args = constructorArgs(step, d.vaultFactory, registry, p);
      const recorded = p[step];
      // Only this script's account is adopted or waited for: a state file naming another deployer is refused.
      if (recorded !== undefined && getAddress(recorded.deployer) !== account.address) {
        throw new Error(`${statePath} records ${contract} as deployed by ${recorded.deployer}, not by this deployer (${account.address})`);
      }
      if (recorded !== undefined) {
        if (await has(recorded)) {
          await checkDeployedCode(client, outDir, step, recorded, args);
          log("adopted", { ...recorded });
          return;
        }
        // Nothing there yet: a transaction of it may still be pending (wait for it), or it never landed (deploy anew).
        const mined = await client.getTransactionCount({ address: account.address, blockTag: "latest" });
        const pending = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
        if (mined <= recorded.nonce && pending > recorded.nonce) throw new Error(`${contract}: its deployment at nonce ${recorded.nonce} (${recorded.address}) is still pending; run again once it is mined`);
      }
      const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
      const next: Deployed = { name: contract, deployer: account.address, nonce, address: getContractAddress({ from: account.address, nonce: BigInt(nonce) }) };
      p[step] = next;
      // The implementation names the modules: a module deployed anew means a new implementation too.
      if (step !== "implementation") delete p.implementation;
      writeJson(statePath, p);
      log("deploying", { ...next });
      const hash = await wallet.deployContract({ abi: ABIS[step], bytecode: artifact(outDir, step).bytecode.object as Hex, args, account, chain: robinhoodChain, nonce });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success" || receipt.contractAddress === null || receipt.contractAddress === undefined) throw new Error(`${contract} (${file}): deployment ${hash} failed`);
      if (getAddress(receipt.contractAddress) !== next.address) throw new Error(`${contract}: deployed at ${receipt.contractAddress}, not at the recorded ${next.address}`);
      log("deployed", { name: contract, address: next.address, tx: hash, gasUsed: receipt.gasUsed });
    };
    for (const step of Object.keys(ARTIFACTS) as Step[]) await ensure(step);
    const prepared = readPrepared(recordPath);
    await checkPrepared(client, outDir, prepared, d);
    const owner = getAddress((await client.readContract({ address: d.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "owner" })) as Address);
    log("prepared", {
      module: prepared.module.address,
      moduleV4: prepared.moduleV4.address,
      implementation: prepared.implementation.address,
      beacon: d.vaultBeacon,
      beaconOwner: owner,
      beaconImplementation: await beaconImplementation(),
    });
    console.log(`next: node scripts/upgrade-owner.ts schedule-upgrade ${d.vaultBeacon} ${prepared.implementation.address}`);
    console.log("VAULT_V4_PREPARED");
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err), rpcUrl));
  }
}

// Run as a script; imported (by upgrade-owner.ts, for checkPrepared), nothing runs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`upgrade-vault failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
