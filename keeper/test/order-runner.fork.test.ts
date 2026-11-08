// The standing-order and Priors-repay fallback (order-runner.ts) on a fork of Robinhood Chain mainnet with Ostra's live
// deployment, the vault beacon upgraded to the version 5 implementation deployed on mainnet: a vault's PAY order is
// found from its OrderSet event, left to the vault's own MCP for the grace, then run by the keeper's fee payer and
// not again before its interval; an order below the minimum and a vault past its runs of the day are left alone.
// Needs anvil on PATH.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { bytesToHex, encodeFunctionData, getAddress, hexToBytes, keccak256, stringToHex, zeroAddress, type Address, type Hex, type PrivateKeyAccount } from "viem";
import {
  ALLOW_KIND,
  EMPTY_POLICY,
  FileWotsStore,
  ORDER_KIND,
  ROBINHOOD_CHAIN_ID,
  USDG,
  VAULT_ACTION,
  WotsKeychain,
  agentActionMask,
  allowValue,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  policyParams,
  readOrder,
  readVault,
  setAllowParams,
  setOrderParams,
  signVaultSpend,
  usdgAbi,
  vaultAddress,
  type Deployment,
  type VaultAction,
} from "@ostraagent/sdk";
import { liveAtV5, startFork, vaultBeaconAtRecord, type Fork } from "@ostraagent/sdk/test/fork";
import { MIN_ORDER_AMOUNT, ORDER_GRACE_S, OrderRunner } from "../src/order-runner.ts";

const LIVE_DEPLOYMENT = fileURLToPath(new URL("../../deployments/robinhood-mainnet.json", import.meta.url));
const MASTER = hexToBytes(keccak256(stringToHex("OSTRA/EVM/KEEPER-TEST/order-runner")));
const DEST = getAddress("0x00000000000000000000000000000000000C0D71");

let fork: Fork;
let d: Deployment;
let sender: PrivateKeyAccount;
let keeper: PrivateKeyAccount;
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ostra-order-runner-"));
  dirs.push(dir);
  return dir;
}

async function send(account: PrivateKeyAccount, to: Address, data: Hex) {
  const hash = await fork.wallet(account).sendTransaction({ to, data, account, chain: fork.client.chain });
  const receipt = await fork.client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  return receipt;
}

/** A new vault of `name`'s keychain, funded, with a policy allowing Transfer to DEST and a PAY order of `amount`. */
async function vaultWithOrder(name: string, amount: bigint): Promise<{ vault: Address; id: bigint }> {
  const chain = new WotsKeychain(MASTER, hexToBytes(keccak256(stringToHex(name))), new FileWotsStore(await tempDir()));
  const root = bytesToHex(chain.keyRoot(0n));
  const vault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: USDG, initialKeyRoot: root, initialCrank: zeroAddress });
  await send(sender, d.vaultFactory, encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [USDG, root, zeroAddress] }));
  await fork.dealUsdg(vault, 100_000_000n);
  const spend = async (action: number, params: Hex) => {
    const v = await readVault(fork.client, d, vault);
    assert.ok(v !== null);
    const s = await signVaultSpend(chain, { vault, nonce: v.nonce, keyRoot: v.keyRoot }, { chainId: ROBINHOOD_CHAIN_ID, action: action as VaultAction, params });
    await send(sender, vault, encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [s.action, s.nextKeyRoot, s.params, s.signature] }));
  };
  await spend(VAULT_ACTION.SET_POLICY, policyParams({ ...EMPTY_POLICY, actions: agentActionMask([VAULT_ACTION.TRANSFER]), perTx: 50_000_000n, daily: 100_000_000n }));
  await spend(VAULT_ACTION.SET_ALLOW, setAllowParams({ kind: ALLOW_KIND.RECIPIENT, value: allowValue(ALLOW_KIND.RECIPIENT, DEST), allowed: true }));
  await spend(VAULT_ACTION.SET_ORDER, setOrderParams({ kind: ORDER_KIND.PAY, venueKind: 0, target: DEST, amount, threshold: 0n, interval: 3_600, runs: 10, endAt: 0n }));
  return { vault, id: 1n };
}

before(async () => {
  fork = await startFork();
  sender = fork.accounts[0] as PrivateKeyAccount;
  keeper = fork.accounts[1] as PrivateKeyAccount;
  d = await liveAtV5(fork, LIVE_DEPLOYMENT);
  await vaultBeaconAtRecord(fork, d);
});

after(async () => {
  await fork?.stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("the fallback runs a due order once its grace is over, within its limits, and only through simulation", { timeout: 900_000 }, async () => {
  const from = await fork.client.getBlockNumber();
  const big = await vaultWithOrder("big", MIN_ORDER_AMOUNT);
  const small = await vaultWithOrder("small", MIN_ORDER_AMOUNT - 1n);
  const sent: { vault: Address; fn: string }[] = [];
  const runner = await OrderRunner.open({
    client: fork.client,
    logsClient: fork.client,
    deployment: d,
    fromBlock: from,
    feePayer: keeper.address,
    send: async (vault, fn, id) => {
      sent.push({ vault, fn });
      const r = await send(keeper, vault, encodeFunctionData({ abi: ostraVaultAbi, functionName: fn, args: [id] }));
      return { hash: r.transactionHash, gasUsed: r.gasUsed, reverted: false };
    },
    dataDir: await tempDir(),
    log: () => {},
  });
  await runner.refresh();
  assert.deepEqual(runner.orders.map((o) => o.vault).sort(), [big.vault, small.vault].sort(), "both orders found from their events");
  // Within the grace: left to the vault's own MCP.
  assert.deepEqual(await runner.tick(), []);
  await fork.increaseTime(ORDER_GRACE_S + 60);
  const balance = async () => (await fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [DEST] })) as bigint;
  const before = await balance();
  const ran = await runner.tick();
  assert.deepEqual(ran.map((r) => [r.vault, r.kind, r.error]), [[big.vault, "order", undefined]], "only the order at the minimum runs");
  assert.equal((await balance()) - before, MIN_ORDER_AMOUNT);
  assert.equal((await readOrder(fork.client, big.vault, big.id)).runsLeft, 9);
  // Not due again before its interval and the grace.
  assert.deepEqual(await runner.tick(), []);
  assert.deepEqual(sent, [{ vault: big.vault, fn: "runOrder" }]);
  // Due again once its interval and the grace have passed.
  await fork.increaseTime(3_600 + ORDER_GRACE_S + 60);
  assert.equal((await runner.tick()).length, 1, "due again after its interval");
  assert.equal(sent.length, 2);
});
