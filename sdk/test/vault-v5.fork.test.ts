// Version 5 (vault-v5.ts) against the version 5 code deployed on Robinhood Chain mainnet, on a fork with Ostra's live
// deployment: the vault beacon is upgraded on the fork to the implementation upgrade-vault.ts prepare deployed, as its
// scheduled call does. Every encoder's params are sent in a spend that must land and read back through the vault's own
// views; the agent key's message is compared with the vault's agentSpendMessage, its spend simulated with a throwaway
// key and then signed and sent; a standing order runs; a failed Priors spend of the owner's key lands as PriorsFailed.
// Needs anvil on PATH.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { bytesToHex, encodeFunctionData, getAddress, hexToBytes, keccak256, parseEventLogs, stringToHex, zeroAddress, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { ostraVaultAbi, ostraVaultFactoryAbi, ostraVaultModuleV5Abi } from "../src/abi.ts";
import { ALLOW_KIND, ORDER_KIND, PRIORS_POOL, PRIORS_POOL_CODEHASH, ROBINHOOD_CHAIN_ID, USDG, VAULT_ACTION, VAULT_PRIORS_MIN_GAS, VAULT_V5 } from "../src/constants.ts";
import type { Deployment } from "../src/deployment.ts";
import { usdgAbi } from "../src/external-abi.ts";
import { lendParams, signVaultSpend, transferParams, vaultAddress, type VaultAction } from "../src/messages.ts";
import { QuoteError } from "../src/quote.ts";
import { failedModuleSpends, floorGasOf, moduleFailureText } from "../src/relayer.ts";
import { readVault } from "../src/reads.ts";
import {
  agentActionMask,
  agentSpendMessage,
  allowValue,
  cancelOrderParams,
  decodeAgentSpendMessage,
  decodePolicyParams,
  decodeSetAgentKeyParams,
  decodeSetAllowParams,
  decodeSetOrderParams,
  EMPTY_POLICY,
  policyParams,
  priorsBorrowParams,
  priorsPoolAbi,
  readAllowEntry,
  readPriorsAgent,
  readLiveOrders,
  readOrder,
  readV5,
  revokeAgentKeyParams,
  setAgentKeyParams,
  setAllowParams,
  setOrderParams,
  signAgentSpend,
  simulateAgentSpend,
  spendAsAgentCall,
  type OrderParams,
  type Policy,
} from "../src/vault-v5.ts";
import { FileWotsStore } from "../src/wots-file.ts";
import { WotsKeychain } from "../src/wots.ts";
import { liveAtV5, startFork, vaultBeaconAtRecord, type Fork } from "./fork.ts";

const LIVE_DEPLOYMENT = fileURLToPath(new URL("../../deployments/robinhood-mainnet.json", import.meta.url));
const MASTER = hexToBytes(keccak256(stringToHex("OSTRA/EVM/SDK-TEST/v5-master")));
const keychainId = (name: string) => hexToBytes(keccak256(stringToHex(`OSTRA/EVM/SDK-TEST/v5/${name}`)));
const DEST = getAddress("0x00000000000000000000000000000000000C0D51");
const OTHER = getAddress("0x00000000000000000000000000000000000C0D52");
const USDG_1 = 1_000_000n;

let fork: Fork;
let d: Deployment;
let relayer: PrivateKeyAccount;
let owner: WotsKeychain;
let agent: WotsKeychain;
let vault: Address;
let agentIndex = 0n;
const dirs: string[] = [];

async function keychain(name: string): Promise<WotsKeychain> {
  const dir = await mkdtemp(join(tmpdir(), "ostra-sdk-v5-"));
  dirs.push(dir);
  return new WotsKeychain(MASTER, keychainId(name), new FileWotsStore(dir));
}

async function send(to: Address, data: Hex, gas?: bigint) {
  const hash = await fork.wallet(relayer).sendTransaction({ to, data, account: relayer, chain: fork.client.chain, ...(gas === undefined ? {} : { gas }) });
  return fork.client.waitForTransactionReceipt({ hash });
}

/** An owner spend of `action`, signed with the vault's key in force and sent from the relayer account; must succeed. */
async function ownerSpend(action: number, params: Hex, gas?: bigint) {
  const state = await readVault(fork.client, d, vault);
  assert.ok(state !== null);
  const signed = await signVaultSpend(owner, { vault, nonce: state.nonce, keyRoot: state.keyRoot }, { chainId: ROBINHOOD_CHAIN_ID, action: action as VaultAction, params });
  const receipt = await send(vault, encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [signed.action, signed.nextKeyRoot, signed.params, signed.signature] }), gas);
  assert.equal(receipt.status, "success", `owner spend ${action}`);
  return receipt;
}

/** An agent spend of `action`, simulated first, then signed with the agent key in force and sent; must succeed. */
async function agentSpend(action: number, params: Hex) {
  await simulateAgentSpend(fork.client, d, { relayer: relayer.address, vault, action, params });
  const s = await readV5(fork.client, vault);
  assert.ok(s !== null);
  const v = await readVault(fork.client, d, vault);
  assert.ok(v !== null);
  const signed = await signAgentSpend(agent, { vault, agentNonce: s.agentKey.agentNonce, keyRoot: s.agentKey.root, vaultKeyRoot: v.keyRoot, index: agentIndex, nextIndex: agentIndex + 1n }, { chainId: ROBINHOOD_CHAIN_ID, action: action as VaultAction, params });
  const call = spendAsAgentCall(vault, signed);
  const receipt = await send(call.to, call.data);
  assert.equal(receipt.status, "success", `agent spend ${action}`);
  agentIndex += 1n;
  return receipt;
}

const balance = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] });
const now = async () => (await fork.client.getBlock()).timestamp;

before(async () => {
  fork = await startFork();
  relayer = fork.accounts[0] as PrivateKeyAccount;
  d = await liveAtV5(fork, LIVE_DEPLOYMENT);
  await vaultBeaconAtRecord(fork, d);
  owner = await keychain("owner");
  agent = await keychain("agent");
  const root = bytesToHex(owner.keyRoot(0n));
  vault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: USDG, initialKeyRoot: root, initialCrank: zeroAddress });
  const receipt = await send(d.vaultFactory, encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [USDG, root, zeroAddress] }));
  assert.equal(receipt.status, "success");
  assert.equal(parseEventLogs({ abi: ostraVaultFactoryAbi, logs: receipt.logs, eventName: "VaultCreated" })[0]?.args.vault, vault);
  await fork.dealUsdg(vault, 50n * USDG_1);
});

after(async () => {
  await fork?.stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("a new vault runs version 5 with an empty policy and no agent key", async () => {
  assert.equal(Number(await fork.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "VERSION" })), VAULT_V5);
  const s = await readV5(fork.client, vault);
  assert.ok(s !== null);
  assert.deepEqual(s.policy, EMPTY_POLICY);
  assert.equal(s.pending, null);
  assert.equal(s.agentKey.inForce, false);
  assert.equal(s.orderCount, 0n);
  assert.equal(s.budgetAvailable, 0n);
  await assert.rejects(simulateAgentSpend(fork.client, d, { relayer: relayer.address, vault, action: VAULT_ACTION.TRANSFER, params: transferParams({ to: DEST, amount: 1n }) }), (e: unknown) => e instanceof QuoteError && e.code === "spend_fails" && /not in force/.test(e.message));
});

test("the owner sets a policy, an allowlist entry and the agent key: each lands and reads back", async () => {
  const policy: Policy = { ...EMPTY_POLICY, actions: agentActionMask([VAULT_ACTION.TRANSFER, VAULT_ACTION.SET_ORDER, VAULT_ACTION.CANCEL_ORDER]), perTx: 5n * USDG_1, daily: 10n * USDG_1 };
  const params = policyParams(policy);
  assert.deepEqual(decodePolicyParams(params), policy);
  await ownerSpend(VAULT_ACTION.SET_POLICY, params);
  const s = await readV5(fork.client, vault);
  assert.deepEqual(s?.policy, policy, "no lock: the policy is in force at once");
  assert.equal(s?.pending, null);

  const value = allowValue(ALLOW_KIND.RECIPIENT, DEST);
  const allow = setAllowParams({ kind: ALLOW_KIND.RECIPIENT, value, allowed: true });
  assert.deepEqual(decodeSetAllowParams(allow), { kind: ALLOW_KIND.RECIPIENT, value, allowed: true });
  await ownerSpend(VAULT_ACTION.SET_ALLOW, allow);
  assert.equal((await readAllowEntry(fork.client, vault, ALLOW_KIND.RECIPIENT, value)).inForce, true);
  assert.equal((await readAllowEntry(fork.client, vault, ALLOW_KIND.RECIPIENT, allowValue(ALLOW_KIND.RECIPIENT, OTHER))).from, 0n);

  const root = bytesToHex(agent.keyRoot(0n));
  const expiry = (await now()) + 30n * 86_400n;
  const key = setAgentKeyParams({ root, expiry });
  assert.deepEqual(decodeSetAgentKeyParams(key), { root, expiry });
  const before = (await readV5(fork.client, vault))?.agentKey.agentNonce ?? -1n;
  await ownerSpend(VAULT_ACTION.SET_AGENT_KEY, key);
  const after = await readV5(fork.client, vault);
  assert.equal(after?.agentKey.root, root);
  assert.equal(after?.agentKey.expiry, expiry);
  assert.equal(after?.agentKey.inForce, true);
  assert.equal(after?.agentKey.agentNonce, before + 1n, "setting a key moves the agent nonce on");
});

test("the agent key's message is the vault's own, and decodes back", async () => {
  const s = await readV5(fork.client, vault);
  assert.ok(s !== null);
  const next = bytesToHex(agent.keyRoot(9n));
  const order: OrderParams = { kind: ORDER_KIND.PAY, venueKind: 0, target: DEST, amount: USDG_1, threshold: 0n, interval: 3_600, runs: 2, endAt: 0n };
  for (const [action, params] of [
    [VAULT_ACTION.TRANSFER, transferParams({ to: DEST, amount: 3n })],
    [VAULT_ACTION.SET_ORDER, setOrderParams(order)],
    [VAULT_ACTION.CANCEL_ORDER, cancelOrderParams(4n)],
  ] as const) {
    const onChain = await fork.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "agentSpendMessage", args: [action, next, params] });
    const message = agentSpendMessage({ chainId: ROBINHOOD_CHAIN_ID, vault, agentNonce: s.agentKey.agentNonce, nextKeyRoot: next, action, params });
    assert.equal(bytesToHex(message), onChain, `action ${action}`);
    assert.deepEqual(decodeAgentSpendMessage(message), { chainId: ROBINHOOD_CHAIN_ID, vault, agentNonce: s.agentKey.agentNonce, nextKeyRoot: next, action, params });
  }
  assert.deepEqual(decodeSetOrderParams(setOrderParams(order)), order);
});

test("an agent transfer is simulated, signed and lands within the policy; what the policy refuses never simulates", async () => {
  const destBefore = await balance(DEST);
  const receipt = await agentSpend(VAULT_ACTION.TRANSFER, transferParams({ to: DEST, amount: 2n * USDG_1 }));
  assert.equal((await balance(DEST)) - destBefore, 2n * USDG_1);
  const spent = parseEventLogs({ abi: ostraVaultModuleV5Abi, logs: receipt.logs, eventName: "AgentSpent" });
  assert.equal(spent.length, 1);
  const s = await readV5(fork.client, vault);
  assert.equal(s?.agentKey.root, bytesToHex(agent.keyRoot(agentIndex)), "the agent key rotated to the next key");
  assert.ok(s !== null && s.budgetAvailable >= 8n * USDG_1 && s.budgetAvailable < 10n * USDG_1, `budget ${s?.budgetAvailable}`);
  // Above perTx, to a recipient not on the list, an action the policy leaves out: each fails now, nothing is signed.
  for (const [action, params, reason] of [
    [VAULT_ACTION.TRANSFER, transferParams({ to: DEST, amount: 6n * USDG_1 }), /OverPerTx/],
    [VAULT_ACTION.TRANSFER, transferParams({ to: OTHER, amount: USDG_1 }), /NotAllowlisted/],
    [VAULT_ACTION.CLAIM_DIVIDEND, `0x${"00".repeat(31)}01` as Hex, /NotAllowed/],
  ] as const) {
    await assert.rejects(simulateAgentSpend(fork.client, d, { relayer: relayer.address, vault, action, params }), (e: unknown) => e instanceof QuoteError && e.code === "spend_fails" && reason.test(e.message), String(reason));
  }
});

test("a PAY order the agent key sets runs from anyone, and the agent key cancels it", async () => {
  const order: OrderParams = { kind: ORDER_KIND.PAY, venueKind: 0, target: DEST, amount: USDG_1, threshold: 0n, interval: 3_600, runs: 3, endAt: 0n };
  await agentSpend(VAULT_ACTION.SET_ORDER, setOrderParams(order));
  const s = await readV5(fork.client, vault);
  assert.ok(s !== null);
  const id = s.orderCount;
  const o = await readOrder(fork.client, vault, id);
  assert.equal(o.live, true);
  assert.equal(o.kind, ORDER_KIND.PAY);
  assert.equal(o.target, DEST);
  assert.equal(o.amount, USDG_1);
  assert.equal(o.runsLeft, 3);
  assert.ok(o.agentGen > 0, "set by the agent key");
  assert.deepEqual((await readLiveOrders(fork.client, vault, s.orderCount)).map((x) => x.id), [id]);
  const destBefore = await balance(DEST);
  const ran = await send(vault, encodeFunctionData({ abi: ostraVaultAbi, functionName: "runOrder", args: [id] }));
  assert.equal(ran.status, "success");
  assert.equal((await balance(DEST)) - destBefore, USDG_1);
  assert.equal((await readOrder(fork.client, vault, id)).runsLeft, 2);
  await agentSpend(VAULT_ACTION.CANCEL_ORDER, cancelOrderParams(id));
  assert.equal((await readOrder(fork.client, vault, id)).live, false);
  assert.deepEqual(await readLiveOrders(fork.client, vault, s.orderCount), []);
});

test("an owner Priors spend that fails lands as PriorsFailed, with its gas floor; the agent key's would revert", async () => {
  const params = priorsBorrowParams({ agentId: 1n, amount: USDG_1, term: 86_400n, maxFee: 0n, jobs: [] });
  const state = await readVault(fork.client, d, vault);
  assert.ok(state !== null);
  const signed = await signVaultSpend(owner, { vault, nonce: state.nonce, keyRoot: state.keyRoot }, { chainId: ROBINHOOD_CHAIN_ID, action: VAULT_ACTION.PRIORS_BORROW, params });
  const data = encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [signed.action, signed.nextKeyRoot, signed.params, signed.signature] });
  assert.deepEqual(floorGasOf({ to: vault, data }), [BigInt(VAULT_PRIORS_MIN_GAS)]);
  const agentCall = spendAsAgentCall(vault, { action: VAULT_ACTION.PRIORS_BORROW, nextKeyRoot: bytesToHex(agent.keyRoot(99n)), params, signature: signed.signature });
  assert.deepEqual(floorGasOf(agentCall), [BigInt(VAULT_PRIORS_MIN_GAS)], "spendAsAgent has the same floor");
  const receipt = await send(vault, data, 6_000_000n);
  assert.equal(receipt.status, "success", "a failed Priors spend of the owner's key lands");
  const failed = failedModuleSpends(receipt.logs, [vault]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.kind, "priors");
  assert.equal(failed[0]?.action, VAULT_ACTION.PRIORS_BORROW);
  assert.equal(typeof moduleFailureText(failed[0]!.reason), "string");
  assert.deepEqual(failedModuleSpends(receipt.logs, [OTHER]), [], "only the vaults named count");
});

test("an agent Lend that would fail is refused before it is signed (a failed Morpho spend lands and rotates the key)", async () => {
  const s = await readV5(fork.client, vault);
  assert.ok(s !== null);
  await ownerSpend(VAULT_ACTION.SET_POLICY, policyParams({ ...s.policy, actions: s.policy.actions | agentActionMask([VAULT_ACTION.LEND]) }));
  await ownerSpend(VAULT_ACTION.SET_ALLOW, setAllowParams({ kind: ALLOW_KIND.LEND, value: allowValue(ALLOW_KIND.LEND, OTHER), allowed: true }));
  const nonce = (await readV5(fork.client, vault))?.agentKey.agentNonce;
  await assert.rejects(simulateAgentSpend(fork.client, d, { relayer: relayer.address, vault, action: VAULT_ACTION.LEND, params: lendParams({ vault: OTHER, assets: USDG_1, minShares: 0n }) }), (e: unknown) => e instanceof QuoteError && e.code === "spend_fails", "a Lend into an address that is no Vault V2");
  assert.equal((await readV5(fork.client, vault))?.agentKey.agentNonce, nonce, "nothing was sent");
});

test("Priors' CreditPoolV2 reads decode against the pool's pinned code", async () => {
  const params = await fork.client.readContract({ address: PRIORS_POOL, abi: priorsPoolAbi, functionName: "getParams" });
  assert.ok(params.maxTerm >= params.minTerm);
  const a = await readPriorsAgent(fork.client, 1n);
  assert.equal(typeof a.enrolled, "boolean");
  assert.equal(await fork.client.getBytecode({ address: PRIORS_POOL }).then((c) => (c === undefined ? "0x" : keccak256(c))), PRIORS_POOL_CODEHASH);
});

test("revoking the agent key ends it: its spends no longer simulate", async () => {
  await ownerSpend(VAULT_ACTION.REVOKE_AGENT_KEY, revokeAgentKeyParams());
  const s = await readV5(fork.client, vault);
  assert.equal(s?.agentKey.inForce, false);
  await assert.rejects(simulateAgentSpend(fork.client, d, { relayer: relayer.address, vault, action: VAULT_ACTION.TRANSFER, params: transferParams({ to: DEST, amount: 1n }) }), (e: unknown) => e instanceof QuoteError && e.code === "spend_fails");
});
