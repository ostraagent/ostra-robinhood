// Swaps from a plain wallet through Uniswap's Universal Router, on a fork of
// Robinhood Chain mainnet (the live router, quoter and Permit2; Ostra's
// contracts deployed on the fork):
//   * a USDG pool: a buy that approves Permit2 and signs a Permit2 allowance
//     first, a second buy that only signs, and a sell of the token, each
//     landing at least at its quote's minOut;
//   * an ETH pool launched from a wallet (the creator's WETH vault named): a
//     buy paid as the transaction's value and a sell back to ETH;
//   * a buy above the pool's max buy is refused by its quote, with the
//     hook's reason, before the wallet is asked for anything.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { encodeFunctionData, keccak256, parseEventLogs, stringToHex, zeroAddress, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  LAUNCHPAD,
  USDG,
  WETH,
  launchParams,
  ostraLaunchpadAbi,
  ostraTokenAbi,
  ostraVaultFactoryAbi,
  retryingHttp,
  startTickForMarketCap,
  usdgAbi,
  vaultAddress,
  type Deployment,
  type LaunchpadDeployment,
} from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import {
  Keys,
  LaunchpadService,
  LocalSender,
  VaultService,
  WALLET_SWAP_DEADLINE_SECONDS,
  WalletSwapError,
  X402_NETWORK,
  permitSingleTypedData,
  quoteWalletSwap,
  readPoolView,
  simulateWalletSwap,
  walletSwapCall,
  walletSwapNeeds,
  type Config,
  type WalletSwapQuote,
} from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";

let fork: Fork;
let d: Deployment;
let lpd: LaunchpadDeployment;
let root: string;
let config: Config;
let trader: PrivateKeyAccount;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-wallet-swap-"));
  fork = await startFork();
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  if (d.launchpad === undefined) throw new Error("no launchpad on the fork");
  lpd = d.launchpad;
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  // A fresh key: anvil's development accounts carry EIP-7702 delegations on Robinhood Chain mainnet, so Permit2
  // would check their signatures through the delegate (EIP-1271) instead of ecrecover.
  trader = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/WALLET-SWAP-FORK/trader")));
  await fork.setBalance(trader.address, 10n ** 19n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const balanceOf = (token: Address, who: Address) =>
  token === zeroAddress ? fork.client.getBalance({ address: who }) : (fork.client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>);

async function chainNow(): Promise<bigint> {
  return (await fork.client.getBlock({ blockTag: "latest" })).timestamp;
}

async function send(account: PrivateKeyAccount, call: { to: Address; data: Hex; value?: bigint }) {
  const hash = await fork.wallet(account).sendTransaction({ account, chain: fork.client.chain, to: call.to, data: call.data, value: call.value ?? 0n });
  const receipt = await fork.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    const tx = await fork.client.getTransaction({ hash });
    console.error("REVERTED gas", tx.gas, "used", receipt.gasUsed);
    const { execFileSync } = await import("node:child_process");
    try {
      console.error(execFileSync("cast", ["run", hash, "--rpc-url", fork.url], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).slice(-6000));
    } catch (e) {
      console.error("TRACE", (e as { stdout?: string }).stdout?.slice(-6000), (e as { stderr?: string }).stderr?.slice(-1500));
    }
  }
  assert.equal(receipt.status, "success", `transaction to ${call.to} failed`);
  return receipt;
}

/** The wallet's whole swap, as the web app runs it: approval, Permit2 signature, simulation, the router call. */
async function walletSwap(q: WalletSwapQuote): Promise<{ approved: boolean; permitted: boolean; spent: bigint; received: bigint }> {
  const client = fork.client as PublicClient;
  const now = await chainNow();
  const needs = await walletSwapNeeds(client, q, trader.address, now);
  if (needs.approve !== null) await send(trader, needs.approve);
  let permit: { permit: NonNullable<typeof needs.permit>; signature: Hex } | undefined;
  if (needs.permit !== null) {
    const typed = permitSingleTypedData(d.chainId, needs.permit);
    const signature = await trader.signTypedData(typed);
    permit = { permit: needs.permit, signature };
  }
  const call = walletSwapCall(q, { deadline: now + BigInt(WALLET_SWAP_DEADLINE_SECONDS), ...(permit === undefined ? {} : { permit }) });
  await simulateWalletSwap(client, trader.address, call);
  const [inBefore, outBefore] = await Promise.all([balanceOf(q.currencyIn, trader.address), balanceOf(q.currencyOut, trader.address)]);
  const receipt = await send(trader, call);
  const [inAfter, outAfter] = await Promise.all([balanceOf(q.currencyIn, trader.address), balanceOf(q.currencyOut, trader.address)]);
  const gas = receipt.gasUsed * receipt.effectiveGasPrice;
  const spent = inBefore - inAfter - (q.currencyIn === zeroAddress ? gas : 0n);
  const received = outAfter - outBefore + (q.currencyOut === zeroAddress ? gas : 0n);
  return { approved: needs.approve !== null, permitted: needs.permit !== null, spent, received };
}

test("a wallet buys and sells on a USDG pool and an ETH pool through the Universal Router; a buy above the max buy is refused by its quote", { timeout: 900_000 }, async () => {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/WALLET-SWAP-FORK/fee-payer")));
  await fork.setBalance(feePayer.address, 10n ** 18n);
  const keys = new Keys({ master: new Uint8Array(32).fill(33), feePayer, store: new FileWotsStore(join(root, "wots")), folder: new MemoryFolder(), backupExported: async () => true });
  const creatorKeys = await keys.forCreatorVault(d.chainId, USDG);
  const local = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, local, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, local, "creator");
  const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: local, creator, creatorSender: local });
  const opened = await buyer.open();
  await fork.dealUsdg(opened.vault, 100_000_000n);
  await lp.fundCreatorVault("20");

  // A USDG pool, launched from the creator vault.
  const launched = await lp.launch({ name: "Wallet Swap", symbol: "WSWAP", marketCap: "50000" });
  assert.equal(launched.status, "launched");
  if (launched.status !== "launched") return;
  const token = launched.token;
  await fork.dealUsdg(trader.address, 100_000_000n);

  // First buy: approve Permit2, sign the allowance, swap.
  const q1 = await quoteWalletSwap(client, lpd, { account: trader.address, token, side: "buy", amountIn: 10_000_000n });
  assert.equal(q1.currencyIn, USDG);
  assert.equal(q1.currencyOut, token);
  assert.ok(q1.minOut > 0n && q1.minOut < q1.expectedOut);
  // A swap past its deadline: the router's reason comes back decoded, and nothing was sent.
  await assert.rejects(simulateWalletSwap(client, trader.address, walletSwapCall(q1, { deadline: (await chainNow()) - 1n })), /TransactionDeadlinePassed/);
  const b1 = await walletSwap(q1);
  assert.deepEqual([b1.approved, b1.permitted], [true, true]);
  assert.equal(b1.spent, 10_000_000n);
  assert.ok(b1.received >= q1.minOut, `${b1.received} < ${q1.minOut}`);

  // Second buy: Permit2 is approved already; the allowance was used, so a new one is signed.
  const q2 = await quoteWalletSwap(client, lpd, { account: trader.address, token, side: "buy", amountIn: 5_000_000n, slippageBps: 50 });
  const b2 = await walletSwap(q2);
  assert.deepEqual([b2.approved, b2.permitted], [false, true]);
  assert.equal(b2.spent, 5_000_000n);
  assert.ok(b2.received >= q2.minOut);

  // Sell half the tokens back for USDG.
  const held = await balanceOf(token, trader.address);
  assert.equal(held, b1.received + b2.received);
  const q3 = await quoteWalletSwap(client, lpd, { account: trader.address, token, side: "sell", amountIn: held / 2n });
  assert.equal(q3.currencyOut, USDG);
  const s1 = await walletSwap(q3);
  assert.deepEqual([s1.approved, s1.permitted], [true, true]);
  assert.equal(s1.spent, held / 2n);
  assert.ok(s1.received >= q3.minOut && s1.received > 0n);

  // The pool's view after the trades: the price rose from the start.
  const view = await readPoolView(client, lpd, token);
  assert.equal(view.quote, USDG);
  assert.equal(view.rules.quoteDecimals, 6);
  assert.equal(view.rules.maxWallet, null);
  assert.ok(Number(view.quoteRaised) > 0);

  // A pool with a max buy of 1,000 tokens for an hour: a 50 USDG buy is refused by its quote.
  const limited = await lp.launch({ name: "Max Buy", symbol: "MAXB", marketCap: "50000", options: { maxBuy: 1_000n * 10n ** 18n, limitsDuration: 3_600 } });
  assert.equal(limited.status, "launched");
  if (limited.status !== "launched") return;
  await assert.rejects(quoteWalletSwap(client, lpd, { account: trader.address, token: limited.token, side: "buy", amountIn: 50_000_000n }), (err: unknown) => {
    assert.ok(err instanceof WalletSwapError);
    assert.match(err.message, /refuses this buy now: \w+/);
    return true;
  });
  assert.equal((await readPoolView(client, lpd, limited.token)).maxBuy, "1000");

  // An ETH pool, launched from a wallet that names the creator's WETH vault.
  const wethRoot = keccak256(stringToHex("OSTRA/CORE/WALLET-SWAP-FORK/weth-vault-root"));
  await send(trader, { to: d.vaultFactory, data: encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [WETH, wethRoot, zeroAddress] }) });
  const wethVault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: WETH, initialKeyRoot: wethRoot, initialCrank: zeroAddress });
  const ethLaunch = launchParams({
    name: "Ether Pool",
    symbol: "EPOOL",
    salt: keccak256(stringToHex("OSTRA/CORE/WALLET-SWAP-FORK/eth-pool")),
    quote: zeroAddress,
    creatorVault: wethVault,
    startTick: startTickForMarketCap(20n * 10n ** 18n),
  });
  const receipt = await send(trader, { to: lpd.launchpad, data: encodeFunctionData({ abi: ostraLaunchpadAbi, functionName: "launch", args: [ethLaunch] }), value: LAUNCHPAD.FEE_WEI });
  const [ev] = parseEventLogs({ abi: ostraLaunchpadAbi, eventName: "Launched", logs: receipt.logs });
  assert.ok(ev !== undefined);
  const ethToken = (ev.args as { token: Address }).token;
  const q4 = await quoteWalletSwap(client, lpd, { account: trader.address, token: ethToken, side: "buy", amountIn: 10n ** 16n });
  assert.equal(q4.currencyIn, zeroAddress);
  const b4 = await walletSwap(q4);
  assert.deepEqual([b4.approved, b4.permitted], [false, false]);
  assert.equal(b4.spent, 10n ** 16n);
  assert.ok(b4.received >= q4.minOut);
  const tokensHeld = (await fork.client.readContract({ address: ethToken, abi: ostraTokenAbi, functionName: "balanceOf", args: [trader.address] })) as bigint;
  const q5 = await quoteWalletSwap(client, lpd, { account: trader.address, token: ethToken, side: "sell", amountIn: tokensHeld });
  assert.equal(q5.currencyOut, zeroAddress);
  const s5 = await walletSwap(q5);
  assert.deepEqual([s5.approved, s5.permitted], [true, true]);
  assert.ok(s5.received >= q5.minOut && s5.received > 0n);
  const ethView = await readPoolView(client, lpd, ethToken);
  assert.equal(ethView.quote, zeroAddress);
  assert.equal(ethView.rules.quoteDecimals, 18);
});
