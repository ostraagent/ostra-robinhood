// The relayer's sender on a fork of Robinhood Chain mainnet: a transaction
// that lands, one that reverts at simulation (not sent, nothing spent), one
// the node refuses (no ETH for the gas: not sent), and one without a receipt
// (anvil holding it in its pool with automine off): it is replaced by a
// zero-value transfer at the same nonce, which proves it never lands. A
// transaction whose vault Swap fails now (SwapFailed) is not sent when the
// gate asks the sender to refuse it, and none is sent with more gas than the
// gate's cap: code that burns all the gas it gets when sent burns no more.
// A send the RPC answers with a JSON-RPC error (through an RPC in front of
// the fork) counts as refused only once the chain agrees: one the node took
// all the same lands and is reported as landed, also when it is mined only
// later; one signed at a nonce another transaction holds (a node behind) is
// not sent; when the reads of that check fail, the replacement proof decides.
// What it says never holds the RPC URL, which may carry an API key, also
// when the replacement proof decides.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { concat, createPublicClient, encodeFunctionData, getAddress, http, keccak256, numberToHex, stringToHex, toEventSelector, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDG, failedSwaps, ostraVaultAbi, retryingHttp, robinhoodChain, usdgAbi } from "@ostraagent/sdk";
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
  sender = new RelaySender(fork.client, http(fork.url), account, { receiptTimeoutMs: 2_000, settleTimeoutMs: 20_000, refusalCheckMs: 3_000 });
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

type Hook = (request: { id?: unknown; method?: string; params?: unknown[] }, answer: string) => { status: number; body: string } | null;

/**
 * An RPC in front of the fork: `stop` may answer a request without passing it on; every other request is passed on,
 * then `hook` may replace the answer the sender gets.
 */
async function front(hook: Hook, path = "", stop: (request: { id?: unknown; method?: string }) => { status: number; body: string } | null = () => null): Promise<{ sender: RelaySender; events: { event: string; fields?: Record<string, unknown> }[]; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      void (async () => {
        const request = JSON.parse(body) as { id?: unknown; method?: string; params?: unknown[] };
        const stopped = stop(request);
        if (stopped !== null) {
          res.writeHead(stopped.status, { "content-type": "application/json" });
          res.end(stopped.body);
          return;
        }
        const answer = await fetch(fork.url, { method: "POST", headers: { "content-type": "application/json" }, body });
        const text = await answer.text();
        const other = hook(request, text);
        res.writeHead(other?.status ?? answer.status, { "content-type": "application/json" });
        res.end(other?.body ?? text);
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const transport = retryingHttp(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
  const events: { event: string; fields?: Record<string, unknown> }[] = [];
  const flaky = new RelaySender(client, transport, account, { receiptTimeoutMs: 2_000, settleTimeoutMs: 20_000, refusalCheckMs: 5_000, log: (event, fields) => events.push({ event, ...(fields === undefined ? {} : { fields }) }) });
  return {
    sender: flaky,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The answer an RPC provider can give to a send it passed on: a JSON-RPC error. */
const sendError = (id: unknown) => ({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "the upstream did not answer in time" } }) });

test("a send the RPC answers with an error after passing it on to the node lands, and is reported as landed", async () => {
  let sends = 0;
  const f = await front((r) => (r.method === "eth_sendRawTransaction" && sends++ === 0 ? sendError(r.id) : null));
  try {
    const nonce = await fork.client.getTransactionCount({ address: account.address });
    const landed = await f.sender.send(transfer(1n));
    assert.equal((await fork.client.getTransactionReceipt({ hash: landed.txHash })).status, "success");
    assert.equal(await fork.client.getTransactionCount({ address: account.address }), nonce + 1);
    assert.equal(sends, 1);
    assert.deepEqual(f.events.map((e) => [e.event, e.fields?.seen]), [["send_answered_error", "landed"]]);
  } finally {
    await f.close();
  }
});

test("one the node takes but mines only seconds later lands too", async () => {
  let sends = 0;
  const f = await front((r) => (r.method === "eth_sendRawTransaction" && sends++ === 0 ? sendError(r.id) : null));
  await rpc("evm_setAutomine", [false]);
  try {
    const nonce = await fork.client.getTransactionCount({ address: account.address });
    const sending = f.sender.send(transfer(1n));
    // Mined once the node holds it, two seconds after it was sent.
    const deadline = Date.now() + 15_000;
    while (sends === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 2_000));
    await rpc("evm_mine", []);
    const landed = await sending;
    assert.equal((await fork.client.getTransactionReceipt({ hash: landed.txHash })).status, "success");
    assert.equal(await fork.client.getTransactionCount({ address: account.address }), nonce + 1);
  } finally {
    await rpc("evm_setAutomine", [true]);
    await f.close();
  }
});

test("one signed at a nonce another transaction holds (a node behind) is not sent", async () => {
  // The first pending nonce the sender reads is one behind, as from a node that lags: the node refuses the send.
  // (A nonce behind needs one used: a transfer first when this test runs alone.)
  if ((await fork.client.getTransactionCount({ address: account.address })) === 0) await sender.send(transfer(1n));
  let lag = true;
  const f = await front((r, answer) => {
    if (r.method !== "eth_getTransactionCount" || r.params?.[1] !== "pending" || !lag) return null;
    lag = false;
    const n = BigInt((JSON.parse(answer) as { result: string }).result);
    return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: r.id, result: `0x${(n - 1n).toString(16)}` }) };
  });
  try {
    const nonce = await fork.client.getTransactionCount({ address: account.address });
    await assert.rejects(f.sender.send(transfer(1n)), (err: unknown) => err instanceof NotSentError && /is used by another transaction/.test(err.message));
    assert.equal(await fork.client.getTransactionCount({ address: account.address }), nonce);
  } finally {
    await f.close();
  }
});

test("when the reads of the check fail, the replacement proof decides: one the node took lands", async () => {
  // After the send (answered with an error, though the node took it), receipts and nonces fail for 12 seconds:
  // longer than the check (5 s), shorter than the replacement proof (20 s).
  let failUntil = 0;
  const f = await front((r) => {
    if (r.method === "eth_sendRawTransaction" && failUntil === 0) {
      failUntil = Date.now() + 12_000;
      return sendError(r.id);
    }
    if ((r.method === "eth_getTransactionReceipt" || r.method === "eth_getTransactionCount") && Date.now() < failUntil) return { status: 503, body: "{}" };
    return null;
  });
  try {
    const nonce = await fork.client.getTransactionCount({ address: account.address });
    const landed = await f.sender.send(transfer(1n));
    assert.equal((await fork.client.getTransactionReceipt({ hash: landed.txHash })).status, "success");
    assert.equal(await fork.client.getTransactionCount({ address: account.address }), nonce + 1);
    assert.deepEqual(f.events.map((e) => [e.event, e.fields?.seen]), [["send_answered_error", "unknown"]]);
  } finally {
    await f.close();
  }
});

test("what a refusal says holds no RPC URL (it may carry an API key)", async () => {
  const f = await front(() => null, "/v2/OSTRA-TEST-SECRET-KEY");
  // USDG for the transfer (the tests before spent it), and no ETH for its gas: the node refuses it.
  await fork.dealUsdg(account.address, 5n);
  await fork.setBalance(account.address, 1n);
  try {
    await assert.rejects(f.sender.send(transfer(1n)), (err: unknown) => err instanceof NotSentError && /the node refused/.test(err.message) && !err.message.includes("OSTRA-TEST-SECRET-KEY") && !err.message.includes("127.0.0.1"));
    assert.deepEqual(f.events.map((e) => [e.event, e.fields?.seen]), [["send_answered_error", "refused"]]);
    assert.ok(!JSON.stringify(f.events).includes("OSTRA-TEST-SECRET-KEY"));
  } finally {
    await fork.setBalance(account.address, 10n ** 17n);
    await f.close();
  }
});

test("nor does a refusal the chain could not confirm, proven by its replacement", async () => {
  // The send is answered with an error and not passed on (refused), and receipts and nonces fail for 12 seconds:
  // the check cannot tell, so the replacement proves it (it lands at the nonce).
  let failUntil = 0;
  const f = await front(
    (r) => ((r.method === "eth_getTransactionReceipt" || r.method === "eth_getTransactionCount") && Date.now() < failUntil ? { status: 503, body: "{}" } : null),
    "/v2/OSTRA-TEST-SECRET-KEY",
    (r) => {
      if (r.method !== "eth_sendRawTransaction" || failUntil !== 0) return null;
      failUntil = Date.now() + 12_000;
      return sendError(r.id);
    },
  );
  try {
    const nonce = await fork.client.getTransactionCount({ address: account.address });
    await assert.rejects(
      f.sender.send(transfer(1n)),
      (err: unknown) => err instanceof NotSentError && /was replaced at nonce/.test(err.message) && /answered the send with an error/.test(err.message) && !err.message.includes("OSTRA-TEST-SECRET-KEY") && !err.message.includes("127.0.0.1"),
    );
    assert.equal(await fork.client.getTransactionCount({ address: account.address }), nonce + 1);
    assert.deepEqual(f.events.map((e) => [e.event, e.fields?.seen]), [["send_answered_error", "unknown"]]);
    assert.ok(!JSON.stringify(f.events).includes("OSTRA-TEST-SECRET-KEY"));
  } finally {
    await f.close();
  }
});
