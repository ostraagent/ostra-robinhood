// The escrow's chain reads on a fork of Robinhood Chain mainnet with Ostra
// deployed: a vault spend is escrowed against the vault's on-chain key, a
// spend by a stale key or to an address that is not an Ostra vault is not,
// and once the spend lands the pruner drops the record from the finalized
// block's state. A vault under guardian recovery: the first spend of the new
// seed is escrowed against the recovery's new key root.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bytesToHex, encodeFunctionData, keccak256, stringToHex, zeroAddress, type Address, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_RECOVERY_DELAY,
  FileWotsStore,
  USDG,
  WotsKeychain,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  readVault,
  recoveryKeyRoot,
  signVaultSetGuardian,
  signVaultSetRecoveryPolicy,
  signVaultSupportRecovery,
  signVaultTransfer,
  vaultAddress,
  type Deployment,
  type SignedSpend,
} from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { decodeRelayRequest } from "../src/calls.ts";
import { SignatureEscrow, SignaturePruner, escrowRecords, wotsClaims } from "../src/signatures.ts";

let fork: Fork;
let d: Deployment;
let root: string;
let sender: PrivateKeyAccount;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-escrow-fork-"));
  fork = await startFork();
  d = await deployOnFork(fork);
  // A fresh key: anvil's development accounts are EIP-7702-delegated on Robinhood Chain mainnet.
  sender = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/RELAYER-ESCROW-TEST/sender")));
  await fork.setBalance(sender.address, 10n ** 18n);
});
after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function send(to: Address, data: `0x${string}`): Promise<void> {
  const hash = await fork.wallet(sender).sendTransaction({ account: sender, chain: fork.client.chain, to, data });
  assert.equal((await fork.client.waitForTransactionReceipt({ hash })).status, "success");
}

const spendData = (s: SignedSpend) => encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [s.action, s.nextKeyRoot, s.params, s.signature] });

test("a vault spend is escrowed against the chain, and pruned once it landed", async () => {
  const keys = new WotsKeychain(new Uint8Array(32).fill(21), new Uint8Array(32).fill(22), new FileWotsStore(join(root, "wots")));
  const root0 = bytesToHex(keys.keyRoot(0n));
  await send(d.vaultFactory, encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [USDG, root0, zeroAddress] }));
  const vault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: USDG, initialKeyRoot: root0, initialCrank: zeroAddress });
  await fork.dealUsdg(vault, 5n);
  const state = await readVault(fork.client, d, vault);
  assert.ok(state !== null);
  const signed = await signVaultTransfer(keys, state, { chainId: d.chainId, to: sender.address, amount: 2n });
  const call = { to: vault, data: spendData(signed) };
  // The same signed spend sent to an address that is not a vault reads no key.
  const tx = decodeRelayRequest({ calls: [call, { to: sender.address, data: call.data }] });
  const records = await escrowRecords(fork.client, d, wotsClaims(tx.parsed, tx.calls, d), Date.now());
  assert.equal(records.length, 2);
  const first = records[0];
  assert.ok(first !== null && first !== undefined && first.keyRoot === root0.toLowerCase() && first.nonce === "0");
  assert.equal(records[1], null);

  const escrow = await SignatureEscrow.open(join(root, "escrow"));
  assert.deepEqual((await escrow.put([first])).added, [root0.toLowerCase()]);
  const pruner = new SignaturePruner({ client: fork.client, deployment: d, escrow, log: () => undefined });
  // Not used yet: nothing is dropped.
  await fork.increaseTime(1);
  assert.deepEqual(await pruner.sweep(), []);
  await send(vault, call.data);
  // A stale key is not escrowed any more.
  const again = await escrowRecords(fork.client, d, wotsClaims(tx.parsed, tx.calls, d), Date.now());
  assert.equal(again[0], null);
  // Once the finalized block shows the key used, the record goes.
  let dropped: string[] = [];
  for (let i = 0; i < 80 && dropped.length === 0; i++) {
    await fork.increaseTime(1);
    dropped = await pruner.sweep();
  }
  assert.deepEqual(dropped, [root0.toLowerCase()]);
  assert.equal(escrow.get(root0), undefined);
});

test("the first spend of a recovering vault's new seed is escrowed against the recovery's key root", async () => {
  const mk = (n: number) => new WotsKeychain(new Uint8Array(32).fill(31), new Uint8Array(32).fill(n), new FileWotsStore(join(root, `wots-${n}`)));
  const owner = mk(1);
  const guardianKeys = mk(2);
  const fresh = mk(3);
  const create = async (k: WotsKeychain) => {
    const r0 = bytesToHex(k.keyRoot(0n));
    await send(d.vaultFactory, encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [USDG, r0, zeroAddress] }));
    return vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: USDG, initialKeyRoot: r0, initialCrank: zeroAddress });
  };
  const vault = await create(owner);
  const guardian = await create(guardianKeys);
  await fork.dealUsdg(vault, 9n);
  const spend = async (k: WotsKeychain, v: `0x${string}`, sign: (st: NonNullable<Awaited<ReturnType<typeof readVault>>>) => Promise<SignedSpend>) => {
    const st = await readVault(fork.client, d, v);
    assert.ok(st !== null);
    await send(v, spendData(await sign(st)));
  };
  await spend(owner, vault, (st) => signVaultSetGuardian(owner, st, { chainId: d.chainId, guardian, enabled: true }));
  await spend(owner, vault, (st) => signVaultSetRecoveryPolicy(owner, st, { chainId: d.chainId, threshold: 1, delay: DEFAULT_RECOVERY_DELAY }));
  const state = await readVault(fork.client, d, vault);
  assert.ok(state !== null);
  const newRoot = recoveryKeyRoot(fresh, state.nonce);
  await spend(guardianKeys, guardian, (st) => signVaultSupportRecovery(guardianKeys, st, { chainId: d.chainId, vault, newKeyRoot: newRoot }));

  // The new seed signs the vault's next spend with the recovery's key root, which is not the vault's key root yet.
  const signed = await signVaultTransfer(fresh, { ...state, keyRoot: newRoot }, { chainId: d.chainId, to: sender.address, amount: 4n });
  const tx = decodeRelayRequest({ calls: [{ to: vault, data: spendData(signed) }] });
  const [record] = await escrowRecords(fork.client, d, wotsClaims(tx.parsed, tx.calls, d), Date.now());
  assert.ok(record !== null && record !== undefined);
  assert.equal(record.keyRoot, newRoot.toLowerCase());
  const escrow = await SignatureEscrow.open(join(root, "escrow-recovery"));
  await escrow.put([record]);
  const pruner = new SignaturePruner({ client: fork.client, deployment: d, escrow, log: () => undefined });
  await fork.increaseTime(1);
  assert.deepEqual(await pruner.sweep(), [], "waiting: the recovery's key is not used");
  // After the delay the spend lands and finishes the recovery; the record is then dropped.
  await fork.increaseTime(DEFAULT_RECOVERY_DELAY);
  await send(vault, spendData(signed));
  assert.equal((await readVault(fork.client, d, vault))?.keyRoot, signed.nextKeyRoot);
  let dropped: string[] = [];
  for (let i = 0; i < 80 && dropped.length === 0; i++) {
    await fork.increaseTime(1);
    dropped = await pruner.sweep();
  }
  assert.deepEqual(dropped, [newRoot.toLowerCase()]);
});
