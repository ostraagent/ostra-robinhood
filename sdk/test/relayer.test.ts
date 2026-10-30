// Relay requests and their price (relayer.ts): the rules the relayer charges
// by and an agent checks a quote with. Chainlink itself is read in
// relayer.fork.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { concat, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, hexToBytes, keccak256, zeroAddress, type Hex, type Log } from "viem";
import { ostraVaultAbi } from "../src/abi.ts";
import { MULTICALL3, USDG, VAULT_ACTION, VAULT_SWAP_GAS, VAULT_SWAP_GAS_RESERVE } from "../src/constants.ts";
import { swapParams, transferParams } from "../src/messages.ts";
import { multicall3Abi } from "../src/external-abi.ts";
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
  reservedSwapGas,
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
