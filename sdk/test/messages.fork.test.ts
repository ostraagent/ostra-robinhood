// The SDK's messages, ids and addresses against the contracts themselves, on
// a fork of Robinhood Chain mainnet: Ostra deployed with deploy.ts next to the
// real USDG, x402BatchSettlement and Uniswap v4 PoolManager. Every off-chain
// encoding is compared with the contract's own view function, and every signed
// call the SDK builds is sent and must land (a vault transfer, a channel open
// and its close request, a crank change, a swap on a deployed v4 pool, a pool
// setting and a dividend claim on an Ostra launch, a guardian recovery to a
// new seed, and a relayed deposit through approval, seal and leaf spend).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  bytesToHex,
  concat,
  encodeAbiParameters,
  encodeDeployData,
  getAddress,
  getContractAddress,
  hexToBytes,
  keccak256,
  numberToHex,
  parseEventLogs,
  parseSignature,
  stringToHex,
  verifyTypedData,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ostraPoolAbi, ostraVaultAbi, ostraVaultFactoryAbi, x402BatchSettlementAbi } from "../src/abi.ts";
import { depositCommitment, type Leaf } from "../src/aggregator.ts";
import { DEFAULT_RECOVERY_DELAY, MIN_RECOVERY_DELAY, POOL_SETTING, ROBINHOOD_CHAIN_ID, UNISWAP_V4_POOL_MANAGER, USDG, VAULT_ACTION, X402_BATCH_SETTLEMENT } from "../src/constants.ts";
import { checkDeployment } from "../src/deploy.ts";
import { parseDeployment, type Deployment } from "../src/deployment.ts";
import { usdgAbi } from "../src/external-abi.ts";
import { depositForLeaves, LEAF_DENOMINATION } from "../src/leaves.ts";
import {
  approvalMessage,
  channelId,
  claimDividendParams,
  closeDigest,
  configurePoolParams,
  closeRequestTypedData,
  decodeClaimDividendParams,
  decodeConfigurePoolParams,
  decodeOpenChannelParams,
  decodeSetGuardianParams,
  decodeSetRecoveryPolicyParams,
  decodeSupportRecoveryParams,
  decodeSetCrankParams,
  decodeSwapParams,
  decodeTransferParams,
  decodeVaultSpendMessage,
  depositAuthorizationTypedData,
  depositKey,
  depositNonce,
  leafMessage,
  openChannelParams,
  poolId,
  recoveryKeyRoot,
  setCrankParams,
  setGuardianParams,
  setRecoveryPolicyParams,
  signApproveBatch,
  signSpendLeaf,
  signVaultClaimDividend,
  signVaultConfigurePool,
  signVaultOpenChannel,
  signVaultSetCrankKey,
  signVaultSetGuardian,
  signVaultSetRecoveryPolicy,
  signVaultSupportRecovery,
  signVaultSwap,
  signVaultTransfer,
  swapInput,
  swapOutput,
  supportRecoveryParams,
  swapParams,
  transferParams,
  vaultAddress,
  vaultChannelConfig,
  vaultSpendMessage,
  voucherDigest,
  voucherTypedData,
  type OpenChannelParams,
  type PoolKey,
  type SwapParams,
} from "../src/messages.ts";
import { batchStateOf, readBatch, readChannel, readDeposit, readPool, readRecovery, readVault } from "../src/reads.ts";
import { FileWotsStore } from "../src/wots-file.ts";
import { WotsKeychain } from "../src/wots.ts";
import { deployOnFork, OUT_DIR, startFork, type Fork } from "./fork.ts";

const MASTER = hexToBytes(keccak256(stringToHex("OSTRA/EVM/SDK-TEST/master")));
const keychainId = (name: string) => hexToBytes(keccak256(stringToHex(`OSTRA/EVM/SDK-TEST/${name}`)));
const session = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/SDK-TEST/session-key")));
const crank = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/SDK-TEST/crank")));
const depositor = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/SDK-TEST/depositor")));

let fork: Fork;
let d: Deployment;
let relayer: PrivateKeyAccount;
const dirs: string[] = [];

async function keychain(name: string): Promise<WotsKeychain> {
  const dir = await mkdtemp(join(tmpdir(), "ostra-sdk-"));
  dirs.push(dir);
  return new WotsKeychain(MASTER, keychainId(name), new FileWotsStore(dir));
}

/** Sends a contract call from the relayer account and requires it to succeed. */
async function send(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) {
  const hash = await fork.wallet(relayer).writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, account: relayer, chain: fork.client.chain });
  const receipt = await fork.client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${functionName} failed`);
  return receipt;
}

async function createVault(chain: WotsKeychain, initialCrank: Address, token: Address = USDG): Promise<Address> {
  const root = bytesToHex(chain.keyRoot(0n));
  const predicted = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot: root, initialCrank });
  const receipt = await send(d.vaultFactory, ostraVaultFactoryAbi, "createVault", [token, root, initialCrank]);
  const [created] = parseEventLogs({ abi: ostraVaultFactoryAbi, logs: receipt.logs, eventName: "VaultCreated" });
  assert.ok(created);
  assert.equal(created.args.vault, predicted);
  return predicted;
}

const balance = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] });

/** The hookless native ETH/USDG pool at 0.05% on the deployed PoolManager (currency0 = ETH, currency1 = USDG). */
const ETH_USDG: PoolKey = { currency0: zeroAddress, currency1: USDG, fee: 500, tickSpacing: 10, hooks: zeroAddress };

before(async () => {
  fork = await startFork();
  relayer = fork.accounts[0] as PrivateKeyAccount;
  d = await deployOnFork(fork);
});

after(async () => {
  await fork?.stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("the deployment is the one deploy.ts makes, and parses back", async () => {
  assert.equal(d.chainId, ROBINHOOD_CHAIN_ID);
  assert.equal(d.token, USDG);
  assert.equal(d.batchSettlement, X402_BATCH_SETTLEMENT);
  await checkDeployment(fork.client, d, { treasury: fork.accounts[1]!.address, poolAuthority: relayer.address });
  assert.deepEqual(parseDeployment(JSON.parse(JSON.stringify(d))), d);
  assert.throws(() => parseDeployment({ ...d, pool: "0x1234" }), /pool is not an address/);
  assert.throws(() => parseDeployment({ ...d, version: 2 }), /version/);
});

test("vault addresses are the factory's, and only factory vaults read as vaults", async () => {
  const chain = await keychain("vault-address");
  for (const initialCrank of [zeroAddress, crank.address]) {
    const root = bytesToHex(chain.keyRoot(0n));
    const onChain = await fork.client.readContract({ address: d.vaultFactory, abi: ostraVaultFactoryAbi, functionName: "vaultAddress", args: [USDG, root, initialCrank] });
    assert.equal(vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: USDG, initialKeyRoot: root, initialCrank }), onChain);
  }
  const vault = await createVault(chain, crank.address);
  const state = await readVault(fork.client, d, vault);
  assert.deepEqual(state, {
    vault,
    token: USDG,
    initialKeyRoot: bytesToHex(chain.keyRoot(0n)),
    initialCrank: crank.address,
    keyRoot: bytesToHex(chain.keyRoot(0n)),
    nonce: 0n,
    crank: crank.address,
  });
  assert.equal(await readVault(fork.client, d, getAddress("0x00000000000000000000000000000000000000aa")), null, "nothing deployed");
  assert.equal(await readVault(fork.client, d, USDG), null, "not a vault");
});

test("spend messages are the vault's own, for every action, and decode back", async () => {
  const chain = await keychain("spend-messages");
  const vault = await createVault(chain, zeroAddress);
  const next = bytesToHex(chain.keyRoot(1n));
  const open: OpenChannelParams = {
    payerAuthorizer: session.address,
    receiver: fork.accounts[2]!.address,
    receiverAuthorizer: fork.accounts[3]!.address,
    withdrawDelay: 900,
    salt: keccak256(stringToHex("salt")),
    amount: 1_000_000n,
  };
  const cases = [
    { action: VAULT_ACTION.TRANSFER, params: transferParams({ to: fork.accounts[2]!.address, amount: 5n }) },
    { action: VAULT_ACTION.OPEN_CHANNEL, params: openChannelParams(open) },
    { action: VAULT_ACTION.SET_CRANK_KEY, params: setCrankParams(crank.address) },
    { action: VAULT_ACTION.SET_CRANK_KEY, params: setCrankParams(zeroAddress) },
    { action: VAULT_ACTION.SWAP, params: swapParams({ key: ETH_USDG, zeroForOne: false, amountIn: 1_000_000n, minOut: 7n, recipient: fork.accounts[2]!.address }) },
    { action: VAULT_ACTION.CONFIGURE_POOL, params: configurePoolParams({ hook: fork.accounts[3]!.address, poolId: poolId(ETH_USDG), field: POOL_SETTING.MAX_BUY, value: 5n }) },
    { action: VAULT_ACTION.CLAIM_DIVIDEND, params: claimDividendParams(fork.accounts[2]!.address) },
    { action: VAULT_ACTION.SET_GUARDIAN, params: setGuardianParams({ guardian: fork.accounts[3]!.address, enabled: true }) },
    { action: VAULT_ACTION.SET_RECOVERY_POLICY, params: setRecoveryPolicyParams({ threshold: 2, delay: DEFAULT_RECOVERY_DELAY }) },
    { action: VAULT_ACTION.SUPPORT_RECOVERY, params: supportRecoveryParams({ vault: fork.accounts[2]!.address, newKeyRoot: next }) },
  ];
  for (const c of cases) {
    const onChain = await fork.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "spendMessage", args: [c.action, next, c.params] });
    const message = vaultSpendMessage({ chainId: ROBINHOOD_CHAIN_ID, vault, nonce: 0n, nextKeyRoot: next, action: c.action, params: c.params });
    assert.equal(bytesToHex(message), onChain, `action ${c.action}`);
    assert.deepEqual(decodeVaultSpendMessage(message), { chainId: ROBINHOOD_CHAIN_ID, vault, nonce: 0n, nextKeyRoot: next, action: c.action, params: c.params });
  }
  assert.deepEqual(decodeTransferParams(cases[0]!.params), { to: fork.accounts[2]!.address, amount: 5n });
  assert.deepEqual(decodeOpenChannelParams(cases[1]!.params), open);
  assert.equal(decodeSetCrankParams(cases[2]!.params), crank.address);
  assert.deepEqual(decodeSwapParams(cases[4]!.params), { key: ETH_USDG, zeroForOne: false, amountIn: 1_000_000n, minOut: 7n, recipient: fork.accounts[2]!.address });
  assert.deepEqual(decodeConfigurePoolParams(cases[5]!.params), { hook: fork.accounts[3]!.address, poolId: poolId(ETH_USDG), field: POOL_SETTING.MAX_BUY, value: 5n });
  assert.equal(decodeClaimDividendParams(cases[6]!.params), fork.accounts[2]!.address);
  assert.deepEqual(decodeSetGuardianParams(cases[7]!.params), { guardian: fork.accounts[3]!.address, enabled: true });
  assert.deepEqual(decodeSetRecoveryPolicyParams(cases[8]!.params), { threshold: 2, delay: DEFAULT_RECOVERY_DELAY });
  assert.deepEqual(decodeSupportRecoveryParams(cases[9]!.params), { vault: fork.accounts[2]!.address, newKeyRoot: next });
  // What the vault would refuse, the SDK never signs.
  assert.throws(() => vaultSpendMessage({ chainId: ROBINHOOD_CHAIN_ID, vault, nonce: 0n, nextKeyRoot: `0x${"00".repeat(32)}`, action: 0, params: cases[0]!.params }), /nextKeyRoot must not be zero/);
  assert.throws(() => transferParams({ to: zeroAddress, amount: 1n }), /zero address/);
  assert.throws(() => transferParams({ to: fork.accounts[2]!.address, amount: 0n }), /greater than zero/);
  assert.throws(() => openChannelParams({ ...open, payerAuthorizer: zeroAddress }), /payerAuthorizer/);
  assert.throws(() => openChannelParams({ ...open, withdrawDelay: 899 }), /withdrawDelay/);
  assert.throws(() => openChannelParams({ ...open, withdrawDelay: 2_592_001 }), /withdrawDelay/);
  assert.throws(() => vaultSpendMessage({ chainId: ROBINHOOD_CHAIN_ID, vault, nonce: 0n, nextKeyRoot: next, action: 0, params: cases[2]!.params }), /64 bytes/);
  const swap: SwapParams = { key: ETH_USDG, zeroForOne: false, amountIn: 1n, minOut: 0n, recipient: fork.accounts[2]!.address };
  assert.throws(() => swapParams({ ...swap, key: { ...ETH_USDG, currency0: USDG, currency1: zeroAddress } }), /currency0 must sort below currency1/);
  assert.throws(() => swapParams({ ...swap, key: { ...ETH_USDG, currency0: USDG } }), /currency0 must sort below currency1/);
  assert.throws(() => swapParams({ ...swap, key: { ...ETH_USDG, fee: 1_000_001 } }), /fee/);
  assert.throws(() => swapParams({ ...swap, key: { ...ETH_USDG, tickSpacing: 0 } }), /tickSpacing/);
  assert.throws(() => swapParams({ ...swap, key: { ...ETH_USDG, tickSpacing: 32_768 } }), /tickSpacing/);
  assert.throws(() => swapParams({ ...swap, amountIn: 0n }), /greater than zero/);
  assert.throws(() => swapParams({ ...swap, amountIn: 1n << 128n }), /amountIn out of range/);
  assert.throws(() => swapParams({ ...swap, recipient: zeroAddress }), /zero address/);
  assert.doesNotThrow(() => swapParams({ ...swap, key: { ...ETH_USDG, fee: 0x800000 } }));
  const setting = { hook: fork.accounts[3]!.address, poolId: poolId(ETH_USDG), field: POOL_SETTING.BUY_TAX, value: 0n } as const;
  assert.throws(() => configurePoolParams({ ...setting, hook: zeroAddress }), /zero address/);
  assert.throws(() => configurePoolParams({ ...setting, poolId: "0x1234" }), /poolId must be 32 bytes/);
  assert.throws(() => configurePoolParams({ ...setting, field: 9 as never }), /unknown pool setting/);
  assert.throws(() => configurePoolParams({ ...setting, value: 0x10000n }), /value out of range/);
  assert.throws(() => configurePoolParams({ ...setting, field: POOL_SETTING.TAX_END_AT, value: 1n << 40n }), /value out of range/);
  assert.throws(() => configurePoolParams({ ...setting, field: POOL_SETTING.RELEASE_LIMITS, value: 1n }), /value out of range/);
  assert.throws(() => configurePoolParams({ ...setting, field: POOL_SETTING.VOLATILITY_FEE, value: 1n }), /value out of range/);
  assert.throws(() => claimDividendParams(zeroAddress), /zero address/);
  assert.throws(() => setGuardianParams({ guardian: zeroAddress, enabled: true }), /zero address/);
  assert.throws(() => setRecoveryPolicyParams({ threshold: 1, delay: MIN_RECOVERY_DELAY - 1 }), /delay/);
  assert.throws(() => setRecoveryPolicyParams({ threshold: 1, delay: 1_209_601 }), /delay/);
  assert.throws(() => setRecoveryPolicyParams({ threshold: 0, delay: 1 }), /delay/);
  assert.throws(() => setRecoveryPolicyParams({ threshold: 256, delay: MIN_RECOVERY_DELAY }), /threshold/);
  assert.doesNotThrow(() => setRecoveryPolicyParams({ threshold: 0, delay: 0 }));
  assert.throws(() => supportRecoveryParams({ vault: fork.accounts[2]!.address, newKeyRoot: `0x${"00".repeat(32)}` }), /newKeyRoot must not be zero/);
});

test("a transfer the SDK signs moves USDG once and rotates the key", async () => {
  const chain = await keychain("transfer");
  const vault = await createVault(chain, zeroAddress);
  await fork.dealUsdg(vault, 100_000_000n);
  const to = fork.accounts[2]!.address;
  const before = await balance(to);
  const state = await readVault(fork.client, d, vault);
  assert.ok(state);
  const spend = await signVaultTransfer(chain, state, { chainId: ROBINHOOD_CHAIN_ID, to, amount: 5_000_000n });
  // Signing the same spend again gives the same bytes (resubmit, never re-sign).
  assert.equal((await signVaultTransfer(chain, state, { chainId: ROBINHOOD_CHAIN_ID, to, amount: 5_000_000n })).signature, spend.signature);
  await assert.rejects(() => signVaultTransfer(chain, state, { chainId: ROBINHOOD_CHAIN_ID, to, amount: 6_000_000n }), /already signed a different message/);
  await send(vault, ostraVaultAbi, "spend", [spend.action, spend.nextKeyRoot, spend.params, spend.signature]);
  assert.equal(await balance(vault), 95_000_000n);
  assert.equal((await balance(to)) - before, 5_000_000n);
  const after1 = await readVault(fork.client, d, vault);
  assert.equal(after1?.nonce, 1n);
  assert.equal(after1?.keyRoot, bytesToHex(chain.keyRoot(1n)));
  // The used signature never works again.
  await assert.rejects(() => send(vault, ostraVaultAbi, "spend", [spend.action, spend.nextKeyRoot, spend.params, spend.signature]));
});

test("an open the SDK signs creates the channel the SDK names; vouchers and close requests verify", async () => {
  const buyerChain = await keychain("buyer");
  const sellerChain = await keychain("seller");
  const buyer = await createVault(buyerChain, crank.address);
  const seller = await createVault(sellerChain, crank.address);
  await fork.dealUsdg(buyer, 50_000_000n);
  const open: OpenChannelParams = {
    payerAuthorizer: session.address,
    receiver: fork.accounts[3]!.address,
    receiverAuthorizer: seller,
    withdrawDelay: 900,
    salt: keccak256(stringToHex("channel 1")),
    amount: 20_000_000n,
  };
  const state = await readVault(fork.client, d, buyer);
  assert.ok(state);
  const spend = await signVaultOpenChannel(buyerChain, state, { chainId: ROBINHOOD_CHAIN_ID, open });
  const receipt = await send(buyer, ostraVaultAbi, "spend", [spend.action, spend.nextKeyRoot, spend.params, spend.signature]);
  const config = vaultChannelConfig(buyer, USDG, open);
  const id = channelId(config);
  assert.equal(id, await fork.client.readContract({ address: X402_BATCH_SETTLEMENT, abi: x402BatchSettlementAbi, functionName: "getChannelId", args: [config] }));
  const [opened] = parseEventLogs({ abi: ostraVaultAbi, logs: receipt.logs, eventName: "ChannelOpened" });
  assert.equal(opened?.args.channelId, id);
  assert.deepEqual(await readChannel(fork.client, X402_BATCH_SETTLEMENT, id), { channelId: id, balance: 20_000_000n, totalClaimed: 0n, pendingWithdrawal: null });
  assert.equal(await balance(buyer), 30_000_000n);

  // A cumulative voucher signed by the session key is the contract's digest and recovers to the payerAuthorizer.
  assert.equal(voucherDigest({ channelId: id, maxClaimableAmount: 1_500_000n }), await fork.client.readContract({ address: X402_BATCH_SETTLEMENT, abi: x402BatchSettlementAbi, functionName: "getVoucherDigest", args: [id, 1_500_000n] }));
  const voucher = await session.signTypedData(voucherTypedData({ channelId: id, maxClaimableAmount: 1_500_000n }));
  assert.ok(await verifyTypedData({ ...voucherTypedData({ channelId: id, maxClaimableAmount: 1_500_000n }), address: session.address, signature: voucher }));

  // A close request signed by the session key, at the vault's close nonce, starts the withdrawal once.
  const block = await fork.client.getBlock();
  const deadline = block.timestamp + 600n;
  const nonce = await fork.client.readContract({ address: buyer, abi: ostraVaultAbi, functionName: "closeNonce", args: [id] });
  assert.equal(nonce, 0n);
  const typed = closeRequestTypedData({ chainId: ROBINHOOD_CHAIN_ID, vault: buyer, channelId: id, amount: 20_000_000n, nonce, deadline });
  assert.equal(closeDigest({ chainId: ROBINHOOD_CHAIN_ID, vault: buyer, channelId: id, amount: 20_000_000n, nonce, deadline }), await fork.client.readContract({ address: buyer, abi: ostraVaultAbi, functionName: "closeDigest", args: [id, 20_000_000n, deadline] }));
  const closeSig = await session.signTypedData(typed);
  await send(buyer, ostraVaultAbi, "requestClose", [config, 20_000_000n, deadline, closeSig]);
  const pending = await readChannel(fork.client, X402_BATCH_SETTLEMENT, id);
  assert.equal(pending.pendingWithdrawal?.amount, 20_000_000n);
  await assert.rejects(() => send(buyer, ostraVaultAbi, "requestClose", [config, 20_000_000n, deadline, closeSig]), "a close signature works once");
});

test("a swap the SDK signs trades the vault's USDG on the deployed Uniswap v4 pool, once", async () => {
  const chain = await keychain("swap");
  const vault = await createVault(chain, zeroAddress);
  await fork.dealUsdg(vault, 50_000_000n);
  const to = fork.accounts[3]!.address;
  assert.equal(poolId(ETH_USDG), keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [zeroAddress, USDG, 500, 10, zeroAddress])));
  const swap: SwapParams = { key: ETH_USDG, zeroForOne: false, amountIn: 10_000_000n, minOut: 1n, recipient: to };
  assert.equal(swapInput(swap), USDG);
  assert.equal(swapOutput(swap), zeroAddress);
  const state = await readVault(fork.client, d, vault);
  assert.ok(state);
  // The SDK refuses a swap whose input is not the vault's token; the vault would revert it.
  await assert.rejects(() => signVaultSwap(chain, state, { chainId: ROBINHOOD_CHAIN_ID, token: USDG, swap: { ...swap, zeroForOne: true } }), /not the vault's token/);
  const spend = await signVaultSwap(chain, state, { chainId: ROBINHOOD_CHAIN_ID, token: USDG, swap });
  assert.equal(spend.action, VAULT_ACTION.SWAP);
  const ethBefore = await fork.client.getBalance({ address: to });
  const receipt = await send(vault, ostraVaultAbi, "spend", [spend.action, spend.nextKeyRoot, spend.params, spend.signature]);
  const [swapped] = parseEventLogs({ abi: ostraVaultAbi, logs: receipt.logs, eventName: "Swapped" });
  assert.ok(swapped);
  assert.equal(swapped.args.poolId, poolId(ETH_USDG));
  assert.equal(swapped.args.zeroForOne, false);
  assert.equal(swapped.args.amountIn, 10_000_000n);
  assert.equal(swapped.args.recipient, to);
  assert.ok(swapped.args.amountOut > 0n);
  assert.equal((await fork.client.getBalance({ address: to })) - ethBefore, swapped.args.amountOut);
  assert.equal(await balance(vault), 40_000_000n);
  assert.equal(await fork.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "POOL_MANAGER" }), UNISWAP_V4_POOL_MANAGER);
  const after1 = await readVault(fork.client, d, vault);
  assert.equal(after1?.nonce, 1n);
  assert.equal(after1?.keyRoot, bytesToHex(chain.keyRoot(1n)));
  await assert.rejects(() => send(vault, ostraVaultAbi, "spend", [spend.action, spend.nextKeyRoot, spend.params, spend.signature]), "the used signature never works again");
});

/** A Foundry artifact of the build the fork deploys from (../out). */
function artifact(file: string, contract: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(readFileSync(`${OUT_DIR}/${file}/${contract}.json`, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: a.abi, bytecode: a.bytecode.object };
}

async function deployArtifact(file: string, contract: string, args: readonly unknown[]): Promise<Address> {
  const { abi, bytecode } = artifact(file, contract);
  const hash = await fork.wallet(relayer).deployContract({ abi, bytecode, args, account: relayer, chain: fork.client.chain });
  const receipt = await fork.client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${contract} deployment failed`);
  return getAddress(receipt.contractAddress!);
}

/** The deterministic CREATE2 deployer deployed on chain 4663 (github.com/Arachnid/deterministic-deployment-proxy). */
const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
/** OstraHook's permission bits (v4-core Hooks): beforeInitialize, beforeAddLiquidity, before/afterSwap, both return deltas. */
const HOOK_FLAGS = 0x28ccn;

test("a pool setting and a dividend claim the SDK signs land on an Ostra launch", async () => {
  assert.notEqual(await fork.client.getCode({ address: CREATE2_DEPLOYER }), undefined);
  const hookArt = artifact("OstraHook.sol", "OstraHook");
  const launchpadArt = artifact("OstraLaunchpad.sol", "OstraLaunchpad");
  const tokenArt = artifact("OstraToken.sol", "OstraToken");
  // The hook's address carries its permission bits: mine a CREATE2 salt for them.
  const fees = await deployArtifact("OstraFees.sol", "OstraFees", []);
  const initCode = encodeDeployData({ abi: hookArt.abi, bytecode: hookArt.bytecode, args: [UNISWAP_V4_POOL_MANAGER, WETH, fees, relayer.address] });
  const bytecodeHash = keccak256(initCode);
  let salt: Hex = `0x${"00".repeat(32)}`;
  let hook: Address = zeroAddress;
  for (let i = 0n; ; ++i) {
    salt = numberToHex(i, { size: 32 });
    hook = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecodeHash });
    if ((BigInt(hook) & 0x3fffn) === HOOK_FLAGS) break;
  }
  const deployed = await fork.client.waitForTransactionReceipt({ hash: await fork.wallet(relayer).sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, initCode]), account: relayer, chain: fork.client.chain }) });
  assert.equal(deployed.status, "success");
  const launchpad = await deployArtifact("OstraLaunchpad.sol", "OstraLaunchpad", [UNISWAP_V4_POOL_MANAGER, hook, WETH, relayer.address]);
  const locker = await deployArtifact("OstraLocker.sol", "OstraLocker", [UNISWAP_V4_POOL_MANAGER, launchpad, hook]);
  await send(hook, hookArt.abi, "initialize", [launchpad, locker]);
  await send(launchpad, launchpadArt.abi, "setLocker", [locker]);

  // A USDG launch with dividends in USDG, by a creator whose USDG vault the SDK controls.
  const creatorChain = await keychain("launch-creator");
  const creatorVault = await createVault(creatorChain, zeroAddress);
  const noKey = { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress };
  const params = {
    name: "Ostra SDK Test", symbol: "OSDK", salt: keccak256(stringToHex("sdk launch")), quote: USDG, creatorVault, startTick: -375_400,
    tiers: [{ width: 40_000, supplyBps: 4_000 }, { width: 40_000, supplyBps: 3_000 }, { width: 0, supplyBps: 3_000 }],
    buyTaxBps: 300, sellTaxBps: 500, postBuyTaxBps: 100, postSellTaxBps: 200, taxDuration: 30 * 86_400,
    creatorBucketBps: 2_500, dividendBucketBps: 2_500, burnBucketBps: 2_500, lpBucketBps: 2_500,
    dividendToken: USDG, dividendKey: noKey, minDividendBalance: 10n ** 18n,
    antiSnipeBps: 0, antiSnipeDuration: 0, maxBuy: 0n, maxWallet: 0n, limitsDuration: 0, antiFarmerDuration: 86_400,
    graduationKind: 2, graduationThreshold: 1_000_000_000_000n, volatilityFee: true,
  };
  const predicted = (await fork.client.readContract({ address: launchpad, abi: launchpadArt.abi, functionName: "tokenAddress", args: [relayer.address, params] })) as Address;
  const launchHash = await fork.wallet(relayer).writeContract({ address: launchpad, abi: launchpadArt.abi, functionName: "launch", args: [params], value: 200_000_000_000_000n, account: relayer, chain: fork.client.chain });
  const launched = await fork.client.waitForTransactionReceipt({ hash: launchHash });
  assert.equal(launched.status, "success");
  const [event] = parseEventLogs({ abi: launchpadArt.abi, logs: launched.logs, eventName: "Launched" }) as unknown as [{ args: { poolId: Hex; token: Address } }];
  const id = event.args.poolId;
  const token = getAddress(event.args.token);
  assert.equal(token, predicted);
  const key = (await fork.client.readContract({ address: hook, abi: hookArt.abi, functionName: "poolKey", args: [id] })) as PoolKey;
  assert.equal(poolId(key), id);
  const config = () => fork.client.readContract({ address: hook, abi: hookArt.abi, functionName: "poolConfig", args: [id] }) as Promise<{ buyTaxBps: number; postBuyTaxBps: number; volatilityFee: boolean }>;

  // ConfigurePool: the creator vault lowers the buy tax from 3% to 0.5% (the post-graduation 1% follows it down).
  const creatorState = await readVault(fork.client, d, creatorVault);
  assert.ok(creatorState);
  const configure = await signVaultConfigurePool(creatorChain, creatorState, { chainId: ROBINHOOD_CHAIN_ID, configure: { hook, poolId: id, field: POOL_SETTING.BUY_TAX, value: 50n } });
  assert.equal(configure.action, VAULT_ACTION.CONFIGURE_POOL);
  await send(creatorVault, ostraVaultAbi, "spend", [configure.action, configure.nextKeyRoot, configure.params, configure.signature]);
  const c = await config();
  assert.equal(c.buyTaxBps, 50);
  assert.equal(c.postBuyTaxBps, 50);
  assert.equal(c.volatilityFee, true);

  // ConfigurePool: the creator vault turns the volatility LP fee off.
  const creatorNext = await readVault(fork.client, d, creatorVault);
  assert.ok(creatorNext);
  const off = await signVaultConfigurePool(creatorChain, creatorNext, { chainId: ROBINHOOD_CHAIN_ID, configure: { hook, poolId: id, field: POOL_SETTING.VOLATILITY_FEE, value: 0n } });
  await send(creatorVault, ostraVaultAbi, "spend", [off.action, off.nextKeyRoot, off.params, off.signature]);
  assert.equal((await config()).volatilityFee, false);

  // A buyer vault swaps USDG into its token vault during the anti-farmer period; the swap pays dividends.
  const buyerChain = await keychain("launch-buyer");
  const holderChain = await keychain("launch-holder");
  const buyer = await createVault(buyerChain, zeroAddress);
  const holder = await createVault(holderChain, zeroAddress, token);
  await fork.dealUsdg(buyer, 100_000_000n);
  const buyerState = await readVault(fork.client, d, buyer);
  assert.ok(buyerState);
  const swap = await signVaultSwap(buyerChain, buyerState, { chainId: ROBINHOOD_CHAIN_ID, token: USDG, swap: { key, zeroForOne: getAddress(key.currency0) === USDG, amountIn: 20_000_000n, minOut: 1n, recipient: holder } });
  await send(buyer, ostraVaultAbi, "spend", [swap.action, swap.nextKeyRoot, swap.params, swap.signature]);
  await send(hook, hookArt.abi, "dispatch", [id]);
  const owed = (await fork.client.readContract({ address: token, abi: tokenArt.abi, functionName: "dividendOf", args: [holder] })) as bigint;
  assert.ok(owed > 0n);

  // ClaimDividend: the token vault claims its USDG dividends to the buyer's USDG vault.
  const holderState = await readVault(fork.client, d, holder);
  assert.ok(holderState);
  assert.equal(holderState.token, token);
  const claim = await signVaultClaimDividend(holderChain, holderState, { chainId: ROBINHOOD_CHAIN_ID, recipient: buyer });
  assert.equal(claim.action, VAULT_ACTION.CLAIM_DIVIDEND);
  const usdgBefore = await balance(buyer);
  await send(holder, ostraVaultAbi, "spend", [claim.action, claim.nextKeyRoot, claim.params, claim.signature]);
  assert.equal((await balance(buyer)) - usdgBefore, owed);
  assert.equal(await fork.client.readContract({ address: token, abi: tokenArt.abi, functionName: "dividendOf", args: [holder] }), 0n);
  assert.equal((await readVault(fork.client, d, holder))?.nonce, 1n);
});

test("a guardian recovery the SDK signs moves a lost vault to a new seed", async () => {
  // The owner's vault, two guardian vaults (2 of 2 here), and the seed the owner starts over with.
  const lost = await keychain("recovery-owner");
  const g1 = await keychain("recovery-guardian-1");
  const g2 = await keychain("recovery-guardian-2");
  const fresh = await keychain("recovery-new-seed");
  const vault = await createVault(lost, zeroAddress);
  const guardian1 = await createVault(g1, zeroAddress);
  const guardian2 = await createVault(g2, zeroAddress);
  await fork.dealUsdg(vault, 30_000_000n);
  const spendWith = async (chain: WotsKeychain, v: Address, sign: (state: NonNullable<Awaited<ReturnType<typeof readVault>>>) => Promise<{ action: number; nextKeyRoot: Hex; params: Hex; signature: Hex }>) => {
    const state = await readVault(fork.client, d, v);
    assert.ok(state);
    const s = await sign(state);
    return send(v, ostraVaultAbi, "spend", [s.action, s.nextKeyRoot, s.params, s.signature]);
  };
  for (const guardian of [guardian1, guardian2]) {
    await spendWith(lost, vault, (st) => signVaultSetGuardian(lost, st, { chainId: ROBINHOOD_CHAIN_ID, guardian, enabled: true }));
  }
  await spendWith(lost, vault, (st) => signVaultSetRecoveryPolicy(lost, st, { chainId: ROBINHOOD_CHAIN_ID, threshold: 2, delay: DEFAULT_RECOVERY_DELAY }));
  let r = await readRecovery(fork.client, vault);
  assert.deepEqual({ guardianCount: r.guardianCount, threshold: r.threshold, delay: r.delay, pending: r.pending }, { guardianCount: 2, threshold: 2, delay: DEFAULT_RECOVERY_DELAY, pending: null });

  // The seed is lost. The new seed's key at the vault's nonce is what the guardians support.
  const nonce = (await readVault(fork.client, d, vault))!.nonce;
  const newKeyRoot = recoveryKeyRoot(fresh, nonce);
  await assert.rejects(() => signVaultSupportRecovery(g1, { vault: guardian1, nonce: 0n, keyRoot: bytesToHex(g1.keyRoot(0n)) }, { chainId: ROBINHOOD_CHAIN_ID, vault: guardian1, newKeyRoot }), /own recovery/);
  await spendWith(g1, guardian1, (st) => signVaultSupportRecovery(g1, st, { chainId: ROBINHOOD_CHAIN_ID, vault, newKeyRoot }));
  assert.equal((await readRecovery(fork.client, vault)).pending, null);
  const started = await spendWith(g2, guardian2, (st) => signVaultSupportRecovery(g2, st, { chainId: ROBINHOOD_CHAIN_ID, vault, newKeyRoot }));
  const [event] = parseEventLogs({ abi: ostraVaultAbi, logs: started.logs, eventName: "RecoveryStarted" });
  assert.ok(event);
  assert.equal(event.args.newKeyRoot, newKeyRoot);
  r = await readRecovery(fork.client, vault);
  assert.equal(r.pending?.newKeyRoot, newKeyRoot);

  await fork.increaseTime(DEFAULT_RECOVERY_DELAY);
  await send(vault, ostraVaultAbi, "finishRecovery", []);
  const after1 = await readVault(fork.client, d, vault);
  assert.equal(after1?.keyRoot, newKeyRoot);
  assert.equal(after1?.nonce, nonce);
  assert.equal((await readRecovery(fork.client, vault)).pending, null);

  // The new seed spends the vault from the same nonce.
  const to = fork.accounts[3]!.address;
  const before = await balance(to);
  await spendWith(fresh, vault, (st) => signVaultTransfer(fresh, st, { chainId: ROBINHOOD_CHAIN_ID, to, amount: 30_000_000n }));
  assert.equal((await balance(to)) - before, 30_000_000n);
});

test("a crank change the SDK signs lands", async () => {
  const chain = await keychain("crank");
  const vault = await createVault(chain, zeroAddress);
  const state = await readVault(fork.client, d, vault);
  assert.ok(state);
  assert.equal(state.crank, null);
  const spend = await signVaultSetCrankKey(chain, state, { chainId: ROBINHOOD_CHAIN_ID, crank: crank.address });
  await send(vault, ostraVaultAbi, "spend", [spend.action, spend.nextKeyRoot, spend.params, spend.signature]);
  assert.equal((await readVault(fork.client, d, vault))?.crank, crank.address);
});

test("pool messages are the pool's own; a relayed deposit is approved, sealed and its leaf spent", async () => {
  const leafChain = await keychain("leaves");
  const approvalChain = await keychain("approvals");
  const pool = await readPool(fork.client, d.pool);
  assert.equal(pool.feeBps, 30);
  assert.equal(pool.leafAmount, LEAF_DENOMINATION);
  const leaves: Leaf[] = [{ keyRoot: leafChain.keyRoot(0n), amount: LEAF_DENOMINATION }];
  const commitment = depositCommitment(leaves);
  const depositId = keccak256(stringToHex("deposit 1"));
  const amount = depositForLeaves(1, pool.feeBps);
  const args = {
    depositor: depositor.address,
    depositId,
    amount,
    refundOwner: depositor.address,
    approvalKeyRoot: bytesToHex(approvalChain.keyRoot(0n)),
    commitment,
  };
  const key = depositKey(depositor.address, depositId);
  assert.equal(key, await fork.client.readContract({ address: d.pool, abi: ostraPoolAbi, functionName: "depositKey", args: [depositor.address, depositId] }));
  assert.equal(
    depositNonce({ ...args, chainId: ROBINHOOD_CHAIN_ID, pool: d.pool }),
    await fork.client.readContract({
      address: d.pool,
      abi: ostraPoolAbi,
      functionName: "depositNonce",
      args: [depositor.address, depositId, amount, depositor.address, args.approvalKeyRoot, bytesToHex(commitment)],
    }),
  );

  // The depositor holds USDG and no ETH; the relayer submits its signed authorization.
  await fork.dealUsdg(depositor.address, amount);
  const block = await fork.client.getBlock();
  const typed = depositAuthorizationTypedData({ ...args, chainId: ROBINHOOD_CHAIN_ID, pool: d.pool, validAfter: 0n, validBefore: block.timestamp + 3600n });
  const { v, r, s } = parseSignature(await depositor.signTypedData(typed));
  await send(d.pool, ostraPoolAbi, "depositWithAuthorization", [
    depositor.address,
    depositId,
    amount,
    depositor.address,
    args.approvalKeyRoot,
    bytesToHex(commitment),
    0n,
    typed.message.validBefore,
    Number(v),
    r,
    s,
  ]);
  const dep = await readDeposit(fork.client, d.pool, key);
  assert.equal(dep.status, "pending");
  assert.equal(dep.amount, amount);
  assert.equal(dep.commitmentHash, keccak256(bytesToHex(commitment)));
  assert.equal(await balance(depositor.address), 0n);

  // A batch of the one leaf; the depositor approves its exact state.
  const batchId = pool.batchCount;
  await send(d.pool, ostraPoolAbi, "createBatch", [1]);
  await send(d.pool, ostraPoolAbi, "appendLeaves", [batchId, [bytesToHex(leaves[0]!.keyRoot)]]);
  const batch = await readBatch(fork.client, d.pool, batchId);
  assert.equal(batch.status, "open");
  assert.deepEqual(batch.leaves, [{ keyRoot: bytesToHex(leaves[0]!.keyRoot), amount: LEAF_DENOMINATION, spent: false }]);
  const state = batchStateOf(batch);
  assert.equal(state, await fork.client.readContract({ address: d.pool, abi: ostraPoolAbi, functionName: "batchState", args: [batchId] }));
  const nextRoot = bytesToHex(approvalChain.keyRoot(1n));
  assert.equal(
    bytesToHex(approvalMessage({ chainId: ROBINHOOD_CHAIN_ID, pool: d.pool, key, batchId, state, nextKeyRoot: nextRoot })),
    await fork.client.readContract({ address: d.pool, abi: ostraPoolAbi, functionName: "approvalMessage", args: [key, batchId, state, nextRoot] }),
  );
  const approval = await signApproveBatch(approvalChain, { index: 0n, currentKeyRoot: dep.approvalKeyRoot }, { chainId: ROBINHOOD_CHAIN_ID, pool: d.pool, key, batchId, state });
  await send(d.pool, ostraPoolAbi, "approveBatch", [approval.key, approval.batchId, approval.state, approval.nextKeyRoot, approval.signature]);
  const approved = await readDeposit(fork.client, d.pool, key);
  assert.equal(approved.approvedBatch, batchId);
  assert.equal(approved.approvedState, state);
  assert.equal(approved.approvalKeyRoot, nextRoot);

  await send(d.pool, ostraPoolAbi, "sealBatch", [batchId, [key], [bytesToHex(commitment)]]);
  assert.equal((await readBatch(fork.client, d.pool, batchId)).status, "sealed");
  assert.equal((await readDeposit(fork.client, d.pool, key)).status, "consumed");

  // The leaf key moves the leaf, whole, to the destination it signed.
  const destination = fork.accounts[2]!.address;
  assert.equal(
    bytesToHex(leafMessage({ chainId: ROBINHOOD_CHAIN_ID, pool: d.pool, batchId, leafIndex: 0, destination, leafAmount: LEAF_DENOMINATION })),
    await fork.client.readContract({ address: d.pool, abi: ostraPoolAbi, functionName: "leafMessage", args: [batchId, 0, destination] }),
  );
  const before = await balance(destination);
  const leafSpend = await signSpendLeaf(leafChain, { index: 0n, leafKeyRoot: batch.leaves[0]!.keyRoot }, { chainId: ROBINHOOD_CHAIN_ID, pool: d.pool, batchId, leafIndex: 0, destination, leafAmount: LEAF_DENOMINATION });
  await send(d.pool, ostraPoolAbi, "spendLeaf", [leafSpend.batchId, leafSpend.leafIndex, leafSpend.destination, leafSpend.signature]);
  assert.equal((await balance(destination)) - before, LEAF_DENOMINATION);
  const spentBatch = await readBatch(fork.client, d.pool, batchId);
  assert.equal(spentBatch.unspent, 0);
  assert.equal(spentBatch.leaves[0]?.spent, true);
});
