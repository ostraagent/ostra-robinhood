// src/morpho.ts against the deployed contracts, on a fork of Robinhood Chain mainnet:
//   * the AdaptiveCurveIrm computed here equals the IRM's borrowRateView, for every market of Borro's vaults and of
//     Steakhouse USDG, at the fork block and a week later;
//   * accrual equals Morpho's: a market accrued here equals the market after Morpho.accrueInterest, and an adapter's
//     supply assets equal its expectedSupplyAssets, and a market adapter's markets add up to its realAssets;
//   * withdrawable liquidity agrees with what redeem does: a fresh deposit into Steakhouse USDG redeems in full, and
//     NetNet Credit, whose redeem reverts for its holders, shows less withdrawable than they hold;
//   * caps read from their events, the worst case they allow, oracles, pending changes and allocators.
// Log reads go to the public RPC (up to the fork block), whose log spans are known; the fork serves the state.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createWalletClient, encodeAbiParameters, getAddress, http, parseAbi, parseAbiItem, toFunctionSelector, type Address, type PublicClient } from "viem";
import { BORRO_STOCKS, BORRO_USDG_VAULT, MORPHO_ADAPTIVE_CURVE_IRM, MORPHO_BLUE, MORPHO_MARKET_V1_ADAPTER_V2_FACTORY, MORPHO_VAULT_V2_FACTORY, ROBINHOOD_PUBLIC_RPC, USDG } from "../src/constants.ts";
import { robinhoodClient } from "../src/chain.ts";
import { marketId } from "../src/messages.ts";
import {
  WAD,
  adapterCapId,
  adaptiveCurveBorrowRate,
  assetsToSharesDown,
  sharesToAssetsDown,
  collateralCapId,
  marketAdapterMarketCapId,
  adaptiveCurveIrmAbi,
  blockTime,
  expectedMarket,
  getLogsChunked,
  instantBorrowRate,
  marketAdapterAbi,
  readAllocators,
  readMorphoMarket,
  readOracle,
  readPendingChanges,
  readVaultV2,
  readVaultV2Caps,
  simulateVaultV2Redeem,
  vaultV2CreationBlock,
  vaultV2GatesAllow,
  vaultV2ReadAbi,
  withdrawableNow,
  worstCaseExposure,
  type VaultV2State,
} from "../src/morpho.ts";
import { startFork, type Fork } from "./fork.ts";

const STEAKHOUSE_USDG: Address = "0xBeEff033F34C046626B8D0A041844C5d1A5409dd";
const PURINTA_USDG: Address = "0x37788ff0c1d4e45A7FE06BC7e71e0cc00121d0A8";
const NETNET_CREDIT: Address = "0x99347d5F70D3838763f6Bddcf80304C8aa953B57";
const NETNET_HOLDER: Address = "0x1CfbE10106C1BeB61d9679207Ab767244Fbd85C7";
const WSNET_ORACLE: Address = "0xCDE9599059f8Ae6D6B9F33A0aF7877827ec75F16";
const morphoAccrue = parseAbi([
  "function accrueInterest((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)",
  "function setFee((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 newFee)",
  "function owner() view returns (address)",
]);
const erc20 = parseAbi(["function approve(address, uint256) returns (bool)"]);
const vaultDeposit = parseAbi(["function deposit(uint256 assets, address onBehalf) returns (uint256)"]);

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

const vaults = () => [BORRO_USDG_VAULT, ...BORRO_STOCKS.map((s) => s.vault as Address), STEAKHOUSE_USDG];

/** Every market of every market adapter of `v`. */
const marketsOf = (v: VaultV2State) => v.adapters.flatMap((a) => (a.kind === "market" ? a.markets.map((m) => ({ adapter: a.address, m })) : []));

async function checkRates(label: string) {
  let checked = 0;
  for (const address of vaults()) {
    const v = await readVaultV2(client, address);
    for (const { adapter, m } of marketsOf(v)) {
      const onChain = await client.readContract({ address: m.params.irm, abi: adaptiveCurveIrmAbi, functionName: "borrowRateView", args: [m.params, m.stored], blockNumber: v.at.blockNumber });
      assert.equal(m.borrowRate, onChain, `${label}: borrow rate of ${m.id} (${v.symbol})`);
      const expected = await client.readContract({ address: adapter, abi: marketAdapterAbi, functionName: "expectedSupplyAssets", args: [m.id], blockNumber: v.at.blockNumber });
      assert.equal(m.supplyAssets, expected, `${label}: expectedSupplyAssets of ${m.id} (${v.symbol})`);
      checked++;
    }
    for (const a of v.adapters) {
      if (a.kind !== "market") continue;
      const sum = a.markets.reduce((s, m) => s + m.supplyAssets, 0n);
      assert.equal(sum, a.realAssets, `${label}: ${v.symbol} adapter ${a.address} markets add up to realAssets`);
    }
  }
  return checked;
}

// Runs first, at the fork block: the wsNET oracle reads a TWAP that the later tests' time warps make stale.
test("oracles: Borro's NVDA oracle reads its Chainlink feed and the bNVDA vault; the wsNET oracle is not a Chainlink oracle", { timeout: 300_000 }, async () => {
  const nvda = BORRO_STOCKS.find((s) => s.symbol === "NVDA")!;
  const o = await readOracle(client, nvda.oracle as Address);
  assert.equal(o.kind, "chainlink");
  assert.equal(o.baseVault, getAddress(nvda.vault));
  assert.equal(o.baseFeeds.length, 1);
  assert.match(o.baseFeeds[0]!.description, /NVDA/);
  const ws = await readOracle(client, WSNET_ORACLE);
  assert.equal(ws.kind, "unknown");
  assert.ok(ws.price !== null && ws.price > 0n);
});

test("the AdaptiveCurveIrm and accrual computed here equal the contracts', at the fork block and a week later", { timeout: 1_800_000 }, async () => {
  const n0 = await checkRates("fork block");
  assert.ok(n0 >= 20, `markets checked: ${n0}`);
  await fork.increaseTime(7 * 86_400);
  const n1 = await checkRates("a week later");
  assert.equal(n1, n0);
});

test("a market accrued here equals the market after Morpho.accrueInterest", { timeout: 600_000 }, async () => {
  const v = await readVaultV2(client, STEAKHOUSE_USDG);
  const busiest = marketsOf(v).map((x) => x.m).sort((a, b) => (b.stored.totalBorrowAssets > a.stored.totalBorrowAssets ? 1 : -1))[0]!;
  const nvda = BORRO_STOCKS.find((s) => s.symbol === "NVDA")!;
  const borroNvda = { loanToken: USDG, collateralToken: nvda.vault as Address, oracle: nvda.oracle as Address, irm: busiest.params.irm, lltv: nvda.lltv };
  // Morpho's fee branch: the owner (impersonated on the fork) sets a 10% fee on the Borro NVDA market first.
  const owner = await client.readContract({ address: MORPHO_BLUE, abi: morphoAccrue, functionName: "owner" });
  await fork.setBalance(owner, 10n ** 18n);
  await rpc("anvil_impersonateAccount", [owner]);
  const ownerWallet = createWalletClient({ account: owner, chain: client.chain, transport: http(fork.url) });
  await client.waitForTransactionReceipt({ hash: await ownerWallet.writeContract({ address: MORPHO_BLUE, abi: morphoAccrue, functionName: "setFee", args: [borroNvda, WAD / 10n], chain: null, account: owner }) });
  await rpc("anvil_stopImpersonatingAccount", [owner]);
  for (const params of [busiest.params, borroNvda]) {
    const id = marketId(params);
    const before = await readMorphoMarket(client, id, await blockTime(client));
    await fork.increaseTime(3 * 86_400);
    const w = fork.wallet(fork.accounts[0]!);
    const hash = await w.writeContract({ address: MORPHO_BLUE, abi: morphoAccrue, functionName: "accrueInterest", args: [params], chain: null, account: fork.accounts[0]! });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const at = await blockTime(client, { blockNumber: receipt.blockNumber });
    const predicted = expectedMarket(before.stored, before.rateAtTarget, at.timestamp);
    const after = await readMorphoMarket(client, id, at);
    assert.deepEqual(after.stored, predicted.market, `market ${id} after accrueInterest`);
    assert.equal(after.rateAtTarget, predicted.rateAtTarget, `rate at target stored by the IRM for ${id}`);
    const again = adaptiveCurveBorrowRate(before.stored, before.rateAtTarget, at.timestamp);
    assert.equal(again.avgRate, predicted.borrowRate);
    // right after the accrual (no time elapsed) the IRM's view is the instant rate computed here
    const nowRate = await client.readContract({ address: params.irm, abi: adaptiveCurveIrmAbi, functionName: "borrowRateView", args: [params, after.stored], blockNumber: at.blockNumber });
    assert.equal(instantBorrowRate(after.stored, after.rateAtTarget), nowRate, `instant rate of ${id}`);
    if (params === borroNvda) assert.equal(after.stored.fee, WAD / 10n);
  }
});

test("withdrawable liquidity agrees with redeem: Steakhouse USDG redeems a fresh deposit in full; NetNet Credit's holders cannot redeem", { timeout: 600_000 }, async () => {
  const me = fork.accounts[1]!;
  const w = fork.wallet(me);
  await fork.dealUsdg(me.address, 1_000_000_000n);
  await client.waitForTransactionReceipt({ hash: await w.writeContract({ address: USDG, abi: erc20, functionName: "approve", args: [STEAKHOUSE_USDG, 1_000_000_000n], chain: null, account: me }) });
  await client.waitForTransactionReceipt({ hash: await w.writeContract({ address: STEAKHOUSE_USDG, abi: vaultDeposit, functionName: "deposit", args: [1_000_000_000n, me.address], chain: null, account: me }) });
  const steak = await readVaultV2(client, STEAKHOUSE_USDG);
  const shares = await client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2ReadAbi, functionName: "balanceOf", args: [me.address] });
  const value = await client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2ReadAbi, functionName: "previewRedeem", args: [shares] });
  assert.ok(withdrawableNow(steak) >= value, `Steakhouse withdrawable ${withdrawableNow(steak)} covers ${value}`);
  const redeemed = await simulateVaultV2Redeem(client, STEAKHOUSE_USDG, me.address, shares);
  assert.ok(redeemed.ok && redeemed.assets === value, JSON.stringify(redeemed, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
  assert.deepEqual(await vaultV2GatesAllow(client, steak, me.address), { deposit: true, redeem: true });

  const netnet = await readVaultV2(client, NETNET_CREDIT);
  const held = await client.readContract({ address: NETNET_CREDIT, abi: vaultV2ReadAbi, functionName: "balanceOf", args: [NETNET_HOLDER] });
  const heldValue = await client.readContract({ address: NETNET_CREDIT, abi: vaultV2ReadAbi, functionName: "previewRedeem", args: [held] });
  assert.ok(withdrawableNow(netnet) < heldValue, `NetNet withdrawable ${withdrawableNow(netnet)} is below the holder's ${heldValue}`);
  assert.deepEqual(await vaultV2GatesAllow(client, netnet, NETNET_HOLDER), { deposit: true, redeem: true }, "NetNet's gates let the holder out");
  const r = await simulateVaultV2Redeem(client, NETNET_CREDIT, NETNET_HOLDER, held);
  assert.ok(!r.ok && /underflow|overflow/i.test(r.reason), `NetNet redeem: ${JSON.stringify(r)}`);
});

test("caps from their events, the worst case they allow, pending changes and allocators", { timeout: 1_800_000 }, async () => {
  for (const address of [PURINTA_USDG, STEAKHOUSE_USDG]) {
    const created = await vaultV2CreationBlock(logs, address, forkBlock);
    assert.ok(created !== null, `${address} was created by the VaultV2Factory ${MORPHO_VAULT_V2_FACTORY}`);
    const v = await readVaultV2(client, address, { blockNumber: forkBlock });
    const caps = await readVaultV2Caps(withState(logs, client), v, created);
    assert.ok(caps.length > 0);
    const worst = worstCaseExposure(v, caps);
    const pending = await readPendingChanges(withState(logs, client), v, created);
    const allocators = await readAllocators(withState(logs, client), v, created);
    assert.ok(allocators.length >= 1, `${v.symbol} has allocators`);
    console.log(
      `${v.symbol}: totalAssets ${v.accruedTotalAssets}, worst case by collateral ${worst.collaterals.map((c) => `${c.token.slice(0, 8)} ${c.max}`).join(", ")}, opaque adapters ${worst.opaque.length}, pending ${pending.length}, allocators ${allocators.length}`,
    );
  }
});

test("the MorphoMarketV1AdapterV2 factory is Morpho Blue's with the AdaptiveCurveIrm, and log reads keep within their span", { timeout: 300_000 }, async () => {
  const f = parseAbi(["function morpho() view returns (address)", "function adaptiveCurveIrm() view returns (address)"]);
  assert.equal(await client.readContract({ address: MORPHO_MARKET_V1_ADAPTER_V2_FACTORY, abi: f, functionName: "morpho" }), MORPHO_BLUE);
  assert.equal(await client.readContract({ address: MORPHO_MARKET_V1_ADAPTER_V2_FACTORY, abi: f, functionName: "adaptiveCurveIrm" }), MORPHO_ADAPTIVE_CURVE_IRM);
  const spans: bigint[] = [];
  const recording = new Proxy(logs, {
    // only spans the RPC answered: a refused span is retried smaller
    get: (t, k) => (k === "getLogs" ? async (q: { fromBlock: bigint; toBlock: bigint }) => { const r = await t.getLogs(q as never); spans.push(q.toBlock - q.fromBlock + 1n); return r; } : Reflect.get(t, k)),
  }) as PublicClient;
  const ev = parseAbiItem("event CreateVaultV2(address indexed owner, address indexed asset, bytes32 salt, address indexed newVaultV2)");
  const got = await getLogsChunked(recording, { address: MORPHO_VAULT_V2_FACTORY, event: ev, fromBlock: forkBlock - 3_000_000n, toBlock: forkBlock, maxSpan: 1_000_000n, minSpan: 1_000n });
  assert.ok(spans.length >= 3 && spans.every((x) => x <= 1_000_000n && x >= 1n), `spans ${spans.join(",")}`);
  assert.equal(spans.reduce((a, b) => a + b, 0n), 3_000_001n, "the spans cover the range once");
  for (const l of got) assert.ok(l.blockNumber >= forkBlock - 3_000_000n && l.blockNumber <= forkBlock);
});

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(fork.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

test("allocate up to the cap room computed here succeeds, one unit more reverts with AbsoluteCapExceeded, and the worst case covers what it holds then", { timeout: 1_800_000 }, async () => {
  const created = (await vaultV2CreationBlock(logs, STEAKHOUSE_USDG, forkBlock))!;
  // the vault as it is now (an earlier test deposited into it through the same adapter): its cap ids
  // from the events up to the fork block, their values read from the fork now
  const capsNow = async () => {
    const ids = await readVaultV2Caps(withState(logs, client), await readVaultV2(client, STEAKHOUSE_USDG, { blockNumber: forkBlock }), created);
    const r = (fn: "absoluteCap" | "relativeCap" | "allocation", id: `0x${string}`) => client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2ReadAbi, functionName: fn, args: [id] }) as Promise<bigint>;
    return Promise.all(ids.map(async (c) => ({ ...c, absoluteCap: await r("absoluteCap", c.id), relativeCap: await r("relativeCap", c.id), allocation: await r("allocation", c.id) })));
  };
  const v = await readVaultV2(client, STEAKHOUSE_USDG);
  const caps = await capsNow();
  const byId = new Map(caps.map((c) => [c.id.toLowerCase(), c]));
  const worst = worstCaseExposure(v, caps);
  // a market whose three ids have relative caps of 100% (so only absolute caps bind) and whose room under its absolute
  // caps the vault's idle assets can fill
  const idsOf = (m: (typeof worst.markets)[number]) => [marketAdapterMarketCapId(m.adapter, m.params), collateralCapId(m.params.collateralToken), adapterCapId(m.adapter)].map((x) => byId.get(x.toLowerCase()));
  const roomOf = (m: (typeof worst.markets)[number]) => idsOf(m).map((c) => (c === undefined ? 0n : c.absoluteCap - c.allocation)).reduce((a, b) => (a < b ? a : b));
  const pick = worst.markets.find((m) => idsOf(m).every((c) => c !== undefined && c.relativeCap === WAD) && roomOf(m) > 0n && roomOf(m) < v.idle);
  assert.ok(pick !== undefined, "a cap-bound market the idle assets can fill");
  const ids = idsOf(pick).map((c) => c!);
  const room = roomOf(pick);
  const allocators = await readAllocators(withState(logs, client), v, created);
  const allocator = allocators[0]!;
  await fork.setBalance(allocator, 10n ** 18n);
  await rpc("anvil_impersonateAccount", [allocator]);
  const w = createWalletClient({ account: allocator, chain: client.chain, transport: http(fork.url) });
  const allocate = parseAbi(["function allocate(address adapter, bytes data, uint256 assets)"]);
  const data = encodeAbiParameters([{ type: "tuple", components: [{ name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" }, { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" }] }], [pick.params]);

  // What allocate adds to each of the market's ids is the adapter's change in allocation (MorphoMarketV1AdapterV2):
  // the supply assets of its shares after Morpho.supply, rounded down, minus the allocation the vault last recorded,
  // so it includes the interest accrued since then. At a fixed timestamp it follows from the market's state alone.
  const head = await client.getBlock();
  const T = head.timestamp + 10n;
  const mk = await readMorphoMarket(client, pick.id, { blockNumber: head.number, timestamp: head.timestamp });
  const accrued = expectedMarket(mk.stored, mk.rateAtTarget, T).market;
  const shares0 = (await client.readContract({ address: pick.adapter, abi: marketAdapterAbi, functionName: "supplyShares", args: [pick.id] })) as bigint;
  const oldAllocation = ids.find((c) => c.what.kind === "market")!.allocation;
  const change = (assets: bigint) => {
    const minted = assetsToSharesDown(assets, accrued.totalSupplyAssets, accrued.totalSupplyShares);
    const shares = shares0 + minted;
    return (shares === 0n ? 0n : sharesToAssetsDown(shares, accrued.totalSupplyAssets + assets, accrued.totalSupplyShares + minted)) - oldAllocation;
  };
  // the most an allocator can allocate: the largest amount whose change keeps every id within its absolute cap
  let lo = 0n;
  let hi = v.idle;
  assert.ok(change(hi) > room, "the idle assets are more than the room, so a cap binds");
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if (change(mid) <= room) lo = mid;
    else hi = mid;
  }
  const most = lo;
  assert.ok(change(most) <= room && change(most + 1n) > room);

  const send = async (assets: bigint) => {
    await rpc("evm_setNextBlockTimestamp", [Number(T)]);
    const hash = await w.writeContract({ address: STEAKHOUSE_USDG, abi: allocate, functionName: "allocate", args: [pick.adapter, data, assets], chain: null, account: allocator, gas: 5_000_000n });
    return { hash, receipt: await client.waitForTransactionReceipt({ hash }) };
  };
  const snapshot = await rpc("evm_snapshot", []);
  const over = await send(most + 1n);
  assert.equal(over.receipt.status, "reverted", "one unit more than the computed most reverts");
  const trace = (await rpc("debug_traceTransaction", [over.hash, { tracer: "callTracer" }])) as { output?: string };
  assert.equal(trace.output?.slice(0, 10), toFunctionSelector("function AbsoluteCapExceeded()"), "and it reverts on an absolute cap");
  await rpc("evm_revert", [snapshot]);
  const ok = await send(most);
  assert.equal(ok.receipt.status, "success", "the computed most succeeds");
  await rpc("anvil_stopImpersonatingAccount", [allocator]);

  // every id grew by exactly the computed change, and the binding one has less room left than one more unit adds
  const after = await capsNow();
  const grown = ids.map((c) => after.find((x) => x.id.toLowerCase() === c.id.toLowerCase())!);
  for (const [i, c] of grown.entries()) assert.equal(c.allocation, ids[i]!.allocation + change(most), `${c.what.kind} id allocation`);
  const left = grown.map((c) => c.absoluteCap - c.allocation).reduce((x, y) => (x < y ? x : y));
  assert.ok(left < change(most + 1n) - change(most), `room left ${left}`);
  // the market now holds its recorded allocation plus the change (pick.now already includes the interest that the
  // change also counts), and the worst case for it is at least that
  const held = grown.find((c) => c.what.kind === "market")!.allocation;
  assert.equal(held, oldAllocation + change(most));
  assert.ok(pick.max >= held, `the worst case ${pick.max} covers what the market holds (${held})`);
});

/** A client whose logs come from `logClient` and whose state reads come from `stateClient` (the fork). */
function withState(logClient: PublicClient, stateClient: PublicClient): PublicClient {
  return new Proxy(stateClient, { get: (t, k) => (k === "getLogs" ? logClient.getLogs.bind(logClient) : Reflect.get(t, k)) }) as PublicClient;
}

