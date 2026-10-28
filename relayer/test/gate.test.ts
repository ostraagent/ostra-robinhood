// The channel an x402 payment header pays from: only read to choose whose
// credit applies (the scheme verifies the payment itself).

import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress } from "viem";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { relayGasCap } from "@ostraagent/sdk";
import { paymentChannel, sendGasCap } from "../src/gate.ts";

const payer = getAddress("0x00000000000000000000000000000000000aa001");
const receiverAuthorizer = getAddress("0x00000000000000000000000000000000000ee001");
const header = (inner: unknown) => encodePaymentSignatureHeader({ x402Version: 2, accepted: {}, payload: inner } as unknown as PaymentPayload);

test("no PAYMENT-SIGNATURE header: undefined (the 402 follows)", () => {
  assert.equal(paymentChannel(undefined), undefined);
  assert.equal(paymentChannel(""), undefined);
});

test("a voucher or deposit payload: its channel's payer and receiverAuthorizer", () => {
  const config = { payer: payer.toLowerCase(), payerAuthorizer: payer, receiver: payer, receiverAuthorizer: receiverAuthorizer.toLowerCase(), token: payer, withdrawDelay: 900, salt: `0x${"00".repeat(32)}` };
  assert.deepEqual(paymentChannel(header({ type: "voucher", channelConfig: config, voucher: {} })), { payer, receiverAuthorizer });
  assert.deepEqual(paymentChannel(header({ type: "deposit", channelConfig: config, voucher: {}, deposit: {} })), { payer, receiverAuthorizer });
});

test("a payload without a channel, or an unreadable header: null", () => {
  assert.equal(paymentChannel(header({ type: "exact" })), null);
  assert.equal(paymentChannel(header({ channelConfig: { payer: "nope", receiverAuthorizer } })), null);
  assert.equal(paymentChannel("!!!not-base64-json"), null);
});

test("Ostra Swap: an escrow order naming the relayer's account as executor or canceller is refused; the router's wallet swaps are refused", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { encodeFunctionData, zeroAddress } = await import("viem");
  const { ostraRouterAbi } = await import("@ostraagent/swap");
  const { parseDeployment } = await import("@ostraagent/sdk");
  const { Ledger } = await import("../src/ledger.ts");
  const { RelayerGate } = await import("../src/gate.ts");
  const dir = await mkdtemp(join(tmpdir(), "ostra-gate-swap-"));
  try {
    const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
    const deployment = parseDeployment({
      version: 1,
      chainId: 4663,
      token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      batchSettlement: "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003",
      vaultImplementation: at(1),
      vaultBeacon: at(2),
      vaultFactory: at(3),
      poolImplementation: at(4),
      poolBeacon: at(5),
      pool: at(6),
      splitFactory: at(7),
      beaconOwner: at(8),
      fromBlock: "1",
    });
    const router = at(0xc0);
    const relayer = at(0xee);
    const ledger = await Ledger.open(dir);
    // The policy decides before anything is read from the chain or paid: nothing else of the gate is reached.
    const gate = new RelayerGate({ deployment, ledger, merchant: { token: deployment.token }, sender: { address: relayer }, swap: { router } } as never);
    const order = { tokenIn: deployment.token, tokenOut: at(0xa1), amountIn: 1n, minOut: 1n, recipient: at(0xa2), refundTo: at(0xa2), notBefore: 0n, deadline: 2_000_000_000n, tranches: 0, interval: 0, executor: zeroAddress, canceller: zeroAddress, route: `0x${"11".repeat(32)}` as const, salt: `0x${"22".repeat(32)}` as const };
    const body = (data: string, to: string) => JSON.stringify({ calls: [{ to, data }] });
    const ask = async (data: string, to: string = router) => (await gate.relay({ body: body(data, to), req: { headers: {} } as never, ip: "127.0.0.1" })) as { status: number; body: { error: string; message: string } };
    for (const o of [{ ...order, executor: relayer }, { ...order, canceller: relayer }]) {
      const a = await ask(encodeFunctionData({ abi: ostraRouterAbi, functionName: "announce", args: [o] }));
      assert.equal(a.status, 422);
      assert.match(a.body.message, /executor or canceller/);
    }
    // A vault's shield is relayed only on the configured private pool (none here).
    const { ostraPrivatePoolAbi } = await import("@ostraagent/swap");
    const pool = at(0xc4);
    const shield = await ask(encodeFunctionData({ abi: ostraPrivatePoolAbi, functionName: "shieldFromEscrow", args: [deployment.token, `0x${"07".repeat(32)}`] }), pool);
    assert.equal(shield.status, 422);
    assert.equal(shield.body.message, `calls[0]: shieldFromEscrow on ${pool} is not relayed`);
    const swap = await ask(encodeFunctionData({ abi: ostraRouterAbi, functionName: "swap", args: [order.tokenIn, order.tokenOut, 1n, 1n, at(0xa2), order.tokenIn, { commands: "0x", inputs: [] }, { commands: "0x", inputs: [] }] }));
    assert.equal(swap.status, 422);
    assert.match(swap.body.message, /not relayed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OstraBreaker: configure and trip are relayed only on the deployment's breaker", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { encodeFunctionData } = await import("viem");
  const { ostraBreakerAbi, parseDeployment } = await import("@ostraagent/sdk");
  const { Ledger } = await import("../src/ledger.ts");
  const { RelayerGate } = await import("../src/gate.ts");
  const dir = await mkdtemp(join(tmpdir(), "ostra-gate-breaker-"));
  try {
    const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
    const base = {
      version: 1,
      chainId: 4663,
      token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      batchSettlement: "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003",
      vaultImplementation: at(1),
      vaultBeacon: at(2),
      vaultFactory: at(3),
      poolImplementation: at(4),
      poolBeacon: at(5),
      pool: at(6),
      splitFactory: at(7),
      beaconOwner: at(8),
      fromBlock: "1",
    };
    const breaker = at(0xb7);
    const limits = { priceDropBps: 10, assetsDropBps: 2_000, maxUtilizationBps: 9_900, minLiquidityBps: 20_000, assetsMarkCap: 1n };
    const configure = encodeFunctionData({ abi: ostraBreakerAbi, functionName: "configure", args: [at(0xa1), at(0xa2), limits] });
    const trip = encodeFunctionData({ abi: ostraBreakerAbi, functionName: "trip", args: [at(0xa1), at(0xa2)] });
    const ask = async (deployment: unknown, data: string, to: string) => {
      const gate = new RelayerGate({ deployment, ledger: await Ledger.open(dir), merchant: { token: base.token }, sender: { address: at(0xee) } } as never);
      return (await gate.relay({ body: JSON.stringify({ calls: [{ to, data }] }), req: { headers: {} } as never, ip: "127.0.0.1" })) as { status: number; body: { error: string; message: string } };
    };
    // Without a breaker in the record, and on another address than the record's: refused by the policy.
    const v2 = parseDeployment(base);
    for (const data of [configure, trip]) {
      const r = await ask(v2, data, breaker);
      assert.equal(r.status, 422);
      assert.match(r.body.message, /is not relayed: it is not this deployment's OstraBreaker/);
    }
    const v3 = { ...v2, vaultModule: at(9), breaker };
    for (const data of [configure, trip]) {
      const r = await ask(v3, data, at(0xb8));
      assert.equal(r.status, 422);
      assert.match(r.body.message, /it is not this deployment's OstraBreaker/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sendGasCap: the margin on the priced gas, or on the limit a refund needs when larger, up to 1.3 times the priced gas; escrows keep their priced cap", () => {
  const q = (gas: number, limit?: number) => ({ gas: String(gas), ...(limit === undefined ? {} : { limit: String(limit) }) });
  assert.equal(sendGasCap(q(100_000), false), relayGasCap(100_000n));
  assert.equal(sendGasCap(q(100_000, 90_000), false), relayGasCap(100_000n));
  assert.equal(sendGasCap(q(97_335, 110_124), false), relayGasCap(110_124n));
  assert.equal(sendGasCap(q(100_000, 500_000), false), relayGasCap(130_000n));
  assert.equal(sendGasCap(q(100_000, 120_000), true), relayGasCap(100_000n));
});
