// A token vault that holds tokens but was never created (MCP 0.1.22; user report of 10 Nov 2026: OSTRA bought and held
// could not be used until a little of it was sold). An agent's vault of a token has its address before it exists, and
// tokens sent there wait for it: an Ostra Swap buy pays the vault of the output token without creating it, as does
// an unshield to the agent's vault or any transfer. The first tool that spends from such a vault creates it first,
// paid by the buyer vault. Through the core services, on a fork of Robinhood Chain mainnet with Ostra and its
// launchpad deployed fresh, against the live OstraRouter (ostra-swap's deployments/robinhood-mainnet.json), Borro,
// Morpho Blue and the ERC-8004 Identity Registry, with the agent's own fee payer sending (LocalSender):
//   * OSTRA bought through Ostra Swap into the OSTRA vault, which does not exist: token_vault shows it; transfer_token
//     sends part of it at once (the vault is created first in its own transaction, then the transfer);
//   * WETH sent straight to the WETH vault's address by a plain ERC-20 transfer: transfer_token sends all of it;
//   * a launched token with dividends in USDG, sent by another agent's transfer_token to this agent's vault of it,
//     which does not exist: the vault earns dividends there; claim_dividends creates it and claims them into the USDG
//     vault; transfer_token then sends the token on;
//   * NVDA and the strategy's carry steps, run through StrategyService.apply on a plan of those steps: while the NVDA
//     vault is empty and not created, lend_stock and link are skipped and nothing is created; NVDA bought through Ostra
//     Swap into that vault, still not created, is counted (its holdings, a position read at its address) and planned
//     without an error, its creation priced; Borro's lend of more than it holds is refused and creates nothing; then
//     lend_stock creates the vault and lends all of it, and link links it to the USDG vault.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createPublicClient, formatUnits, getAddress, http, keccak256, parseAbi, stringToHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, OSTRA, USDG, WETH, borroStock, ostraTokenAbi, readVault, readVaultGuard, retryingHttp, robinhoodChain, usdgAbi, vaultV2Abi, type Deployment } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { parseSwapDeployment, type SwapDeployment } from "@ostraagent/swap";
import { BorroService, Keys, LaunchpadService, LocalSender, StrategyService, SwapService, VaultService, X402_NETWORK, type Config, type Step } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";
import { splitLogsClient } from "./split-logs.ts";

const SWAP: SwapDeployment = parseSwapDeployment(JSON.parse(readFileSync(new URL("../../../ostra-swap/deployments/robinhood-mainnet.json", import.meta.url), "utf8")));
const wethAbi = parseAbi(["function deposit() payable", "function transfer(address to, uint256 amount) returns (bool)"]);
const dispatcherAbi = parseAbi(["function dispatch(bytes32 id)"]);

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
let forkBlock: bigint;
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/UNCREATED-VAULT-FORK/fee-payer")));
/** Robinhood Chain's gas price: the fork block's base fee (anvil's eth_gasPrice adds a 1 gwei tip the chain does not charge). */
const chainGasPrice = async () => (await fork.client.getBlock({ blockNumber: forkBlock })).baseFeePerGas as bigint;
/** Quotes read many pools in one call, which a fork fetches slot by slot from its upstream the first time. */
const quoteClient = () => createPublicClient({ chain: robinhoodChain, transport: http(fork.url, { timeout: 300_000 }) }) as PublicClient;
const balanceOf = (token: Address, who: Address) => fork.client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const exists = async (vault: Address) => (await readVault(fork.client as PublicClient, d, vault)) !== null;
/** A fresh address for `name` (no key is used). */
const someone = (name: string): Address => privateKeyToAccount(keccak256(stringToHex(`OSTRA/CORE/UNCREATED-VAULT-FORK/${name}`))).address;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-uncreated-"));
  fork = await startFork();
  forkBlock = await fork.client.getBlockNumber({ cacheTime: 0 });
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

let planNo = 0;
/** Runs `steps` through StrategyService.apply, as a plan kept in the planner's folder (where plan() keeps its own). */
async function applySteps(a: { keys: Keys; strategy: StrategyService }, steps: Step[]) {
  const id = `${Math.floor(Date.now() / 1000)}-${++planNo}`;
  const dir = a.keys.folder.folder("strategy").folder("plans");
  await dir.ensure();
  await dir.write(`${id}.json`, JSON.stringify({ id, profile: "balanced", at: 0, steps, keep: "0", expected30d: "0", cashApy: "0", trading: null, risks: [], stopWhen: [], breaker: "" }));
  return a.strategy.apply(id);
}
const step = (kind: Step["kind"], what: string, amount: string): Step => ({ kind, what, amount, urgent: false, notBefore: 0, cost: "0", reason: "the test's step" });

/** An agent as its MCP server builds it: one vault service per token (the launchpad's), Ostra Swap, Borro, the planner. */
async function agent(name: string, seed: number) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder: new MemoryFolder(), backupExported: async () => true });
  const creatorKeys = await keys.forCreatorVault(d.chainId, USDG);
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, sender, "creator");
  const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: sender, creator, creatorSender: sender });
  const tokenVault = (token: Address) => lp.tokenVault(token);
  const swap = new SwapService({ client: quoteClient(), logsClient: splitLogsClient(fork.url, forkBlock), config, swap: SWAP, vaultFor: tokenVault, sender, folder: keys.folder.folder("ostra-swap") });
  const ownVaults = async () => [await buyer.vaultAddress(), await creator.vaultAddress()];
  const borro = new BorroService({ client, config, buyer, tokenVault, sender, ownVaults, gasPrice: chainGasPrice });
  const strategy = new StrategyService({ client, logsClient: splitLogsClient(fork.url, forkBlock), config, buyer, tokenVault, creator, borro, folder: keys.folder.folder("strategy"), agentId: async () => null, ethClient: null });
  const opened = await buyer.open();
  await fork.dealUsdg(opened.vault, 500_000_000n);
  return { keys, buyer, creator, lp, tokenVault, swap, borro, strategy, buyerVault: getAddress(opened.vault) };
}

test("OSTRA bought through Ostra Swap into its vault, which does not exist: shown, then sent with transfer_token at once", { timeout: 1_800_000 }, async () => {
  const a = await agent("ostra", 81);
  const vault = getAddress(await a.tokenVault(OSTRA).vaultAddress());
  assert.equal(await exists(vault), false);
  await fork.increaseTime(0);
  const bought = await a.swap.swap({ tokenIn: USDG, tokenOut: OSTRA, amount: "5" });
  assert.ok(bought.status === "sent" && bought.swapped, JSON.stringify(bought));
  assert.equal(getAddress(bought.to), vault);
  assert.equal(await exists(vault), false, "the buy pays the vault's address without creating it");
  const held = await balanceOf(OSTRA, vault);
  assert.ok(held > 0n);
  const info = await a.lp.tokenVaultInfo(OSTRA);
  assert.equal(info.exists, false);
  assert.equal(info.balance, formatUnits(held, 18));

  // Before 0.1.22 this was refused ("this agent has no vault in ..."), until the vault was used once (a sale).
  const to = someone("ostra-recipient");
  const part = held / 3n;
  const nonceBefore = (await readVault(fork.client as PublicClient, d, a.buyerVault))?.nonce;
  const sent = await a.lp.transferToken({ token: OSTRA, destination: to, amount: formatUnits(part, 18) });
  assert.equal(sent.status, "sent", JSON.stringify(sent));
  assert.equal(await exists(vault), true, "transfer_token created the vault first");
  assert.equal(await balanceOf(OSTRA, to), part);
  assert.equal(await balanceOf(OSTRA, vault), held - part);
  assert.equal((await readVault(fork.client as PublicClient, d, vault))?.nonce, 1n, "one spend: the transfer");
  assert.equal((await readVault(fork.client as PublicClient, d, a.buyerVault))?.nonce, nonceBefore, "the buyer vault signed nothing (its fee payer paid the creation)");

  // More than it holds: refused, nothing signed.
  await assert.rejects(a.lp.transferToken({ token: OSTRA, destination: to, amount: formatUnits(held, 18) }), /holds .* less than/);
  assert.equal((await readVault(fork.client as PublicClient, d, vault))?.nonce, 1n);
});

test("WETH sent straight to the WETH vault's address by a plain transfer: transfer_token sends all of it", { timeout: 900_000 }, async () => {
  const a = await agent("weth", 82);
  const vault = getAddress(await a.tokenVault(WETH).vaultAddress());
  assert.equal(await exists(vault), false);
  const sender = fork.accounts[1]!;
  const w = fork.wallet(sender);
  const amount = 10n ** 15n;
  await fork.client.waitForTransactionReceipt({ hash: await w.writeContract({ account: sender, chain: null, address: WETH, abi: wethAbi, functionName: "deposit", value: amount }) });
  await fork.client.waitForTransactionReceipt({ hash: await w.writeContract({ account: sender, chain: null, address: WETH, abi: wethAbi, functionName: "transfer", args: [vault, amount] }) });
  assert.equal(await balanceOf(WETH, vault), amount);

  // A transfer of nothing, or to the vault itself, is refused before the vault is created.
  await assert.rejects(a.lp.transferToken({ token: WETH, destination: vault, amount: formatUnits(amount, 18) }), /the destination is the vault itself/);
  assert.equal(await exists(vault), false);

  const to = someone("weth-recipient");
  const sent = await a.lp.transferToken({ token: WETH, destination: to, amount: formatUnits(amount, 18) });
  assert.equal(sent.status, "sent", JSON.stringify(sent));
  assert.equal(await exists(vault), true);
  assert.equal(await balanceOf(WETH, to), amount);
  assert.equal(await balanceOf(WETH, vault), 0n);
});

test("a launched token sent by another agent to a vault that does not exist: it earns dividends there; claim_dividends creates it and claims", { timeout: 1_800_000 }, async () => {
  const launcher = await agent("launcher", 83);
  const holder = await agent("holder", 84);
  await launcher.lp.fundCreatorVault("20");
  // Dividends in USDG, a quarter of each tax: the buckets and taxes of the launchpad's own fork test (Launchpad.fork.t.sol _params).
  const launched = await launcher.lp.launch({
    name: "Uncreated Vault Test",
    symbol: "UNCV",
    marketCap: "50000",
    options: {
      buyTaxBps: 300,
      sellTaxBps: 500,
      postBuyTaxBps: 100,
      postSellTaxBps: 200,
      taxDuration: 30 * 86_400,
      creatorBucketBps: 2_500,
      dividendBucketBps: 2_500,
      burnBucketBps: 2_500,
      lpBucketBps: 2_500,
      dividendToken: USDG,
      minDividendBalance: 1_000n * 10n ** 18n,
    },
  });
  assert.equal(launched.status, "launched", JSON.stringify(launched));
  if (launched.status !== "launched") return;
  const token = launched.token;
  await fork.increaseTime(601);
  const bought = await launcher.lp.buy({ token, amount: "20" });
  assert.ok(bought.status === "sent" && bought.swapped, JSON.stringify(bought));
  const launcherHeld = await balanceOf(token, launched.tokenVault);

  // The launcher's transfer_token pays the holder's vault of the token, which does not exist.
  const vault = getAddress(await holder.tokenVault(token).vaultAddress());
  assert.equal(await exists(vault), false);
  const given = launcherHeld / 2n;
  assert.ok(given >= 1_000n * 10n ** 18n, "over the dividends' minimum balance");
  const gave = await launcher.lp.transferToken({ token, destination: vault, amount: formatUnits(given, 18) });
  assert.equal(gave.status, "sent", JSON.stringify(gave));
  assert.equal(await balanceOf(token, vault), given);
  assert.equal(await exists(vault), false);

  // Nothing owed yet: refused before the vault is created.
  await assert.rejects(holder.lp.claimDividends(token), /no dividends to claim now/);
  assert.equal(await exists(vault), false);

  // Trading pays the dividend bucket; the dispatcher distributes it.
  await launcher.lp.buy({ token, amount: "200" });
  const anyone = fork.accounts[2]!;
  await fork.client.waitForTransactionReceipt({ hash: await fork.wallet(anyone).writeContract({ account: anyone, chain: null, address: d.launchpad?.dispatcher as Address, abi: dispatcherAbi, functionName: "dispatch", args: [launched.poolId] }) });
  const owed = (await fork.client.readContract({ address: token, abi: ostraTokenAbi, functionName: "dividendOf", args: [vault] })) as bigint;
  assert.ok(owed > 0n, "the vault's address earned dividends");
  const info = await holder.lp.tokenVaultInfo(token);
  assert.equal(info.exists, false);
  assert.equal(info.dividends, formatUnits(owed, 6));

  const usdgBefore = await balanceOf(USDG, holder.buyerVault);
  const claimed = await holder.lp.claimDividends(token);
  assert.equal(claimed.status, "sent", JSON.stringify(claimed));
  assert.equal(claimed.recipient, holder.buyerVault);
  assert.equal(await exists(vault), true, "claim_dividends created the vault first");
  assert.equal((await balanceOf(USDG, holder.buyerVault)) - usdgBefore, owed);
  assert.equal(await fork.client.readContract({ address: token, abi: ostraTokenAbi, functionName: "dividendOf", args: [vault] }), 0n);

  // The token goes on from the vault now created.
  const to = someone("uncv-recipient");
  const sent = await holder.lp.transferToken({ token, destination: to, amount: formatUnits(given, 18) });
  assert.equal(sent.status, "sent", JSON.stringify(sent));
  assert.equal(await balanceOf(token, to), given);
});

test("NVDA in a vault not created yet: the carry's steps skip while it is empty; once it holds NVDA the planner counts it, lend_stock creates it and lends, link links it", { timeout: 1_800_000 }, async () => {
  const a = await agent("nvda", 85);
  const nvda = borroStock("NVDA");
  const vault = getAddress(await a.tokenVault(nvda.token).vaultAddress());
  assert.equal(await exists(vault), false);
  // Registered first: the carry's steps wait for the ERC-8004 gate.
  await a.lp.fundCreatorVault("5");
  const reg = await a.lp.registerAgent("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
  assert.equal(reg.status, "sent");

  // Empty and not created: both steps are skipped and nothing is created.
  const empty = await applySteps(a, [step("lend_stock", "NVDA", (10n ** 18n).toString()), step("link", "NVDA", "0")]);
  assert.equal(empty.next, null, JSON.stringify(empty));
  assert.deepEqual(empty.done.map((x) => [x.kind, x.landed, x.skipped]), [
    ["lend_stock", true, "the vault holds no NVDA now beyond the trading capital's"],
    ["link", true, "the NVDA vault was never created (nothing was lent from it): no link"],
  ]);
  assert.equal(await exists(vault), false);

  await fork.increaseTime(0);
  const bought = await a.swap.swap({ tokenIn: USDG, tokenOut: nvda.token, amount: "30" });
  assert.ok(bought.status === "sent" && bought.swapped, JSON.stringify(bought));
  assert.equal(await exists(vault), false);
  const held = await balanceOf(nvda.token, vault);
  assert.ok(held > 0n);

  // The planner counts the stock of a vault not created yet, with a position read at its address.
  const h = await a.strategy.holdings();
  assert.deepEqual(h.errors, []);
  const row = h.stocks.find((s) => s.stock.symbol === "NVDA");
  assert.ok(row !== undefined && row.exists === false && row.balance === held && row.position !== null && row.position.shares === 0n, JSON.stringify(row, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  // It plans without an error; a carry it plans for NVDA (the market, the rates and the gas decide) lends first,
  // creating the vault, its creation priced.
  const plans = await a.strategy.plan();
  assert.ok(plans.length >= 1);
  for (const p of plans) {
    const first = p.steps.find((s) => s.what === "NVDA");
    if (first !== undefined) {
      assert.equal(first.kind, "lend_stock", JSON.stringify(p.steps));
      assert.match(first.reason, /never created/);
    }
  }
  assert.ok((await a.borro.creationCost(a.tokenVault(nvda.token))).usdg > 0n, "the vault's creation is priced");
  assert.equal(await exists(vault), false, "planning signs nothing");

  // More than it holds: refused, nothing created.
  await assert.rejects(a.borro.lend("NVDA", formatUnits(held + 1n, 18)), /holds .* less than/);
  assert.equal(await exists(vault), false);

  // The carry's steps: lend_stock creates the vault, then lends all of it; link links it to the USDG vault.
  const ran = await applySteps(a, [step("lend_stock", "NVDA", held.toString()), step("link", "NVDA", "0")]);
  assert.equal(ran.next, null, JSON.stringify(ran, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.deepEqual(ran.done.map((x) => [x.kind, x.landed, x.skipped]), [["lend_stock", true, undefined], ["link", true, undefined]]);
  assert.equal(await exists(vault), true);
  assert.equal(await balanceOf(nvda.token, vault), 0n);
  const shares = (await fork.client.readContract({ address: nvda.vault, abi: vaultV2Abi, functionName: "balanceOf", args: [vault] })) as bigint;
  assert.ok(shares > 0n, "Borro's NVDA vault shares held by the agent's NVDA vault");
  assert.equal((await readVaultGuard(fork.client as PublicClient, vault)).linkedVault, a.buyerVault);
});
