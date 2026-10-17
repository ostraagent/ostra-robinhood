// The chain facts in src/constants.ts and the external ABIs, checked against
// the deployed contracts on a fork of Robinhood Chain mainnet.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { domainSeparator, type Address } from "viem";
import { x402BatchSettlementAbi } from "../src/abi.ts";
import { assertRobinhoodChain } from "../src/chain.ts";
import {
  CHAINLINK_ETH_USD,
  CHAINLINK_ETH_USD_DECIMALS,
  ERC8004_IDENTITY_REGISTRY,
  ERC8004_REPUTATION_REGISTRY,
  MULTICALL3,
  ROBINHOOD_CHAIN_ID,
  USDG,
  USDG_DECIMALS,
  USDG_EIP712_DOMAIN,
  X402_BATCH_SETTLEMENT,
  X402_ERC3009_DEPOSIT_COLLECTOR,
  X402_MAX_WITHDRAW_DELAY,
  X402_MIN_WITHDRAW_DELAY,
  X402_PERMIT2_DEPOSIT_COLLECTOR,
} from "../src/constants.ts";
import { chainlinkAggregatorAbi, multicall3Abi, usdgAbi } from "../src/external-abi.ts";
import { startFork, type Fork } from "./fork.ts";

let fork: Fork;
before(async () => {
  fork = await startFork();
});
after(async () => {
  await fork?.stop();
});

test("the fork is Robinhood Chain and every contract the SDK names has code", async () => {
  await assertRobinhoodChain(fork.client);
  assert.equal(await fork.client.getChainId(), ROBINHOOD_CHAIN_ID);
  const named: Record<string, Address> = {
    USDG,
    X402_BATCH_SETTLEMENT,
    X402_ERC3009_DEPOSIT_COLLECTOR,
    X402_PERMIT2_DEPOSIT_COLLECTOR,
    CHAINLINK_ETH_USD,
    ERC8004_IDENTITY_REGISTRY,
    ERC8004_REPUTATION_REGISTRY,
    MULTICALL3,
  };
  for (const [name, address] of Object.entries(named)) {
    const code = await fork.client.getCode({ address });
    assert.ok(code !== undefined && code.length > 2, `${name} has no code`);
  }
});

test("USDG: 6 decimals, its EIP-712 domain, EIP-3009 state and the freeze check", async () => {
  const read = (functionName: "name" | "symbol" | "decimals" | "DOMAIN_SEPARATOR") => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName });
  assert.equal(await read("name"), "Global Dollar");
  assert.equal(await read("symbol"), "USDG");
  assert.equal(await read("decimals"), USDG_DECIMALS);
  assert.equal(await read("DOMAIN_SEPARATOR"), domainSeparator({ domain: USDG_EIP712_DOMAIN }));
  const someone: Address = "0x000000000000000000000000000000000000dEaD";
  assert.equal(await fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "authorizationState", args: [someone, `0x${"00".repeat(31)}01`] }), false);
  assert.equal(await fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "isFrozen", args: [someone] }), false);
});

test("x402BatchSettlement: withdraw delay bounds", async () => {
  assert.equal(await fork.client.readContract({ address: X402_BATCH_SETTLEMENT, abi: x402BatchSettlementAbi, functionName: "MIN_WITHDRAW_DELAY" }), X402_MIN_WITHDRAW_DELAY);
  assert.equal(await fork.client.readContract({ address: X402_BATCH_SETTLEMENT, abi: x402BatchSettlementAbi, functionName: "MAX_WITHDRAW_DELAY" }), X402_MAX_WITHDRAW_DELAY);
});

test("Chainlink ETH/USD: 8 decimals and a positive answer", async () => {
  assert.equal(await fork.client.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAggregatorAbi, functionName: "decimals" }), CHAINLINK_ETH_USD_DECIMALS);
  assert.equal(await fork.client.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAggregatorAbi, functionName: "description" }), "ETH / USD");
  const [, answer, , updatedAt] = await fork.client.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" });
  assert.ok(answer > 0n);
  assert.ok(updatedAt > 0n);
});

test("Multicall3 aggregate3 runs calls in one transaction", async () => {
  const { result } = await fork.client.simulateContract({
    address: MULTICALL3,
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [[{ target: USDG, allowFailure: false, callData: "0x313ce567" }]],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.success, true);
  assert.equal(BigInt(result[0]!.returnData), 6n);
});
