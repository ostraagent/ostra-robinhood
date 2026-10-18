// Deploys Ostra's contracts from the Foundry build (Node only; exported by
// the SDK's Node entry). One path for the fork tests and for mainnet:
//   1. OstraVault implementation (bound to x402BatchSettlement and the
//      Uniswap v4 PoolManager), its UpgradeableBeacon, and OstraVaultFactory
//      on that beacon;
//   2. OstraPool implementation, its UpgradeableBeacon, and the pool as a
//      BeaconProxy initialized for USDG with the decided fee and limits;
//   3. OstraSplitFactory.
// Both beacons are owned by `beaconOwner` (upgradeable until the Phase 4
// conditions are met, then released). Every step is checked on chain before
// the next one, and the result is checked again as a whole.
//
// deployLaunchpad adds the launchpad (src/launchpad/): OstraFees, OstraHook at
// a CREATE2 address mined through the deterministic deployer for its
// permission bits (LAUNCHPAD.HOOK_FLAGS), OstraLaunchpad, OstraCreatorSplit,
// OstraDispatcher, OstraLocker, OstraDevBuy (with its OstraVesting
// implementation) and OstraAirdrop, then wires them (hook.initialize,
// launchpad.setLocker). The deploying account owns the hook, the launchpad
// and the dispatcher.

import { readFileSync } from "node:fs";
import { concat, encodeDeployData, encodeFunctionData, getAddress, getContractAddress, keccak256, numberToHex, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import {
  beaconProxyAbi,
  ostraAirdropAbi,
  ostraCreatorSplitAbi,
  ostraDevBuyAbi,
  ostraDispatcherAbi,
  ostraHookAbi,
  ostraLaunchpadAbi,
  ostraLockerAbi,
  ostraPoolAbi,
  ostraSplitFactoryAbi,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  upgradeableBeaconAbi,
} from "./abi.ts";
import {
  CREATE2_DEPLOYER,
  LAUNCHPAD,
  POOL_FEE_BPS,
  POOL_MAX_DEPOSIT,
  POOL_MAX_TOTAL,
  ROBINHOOD_CHAIN_ID,
  UNISWAP_V4_POOL_MANAGER,
  USDG,
  WETH,
  X402_BATCH_SETTLEMENT,
} from "./constants.ts";
import type { Deployment, LaunchpadDeployment } from "./deployment.ts";
import { LEAF_DENOMINATION } from "./leaves.ts";

function creationCode(outDir: string, file: string, contract: string): Hex {
  const artifact = JSON.parse(readFileSync(`${outDir}/${file}/${contract}.json`, "utf8")) as { bytecode: { object: string } };
  const code = artifact.bytecode.object;
  if (!/^0x[0-9a-f]+$/.test(code)) throw new Error(`${file}/${contract}: no creation code in the build`);
  return code as Hex;
}

export type DeployOptions = {
  publicClient: PublicClient;
  /** Pays for the deployment; its account signs. */
  walletClient: WalletClient;
  /** The Foundry build directory (out/). */
  outDir: string;
  beaconOwner: Address;
  /** Receives the pool fees. */
  treasury: Address;
  /** May raise the pool limits (never lower them). */
  poolAuthority: Address;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

export async function deployOstra(o: DeployOptions): Promise<Deployment> {
  const account = o.walletClient.account;
  if (account === undefined) throw new Error("the wallet client has no account");
  const chainId = await o.publicClient.getChainId();
  if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`refusing to deploy on chain ${chainId}: Ostra runs on Robinhood Chain (${ROBINHOOD_CHAIN_ID})`);
  const log = o.log ?? (() => undefined);
  let fromBlock: bigint | undefined;

  const deploy = async (name: string, abi: Abi, bytecode: Hex, args: readonly unknown[]): Promise<Address> => {
    const hash = await o.walletClient.deployContract({ abi, bytecode, args, account, chain: o.walletClient.chain ?? null });
    const receipt = await o.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || receipt.contractAddress === null || receipt.contractAddress === undefined) {
      throw new Error(`${name}: deployment ${hash} failed`);
    }
    fromBlock ??= receipt.blockNumber;
    const address = getAddress(receipt.contractAddress);
    log("deployed", { name, address, tx: hash, gasUsed: receipt.gasUsed });
    return address;
  };
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    o.publicClient.readContract({ address, abi, functionName, args }) as Promise<T>;
  const expect = (what: string, got: unknown, want: unknown) => {
    const norm = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : x);
    if (norm(got) !== norm(want)) throw new Error(`${what}: ${String(got)}, expected ${String(want)}`);
  };

  const vaultImplementation = await deploy("OstraVault", ostraVaultAbi, creationCode(o.outDir, "OstraVault.sol", "OstraVault"), [
    X402_BATCH_SETTLEMENT,
    UNISWAP_V4_POOL_MANAGER,
  ]);
  expect("vault implementation BATCH_SETTLEMENT", await read(vaultImplementation, ostraVaultAbi, "BATCH_SETTLEMENT"), X402_BATCH_SETTLEMENT);
  expect("vault implementation POOL_MANAGER", await read(vaultImplementation, ostraVaultAbi, "POOL_MANAGER"), UNISWAP_V4_POOL_MANAGER);
  const vaultBeacon = await deploy("OstraVault beacon", upgradeableBeaconAbi, creationCode(o.outDir, "UpgradeableBeacon.sol", "UpgradeableBeacon"), [
    vaultImplementation,
    o.beaconOwner,
  ]);
  const vaultFactory = await deploy("OstraVaultFactory", ostraVaultFactoryAbi, creationCode(o.outDir, "OstraVaultFactory.sol", "OstraVaultFactory"), [vaultBeacon]);

  const poolImplementation = await deploy("OstraPool", ostraPoolAbi, creationCode(o.outDir, "OstraPool.sol", "OstraPool"), []);
  const poolBeacon = await deploy("OstraPool beacon", upgradeableBeaconAbi, creationCode(o.outDir, "UpgradeableBeacon.sol", "UpgradeableBeacon"), [
    poolImplementation,
    o.beaconOwner,
  ]);
  const init = encodeFunctionData({
    abi: ostraPoolAbi,
    functionName: "initialize",
    args: [USDG, POOL_FEE_BPS, o.treasury, POOL_MAX_DEPOSIT, POOL_MAX_TOTAL, o.poolAuthority],
  });
  const pool = await deploy("OstraPool proxy", beaconProxyAbi, creationCode(o.outDir, "BeaconProxy.sol", "BeaconProxy"), [poolBeacon, init]);
  const splitFactory = await deploy("OstraSplitFactory", ostraSplitFactoryAbi, creationCode(o.outDir, "OstraSplit.sol", "OstraSplitFactory"), []);

  const d: Deployment = {
    version: 1,
    chainId,
    token: USDG,
    batchSettlement: X402_BATCH_SETTLEMENT,
    vaultImplementation,
    vaultBeacon,
    vaultFactory,
    poolImplementation,
    poolBeacon,
    pool,
    splitFactory,
    beaconOwner: getAddress(o.beaconOwner),
    fromBlock: (fromBlock ?? 0n).toString(),
  };
  await checkDeployment(o.publicClient, d, { treasury: o.treasury, poolAuthority: o.poolAuthority });
  return d;
}

/** Checks on chain that `d` is the deployment deploy.ts makes (with `treasury` and `poolAuthority` when given). */
export async function checkDeployment(client: PublicClient, d: Deployment, expected: { treasury?: Address; poolAuthority?: Address } = {}): Promise<void> {
  const read = <T>(address: Address, abi: Abi, functionName: string) => client.readContract({ address, abi, functionName }) as Promise<T>;
  const same = (what: string, got: unknown, want: unknown) => {
    const norm = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : x);
    if (norm(got) !== norm(want)) throw new Error(`deployment check: ${what} is ${String(got)}, expected ${String(want)}`);
  };
  same("chain id", await client.getChainId(), d.chainId);
  same("vault beacon implementation", await read(d.vaultBeacon, upgradeableBeaconAbi, "implementation"), d.vaultImplementation);
  same("vault beacon owner", await read(d.vaultBeacon, upgradeableBeaconAbi, "owner"), d.beaconOwner);
  same("vault factory beacon", await read(d.vaultFactory, ostraVaultFactoryAbi, "BEACON"), d.vaultBeacon);
  same("vault implementation settlement", await read(d.vaultImplementation, ostraVaultAbi, "BATCH_SETTLEMENT"), d.batchSettlement);
  same("vault implementation pool manager", await read(d.vaultImplementation, ostraVaultAbi, "POOL_MANAGER"), UNISWAP_V4_POOL_MANAGER);
  same("pool beacon implementation", await read(d.poolBeacon, upgradeableBeaconAbi, "implementation"), d.poolImplementation);
  same("pool beacon owner", await read(d.poolBeacon, upgradeableBeaconAbi, "owner"), d.beaconOwner);
  same("pool token", await read(d.pool, ostraPoolAbi, "token"), d.token);
  same("pool fee", await read(d.pool, ostraPoolAbi, "feeBps"), POOL_FEE_BPS);
  same("pool max deposit", await read(d.pool, ostraPoolAbi, "maxDeposit"), POOL_MAX_DEPOSIT);
  same("pool max total", await read(d.pool, ostraPoolAbi, "maxTotal"), POOL_MAX_TOTAL);
  same("pool leaf amount", await read(d.pool, ostraPoolAbi, "leafAmount"), LEAF_DENOMINATION);
  if (expected.treasury !== undefined) same("pool treasury", await read(d.pool, ostraPoolAbi, "treasury"), expected.treasury);
  if (expected.poolAuthority !== undefined) same("pool authority", await read(d.pool, ostraPoolAbi, "initAuthority"), expected.poolAuthority);
  for (const [name, address] of [
    ["vault factory", d.vaultFactory],
    ["split factory", d.splitFactory],
    ["pool", d.pool],
  ] as const) {
    const code = await client.getCode({ address });
    if (code === undefined || code === "0x") throw new Error(`deployment check: no code at the ${name} ${address}`);
  }
}

/** The salt and address of OstraHook through the deterministic deployer: the first salt whose address carries the hook's permission bits. */
export function mineHookSalt(initCode: Hex): { salt: Hex; hook: Address } {
  const bytecodeHash = keccak256(initCode);
  for (let i = 0n; i < 10_000_000n; ++i) {
    const salt = numberToHex(i, { size: 32 });
    const hook = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecodeHash });
    if ((BigInt(hook) & BigInt(LAUNCHPAD.HOOK_FLAGS_MASK)) === BigInt(LAUNCHPAD.HOOK_FLAGS)) return { salt, hook };
  }
  throw new Error("no hook salt found");
}

export type DeployLaunchpadOptions = Omit<DeployOptions, "beaconOwner" | "treasury" | "poolAuthority">;

/** Deploys and wires the launchpad next to the deployment `d` (deployOstra); returns `d` with its `launchpad`. */
export async function deployLaunchpad(o: DeployLaunchpadOptions, d: Deployment): Promise<Deployment> {
  const account = o.walletClient.account;
  if (account === undefined) throw new Error("the wallet client has no account");
  const chainId = await o.publicClient.getChainId();
  if (chainId !== ROBINHOOD_CHAIN_ID || d.chainId !== chainId) throw new Error(`refusing to deploy on chain ${chainId}: Ostra runs on Robinhood Chain (${ROBINHOOD_CHAIN_ID})`);
  const code = await o.publicClient.getCode({ address: CREATE2_DEPLOYER });
  if (code === undefined || code === "0x") throw new Error(`no deterministic deployer at ${CREATE2_DEPLOYER}`);
  const log = o.log ?? (() => undefined);
  const owner = getAddress(account.address);
  const chain = o.walletClient.chain ?? null;

  const landed = async (name: string, hash: Hex) => {
    const receipt = await o.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${name}: transaction ${hash} failed`);
    return receipt;
  };
  const deploy = async (name: string, abi: Abi, file: string, contract: string, args: readonly unknown[]): Promise<Address> => {
    const hash = await o.walletClient.deployContract({ abi, bytecode: creationCode(o.outDir, file, contract), args, account, chain });
    const receipt = await landed(name, hash);
    if (receipt.contractAddress === null || receipt.contractAddress === undefined) throw new Error(`${name}: no contract address in ${hash}`);
    const address = getAddress(receipt.contractAddress);
    log("deployed", { name, address, tx: hash, gasUsed: receipt.gasUsed });
    return address;
  };
  const write = async (name: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) => {
    const hash = await o.walletClient.writeContract({ address, abi, functionName, args, account, chain } as never);
    await landed(name, hash);
    log("called", { name, address, tx: hash });
  };

  const fees = await deploy("OstraFees", [] as Abi, "OstraFees.sol", "OstraFees", []);
  const initCode = encodeDeployData({ abi: ostraHookAbi, bytecode: creationCode(o.outDir, "OstraHook.sol", "OstraHook"), args: [UNISWAP_V4_POOL_MANAGER, WETH, fees, owner] });
  const { salt, hook } = mineHookSalt(initCode);
  await landed("OstraHook", await o.walletClient.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, initCode]), account, chain }));
  const hookCode = await o.publicClient.getCode({ address: hook });
  if (hookCode === undefined || hookCode === "0x") throw new Error(`OstraHook: no code at ${hook}`);
  log("deployed", { name: "OstraHook", address: hook, salt });
  const launchpad = await deploy("OstraLaunchpad", ostraLaunchpadAbi, "OstraLaunchpad.sol", "OstraLaunchpad", [UNISWAP_V4_POOL_MANAGER, hook, WETH, owner]);
  const creatorSplit = await deploy("OstraCreatorSplit", ostraCreatorSplitAbi, "OstraCreatorSplit.sol", "OstraCreatorSplit", [hook]);
  const dispatcher = await deploy("OstraDispatcher", ostraDispatcherAbi, "OstraDispatcher.sol", "OstraDispatcher", [UNISWAP_V4_POOL_MANAGER, hook, WETH, creatorSplit, owner]);
  const locker = await deploy("OstraLocker", ostraLockerAbi, "OstraLocker.sol", "OstraLocker", [UNISWAP_V4_POOL_MANAGER, launchpad, dispatcher]);
  const devBuy = await deploy("OstraDevBuy", ostraDevBuyAbi, "OstraDevBuy.sol", "OstraDevBuy", [UNISWAP_V4_POOL_MANAGER, launchpad]);
  const airdrop = await deploy("OstraAirdrop", ostraAirdropAbi, "OstraAirdrop.sol", "OstraAirdrop", [hook]);
  await write("OstraHook.initialize", hook, ostraHookAbi, "initialize", [launchpad, locker, dispatcher, devBuy, airdrop]);
  await write("OstraLaunchpad.setLocker", launchpad, ostraLaunchpadAbi, "setLocker", [locker]);
  const vesting = (await o.publicClient.readContract({ address: devBuy, abi: ostraDevBuyAbi, functionName: "VESTING" })) as Address;
  const out: Deployment = { ...d, launchpad: { hook, fees, launchpad, creatorSplit, dispatcher, locker, devBuy, vesting: getAddress(vesting), airdrop, owner } };
  await checkLaunchpad(o.publicClient, out);
  return out;
}

/** Checks on chain that `d.launchpad` is wired as deployLaunchpad wires it. */
export async function checkLaunchpad(client: PublicClient, d: Deployment): Promise<void> {
  const l: LaunchpadDeployment | undefined = d.launchpad;
  if (l === undefined) throw new Error("launchpad check: the deployment has no launchpad");
  const read = (address: Address, abi: Abi, functionName: string) => client.readContract({ address, abi, functionName }) as Promise<unknown>;
  const same = async (what: string, address: Address, abi: Abi, functionName: string, want: unknown) => {
    const got = await read(address, abi, functionName);
    const norm = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : x);
    if (norm(got) !== norm(want)) throw new Error(`launchpad check: ${what} is ${String(got)}, expected ${String(want)}`);
  };
  if ((BigInt(l.hook) & BigInt(LAUNCHPAD.HOOK_FLAGS_MASK)) !== BigInt(LAUNCHPAD.HOOK_FLAGS)) throw new Error(`launchpad check: the hook ${l.hook} lacks its permission bits`);
  await same("hook pool manager", l.hook, ostraHookAbi, "POOL_MANAGER", UNISWAP_V4_POOL_MANAGER);
  await same("hook WETH", l.hook, ostraHookAbi, "WETH", WETH);
  await same("hook fees", l.hook, ostraHookAbi, "FEES", l.fees);
  await same("hook launchpad", l.hook, ostraHookAbi, "launchpad", l.launchpad);
  await same("hook locker", l.hook, ostraHookAbi, "locker", l.locker);
  await same("hook dispatcher", l.hook, ostraHookAbi, "dispatcher", l.dispatcher);
  await same("hook dev buy", l.hook, ostraHookAbi, "devBuy", l.devBuy);
  await same("hook airdrop", l.hook, ostraHookAbi, "airdrop", l.airdrop);
  await same("hook owner", l.hook, ostraHookAbi, "owner", l.owner);
  await same("hook tick spacing", l.hook, ostraHookAbi, "TICK_SPACING", LAUNCHPAD.TICK_SPACING);
  await same("launchpad hook", l.launchpad, ostraLaunchpadAbi, "HOOK", l.hook);
  await same("launchpad locker", l.launchpad, ostraLaunchpadAbi, "locker", l.locker);
  await same("launchpad owner", l.launchpad, ostraLaunchpadAbi, "owner", l.owner);
  await same("launchpad fee", l.launchpad, ostraLaunchpadAbi, "LAUNCH_FEE", LAUNCHPAD.FEE_WEI);
  await same("launchpad supply", l.launchpad, ostraLaunchpadAbi, "SUPPLY", LAUNCHPAD.SUPPLY);
  await same("dispatcher hook", l.dispatcher, ostraDispatcherAbi, "HOOK", l.hook);
  await same("dispatcher split", l.dispatcher, ostraDispatcherAbi, "SPLIT", l.creatorSplit);
  await same("dispatcher owner", l.dispatcher, ostraDispatcherAbi, "owner", l.owner);
  await same("creator split hook", l.creatorSplit, ostraCreatorSplitAbi, "HOOK", l.hook);
  await same("locker launchpad", l.locker, ostraLockerAbi, "LAUNCHPAD", l.launchpad);
  await same("locker dispatcher", l.locker, ostraLockerAbi, "DISPATCHER", l.dispatcher);
  await same("dev buy launchpad", l.devBuy, ostraDevBuyAbi, "LAUNCHPAD", l.launchpad);
  await same("dev buy vesting", l.devBuy, ostraDevBuyAbi, "VESTING", l.vesting);
  await same("dev buy WETH", l.devBuy, ostraDevBuyAbi, "WETH", WETH);
  await same("airdrop hook", l.airdrop, ostraAirdropAbi, "HOOK", l.hook);
}
