// The buyback (src/buyback.ts) on a fork of Robinhood Chain mainnet: Ostra and
// its launchpad deployed on the fork next to the real USDG, WETH, Uniswap v3
// pools, Universal Router, Permit2, Chainlink ETH/USD, OSTRA and its Pons
// curve. OstraDispatcher's ownership is handed (Ownable2Step) to a fresh key,
// an account without code as the owner is on mainnet. Three pools are launched
// from a wallet, paired with USDG, ETH and OSTRA (the OSTRA bought on its Pons
// curve), and traded through the Universal Router (core wallet-swap.ts), so a
// buyback share is owed in each currency:
//   * a run whose minimum is above every share claims nothing and reports each;
//   * a run claims all three, swaps the USDG for WETH, unwraps the WETH, buys
//     OSTRA on the curve with the ETH and burns every OSTRA it claimed and
//     bought: OSTRA's supply falls by exactly what it burned, the dispatcher
//     owes nothing more, nothing is left waiting, and the account's gas ETH
//     was never spent on OSTRA;
//   * a claim signed and kept by a run that stopped before sending it, with a
//     fee cap the node now refuses, is signed again at its nonce by the next
//     run and counted once; a kept transaction whose nonce another transaction
//     used, with no receipt, stops the run with nothing done until the state is
//     cleared by hand;
//   * a stock token's share is reported, never claimed;
//   * once the curve graduates (bought up on the fork), the USDG and ETH shares
//     stay owed, and the OSTRA share is still claimed and burned.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createWalletClient, encodeFunctionData, http, keccak256, parseEventLogs, stringToHex, zeroAddress, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  LAUNCHPAD,
  OSTRA,
  OSTRA_PONS_CURVE,
  USDG,
  WETH,
  launchParams,
  ostraDispatcherAbi,
  ostraLaunchpadAbi,
  ostraVaultFactoryAbi,
  ponsCurveAbi,
  robinhoodChain,
  retryingHttp,
  startTickForMarketCap,
  usdgAbi,
  vaultAddress,
  type Deployment,
  type LaunchpadDeployment,
} from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { WALLET_SWAP_DEADLINE_SECONDS, permitSingleTypedData, quoteWalletSwap, simulateWalletSwap, walletSwapCall, walletSwapGasLimit, walletSwapNeeds } from "@ostraagent/core/wallet-swap";
import { bestUsdgToWeth, parseUsd, readState, runBuyback, writeState, type BuybackOptions } from "../src/buyback.ts";

let fork: Fork;
let d: Deployment;
let lpd: LaunchpadDeployment;
let root: string;
/** The dispatcher's owner on the fork: a fresh key, an account without code. */
let owner: PrivateKeyAccount;
/** A fresh key that launches and trades (anvil's development keys carry EIP-7702 delegations on mainnet). */
let trader: PrivateKeyAccount;
const events: { event: string; fields?: Record<string, unknown> }[] = [];

const balanceOf = (token: Address, who: Address) => fork.client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const ostraSupply = () => fork.client.readContract({ address: OSTRA, abi: [{ type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const, functionName: "totalSupply" });
const owed = (c: Address) => fork.client.readContract({ address: lpd.dispatcher, abi: ostraDispatcherAbi, functionName: "buybackOwed", args: [c] }) as Promise<bigint>;

async function send(account: PrivateKeyAccount, call: { to: Address; data: Hex; value?: bigint }) {
  const estimate = await fork.client.estimateGas({ account, to: call.to, data: call.data, value: call.value ?? 0n });
  const hash = await fork.wallet(account).sendTransaction({ account, chain: fork.client.chain, to: call.to, data: call.data, value: call.value ?? 0n, gas: walletSwapGasLimit(estimate) });
  const receipt = await fork.client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `transaction to ${call.to} failed`);
  return receipt;
}

/** The wallet's whole swap through the Universal Router, as the web app runs it. */
async function walletSwap(token: Address, side: "buy" | "sell", amountIn: bigint): Promise<void> {
  const client = fork.client as PublicClient;
  const q = await quoteWalletSwap(client, lpd, { account: trader.address, token, side, amountIn });
  const now = (await fork.client.getBlock({ blockTag: "latest" })).timestamp;
  const needs = await walletSwapNeeds(client, q, trader.address, now);
  if (needs.approve !== null) await send(trader, needs.approve);
  let permit: { permit: NonNullable<typeof needs.permit>; signature: Hex } | undefined;
  if (needs.permit !== null) permit = { permit: needs.permit, signature: await trader.signTypedData(permitSingleTypedData(d.chainId, needs.permit)) };
  const call = walletSwapCall(q, { deadline: now + BigInt(WALLET_SWAP_DEADLINE_SECONDS), ...(permit === undefined ? {} : { permit }) });
  await simulateWalletSwap(client, trader.address, call);
  await send(trader, call);
}

/** A pool paired with `quote`, launched from the trader's wallet with a creator vault in the quote's vault token. */
async function launchFromWallet(quote: Address, symbol: string, capInQuote: bigint): Promise<Address> {
  const vaultToken = quote === zeroAddress ? WETH : quote;
  const keyRoot = keccak256(stringToHex(`OSTRA/BUYBACK-FORK/creator-vault/${symbol}`));
  await send(trader, { to: d.vaultFactory, data: encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [vaultToken, keyRoot, zeroAddress] }) });
  const creatorVault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: vaultToken, initialKeyRoot: keyRoot, initialCrank: zeroAddress });
  const p = launchParams({ name: `Buyback ${symbol}`, symbol, salt: keccak256(stringToHex(`OSTRA/BUYBACK-FORK/${symbol}`)), quote, creatorVault, startTick: startTickForMarketCap(capInQuote) });
  const receipt = await send(trader, { to: lpd.launchpad, data: encodeFunctionData({ abi: ostraLaunchpadAbi, functionName: "launch", args: [p] }), value: LAUNCHPAD.FEE_WEI });
  const [ev] = parseEventLogs({ abi: ostraLaunchpadAbi, eventName: "Launched", logs: receipt.logs });
  assert.ok(ev !== undefined);
  return (ev.args as { token: Address }).token;
}

const options = (minUsd: string): BuybackOptions => ({
  client: fork.client as PublicClient,
  transport: retryingHttp(fork.url),
  account: owner,
  deployment: d,
  statePath: join(root, "state", "state.json"),
  minUsdE6: parseUsd(minUsd),
  log: (event, fields) => {
    events.push({ event, ...(fields === undefined ? {} : { fields }) });
  },
});

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-buyback-fork-"));
  fork = await startFork();
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  if (d.launchpad === undefined) throw new Error("no launchpad on the fork");
  lpd = d.launchpad;
  owner = privateKeyToAccount(keccak256(stringToHex("OSTRA/BUYBACK-FORK/owner")));
  trader = privateKeyToAccount(keccak256(stringToHex("OSTRA/BUYBACK-FORK/trader")));
  await fork.setBalance(owner.address, 10n ** 17n);
  await fork.setBalance(trader.address, 50n * 10n ** 18n);
  // Ownable2Step: the fork's deployer (account 0) hands the dispatcher to the owner key, which accepts.
  const [deployer] = fork.accounts as [PrivateKeyAccount];
  await send(deployer, { to: lpd.dispatcher, data: encodeFunctionData({ abi: ostraDispatcherAbi, functionName: "transferOwnership", args: [owner.address] }) });
  await send(owner, { to: lpd.dispatcher, data: encodeFunctionData({ abi: ostraDispatcherAbi, functionName: "acceptOwnership", args: [] }) });
  assert.equal(await fork.client.readContract({ address: lpd.dispatcher, abi: ostraDispatcherAbi, functionName: "owner" }), owner.address);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("the buyback claims the share owed in USDG, ETH and OSTRA, buys OSTRA on its Pons curve and burns it", { timeout: 1_200_000 }, async () => {
  assert.equal(await fork.client.readContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "graduated" }), false, "OSTRA has graduated on mainnet: this test needs its curve");
  // The trader's OSTRA, bought on the curve.
  await send(trader, { to: OSTRA_PONS_CURVE, data: encodeFunctionData({ abi: ponsCurveAbi, functionName: "buy", args: [2n * 10n ** 17n, 0n, trader.address] }), value: 2n * 10n ** 17n });
  const traderOstra = await balanceOf(OSTRA, trader.address);
  assert.ok(traderOstra > 0n);
  await fork.dealUsdg(trader.address, 5_000_000_000n);

  // Three pools, traded so that the buyback share is owed in each currency.
  const usdgToken = await launchFromWallet(USDG, "BBUSDG", 1_000_000n * 10n ** 6n);
  const ethToken = await launchFromWallet(zeroAddress, "BBETH", 500n * 10n ** 18n);
  const ostraToken = await launchFromWallet(OSTRA, "BBOSTRA", 10n ** 9n * 10n ** 18n);
  for (let i = 0; i < 4; i++) await walletSwap(usdgToken, "buy", 500_000_000n);
  for (let i = 0; i < 2; i++) await walletSwap(ethToken, "buy", 5n * 10n ** 17n);
  for (let i = 0; i < 2; i++) await walletSwap(ostraToken, "buy", traderOstra / 4n);
  const [owedUsdg, owedEth, owedOstra] = await Promise.all([owed(USDG), owed(zeroAddress), owed(OSTRA)]);
  assert.ok(owedUsdg > 0n && owedEth > 0n && owedOstra > 0n, `owed ${owedUsdg} ${owedEth} ${owedOstra}`);

  // Above every share: nothing is claimed, each is reported.
  const none = await runBuyback(options("1000000"));
  assert.deepEqual(none.claimed, []);
  assert.equal(none.burnedNow, "0");
  assert.deepEqual(new Set(none.waiting.map((w) => w.currency)), new Set([USDG, zeroAddress, OSTRA]));
  assert.equal(await owed(USDG), owedUsdg);

  // A claim signed and kept by a run that stopped before sending it, with a fee cap below the base fee: the node
  // refuses it, so the next run signs it again at its nonce with fees now, and counts it once.
  const statePath = options("0").statePath;
  const wallet = createWalletClient({ account: owner, chain: robinhoodChain, transport: http(fork.url) });
  const claimData = encodeFunctionData({ abi: ostraDispatcherAbi, functionName: "claimBuyback", args: [USDG, owner.address] });
  const req = await wallet.prepareTransactionRequest({ account: owner, chain: robinhoodChain, to: lpd.dispatcher, data: claimData, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
  const raw = await wallet.signTransaction(req as never);
  const kept = readState(statePath, owner.address);
  kept.inflight = { step: "claim_usdg", hash: keccak256(raw), raw, nonce: Number(req.nonce), value: "0", to: lpd.dispatcher, data: claimData, amount: "0", prior: [], at: new Date().toISOString() };
  writeState(statePath, kept);

  const ethBefore = await fork.client.getBalance({ address: owner.address });
  const supplyBefore = await ostraSupply();
  const quoteNow = await bestUsdgToWeth(fork.client as PublicClient, owedUsdg);
  assert.ok(quoteNow !== null && quoteNow.out > 0n, "a USDG/WETH v3 pool quotes the swap");
  events.length = 0;
  const run = await runBuyback(options("0"));
  assert.ok(events.some((e) => e.event === "resigned"), JSON.stringify(events.map((e) => e.event)));
  // USDG once (the kept claim), ETH as WETH, OSTRA.
  assert.deepEqual(
    run.claimed.map((c) => c.currency),
    ["USDG", "ETH (as WETH)", "OSTRA"],
  );
  assert.equal(run.claimed[0]?.amount, owedUsdg.toString());
  assert.equal(run.claimed[1]?.amount, owedEth.toString());
  assert.equal(run.claimed[2]?.amount, owedOstra.toString());
  assert.deepEqual([await owed(USDG), await owed(zeroAddress), await owed(OSTRA)], [0n, 0n, 0n]);
  for (const step of ["swap", "unwrap", "buy", "burn"]) assert.ok(events.some((e) => e.event === "landed" && e.fields?.step === step), `${step} landed: ${JSON.stringify(events)}`);
  assert.deepEqual(run.pending, { usdg: "0", weth: "0", eth: "0", ostra: "0" });
  // Everything burned: the claimed OSTRA and what the ETH bought; the supply falls by exactly that.
  const burned = BigInt(run.burnedNow);
  assert.ok(burned > owedOstra, `burned ${burned}, claimed OSTRA ${owedOstra}`);
  assert.equal(await ostraSupply(), supplyBefore - burned);
  assert.equal(run.burned, burned.toString());
  assert.deepEqual([await balanceOf(USDG, owner.address), await balanceOf(WETH, owner.address), await balanceOf(OSTRA, owner.address)], [0n, 0n, 0n]);
  // The account's own ETH paid only gas: what the claims brought in was spent on OSTRA, nothing more.
  const ethAfter = await fork.client.getBalance({ address: owner.address });
  assert.ok(ethBefore - ethAfter < 10n ** 15n, `the owner's ETH fell by ${ethBefore - ethAfter} wei`);
  assert.deepEqual(readState(statePath, owner.address).pending, run.pending);

  // A kept claim the node refuses (its fee cap) that can no longer be made (nothing is owed now): its nonce is
  // used by a cancel, which lands and changes nothing.
  const deadData = encodeFunctionData({ abi: ostraDispatcherAbi, functionName: "claimBuyback", args: [OSTRA, owner.address] });
  const deadReq = await wallet.prepareTransactionRequest({ account: owner, chain: robinhoodChain, to: lpd.dispatcher, data: deadData, gas: 200_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
  const deadRaw = await wallet.signTransaction(deadReq as never);
  const dead = readState(statePath, owner.address);
  dead.inflight = { step: "claim_ostra", hash: keccak256(deadRaw), raw: deadRaw, nonce: Number(deadReq.nonce), value: "0", to: lpd.dispatcher, data: deadData, amount: "0", prior: [], at: new Date().toISOString() };
  writeState(statePath, dead);
  const supplyBeforeCancel = await ostraSupply();
  events.length = 0;
  const cancelled = await runBuyback(options("0"));
  assert.ok(events.some((e) => e.event === "cancelling") && events.some((e) => e.event === "cancelled"), JSON.stringify(events.map((e) => e.event)));
  assert.deepEqual(cancelled.claimed, []);
  assert.equal(await fork.client.getTransactionCount({ address: owner.address }), Number(deadReq.nonce) + 1);
  assert.equal(await ostraSupply(), supplyBeforeCancel);
  assert.deepEqual(readState(statePath, owner.address).pending, { usdg: "0", weth: "0", eth: "0", ostra: "0" });

  // A kept transaction with no receipt whose nonce another transaction used: the run stops, nothing is done, the
  // state is left as it was; once it is cleared by hand, the next run goes on.
  const usedNonce = (await fork.client.getTransactionCount({ address: owner.address })) - 1;
  const usedReq = await wallet.prepareTransactionRequest({ account: owner, chain: robinhoodChain, to: owner.address, value: 0n, nonce: usedNonce });
  const usedRaw = await wallet.signTransaction(usedReq as never);
  const stale = readState(statePath, owner.address);
  stale.inflight = { step: "claim_usdg", hash: keccak256(usedRaw), raw: usedRaw, nonce: usedNonce, value: "0", to: owner.address, data: "0x", amount: "0", prior: [], at: new Date().toISOString() };
  writeState(statePath, stale);
  const nonceBefore = await fork.client.getTransactionCount({ address: owner.address });
  await assert.rejects(runBuyback(options("0")), /has no receipt, yet nonce .* is used/);
  assert.equal(await fork.client.getTransactionCount({ address: owner.address }), nonceBefore);
  assert.equal(readState(statePath, owner.address).inflight?.hash, keccak256(usedRaw));
  const cleared = readState(statePath, owner.address);
  cleared.inflight = null;
  writeState(statePath, cleared);
  const quiet = await runBuyback(options("0"));
  assert.deepEqual(quiet.claimed, []);

  // Once the curve graduates: the USDG and ETH shares stay owed; the OSTRA share is still claimed and burned.
  for (let i = 0; i < 2; i++) await walletSwap(usdgToken, "buy", 500_000_000n);
  await walletSwap(ethToken, "buy", 5n * 10n ** 17n);
  await walletSwap(ostraToken, "buy", (await balanceOf(OSTRA, trader.address)) / 2n);
  const threshold = await fork.client.readContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "graduationThreshold" });
  for (let i = 0; i < 20 && !(await fork.client.readContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "graduated" })); i++) {
    await send(trader, { to: OSTRA_PONS_CURVE, data: encodeFunctionData({ abi: ponsCurveAbi, functionName: "buy", args: [threshold / 4n, 0n, trader.address] }), value: threshold / 4n });
  }
  assert.equal(await fork.client.readContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "graduated" }), true, "the curve graduated on the fork");
  const [u2, e2, o2] = await Promise.all([owed(USDG), owed(zeroAddress), owed(OSTRA)]);
  assert.ok(u2 > 0n && e2 > 0n && o2 > 0n);
  const supply2 = await ostraSupply();
  events.length = 0;
  const late = await runBuyback(options("0"));
  assert.equal(late.graduated, true);
  assert.ok(events.some((e) => e.event === "graduated"));
  assert.deepEqual(late.claimed.map((c) => c.currency), ["OSTRA"]);
  assert.equal(late.burnedNow, o2.toString());
  assert.equal(await ostraSupply(), supply2 - o2);
  assert.deepEqual([await owed(USDG), await owed(zeroAddress)], [u2, e2]);
  assert.deepEqual(new Set(late.waiting.map((w) => w.currency)), new Set([USDG, zeroAddress]));
});

test("the minimum is US dollars with at most 6 decimals", () => {
  assert.equal(parseUsd("1"), 1_000_000n);
  assert.equal(parseUsd("0.5"), 500_000n);
  assert.equal(parseUsd("25.123456"), 25_123_456n);
  assert.throws(() => parseUsd("1.1234567"), /at most 6 decimals/);
  assert.throws(() => parseUsd("-1"), /at most 6 decimals/);
  assert.throws(() => parseUsd(""), /at most 6 decimals/);
});
