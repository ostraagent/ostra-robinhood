// The planner's paths that open positions, on a fork of Robinhood Chain mainnet at block 95,228,009 (Thursday 22 Oct
// 2026 15:50:00 UTC: the NYSE open, so a carry may open; the SPY oracle's feeds answered at 07:10:53 (RHSPY / USD) and
// 15:45:23 (USDG / USD, once a day), so they stay fresh through the test's delays; and before Steakhouse USDG's curator
// submitted, on 23 Oct 08:20:55 UTC, the caps of a new mGLO market whose oracle is not accepted). A fork of an older block needs an archive
// RPC as OSTRA_FORK_RPC. Ostra and its launchpad are deployed fresh; Borro's live SPY market, Steakhouse USDG, Morpho
// Blue and the ERC-8004 Identity Registry are the deployed ones; USDe's price is Chainlink's on Ethereum (OSTRA_ETH_RPC):
//   * a SPY carry: a registered agent holding SPY gets a balanced plan (lend the SPY, post the shares, link the SPY
//     vault, borrow the target: 50% of the LLTV, within the vault's half-LLTV cap and the market's room under 90% use,
//     each read here independently; then lend to Steakhouse what is over the buffer and the 70% step's idle reserve),
//     applied after its random delay with every step landing and exactly the plan's `keep` left; a quiet check holds;
//     a real borrower takes the market past 90% use, and the check's plan (not urgent, after its own delay) repays what
//     brings it back to 90%;
//   * the cash path: a conservative plan, applied after its random delay, lends exactly what is over the buffer; the
//     run's check finds nothing to do and the report shows the route; its liquidity market pushed past 99% use by a
//     real borrower, the check leaves at once with minAssets 0.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, parseAbi, stringToHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import {
  BORRO_BUILDERS,
  BORRO_CODE,
  FileWotsStore,
  MORPHO_BLUE,
  STEAKHOUSE_USDG,
  USDG,
  blockTime,
  borroStock,
  halfLltvMaxDebt,
  readBorroPosition,
  readMorphoMarket,
  readVaultGuard,
  retryingHttp,
  robinhoodChain,
  usdgAbi,
  utilization,
  vaultV2Abi,
  type Deployment,
} from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import {
  BorroService,
  CARRY_MAX_UTILIZATION,
  JITTER_MAX_SECONDS,
  Keys,
  LAUNCHPAD_DIR,
  LaunchpadService,
  LocalSender,
  StrategyService,
  VaultService,
  WAD,
  X402_NETWORK,
  carryIdleReserve,
  type Config,
} from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";
import { splitLogsClient } from "./split-logs.ts";

const PINNED_BLOCK = 95_228_009n;
const forkRpc = process.env.OSTRA_FORK_RPC;
const ethRpc = process.env.OSTRA_ETH_RPC;
const skip =
  forkRpc === undefined || forkRpc === ""
    ? "needs an archive RPC as OSTRA_FORK_RPC (the fork is at block 95,228,009)"
    : ethRpc === undefined || ethRpc === ""
      ? "needs OSTRA_ETH_RPC (Chainlink USDe / USD on Ethereum)"
      : false;

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
const forkBlock = PINNED_BLOCK;
/** Robinhood Chain's gas price: the fork block's base fee (anvil's eth_gasPrice adds a 1 gwei tip the chain does not charge). */
const chainGasPrice = async () => (await fork.client.getBlock({ blockNumber: forkBlock })).baseFeePerGas as bigint;

const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/STRATEGY-PINNED-FORK/fee-payer")));
const morphoAbi = parseAbi([
  "function supplyCollateral((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, address onBehalf, bytes data)",
  "function borrow((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
]);
const vaultIn = parseAbi(["function deposit(uint256 assets, address onBehalf) returns (uint256)", "function convertToAssets(uint256 shares) view returns (uint256)"]);
const erc20 = parseAbi(["function approve(address, uint256) returns (bool)"]);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
const buildersAbi = parseAbi(["function register(bytes32 code)", "function builders(bytes32 code) view returns (address)"]);
const BORRO_CODE_REGISTRANT: Address = "0x3D8a0670D278C125966f884DC66beA34944A4220";

before(async () => {
  if (skip !== false) return;
  root = await mkdtemp(join(tmpdir(), "ostra-core-strategy-pinned-"));
  fork = await startFork({ blockNumber: PINNED_BLOCK });
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
  // Ostra's Borro builder code was registered on mainnet after this block (block 96,112,109, 23 Oct 2026 17:26:24 UTC,
  // by 0x3D8a0670D278C125966f884DC66beA34944A4220): the same registration is sent here first, from the same account,
  // or every Lend of a stock through BorroBuilders reverts NotRegistered.
  await anvil("anvil_impersonateAccount", [BORRO_CODE_REGISTRANT]);
  await fork.setBalance(BORRO_CODE_REGISTRANT, 10n ** 18n);
  const w = createWalletClient({ account: BORRO_CODE_REGISTRANT, chain: robinhoodChain, transport: http(fork.url) });
  await send(await w.writeContract({ address: BORRO_BUILDERS, abi: buildersAbi, functionName: "register", args: [BORRO_CODE], account: BORRO_CODE_REGISTRANT, chain: robinhoodChain }));
  await anvil("anvil_stopImpersonatingAccount", [BORRO_CODE_REGISTRANT]);
  assert.equal(getAddress(await fork.client.readContract({ address: BORRO_BUILDERS, abi: buildersAbi, functionName: "builders", args: [BORRO_CODE] })), BORRO_CODE_REGISTRANT);
});

async function anvil(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(fork.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** A registered agent: its own seed and records, its vaults, Borro, the launchpad and the planner (with USDe's price). */
async function agent(name: string, seed: number) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const eth = createPublicClient({ chain: mainnet, transport: retryingHttp(ethRpc as string) }) as PublicClient;
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder: new MemoryFolder(), backupExported: async () => true });
  const creatorKeys = await keys.forCreatorVault(d.chainId, USDG);
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, sender, "creator");
  const tokenVaults = new Map<Address, VaultService>();
  const tokenVault = (token: Address) => {
    let v = tokenVaults.get(token);
    if (v === undefined) {
      v = new VaultService(client, transport, config, keys, sender, "token", null, token);
      tokenVaults.set(token, v);
    }
    return v;
  };
  const ownVaults = async () => [await buyer.vaultAddress(), ...(await Promise.all([...tokenVaults.values()].map((v) => v.vaultAddress())))];
  const borro = new BorroService({ client, config, buyer, tokenVault, sender, ownVaults, gasPrice: chainGasPrice });
  const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: sender, creator, creatorSender: sender });
  const agentId = async () => {
    const t = await keys.folder.folder(LAUNCHPAD_DIR).read("agent.json");
    return t === undefined ? null : (JSON.parse(t) as { agentId: string }).agentId;
  };
  const s = new StrategyService({ client, logsClient: splitLogsClient(fork.url, forkBlock), config, buyer, tokenVault, creator, borro, swap: null, folder: keys.folder.folder("strategy"), agentId, ethClient: eth });
  return { client, buyer, creator, tokenVault, borro, lp, s };
}

const usdg = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const sharesOf = (vault: Address, who: Address) => fork.client.readContract({ address: vault, abi: vaultV2Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const send = async (hash: `0x${string}`) => assert.equal((await fork.client.waitForTransactionReceipt({ hash })).status, "success");

test("a SPY carry: planned, applied after its delay, held, and paid down when its market passes 90% use", { timeout: 2_400_000, skip }, async () => {
  const { client, buyer, lp, tokenVault, s } = await agent("carry", 81);
  // A registered agent with 1,000 USDG and 10 SPY.
  const spy = borroStock("SPY");
  const buyerAt = (await buyer.open()).vault;
  await fork.dealUsdg(buyerAt, 1_000_000_000n);
  await lp.fundCreatorVault("5");
  assert.equal((await lp.registerAgent("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy")).status, "sent");
  const spyAt = (await tokenVault(spy.token).open()).vault;
  await fork.dealToken(spyAt, spy.token, 10n * 10n ** 18n);

  // What the carry should borrow, read here: 50% of the LLTV of the collateral the 10 SPY buy, within the vault's
  // half-LLTV cap, the room under 90% use and the market's liquidity.
  const p0 = await readBorroPosition(client, spyAt, spy);
  const shares = (await client.readContract({ address: spy.vault, abi: vaultV2Abi, functionName: "previewDeposit", args: [10n * 10n ** 18n] })) as bigint;
  const value = (shares * p0.price) / 10n ** 36n;
  const byCollateral = (value * spy.market.lltv * 5_000n) / (WAD * 10_000n);
  const room = (p0.supply * CARRY_MAX_UTILIZATION) / WAD - p0.borrowed;
  let expected = byCollateral;
  for (const x of [halfLltvMaxDebt(shares, p0.price, spy.market.lltv), room, p0.available]) if (x < expected) expected = x;
  assert.ok(expected > 0n, `the SPY market has room: ${room}`);

  const keepBuffer = 100_000_000n;
  const plans = await s.plan({ buffer: keepBuffer });
  const balanced = plans.find((p) => p.profile === "balanced");
  assert.ok(balanced !== undefined, plans.map((p) => p.risks.join("\n")).join("\n---\n"));
  assert.deepEqual(
    balanced.steps.map((x) => [x.kind, x.what]),
    [
      ["lend_stock", "SPY"],
      ["post_collateral", "SPY"],
      ["link", "SPY"],
      ["borrow", "SPY"],
      ["lend_cash", "USDG"],
    ],
  );
  const loan = BigInt(balanced.steps[3]!.amount);
  assert.equal(loan, expected);
  assert.equal(balanced.keep, (keepBuffer + carryIdleReserve(loan)).toString());
  assert.equal(balanced.steps[4]!.vault, STEAKHOUSE_USDG);
  assert.ok(Number(balanced.expected30d) > Number(plans.find((p) => p.profile === "conservative")!.expected30d));

  // Applied after its delay: every step lands, the USDG vault keeps exactly the plan's keep.
  const first = await s.apply(balanced.id);
  if (first.next !== null) {
    assert.deepEqual(first.done, []);
    await fork.increaseTime(JITTER_MAX_SECONDS + 1);
  }
  const applied = first.next === null ? first : await s.apply(balanced.id);
  assert.equal(applied.next, null, JSON.stringify(applied, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
  assert.equal(applied.done.length, 5);
  assert.ok(applied.done.every((x) => x.landed && x.skipped === undefined), JSON.stringify(applied.done));
  const p1 = await readBorroPosition(client, spyAt, spy);
  // The shares the 10 SPY bought (the Borro vault's share price moves a little over the delay), all posted.
  assert.ok(p1.collateral * 1_000n >= shares * 999n && p1.collateral * 1_000n <= shares * 1_001n, `collateral ${p1.collateral}, planned ${shares}`);
  assert.equal(p1.shares, 0n);
  // The loan, and the interest of the seconds since it landed.
  assert.ok(p1.debt >= loan && p1.debt <= loan + 1_000n, `debt ${p1.debt}, loan ${loan}`);
  assert.equal((await readVaultGuard(client, spyAt)).linkedVault, buyerAt);
  assert.equal(await usdg(buyerAt), BigInt(balanced.keep));
  assert.ok(((await client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2Abi, functionName: "balanceOf", args: [buyerAt] })) as bigint) > 0n);

  // A quiet run holds.
  const quiet = await s.check();
  assert.deepEqual(quiet.actions, []);
  assert.ok(quiet.findings.some((f) => f.startsWith("SPY carry:")), quiet.findings.join("\n"));

  // A real borrower takes the SPY market to 92% use (the rate rule must not fire first: the average of the two runs'
  // rates stays under the cash yield less 1 point, checked below).
  const borrower = fork.accounts[2]!;
  const w = fork.wallet(borrower);
  await fork.setBalance(borrower.address, 10n ** 19n);
  const want = (p1.supply * 92n) / 100n - p1.borrowed;
  const needShares = (want * 10n ** 36n * WAD * 12n) / (p1.price * spy.market.lltv * 10n) + 1n;
  const needAssets = ((await client.readContract({ address: spy.vault, abi: vaultIn, functionName: "convertToAssets", args: [needShares] })) * 101n) / 100n + 1n;
  await fork.dealToken(borrower.address, spy.token, needAssets);
  await send(await w.writeContract({ address: spy.token, abi: erc20, functionName: "approve", args: [spy.vault, needAssets], chain: null, account: borrower }));
  await send(await w.writeContract({ address: spy.vault, abi: vaultIn, functionName: "deposit", args: [needAssets, borrower.address], chain: null, account: borrower }));
  const got = (await client.readContract({ address: spy.vault, abi: vaultV2Abi, functionName: "balanceOf", args: [borrower.address] })) as bigint;
  await send(await w.writeContract({ address: spy.vault, abi: erc20, functionName: "approve", args: [MORPHO_BLUE, got], chain: null, account: borrower }));
  await send(await w.writeContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "supplyCollateral", args: [spy.market, got, borrower.address, "0x"], chain: null, account: borrower }));
  await send(await w.writeContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "borrow", args: [spy.market, want, 0n, borrower.address, borrower.address], chain: null, account: borrower }));

  const busy = await s.check();
  const p2 = await readBorroPosition(client, spyAt, spy);
  const cashNow = (await s.cashVaults()).find((x) => x.vault === STEAKHOUSE_USDG)!.modelApy;
  assert.ok((p1.borrowRatePerYear + p2.borrowRatePerYear) / 2n < cashNow - WAD / 100n, `rates ${p1.borrowRatePerYear} and ${p2.borrowRatePerYear} against ${cashNow}`);
  const over = p2.borrowed - (p2.supply * CARRY_MAX_UTILIZATION) / WAD;
  // The excess back, or the whole debt (by its shares) when the excess is that much or more.
  const repay = busy.actions.find((x) => (x.kind === "repay" || x.kind === "close_carry") && x.what === "SPY");
  assert.ok(repay !== undefined && !repay.urgent, JSON.stringify(busy.actions));
  assert.ok(busy.plan !== null);
  if (over < p2.debt) {
    assert.equal(repay.kind, "repay");
    assert.ok(BigInt(repay.amount) + 2n >= over && BigInt(repay.amount) <= over + 2n, `repay ${repay.amount}, over ${over}`);
  } else assert.equal(repay.kind, "close_carry");
  const waiting = await s.apply(busy.plan);
  if (waiting.next !== null) await fork.increaseTime(JITTER_MAX_SECONDS + 1);
  const paid = waiting.next === null ? waiting : await s.apply(busy.plan);
  assert.equal(paid.next, null, JSON.stringify(paid.done));
  const p3 = await readBorroPosition(client, spyAt, spy);
  assert.ok(p3.debt < p2.debt);
  // Back at about 90% use (the interest of the delay on top), or the whole debt repaid when the excess was more.
  if (over < p2.debt) assert.ok(p3.borrowed * 1_000n <= p3.supply * 901n, `use ${(Number(p3.borrowed) / Number(p3.supply)).toFixed(4)}`);
  else assert.equal(p3.debt, 0n);
});

test("the cash path: lend over the buffer after the random delay, a quiet check, the report; its liquidity market past 99% use, an exit at once", { timeout: 1_800_000, skip }, async () => {
  const a = await agent("cash", 91);
  const { client, s } = a;
  const buyer = (await a.buyer.open()).vault;
  await fork.dealUsdg(buyer, 2_005_000_000n);
  await a.lp.fundCreatorVault("5");
  assert.equal((await a.lp.registerAgent("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy")).status, "sent");
  const keep = 100_000_000n;
  const before = await usdg(buyer);
  assert.ok(before > keep);

  const plans = await s.plan({ buffer: keep });
  const cons = plans.find((p) => p.profile === "conservative")!;
  assert.equal(plans.find((p) => p.profile === "balanced"), undefined, "no stock held: no carry");
  assert.equal(cons.steps.length, 1, JSON.stringify(cons));
  const step = cons.steps[0]!;
  assert.deepEqual([step.kind, step.vault, step.amount, step.urgent], ["lend_cash", STEAKHOUSE_USDG, "free", false]);
  assert.equal(cons.keep, keep.toString());
  assert.ok(Number(cons.expected30d) > 0);
  const now = Number((await client.getBlock()).timestamp);
  assert.ok(step.notBefore >= now && step.notBefore <= now + JITTER_MAX_SECONDS + 60);

  // Before its delay nothing is signed; after it, exactly what is over the buffer goes in.
  const early = await s.apply(cons.id);
  if (early.next !== null) {
    assert.deepEqual(early.done, []);
    await fork.increaseTime(JITTER_MAX_SECONDS + 1);
  }
  const applied = early.next === null ? early : await s.apply(cons.id);
  assert.equal(applied.next, null);
  assert.equal(applied.done.length, 1);
  assert.equal(applied.done[0]!.landed, true);
  assert.equal(await usdg(buyer), keep);
  const shares = await sharesOf(STEAKHOUSE_USDG, buyer);
  assert.ok(shares > 0n);
  // Done steps are not run again.
  assert.deepEqual(await s.apply(cons.id), { done: [], next: null });

  // A quiet run: nothing to do, the run recorded, the route reported.
  const quiet = await s.check();
  assert.deepEqual(quiet.actions, []);
  assert.equal(quiet.plan, null);
  assert.ok(quiet.findings.some((f) => f.startsWith(`${STEAKHOUSE_USDG}: every check passes`)), quiet.findings.join("\n"));
  const rep = await s.report();
  assert.equal(rep.routes.length, 1);
  assert.ok(Number(rep.routes[0]!.value) > 1_800);

  // A real borrower takes the liquidity market past 99% use.
  const c = (await s.cashVaults()).find((x) => x.vault === STEAKHOUSE_USDG)!;
  const lm = c.state.liquidityMarket!;
  assert.ok(lm !== null && lm.expected !== null);
  const borrower = fork.accounts[2]!;
  const w = fork.wallet(borrower);
  const e = lm.expected!;
  const want = e.totalSupplyAssets - e.totalBorrowAssets - (e.totalSupplyAssets * 5n) / 1_000n;
  const price = await client.readContract({ address: lm.params.oracle, abi: oracleAbi, functionName: "price" });
  const collateral = (want * 10n ** 36n * 10n ** 18n * 12n) / (price * lm.params.lltv * 10n) + 1n;
  await fork.dealToken(borrower.address, lm.params.collateralToken, collateral);
  await fork.setBalance(borrower.address, 10n ** 19n);
  await send(await w.writeContract({ address: lm.params.collateralToken, abi: erc20, functionName: "approve", args: [MORPHO_BLUE, collateral], chain: null, account: borrower }));
  await send(await w.writeContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "supplyCollateral", args: [lm.params, collateral, borrower.address, "0x"], chain: null, account: borrower }));
  await send(await w.writeContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "borrow", args: [lm.params, want, 0n, borrower.address, borrower.address], chain: null, account: borrower }));
  const after = await readMorphoMarket(client, lm.id, await blockTime(client));
  assert.ok(utilization(after.expected!) >= (99n * 10n ** 18n) / 100n);

  const exit = await s.check({ execute: true });
  const leave = exit.actions.find((x) => x.kind === "redeem_cash" && x.vault === STEAKHOUSE_USDG);
  assert.ok(leave !== undefined && leave.urgent, JSON.stringify(exit.actions));
  assert.match(leave.reason, /99% used/);
  assert.equal(exit.results.length, 1);
  assert.equal(exit.results[0]!.landed, true, JSON.stringify(exit.results[0]));
  assert.equal(await sharesOf(STEAKHOUSE_USDG, buyer), 0n, "every share redeemed (its free liquidity covers them)");
  assert.ok((await usdg(buyer)) > before - 1_000_000n, "about what went in came back");
});
