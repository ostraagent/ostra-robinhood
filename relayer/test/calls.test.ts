// Reading relay requests: every Ostra function the relayer recognises,
// unknown and malformed calls, the request hash, and the four kinds relayed
// before payment.

import assert from "node:assert/strict";
import { test } from "node:test";
import { concat, encodeFunctionData, getAddress, hexToBytes, keccak256, toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction, type Address, type Hex } from "viem";
import { ostraPrivatePoolAbi, ostraRouterAbi } from "@ostraagent/swap";
import { ESCROW_EXECUTED_TOPIC, EXECUTE_ESCROW_SELECTOR } from "@ostraagent/sdk";
import {
  LAUNCHPAD,
  MULTICALL3,
  NO_DEV_BUY,
  VAULT_ACTION,
  launchFromVaultData,
  launchParams,
  openChannelParams,
  ostraAirdropAbi,
  ostraCreatorSplitAbi,
  ostraDispatcherAbi,
  ostraVestingAbi,
  relayValue,
  ostraPoolAbi,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  relayRequestHash,
  transferParams,
  usdgAbi,
  vaultAddress,
  type Deployment,
} from "@ostraagent/sdk";
import { classify, decodeRelayRequest, parseCall } from "../src/calls.ts";

const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const d: Deployment = {
  version: 1,
  chainId: 4663,
  token: at(0x5f),
  batchSettlement: at(0x40),
  vaultImplementation: at(0x10),
  vaultBeacon: at(0x11),
  vaultFactory: at(0x12),
  poolImplementation: at(0x13),
  poolBeacon: at(0x14),
  pool: at(0x15),
  splitFactory: at(0x16),
  beaconOwner: at(0x17),
  fromBlock: "1",
};
const relayerVault = at(0xee01);
const vault = at(0xaa01);
const root = `0x${"31".repeat(32)}` as Hex;
const next = `0x${"32".repeat(32)}` as Hex;
const sig = `0x${"ab".repeat(1892)}` as Hex;

const createVault = (token: Address = d.token, initialKeyRoot: Hex = root) => ({ to: d.vaultFactory, data: encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [token, initialKeyRoot, at(0)] }) });
const spend = (to: Address, action: number, params: Hex) => ({ to, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [action, next, params, sig] }) });
const spendLeaf = (destination: Address, to: Address = d.pool) => ({ to, data: encodeFunctionData({ abi: ostraPoolAbi, functionName: "spendLeaf", args: [3n, 5, destination, sig] }) });
const created = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: d.token, initialKeyRoot: root, initialCrank: at(0) });
const openTo = (receiverAuthorizer: Address) =>
  spend(vault, VAULT_ACTION.OPEN_CHANNEL, openChannelParams({ payerAuthorizer: at(0xbb01), receiver: at(0xbb02), receiverAuthorizer, withdrawDelay: 900, salt: `0x${"07".repeat(32)}`, amount: 2_000_000n }));

test("every recognised Ostra function is read with its arguments", () => {
  const c = parseCall(createVault());
  assert.deepEqual(c, { fn: "createVault", to: d.vaultFactory, token: d.token, initialKeyRoot: root, initialCrank: at(0) });
  const s = parseCall(spend(vault, VAULT_ACTION.TRANSFER, transferParams({ to: at(0xcc), amount: 5n })));
  assert.equal(s.fn, "spend");
  assert.ok(s.fn === "spend" && s.action === 0 && s.nextKeyRoot === next && s.signature === sig);
  const l = parseCall(spendLeaf(vault));
  assert.ok(l.fn === "spendLeaf" && l.batchId === 3n && l.leafIndex === 5 && l.destination === vault);
  const config = { payer: vault, payerAuthorizer: at(0xbb01), receiver: at(0xbb02), receiverAuthorizer: relayerVault, token: d.token, withdrawDelay: 900, salt: `0x${"07".repeat(32)}` as Hex };
  const rc = parseCall({ to: vault, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "requestClose", args: [config, 7n, 99n, "0x1234"] }) });
  assert.ok(rc.fn === "requestClose" && rc.amount === 7n && rc.deadline === 99n);
  assert.deepEqual(rc.fn === "requestClose" ? rc.config : null, config);
  const fw = parseCall({ to: vault, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "finalizeWithdraw", args: [config] }) });
  assert.equal(fw.fn, "finalizeWithdraw");
  const ab = parseCall({ to: d.pool, data: encodeFunctionData({ abi: ostraPoolAbi, functionName: "approveBatch", args: [root, 6n, next, root, sig] }) });
  assert.ok(ab.fn === "approveBatch" && ab.batchId === 6n && ab.key === root);
  assert.equal(parseCall({ to: d.pool, data: encodeFunctionData({ abi: ostraPoolAbi, functionName: "cancelDeposit", args: [root] }) }).fn, "cancelDeposit");
  assert.equal(parseCall({ to: d.pool, data: encodeFunctionData({ abi: ostraPoolAbi, functionName: "closeDeposit", args: [root] }) }).fn, "closeDeposit");
  const dep = encodeFunctionData({ abi: ostraPoolAbi, functionName: "depositWithAuthorization", args: [at(0xdd), root, 20_060_181n, at(0xdd), root, 0n, 99n, 27, root, root] });
  assert.equal(parseCall({ to: d.pool, data: dep }).fn, "depositWithAuthorization");
});

test("anything else is an unknown call (the policy refuses it); a recognised function that does not decode is malformed", () => {
  const transfer = { to: d.token, data: encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [at(1), 1n] }) };
  assert.deepEqual(parseCall(transfer), { fn: null, to: d.token, selector: transfer.data.slice(0, 10) });
  // createBatch and sealBatch are Ostra functions the relayer never sends (it must not become an aggregator).
  assert.equal(parseCall({ to: d.pool, data: encodeFunctionData({ abi: ostraPoolAbi, functionName: "createBatch", args: [8] }) }).fn, null);
  const cut = createVault().data.slice(0, 40) as Hex;
  assert.throws(() => parseCall({ to: d.vaultFactory, data: cut }, 2), /calls\[2\]: malformed createVault calldata/);
});

test("the request hash is keccak256(to || data) of the transaction the relayer sends", () => {
  const one = [createVault()];
  const tx1 = decodeRelayRequest({ calls: one });
  assert.equal(tx1.to, d.vaultFactory);
  assert.equal(tx1.hash, keccak256(concat([hexToBytes(d.vaultFactory), hexToBytes(one[0]!.data)]), "hex"));
  assert.equal(tx1.hash, relayRequestHash(one));
  const two = [createVault(), spendLeaf(created)];
  const tx2 = decodeRelayRequest({ calls: two });
  assert.equal(tx2.to, MULTICALL3);
  assert.equal(tx2.parsed.length, 2);
  assert.notEqual(tx2.hash, tx1.hash);
  // The same calls with addresses in another letter case are the same request.
  assert.equal(decodeRelayRequest({ calls: two.map((c) => ({ to: c.to.toLowerCase(), data: c.data.toUpperCase().replace("0X", "0x") })) }).hash, tx2.hash);
});

test("malformed requests are refused", () => {
  assert.throws(() => decodeRelayRequest({}), /calls must be a non-empty array/);
  assert.throws(() => decodeRelayRequest({ calls: [] }), /calls must be a non-empty array/);
  assert.throws(() => decodeRelayRequest({ calls: Array.from({ length: 9 }, () => createVault()) }), /at most 8 calls/);
  assert.throws(() => decodeRelayRequest({ calls: [{ to: "0x12", data: "0x12345678" }] }), /calls\[0\]\.to is not an address/);
  assert.throws(() => decodeRelayRequest({ calls: [{ to: d.pool, data: "0x1234" }] }), /at least a 4-byte selector/);
  assert.throws(() => decodeRelayRequest({ calls: [{ to: d.pool, data: "0x123456789" }] }), /at least a 4-byte selector/);
  assert.throws(() => decodeRelayRequest({ calls: [{ ...createVault(), value: "1" }] }), /sends no ETH value/);
});

test("the four kinds relayed before payment, each the whole request", () => {
  const kind = (calls: { to: Address; data: Hex }[], prepay = false) => classify(decodeRelayRequest({ calls }), d, relayerVault, prepay);
  const cv = kind([createVault()]);
  assert.deepEqual(cv, { kind: "create_vault", ix: { vault: created, token: d.token, initialKeyRoot: root, initialCrank: at(0) } });
  assert.deepEqual(kind([createVault()], true), { kind: "other", vaults: [created] });
  const open = kind([openTo(relayerVault)]);
  assert.equal(open.kind, "open_relayer_channel");
  assert.ok(open.kind === "open_relayer_channel" && open.ix.vault === vault && open.ix.open.amount === 2_000_000n);
  // An open to anyone else is an ordinary request of that vault.
  assert.deepEqual(kind([openTo(at(0xee02))]), { kind: "other", vaults: [vault] });
  assert.deepEqual(kind([spendLeaf(vault)]), { kind: "spend_leaf", ix: { pool: d.pool, batchId: 3n, leafIndex: 5, destination: vault } });
  // A spendLeaf to another contract than the pool is not the pool's leaf.
  assert.deepEqual(kind([spendLeaf(vault, at(0x99))]), { kind: "other", vaults: [] });
  const un = kind([createVault(), spendLeaf(created)]);
  assert.equal(un.kind, "unshield_vault");
  assert.ok(un.kind === "unshield_vault" && un.create.vault === created && un.leaf.destination === created);
  assert.equal(kind([createVault(), spendLeaf(created)], true).kind, "other");
  // Anything else: the vaults it acts for, once each.
  const transfer = spend(vault, VAULT_ACTION.TRANSFER, transferParams({ to: at(0xcc), amount: 5n }));
  assert.deepEqual(kind([transfer, transfer, createVault(d.token, next)]), {
    kind: "other",
    vaults: [vault, vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: d.token, initialKeyRoot: next, initialCrank: at(0) })],
  });
});

test("the launchpad's calls: a vault-funded launch acts for its creator vault and carries the launch fee; the public calls are read with their arguments", () => {
  const l = { hook: at(0x70), fees: at(0x71), launchpad: at(0x72), creatorSplit: at(0x73), dispatcher: at(0x74), locker: at(0x75), devBuy: at(0x76), vesting: at(0x77), airdrop: at(0x78), owner: at(0x79) };
  const dl: Deployment = { ...d, launchpad: l };
  const creatorVault = at(0xaa09);
  const p = launchParams({ name: "T", symbol: "T", salt: `0x${"05".repeat(32)}`, quote: d.token, creatorVault, startTick: -400_000 });
  const dev = { quoteIn: 5_000_000n, beneficiary: at(0xab), dividendRecipient: at(0), cliff: 604_800, duration: 0 };
  const launch = { to: l.devBuy, data: launchFromVaultData(p, dev, { nextKeyRoot: next, signature: sig }) };
  const c = parseCall(launch);
  assert.ok(c.fn === "launchFromVault" && c.vault === creatorVault && c.nextKeyRoot === next && c.signature === sig && c.dev.quoteIn === 5_000_000n && c.launch.symbol === "T");
  assert.deepEqual(classify(decodeRelayRequest({ calls: [launch] }), dl, relayerVault), { kind: "other", vaults: [creatorVault] });
  // The relayer decides the value from the call: the launch fee on the deployment's OstraDevBuy, nothing anywhere else.
  assert.equal(relayValue(dl, launch), LAUNCHPAD.FEE_WEI);
  assert.equal(relayValue(dl, { to: l.launchpad, data: launch.data }), 0n);
  assert.equal(relayValue(d, launch), 0n);
  const noDev = parseCall({ to: l.devBuy, data: launchFromVaultData(p, NO_DEV_BUY, { nextKeyRoot: next, signature: sig }) });
  assert.ok(noDev.fn === "launchFromVault" && noDev.dev.quoteIn === 0n);
  const poolId = `0x${"0e".repeat(32)}` as Hex;
  const claim = parseCall({ to: l.airdrop, data: encodeFunctionData({ abi: ostraAirdropAbi, functionName: "claim", args: [poolId, at(0xc1), 7n, [root]] }) });
  assert.ok(claim.fn === "airdropClaim" && claim.poolId === poolId && claim.account === at(0xc1) && claim.amount === 7n);
  assert.equal(parseCall({ to: l.airdrop, data: encodeFunctionData({ abi: ostraAirdropAbi, functionName: "close", args: [poolId] }) }).fn, "airdropClose");
  const ref = parseCall({ to: l.dispatcher, data: encodeFunctionData({ abi: ostraDispatcherAbi, functionName: "claimReferral", args: [at(0xc2), d.token] }) });
  assert.ok(ref.fn === "claimReferral" && ref.referrer === at(0xc2) && ref.currency === d.token);
  const rel = parseCall({ to: l.creatorSplit, data: encodeFunctionData({ abi: ostraCreatorSplitAbi, functionName: "release", args: [poolId, at(0xc3)] }) });
  assert.ok(rel.fn === "splitRelease" && rel.account === at(0xc3));
  assert.equal(parseCall({ to: at(0xd1), data: encodeFunctionData({ abi: ostraVestingAbi, functionName: "release" }) }).fn, "vestingRelease");
  assert.equal(parseCall({ to: at(0xd1), data: encodeFunctionData({ abi: ostraVestingAbi, functionName: "claimDividends" }) }).fn, "vestingClaimDividends");
  // A launch call cut short is malformed, not unknown.
  assert.throws(() => parseCall({ to: l.devBuy, data: launch.data.slice(0, 200) as Hex }, 1), /calls\[1\]: malformed launchFromVault calldata/);
});

test("Ostra Swap: the router's escrow-order functions and the private pool's spends are read; swap, swapAtBaseFee and shield are unknown", () => {
  const router = getAddress("0x00000000000000000000000000000000000c0001");
  const pool = getAddress("0x00000000000000000000000000000000000c0002");
  const order = {
    tokenIn: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
    tokenOut: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
    amountIn: 1_000_000n,
    minOut: 1n,
    recipient: getAddress("0x00000000000000000000000000000000000c0003"),
    refundTo: getAddress("0x00000000000000000000000000000000000c0003"),
    notBefore: 0n,
    deadline: 2_000_000_000n,
    tranches: 0,
    interval: 0,
    executor: getAddress("0x0000000000000000000000000000000000000000"),
    canceller: getAddress("0x0000000000000000000000000000000000000000"),
    route: `0x${"11".repeat(32)}` as Hex,
    salt: `0x${"22".repeat(32)}` as Hex,
  };
  const noLeg = { commands: "0x" as Hex, inputs: [] as Hex[] };
  const exec = parseCall({ to: router, data: encodeFunctionData({ abi: ostraRouterAbi, functionName: "executeEscrow", args: [order, order.tokenIn, noLeg, noLeg] }) });
  assert.equal(exec.fn, "executeEscrow");
  assert.deepEqual((exec as { order: unknown }).order, order);
  assert.equal(parseCall({ to: router, data: encodeFunctionData({ abi: ostraRouterAbi, functionName: "announce", args: [order] }) }).fn, "announce");
  assert.equal(parseCall({ to: router, data: encodeFunctionData({ abi: ostraRouterAbi, functionName: "closeEscrow", args: [order] }) }).fn, "closeEscrow");
  for (const name of ["swap", "swapAtBaseFee"] as const) {
    const item = ostraRouterAbi.find((x) => x.type === "function" && x.name === name);
    assert.ok(item);
    assert.equal(parseCall({ to: router, data: concat([toFunctionSelector(item as AbiFunction), `0x${"00".repeat(64)}`]) }).fn, null);
  }
  for (const [name, as] of [["privateSwap", "privateSwap"], ["unshield", "privateUnshield"], ["shield", null]] as const) {
    const item = ostraPrivatePoolAbi.find((x) => x.type === "function" && x.name === name);
    assert.ok(item);
    const selector = toFunctionSelector(item as AbiFunction);
    if (as === null) assert.equal(parseCall({ to: pool, data: concat([selector, `0x${"00".repeat(96)}`]) }).fn, null);
    else assert.throws(() => parseCall({ to: pool, data: concat([selector, "0x00"]) }), /malformed/);
  }
  // A vault's shield takes what the pool's escrow holds: read with its token and tag.
  const tag = `0x${"07".repeat(32)}` as Hex;
  assert.deepEqual(parseCall({ to: pool, data: encodeFunctionData({ abi: ostraPrivatePoolAbi, functionName: "shieldFromEscrow", args: [order.tokenIn, tag] }) }), { fn: "shieldFromEscrow", to: pool, token: order.tokenIn, tag });
});

test("the SDK's executeEscrow selector and EscrowExecuted topic are OstraRouter's", () => {
  const item = ostraRouterAbi.find((x) => x.type === "function" && x.name === "executeEscrow");
  assert.ok(item);
  assert.equal(toFunctionSelector(item as AbiFunction), EXECUTE_ESCROW_SELECTOR);
  const event = ostraRouterAbi.find((x) => x.type === "event" && x.name === "EscrowExecuted");
  assert.ok(event);
  assert.equal(toEventSelector(event as AbiEvent), ESCROW_EXECUTED_TOPIC);
});
