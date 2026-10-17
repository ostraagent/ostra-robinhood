// The relayer's price inputs on a fork of Robinhood Chain mainnet: the live
// Chainlink ETH/USD feed read and checked for freshness by chain time, and a
// transaction measured with eth_estimateGas (a reverting one refused).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { encodeFunctionData } from "viem";
import { USDG } from "../src/constants.ts";
import { usdgAbi } from "../src/external-abi.ts";
import { RelaySimulationError, chainlinkEthUsd, estimateRelay, weiToTokenUnits, withMargin } from "../src/relayer.ts";
import { startFork, type Fork } from "./fork.ts";

let fork: Fork;
before(async () => {
  fork = await startFork();
});
after(async () => {
  await fork?.stop();
});

test("Chainlink ETH/USD reads positive and fresh by the chain's latest block time", async () => {
  const p = await chainlinkEthUsd(fork.client)();
  assert.ok(p.answer > 0n);
  const now = (await fork.client.getBlock()).timestamp;
  assert.ok(now - p.updatedAt <= 90_000n, `answer ${now - p.updatedAt} s old`);
  // Ten years on, the same answer is refused.
  await fork.increaseTime(10 * 365 * 86_400);
  await assert.rejects(chainlinkEthUsd(fork.client)(), /ETH\/USD answer is .* s old/);
});

test("a relayed transaction is measured with eth_estimateGas; one that reverts is refused", async () => {
  const relayer = fork.accounts[3]!.address;
  await fork.dealUsdg(relayer, 1_000_000n);
  const ok = await estimateRelay(fork.client, { relayer, to: USDG, data: encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [fork.accounts[2]!.address, 1n] }) });
  assert.ok(ok.gas > 21_000n && ok.gasPrice > 0n && ok.wei === ok.gas * ok.gasPrice);
  const price = { answer: 400_000_000_000n, roundId: 1n, updatedAt: 0n };
  assert.ok(weiToTokenUnits(withMargin(ok.wei), price, 6) >= 1n);
  await assert.rejects(
    estimateRelay(fork.client, { relayer, to: USDG, data: encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [fork.accounts[2]!.address, 10n ** 12n] }) }),
    (err: unknown) => err instanceof RelaySimulationError && err.code === "simulation_failed",
  );
});
