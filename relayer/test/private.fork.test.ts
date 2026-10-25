// Private spends relayed for the fee their proof pays, and those fees sold for ETH, on a fork of Robinhood Chain
// mainnet (anvil, OSTRA_FORK_RPC or the public RPC) at the chain's own gas price: OstraRouter, SpendVerifier and
// OstraPrivatePool are deployed from the ostra-swap Foundry build, every proof is made by ostra-prove, prices come
// from Chainlink ETH/USD and the Uniswap pools on the fork. The relayer sends from a fresh account through its
// RelaySender. Needs ../../ostra-swap built (forge build; cd privacy && cargo build --release --locked --bin
// ostra-prove) and anvil on PATH.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, getAddress, http, keccak256, parseEther, parseUnits, stringToHex, type Address, type Hex, type PrivateKeyAccount, type PublicClient, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainlinkEthUsd, estimateRelay, relayGasCap, robinhoodChain } from "@ostraagent/sdk";
import {
  ETH,
  OSTRA,
  OSTRA_PONS_CURVE,
  PONS_HOOK,
  PRIVATE_SWAP_FEE_BPS,
  PoolIndex,
  PoolTrees,
  ROBINHOOD_PUBLIC_RPC,
  TREASURY,
  UNIVERSAL_ROUTER,
  USDG,
  WETH,
  changeNote,
  erc20Abi,
  executeEscrowData,
  findRoute,
  escrowAddress,
  orderFor,
  ostraRouterAbi,
  randomSalt,
  NO_LEG,
  newSecret,
  ostraPrivatePoolAbi,
  privateSwapCall,
  proveUnshield,
  provePrivateSwap,
  shieldCall,
  shieldedNote,
  swapOutputNote,
  tagOf,
  unshieldCall,
  walletSwapCall,
  type Digest,
  type PrivateNote,
  type Spend,
} from "@ostraagent/swap";
import { cliProver } from "@ostraagent/swap/cli-prover";
import { decodeRelayRequest } from "../src/calls.ts";
import { createRelayerServer } from "../src/http.ts";
import { Ledger } from "../src/ledger.ts";
import { MIN_DEADLINE_SECONDS, PRIVATE_RELAYS_PER_IP_HOUR, PrivateRelay } from "../src/private.ts";
import { RelayerGate, type GateOptions } from "../src/gate.ts";
import { RelaySender } from "../src/send.ts";
import { FeeSweeper } from "../src/sweep.ts";

const SWAP_DIR = new URL("../../../ostra-swap/", import.meta.url);
const NVDA: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const PORT = 8_747;
const FORK_URL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 4663;
/** anvil's default accounts: the deployer and the agent's funding wallet. */
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const AGENT = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a7c43dea1e1be8b3e3a");
const RECIPIENT = getAddress("0x00000000000000000000000000000000000D0D0E");
const OTHER_RELAYER = getAddress("0x00000000000000000000000000000000000D0D0F");

const prover = cliProver(fileURLToPath(new URL("privacy/target/release/ostra-prove", SWAP_DIR)));
let anvil: ChildProcess;
let client: PublicClient;
const logsClient = createPublicClient({ transport: http(ROBINHOOD_PUBLIC_RPC, { retryCount: 6, retryDelay: 2_000 }) }) as PublicClient;
const wallet = (account: PrivateKeyAccount) => createWalletClient({ account, transport: http(FORK_URL) });
const index = new PoolIndex();
let relayerAccount: PrivateKeyAccount;
let router: Address;
let stake: Address;
let pool: Address;
let trees: PoolTrees;
let sk: Digest;
let dataDir: string;
let ledger: Ledger;
let relay: PrivateRelay;
let sender: RelaySender;
const events: { event: string; fields: Record<string, unknown> }[] = [];
const log = (event: string, fields: Record<string, unknown> = {}) => {
  events.push({ event, fields });
};
const notes: PrivateNote[] = [];

function artifact(file: string, name: string): { abi: unknown[]; bytecode: Hex } {
  const a = JSON.parse(readFileSync(new URL(`out/${file}/${name}.json`, SWAP_DIR), "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
  return { abi: a.abi, bytecode: a.bytecode.object };
}

async function deploy(file: string, name: string, args: unknown[]): Promise<Address> {
  const a = artifact(file, name);
  const hash = await wallet(DEPLOYER).deployContract({ abi: a.abi, bytecode: a.bytecode, args, chain: null, gas: 15_000_000n });
  const r = await client.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success");
  assert.ok(r.contractAddress);
  return getAddress(r.contractAddress);
}

async function send(account: PrivateKeyAccount, call: { to: Address; data: Hex; value?: bigint }, gas = 3_000_000n): Promise<TransactionReceipt> {
  const hash = await wallet(account).sendTransaction({ ...call, chain: null, gas });
  const r = await client.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `transaction to ${call.to} reverted`);
  return r;
}

const balance = (token: Address, who: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const request = (call: { to: Address; data: Hex }) => decodeRelayRequest({ calls: [{ to: call.to, data: call.data }] });
const feeOf = async (token: Address, kind: "swap" | "unshield") => {
  const a = await relay.price(token, kind);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return BigInt((a.body as { fee: string }).fee);
};
const deadline = async () => (await client.getBlock()).timestamp + 3_600n;

before(async () => {
  const fork = process.env.OSTRA_FORK_RPC || ROBINHOOD_PUBLIC_RPC;
  // The fork keeps the chain's base fee; anvil adds its own suggested priority fee (1 gwei, where Robinhood Chain
  // suggests none), so the fees below are many times the chain's, and the agent's balance is sized for that.
  anvil = spawn("anvil", ["--fork-url", fork, "--port", String(PORT), "--gas-limit", "60000000"], { stdio: ["ignore", process.env.OSTRA_ANVIL_LOG ? "pipe" : "ignore", "pipe"] });
  let anvilErr = "";
  anvil.stderr?.on("data", (b: Buffer) => {
    anvilErr = (anvilErr + b.toString()).slice(-2_000);
  });
  // OSTRA_ANVIL_LOG: a file anvil's own log goes to, to see what a stuck fork waits for.
  if (process.env.OSTRA_ANVIL_LOG) anvil.stdout?.pipe(createWriteStream(process.env.OSTRA_ANVIL_LOG));
  const probe = createPublicClient({ transport: http(FORK_URL, { retryCount: 0, timeout: 2_000 }) }) as PublicClient;
  for (let i = 0; ; i++) {
    if (anvil.exitCode !== null) throw new Error(`anvil exited (${anvil.exitCode}): ${anvilErr.replace(/https?:\/\/\S+/g, "<url>")}`);
    try {
      if ((await probe.getChainId()) === CHAIN_ID) break;
    } catch {}
    if (i > 120) throw new Error("anvil did not answer within 2 minutes");
    await new Promise((r) => setTimeout(r, 1_000));
  }
  client = createPublicClient({ chain: robinhoodChain, transport: http(FORK_URL, { retryCount: 3, retryDelay: 1_000, timeout: 180_000 }) }) as PublicClient;
  assert.ok((await client.getGasPrice()) > 0n, "the fork has the chain's gas price");
  // A fresh key: anvil's development accounts are EIP-7702-delegated on Robinhood Chain mainnet.
  relayerAccount = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/RELAYER-PRIVATE-TEST/account")));
  for (const a of [DEPLOYER.address, AGENT.address, relayerAccount.address]) await client.request({ method: "anvil_setBalance" as never, params: [a, "0x56BC75E2D63100000"] as never });
  stake = await deploy("OstraStake.sol", "OstraStake", [OSTRA]);
  const buyback = await deploy("OstraBuyback.sol", "OstraBuyback", [OSTRA, USDG, WETH, UNIVERSAL_ROUTER, OSTRA_PONS_CURVE, PONS_HOOK, DEPLOYER.address, DEPLOYER.address]);
  router = await deploy("OstraRouter.sol", "OstraRouter", [UNIVERSAL_ROUTER, USDG, WETH, stake, buyback, TREASURY]);
  const verifier = await deploy("SpendVerifier.sol", "SpendVerifier", []);
  const fromBlock = (await client.getBlockNumber()) + 1n;
  pool = await deploy("OstraPrivatePool.sol", "OstraPrivatePool", [verifier, router]);
  trees = new PoolTrees(pool, fromBlock);
  sk = await newSecret(prover);

  dataDir = await mkdtemp(join(tmpdir(), "ostra-relayer-private-"));
  ledger = await Ledger.open(dataDir);
  sender = new RelaySender(client, http(FORK_URL), relayerAccount, { receiptTimeoutMs: 30_000, settleTimeoutMs: 60_000 });
  relay = new PrivateRelay({ client, logsClient, index, pool, ledger, sender, ethUsd: chainlinkEthUsd(client), log });

  // The agent's USDG, bought through OstraRouter, shielded for sk.
  const route = await findRoute({ client, logsClient, index, tokenIn: ETH, tokenOut: USDG, amountIn: parseEther("2"), feeBps: 20, slippageBps: 0 });
  await send(AGENT, walletSwapCall(router, route, AGENT.address));
  const amount = parseUnits("2000", 6);
  const rho = await newSecret(prover);
  await send(AGENT, { to: USDG, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, amount] }) });
  const r = await send(AGENT, shieldCall(pool, USDG, amount, await tagOf(prover, sk, rho)), 5_000_000n);
  notes.push(await shieldedNote(prover, sk, rho, r, pool));
  await trees.sync(client);
});

after(async () => {
  anvil?.kill();
  if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
});

// 900 s as the others: as the first test it quotes every pool on a cold fork (465 s in the workspace and over 600 s on
// the VPS, 25 Oct 2026, past the 300 s it had).
test("the price of a spend, per token and kind, over HTTP too; a token with no route to WETH is unpriced", { timeout: 900_000 }, async () => {
  const usdgSwap = await feeOf(USDG, "swap");
  const usdgUnshield = await feeOf(USDG, "unshield");
  assert.ok(usdgSwap > usdgUnshield && usdgUnshield > 0n);
  const wethSwap = await feeOf(WETH, "swap");
  // WETH counts one to one: the price is the wei itself; USDG at ETH/USD is the same value.
  assert.equal(await relay.valueInWei(WETH, wethSwap), wethSwap);
  const usdgWorth = (await relay.valueInWei(USDG, usdgSwap)) as bigint;
  assert.ok(usdgWorth >= wethSwap && usdgWorth - wethSwap < wethSwap / 1_000n + 10n ** 9n, `${usdgWorth} vs ${wethSwap}`);
  const nvda = await feeOf(NVDA, "unshield");
  assert.ok(((await relay.valueInWei(NVDA, nvda)) as bigint) >= (await relay.valueInWei(USDG, usdgUnshield))! * 99n / 100n);
  const none = await relay.price(getAddress("0x00000000000000000000000000000000000d0d01"), "swap");
  assert.equal(none.status, 422);
  assert.equal((none.body as { error: string }).error, "fee_unpriced");

  const unused = () => {
    throw new Error("not used here");
  };
  const server = createRelayerServer({ gate: { relay: unused, vaultState: unused, escrow: unused }, escrow: { get: unused }, backups: { get: unused, lastWrite: unused, write: unused }, privateRelay: relay, facts: {}, clientIp: "socket", log, scrub: (t) => t });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ok = await fetch(`${base}/v1/private/price?token=${USDG}&kind=unshield`);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { fee: string; relayer: string; pool: string };
    assert.equal(getAddress(body.relayer), relayerAccount.address);
    assert.equal(getAddress(body.pool), pool);
    assert.ok(BigInt(body.fee) > 0n);
    assert.equal((await fetch(`${base}/v1/private/price?token=${USDG}&kind=shield`)).status, 400);
    assert.equal((await fetch(`${base}/v1/private/price?token=nope&kind=swap`)).status, 400);
  } finally {
    server.close();
  }
});

test("a private swap USDG to NVDA is relayed for its USDG fee, once; the fee covers the gas", { timeout: 900_000 }, async () => {
  const n = notes.shift() as PrivateNote;
  const fee = await feeOf(USDG, "swap");
  const route = await findRoute({ client, logsClient, index, tokenIn: USDG, tokenOut: NVDA, amountIn: parseUnits("500", 6), feeBps: PRIVATE_SWAP_FEE_BPS, slippageBps: 100 });
  const outRho = await newSecret(prover);
  const { spend, swap } = await provePrivateSwap({ prover, sk, note: n, trees, chainId: CHAIN_ID, pool, fee, relayer: relayerAccount.address, deadline: await deadline(), route, outRho });
  const tx = request(privateSwapCall(pool, spend, swap));
  assert.equal(relay.kindOf(tx), "swap");

  // Only known code: a leg the SDK would not build, or a tokenOut the relayer does not take, is refused unsent.
  const altered = (t: typeof swap) => request({ to: pool, data: encodeFunctionData({ abi: ostraPrivatePoolAbi, functionName: "privateSwap", args: [spend.terms, t, spend.proof] }) });
  // NVDA is not the hub, so the swap needs a leg out: none is not a leg the SDK builds (calldata really changed).
  assert.notEqual(getAddress(swap.tokenOut), getAddress(swap.hub));
  const noLegOut = altered({ ...swap, legOut: NO_LEG });
  assert.notEqual(noLegOut.data, tx.data);
  const badLeg = await relay.relay(noLegOut, "127.0.0.1");
  assert.equal((badLeg.body as { error: string }).error, "route_not_relayed", JSON.stringify(badLeg.body));
  const badOut = await relay.relay(altered({ ...swap, tokenOut: getAddress("0x00000000000000000000000000000000000d0d01") }), "127.0.0.1");
  assert.equal((badOut.body as { error: string }).error, "route_not_relayed");
  assert.equal(ledger.view().paid[tx.hash], undefined, "nothing was relayed for the spend yet");

  const usdgBefore = await balance(USDG, relayerAccount.address);
  const ethBefore = await client.getBalance({ address: relayerAccount.address });
  const a = await relay.relay(tx, "127.0.0.1");
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const { txHash } = a.body as { txHash: Hex };
  const r = await client.getTransactionReceipt({ hash: txHash });
  assert.equal(r.status, "success");
  assert.equal((await balance(USDG, relayerAccount.address)) - usdgBefore, fee);
  const spentWei = ethBefore - (await client.getBalance({ address: relayerAccount.address }));
  assert.equal(spentWei, r.gasUsed * r.effectiveGasPrice);
  assert.ok(((await relay.valueInWei(USDG, fee)) as bigint) > spentWei, "the fee is worth more than the gas it paid");

  // Sent again: the same transaction, nothing sent.
  const again = await relay.relay(tx, "127.0.0.1");
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { txHash, fee: fee.toString(), token: USDG, repeated: true });
  const view = ledger.view();
  assert.equal(view.paid[tx.hash]?.token, USDG);
  assert.deepEqual(view.feeTokens, [USDG]);

  const out = await swapOutputNote(prover, sk, outRho, spend, swap, r, pool);
  const change = changeNote(spend, r, pool);
  assert.ok(change);
  notes.push(out, change);
  await trees.sync(client);
});

test("refused before sending: another relayer's fee, no fee, a close deadline, a fee below the cost (with the fee that would do)", { timeout: 900_000 }, async () => {
  const change = notes[1] as PrivateNote;
  const low = await proveUnshield({ prover, sk, note: change, trees, chainId: CHAIN_ID, pool, fee: 1n, relayer: relayerAccount.address, deadline: await deadline(), v: parseUnits("10", 6), recipient: RECIPIENT });
  const altered = (terms: Partial<Spend["terms"]>) => request({ to: pool, data: encodeFunctionData({ abi: ostraPrivatePoolAbi, functionName: "unshield", args: [{ ...low.terms, ...terms }, RECIPIENT, low.proof] }) });
  const nonce = await client.getTransactionCount({ address: relayerAccount.address });

  const other = await relay.relay(altered({ relayer: OTHER_RELAYER }), "127.0.0.1");
  assert.equal(other.status, 422);
  assert.equal((other.body as { error: string }).error, "not_relayer_fee");
  const zero = await relay.relay(altered({ fee: 0n }), "127.0.0.1");
  assert.equal((zero.body as { error: string }).error, "fee_too_low");
  const now = (await client.getBlock()).timestamp;
  const close = await relay.relay(altered({ deadline: now + MIN_DEADLINE_SECONDS - 5n }), "127.0.0.1");
  assert.equal((close.body as { error: string }).error, "deadline_too_close");
  const token = await relay.relay(altered({ asset: getAddress("0x00000000000000000000000000000000000d0d01") }), "127.0.0.1");
  assert.equal((token.body as { error: string }).error, "token_not_relayed");
  // A note whose spend reverted when relayed is not sent again.
  const banned = `0x${"ab".repeat(32)}` as Hex;
  await ledger.update((data) => {
    data.privateReverts = { [banned]: [{ txHash: `0x${"cd".repeat(32)}`, at: Date.now() - 1_000 }, { txHash: `0x${"ce".repeat(32)}`, at: Date.now() }] };
  });
  assert.equal(((await relay.relay(altered({ nullifier: banned }), "127.0.0.1")).body as { error: string }).error, "reverted_before");
  // Through the gate: a private spend goes to the private relay, before any WOTS escrow or x402 payment.
  const gate = new RelayerGate({ swap: { router, private: relay } } as unknown as GateOptions);
  const viaGate = await gate.relay({ body: JSON.stringify({ calls: [{ to: pool, data: altered({ relayer: OTHER_RELAYER }).data }] }), req: undefined as never, ip: "127.0.0.2" });
  assert.equal((viaGate.body as { error: string }).error, "not_relayer_fee");
  // One IP address gets PRIVATE_RELAYS_PER_IP_HOUR requests an hour.
  for (let i = 0; i < PRIVATE_RELAYS_PER_IP_HOUR; i++) assert.equal((await relay.relay(altered({ relayer: OTHER_RELAYER }), "10.0.0.9")).status, 422);
  assert.equal((await relay.relay(altered({ relayer: OTHER_RELAYER }), "10.0.0.9")).status, 429);

  const tooLow = await relay.relay(request(unshieldCall(pool, low, RECIPIENT)), "127.0.0.1");
  assert.equal(tooLow.status, 422, JSON.stringify(tooLow.body));
  const body = tooLow.body as { error: string; required: string; token: string };
  assert.equal(body.error, "fee_too_low");
  assert.equal(getAddress(body.token), USDG);
  assert.ok(BigInt(body.required) > 1n);
  assert.equal(await client.getTransactionCount({ address: relayerAccount.address }), nonce, "nothing was sent");

  // Proved again with the fee the refusal names: relayed.
  const ok = await proveUnshield({ prover, sk, note: change, trees, chainId: CHAIN_ID, pool, fee: BigInt(body.required), relayer: relayerAccount.address, deadline: await deadline(), v: parseUnits("10", 6), recipient: RECIPIENT });
  const a = await relay.relay(request(unshieldCall(pool, ok, RECIPIENT)), "127.0.0.1");
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(await balance(USDG, RECIPIENT), parseUnits("10", 6));
  const r = await client.getTransactionReceipt({ hash: (a.body as { txHash: Hex }).txHash });
  const rest = changeNote(ok, r, pool);
  assert.ok(rest);
  notes[1] = rest;
  await trees.sync(client);
});

test("an NVDA note unshielded for a fee in NVDA, priced by its sale to WETH", { timeout: 900_000 }, async () => {
  const nvda = notes[0] as PrivateNote;
  assert.equal(nvda.asset, NVDA);
  const fee = await feeOf(NVDA, "unshield");
  assert.ok(fee < nvda.amount);
  const s = await proveUnshield({ prover, sk, note: nvda, trees, chainId: CHAIN_ID, pool, fee, relayer: relayerAccount.address, deadline: await deadline(), v: nvda.amount - fee, recipient: RECIPIENT });
  const a = await relay.relay(request(unshieldCall(pool, s, RECIPIENT)), "127.0.0.1");
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(await balance(NVDA, relayerAccount.address), fee);
  assert.equal(await balance(NVDA, RECIPIENT), nvda.amount - fee);
  assert.deepEqual(ledger.view().feeTokens, [USDG, NVDA]);
});

test("an immediate escrow order executed by the relayer, sent at the cap it was priced for, swaps (priced at the gas limit its swap needs)", { timeout: 600_000 }, async () => {
  const route = await findRoute({ client, logsClient, index, tokenIn: USDG, tokenOut: WETH, amountIn: parseUnits("10", 6), feeBps: 20, slippageBps: 100 });
  const order = orderFor(route, AGENT.address, USDG, RECIPIENT, (await client.getBlock()).timestamp, randomSalt());
  await send(AGENT, { to: USDG, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [escrowAddress(router, order), order.amountIn] }) });
  const call = { to: router, data: executeEscrowData(order, route) };
  const m = await estimateRelay(client, { relayer: relayerAccount.address, ...call });
  const estimated = await client.estimateGas({ account: relayerAccount.address, ...call });
  const landed = await sender.send(call, { maxGas: relayGasCap(m.gas), gasAtCap: true });
  const sentTx = await client.getTransaction({ hash: landed.txHash });
  console.log(`executeEscrow gas: priced ${m.gas}, sent limit ${sentTx.gas}, eth_estimateGas ${estimated}, used ${landed.gasUsed}`);
  const r = await client.getTransactionReceipt({ hash: landed.txHash });
  assert.equal((await client.getTransaction({ hash: landed.txHash })).gas, relayGasCap(m.gas));
  const events = (logs: readonly { data: Hex; topics: readonly Hex[] }[]) =>
    logs.flatMap((l) => {
      try {
        const e = decodeEventLog({ abi: ostraRouterAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        return e.eventName === "EscrowExecuted" || e.eventName === "EscrowRefunded" ? [{ name: e.eventName, ...(e.args as Record<string, unknown>) }] : [];
      } catch {
        return [];
      }
    });
  const show = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  // What the simulation the price came from did, and what the sent transaction did (a refund carries its reason).
  console.log(`executeEscrow simulated: ${show(events(m.logs as never))}`);
  console.log(`executeEscrow sent: ${show(events(r.logs))}`);
  const executed = events(r.logs).filter((e) => e.name === "EscrowExecuted");
  assert.deepEqual(executed, [{ ...executed[0], swapped: true, received: order.amountIn }], show(events(r.logs)));
  console.log(`executeEscrow: ${r.gasUsed} gas used of ${relayGasCap(m.gas)} (priced ${m.gas})`);
});

test("a spend that reverts on-chain (its change note shielded first) costs the relayer its gas and counts against the note and the IP address", { timeout: 900_000 }, async () => {
  const rest = notes[1] as PrivateNote;
  const fee = await feeOf(USDG, "unshield");
  const changeRho = await newSecret(prover);
  const s = await proveUnshield({ prover, sk, note: rest, trees, chainId: CHAIN_ID, pool, fee, relayer: relayerAccount.address, deadline: await deadline(), v: parseUnits("5", 6), recipient: RECIPIENT, changeRho });
  const change = s.change;
  assert.ok(change.amount > 0n);
  await send(AGENT, { to: USDG, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, change.amount] }) });
  const clash = shieldCall(pool, USDG, change.amount, await tagOf(prover, sk, changeRho));
  const tx = request(unshieldCall(pool, s, RECIPIENT));
  const ethBefore = await client.getBalance({ address: relayerAccount.address });
  const usdgBefore = await balance(USDG, relayerAccount.address);

  // The relayer's transaction waits in anvil's pool; the agent's shield of the same commitment, with a higher tip, lands first in that block.
  await client.request({ method: "evm_setAutomine" as never, params: [false] as never });
  let answer: Awaited<ReturnType<typeof relay.relay>>;
  try {
    const pending = relay.relay(tx, "10.0.0.7");
    const self = relayerAccount.address.toLowerCase();
    for (let i = 0; ; i++) {
      const pool = (await client.request({ method: "txpool_content" as never, params: [] as never })) as { pending?: Record<string, unknown> };
      if (Object.keys(pool.pending ?? {}).some((from) => from.toLowerCase() === self)) break;
      if (i > 600) throw new Error("the relayer's transaction did not reach anvil's pool");
      await new Promise((r) => setTimeout(r, 100));
    }
    const tip = 50_000_000_000n;
    const hash = await wallet(AGENT).sendTransaction({ ...clash, chain: null, gas: 5_000_000n, maxPriorityFeePerGas: tip, maxFeePerGas: tip * 2n });
    await client.request({ method: "evm_mine" as never, params: [] as never });
    assert.equal((await client.getTransactionReceipt({ hash })).status, "success");
    answer = await pending;
  } finally {
    await client.request({ method: "evm_setAutomine" as never, params: [true] as never });
  }
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.equal((answer.body as { error: string }).error, "not_sent");
  assert.ok((await client.getBalance({ address: relayerAccount.address })) < ethBefore, "the relayer paid the reverted transaction's gas");
  assert.equal(await balance(USDG, relayerAccount.address), usdgBefore, "and got no fee");
  assert.equal(ledger.view().privateReverts?.[s.terms.nullifier.toLowerCase()]?.length, 1);
  // Sent again: its simulation refuses it now (the commitment exists), nothing is sent.
  const again = await relay.relay(tx, "10.0.0.7");
  assert.equal(again.status, 422, JSON.stringify(again.body));
});

test("the sweep sells every fee token for ETH through OstraRouter", { timeout: 600_000 }, async () => {
  // The fees of one test run are small: no minimum sale here, the gas rule still holds.
  const sweeper = new FeeSweeper({ client, logsClient, index, router, stake, ledger, sender, log, minWei: 1n });
  const ethBefore = await client.getBalance({ address: relayerAccount.address });
  const results = await sweeper.sweep();
  assert.deepEqual(results.map((x) => [x.token, x.outcome]), [[USDG, "sold"], [NVDA, "sold"]], JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  assert.equal(await balance(USDG, relayerAccount.address), 0n);
  assert.equal(await balance(NVDA, relayerAccount.address), 0n);
  for (const t of [USDG, NVDA]) assert.equal(await client.readContract({ address: t, abi: erc20Abi, functionName: "allowance", args: [relayerAccount.address, router] }), 0n);
  assert.ok((await client.getBalance({ address: relayerAccount.address })) > ethBefore, "the sales brought more ETH than their gas");
  // Nothing left: the next sweep skips both.
  assert.deepEqual((await sweeper.sweep()).map((x) => x.outcome), ["skipped", "skipped"]);
});

