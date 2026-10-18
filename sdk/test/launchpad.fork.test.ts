// The launchpad through the SDK on a fork of Robinhood Chain mainnet: the
// launchpad deployed and wired by deployLaunchpad next to Ostra (the real
// PoolManager, USDG and WETH), a launch paid from the creator's vault
// (signVaultDevBuy, launchHash against the contract's own, relayValue), and a
// vault Swap quoted before it is signed (quoteVaultSwap: swapGas, minOut and
// the circuit breaker's room), then signed with the quote and sent.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bytesToHex, encodeFunctionData, hexToBytes, keccak256, parseEventLogs, stringToHex, zeroAddress, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { ostraDevBuyAbi, ostraHookAbi, ostraLaunchpadAbi, ostraTokenAbi, ostraVaultAbi, ostraVaultFactoryAbi } from "../src/abi.ts";
import { LAUNCHPAD, USDG, VAULT_ACTION, VAULT_SWAP_GAS } from "../src/constants.ts";
import { checkLaunchpad } from "../src/deploy.ts";
import { parseDeployment, type Deployment } from "../src/deployment.ts";
import { usdgAbi } from "../src/external-abi.ts";
import { NO_DEV_BUY, decodeDevBuyParams, launchFromVaultData, launchHash, launchParams, signVaultDevBuy, startTickForMarketCap, type DevBuyTerms, type LaunchParams } from "../src/launch.ts";
import { signVaultSwap, vaultAddress, type PoolKey } from "../src/messages.ts";
import { SwapQuoteError, poolTick, quoteVaultSwap } from "../src/quote.ts";
import { readVault } from "../src/reads.ts";
import { relayValue, simulateRelay } from "../src/relayer.ts";
import { FileWotsStore } from "../src/wots-file.ts";
import { WotsKeychain } from "../src/wots.ts";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "./fork.ts";

const MASTER = hexToBytes(keccak256(stringToHex("OSTRA/EVM/SDK-LAUNCHPAD-TEST/master")));
const keychainId = (name: string) => hexToBytes(keccak256(stringToHex(`OSTRA/EVM/SDK-LAUNCHPAD-TEST/${name}`)));

let fork: Fork;
let d: Deployment;
let relayer: PrivateKeyAccount;
const dirs: string[] = [];

async function keychain(name: string): Promise<WotsKeychain> {
  const dir = await mkdtemp(join(tmpdir(), "ostra-sdk-launchpad-"));
  dirs.push(dir);
  return new WotsKeychain(MASTER, keychainId(name), new FileWotsStore(dir));
}

async function sendData(to: Address, data: Hex, value = 0n) {
  const hash = await fork.wallet(relayer).sendTransaction({ account: relayer, chain: fork.client.chain, to, data, value });
  const receipt = await fork.client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction to ${to} failed`);
  return receipt;
}

async function createVault(chain: WotsKeychain, token: Address): Promise<Address> {
  const root = bytesToHex(chain.keyRoot(0n));
  await sendData(d.vaultFactory, encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [token, root, zeroAddress] }));
  return vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot: root, initialCrank: zeroAddress });
}

const usdg = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] });

before(async () => {
  fork = await startFork();
  relayer = fork.accounts[0] as PrivateKeyAccount;
  await fork.setBalance(relayer.address, 10n ** 19n);
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
});

after(async () => {
  await fork?.stop();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test("deployLaunchpad wires the launchpad next to Ostra, and the record parses back", async () => {
  assert.ok(d.launchpad);
  await checkLaunchpad(fork.client, d);
  assert.deepEqual(parseDeployment(JSON.parse(JSON.stringify(d))), d);
  assert.equal(BigInt(d.launchpad.hook) & BigInt(LAUNCHPAD.HOOK_FLAGS_MASK), BigInt(LAUNCHPAD.HOOK_FLAGS));
  assert.equal(startTickForMarketCap(50_000_000_000n), -375_400);
});

let token: Address;
let key: PoolKey;

test("a launch paid from the creator vault: the SDK's launch hash is the contract's, the relayer sends the launch fee", async () => {
  const l = d.launchpad!;
  const creatorChain = await keychain("creator");
  const creatorVault = await createVault(creatorChain, USDG);
  await fork.dealUsdg(creatorVault, 200_000_000n);
  const p: LaunchParams = launchParams({ name: "Ostra SDK Launch", symbol: "OSDKL", salt: keccak256(stringToHex("sdk vault launch")), quote: USDG, creatorVault, startTick: startTickForMarketCap(50_000_000_000n) });
  const predicted = (await fork.client.readContract({ address: l.devBuy, abi: ostraDevBuyAbi, functionName: "tokenAddressFromVault", args: [p] })) as Address;
  const tokenVault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: predicted, initialKeyRoot: bytesToHex((await keychain("creator-token")).keyRoot(0n)), initialCrank: zeroAddress });
  const dev: DevBuyTerms = { quoteIn: 50_000_000n, beneficiary: tokenVault, dividendRecipient: zeroAddress, cliff: 7 * 86_400, duration: 30 * 86_400 };
  // The hash OstraVault's DevBuy spend signs: the SDK's encoding is the contract's.
  assert.equal(launchHash(p, dev), await fork.client.readContract({ address: l.devBuy, abi: ostraDevBuyAbi, functionName: "launchHash", args: [p, dev] }));
  assert.equal(launchHash(p, NO_DEV_BUY), await fork.client.readContract({ address: l.devBuy, abi: ostraDevBuyAbi, functionName: "launchHash", args: [p, NO_DEV_BUY] }));
  const state = await readVault(fork.client, d, creatorVault);
  assert.ok(state);
  await assert.rejects(() => signVaultDevBuy(creatorChain, { ...state, vault: tokenVault }, { chainId: d.chainId, devBuy: l.devBuy, launch: p, dev }), /creator vault/);
  const signed = await signVaultDevBuy(creatorChain, state, { chainId: d.chainId, devBuy: l.devBuy, launch: p, dev });
  assert.equal(signed.action, VAULT_ACTION.DEV_BUY);
  assert.deepEqual(decodeDevBuyParams(signed.params), { devBuy: l.devBuy, launchHash: launchHash(p, dev), amount: dev.quoteIn });
  const data = launchFromVaultData(p, dev, signed);
  // The relayer sends the launch fee with a vault-funded launch, and nothing with anything else.
  assert.equal(relayValue(d, { to: l.devBuy, data }), LAUNCHPAD.FEE_WEI);
  assert.equal(relayValue(d, { to: l.launchpad, data }), 0n);
  assert.equal(relayValue(d, { to: creatorVault, data: "0x12345678" }), 0n);
  // The simulation the relayer prices with, then the launch itself.
  const sim = await simulateRelay(fork.client, { relayer: relayer.address, to: l.devBuy, data, value: LAUNCHPAD.FEE_WEI });
  assert.ok(sim.gasUsed > 2_000_000n);
  const receipt = await sendData(l.devBuy, data, LAUNCHPAD.FEE_WEI);
  const [bought] = parseEventLogs({ abi: ostraDevBuyAbi, logs: receipt.logs, eventName: "DevBought" });
  assert.ok(bought);
  assert.equal(bought.args.token, predicted);
  assert.equal(await usdg(creatorVault), 150_000_000n);
  assert.equal((await readVault(fork.client, d, creatorVault))?.nonce, 1n);
  token = predicted;
  const id = (await fork.client.readContract({ address: l.launchpad, abi: ostraLaunchpadAbi, functionName: "poolOf", args: [token] })) as Hex;
  assert.notEqual(BigInt(id), 0n);
  key = (await fork.client.readContract({ address: l.hook, abi: ostraHookAbi, functionName: "poolKey", args: [id] })) as PoolKey;
});

test("a vault Swap is quoted before it is signed: the quote's swapGas and minOut, then the signed swap lands at least at minOut", async () => {
  const l = d.launchpad!;
  const buyerChain = await keychain("buyer");
  const buyer = await createVault(buyerChain, USDG);
  await fork.dealUsdg(buyer, 100_000_000n);
  const buyerToken = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot: bytesToHex((await keychain("buyer-token")).keyRoot(0n)), initialCrank: zeroAddress });
  const zeroForOne = key.currency0.toLowerCase() === USDG.toLowerCase();
  const before = await readVault(fork.client, d, buyer);
  const quote = await quoteVaultSwap(fork.client, d, { vault: buyer, relayer: relayer.address, swap: { key, zeroForOne, amountIn: 20_000_000n, recipient: buyerToken } });
  // Nothing was signed or spent by the quote.
  assert.deepEqual(await readVault(fork.client, d, buyer), before);
  assert.ok(quote.amountOut > 0n && quote.swap.minOut === (quote.amountOut * 9_900n) / 10_000n);
  assert.ok(quote.swapGasNeeded >= BigInt(VAULT_SWAP_GAS.MIN) && quote.swapGasNeeded < 1_000_000n, `needed ${quote.swapGasNeeded}`);
  assert.equal(quote.swap.swapGas, (quote.swapGasNeeded * 3n) / 2n + 50_000n);
  const id = (await fork.client.readContract({ address: l.launchpad, abi: ostraLaunchpadAbi, functionName: "poolOf", args: [token] })) as Hex;
  assert.ok(quote.band !== null && quote.band.usedBps < 8_000 && quote.band.tickBefore === (await poolTick(fork.client, id)));
  assert.ok(quote.band.tickAfter !== quote.band.tickBefore);
  const state = await readVault(fork.client, d, buyer);
  assert.ok(state);
  const signed = await signVaultSwap(buyerChain, state, { chainId: d.chainId, token: USDG, swap: quote.swap });
  const receipt = await sendData(buyer, encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [signed.action, signed.nextKeyRoot, signed.params, signed.signature] }));
  const [swapped] = parseEventLogs({ abi: ostraVaultAbi, logs: receipt.logs, eventName: "Swapped" });
  assert.ok(swapped, "the quoted swap swapped");
  assert.ok(swapped.args.amountOut >= quote.swap.minOut);
  assert.equal(await fork.client.readContract({ address: token, abi: ostraTokenAbi, functionName: "balanceOf", args: [buyerToken] }), swapped.args.amountOut);
});


test("a swap that cannot pass, or that would use most of the circuit breaker's room, is refused before anything is signed", async () => {
  const buyerChain = await keychain("buyer-2");
  const buyer = await createVault(buyerChain, USDG);
  await fork.dealUsdg(buyer, 10_000_000n);
  const zeroForOne = key.currency0.toLowerCase() === USDG.toLowerCase();
  // More than the vault holds: it fails at any gas.
  await assert.rejects(
    () => quoteVaultSwap(fork.client, d, { vault: buyer, relayer: relayer.address, swap: { key, zeroForOne, amountIn: 50_000_000n, recipient: relayer.address } }),
    (err: unknown) => err instanceof SwapQuoteError && err.code === "swap_fails",
  );
  await assert.rejects(
    () => quoteVaultSwap(fork.client, d, { vault: buyer, relayer: relayer.address, swap: { key, zeroForOne, amountIn: 1_000_000n, recipient: relayer.address }, slippageBps: 1_001 }),
    (err: unknown) => err instanceof SwapQuoteError && err.code === "bad_request",
  );
  // The breaker allows 2,231 ticks (+25%) in one transaction: here 2,000 USDG moves about 1,640 of them (74%), 2,400 USDG
  // about 88% (refused as too near), and 3,000 USDG more than the breaker allows (the swap fails at any gas).
  await fork.dealUsdg(buyer, 20_000_000_000n);
  await assert.rejects(
    () => quoteVaultSwap(fork.client, d, { vault: buyer, relayer: relayer.address, swap: { key, zeroForOne, amountIn: 3_000_000_000n, recipient: relayer.address } }),
    (err: unknown) => err instanceof SwapQuoteError && err.code === "swap_fails",
  );
  await assert.rejects(
    () => quoteVaultSwap(fork.client, d, { vault: buyer, relayer: relayer.address, swap: { key, zeroForOne, amountIn: 2_400_000_000n, recipient: relayer.address } }),
    (err: unknown) => err instanceof SwapQuoteError && err.code === "near_circuit_breaker" && /circuit breaker/.test(err.message),
  );
});
