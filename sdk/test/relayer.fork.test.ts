// The relayer's price inputs on a fork of Robinhood Chain mainnet: the live
// Chainlink ETH/USD feed read and checked for freshness by chain time, a
// transaction measured by simulation (eth_simulateV1) to exactly the gas its
// receipt shows (a reverting one refused), and the L1 data component read
// from the live chain's NodeInterface (anvil has none; the component is 0
// while the chain's L1 price estimate is 0).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { redact, robinhoodClient } from "../src/chain.ts";
import { ARBITRUM_NODE_INTERFACE, ROBINHOOD_PUBLIC_RPC, USDG } from "../src/constants.ts";
import { nodeInterfaceAbi, usdgAbi } from "../src/external-abi.ts";
import { RelaySimulationError, chainlinkEthUsd, estimateRelay, l1DataGas, weiToTokenUnits, withMargin } from "../src/relayer.ts";
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

test("a relayed transaction is measured by simulation, to the gas its receipt shows; one that reverts is refused", async () => {
  const sender = fork.accounts[3]!;
  await fork.dealUsdg(sender.address, 1_000_000n);
  await fork.setBalance(sender.address, 10n ** 18n);
  const data = encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [fork.accounts[2]!.address, 1n] });
  const ok = await estimateRelay(fork.client, { relayer: sender.address, to: USDG, data });
  assert.ok(ok.gas > 21_000n && ok.gasPrice > 0n && ok.wei === ok.gas * ok.gasPrice);
  assert.ok(ok.logs.length === 1, "the simulated transfer's Transfer log");
  // anvil has no NodeInterface: no L1 data component on the fork.
  assert.equal(await l1DataGas(fork.client, USDG, data), 0n);
  const hash = await fork.wallet(sender).sendTransaction({ account: sender, chain: fork.client.chain, to: USDG, data });
  const receipt = await fork.client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  assert.equal(ok.gas, receipt.gasUsed);
  const price = { answer: 400_000_000_000n, roundId: 1n, updatedAt: 0n };
  assert.ok(weiToTokenUnits(withMargin(ok.wei), price, 6) >= 1n);
  await assert.rejects(
    estimateRelay(fork.client, { relayer: sender.address, to: USDG, data: encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [fork.accounts[2]!.address, 10n ** 12n] }) }),
    (err: unknown) => err instanceof RelaySimulationError && err.code === "simulation_failed" && /reverts/.test(err.message),
  );
});

test("the L1 data component is the live chain's NodeInterface estimate, which grows with the data while L1 is priced", async () => {
  // The live chain the fork is made from (OSTRA_FORK_RPC, default the public RPC): read only.
  const url = process.env.OSTRA_FORK_RPC !== undefined && process.env.OSTRA_FORK_RPC !== "" ? process.env.OSTRA_FORK_RPC : ROBINHOOD_PUBLIC_RPC;
  const live = robinhoodClient(url);
  // Its errors carry the URL, which may hold an API key: redacted.
  const safe = <T>(p: Promise<T>) =>
    p.catch((err: unknown) => {
      throw new Error(redact(err instanceof Error ? err.message : String(err), url));
    });
  const small = encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [fork.accounts[2]!.address, 1n] });
  const large = `0x${"5a".repeat(2_000)}` as const;
  const raw = async (data: `0x${string}`) => {
    const res = await safe(live.call({ to: ARBITRUM_NODE_INTERFACE, data: encodeFunctionData({ abi: nodeInterfaceAbi, functionName: "gasEstimateL1Component", args: [USDG, false, data] }) }));
    // The live chain has the NodeInterface: it answers (an empty answer is read as 0 only on a fork without it).
    assert.ok(res.data !== undefined && res.data !== "0x");
    return decodeFunctionResult({ abi: nodeInterfaceAbi, functionName: "gasEstimateL1Component", data: res.data });
  };
  const [smallL1, , l1BaseFee] = await raw(small);
  const [largeL1] = await raw(large);
  const [smallGas, largeGas] = [await safe(l1DataGas(live, USDG, small)), await safe(l1DataGas(live, USDG, large))];
  // Read again a moment later: the estimate moves with the L1 price, so the two reads are compared loosely.
  assert.ok(smallGas <= smallL1 * 2n + 10n && smallL1 <= smallGas * 2n + 10n, `${smallGas} vs ${smallL1}`);
  if (l1BaseFee > 0n) assert.ok(largeL1 > smallL1 && largeGas > smallGas, `L1 priced at ${l1BaseFee}: ${largeL1} <= ${smallL1}`);
  else assert.ok(smallL1 === 0n && largeL1 === 0n, "with no L1 price the component is 0");
});
