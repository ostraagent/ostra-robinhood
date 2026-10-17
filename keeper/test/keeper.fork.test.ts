// The keeper end to end on a fork of Robinhood Chain mainnet: Ostra deployed
// with deployOstra next to the real USDG and x402BatchSettlement, the keeper's
// HTTP endpoint on a local port, and channels opened by an Ostra buyer vault
// (WOTS OpenChannel spends) to a seller vault whose crank is the keeper crank
// of the seller's merchant key. Mirrors keeper/scripts/chain-check.ts of the
// Solana version: vouchers below and above the 1-token threshold, a buyer's
// close request claimed and refunded within one watch pass, a seller's signed
// close request, the age rule, and every refusal; balances are checked to the
// smallest unit.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bytesToHex, hexToBytes, http, keccak256, stringToHex, zeroAddress, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  ROBINHOOD_CHAIN_ID,
  USDG,
  WotsKeychain,
  channelId,
  closeRequestTypedData,
  ostraSplitFactoryAbi,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  readChannel,
  readVault,
  signVaultOpenChannel,
  usdgAbi,
  vaultAddress,
  vaultChannelConfig,
  voucherTypedData,
  type ChannelConfig,
  type Deployment,
  type OpenChannelParams,
} from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Sender } from "../src/chain.ts";
import { KEEPER_FEE_BPS, MIN_GRACE_SECONDS, type Config } from "../src/config.ts";
import { createKeeperServer } from "../src/http.ts";
import { Keeper } from "../src/keeper.ts";
import { KeeperKeys, closeRequestMessage } from "../src/keys.ts";
import { ChannelStore } from "../src/store.ts";

const MASTER = new Uint8Array(32).fill(7);
const tokens = (text: string) => BigInt(Math.round(Number(text) * 1e6));
const share = (amount: bigint) => (amount * BigInt(KEEPER_FEE_BPS)) / 10_000n;

let fork: Fork;
let d: Deployment;
let relayer: PrivateKeyAccount;
let keeper: Keeper;
let server: Server;
let base: string;
let root: string;
let keys: KeeperKeys;
let store: ChannelStore;
let config: Config;
let sender: Sender;
const merchant = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/KEEPER-TEST/merchant")));
const otherMerchant = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/KEEPER-TEST/other-merchant")));
let feeRecipient: Address;
let sellerVault: Address;
let sellerSplit: Address;
let buyerChain: WotsKeychain;
let buyerVault: Address;

async function send(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) {
  const hash = await fork.wallet(relayer).writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, account: relayer, chain: fork.client.chain });
  const receipt = await fork.client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${functionName} failed`);
}

async function keychain(name: string): Promise<WotsKeychain> {
  const dir = await mkdtemp(join(root, "wots-"));
  return new WotsKeychain(MASTER, hexToBytes(keccak256(stringToHex(`OSTRA/EVM/KEEPER-TEST/${name}`))), new FileWotsStore(dir));
}

async function createVault(chain: WotsKeychain, crank: Address): Promise<Address> {
  const root0 = bytesToHex(chain.keyRoot(0n));
  await send(d.vaultFactory, ostraVaultFactoryAbi, "createVault", [USDG, root0, crank]);
  return vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: USDG, initialKeyRoot: root0, initialCrank: crank });
}

const balance = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] });

async function splitOf(vault: Address, recipients: { recipient: Address; bps: number }[]): Promise<Address> {
  return fork.client.readContract({ address: d.splitFactory, abi: ostraSplitFactoryAbi, functionName: "splitAddress", args: [USDG, vault, recipients.map((r) => r.recipient), recipients.map((r) => r.bps)] });
}

/** Opens a channel from the buyer vault with a WOTS spend; returns its config and the voucher key. */
async function openChannel(o: Partial<OpenChannelParams> & { amount: bigint }, salt: string): Promise<{ config: ChannelConfig; session: PrivateKeyAccount }> {
  const session = privateKeyToAccount(keccak256(stringToHex(`OSTRA/EVM/KEEPER-TEST/session/${salt}`)));
  const open: OpenChannelParams = {
    payerAuthorizer: session.address,
    receiver: sellerSplit,
    receiverAuthorizer: sellerVault,
    withdrawDelay: MIN_GRACE_SECONDS,
    salt: keccak256(stringToHex(salt)),
    ...o,
  };
  const state = await readVault(fork.client, d, buyerVault);
  assert.ok(state);
  const spend = await signVaultOpenChannel(buyerChain, state, { chainId: ROBINHOOD_CHAIN_ID, open });
  await send(buyerVault, ostraVaultAbi, "spend", [spend.action, spend.nextKeyRoot, spend.params, spend.signature]);
  return { config: vaultChannelConfig(buyerVault, USDG, open), session };
}

async function voucherOf(session: PrivateKeyAccount, config: ChannelConfig, amount: bigint) {
  const id = channelId(config);
  const signature = await session.signTypedData(voucherTypedData({ channelId: id, maxClaimableAmount: amount }));
  return { channelId: id, maxClaimableAmount: amount.toString(), signature };
}

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function buyerRequestsClose(config: ChannelConfig, session: PrivateKeyAccount): Promise<void> {
  const id = channelId(config);
  const ch = await readChannel(fork.client, d.batchSettlement, id);
  const nonce = await fork.client.readContract({ address: buyerVault, abi: ostraVaultAbi, functionName: "closeNonce", args: [id] });
  const deadline = (await fork.client.getBlock()).timestamp + 600n;
  const amount = ch.balance - ch.totalClaimed;
  const sig = await session.signTypedData(closeRequestTypedData({ chainId: ROBINHOOD_CHAIN_ID, vault: buyerVault, channelId: id, amount, nonce, deadline }));
  await send(buyerVault, ostraVaultAbi, "requestClose", [config, amount, deadline, sig]);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-keeper-fork-"));
  fork = await startFork();
  relayer = fork.accounts[0] as PrivateKeyAccount;
  d = await deployOnFork(fork);
  keys = await KeeperKeys.open(join(root, "secrets"), d.chainId);
  await fork.setBalance(keys.feePayer.address, 10n ** 18n);
  store = new ChannelStore(join(root, "data"));
  await store.init();
  feeRecipient = await createVault(await keychain("operator"), zeroAddress);
  config = { rpcUrl: fork.url, deployment: d, secretsDir: join(root, "secrets"), dataDir: join(root, "data"), listen: { host: "127.0.0.1", port: 0 }, feeRecipient };
  sender = new Sender(fork.client, http(fork.url), keys.feePayer, (event, fields) => keeper?.log(event, fields));
  keeper = await Keeper.open({ client: fork.client, config, keys, store, sender, decimals: 6, redact: (t) => t });
  server = createKeeperServer(keeper);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;

  const crankReply = await get(`/v1/crank?merchant=${merchant.address}`);
  assert.equal(crankReply.status, 200);
  sellerVault = await createVault(await keychain("seller"), crankReply.json.crank as Address);
  sellerSplit = await splitOf(sellerVault, [{ recipient: feeRecipient, bps: KEEPER_FEE_BPS }]);
  buyerChain = await keychain("buyer");
  buyerVault = await createVault(buyerChain, zeroAddress);
  await fork.dealUsdg(buyerVault, tokens("5"));
});

after(async () => {
  await keeper?.stop();
  server?.close();
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const splits = () => [{ recipient: feeRecipient, bps: KEEPER_FEE_BPS }];

test("terms, crank and health", async () => {
  const terms = await get("/v1/terms");
  assert.deepEqual(terms.json, { chainId: ROBINHOOD_CHAIN_ID, token: USDG, feeRecipient, feeBps: 30, minGraceSeconds: 900 });
  const crank = await get(`/v1/crank?merchant=${merchant.address}`);
  assert.equal(crank.json.crank, keys.crankFor(merchant.address).address);
  assert.equal((await readVault(fork.client, d, sellerVault))?.crank, crank.json.crank);
  assert.equal((await get("/v1/crank?merchant=nope")).status, 400);
  const health = await get("/v1/health");
  assert.equal(health.json.feePayer, keys.feePayer.address);
  assert.equal(health.json.feePayerWei, (10n ** 18n).toString());
  assert.equal((await get("/v1/nothing")).status, 404);
});

test("vouchers below the threshold wait, 1 token is claimed, a buyer's close is claimed and refunded in one pass", async () => {
  const { config: c, session } = await openChannel({ amount: tokens("2") }, "channel A");
  const other = privateKeyToAccount(keccak256(stringToHex("not the session key")));
  const sellerBefore = await balance(sellerVault);
  const feeBefore = await balance(feeRecipient);
  const buyerBefore = await balance(buyerVault);

  let r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: c, voucher: await voucherOf(session, c, tokens("0.3")), splits: splits() });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.accepted, true);
  r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: c, voucher: await voucherOf(session, c, tokens("0.3")) });
  assert.deepEqual([r.status, r.json.accepted, r.json.reason], [200, false, "not_newer"]);
  r = await post("/v1/vouchers", { merchant: otherMerchant.address, channelConfig: c, voucher: await voucherOf(session, c, tokens("0.4")) });
  assert.deepEqual([r.status, r.json.error], [403, "wrong_merchant"]);
  r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: c, voucher: await voucherOf(other, c, tokens("0.4")) });
  assert.deepEqual([r.status, r.json.error], [400, "bad_voucher_signature"]);
  r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: c, voucher: await voucherOf(session, c, tokens("2.1")) });
  assert.deepEqual([r.status, r.json.error], [400, "over_deposit"]);
  r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: { ...c, salt: keccak256(stringToHex("other")) }, voucher: await voucherOf(session, c, tokens("0.4")) });
  assert.deepEqual([r.status, r.json.error], [400, "invalid_request"]);

  r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: c, voucher: await voucherOf(session, c, tokens("0.6")) });
  assert.equal(r.json.accepted, true);
  await keeper.idle();
  const id = channelId(c);
  assert.equal((await readChannel(fork.client, d.batchSettlement, id)).totalClaimed, 0n, "nothing claimed below 1 token");

  const crank = keys.crankFor(merchant.address);
  const crankEthBefore = await fork.client.getBalance({ address: crank.address });
  r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: c, voucher: await voucherOf(session, c, tokens("1.2")) });
  assert.equal(r.json.accepted, true);
  await keeper.idle();
  assert.equal((await readChannel(fork.client, d.batchSettlement, id)).totalClaimed, tokens("1.2"), "the keeper claimed 1.2 on its own (threshold 1 token)");
  assert.equal(crankEthBefore, 0n);
  assert.ok((await fork.client.getBalance({ address: crank.address })) > 0n, "the fee payer funded the crank's gas");

  r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: c, voucher: await voucherOf(session, c, tokens("1.5")) });
  assert.equal(r.json.accepted, true);
  await keeper.idle();
  assert.equal((await readChannel(fork.client, d.batchSettlement, id)).totalClaimed, tokens("1.2"), "0.3 more is below the threshold");

  // The buyer asks to close; one watch pass claims 1.5, refunds 0.5 and pays out.
  await buyerRequestsClose(c, session);
  assert.notEqual((await readChannel(fork.client, d.batchSettlement, id)).pendingWithdrawal, null);
  await keeper.pass();
  await keeper.idle();
  const ch = await readChannel(fork.client, d.batchSettlement, id);
  assert.equal(ch.totalClaimed, tokens("1.5"), "claimed at the last voucher");
  assert.equal(ch.balance, ch.totalClaimed, "no unclaimed escrow left");
  // The refund took what the buyer's pending withdrawal asked for; what is left of it can withdraw nothing.
  assert.ok(ch.pendingWithdrawal === null || ch.balance - ch.totalClaimed === 0n);
  const paid = tokens("1.5");
  assert.equal((await balance(sellerVault)) - sellerBefore, paid - share(paid), "seller vault got 1.5 minus the 30 bps keeper fee");
  assert.equal((await balance(feeRecipient)) - feeBefore, share(paid), "the keeper fee recipient got 30 bps");
  assert.equal((await balance(buyerVault)) - buyerBefore, tokens("0.5"), "buyer vault got its unspent 0.5 back");
  assert.equal(await balance(sellerSplit), 0n, "the split holds nothing after release");
  assert.equal((await store.load(id.toLowerCase()))?.done, true);
});

test("a seller's close request must be signed by its merchant key and the crank must be the keeper's", async () => {
  const { config: c, session } = await openChannel({ amount: tokens("0.5") }, "channel B");
  const id = channelId(c);
  const sellerBefore = await balance(sellerVault);
  const buyerBefore = await balance(buyerVault);
  const sign = async (who: PrivateKeyAccount) => who.signMessage({ message: { raw: closeRequestMessage(ROBINHOOD_CHAIN_ID, id) } });

  let r = await post("/v1/close", { merchant: otherMerchant.address, channelConfig: c, signature: await sign(otherMerchant), splits: splits() });
  assert.deepEqual([r.status, r.json.error], [403, "not_keeper_crank"]);
  r = await post("/v1/close", { merchant: merchant.address, channelConfig: c, signature: await sign(otherMerchant), splits: splits() });
  assert.deepEqual([r.status, r.json.error], [403, "bad_signature"]);
  r = await post("/v1/close", { merchant: merchant.address, channelConfig: c, signature: await sign(merchant), voucher: await voucherOf(session, c, tokens("0.2")), splits: splits() });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(String(r.json.tx), /^0x[0-9a-f]{64}$/);
  const ch = await readChannel(fork.client, d.batchSettlement, id);
  assert.equal(ch.totalClaimed, tokens("0.2"));
  assert.equal(ch.balance, ch.totalClaimed);
  assert.equal((await balance(sellerVault)) - sellerBefore, tokens("0.2") - share(tokens("0.2")));
  assert.equal((await balance(buyerVault)) - buyerBefore, tokens("0.3"));
  // Closing a closed channel again changes nothing and still answers.
  r = await post("/v1/close", { merchant: merchant.address, channelConfig: c, signature: await sign(merchant) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test("an unclaimed voucher is claimed once it is an hour old", async () => {
  const { config: c, session } = await openChannel({ amount: tokens("0.5") }, "channel C");
  const id = channelId(c);
  const r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: c, voucher: await voucherOf(session, c, tokens("0.1")), splits: splits() });
  assert.equal(r.json.accepted, true);
  await keeper.idle();
  await keeper.pass();
  await keeper.idle();
  assert.equal((await readChannel(fork.client, d.batchSettlement, id)).totalClaimed, 0n);
  await fork.increaseTime(3_600);
  await keeper.pass();
  await keeper.idle();
  assert.equal((await readChannel(fork.client, d.batchSettlement, id)).totalClaimed, tokens("0.1"), "claimed by age");
});

test("channels the keeper must not guard are refused", async () => {
  // A split that does not pay the keeper fee.
  const bare = await splitOf(sellerVault, []);
  const { config: noFee, session: s1 } = await openChannel({ amount: tokens("0.1"), receiver: bare }, "no fee");
  let r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: noFee, voucher: await voucherOf(s1, noFee, tokens("0.05")), splits: [] });
  assert.deepEqual([r.status, r.json.error], [403, "keeper_fee_missing"]);
  r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: noFee, voucher: await voucherOf(s1, noFee, tokens("0.05")), splits: splits() });
  assert.deepEqual([r.status, r.json.error], [400, "wrong_splits"]);
  // The receiverAuthorizer is not an Ostra vault.
  const { config: notVault, session: s2 } = await openChannel({ amount: tokens("0.1"), receiverAuthorizer: relayer.address }, "not a vault");
  r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: notVault, voucher: await voucherOf(s2, notVault, tokens("0.05")), splits: splits() });
  assert.deepEqual([r.status, r.json.error], [403, "not_ostra_vault"]);
  // A channel that was never funded.
  const ghost = { ...noFee, salt: keccak256(stringToHex("never opened")) };
  r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: ghost, voucher: await voucherOf(s1, ghost, tokens("0.05")), splits: splits() });
  assert.deepEqual([r.status, r.json.error], [404, "not_found"]);
  // Another token than the keeper's.
  r = await post("/v1/vouchers", { merchant: merchant.address, channelConfig: { ...ghost, token: d.pool as Hex }, voucher: await voucherOf(s1, { ...ghost, token: d.pool }, tokens("0.05")) });
  assert.deepEqual([r.status, r.json.error], [403, "wrong_mint"]);
});

test("records survive a restart", async () => {
  const again = await Keeper.open({ client: fork.client, config, keys, store, sender, decimals: 6, redact: (t) => t });
  const before = await keeper.health();
  const after = await again.health();
  assert.equal(after.guarded, before.guarded);
  assert.ok(after.guarded >= 1, "channel C is still guarded");
});
