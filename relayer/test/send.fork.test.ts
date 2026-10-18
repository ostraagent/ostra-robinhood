// The relayer's sender on a fork of Robinhood Chain mainnet: a transaction
// that lands, one that reverts at simulation (not sent, nothing spent), one
// the node refuses (no ETH for the gas: not sent), and one without a receipt
// (anvil holding it in its pool with automine off): it is replaced by a
// zero-value transfer at the same nonce, which proves it never lands. A
// transaction whose vault Swap fails now (SwapFailed) is not sent when the
// gate asks the sender to refuse it, and none is sent with more gas than the
// gate's cap: code that burns all the gas it gets when sent burns no more.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { concat, encodeFunctionData, getAddress, http, keccak256, numberToHex, stringToHex, toEventSelector, type Hex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDG, failedSwaps, ostraVaultAbi, usdgAbi } from "@ostraagent/sdk";
import { startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { NotSentError, RelaySender } from "../src/send.ts";

let fork: Fork;
let account: PrivateKeyAccount;
let sender: RelaySender;

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(fork.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** Waits until anvil's pool holds, at `nonce`, the sender's replacement: a transfer from the account to itself. */
async function replacementPending(nonce: number): Promise<void> {
  const self = account.address.toLowerCase();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const pool = (await rpc("txpool_content", [])) as { pending?: Record<string, Record<string, { to?: string | null; nonce: string }>> };
    const mine = Object.entries(pool.pending ?? {}).find(([from]) => from.toLowerCase() === self)?.[1] ?? {};
    if (Object.values(mine).some((tx) => Number(tx.nonce) === nonce && tx.to?.toLowerCase() === self)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the replacement at nonce ${nonce} did not reach anvil's pool`);
}

const transfer = (amount: bigint) => ({ to: USDG, data: encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [fork.accounts[2]!.address, amount] }) });

before(async () => {
  fork = await startFork();
  // A fresh key: anvil's development accounts are EIP-7702-delegated on Robinhood Chain mainnet.
  account = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/RELAYER-SEND-TEST/account")));
  await fork.setBalance(account.address, 10n ** 17n);
  await fork.dealUsdg(account.address, 5n);
  sender = new RelaySender(fork.client, http(fork.url), account, { receiptTimeoutMs: 2_000, settleTimeoutMs: 20_000 });
});
after(async () => {
  await fork?.stop();
});

test("a transaction lands: its hash, gas used and price", async () => {
  const landed = await sender.send(transfer(1n));
  const receipt = await fork.client.getTransactionReceipt({ hash: landed.txHash });
  assert.equal(receipt.status, "success");
  assert.equal(landed.gasUsed, receipt.gasUsed);
  assert.equal(landed.effectiveGasPrice, receipt.effectiveGasPrice);
});

test("a transaction that reverts now is not sent and costs nothing", async () => {
  const nonce = await fork.client.getTransactionCount({ address: account.address });
  const eth = await fork.client.getBalance({ address: account.address });
  await assert.rejects(sender.send(transfer(1_000n)), (err: unknown) => err instanceof NotSentError && err.txHash === null && /reverts now/.test(err.message));
  assert.equal(await fork.client.getTransactionCount({ address: account.address }), nonce);
  assert.equal(await fork.client.getBalance({ address: account.address }), eth);
});

test("a transaction the node refuses is not sent", async () => {
  await fork.setBalance(account.address, 1n);
  try {
    await assert.rejects(sender.send(transfer(1n)), (err: unknown) => err instanceof NotSentError && /the node refused/.test(err.message));
  } finally {
    await fork.setBalance(account.address, 10n ** 17n);
  }
});

test("without a receipt, the transaction is replaced at its nonce: not sent", async () => {
  const nonce = await fork.client.getTransactionCount({ address: account.address });
  await rpc("evm_setAutomine", [false]);
  try {
    const sending = sender.send(transfer(1n));
    // Mine only once the replacement (a zero-value transfer to itself) holds the nonce in anvil's pool: a fixed wait
    // would mine the original under load.
    await replacementPending(nonce);
    await rpc("evm_mine", []);
    await assert.rejects(sending, (err: unknown) => err instanceof NotSentError && /was replaced at nonce/.test(err.message));
  } finally {
    await rpc("evm_setAutomine", [true]);
  }
  assert.equal(await fork.client.getTransactionCount({ address: account.address }), nonce + 1);
  assert.equal(await fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [account.address] }), 4n);
});

test("a transaction whose vault Swap fails now is not sent when the sender is asked to refuse it", async () => {
  // A stand-in for a vault whose Swap soft-fails: any call to it emits OstraVault's SwapFailed(poolId, reason).
  const vault = getAddress("0x00000000000000000000000000000000057a1ed0");
  const poolId = keccak256("0x01");
  const topic = toEventSelector(ostraVaultAbi.find((x) => x.type === "event" && x.name === "SwapFailed") as Parameters<typeof toEventSelector>[0]);
  const code = concat(["0x63356680b760e01b600052", "0x7f", poolId, "0x7f", topic, "0x60206000a200"]) as Hex;
  await rpc("anvil_setCode", [vault, code]);
  const nonce = await fork.client.getTransactionCount({ address: account.address });
  await assert.rejects(sender.send({ to: vault, data: "0x" }, { refuseFailedSwaps: [vault] }), (err: unknown) => err instanceof NotSentError && err.txHash === null && /fails now, so it was not sent/.test(err.message));
  assert.equal(await fork.client.getTransactionCount({ address: account.address }), nonce);
  // Another vault's refusal does not apply; without one the failing Swap is sent (allowFailedSwaps).
  const other = await sender.send({ to: vault, data: "0x" }, { refuseFailedSwaps: [getAddress(numberToHex(1n, { size: 20 }))] });
  const receipt = await fork.client.getTransactionReceipt({ hash: other.txHash });
  assert.deepEqual(failedSwaps(receipt.logs, [vault]), [{ vault, poolId, reason: "0x356680b7" }]);
  await sender.send({ to: vault, data: "0x" });
});

test("the gas limit is at most the gate's cap: one that needs more now is not sent; code that burns what it gets burns no more", async () => {
  const nonce = await fork.client.getTransactionCount({ address: account.address });
  const t = transfer(1n);
  const gas = await fork.client.estimateGas({ account: account.address, ...t, value: 0n });
  await assert.rejects(sender.send(t, { maxGas: gas - 1n }), (err: unknown) => err instanceof NotSentError && err.txHash === null && /more than the .* it was priced for/.test(err.message));
  assert.equal(await fork.client.getTransactionCount({ address: account.address }), nonce);
  const capped = await sender.send(t, { maxGas: gas + 1n });
  assert.equal((await fork.client.getTransaction({ hash: capped.txHash })).gas, gas + 1n);
  // Burns gas until 5,000 is left whenever the gas price is not zero (as when sent, not as when simulated).
  const burner = getAddress("0x000000000000000000000000000000000b0a9e75");
  await rpc("anvil_setCode", [burner, "0x5b3a156011575a611388116011576000565b00"]);
  const burnt = await sender.send({ to: burner, data: "0x" }, { maxGas: 100_000n });
  const tx = await fork.client.getTransaction({ hash: burnt.txHash });
  assert.ok(tx.gas <= 100_000n && burnt.gasUsed <= tx.gas && burnt.gasUsed > tx.gas - 5_100n, `limit ${tx.gas}, used ${burnt.gasUsed}`);
});
