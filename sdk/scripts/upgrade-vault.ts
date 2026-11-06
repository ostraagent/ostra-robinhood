// Prepares and records the upgrade of every vault from OstraVault version 4 to version 5 (the agent key, its policy and
// allowlists, standing orders and Priors credit: spends 29 to 46, spendAsAgent, runOrder, repayDue, guard ops 7 and 8;
// src/OstraVault.sol, which runs its version 5 spends in src/OstraVaultModuleV5.sol), through the vault beacon, which
// OstraUpgradeOwner owns: the upgrade itself is a WOTS-signed call that waits 72 hours in public
// (scripts/upgrade-owner.ts). Versions 1 to 4's storage is unchanged and version 5's state sits at its own ERC-7201
// slot, so every vault keeps its token, key, nonce, crank, guardians, channels, withdrawal lock, linked vault, hash
// approvals, Morpho positions and venues, and starts version 5 with no agent key, no policy and no order. Version 5
// keeps the live OstraVaultModule and OstraVaultModuleV4 (their deployed code, unchanged): only OstraVaultModuleV5
// and the implementation are new.
//
//   node scripts/upgrade-vault.ts prepare     deploys OstraVaultModuleV5 (bound to the live factory, the live module V4,
//                                              the Priors pool and its code hash, USDG, the ERC-8004 Identity Registry
//                                              and OstraPad) and the version 5 implementation (bound to the live
//                                              registry and the three modules; the deployer key pays gas, it authorizes
//                                              nothing), checks both on chain, scans the live vaults' locks and prints
//                                              the upgrade to schedule; run again, it resumes. It refuses to start
//                                              unless the build is the one of this checkout's sources
//   node scripts/upgrade-vault.ts scan-locks  the scan alone (upgrade-owner.ts execute runs it again before the
//                                              upgrade): every vault the factory made whose withdrawal lock, in force
//                                              or waiting, names an address with no code
//   node scripts/upgrade-vault.ts finalize    once the scheduled upgrade has run: checks the beacon and writes the
//                                              record's vaultImplementation and vaultModuleV5
//
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) with the deployer's 32-byte hex private key (default
//                             /etc/ostra/deployer.key); never printed
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_LOGS_RPC_URL        RPC the scan reads the factory's VaultCreated logs from (default the public RPC, which
//                             serves wide block ranges)
//   OSTRA_DEPLOYMENT          the deployment record; finalize rewrites it
//   OSTRA_OUT_DIR             the Foundry build (default ../../out)
//
// Why the scan: version 5 refuses a new withdrawal address with no code (an Ostra vault not created yet at such an
// address could be created later, unlocked, by whoever holds the seed), but a lock chosen under version 4 stays. Before
// the upgrade, every such lock is listed, so that its owner can be told; upgrade-owner.ts execute refuses to run the
// upgrade while one exists unless OSTRA_ACCEPT_CODELESS_LOCKS names each such vault (comma separated), once checked.
//
// What prepare deploys is kept next to the record (<record>.vault-v5.json) until finalize: each deployment's name, the
// deployer, its nonce and the address that nonce creates, written before the transaction is sent, so a run that stops
// half-way never deploys twice (code at a recorded address is adopted once it passes the code check below).
//
// prepare, finalize and upgrade-owner.ts schedule-upgrade (for the vault beacon) prove the two contracts are the
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
import { ostraVaultAbi, ostraVaultModuleV5Abi, upgradeableBeaconAbi } from "../src/abi.ts";
import { redact, robinhoodChain } from "../src/chain.ts";
import {
  ERC8004_IDENTITY_REGISTRY,
  OSTRA_REGISTRY,
  OSTRA_VAULT_MODULE,
  OSTRA_VAULT_MODULE_V4,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_PUBLIC_RPC,
  UNISWAP_V4_POOL_MANAGER,
  VAULT_V5,
  X402_BATCH_SETTLEMENT,
} from "../src/constants.ts";
import { checkDeployment, checkVaultModule, checkVaultModuleV4, checkVaultModuleV5, vaultModuleV5Args } from "../src/deploy.ts";
import { parseDeployment, type Deployment } from "../src/deployment.ts";
import { listOstraVaults } from "../src/strategy.ts";

/**
 * Gas prepare may use, for the balance check before anything is sent: OstraVaultModuleV5's creation code is 35.8 KB
 * (34.7 KB deployed) and the implementation's 32.8 KB (31.1 KB): 14.4 million gas together on a fork of Robinhood
 * Chain mainnet (7.58 and 6.82 million), with room for the chain's data fee.
 */
export const PREPARE_GAS_BUDGET = 22_000_000n;

/** OpenZeppelin 5's Initializable storage (ERC-7201 "openzeppelin.storage.Initializable"), and its value once disabled. */
const INITIALIZABLE_SLOT: Hex = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
const INITIALIZED_FOR_GOOD = (1n << 64n) - 1n;

/** The repository the reviewed sources are in (the Foundry project root): this script's checkout. */
const SOURCE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** One deployment of prepare, recorded before it is sent: the deployer, its nonce and the address that nonce creates. */
export type Deployed = { name: string; deployer: Address; nonce: number; address: Address };
/** What prepare deployed (<record>.vault-v5.json). */
export type Prepared = { moduleV5: Deployed; implementation: Deployed };
type Step = keyof Prepared;

/** The state file prepare keeps next to the record until finalize. */
export const preparedPath = (recordPath: string) => `${recordPath}.vault-v5.json`;

/** The artifact of each step in the Foundry build: [file, contract]. */
const ARTIFACTS: Readonly<Record<Step, readonly [string, string]>> = {
  moduleV5: ["OstraVaultModuleV5.sol", "OstraVaultModuleV5"],
  implementation: ["OstraVault.sol", "OstraVault"],
};
const ABIS: Readonly<Record<Step, Abi>> = { moduleV5: ostraVaultModuleV5Abi, implementation: ostraVaultAbi };

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

/**
 * The live registry and modules, which version 5 keeps: the pinned addresses (OSTRA_REGISTRY, OSTRA_VAULT_MODULE,
 * OSTRA_VAULT_MODULE_V4), never what a record file names; throws unless the record is a version 4 one naming them.
 */
function liveModules(d: Deployment): { registry: Address; module: Address; moduleV4: Address } {
  if (d.registry === undefined || d.vaultModule === undefined || d.vaultModuleV4 === undefined) {
    throw new Error("the record has no registry, vault module or vault module V4: the vaults do not run version 4");
  }
  if (getAddress(d.registry) !== OSTRA_REGISTRY || getAddress(d.vaultModule) !== OSTRA_VAULT_MODULE || getAddress(d.vaultModuleV4) !== OSTRA_VAULT_MODULE_V4) {
    throw new Error(`the record's registry, vault module or vault module V4 is not the live one (${OSTRA_REGISTRY}, ${OSTRA_VAULT_MODULE}, ${OSTRA_VAULT_MODULE_V4})`);
  }
  return { registry: OSTRA_REGISTRY, module: OSTRA_VAULT_MODULE, moduleV4: OSTRA_VAULT_MODULE_V4 };
}

/** The constructor arguments of each step, for the live record `d` and the module V5 `p` names. */
function constructorArgs(step: Step, d: Deployment, p: Partial<Prepared>): readonly unknown[] {
  const live = liveModules(d);
  if (step === "moduleV5") return vaultModuleV5Args(d.vaultFactory, live.moduleV4);
  if (p.moduleV5 === undefined) throw new Error("the implementation names module V5: deploy it first");
  return [
    {
      batchSettlement: X402_BATCH_SETTLEMENT,
      poolManager: UNISWAP_V4_POOL_MANAGER,
      registry: live.registry,
      identityRegistry: ERC8004_IDENTITY_REGISTRY,
      module: live.module,
      moduleV4: live.moduleV4,
      moduleV5: p.moduleV5.address,
    },
  ];
}

/**
 * Throws unless the build in `outDir` of the two contracts is the one of the sources in this checkout: every source
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
 * version 5 vault bound to the chain's contracts, to the record's registry, to the record's module and module V4 and to
 * the new module V5, which is bound to the record's factory and module V4.
 */
export async function checkPrepared(client: PublicClient, outDir: string, p: Prepared, d: Deployment): Promise<void> {
  const { registry, module, moduleV4 } = liveModules(d);
  const factory = d.vaultFactory;
  checkBuildCurrent(outDir);
  for (const step of Object.keys(ARTIFACTS) as Step[]) await checkDeployedCode(client, outDir, step, p[step], constructorArgs(step, d, p));
  const read = (address: Address, abi: Abi, functionName: string) => client.readContract({ address, abi, functionName });
  const same = (what: string, got: unknown, want: unknown) => {
    const norm = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : x);
    if (norm(got) !== norm(want)) throw new Error(`${what} is ${String(got)}, expected ${String(want)}`);
  };
  const implementation = p.implementation.address;
  same("implementation version", await read(implementation, ostraVaultAbi, "VERSION"), VAULT_V5);
  same("implementation registry", await read(implementation, ostraVaultAbi, "REGISTRY"), registry);
  same("implementation identity registry", await read(implementation, ostraVaultAbi, "IDENTITY_REGISTRY"), ERC8004_IDENTITY_REGISTRY);
  same("implementation settlement", await read(implementation, ostraVaultAbi, "BATCH_SETTLEMENT"), X402_BATCH_SETTLEMENT);
  same("implementation pool manager", await read(implementation, ostraVaultAbi, "POOL_MANAGER"), UNISWAP_V4_POOL_MANAGER);
  await checkVaultModule(client, implementation, module, factory);
  await checkVaultModuleV4(client, implementation, moduleV4, factory);
  await checkVaultModuleV5(client, implementation, p.moduleV5.address, moduleV4, factory);
  // The implementation itself can never be initialized (its constructor's _disableInitializers): OpenZeppelin 5's
  // Initializable slot holds _initialized type(uint64).max and _initializing false, nothing else.
  const initializable = await client.getStorageAt({ address: implementation, slot: INITIALIZABLE_SLOT });
  if (initializable === undefined || BigInt(initializable) !== INITIALIZED_FOR_GOOD) throw new Error(`implementation ${implementation}: its Initializable slot is ${String(initializable)}, not disabled for good`);
}

/**
 * What prepare recorded next to `recordPath` (<record>.vault-v5.json), every deployment present and both by one
 * deployer (the deployment record names none, so they are held to each other); throws when it is not so.
 */
export function readPrepared(recordPath: string): Prepared {
  const statePath = preparedPath(recordPath);
  if (!existsSync(statePath)) throw new Error(`no ${statePath}: run upgrade-vault.ts prepare first`);
  const p = JSON.parse(readFileSync(statePath, "utf8")) as Partial<Prepared>;
  for (const step of Object.keys(ARTIFACTS) as Step[]) {
    const s = p[step];
    if (s === undefined || typeof s.address !== "string" || typeof s.deployer !== "string" || !Number.isSafeInteger(s.nonce)) throw new Error(`${statePath} has no finished ${step} deployment: run upgrade-vault.ts prepare again`);
  }
  const prepared = p as Prepared;
  const deployers = new Set((Object.keys(ARTIFACTS) as Step[]).map((step) => getAddress(prepared[step].deployer)));
  if (deployers.size !== 1) throw new Error(`${statePath} names more than one deployer (${[...deployers].join(", ")}): prepare deploys both from one account`);
  return prepared;
}

/** A vault whose withdrawal lock, in force or waiting, names an address with no code. */
export type CodelessLock = { vault: Address; withdrawal: Address; waiting: boolean };

/** How long the scan waits for its logs RPC to reach the state RPC's head (the public RPC trailed by 4 blocks on 6 Nov 2026). */
export const LOGS_CATCH_UP_MS = 60_000;

/**
 * The state RPC's head, once the logs RPC has reached it: a logs RPC behind it is waited for (polled each second) and
 * never trusted short of that block; still behind after `timeoutMs`, refused.
 */
export async function logsHeadReached(client: PublicClient, logsClient: PublicClient, timeoutMs: number = LOGS_CATCH_UP_MS): Promise<bigint> {
  const toBlock = await client.getBlockNumber({ cacheTime: 0 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const logsHead = await logsClient.getBlockNumber({ cacheTime: 0 });
    if (logsHead >= toBlock) return toBlock;
    if (Date.now() >= deadline) throw new Error(`the logs RPC is at block ${logsHead}, still behind the state RPC's ${toBlock} after ${timeoutMs / 1000} s: run the scan again`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * Every vault `d`'s factory made (its VaultCreated logs, read through `logsClient`) whose withdrawal lock in force, or
 * whose waiting lock change, names an address with no code: such a lock, chosen under version 4, stays under version 5.
 */
export async function scanCodelessLocks(client: PublicClient, logsClient: PublicClient, d: Deployment): Promise<{ vaults: number; locked: number; codeless: CodelessLock[] }> {
  // Every vault up to the head of the RPC the state is read from, once the logs RPC has reached it.
  const toBlock = await logsHeadReached(client, logsClient);
  const vaults = await listOstraVaults(logsClient, d.vaultFactory, BigInt(d.fromBlock), toBlock);
  const codeless: CodelessLock[] = [];
  let locked = 0;
  const noCode = async (a: Address) => {
    const code = await client.getCode({ address: a });
    return code === undefined || code === "0x";
  };
  for (const { vault } of vaults) {
    const lock = (await client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "withdrawalLock" })) as { withdrawal: Address };
    const [pending] = (await client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "pendingChanges" })) as readonly [{ withdrawal: Address }, bigint, Address, bigint];
    const zero = (a: Address) => BigInt(a) === 0n;
    if (!zero(lock.withdrawal)) {
      ++locked;
      if (await noCode(lock.withdrawal)) codeless.push({ vault, withdrawal: getAddress(lock.withdrawal), waiting: false });
    }
    if (!zero(pending.withdrawal) && (await noCode(pending.withdrawal))) codeless.push({ vault, withdrawal: getAddress(pending.withdrawal), waiting: true });
  }
  return { vaults: vaults.length, locked, codeless };
}

/** The client the scan reads logs through: OSTRA_LOGS_RPC_URL, else the public RPC (wide block ranges). */
export function logsClientFromEnv(): PublicClient {
  const url = process.env.OSTRA_LOGS_RPC_URL || ROBINHOOD_PUBLIC_RPC;
  return createPublicClient({ chain: robinhoodChain, transport: http(url) }) as PublicClient;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "prepare" && command !== "finalize" && command !== "scan-locks") throw new Error("usage: upgrade-vault.ts prepare | scan-locks | finalize");
  const keyFile = process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key";
  const rpcFile = process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url";
  const recordPath = process.env.OSTRA_DEPLOYMENT;
  if (recordPath === undefined || recordPath === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
  const statePath = preparedPath(recordPath);
  const outDir = process.env.OSTRA_OUT_DIR || fileURLToPath(new URL("../../out", import.meta.url));
  const rpcUrl = privateFile(rpcFile, "the RPC URL file");
  // Both RPC URLs may carry an API key in their path: neither is ever printed.
  const hide = (text: string) => redact(redact(text, rpcUrl), process.env.OSTRA_LOGS_RPC_URL ?? "");
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(hide(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v))));
  try {
    const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) }) as PublicClient;
    const chainId = await client.getChainId();
    if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`the RPC is chain ${chainId}, not Robinhood Chain (${ROBINHOOD_CHAIN_ID})`);
    const d = parseDeployment(JSON.parse(readFileSync(recordPath, "utf8")));
    if (d.chainId !== chainId) throw new Error(`${recordPath} is a deployment on chain ${d.chainId}`);
    const beaconImplementation = async () =>
      getAddress((await client.readContract({ address: d.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "implementation" })) as Address);
    const scan = async () => {
      const r = await scanCodelessLocks(client, logsClientFromEnv(), d);
      for (const c of r.codeless) log("codeless_lock", { ...c });
      log("locks_scanned", { vaults: r.vaults, locked: r.locked, codeless: r.codeless.length });
      return r;
    };

    if (command === "scan-locks") {
      await scan();
      console.log("VAULT_LOCKS_SCANNED");
      return;
    }
    if (command === "finalize") {
      if (d.vaultModuleV5 !== undefined) {
        await checkDeployment(client, d);
        log("checked", { vaultImplementation: d.vaultImplementation, vaultModuleV5: d.vaultModuleV5 });
        console.log("VAULT_V5_RECORDED");
        return;
      }
      const p = readPrepared(recordPath);
      await checkPrepared(client, outDir, p, d);
      const now = await beaconImplementation();
      if (now !== getAddress(p.implementation.address)) throw new Error(`the vault beacon still points at ${now}: the scheduled upgrade to ${p.implementation.address} has not run`);
      const next: Deployment = {
        ...d,
        vaultImplementation: getAddress(p.implementation.address),
        vaultModuleV5: getAddress(p.moduleV5.address),
      };
      await checkDeployment(client, next);
      writeJson(recordPath, next);
      unlinkSync(statePath);
      log("written", {
        record: recordPath,
        vaultImplementation: next.vaultImplementation,
        vaultModuleV5: next.vaultModuleV5,
        previous: d.vaultImplementation,
      });
      console.log("VAULT_V5_RECORDED");
      return;
    }

    // prepare
    if (d.vaultModuleV5 !== undefined) throw new Error("the record has a vault module V5 already: the vaults run version 5");
    liveModules(d);
    checkBuildCurrent(outDir);
    await checkDeployment(client, d);
    const key = privateFile(keyFile, "the deployer key file");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyFile} does not hold a 32-byte hex private key`);
    const account = privateKeyToAccount(key as Hex);
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(rpcUrl) });
    const p: Partial<Prepared> = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Partial<Prepared>) : {};
    const has = async (s: Deployed | undefined) => s !== undefined && (await client.getCode({ address: s.address })) !== undefined;
    if (!(await has(p.moduleV5)) || !(await has(p.implementation))) {
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
      const args = constructorArgs(step, d, p);
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
      // The implementation names module V5: a module V5 deployed anew means a new implementation too.
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
      moduleV5: prepared.moduleV5.address,
      implementation: prepared.implementation.address,
      beacon: d.vaultBeacon,
      beaconOwner: owner,
      beaconImplementation: await beaconImplementation(),
    });
    await scan();
    console.log(`next: node scripts/upgrade-owner.ts schedule-upgrade ${d.vaultBeacon} ${prepared.implementation.address}`);
    console.log("VAULT_V5_PREPARED");
  } catch (err) {
    throw new Error(hide(err instanceof Error ? err.message : String(err)));
  }
}

// Run as a script; imported (by upgrade-owner.ts, for checkPrepared), nothing runs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`upgrade-vault failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
