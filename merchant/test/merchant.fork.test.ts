// The seller server end to end on a fork of Robinhood Chain mainnet: Ostra
// deployed next to the real USDG, x402BatchSettlement and the x402 deposit
// collectors; the keeper running as its own process (keeper/src/main.ts); the
// merchant in-process behind its HTTP endpoint; and buyers paying with the
// stock x402 batch-settlement client (@x402/evm 2.28.0):
//   * channel A: a plain account deposits 2 USDG with an EIP-3009
//     authorization through this server's facilitator, pays four requests,
//     the keeper claims 1.2 on its own, a replayed voucher gets 409 and a
//     voucher under the price a corrective 402; the server restarts and a
//     fifth request still pays; the buyer's x402 refund closes the channel
//     through the keeper;
//   * channel B: an Ostra buyer vault opens a channel with a WOTS OpenChannel
//     spend, the server adopts it from the chain on its first voucher, and
//     closes it through the keeper once it is idle;
//   * a vault channel that does not match the offer is refused, and the
//     server refuses to start on a vault that is not ready for the keeper.
// Balances are checked to the smallest unit.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { bytesToHex, hexToBytes, keccak256, stringToHex, zeroAddress, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  ROBINHOOD_CHAIN_ID,
  USDG,
  WotsKeychain,
  channelId,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  readChannel,
  readVault,
  signVaultOpenChannel,
  usdgAbi,
  vaultAddress,
  voucherTypedData,
  type Deployment,
  type OpenChannelParams,
} from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme as BatchSettlementClient } from "@x402/evm/batch-settlement/client";
import { createMerchantServer } from "../src/http.ts";
import { MerchantKeys } from "../src/keys.ts";
import { ERR_VAULT_CHANNEL_REFUSED, createOstraMerchant, type OstraMerchant } from "../src/merchant.ts";
import { FileChannelStorage } from "../src/store.ts";

const NETWORK = `eip155:${ROBINHOOD_CHAIN_ID}` as const;
const MASTER = new Uint8Array(32).fill(5);
const PRICE = 300_000n;
const IDLE_SECONDS = 8;
const tokens = (text: string) => BigInt(Math.round(Number(text) * 1e6));
const share = (amount: bigint) => (amount * 30n) / 10_000n;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let fork: Fork;
let d: Deployment;
let root: string;
let relayer: PrivateKeyAccount;
let keeperChild: ChildProcess | undefined;
let keeperUrl: string;
let keys: MerchantKeys;
let feeRecipient: Address;
let sellerVault: Address;
let merchant: OstraMerchant;
let server: Server;
let base: string;
const logs: string[] = [];
const log = (event: string, fields: Record<string, unknown> = {}) => logs.push(JSON.stringify({ event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a !== null && typeof a === "object" ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

async function send(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) {
  const hash = await fork.wallet(relayer).writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, account: relayer, chain: fork.client.chain });
  const receipt = await fork.client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${functionName} failed`);
}

async function keychain(name: string): Promise<WotsKeychain> {
  return new WotsKeychain(MASTER, hexToBytes(keccak256(stringToHex(`OSTRA/EVM/MERCHANT-TEST/${name}`))), new FileWotsStore(await mkdtemp(join(root, "wots-"))));
}

async function createVault(chain: WotsKeychain, crank: Address): Promise<Address> {
  const root0 = bytesToHex(chain.keyRoot(0n));
  await send(d.vaultFactory, ostraVaultFactoryAbi, "createVault", [USDG, root0, crank]);
  return vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: USDG, initialKeyRoot: root0, initialCrank: crank });
}

const balance = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] });

async function startMerchant(): Promise<void> {
  const storage = await FileChannelStorage.open(join(root, "merchant-data"));
  merchant = await createOstraMerchant({ rpcUrl: fork.url, deployment: d, vault: sellerVault, keeperUrl, keys, storage, price: PRICE, suggestedDeposit: tokens("2"), idleTimeoutSeconds: IDLE_SECONDS, log });
  server = createMerchantServer(merchant, {}, log, (t) => t);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const at = server.address();
  assert.ok(at !== null && typeof at === "object");
  base = `http://127.0.0.1:${at.port}`;
}

async function stopMerchant(): Promise<void> {
  merchant.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** An x402 HTTP client paying with the stock batch-settlement client scheme. */
function payingClient(scheme: BatchSettlementClient): x402HTTPClient {
  const client = new x402Client().register(NETWORK, scheme);
  client.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: USDG }] });
  return new x402HTTPClient(client);
}

type Paid = { status: number; body: Record<string, unknown>; payload: PaymentPayload; headers: Headers; detail: string };

/** GET /paid: the 402, then the payment the client builds for it. */
async function pay(http: x402HTTPClient): Promise<Paid> {
  const first = await fetch(`${base}/paid`);
  assert.equal(first.status, 402);
  const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json());
  const payload = await http.createPaymentPayload(required);
  return resend(http, payload);
}

async function resend(http: x402HTTPClient, payload: PaymentPayload): Promise<Paid> {
  const res = await fetch(`${base}/paid`, { headers: http.encodePaymentSignatureHeader(payload) });
  const body = (await res.json()) as Record<string, unknown>;
  const required = res.headers.get("payment-required");
  const response = res.headers.get("payment-response");
  const detail = JSON.stringify({
    body,
    required: required === null ? undefined : decodePaymentRequiredHeader(required).error,
    response: response === null ? undefined : decodePaymentResponseHeader(response),
  });
  if (res.status !== 409) await http.processPaymentResult(payload, (n) => res.headers.get(n), res.status);
  return { status: res.status, body, payload, headers: res.headers, detail };
}

async function waitFor(done: () => Promise<boolean>, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if (await done()) return true;
    await sleep(500);
  }
  return done();
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-merchant-fork-"));
  fork = await startFork();
  relayer = fork.accounts[0] as PrivateKeyAccount;
  d = await deployOnFork(fork);
  await writeFile(join(root, "deployment.json"), JSON.stringify(d));
  feeRecipient = await createVault(await keychain("operator"), zeroAddress);

  const port = await freePort();
  keeperUrl = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? root,
    OSTRA_RPC_URL: fork.url,
    OSTRA_DEPLOYMENT: join(root, "deployment.json"),
    OSTRA_KEEPER_SECRETS: join(root, "keeper-secrets"),
    OSTRA_KEEPER_DATA: join(root, "keeper-data"),
    OSTRA_KEEPER_LISTEN: `127.0.0.1:${port}`,
    OSTRA_KEEPER_FEE_RECIPIENT: feeRecipient,
  };
  keeperChild = spawn(process.execPath, [fileURLToPath(new URL("../../keeper/src/main.ts", import.meta.url))], { env, stdio: ["ignore", "pipe", "pipe"] });
  keeperChild.stdout?.on("data", (c: Buffer) => logs.push(`keeper | ${c.toString("utf8").trim()}`));
  keeperChild.stderr?.on("data", (c: Buffer) => logs.push(`keeper ! ${c.toString("utf8").trim()}`));
  let health: Record<string, unknown> | undefined;
  for (let i = 0; i < 120 && health === undefined; i++) {
    try {
      health = (await (await fetch(`${keeperUrl}/v1/health`)).json()) as Record<string, unknown>;
    } catch {
      await sleep(500);
    }
  }
  assert.ok(health !== undefined, "the keeper did not start");
  await fork.setBalance(health.feePayer as Address, 10n ** 18n);

  keys = await MerchantKeys.open(join(root, "merchant-secrets"));
  await fork.setBalance(keys.facilitator.address, 10n ** 18n);
  const crank = ((await (await fetch(`${keeperUrl}/v1/crank?merchant=${keys.merchant}`)).json()) as { crank: Address }).crank;
  sellerVault = await createVault(await keychain("seller"), crank);
});

after(async () => {
  if (merchant !== undefined) await stopMerchant().catch(() => undefined);
  if (keeperChild !== undefined && keeperChild.exitCode === null) {
    const exited = new Promise((resolve) => keeperChild?.once("exit", resolve));
    keeperChild.kill("SIGTERM");
    await exited;
  }
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("the server refuses to start on an address that is not an Ostra vault or a vault without the keeper crank", async () => {
  const storage = await FileChannelStorage.open(join(root, "refused-data"));
  const options = { rpcUrl: fork.url, deployment: d, keeperUrl, keys, storage, price: PRICE, log };
  await assert.rejects(createOstraMerchant({ ...options, vault: relayer.address }), /is not an Ostra vault/);
  const bare = await createVault(await keychain("no crank"), zeroAddress);
  await assert.rejects(createOstraMerchant({ ...options, vault: bare }), /has no crank, not the keeper crank/);
  await assert.rejects(createOstraMerchant({ ...options, vault: sellerVault, gracePeriodSeconds: 899 }), /at least 900 seconds/);
  await assert.rejects(createOstraMerchant({ ...options, vault: sellerVault, price: 0n }), /positive/);
});

test("channel A: an EIP-3009 deposit, vouchers, the keeper's threshold claim, 409 and corrective 402, a restart, and the buyer's refund through the keeper", async () => {
  await startMerchant();
  // A fresh key: anvil's development accounts are EIP-7702-delegated on Robinhood Chain mainnet (they have code there).
  const buyer = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/MERCHANT-TEST/buyer A")));
  await fork.dealUsdg(buyer.address, tokens("2.5"));
  const scheme = new BatchSettlementClient(toClientEvmSigner(buyer, fork.client as never), { depositStrategy: () => tokens("2").toString() });
  const http = payingClient(scheme);
  const sellerBefore = await balance(sellerVault);
  const feeBefore = await balance(feeRecipient);

  // The offer: the split as payTo, the vault as receiverAuthorizer, the keeper's withdraw delay.
  const probe = await fetch(`${base}/paid`);
  assert.equal(probe.status, 402);
  const offer = decodePaymentRequiredHeader(probe.headers.get("payment-required") ?? "").accepts[0];
  assert.ok(offer !== undefined);
  assert.equal(offer.scheme, "batch-settlement");
  assert.equal(offer.network, NETWORK);
  assert.equal(offer.amount, PRICE.toString());
  assert.equal(offer.asset, USDG);
  assert.equal(offer.payTo, merchant.split);
  assert.equal(offer.extra.receiverAuthorizer, sellerVault);
  assert.equal(offer.extra.withdrawDelay, 900);
  assert.equal(offer.extra.minDeposit, tokens("2").toString());
  assert.deepEqual(merchant.splits, [{ recipient: feeRecipient, bps: 30 }]);

  let r = await pay(http);
  assert.equal(r.status, 200, r.detail);
  const config = (r.payload.payload as { channelConfig: Parameters<typeof channelId>[0] }).channelConfig;
  const id = channelId(config);
  assert.equal((await readChannel(fork.client, d.batchSettlement, id)).balance, tokens("2"), "the facilitator deposited 2 USDG");
  for (const expected of ["0.6", "0.9", "1.2"]) {
    r = await pay(http);
    assert.equal(r.status, 200, `${expected}: ${r.detail}`);
  }
  assert.ok(await waitFor(async () => (await readChannel(fork.client, d.batchSettlement, id)).totalClaimed === tokens("1.2"), 60), "the keeper claimed 1.2 on its own");

  // A voucher that already paid gets 409; one under the price a corrective 402.
  const replay = await resend(http, r.payload);
  assert.deepEqual([replay.status, replay.body.error], [409, "voucher_replayed"]);
  const short = structuredClone(r.payload);
  const voucher = (short.payload as { voucher: { maxClaimableAmount: string; signature: Hex } }).voucher;
  voucher.maxClaimableAmount = (tokens("1.2") + PRICE - 1n).toString();
  voucher.signature = await buyer.signTypedData(voucherTypedData({ channelId: id, maxClaimableAmount: BigInt(voucher.maxClaimableAmount) }));
  const under = await fetch(`${base}/paid`, { headers: http.encodePaymentSignatureHeader(short) });
  assert.equal(under.status, 402);
  assert.equal(decodePaymentRequiredHeader(under.headers.get("payment-required") ?? "").error, "invalid_batch_settlement_evm_cumulative_amount_mismatch");

  // The server restarts from its stored channels.
  await stopMerchant();
  await startMerchant();
  r = await pay(http);
  assert.equal(r.status, 200, r.detail);

  // The buyer's refund: the keeper claims 1.5, refunds 0.5 and pays out.
  const refund = await scheme.refund(`${base}/paid`);
  assert.equal(refund.success, true, JSON.stringify(refund));
  assert.match(refund.transaction, /^0x[0-9a-f]{64}$/);
  assert.equal(refund.amount, tokens("0.5").toString());
  const ch = await readChannel(fork.client, d.batchSettlement, id);
  assert.equal(ch.totalClaimed, tokens("1.5"));
  assert.equal(ch.balance, ch.totalClaimed);
  assert.equal(await balance(buyer.address), tokens("1"), "the buyer got its unspent 0.5 back");
  const paid = tokens("1.5");
  assert.equal((await balance(sellerVault)) - sellerBefore, paid - share(paid), "the seller vault got 1.5 minus the 30 bps keeper fee");
  assert.equal((await balance(feeRecipient)) - feeBefore, share(paid));
});

test("channel B: a buyer vault's channel is adopted from the chain, paid, and closed through the keeper when idle", async () => {
  const buyerChain = await keychain("buyer vault");
  const buyerVault = await createVault(buyerChain, zeroAddress);
  await fork.dealUsdg(buyerVault, tokens("5"));
  const session = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/MERCHANT-TEST/session")));
  const salt = keccak256(stringToHex("channel B"));
  const open: OpenChannelParams = { payerAuthorizer: session.address, receiver: merchant.split, receiverAuthorizer: sellerVault, withdrawDelay: 900, salt, amount: tokens("0.5") };
  const state = await readVault(fork.client, d, buyerVault);
  assert.ok(state);
  const spend = await signVaultOpenChannel(buyerChain, state, { chainId: ROBINHOOD_CHAIN_ID, open });
  await send(buyerVault, ostraVaultAbi, "spend", [spend.action, spend.nextKeyRoot, spend.params, spend.signature]);
  const sellerBefore = await balance(sellerVault);
  const buyerBefore = await balance(buyerVault);

  // The vault cannot sign deposits; its session key signs the vouchers.
  const vaultSigner = { address: buyerVault, signTypedData: () => Promise.reject(new Error("a vault never signs")), readContract: (args: never) => fork.client.readContract(args) };
  const scheme = new BatchSettlementClient(vaultSigner as never, { voucherSigner: toClientEvmSigner(session, fork.client as never), payerAuthorizer: session.address, salt, depositStrategy: () => false });
  const r = await pay(payingClient(scheme));
  assert.equal(r.status, 200, r.detail);
  assert.ok(logs.some((l) => l.includes("vault_channel_adopted")));

  const id = channelId({ payer: buyerVault, payerAuthorizer: session.address, receiver: merchant.split, receiverAuthorizer: sellerVault, token: USDG, withdrawDelay: 900, salt });
  assert.ok(
    await waitFor(async () => {
      const ch = await readChannel(fork.client, d.batchSettlement, id);
      return ch.totalClaimed === PRICE && ch.balance === ch.totalClaimed && (await balance(sellerVault)) - sellerBefore === PRICE - share(PRICE);
    }, IDLE_SECONDS + 60),
    `the idle channel was closed through the keeper:\n${logs.slice(-20).join("\n")}`,
  );
  assert.equal((await balance(buyerVault)) - buyerBefore, tokens("0.2"), "the buyer vault got its unspent 0.2 back");
});

test("a vault channel that does not match the offer is refused", async () => {
  const buyerChain = await keychain("mismatched vault");
  const buyerVault = await createVault(buyerChain, zeroAddress);
  await fork.dealUsdg(buyerVault, tokens("1"));
  const session = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/MERCHANT-TEST/session-2")));
  const salt = keccak256(stringToHex("channel C"));
  // A longer withdraw delay than the offer's.
  const open: OpenChannelParams = { payerAuthorizer: session.address, receiver: merchant.split, receiverAuthorizer: sellerVault, withdrawDelay: 1_800, salt, amount: tokens("0.5") };
  const state = await readVault(fork.client, d, buyerVault);
  assert.ok(state);
  const spend = await signVaultOpenChannel(buyerChain, state, { chainId: ROBINHOOD_CHAIN_ID, open });
  await send(buyerVault, ostraVaultAbi, "spend", [spend.action, spend.nextKeyRoot, spend.params, spend.signature]);
  const config = { payer: buyerVault, payerAuthorizer: session.address, receiver: merchant.split, receiverAuthorizer: sellerVault, token: USDG, withdrawDelay: 1_800, salt };
  const id = channelId(config);
  const signature = await session.signTypedData(voucherTypedData({ channelId: id, maxClaimableAmount: PRICE }));
  const probe = await fetch(`${base}/paid`);
  const accepted = decodePaymentRequiredHeader(probe.headers.get("payment-required") ?? "").accepts[0];
  const payload = { x402Version: 2, accepted, payload: { type: "voucher", channelConfig: config, voucher: { channelId: id, maxClaimableAmount: PRICE.toString(), signature } } } as unknown as PaymentPayload;
  const res = await fetch(`${base}/paid`, { headers: new x402HTTPClient(new x402Client()).encodePaymentSignatureHeader(payload) });
  assert.equal(res.status, 402);
  const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
  assert.equal(required.error, ERR_VAULT_CHANNEL_REFUSED, JSON.stringify(required));
});
