// The gate's rule for the vaults of other ERC-20s (MCP 0.1.20: Ostra Swap buys any ERC-20 that passes its token
// check), on a fork of Robinhood Chain mainnet with Ostra deployed: with Ostra Swap configured, a vault of a token
// that is not USDG, WETH, a listed pair token or a launched one is created and spends Transfer and its withdrawal lock
// (paid by a payer vault in the relayer's token), and nothing else; without Ostra Swap such a vault is not served.
// The policy decides before the request is priced: a request it lets through is refused further on for what it lacks
// (a payer vault), never for its token, or goes on to its simulation (a Transfer of a token the vault does not hold
// reverts there: answered simulation_failed, not refused).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bytesToHex, encodeFunctionData, getAddress, keccak256, stringToHex, zeroAddress, type Address, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  USDG,
  WotsKeychain,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  readVault,
  signVaultSetProfile,
  signVaultTransfer,
  vaultAddress,
  type Deployment,
  type SignedSpend,
} from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { RelayerGate } from "../src/gate.ts";
import { Ledger } from "../src/ledger.ts";
import { SignatureEscrow } from "../src/signatures.ts";

/** A token with a Uniswap v4 pool against native ETH, which Ostra Swap's token check passed on 5 Nov 2026. */
const OTHER: Address = "0xf858011999Dfb3c82Dd7b11e65b1b73579b1F515";

let fork: Fork;
let d: Deployment;
let root: string;
let sender: PrivateKeyAccount;
let keys: WotsKeychain;
/** A second vault in OTHER, with its own keys: a WOTS key signs one message. */
let keys2: WotsKeychain;
let otherVault: Address;
let otherVault2: Address;
let payer: Address;

async function send(to: Address, data: `0x${string}`): Promise<void> {
  const hash = await fork.wallet(sender).sendTransaction({ account: sender, chain: fork.client.chain, to, data });
  assert.equal((await fork.client.waitForTransactionReceipt({ hash })).status, "success");
}

const spendData = (s: SignedSpend) => encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [s.action, s.nextKeyRoot, s.params, s.signature] });

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-gate-tokens-"));
  fork = await startFork();
  d = await deployOnFork(fork);
  // A fresh key: anvil's development accounts are EIP-7702-delegated on Robinhood Chain mainnet.
  sender = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/RELAYER-GATE-TOKENS-TEST/sender")));
  await fork.setBalance(sender.address, 10n ** 18n);
  keys = new WotsKeychain(new Uint8Array(32).fill(41), new Uint8Array(32).fill(42), new FileWotsStore(join(root, "wots")));
  const root0 = bytesToHex(keys.keyRoot(0n));
  await send(d.vaultFactory, encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [OTHER, root0, zeroAddress] }));
  otherVault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: OTHER, initialKeyRoot: root0, initialCrank: zeroAddress });
  await send(d.vaultFactory, encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [USDG, root0, zeroAddress] }));
  payer = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: USDG, initialKeyRoot: root0, initialCrank: zeroAddress });
  keys2 = new WotsKeychain(new Uint8Array(32).fill(43), new Uint8Array(32).fill(44), new FileWotsStore(join(root, "wots2")));
  const root2 = bytesToHex(keys2.keyRoot(0n));
  await send(d.vaultFactory, encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [OTHER, root2, zeroAddress] }));
  otherVault2 = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: OTHER, initialKeyRoot: root2, initialCrank: zeroAddress });
  assert.equal((await readVault(fork.client, d, otherVault))?.token, getAddress(OTHER));
  assert.equal((await readVault(fork.client, d, otherVault2))?.token, getAddress(OTHER));
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** A gate on the fork, with Ostra Swap (its live router's address) or without; what it answers to `body`. */
async function ask(withSwap: boolean, name: string, body: unknown): Promise<{ status: number; body: { error: string; message: string } }> {
  const gate = new RelayerGate({
    client: fork.client,
    deployment: d,
    ledger: await Ledger.open(join(root, `ledger-${name}`)),
    escrow: await SignatureEscrow.open(join(root, `escrow-${name}`)),
    merchant: { token: d.token },
    sender: { address: sender.address },
    log: () => undefined,
    ...(withSwap ? { swap: { router: getAddress("0x5b9686f384A5Fb768B2360cF0B893F0d1E960B01") } } : {}),
  } as never);
  return (await gate.relay({ body: JSON.stringify(body), req: { headers: {} } as never, ip: "127.0.0.1" })) as { status: number; body: { error: string; message: string } };
}

test("createVault of another ERC-20: served with Ostra Swap (paid by a payer vault), not without", { timeout: 600_000 }, async () => {
  const fresh = bytesToHex(keys.keyRoot(7n));
  // A vault not in the relayer's token is created paid up front (prepay), as core's VaultService.open sends it.
  const call = { to: d.vaultFactory, data: encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [OTHER, fresh, zeroAddress] }) };
  const off = await ask(false, "create-off", { calls: [call], payer, prepay: true });
  assert.equal(off.status, 422);
  assert.match(off.body.message, new RegExp(`vaults are created in ${d.token}, WETH, a listed pair token .* not ${getAddress(OTHER)}`));
  // With Ostra Swap the token passes; without a payer vault the request is refused for that alone.
  const on = await ask(true, "create-on", { calls: [call], prepay: true });
  assert.equal(on.status, 422);
  assert.equal(on.body.message, `calls[0]: a vault in ${getAddress(OTHER)} is paid for by a payer vault in ${d.token}`);
});

test("a vault of another ERC-20 spends Transfer and its withdrawal lock with Ostra Swap, nothing else; without it, nothing", { timeout: 600_000 }, async () => {
  const state = await readVault(fork.client, d, otherVault);
  assert.ok(state !== null);
  const transfer = { to: otherVault, data: spendData(await signVaultTransfer(keys, state, { chainId: d.chainId, to: sender.address, amount: 1n })) };
  const off = await ask(false, "transfer-off", { calls: [transfer], payer });
  assert.equal(off.status, 422);
  assert.equal(off.body.message, `calls[0]: ${otherVault} is not an Ostra vault in ${d.token}, WETH, a listed pair token (OSTRA or a stock token) or a token the Ostra launchpad launched`);
  const noPayer = await ask(true, "transfer-on", { calls: [transfer] });
  assert.equal(noPayer.status, 422);
  assert.equal(noPayer.body.message, `calls[0]: a vault in ${getAddress(OTHER)} is paid for by a payer vault in ${d.token}`);
  // With a payer the policy lets it through: its simulation reverts, as the vault holds none of the token.
  const paid = await ask(true, "transfer-paid", { calls: [transfer], payer });
  assert.equal(paid.status, 422, JSON.stringify(paid.body));
  assert.equal(paid.body.error, "simulation_failed", JSON.stringify(paid.body));
  assert.match(paid.body.message, /the transaction reverts/);
  // Another action of a vault in the same token (SetProfile): refused by its token's rule, with a payer.
  const state2 = await readVault(fork.client, d, otherVault2);
  assert.ok(state2 !== null);
  const profile = { to: otherVault2, data: spendData(await signVaultSetProfile(keys2, state2, { chainId: d.chainId, uri: "ipfs://none" })) };
  const other = await ask(true, "profile-on", { calls: [profile], payer });
  assert.equal(other.status, 422);
  assert.equal(other.body.message, `calls[0]: a vault in ${getAddress(OTHER)} is relayed only for Transfer and its withdrawal lock`);
});
