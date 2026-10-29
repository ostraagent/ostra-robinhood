// Ostra Swap's split swaps and the trading capital (swap.ts, trading.ts) through the core services, on a fork of
// Robinhood Chain mainnet at its latest block, against the live OstraRouter and OstraStake (ostra-swap's
// deployments/robinhood-mainnet.json) and the live Uniswap pools, with Ostra and its launchpad deployed fresh and the
// agent's own fee payer sending (LocalSender):
//   * a USDG to WETH swap whose quote moves the price more than the limit asked (a quarter of its own impact, so it
//     splits whatever the pool's depth) is swapped in parts, each within the limit and half as many past it (checked
//     with quotes taken here, against the part's own route at a small size): each its own escrow order, the first at
//     once, each next one after 60 s (runSplits), only the part leaving the vault each time, every part's output in
//     the WETH vault; between parts an arbitrageur (a real swap back through Ostra Swap) brings the pools back, as
//     one does on mainnet within the 60 s;
//   * with no slippage, the second part would pay less than the first part's quote once the first moved the price (no
//     arbitrage brings a fork's pool back): it waits, saying so; cancelled, no further part runs and the rest stays in
//     the vault; another split left past its deadline ends there;
//   * the trading capital, for an agent registered in ERC-8004: set with a daily loss limit tightened to 1 bps; a buy
//     over the position limit (25% of the capital, computed here) is refused; a buy within it lands and is booked from
//     the order; the round trip's cost (Ostra's fee and the pool's) is more than 1 bps of the capital, so the next buy is
//     refused while a sell is not; the plans keep the capital's cash; ending and setting it again keeps the stop; the
//     next day buys are allowed again; SPY it buys is not counted by the carry plans as theirs; it ends.
// The pool index is searched once from the public RPC (the fork's history), as an agent's first swap does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createPublicClient, formatUnits, getAddress, http, keccak256, parseUnits, stringToHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, USDG, WETH, borroStock, retryingHttp, robinhoodChain, usdgAbi, type Deployment } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { PoolIndex, bestLeg, findRoute, ostraStakeAbi, parseSwapDeployment, type SwapDeployment } from "@ostraagent/swap";
import {
  BorroService,
  DEFAULT_SWAP_SLIPPAGE_BPS,
  Keys,
  LAUNCHPAD_DIR,
  LaunchpadService,
  LocalSender,
  SPLIT_INTERVAL_SECONDS,
  SPLIT_SLACK_SECONDS,
  StrategyService,
  SwapService,
  TRADING_LEDGER,
  TradingService,
  VaultService,
  X402_NETWORK,
  impactBps,
  referenceQuote,
  type Config,
} from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";
import { splitLogsClient } from "./split-logs.ts";

const SWAP: SwapDeployment = parseSwapDeployment(JSON.parse(readFileSync(new URL("../../../ostra-swap/deployments/robinhood-mainnet.json", import.meta.url), "utf8")));

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
let forkBlock: bigint;
const chainGasPrice = async () => (await fork.client.getBlock({ blockNumber: forkBlock })).baseFeePerGas as bigint;
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/SWAP-SPLIT-FORK/fee-payer")));
/**
 * The client quotes go through: a quote is one call of a batch contract that reads many pools, which a fork fetches
 * from its upstream RPC slot by slot the first time (viem's 10 s default cut it off in the workspace, 25 Oct 2026).
 */
const quoteClient = () => createPublicClient({ chain: robinhoodChain, transport: http(fork.url, { timeout: 180_000 }) }) as PublicClient;
const balanceOf = (token: Address, who: Address) => fork.client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

/** A fork at the latest block (the one before it stopped), with Ostra and its launchpad deployed. */
async function freshFork() {
  await fork?.stop();
  root ??= await mkdtemp(join(tmpdir(), "ostra-core-swap-split-"));
  fork = await startFork();
  forkBlock = await fork.client.getBlockNumber({ cacheTime: 0 });
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
}

before(freshFork);

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** An agent: its seed and records, its vaults, Ostra Swap (the live router), the launchpad, the planner and the trading capital. */
async function agent(name: string, seed: number) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder: new MemoryFolder(), backupExported: async () => true });
  const creatorKeys = await keys.forCreatorVault(d.chainId, USDG);
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, sender, "creator");
  const tokenVaults = new Map<Address, VaultService>();
  const tokenVault = (token: Address) => {
    const t = getAddress(token);
    if (t === getAddress(USDG)) return buyer;
    let v = tokenVaults.get(t);
    if (v === undefined) {
      v = new VaultService(client, transport, config, keys, sender, "token", null, t);
      tokenVaults.set(t, v);
    }
    return v;
  };
  const logsClient = splitLogsClient(fork.url, forkBlock);
  const swap = new SwapService({ client: quoteClient(), logsClient, config, swap: SWAP, vaultFor: tokenVault, sender, folder: keys.folder.folder("ostra-swap") });
  const ownVaults = async () => [await buyer.vaultAddress(), ...(await Promise.all([...tokenVaults.values()].map((v) => v.vaultAddress())))];
  const borro = new BorroService({ client, config, buyer, tokenVault, sender, ownVaults, gasPrice: chainGasPrice });
  const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: sender, creator, creatorSender: sender });
  const agentId = async () => {
    const t = await keys.folder.folder(LAUNCHPAD_DIR).read("agent.json");
    return t === undefined ? null : (JSON.parse(t) as { agentId: string }).agentId;
  };
  let strategy: StrategyService | null = null;
  const trading = new TradingService({ client, swap, buyer, tokenVault, folder: keys.folder.folder("strategy"), gate: () => (strategy as StrategyService).gate() });
  strategy = new StrategyService({ client, logsClient, config, buyer, tokenVault, creator, borro, folder: keys.folder.folder("strategy"), agentId, ethClient: null, trading });
  return { keys, buyer, creator, tokenVault, swap, lp, strategy, trading, folder: keys.folder };
}

/**
 * Quotes taken here, apart from SwapService (findRoute at OstraStake's fee for `to`): `out(amount)`, and the impact of
 * an amount against its own route at a small size (bestLeg on its pools).
 */
async function quoteHere(tokenIn: Address, tokenOut: Address, to: Address, index: PoolIndex) {
  const feeBps = Number(await fork.client.readContract({ address: SWAP.stake, abi: ostraStakeAbi, functionName: "feeBps", args: [to] }));
  const logsClient = splitLogsClient(fork.url, forkBlock);
  const client = quoteClient();
  const route = (amount: bigint) => findRoute({ client, logsClient, index, tokenIn, tokenOut, amountIn: amount, feeBps, slippageBps: DEFAULT_SWAP_SLIPPAGE_BPS });
  const out = async (amount: bigint) => (await route(amount)).expectedOut;
  const impact = async (amount: bigint) => {
    const r = await route(amount);
    const small = await referenceQuote(amount, out);
    let hub = small.refIn;
    let own: bigint | null = null;
    const legIn = r.legIn === null ? null : await bestLeg(client, [r.legIn.pool], tokenIn, r.hub, hub);
    if (r.legIn === null || legIn !== null) {
      hub = legIn === null ? hub : legIn.amountOut;
      const net = hub - (hub * BigInt(feeBps)) / 10_000n;
      own = r.legOut === null ? net : ((await bestLeg(client, [r.legOut.pool], r.hub, tokenOut, net))?.amountOut ?? null);
    }
    const ref = own !== null && own > 0n ? { refIn: small.refIn, refOut: own } : small;
    return impactBps({ amount, out: r.expectedOut, ...ref });
  };
  return { out, impact };
}

/**
 * A block mined now. An escrow order lasts DEFAULT_ORDER_TTL_SECONDS (600) from the latest block's time, and anvil
 * mines a block only for a transaction: after the minutes of quotes a test takes without one, the latest block is
 * older than that and the order is past its deadline when it lands (the VPS runs of 25 Oct 2026: "part 1 of 4 did not
 * run (its order was past its deadline)"). Mainnet makes blocks every second.
 */
const blockNow = () => fork.increaseTime(0);

let swapper: Awaited<ReturnType<typeof agent>>;
const index = new PoolIndex();
/**
 * The swap's size, set by the first test from the pools at the fork's block: 120,000 USDG, doubled until one swap of
 * it moves the WETH price at least MIN_WHOLE_IMPACT_BPS and a quarter of it moves it less (the split's limit is a
 * quarter's impact, so it splits into at most 4 parts). The live pools' depth changes from hour to hour (25 Oct 2026:
 * 10 bps for 120,000 USDG at 13:30 UTC, 0 to 2 bps two hours later through a deeper native ETH pool), and their
 * liquidity sits in narrow ranges, so impact is far from proportional to size: 3,840,000 USDG moved it 27 bps while
 * no sixteenth of it stayed under 6 bps. A limit under the 1 bps a quote resolves cannot split anything.
 */
let AMOUNT = 0n;
let AMOUNT_TEXT = "";
const MIN_WHOLE_IMPACT_BPS = 16n;

test("a swap past the impact limit: its parts swapped one at a time, 60 s apart, each within the limit", { timeout: 2_400_000 }, async () => {
  swapper = await agent("swapper", 41);
  const a = swapper;
  const usdgVault = (await a.buyer.open()).vault;
  // The whole amount's impact (under the default 1% slippage, so that every part can pay the first part's quote less
  // it without an arbitrage on the fork), then a limit of a quarter of it: the swap must split.
  let size = 0n;
  let wholeImpact = 0n;
  let max = 0n;
  for (let k = 0; k < 10; k++) {
    size = 120_000_000_000n << BigInt(k);
    wholeImpact = BigInt((await a.swap.quote({ tokenIn: USDG, tokenOut: WETH, amount: formatUnits(size, 6) })).impactBps);
    if (wholeImpact < MIN_WHOLE_IMPACT_BPS) continue;
    max = await a.swap.impactOf(USDG, WETH, size / 4n);
    console.log(`${formatUnits(size, 6)} USDG moves the WETH price ${wholeImpact} bps, a quarter of it ${max} bps`);
    if (max >= 1n && max < wholeImpact) break;
  }
  // Dealt before the checks, so that the next test (which swaps the same size) finds it even when one fails here.
  await fork.dealUsdg(usdgVault, 3n * size);
  AMOUNT = size;
  AMOUNT_TEXT = formatUnits(size, 6);
  assert.ok(wholeImpact >= MIN_WHOLE_IMPACT_BPS && max >= 1n && max < wholeImpact, `${AMOUNT_TEXT} USDG moves the WETH price ${wholeImpact} bps, a quarter of it ${max} bps`);
  const wethVault = getAddress(await a.tokenVault(WETH).vaultAddress());
  // The parts, checked with quotes taken here: one part within the limit, half as many parts past it.
  const q = await quoteHere(USDG, WETH, wethVault, index);
  assert.equal(await q.impact(AMOUNT), wholeImpact);
  const quoted = await a.swap.quote({ tokenIn: USDG, tokenOut: WETH, amount: AMOUNT_TEXT, maxImpactBps: Number(max) });
  assert.ok(quoted.parts !== null && quoted.parts > 1, JSON.stringify(quoted));
  const expected = { parts: quoted.parts, part: AMOUNT / BigInt(quoted.parts) };
  assert.ok((await q.impact(expected.part)) <= max);
  assert.ok((await q.impact(AMOUNT / BigInt(quoted.parts / 2))) > max);

  await blockNow();
  const r = await a.swap.swap({ tokenIn: USDG, tokenOut: WETH, amount: AMOUNT_TEXT, maxImpactBps: Number(max) });
  if (r.status !== "split") throw new Error(`not split: ${JSON.stringify(r)}`);
  assert.equal(r.split.parts, expected.parts);
  assert.equal(r.split.partsDone, 1, JSON.stringify(r));
  assert.ok(r.first !== undefined && r.first.swapped, JSON.stringify(r));
  // Only the first part left the vault; it paid what it reported, at least its minimum.
  assert.equal(await balanceOf(USDG, usdgVault), 3n * AMOUNT - expected.part);
  const firstOut = await balanceOf(WETH, wethVault);
  assert.equal(firstOut, parseUnits(r.first.amountOut, 18));
  assert.ok(firstOut >= parseUnits(r.first.minOut, 18));

  const id = r.split.id;
  // Not before its time: nothing runs.
  assert.deepEqual(await a.swap.runSplits(), []);
  assert.equal((await a.swap.splits())[0]!.partsDone, 1);
  // An arbitrageur brings the pools back between parts, as one does on mainnet within the 60 s (a fork has none): a
  // real swap of the WETH the last part bought back to USDG, through Ostra Swap's routing (it goes where the price
  // is best: the pools the part moved).
  const arb = await agent("arbitrageur", 43);
  await arb.buyer.open();
  const arbWeth = getAddress(await arb.tokenVault(WETH).vaultAddress());
  let lastOut = firstOut;
  for (let k = 2; k <= expected.parts; k++) {
    await fork.dealToken(arbWeth, WETH, lastOut);
    await blockNow();
    const back = await arb.swap.swap({ tokenIn: WETH, tokenOut: USDG, amount: formatUnits(lastOut, 18), maxImpactBps: 10_000 });
    assert.ok(back.status === "sent" && back.swapped, JSON.stringify(back));
    const before = await balanceOf(WETH, wethVault);
    await fork.increaseTime(SPLIT_INTERVAL_SECONDS);
    assert.deepEqual(await a.swap.runSplits(), []);
    lastOut = (await balanceOf(WETH, wethVault)) - before;
    const st = (await a.swap.splits()).find((x) => x.id === id)!;
    assert.equal(st.partsDone, k, JSON.stringify(st));
    assert.equal(st.open, k < expected.parts);
  }
  const done = await a.swap.splitResult(id);
  assert.deepEqual([done.open, done.spent, done.received], [false, AMOUNT, await balanceOf(WETH, wethVault)]);
  assert.equal(await balanceOf(USDG, usdgVault), 2n * AMOUNT);
});

test("a part that would pay less than the first part's quote waits; cancelled, or left to its deadline, the rest stays in the vault", { timeout: 2_400_000 }, async () => {
  const a = swapper;
  // A split the test before left open (when it failed) must not run here.
  for (const x of await a.swap.splits()) if (x.open) await a.swap.cancelSplit(x.id);
  const usdgVault = await a.buyer.vaultAddress();
  assert.ok(AMOUNT_TEXT !== "", "the first test did not size the swap (see its failure)");
  // The limit as the first test set it: a quarter's impact, now (the first test's parts and the arbitrage moved the pools).
  const quarter = await a.swap.impactOf(USDG, WETH, AMOUNT / 4n);
  const max = Number(quarter > 0n ? quarter : 1n);
  const before = await balanceOf(USDG, usdgVault);
  // No slippage: once the first part moved the price, the second would pay less than the first part's quote.
  await blockNow();
  const r = await a.swap.swap({ tokenIn: USDG, tokenOut: WETH, amount: AMOUNT_TEXT, slippageBps: 0, maxImpactBps: max });
  if (r.status !== "split") throw new Error(`not split: ${JSON.stringify(r)}`);
  assert.equal(r.split.partsDone, 1, JSON.stringify(r));
  const part = parseUnits(r.split.spent, 6);
  await fork.increaseTime(SPLIT_INTERVAL_SECONDS);
  assert.deepEqual(await a.swap.runSplits(), []);
  const waiting = (await a.swap.splits()).find((x) => x.id === r.split.id)!;
  assert.equal(waiting.partsDone, 1, "the second part did not run");
  // It waits: it would move its pools past the limit or pay less than the first part's quote, now that the first part
  // moved the price and nothing brought it back.
  assert.match(waiting.note ?? "", /part 2 of \d+ waits: .*(more than \d+|the price has not come back)/, JSON.stringify(waiting));
  assert.equal(await balanceOf(USDG, usdgVault), before - part, "the rest never left the vault");
  // Cancelled: no further part.
  const cancelled = await a.swap.cancelSplit(r.split.id);
  assert.equal(cancelled.open, false);
  await fork.increaseTime(SPLIT_INTERVAL_SECONDS);
  assert.deepEqual(await a.swap.runSplits(), []);
  assert.equal(await balanceOf(USDG, usdgVault), before - part);
  assert.deepEqual(await a.swap.splitResult(r.split.id), { open: false, spent: part, received: parseUnits(r.split.received, 18) });

  // Another, left to its deadline.
  await blockNow();
  const r2 = await a.swap.swap({ tokenIn: USDG, tokenOut: WETH, amount: AMOUNT_TEXT, slippageBps: 0, maxImpactBps: max });
  if (r2.status !== "split") throw new Error(`not split: ${JSON.stringify(r2)}`);
  const part2 = parseUnits(r2.split.spent, 6);
  await fork.increaseTime(r2.split.parts * SPLIT_INTERVAL_SECONDS + SPLIT_SLACK_SECONDS + 1);
  assert.deepEqual(await a.swap.runSplits(), []);
  const ended = (await a.swap.splits()).find((x) => x.id === r2.split.id)!;
  assert.equal(ended.open, false);
  assert.match(ended.note ?? "", /past its deadline/);
  assert.equal((await a.swap.splitResult(r2.split.id)).spent, part2);
});

test("the trading capital: its position limit, a buy, a stop for the day's loss, a sell, the next day, the plans' keep", { timeout: 2_400_000 }, async () => {
  // A fork of its own: the split swaps before leave the pools moved (their parts bought WETH, nothing arbitraged the
  // last ones back), and against those pools a buy of WETH could be worth more at the sell quote than it cost (the VPS
  // run of 25 Oct 2026: 1,000.04 USDG of capital after a 200 USDG buy), where this test needs a round trip to cost.
  await freshFork();
  const a = await agent("trader", 42);
  const usdgVault = (await a.buyer.open()).vault;
  await fork.dealUsdg(usdgVault, 1_500_000_000n);
  // Not registered: refused.
  await assert.rejects(a.trading.set({ capital: "1000" }), /publish_profile/);
  await a.lp.fundCreatorVault("5");
  assert.equal((await a.lp.registerAgent("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy")).status, "sent");
  await assert.rejects(a.trading.set({ capital: "2000" }), /holds .* less than 2000/);
  await assert.rejects(a.trading.set({ capital: "1000", limits: { dailyLossBps: 501n } }), RangeError);
  const set = await a.trading.set({ capital: "1000", limits: { dailyLossBps: 1n } });
  assert.deepEqual([set.capital, set.cash, set.value, set.buys.ok, set.limits.dailyLossBps], ["1000", "1000", "1000", true, "1"]);

  // The position limit: 25% of the capital, or less when a buy that large moves the price more than 1% (read here).
  const wethVault = getAddress(await a.tokenVault(WETH).vaultAddress());
  const st = await a.trading.status(WETH);
  const q = await quoteHere(USDG, WETH, wethVault, index);
  const within = (await q.impact(250_000_000n)) <= 100n;
  if (within) assert.equal(st.position!.max, "250");
  else assert.ok(Number(st.position!.max) < 250);
  await assert.rejects(a.trading.buy({ token: WETH, amount: "300" }), /over its limit/);
  await assert.rejects(a.trading.buy({ token: WETH, amount: "1001" }), /cash is 1000 USDG/);

  // A buy within it: booked from its order.
  await blockNow();
  const bought = await a.trading.buy({ token: WETH, amount: "200" });
  assert.equal(bought.status, "sent", JSON.stringify(bought));
  const weth = await balanceOf(WETH, wethVault);
  assert.ok(weth > 0n);
  const ledger = JSON.parse((await a.folder.folder("strategy").read(TRADING_LEDGER)) as string) as { cash: string; positions: Record<string, string>; pending: unknown[] };
  assert.deepEqual([ledger.cash, ledger.positions[getAddress(WETH)], ledger.pending.length], ["800000000", weth.toString(), 0]);

  // The round trip's cost is more than 1 bps of the capital: buys stop for the day; a sell does not.
  const after = await a.trading.status();
  assert.ok(Number(after.value) < 1000 * (1 - 0.0001), after.value);
  assert.equal(after.buys.ok, false);
  await assert.rejects(a.trading.buy({ token: WETH, amount: "10" }), /buys are stopped: the trading capital lost 1 bps or more today/);
  await blockNow();
  const sold = await a.trading.sell({ token: WETH, amount: "all" });
  assert.equal(sold.status, "sent", JSON.stringify(sold));
  assert.equal(await balanceOf(WETH, wethVault), 0n);
  const afterSell = await a.trading.status();
  assert.deepEqual(afterSell.positions, []);
  assert.ok(Number(afterSell.cash) > 990 && Number(afterSell.cash) < 1000, afterSell.cash);

  // The plans keep the capital's cash in the USDG vault.
  const plans = await a.strategy.plan({ buffer: 100_000_000n });
  const cash = parseUnits(afterSell.cash, 6);
  assert.equal(plans[0]!.keep, (100_000_000n + cash).toString());
  assert.equal(plans[0]!.trading?.cashUnits, cash.toString());

  // Ending the capital and setting it again does not lift the day's stop.
  assert.deepEqual((await a.trading.end()).untracked, []);
  const again = await a.trading.set({ capital: "900", limits: { dailyLossBps: 1n } });
  assert.equal(again.buys.ok, false, JSON.stringify(again));
  await assert.rejects(a.trading.buy({ token: WETH, amount: "10" }), /buys are stopped/);

  // The next day: the day's start is taken again, buys are allowed.
  await fork.increaseTime(86_400);
  const next = await a.trading.status();
  assert.equal(next.buys.ok, true, JSON.stringify(next));
  assert.equal(next.dayStart, next.value);
  // A buy of SPY (a Borro carry stock): the carry plans do not count the capital's SPY as theirs.
  const spy = borroStock("SPY");
  const spyVault = getAddress(await a.tokenVault(spy.token).vaultAddress());
  await blockNow();
  assert.equal((await a.trading.buy({ token: spy.token, amount: "10" })).status, "sent");
  const spyHeld = await balanceOf(spy.token, spyVault);
  assert.ok(spyHeld > 0n);
  assert.equal((await a.trading.heldTokens()).get(getAddress(spy.token)), spyHeld);
  const h = await a.strategy.holdings();
  assert.equal(h.stocks.find((x) => x.stock.symbol === "SPY")!.balance, 0n, "the capital's SPY is not the carry's");
  await assert.rejects(a.trading.set({ capital: "500" }), /holds positions or open orders/);
  await blockNow();
  await a.trading.sell({ token: spy.token, amount: "all" });
  assert.equal(await balanceOf(spy.token, spyVault), 0n);
  const ended = await a.trading.end();
  assert.deepEqual(ended.untracked, []);
  assert.equal(await a.folder.folder("strategy").read(TRADING_LEDGER), undefined);
});
