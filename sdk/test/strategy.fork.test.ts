// src/strategy.ts and the reads the planner adds to borro.ts and chain.ts, against the deployed contracts on a fork of
// Robinhood Chain mainnet:
//   * Strategy 1's check: Steakhouse USDG qualifies (with the second mGLO market its curator submitted on 23 Oct,
//     accepted on 25 Oct), a holder's full redeem simulates, its model yield (maxRate before fees) and share price are
//     read, its room follows the 5% share rule; NetNet Credit (whose holders cannot redeem, and whose caps reach markets
//     outside the accepted list) fails;
//   * pending changes count only when they would fail the check once executed (real ones and ones built from its caps);
//   * mGLO's limits (its share under the caps now and once the submitted increases are executed, its NAV's age) hold
//     new deposits at their bounds, and are never a problem;
//   * USDe's price from Chainlink's USDe / USD feed on Ethereum mainnet (OSTRA_ETH_RPC), found by its ENS name;
//   * ERC-8004: an id nobody holds reads as none, and an owner that registered nothing has no agent ids;
//   * readBorroPosition reads a market accrued to its block: equal to what Morpho.accrueInterest stores at that time;
//   * retryingHttp asks an idempotent read answered -32602 again (four times, after 1, 2, 4 and 8 s), and never a
//     transaction.
// Log reads go to the public RPC (up to the fork block); the fork serves the state.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { createPublicClient, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, stringToHex, toFunctionSelector, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { borroStock, readBorroPosition } from "../src/borro.ts";
import { INVALID_PARAMS_RETRIES, robinhoodChain, robinhoodClient, retryingHttp } from "../src/chain.ts";
import { MORPHO_BLUE, ROBINHOOD_PUBLIC_RPC, USDG } from "../src/constants.ts";
import { capIdsFromEvents, instantBorrowRate, readMorphoMarket, readPendingChanges, readVaultV2, worstCaseExposure } from "../src/morpho.ts";
import {
  CASH_COLLATERAL_LIMITS,
  CASH_VAULTS,
  MGLO,
  MGLO_NAV_FEED,
  OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS,
  STEAKHOUSE_USDG,
  USDE_EXIT_PRICE,
  USDE_FEED_MAX_AGE,
  USDE_USD_FEED_ENS,
  agentIdsRegisteredBy,
  capsAfterPending,
  cashCollateralHolds,
  cashVaultModel,
  cashVaultRoom,
  checkCashVault,
  isAcceptedCashMarket,
  pendingChangeProblems,
  readAgentIdentity,
  readUsdeUsd,
  type PendingChange,
} from "../src/strategy.ts";
import { startFork, type Fork } from "./fork.ts";

const NETNET_CREDIT: Address = "0x99347d5F70D3838763f6Bddcf80304C8aa953B57";
const morphoAbi = parseAbi([
  "function accrueInterest((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const someone = (name: string): Address => privateKeyToAccount(keccak256(stringToHex(`OSTRA/SDK/STRATEGY-FORK/${name}`))).address;

let fork: Fork;
let client: PublicClient;
let logs: PublicClient;
let forkBlock: bigint;

before(async () => {
  fork = await startFork();
  client = fork.client as PublicClient;
  logs = robinhoodClient(process.env.OSTRA_LOGS_RPC ?? ROBINHOOD_PUBLIC_RPC);
  forkBlock = await client.getBlockNumber();
});
after(async () => {
  await fork?.stop();
});

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(fork.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

// Steakhouse USDG's curator submitted (23 Oct 2026, executable from 30 Oct 08:20:55 UTC) caps for a second mGLO market,
// at 98% of mGLO's NAV (the first one: 94%), raising mGLO's collateral cap from 50 to 100 million USDG; accepted on 25 Oct.
const NEW_MGLO_ORACLE: Address = "0xD32146a0C1E4B79fD8D9ebcd4Adc66b2B7397D4d";
/** An oracle nobody accepted, for a market built from a real one. */
const OTHER_ORACLE = someone("oracle");
const vaultV2Writes = parseAbi([
  "function increaseAbsoluteCap(bytes idData, uint256 newAbsoluteCap)",
  "function setPerformanceFee(uint256 newPerformanceFee)",
  "function decreaseTimelock(bytes4 selector, uint256 newDuration)",
  "function setIsSentinel(address account, bool newIsSentinel)",
  "function removeAdapter(address account)",
  "function deposit(uint256 assets, address onBehalf) returns (uint256)",
]);
const approveAbi = parseAbi(["function approve(address, uint256) returns (bool)"]);

test("Strategy 1's check: Steakhouse USDG qualifies; a holder redeems in full; NetNet Credit does not", { timeout: 900_000 }, async () => {
  assert.deepEqual(CASH_VAULTS, [STEAKHOUSE_USDG]);
  // A holder with shares, so the full-redeem simulation runs.
  const me = fork.accounts[1]!;
  const w = fork.wallet(me);
  await fork.dealUsdg(me.address, 1_000_000_000n);
  await client.waitForTransactionReceipt({ hash: await w.writeContract({ address: USDG, abi: approveAbi, functionName: "approve", args: [STEAKHOUSE_USDG, 1_000_000_000n], chain: null, account: me }) });
  await client.waitForTransactionReceipt({ hash: await w.writeContract({ address: STEAKHOUSE_USDG, abi: vaultV2Writes, functionName: "deposit", args: [1_000_000_000n, me.address], chain: null, account: me }) });
  const capIds = await capIdsFromEvents(logs, STEAKHOUSE_USDG, 0n, forkBlock);
  assert.ok(capIds.size > 0, "Steakhouse USDG has cap events");
  const c = await checkCashVault(client, STEAKHOUSE_USDG, { capIds, holders: [me.address], ostraVaults: [], planned: 0n });
  assert.deepEqual(c.problems, []);
  assert.ok(isAcceptedCashMarket({ collateralToken: MGLO, oracle: NEW_MGLO_ORACLE }));
  assert.equal(c.shareProblem, null);
  // Its deposit gate is not abdicated but waits 7 days (Morpho: it can only close new deposits); the exit gates are.
  assert.equal(c.state.timelocks.setSendAssetsGate?.abdicated, false);
  assert.ok((c.state.timelocks.setSendAssetsGate?.seconds ?? 0n) >= 3n * 86_400n);
  assert.equal(c.ok, c.problems.length === 0);
  assert.ok(c.modelApy > 0n && c.modelApy < 10n ** 18n, `model yield ${c.modelApy}`);
  assert.ok(c.sharePrice >= 10n ** 6n, `share price ${c.sharePrice}`);
  assert.ok(c.withdrawable > 0n);
  // The model as VaultV2 distributes interest: maxRate 0 distributes nothing, and the cap applies before the fees.
  assert.equal(cashVaultModel({ ...c.state, maxRate: 0n }), 0n);
  // 5e8 per second (about 1.6% a year) is under what its markets earn (about 4%), so it binds: 90% of it after a 10% fee.
  const capped = cashVaultModel({ ...c.state, maxRate: 5n * 10n ** 8n, performanceFee: 10n ** 17n, managementFee: 0n });
  assert.equal(capped, ((5n * 10n ** 8n * (10n ** 18n - 10n ** 17n)) / 10n ** 18n) * 31_536_000n);
  assert.ok(cashVaultModel({ ...c.state, maxRate: 10n ** 18n, performanceFee: 10n ** 17n, managementFee: 0n }) > capped);
  // The room is 5% of what it can pay out (no Ostra vault holds any yet), and one unit more is over the share limit.
  const room = cashVaultRoom(c);
  assert.equal(room, (c.withdrawable * OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS) / 10_000n);
  const atRoom = await checkCashVault(client, STEAKHOUSE_USDG, { capIds, holders: [me.address], ostraVaults: [], planned: room });
  assert.equal(atRoom.shareProblem, null);
  const over = await checkCashVault(client, STEAKHOUSE_USDG, { capIds, holders: [me.address], ostraVaults: [], planned: room + 1n });
  assert.equal(over.ok, false);
  assert.match(over.shareProblem ?? "", /more than 500 bps/);

  const bad = await checkCashVault(client, NETNET_CREDIT, { capIds: await capIdsFromEvents(logs, NETNET_CREDIT, 0n, forkBlock), holders: [someone("holder")], ostraVaults: [], planned: 0n });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.length > 0);
});

test("pending changes count only when they would fail the check once executed", { timeout: 900_000 }, async () => {
  const capIds = await capIdsFromEvents(logs, STEAKHOUSE_USDG, 0n, forkBlock);
  const c = await checkCashVault(client, STEAKHOUSE_USDG, { capIds, holders: [], ostraVaults: [], planned: 0n });
  const v = c.state;
  const later = v.at.timestamp + 7n * 86_400n;
  const change = (data: `0x${string}`, target: Address = v.address): PendingChange => ({ target, selector: data.slice(0, 10) as `0x${string}`, data, executableAt: later, abdicated: false });
  // The changes really pending now: an old setIsSentinel (not timelocked: it can never be executed) is ignored, and
  // the second mGLO market's caps (until they are executed on 30 Oct) are fine: it is an accepted market.
  const real = await readPendingChanges(logs, v, 22_721n);
  const r = pendingChangeProblems(v, c.caps, real);
  for (const p of real) {
    if (p.selector === toFunctionSelector("function setIsSentinel(address,bool)")) assert.ok(r.ignored.some((x) => x.startsWith(p.selector)), JSON.stringify(r));
  }
  assert.deepEqual(r.problems, []);
  // Built from its real caps: a raise of an accepted market's cap is fine; an mGLO market behind another oracle is not.
  const accepted = c.caps.find((x) => x.what.kind === "market" && isAcceptedCashMarket(x.what.params) && x.absoluteCap > 0n)!;
  assert.ok(accepted !== undefined);
  const raise = encodeFunctionData({ abi: vaultV2Writes, functionName: "increaseAbsoluteCap", args: [accepted.idData, accepted.absoluteCap * 2n] });
  assert.deepEqual(pendingChangeProblems(v, c.caps, [change(raise)]).problems, []);
  const adapter = v.adapters.find((a) => a.kind === "market")!.address;
  const someMglo = c.caps.find((x) => x.what.kind === "market" && x.what.params.collateralToken === MGLO);
  assert.ok(someMglo !== undefined && someMglo.what.kind === "market");
  const params = { ...someMglo.what.params, oracle: OTHER_ORACLE };
  const idData = encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "tuple", components: [{ name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" }, { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" }] }], ["this/marketParams", adapter, params]);
  const unaccepted = encodeFunctionData({ abi: vaultV2Writes, functionName: "increaseAbsoluteCap", args: [idData, 10n ** 14n] });
  assert.match(pendingChangeProblems(v, c.caps, [change(unaccepted)]).problems.join("; "), new RegExp(`oracle ${OTHER_ORACLE}, which is not an accepted market`));
  // A fee raised, a guarded timelock lowered: problems; a removal, a sentinel: fine and ignored; abdicated: ignored.
  const fee = encodeFunctionData({ abi: vaultV2Writes, functionName: "setPerformanceFee", args: [v.performanceFee + 1n] });
  assert.match(pendingChangeProblems(v, c.caps, [change(fee)]).problems.join(";"), /performance fee would rise/);
  const lower = encodeFunctionData({ abi: vaultV2Writes, functionName: "decreaseTimelock", args: [toFunctionSelector("function addAdapter(address)"), 86_400n] });
  assert.match(pendingChangeProblems(v, c.caps, [change(lower)]).problems.join(";"), /would drop to 86400 s/);
  const remove = encodeFunctionData({ abi: vaultV2Writes, functionName: "removeAdapter", args: [adapter] });
  assert.equal(pendingChangeProblems(v, c.caps, [change(remove)]).fine.length, 1);
  const sentinel = encodeFunctionData({ abi: vaultV2Writes, functionName: "setIsSentinel", args: [someone("sentinel"), true] });
  assert.equal(pendingChangeProblems(v, c.caps, [change(sentinel)]).ignored.length, 1);
  assert.equal(pendingChangeProblems(v, c.caps, [{ ...change(fee), abdicated: true }]).ignored.length, 1);
});

// Ethereum mainnet is read through OSTRA_ETH_RPC (any Ethereum RPC; the VPS run sets a public one).
const ethRpc = process.env.OSTRA_ETH_RPC;
test("USDe's price from Chainlink's USDe / USD feed on Ethereum, found by its ENS name", { timeout: 300_000, skip: ethRpc === undefined || ethRpc === "" ? "needs OSTRA_ETH_RPC" : false }, async () => {
  const eth = createPublicClient({ chain: mainnet, transport: retryingHttp(ethRpc as string) }) as PublicClient;
  const u = await readUsdeUsd(eth);
  assert.equal(u.feed, getAddress((await eth.getEnsAddress({ name: USDE_USD_FEED_ENS })) as Address));
  // The address the VPS read on 24 Oct 2026 for usde-usd.data.eth.
  assert.equal(u.feed, "0xa569d910839Ae8865Da8F8e70FfFb0cBA869F961");
  // USDe is a dollar stablecoin: within 3% of 1 US dollar, and the exit line sits just under 1.
  assert.ok(u.price > (97n * 10n ** 18n) / 100n && u.price < (103n * 10n ** 18n) / 100n, `USDe at ${u.price}`);
  assert.equal(u.stale, false, `the answer is ${u.age} s old`);
  assert.ok(USDE_EXIT_PRICE < 10n ** 18n && USDE_FEED_MAX_AGE > 0n);
  // A Robinhood Chain RPC is refused: it is not Ethereum.
  await assert.rejects(readUsdeUsd(client), /not 1/);
});

test("ERC-8004: an id nobody holds reads as none; an owner that registered nothing has no ids", { timeout: 300_000 }, async () => {
  assert.equal(await readAgentIdentity(client, 2n ** 200n), null);
  assert.deepEqual(await agentIdsRegisteredBy(logs, someone("nobody"), forkBlock - 100_000n, forkBlock), []);
});

test("readBorroPosition reads the market accrued to its block, as Morpho.accrueInterest stores it then", { timeout: 600_000 }, async () => {
  const spy = borroStock("SPY");
  await fork.increaseTime(2 * 86_400);
  const head = await client.getBlock();
  const T = head.timestamp + 5n;
  // What accrueInterest stores at T ...
  const snapshot = await rpc("evm_snapshot", []);
  await rpc("evm_setNextBlockTimestamp", [Number(T)]);
  const w = fork.wallet(fork.accounts[0]!);
  const hash = await w.writeContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "accrueInterest", args: [spy.market], chain: null, account: fork.accounts[0]! });
  assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
  const stored = await client.readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "market", args: [spy.marketId] });
  const after = await readMorphoMarket(client, spy.marketId, { blockNumber: await client.getBlockNumber(), timestamp: T });
  await rpc("evm_revert", [snapshot]);
  // ... equals what readBorroPosition reads in a block at T without it.
  await rpc("evm_setNextBlockTimestamp", [Number(T)]);
  await rpc("evm_mine", []);
  const p = await readBorroPosition(client, someone("no-position"), spy);
  assert.equal(p.at, T);
  assert.equal(p.supply, stored[0]);
  assert.equal(p.borrowed, stored[2]);
  assert.ok(stored[4] === T, "the accrual ran at T");
  assert.equal(p.available, stored[0] - stored[2]);
  // Its rate is the IRM's right after that accrual.
  assert.equal(p.borrowRatePerYear, instantBorrowRate(after.stored, after.rateAtTarget) * 31_536_000n);
  assert.equal(p.debt, 0n);
  assert.equal(getAddress(p.stock.token), getAddress(spy.token));
});

/** An RPC in front of the fork that answers the first `fail` requests of `method` with -32602, and counts them. */
async function flakyProxy(method: string, fail: number): Promise<{ url: string; seen: () => number; close: () => Promise<void> }> {
  let seen = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
    if (body.method === method) {
      seen++;
      if (seen <= fail) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "invalid params" } }));
        return;
      }
    }
    const up = await fetch(fork.url, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) });
    res.writeHead(up.status, { "content-type": "application/json" });
    res.end(await up.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen: () => seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test("retryingHttp asks an idempotent read answered -32602 again, four times, and never a transaction", { timeout: 300_000 }, async () => {
  const read = (url: string) => {
    const c = createPublicClient({ chain: robinhoodChain, transport: retryingHttp(url) }) as PublicClient;
    return c.readContract({ address: USDG, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" });
  };
  assert.equal(INVALID_PARAMS_RETRIES, 4);
  // Four answers of -32602, then the read: it succeeds, after waiting 1, 2, 4 and 8 s.
  let p = await flakyProxy("eth_call", 4);
  const t0 = Date.now();
  assert.equal(await read(p.url), 6);
  assert.ok(Date.now() - t0 >= 15_000, `waited ${Date.now() - t0} ms`);
  assert.equal(p.seen(), 5);
  await p.close();
  // Five: the fifth answer is the error.
  p = await flakyProxy("eth_call", 5);
  await assert.rejects(read(p.url), (e: unknown) => /invalid params/i.test(String(e)));
  assert.equal(p.seen(), 5);
  await p.close();
  // A transaction answered -32602 is not sent again.
  p = await flakyProxy("eth_sendRawTransaction", 1);
  const c = createPublicClient({ chain: robinhoodChain, transport: retryingHttp(p.url) }) as PublicClient;
  await assert.rejects(c.request({ method: "eth_sendRawTransaction", params: ["0x00"] }), (e: unknown) => /invalid params/i.test(String(e)));
  assert.equal(p.seen(), 1);
  await p.close();
});

// Last: it moves the fork's clock 36 days on.
test("mGLO's limits hold new deposits at their bounds, now and once the submitted caps are executed, and are never a problem", { timeout: 900_000 }, async () => {
  const limit = CASH_COLLATERAL_LIMITS.find((x) => x.symbol === "mGLO")!;
  assert.deepEqual({ collateral: limit.collateral, navFeed: limit.navFeed, maxShareBps: limit.maxShareBps, maxNavAge: limit.maxNavAge }, { collateral: MGLO, navFeed: MGLO_NAV_FEED, maxShareBps: 2_000n, maxNavAge: 35n * 86_400n });
  const capIds = await capIdsFromEvents(logs, STEAKHOUSE_USDG, 0n, forkBlock);
  const c = await checkCashVault(client, STEAKHOUSE_USDG, { capIds, holders: [], ostraVaults: [], planned: 0n });
  const v = c.state;
  const after = capsAfterPending(v, c.caps, await readPendingChanges(logs, v, 22_721n));
  // Once the submitted increases are executed, mGLO's collateral cap is 100 million USDG (50 million before; or already 100 million).
  const capOf = (caps: typeof after) => caps.find((x) => x.what.kind === "collateral" && getAddress(x.what.token) === MGLO)?.absoluteCap ?? 0n;
  assert.equal(capOf(after), 100_000_000_000_000n, `mGLO cap now ${capOf(c.caps)}, after ${capOf(after)}`);
  const worst = (caps: typeof after, total: bigint) => worstCaseExposure(v, caps, total).collaterals.find((x) => getAddress(x.token) === MGLO)!.max;
  const nav = (await client.readContract({ address: MGLO_NAV_FEED, abi: parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]), functionName: "latestRoundData", blockNumber: v.at.blockNumber })) as readonly [bigint, bigint, bigint, bigint, bigint];
  const fresh = v.at.timestamp - nav[3] <= limit.maxNavAge;
  const navHolds = (xs: string[]) => xs.filter((x) => /NAV/.test(x));
  // At its total assets now: under 20% now and after (18.4% at 543.7 million on 25 Oct).
  for (const caps of [c.caps, after]) {
    assert.ok(worst(caps, v.accruedTotalAssets) * 10_000n <= v.accruedTotalAssets * 2_000n, `worst ${worst(caps, v.accruedTotalAssets)} of ${v.accruedTotalAssets}`);
    const holds = await cashCollateralHolds(client, v, caps, v.accruedTotalAssets);
    assert.deepEqual(holds.filter((x) => !/NAV/.test(x)), []);
    assert.equal(navHolds(holds).length, fresh ? 0 : 1, holds.join("; "));
  }
  // The share's bound: at exactly 20% of the total nothing holds; one unit of total less, the share holds deposits.
  const m = worst(after, v.accruedTotalAssets);
  const atBound = (m * 10_000n) / 2_000n;
  assert.equal(worst(after, atBound), m, "the bound is the cap, not the total");
  assert.deepEqual((await cashCollateralHolds(client, v, after, atBound)).filter((x) => !/NAV/.test(x)), []);
  const over = await cashCollateralHolds(client, v, after, atBound - 1n);
  assert.match(over.join("; "), /against mGLO, more than 2000 bps/);
  // 36 days on, with no new NAV published on the fork: the NAV is older than 35 days, and deposits are held.
  await fork.increaseTime(36 * 86_400);
  const later = await readVaultV2(client, STEAKHOUSE_USDG);
  const stale = await cashCollateralHolds(client, later, c.caps, later.accruedTotalAssets);
  assert.match(stale.join("; "), /mGLO's NAV was last published [0-9]+ s ago, more than 3024000 s/);
  // Never a problem: the check itself still passes but for that hold, which is not part of it.
  const again = await checkCashVault(client, STEAKHOUSE_USDG, { capIds, holders: [], ostraVaults: [], planned: 0n });
  assert.deepEqual(again.problems.filter((x) => /mGLO|NAV/.test(x)), []);
});
