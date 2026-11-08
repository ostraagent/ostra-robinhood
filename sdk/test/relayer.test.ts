// Relay requests and their price (relayer.ts): the rules the relayer charges
// by and an agent checks a quote with. Chainlink itself is read in
// relayer.fork.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { concat, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, hexToBytes, keccak256, toFunctionSelector, zeroAddress, type Hex, type Log } from "viem";
import { ostraVaultAbi, ostraVaultModuleAbi, ostraVaultModuleV4Abi } from "../src/abi.ts";
import {
  GUARD_OP,
  MULTICALL3,
  RAETO_NVDA_VAULT,
  RAETO_TSLA_VAULT,
  RAETO_USDG_VAULT,
  SPARK_SAVINGS_USDG,
  USDG,
  VAULT_ACTION,
  VAULT_ERC4626_MIN_GAS,
  VAULT_GUARD_EXIT_MIN_GAS,
  VAULT_GUARD_MIN_GAS,
  VAULT_MORPHO_MIN_GAS,
  VAULT_RAETO_STOCK_MIN_GAS,
  VAULT_RAETO_USDG_MIN_GAS,
  VAULT_SWAP_GAS,
  VAULT_SWAP_GAS_RESERVE,
  VENUE_KIND,
} from "../src/constants.ts";
import { enterParams, exitParams, forwardParams, guardParams, lendParams, setVenueParams, supportRecoveryParams, swapParams, transferParams } from "../src/messages.ts";
import { multicall3Abi } from "../src/external-abi.ts";
import { STEAKHOUSE_USDG } from "../src/strategy.ts";
import {
  ETH_USD_DEVIATION_BPS,
  ETH_USD_MAX_AGE_SECONDS,
  MAX_RELAY_CALLS,
  RELAYER_MARGIN_BPS,
  RELAYER_QUOTE_TOLERANCE_BPS,
  checkFresh,
  failedSwaps,
  maxAcceptedQuote,
  relayCalls,
  relayRequestBody,
  relayRequestHash,
  relayGasCap,
  relayTransaction,
  ESCROW_EXECUTED_TOPIC,
  EXECUTE_ESCROW_SELECTOR,
  escrowCalls,
  escrowSwaps,
  failedModuleSpends,
  catalogVenueSpend,
  floorGasOf,
  moduleFailureText,
  pricedFloorGas,
  relayGas,
  relayPriceWei,
  reservedSwapGas,
  spendFloorGas,
  unpricedFloorGas,
  swapGasOf,
  weiToTokenUnits,
  withMargin,
} from "../src/relayer.ts";

const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
/** $4,000.00 per ETH in the feed's 8 decimals. */
const price = { answer: 400_000_000_000n, roundId: 1n, updatedAt: 1_000n };

test("decided numbers", () => {
  assert.equal(RELAYER_MARGIN_BPS, 1_000n);
  assert.equal(RELAYER_QUOTE_TOLERANCE_BPS, 1_000n);
  assert.equal(ETH_USD_DEVIATION_BPS, 50n);
  assert.equal(ETH_USD_MAX_AGE_SECONDS, 90_000n);
  assert.equal(MAX_RELAY_CALLS, 8);
});

test("the margin is 10%, rounded up", () => {
  assert.equal(withMargin(1_000n), 1_100n);
  assert.equal(withMargin(1n), 2n);
  assert.equal(withMargin(0n), 0n);
});

test("wei to token units: at the answer + 0.5%, rounded up, at least 1", () => {
  // 0.001 ETH at $4,000 = $4, + 0.5% = $4.02 = 4,020,000 units of a 6-decimal token.
  assert.equal(weiToTokenUnits(10n ** 15n, price, 6), 4_020_000n);
  // One more wei rounds up by one unit.
  assert.equal(weiToTokenUnits(10n ** 15n + 1n, price, 6), 4_020_001n);
  // A tiny cost is still one unit; nothing costs nothing.
  assert.equal(weiToTokenUnits(1n, price, 6), 1n);
  assert.equal(weiToTokenUnits(0n, price, 6), 0n);
  assert.throws(() => weiToTokenUnits(1n, { ...price, answer: 0n }, 6), RangeError);
  assert.throws(() => weiToTokenUnits(1n, price, 19), RangeError);
});

test("an agent pays a quote at most 10% above its own price", () => {
  assert.equal(maxAcceptedQuote(1_000n), 1_100n);
  assert.equal(maxAcceptedQuote(1_001n), 1_102n);
  assert.equal(maxAcceptedQuote(1n), 2n);
  assert.throws(() => maxAcceptedQuote(-1n), RangeError);
});

test("an ETH/USD answer older than the heartbeat plus an hour is refused", () => {
  checkFresh(price, price.updatedAt + ETH_USD_MAX_AGE_SECONDS);
  assert.throws(() => checkFresh(price, price.updatedAt + ETH_USD_MAX_AGE_SECONDS + 1n), /old/);
  assert.throws(() => checkFresh({ ...price, updatedAt: 10n ** 9n }, 1_000n), /future/);
});

test("one call is sent as it is; several go through Multicall3 aggregate3, none allowed to fail", () => {
  const a = { to: at(1), data: "0x12345678aa" as Hex };
  const b = { to: at(2), data: "0xdeadbeef" as Hex };
  assert.deepEqual(relayTransaction([a]), { to: a.to, data: a.data });
  const tx = relayTransaction([a, b]);
  assert.equal(tx.to, MULTICALL3);
  const decoded = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
  assert.equal(decoded.functionName, "aggregate3");
  assert.deepEqual(decoded.args[0], [
    { target: a.to, allowFailure: false, callData: a.data },
    { target: b.to, allowFailure: false, callData: b.data },
  ]);
  assert.equal(relayRequestHash([a, b]), keccak256(concat([hexToBytes(MULTICALL3), hexToBytes(tx.data)]), "hex"));
});

test("calls are checked and normalized; the body an agent posts reads back", () => {
  const calls = relayCalls([{ to: at(1).toLowerCase(), data: "0xABCDEF01" }]);
  assert.deepEqual(calls, [{ to: at(1), data: "0xabcdef01" }]);
  assert.deepEqual(JSON.parse(relayRequestBody(calls, { prepay: true, payer: at(3) })), { calls: [{ to: at(1), data: "0xabcdef01" }], prepay: true, payer: at(3) });
  assert.deepEqual(JSON.parse(relayRequestBody(calls)), { calls: [{ to: at(1), data: "0xabcdef01" }] });
  assert.deepEqual(JSON.parse(relayRequestBody(calls, { allowFailedSwaps: true })), { calls: [{ to: at(1), data: "0xabcdef01" }], allowFailedSwaps: true });
  assert.throws(() => relayCalls(Array.from({ length: MAX_RELAY_CALLS + 1 }, () => ({ to: at(1), data: "0x12345678" }))), /at most 8 calls/);
  assert.throws(() => relayCalls([{ to: at(1), data: "0x123456" }]), /4-byte selector/);
  assert.throws(() => relayCalls([{ to: at(1), data: "0x12345678", value: "0x1" }]), /no ETH value/);
});

test("failed vault Swaps are read from SwapFailed, only from the vaults named", () => {
  const poolId = keccak256("0x01");
  const reason = "0x7c9c6e8f" as Hex;
  const failed = (address: Hex): Log =>
    ({
      address,
      topics: encodeEventTopics({ abi: ostraVaultAbi, eventName: "SwapFailed", args: { poolId } }),
      data: encodeAbiParameters([{ type: "bytes4" }], [reason]),
    }) as unknown as Log;
  const swapped = {
    address: at(1),
    topics: encodeEventTopics({ abi: ostraVaultAbi, eventName: "Swapped", args: { poolId } }),
    data: encodeAbiParameters([{ type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }], [false, 1n, 1n, at(9)]),
  } as unknown as Log;
  const logs = [swapped, failed(at(1)), failed(at(2))];
  assert.deepEqual(failedSwaps(logs, [at(1).toLowerCase() as Hex]), [{ vault: at(1), poolId, reason }]);
  assert.deepEqual(failedSwaps(logs, [at(1), at(2)]).map((f) => f.vault), [at(1), at(2)]);
  // Any contract can emit the topic: one not among the vaults does not count.
  assert.deepEqual(failedSwaps(logs, [at(3)]), []);
  assert.deepEqual(failedSwaps([swapped], [at(1)]), []);
});

test("failed version 3 and 4 spends are read from MorphoFailed, Guarded (ok false) and VenueFailed, only from the vaults named", () => {
  const notEnabled = toFunctionSelector("NotEnabled()");
  const outOfGas = toFunctionSelector("OutOfGas()");
  const log = (address: Hex, abi: typeof ostraVaultModuleAbi | typeof ostraVaultModuleV4Abi, eventName: string, args: Record<string, unknown>, data: Hex): Log =>
    ({ address, topics: encodeEventTopics({ abi, eventName, args } as never), data }) as unknown as Log;
  const venueFailed = (address: Hex, action: number) => log(address, ostraVaultModuleV4Abi, "VenueFailed", { action }, encodeAbiParameters([{ type: "bytes4" }], [notEnabled]));
  const morphoFailed = log(at(1), ostraVaultModuleAbi, "MorphoFailed", { action: VAULT_ACTION.LEND }, encodeAbiParameters([{ type: "bytes4" }], [outOfGas]));
  const guarded = (ok: boolean) => log(at(1), ostraVaultModuleAbi, "Guarded", { vault: at(5) }, encodeAbiParameters([{ type: "uint8" }, { type: "bool" }, { type: "bytes4" }], [6, ok, ok ? "0x00000000" : notEnabled]));
  const logs = [morphoFailed, guarded(true), guarded(false), venueFailed(at(1), VAULT_ACTION.ENTER), venueFailed(at(2), VAULT_ACTION.EXIT)];
  assert.deepEqual(failedModuleSpends(logs, [at(1)]), [
    { vault: at(1), kind: "morpho", action: VAULT_ACTION.LEND, reason: outOfGas },
    { vault: at(1), kind: "guard", action: 6, reason: notEnabled },
    { vault: at(1), kind: "venue", action: VAULT_ACTION.ENTER, reason: notEnabled },
  ]);
  assert.deepEqual(failedModuleSpends(logs, [at(2)]), [{ vault: at(2), kind: "venue", action: VAULT_ACTION.EXIT, reason: notEnabled }]);
  // Any contract can emit the topics: one not among the vaults does not count.
  assert.deepEqual(failedModuleSpends(logs, [at(3)]), []);
  // OstraVaultModuleV4's errors are named, those with arguments too.
  assert.equal(moduleFailureText(notEnabled), "NotEnabled");
  assert.equal(moduleFailureText(toFunctionSelector("VenueChanged(uint8)")), "VenueChanged");
  assert.equal(moduleFailureText(toFunctionSelector("InLoss()")), "InLoss");
  assert.ok(ostraVaultModuleV4Abi.some((x) => x.type === "error" && x.name === "VenueChanged" && x.inputs.length === 1));
  assert.equal(moduleFailureText(outOfGas), "OutOfGas");
});

test("the gas the vault Swaps of a relay transaction reserve is added up (swapGas and its check's headroom); other calls reserve none", () => {
  const key = { currency0: zeroAddress, currency1: USDG, fee: 500, tickSpacing: 10, hooks: zeroAddress };
  const spend = (action: number, params: Hex) => encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [action, keccak256("0x02"), params, "0x00"] });
  const swap = (swapGas?: bigint) => ({ to: at(1), data: spend(VAULT_ACTION.SWAP, swapParams({ key, zeroForOne: false, amountIn: 1n, minOut: 0n, recipient: at(9), swapGas })) });
  const transfer = { to: at(2), data: spend(VAULT_ACTION.TRANSFER, transferParams({ to: at(9), amount: 1n })) };
  const held = (g: bigint) => g + g / 63n + 1n + BigInt(VAULT_SWAP_GAS_RESERVE);
  assert.equal(reservedSwapGas(relayTransaction([swap(252_000n)])), 252_000n + 4_001n + 30_000n);
  assert.equal(reservedSwapGas(relayTransaction([swap()])), held(BigInt(VAULT_SWAP_GAS.DEFAULT)));
  assert.equal(reservedSwapGas(relayTransaction([swap(250_000n), transfer, swap(300_000n)])), held(250_000n) + held(300_000n));
  assert.deepEqual(swapGasOf(relayTransaction([swap(250_000n), transfer, swap(300_000n)])), [250_000n, 300_000n]);
  assert.equal(reservedSwapGas(relayTransaction([transfer])), 0n);
  assert.equal(reservedSwapGas({ to: at(3), data: "0xabcdef01" }), 0n);
  // A Swap spend whose params do not decode, or a spend call that does not, reserves the most a Swap can sign.
  assert.equal(reservedSwapGas(relayTransaction([{ to: at(1), data: spend(VAULT_ACTION.SWAP, "0x1234") }])), held(BigInt(VAULT_SWAP_GAS.MAX)));
  assert.deepEqual(swapGasOf(relayTransaction([{ to: at(1), data: transfer.data.slice(0, 74) as Hex }, swap(250_000n)])), [BigInt(VAULT_SWAP_GAS.MAX), 250_000n]);
  // The gas limit cap: the priced gas + the margin.
  assert.equal(relayGasCap(100_000n), 110_000n);
  assert.equal(relayGasCap(100_001n), withMargin(100_001n));
});

test("the gas floors of a relay transaction's vault spends: Morpho, Guard and SupportRecovery (version 3), Enter and Exit by kind and a Guard with op 5 or 6 (version 4)", () => {
  const spend = (action: number, params: Hex) => ({ to: at(1), data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [action, keccak256("0x02"), params, "0x00"] }) });
  const venue = (action: number, kind: number, v: Hex) =>
    spend(action, action === VAULT_ACTION.ENTER ? enterParams({ kind: kind as never, venue: v, amount: 1n, minPosition: 0n }) : exitParams({ kind: kind as never, venue: v, amount: 1n, minOut: 0n }));
  const floor = (call: { to: Hex; data: Hex }) => floorGasOf(relayTransaction([call]));
  // Version 3.
  assert.deepEqual(floor(spend(VAULT_ACTION.LEND, lendParams({ vault: at(5), assets: 1n, minShares: 0n }))), [BigInt(VAULT_MORPHO_MIN_GAS)]);
  assert.deepEqual(floor(spend(VAULT_ACTION.SUPPORT_RECOVERY, supportRecoveryParams({ vault: at(5), newKeyRoot: keccak256("0x03") }))), [BigInt(VAULT_GUARD_MIN_GAS)]);
  assert.deepEqual(floor(spend(VAULT_ACTION.GUARD, guardParams(at(5), { op: GUARD_OP.SWEEP, expected: at(6) }))), [BigInt(VAULT_GUARD_MIN_GAS)]);
  // Version 4: a Guard with op 5 runs in OstraVaultModuleV4 with its own floor.
  assert.deepEqual(floor(spend(VAULT_ACTION.GUARD, guardParams(at(5), { op: GUARD_OP.EXIT, kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 0n }))), [BigInt(VAULT_GUARD_EXIT_MIN_GAS)]);
  assert.deepEqual(
    floor(spend(VAULT_ACTION.GUARD, guardParams(at(5), { op: GUARD_OP.EXIT_SWEEP, kind: VENUE_KIND.RAETO_USDG, venue: RAETO_USDG_VAULT, amount: 0n, expected: at(6) }))),
    [BigInt(VAULT_GUARD_EXIT_MIN_GAS)],
  );
  for (const action of [VAULT_ACTION.ENTER, VAULT_ACTION.EXIT]) {
    assert.deepEqual(floor(venue(action, VENUE_KIND.RAETO_USDG, RAETO_USDG_VAULT)), [BigInt(VAULT_RAETO_USDG_MIN_GAS)]);
    assert.deepEqual(floor(venue(action, VENUE_KIND.RAETO_STOCK, RAETO_NVDA_VAULT)), [BigInt(VAULT_RAETO_STOCK_MIN_GAS)]);
    assert.deepEqual(floor(venue(action, VENUE_KIND.ERC4626, SPARK_SAVINGS_USDG)), [BigInt(VAULT_ERC4626_MIN_GAS)]);
  }
  // Any other kind word starts with the ERC4626 floor, as OstraVaultModuleV4._minGas gives it.
  assert.equal(spendFloorGas(VAULT_ACTION.ENTER, `0x${"00".repeat(31)}07${"00".repeat(96)}`), BigInt(VAULT_ERC4626_MIN_GAS));
  // The op is the op word's last byte, the one OstraVault routes by: 7 and 8 go to OstraVaultModuleV5.guardSpend
  // (version 5), any other from 5 up to OstraVaultModuleV4 (which refuses all but 5 and 6), below 5 to OstraVaultModule.
  for (const op of ["05", "06", "09", "ff"]) assert.equal(spendFloorGas(VAULT_ACTION.GUARD, `0x${"00".repeat(63)}${op}${"00".repeat(64)}`), BigInt(VAULT_GUARD_EXIT_MIN_GAS), op);
  for (const op of ["00", "04", "07", "08"]) assert.equal(spendFloorGas(VAULT_ACTION.GUARD, `0x${"00".repeat(63)}${op}${"00".repeat(64)}`), BigInt(VAULT_GUARD_MIN_GAS), op);
  // No floor: SetVenue, Forward, Transfer, a call that is no spend.
  assert.deepEqual(floor(spend(VAULT_ACTION.SET_VENUE, setVenueParams({ kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, enabled: true }))), []);
  assert.deepEqual(floor(spend(VAULT_ACTION.FORWARD, forwardParams({ token: USDG, amount: 1n }))), []);
  assert.deepEqual(floor(spend(VAULT_ACTION.TRANSFER, transferParams({ to: at(9), amount: 1n }))), []);
  assert.deepEqual(floor({ to: at(3), data: "0xabcdef01" }), []);
  // Several calls: one floor each, added to what the transaction reserves.
  const both = relayTransaction([venue(VAULT_ACTION.ENTER, VENUE_KIND.RAETO_USDG, RAETO_USDG_VAULT), venue(VAULT_ACTION.EXIT, VENUE_KIND.ERC4626, SPARK_SAVINGS_USDG)]);
  assert.deepEqual(floorGasOf(both), [BigInt(VAULT_RAETO_USDG_MIN_GAS), BigInt(VAULT_ERC4626_MIN_GAS)]);
  assert.equal(reservedSwapGas(both), BigInt(VAULT_RAETO_USDG_MIN_GAS + VAULT_ERC4626_MIN_GAS));
});

test("a venue spend of VENUE_CATALOG is priced at the gas it uses, its floor kept apart for the gas limit; one outside it is priced with its floor", () => {
  const spend = (action: number, params: Hex) => ({ to: at(1), data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [action, keccak256("0x02"), params, "0x00"] }) });
  const enter = (kind: number, v: Hex) => enterParams({ kind: kind as never, venue: v, amount: 1n, minPosition: 0n });
  const exit = (kind: number, v: Hex) => exitParams({ kind: kind as never, venue: v, amount: 1n, minOut: 0n });
  // The catalog: Spark as ERC4626, Raeto's USDG vault, Raeto's stock vaults; Enter and Exit, and a Guard with op 5 or 6.
  for (const [kind, venue] of [[VENUE_KIND.ERC4626, SPARK_SAVINGS_USDG], [VENUE_KIND.RAETO_USDG, RAETO_USDG_VAULT], [VENUE_KIND.RAETO_STOCK, RAETO_NVDA_VAULT], [VENUE_KIND.RAETO_STOCK, RAETO_TSLA_VAULT]] as const) {
    for (const params of [enter(kind, venue), exit(kind, venue)]) {
      for (const action of [VAULT_ACTION.ENTER, VAULT_ACTION.EXIT]) {
        assert.equal(catalogVenueSpend(action, params), true, `${action} ${kind} ${venue}`);
        assert.equal(pricedFloorGas(action, params), 0n);
      }
    }
    assert.equal(catalogVenueSpend(VAULT_ACTION.GUARD, guardParams(at(5), { op: GUARD_OP.EXIT, kind, venue, amount: 0n })), true);
    assert.equal(catalogVenueSpend(VAULT_ACTION.GUARD, guardParams(at(5), { op: GUARD_OP.EXIT_SWEEP, kind, venue, amount: 0n, expected: at(6) })), true);
    assert.equal(pricedFloorGas(VAULT_ACTION.GUARD, guardParams(at(5), { op: GUARD_OP.EXIT, kind, venue, amount: 0n })), 0n);
  }
  // Outside it: another venue of a kind (Steakhouse is an ERC-4626, a venue anyone deploys too), a catalog venue under
  // another kind, a Guard of another op, any other spend: their floors are priced.
  for (const params of [enter(VENUE_KIND.ERC4626, STEAKHOUSE_USDG), enter(VENUE_KIND.ERC4626, at(0x4626)), enter(VENUE_KIND.ERC4626, RAETO_USDG_VAULT), enter(VENUE_KIND.RAETO_USDG, SPARK_SAVINGS_USDG), exit(VENUE_KIND.RAETO_STOCK, RAETO_USDG_VAULT)]) {
    assert.equal(catalogVenueSpend(VAULT_ACTION.ENTER, params), false, params);
    assert.equal(pricedFloorGas(VAULT_ACTION.ENTER, params), spendFloorGas(VAULT_ACTION.ENTER, params));
  }
  assert.equal(catalogVenueSpend(VAULT_ACTION.GUARD, guardParams(at(5), { op: GUARD_OP.EXIT, kind: VENUE_KIND.ERC4626, venue: at(0x4626), amount: 0n })), false);
  assert.equal(catalogVenueSpend(VAULT_ACTION.GUARD, guardParams(at(5), { op: GUARD_OP.SWEEP, expected: SPARK_SAVINGS_USDG })), false);
  assert.equal(pricedFloorGas(VAULT_ACTION.GUARD, guardParams(at(5), { op: GUARD_OP.SWEEP, expected: at(6) })), BigInt(VAULT_GUARD_MIN_GAS));
  assert.equal(pricedFloorGas(VAULT_ACTION.LEND, lendParams({ vault: STEAKHOUSE_USDG, assets: 1n, minShares: 0n })), BigInt(VAULT_MORPHO_MIN_GAS));
  assert.equal(catalogVenueSpend(VAULT_ACTION.SET_VENUE, setVenueParams({ kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, enabled: true })), false);
  // Words the module's abi.decode refuses name no venue: a dirty kind or venue word, a Guard arg with bits above the
  // kind, an op word of more than a byte, and params too short.
  const spark = enter(VENUE_KIND.ERC4626, SPARK_SAVINGS_USDG);
  assert.equal(catalogVenueSpend(VAULT_ACTION.ENTER, `0x${"00".repeat(30)}01${spark.slice(64)}` as Hex), false);
  assert.equal(catalogVenueSpend(VAULT_ACTION.ENTER, `${spark.slice(0, 66)}01${spark.slice(68)}` as Hex), false);
  const guard = guardParams(at(5), { op: GUARD_OP.EXIT, kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 0n });
  assert.equal(catalogVenueSpend(VAULT_ACTION.GUARD, `${guard.slice(0, 130)}01${guard.slice(132)}` as Hex), false);
  assert.equal(catalogVenueSpend(VAULT_ACTION.GUARD, `${guard.slice(0, 66)}${"00".repeat(30)}0105${guard.slice(130)}` as Hex), false);
  assert.equal(catalogVenueSpend(VAULT_ACTION.ENTER, spark.slice(0, 66) as Hex), false);

  // The price: a Spark Enter that used 300,000 gas simulated with 50,000 of L1 data is priced at those alone, and its
  // floor (600,000) is kept apart for the gas limit; the same Enter into a venue outside the catalog is priced with it.
  const gasPrice = 20_000_000n;
  const inCatalog = relayTransaction([spend(VAULT_ACTION.ENTER, spark)]);
  const outside = relayTransaction([spend(VAULT_ACTION.ENTER, enter(VENUE_KIND.ERC4626, at(0x4626)))]);
  assert.deepEqual(relayGas(inCatalog, 300_000n, 50_000n), { gas: 350_000n, unpricedGas: BigInt(VAULT_ERC4626_MIN_GAS) });
  assert.deepEqual(relayGas(outside, 300_000n, 50_000n), { gas: 350_000n + BigInt(VAULT_ERC4626_MIN_GAS), unpricedGas: 0n });
  assert.equal(relayPriceWei({ wei: relayGas(inCatalog, 300_000n, 50_000n).gas * gasPrice, value: 0n }), withMargin(350_000n * gasPrice));
  assert.equal(relayPriceWei({ wei: relayGas(outside, 300_000n, 50_000n).gas * gasPrice, value: 0n }), withMargin((350_000n + BigInt(VAULT_ERC4626_MIN_GAS)) * gasPrice));
  // What the transaction reserves (and its gas limit cap keeps) is the same for both: the floor is never dropped from it.
  assert.equal(reservedSwapGas(inCatalog), reservedSwapGas(outside));
  // Several calls: each catalog spend's floor apart, every other floor priced.
  const mixed = relayTransaction([spend(VAULT_ACTION.EXIT, exit(VENUE_KIND.RAETO_USDG, RAETO_USDG_VAULT)), spend(VAULT_ACTION.LEND, lendParams({ vault: STEAKHOUSE_USDG, assets: 1n, minShares: 0n })), spend(VAULT_ACTION.ENTER, spark)]);
  assert.equal(unpricedFloorGas(mixed), BigInt(VAULT_RAETO_USDG_MIN_GAS + VAULT_ERC4626_MIN_GAS));
  assert.deepEqual(relayGas(mixed, 1_000n, 0n), { gas: 1_000n + BigInt(VAULT_MORPHO_MIN_GAS), unpricedGas: BigInt(VAULT_RAETO_USDG_MIN_GAS + VAULT_ERC4626_MIN_GAS) });
  assert.equal(unpricedFloorGas({ to: at(3), data: "0xabcdef01" }), 0n);
  // With an escrow execution in the transaction (sent at its cap, its swap given all the gas left) every floor is
  // priced, a catalog venue spend's too.
  const withEscrow = relayTransaction([spend(VAULT_ACTION.EXIT, exit(VENUE_KIND.RAETO_USDG, RAETO_USDG_VAULT)), { to: at(7), data: concat([EXECUTE_ESCROW_SELECTOR, "0x00"]) }]);
  assert.equal(unpricedFloorGas(withEscrow), 0n);
  assert.deepEqual(relayGas(withEscrow, 1_000n, 0n), { gas: 1_000n + BigInt(VAULT_RAETO_USDG_MIN_GAS), unpricedGas: 0n });
});

test("escrow executions: counted by selector in a relay transaction, and their swaps read from EscrowExecuted", () => {
  const exec = { to: at(7), data: concat([EXECUTE_ESCROW_SELECTOR, "0x00"]) };
  const other = { to: at(8), data: "0xabcdef01" as Hex };
  assert.equal(escrowCalls(relayTransaction([exec])), 1);
  assert.equal(escrowCalls(relayTransaction([other, exec, exec])), 2);
  assert.equal(escrowCalls(relayTransaction([other])), 0);
  assert.equal(ESCROW_EXECUTED_TOPIC, encodeEventTopics({ abi: [{ type: "event", name: "EscrowExecuted", inputs: [{ name: "orderHash", type: "bytes32", indexed: true }, { name: "escrow", type: "address", indexed: true }, { name: "received", type: "uint256", indexed: false }, { name: "swapped", type: "bool", indexed: false }] }] as const, eventName: "EscrowExecuted" })[0]);
  const executed = (swapped: boolean, address = at(7)) => ({ address, topics: [ESCROW_EXECUTED_TOPIC, `0x${"11".repeat(32)}`, `0x${"00".repeat(12)}${"22".repeat(20)}`], data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [10n, swapped]) }) as unknown as Log;
  assert.equal(escrowSwaps([executed(true), executed(false), executed(true)], [at(7)]), 2);
  assert.equal(escrowSwaps([{ ...executed(true), topics: [`0x${"33".repeat(32)}`] } as unknown as Log], [at(7)]), 0);
  // Only the router's own logs count: another contract in the swap cannot claim one.
  assert.equal(escrowSwaps([executed(true, at(9))], [at(7)]), 0);
});
