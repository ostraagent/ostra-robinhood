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

import { readFileSync } from "node:fs";
import { encodeFunctionData, getAddress, type Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { beaconProxyAbi, ostraPoolAbi, ostraSplitFactoryAbi, ostraVaultAbi, ostraVaultFactoryAbi, upgradeableBeaconAbi } from "./abi.ts";
import { POOL_FEE_BPS, POOL_MAX_DEPOSIT, POOL_MAX_TOTAL, ROBINHOOD_CHAIN_ID, UNISWAP_V4_POOL_MANAGER, USDG, X402_BATCH_SETTLEMENT } from "./constants.ts";
import type { Deployment } from "./deployment.ts";
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
