// The Morpho math in src/morpho.ts on values whose result follows from the contracts' formulas alone (the fork test
// checks every function against the deployed contracts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, getAddress, keccak256 } from "viem";
import {
  ADAPTIVE_CURVE_IRM,
  WAD,
  adapterCapId,
  adaptiveCurveBorrowRate,
  assetsToSharesDown,
  collateralCapId,
  decodeCapIdData,
  decodeMarketParams,
  expectedMarket,
  marketAdapterMarketCapId,
  marketAfter,
  sharesToAssetsDown,
  sharesToAssetsUp,
  supplyRate,
  utilization,
  wExp,
  wTaylorCompounded,
  worstCaseExposure,
  type MarketState,
  type VaultCap,
  type VaultV2State,
} from "../src/morpho.ts";
import { marketId } from "../src/messages.ts";

const LN_2 = 693_147_180_559_945_309n;
const now = 1_800_000_000n;
const rat = ADAPTIVE_CURVE_IRM.INITIAL_RATE_AT_TARGET * 3n;
const market = (supply: bigint, borrow: bigint, lastUpdate = now, fee = 0n): MarketState => ({
  totalSupplyAssets: supply,
  totalSupplyShares: supply * 1_000_000n,
  totalBorrowAssets: borrow,
  totalBorrowShares: borrow * 1_000_000n,
  lastUpdate,
  fee,
});

test("ExpLib.wExp: exact at 0 and at multiples of ln 2, clipped at both ends", () => {
  assert.equal(wExp(0n), WAD);
  assert.equal(wExp(LN_2), 2n * WAD);
  assert.equal(wExp(-LN_2), WAD / 2n);
  assert.equal(wExp(3n * LN_2), 8n * WAD);
  assert.equal(wExp(-41_446_531_673_892_822_313n), 0n);
  assert.equal(wExp(93_859_467_695_000_404_319n), 57_716_089_161_558_943_949_701_069_502_944_508_345_128_422_502_756_744_429_568n);
  // second-order Taylor around 0: e^0.1 ~ 1.105
  assert.equal(wExp(WAD / 10n), WAD + WAD / 10n + (WAD / 10n) * (WAD / 10n) / WAD / 2n);
});

test("AdaptiveCurveIrm curve with no time elapsed: the rate at target at 90% utilisation, 4x at 100%, a quarter at 0", () => {
  assert.equal(adaptiveCurveBorrowRate(market(1000n, 900n), rat, now).avgRate, rat);
  assert.equal(adaptiveCurveBorrowRate(market(1000n, 1000n), rat, now).avgRate, 4n * rat);
  assert.equal(adaptiveCurveBorrowRate(market(1000n, 0n), rat, now).avgRate, rat / 4n);
  // first interaction: the initial rate at target
  assert.equal(adaptiveCurveBorrowRate(market(1000n, 900n), 0n, now).avgRate, ADAPTIVE_CURVE_IRM.INITIAL_RATE_AT_TARGET);
});

test("AdaptiveCurveIrm adaptation: the rate at target grows above the target, shrinks below, bounded", () => {
  const day = 86_400n;
  const up = adaptiveCurveBorrowRate(market(1000n, 1000n, now - 5n * day), rat, now);
  assert.ok(up.endRateAtTarget > rat, "above target the rate at target rises");
  const down = adaptiveCurveBorrowRate(market(1000n, 0n, now - 5n * day), rat, now);
  assert.ok(down.endRateAtTarget < rat, "below target it falls");
  const floor = adaptiveCurveBorrowRate(market(1000n, 0n, now - 3650n * day), rat, now);
  assert.equal(floor.endRateAtTarget, ADAPTIVE_CURVE_IRM.MIN_RATE_AT_TARGET);
  const ceiling = adaptiveCurveBorrowRate(market(1000n, 1000n, now - 3650n * day), ADAPTIVE_CURVE_IRM.MAX_RATE_AT_TARGET, now);
  assert.equal(ceiling.endRateAtTarget, ADAPTIVE_CURVE_IRM.MAX_RATE_AT_TARGET);
});

test("accrual: interest on borrows added to both totals, nothing without elapsed time or borrows, the fee minted as shares", () => {
  const m = market(1_000_000_000n, 800_000_000n, now - 86_400n);
  const e = expectedMarket(m, rat, now);
  const interest = e.market.totalBorrowAssets - m.totalBorrowAssets;
  assert.equal(interest, (m.totalBorrowAssets * wTaylorCompounded(e.borrowRate, 86_400n)) / WAD);
  assert.equal(e.market.totalSupplyAssets - m.totalSupplyAssets, interest);
  assert.equal(e.market.totalSupplyShares, m.totalSupplyShares);
  assert.deepEqual(expectedMarket({ ...m, lastUpdate: now }, rat, now).market, { ...m, lastUpdate: now });
  const empty = expectedMarket(market(1_000_000_000n, 0n, now - 86_400n), rat, now).market;
  assert.equal(empty.totalSupplyAssets, 1_000_000_000n);
  const withFee = expectedMarket({ ...m, fee: WAD / 10n }, rat, now).market;
  assert.ok(withFee.totalSupplyShares > m.totalSupplyShares);
});

test("shares math rounds as SharesMathLib, and a supply or a borrow moves utilisation and the supply rate", () => {
  assert.equal(sharesToAssetsDown(1_000_000n, 0n, 0n), 1n);
  assert.equal(sharesToAssetsUp(1n, 0n, 0n), 1n);
  assert.equal(assetsToSharesDown(1n, 0n, 0n), 1_000_000n);
  const m = market(1000n, 500n);
  assert.equal(utilization(m), WAD / 2n);
  const more = marketAfter(m, { supply: 1000n });
  assert.equal(utilization(more), WAD / 4n);
  assert.ok(supplyRate(more, rat) < supplyRate(m, rat));
  assert.throws(() => marketAfter(m, { borrow: 600n }), /more borrowed than supplied/);
});

test("cap ids decode to what MorphoMarketV1AdapterV2.ids encodes", () => {
  const adapter = getAddress("0x45233242b7aFA26Bd36Cd7E7C9Db23bD8668cbEc");
  const token = getAddress("0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34");
  const params = { loanToken: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"), collateralToken: token, oracle: getAddress("0xE64849bd4AD03DfaBbe02bb521de19997a19055f"), irm: getAddress("0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1"), lltv: 915_000_000_000_000_000n };
  const adapterData = encodeAbiParameters([{ type: "string" }, { type: "address" }], ["this", adapter]);
  assert.equal(keccak256(adapterData), adapterCapId(adapter));
  assert.deepEqual(decodeCapIdData(adapterData), { kind: "adapter", adapter });
  const collData = encodeAbiParameters([{ type: "string" }, { type: "address" }], ["collateralToken", token]);
  assert.equal(keccak256(collData), collateralCapId(token));
  assert.deepEqual(decodeCapIdData(collData), { kind: "collateral", token });
  const tuple = { type: "tuple", components: [{ name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" }, { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" }] } as const;
  const marketData = encodeAbiParameters([{ type: "string" }, { type: "address" }, tuple], ["this/marketParams", adapter, params]);
  assert.equal(keccak256(marketData), marketAdapterMarketCapId(adapter, params));
  assert.deepEqual(decodeCapIdData(marketData), { kind: "market", adapter, params });
  assert.deepEqual(decodeMarketParams(encodeAbiParameters([tuple], [params])), params);
  assert.equal(decodeMarketParams("0x1234"), null);
  assert.deepEqual(decodeCapIdData("0x00"), { kind: "unknown" });
});

test("worst case: absolute caps bind, relative caps do not, and positions above their caps count at what they hold", () => {
  const adapter = getAddress("0x45233242b7aFA26Bd36Cd7E7C9Db23bD8668cbEc");
  const asset = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  const irm = getAddress("0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1");
  const coll = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
  const params = (n: number) => ({ loanToken: asset, collateralToken: coll(n), oracle: coll(99), irm, lltv: 625_000_000_000_000_000n });
  const m = (n: number, supply: bigint) => ({ id: marketId(params(n)), params: params(n), supplyAssets: supply, supplyShares: 0n, allocation: supply }) as never;
  const v = {
    asset,
    accruedTotalAssets: 1000n,
    adapters: [{ kind: "market", address: adapter, adapterId: adapterCapId(adapter), timelocks: {}, realAssets: 0n, markets: [m(1, 600n), m(2, 0n)] }],
  } as unknown as VaultV2State;
  const cap = (what: VaultCap["what"], id: `0x${string}`, absoluteCap: bigint, relativeCap = WAD): VaultCap => ({ id, idData: "0x", what, absoluteCap, relativeCap, allocation: 0n });
  const caps: VaultCap[] = [
    cap({ kind: "adapter", adapter }, adapterCapId(adapter), 10_000n),
    // market 1: its cap was cut to 100 after it took 600; its collateral cap to 0
    cap({ kind: "market", adapter, params: params(1) }, marketAdapterMarketCapId(adapter, params(1)), 100n),
    cap({ kind: "collateral", token: coll(1) }, collateralCapId(coll(1)), 0n),
    // market 2: absolute caps of 5,000 with a 10% relative cap, which does not bind for good
    cap({ kind: "market", adapter, params: params(2) }, marketAdapterMarketCapId(adapter, params(2)), 5_000n, WAD / 10n),
    cap({ kind: "collateral", token: coll(2) }, collateralCapId(coll(2)), 5_000n, WAD / 10n),
    // market 3: no collateral cap, cannot be entered
    cap({ kind: "market", adapter, params: params(3) }, marketAdapterMarketCapId(adapter, params(3)), 5_000n),
  ];
  const w = worstCaseExposure(v, caps);
  const byColl = new Map(w.collaterals.map((c) => [c.token, c]));
  assert.equal(byColl.get(coll(1))?.max, 600n);
  assert.equal(byColl.get(coll(1))?.now, 600n);
  assert.equal(byColl.get(coll(2))?.max, 1000n, "bounded by total assets, not by the 10% relative cap");
  assert.equal(byColl.has(coll(3)), false);
  assert.deepEqual(w.opaque, []);
});
