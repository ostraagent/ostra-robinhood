// The parts of the core package that need no chain: amounts, encodings, the
// key derivations, the pending-spend decoders, the relayer client's checks,
// the channel rules and records, sessions, approvals and unshield timing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, encodeFunctionData, getAddress, keccak256, stringToHex, zeroAddress, type Hex } from "viem";
import {
  CHAINLINK_ETH_USD,
  MAX_RELAY_CALLS,
  ROBINHOOD_CHAIN_ID,
  USDG,
  WotsKeychain,
  approvalMessage,
  ostraVaultAbi,
  signVaultOpenChannel,
  signVaultSetCrankKey,
  signVaultTransfer,
  vaultChannelConfig,
  type WotsSignatureRecord,
  type WotsStore,
} from "@ostraagent/sdk";
import {
  ChannelStore,
  Keys,
  RELAYER_CHANNEL_DEPOSIT,
  SessionStore,
  UNSHIELD_MAX_WINDOW_HOURS,
  accountFromSecret,
  channelMoved,
  channelStatus,
  checkRelayerFacts,
  decodeApproveMessage,
  decodeVaultOpenChannelMessage,
  decodeVaultSetCrankKeyMessage,
  decodeVaultSpendHeader,
  decodeVaultTransferMessage,
  formatEth,
  formatTokenAmount,
  fromBase64Url,
  isPrivateKey,
  openChannelCall,
  parseGracePeriod,
  parseRecipients,
  parseTokenAmount,
  payCapacity,
  privateVaultKeychainId,
  relayerChannelDeposit,
  relayerOfferProblem,
  sellerKeychainId,
  shieldApprovalKeychainId,
  shieldLeafKeychainId,
  unshieldDelaySeconds,
  vaultKeychainId,
  type ChannelRecord,
} from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";

class MemoryWotsStore implements WotsStore {
  readonly #records = new Map<string, WotsSignatureRecord>();
  async load(keychainId: Uint8Array, index: bigint): Promise<WotsSignatureRecord | undefined> {
    return this.#records.get(`${bytesToHex(keychainId)}:${index}`);
  }
  async saveIfAbsent(record: WotsSignatureRecord): Promise<boolean> {
    const k = `0x${record.keychain}:${record.index}`;
    if (this.#records.has(k)) return false;
    this.#records.set(k, record);
    return true;
  }
}

const MASTER = new Uint8Array(32).fill(7);
const keys = (folder = new MemoryFolder()) =>
  new Keys({ master: MASTER, feePayer: accountFromSecret(new Uint8Array(32).fill(9)), store: new MemoryWotsStore(), folder, backupExported: async () => false });
const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

test("token amounts and ETH format as before", () => {
  assert.equal(parseTokenAmount("1.25"), 1_250_000n);
  assert.equal(parseTokenAmount("0.000001"), 1n);
  assert.throws(() => parseTokenAmount("1.2345678"));
  assert.throws(() => parseTokenAmount("-1"));
  assert.equal(formatTokenAmount(1_250_000n), "1.25");
  assert.equal(formatTokenAmount(10_000_000n), "10");
  assert.equal(formatEth(1_500_000_000_000_000_000n), "1.5");
  assert.equal(formatEth(1n), "0.000000000000000001");
});

test("base64url decodes without Buffer", () => {
  assert.deepEqual([...fromBase64Url("AQID")], [1, 2, 3]);
  assert.deepEqual([...fromBase64Url("-_8")], [251, 255]);
  assert.throws(() => fromBase64Url("a+b"));
});

test("key derivations: separate per vault kind, chain, token and index; secp256k1 accounts", () => {
  const k = keys();
  const v = vaultKeychainId(ROBINHOOD_CHAIN_ID, USDG);
  assert.notEqual(bytesToHex(v), bytesToHex(sellerKeychainId(ROBINHOOD_CHAIN_ID, USDG)));
  assert.notEqual(bytesToHex(v), bytesToHex(vaultKeychainId(ROBINHOOD_CHAIN_ID + 1, USDG)));
  assert.notEqual(bytesToHex(v), bytesToHex(vaultKeychainId(ROBINHOOD_CHAIN_ID, A(1))));
  assert.notEqual(bytesToHex(shieldApprovalKeychainId(ROBINHOOD_CHAIN_ID, USDG, 0n)), bytesToHex(shieldLeafKeychainId(ROBINHOOD_CHAIN_ID, USDG, 0n)));
  assert.notEqual(bytesToHex(privateVaultKeychainId(ROBINHOOD_CHAIN_ID, USDG, 0n)), bytesToHex(privateVaultKeychainId(ROBINHOOD_CHAIN_ID, USDG, 1n)));
  const salt1 = keccak256(stringToHex("a"));
  const salt2 = keccak256(stringToHex("b"));
  assert.equal(k.channelVoucherSigner(ROBINHOOD_CHAIN_ID, USDG, salt1).address, keys().channelVoucherSigner(ROBINHOOD_CHAIN_ID, USDG, salt1).address);
  assert.notEqual(k.channelVoucherSigner(ROBINHOOD_CHAIN_ID, USDG, salt1).address, k.channelVoucherSigner(ROBINHOOD_CHAIN_ID, USDG, salt2).address);
  assert.notEqual(k.shieldSigner(ROBINHOOD_CHAIN_ID, USDG, 0n).address, k.shieldSigner(ROBINHOOD_CHAIN_ID, USDG, 1n).address);
  assert.notEqual(k.shieldDepositId(ROBINHOOD_CHAIN_ID, USDG, 0n), k.shieldDepositId(ROBINHOOD_CHAIN_ID, USDG, 1n));
  assert.match(k.merchantKey(ROBINHOOD_CHAIN_ID, USDG), /^0x[0-9a-f]{64}$/);
  assert.notEqual(k.selfCrankSigner(ROBINHOOD_CHAIN_ID, USDG).address, accountFromSecret(new Uint8Array(32).fill(9)).address);
  assert.equal(isPrivateKey(new Uint8Array(32)), false);
  assert.equal(isPrivateKey(new Uint8Array(32).fill(0xff)), false);
  assert.equal(isPrivateKey(new Uint8Array(32).fill(1)), true);
  assert.throws(() => accountFromSecret(new Uint8Array(32)));
});

test("a private vault's records live in its own folder", async () => {
  const root = new MemoryFolder();
  const k = keys(root);
  const p = await k.forPrivateVault(ROBINHOOD_CHAIN_ID, USDG, 3n);
  await p.folder.write("x", "1");
  assert.equal(await root.folder("private").folder(`${ROBINHOOD_CHAIN_ID}-${USDG}-3`).read("x"), "1");
  assert.equal(p.feePayer.address, k.feePayer.address);
});

test("a stored vault spend decodes back into what it does", async () => {
  const store = new MemoryWotsStore();
  const chain = new WotsKeychain(MASTER, vaultKeychainId(ROBINHOOD_CHAIN_ID, USDG), store);
  const vault = A(0xaa);
  const state = { vault, nonce: 4n, keyRoot: bytesToHex(chain.keyRoot(4n)) };
  const t = await signVaultTransfer(chain, state, { chainId: ROBINHOOD_CHAIN_ID, to: A(5), amount: 123n });
  const tx = decodeVaultTransferMessage(t.message);
  assert.equal(tx.vault, vault);
  assert.equal(tx.nonce, 4n);
  assert.equal(tx.to, A(5));
  assert.equal(tx.amount, 123n);
  assert.equal(decodeVaultSpendHeader(t.message).action, 0);
  assert.throws(() => decodeVaultOpenChannelMessage(t.message));

  const chain2 = new WotsKeychain(MASTER, sellerKeychainId(ROBINHOOD_CHAIN_ID, USDG), store);
  const open = { payerAuthorizer: A(1), receiver: A(2), receiverAuthorizer: A(3), withdrawDelay: 900, salt: keccak256("0x01"), amount: 5n };
  const o = await signVaultOpenChannel(chain2, { vault, nonce: 0n, keyRoot: bytesToHex(chain2.keyRoot(0n)) }, { chainId: ROBINHOOD_CHAIN_ID, open });
  assert.deepEqual(decodeVaultOpenChannelMessage(o.message).open, open);
  const c = await signVaultSetCrankKey(chain2, { vault, nonce: 1n, keyRoot: bytesToHex(chain2.keyRoot(1n)) }, { chainId: ROBINHOOD_CHAIN_ID, crank: zeroAddress });
  assert.equal(decodeVaultSetCrankKeyMessage(c.message).crank, null);
});

test("the relayer's terms are checked", () => {
  const good = {
    chainId: ROBINHOOD_CHAIN_ID,
    token: USDG,
    decimals: 6,
    priceFeed: CHAINLINK_ETH_USD,
    maxCalls: MAX_RELAY_CALLS,
    gracePeriodSeconds: 900,
    feePayer: A(1),
    vault: A(2),
    split: A(3),
    splits: [{ recipient: A(4), bps: 30 }],
  };
  const f = checkRelayerFacts(good, { chainId: ROBINHOOD_CHAIN_ID, token: USDG });
  assert.equal(f.vault, A(2));
  assert.equal(f.split, A(3));
  for (const bad of [
    { chainId: 1 },
    { token: A(9) },
    { decimals: 18 },
    { priceFeed: A(9) },
    { maxCalls: 4 },
    { gracePeriodSeconds: 899 },
    { gracePeriodSeconds: 86_401 },
    { splits: [{ recipient: A(4), bps: 0 }] },
    { splits: [{ recipient: A(4), bps: 30 }, { recipient: A(4), bps: 30 }] },
    { splits: [{ recipient: A(4), bps: 9_000 }, { recipient: A(5), bps: 1_001 }] },
  ]) {
    assert.throws(() => checkRelayerFacts({ ...good, ...bad }, { chainId: ROBINHOOD_CHAIN_ID, token: USDG }), JSON.stringify(bad));
  }
});

test("a relayer channel deposit: at least the default, what is needed, never more than the vault holds", () => {
  assert.equal(relayerChannelDeposit(10n, 5_000_000n), RELAYER_CHANNEL_DEPOSIT);
  assert.equal(relayerChannelDeposit(2_000_000n, 5_000_000n), 2_000_000n);
  assert.equal(relayerChannelDeposit(10n, 500_000n), 500_000n);
  assert.equal(relayerChannelDeposit(10n, 2_000_000n, 1_500_000n), 500_000n);
  assert.throws(() => relayerChannelDeposit(600_000n, 1_000_000n, 500_000n), /fund the vault first/);
});

test("a relayer offer is paid only to the relayer's split, vault and grace, in the token, up to the most accepted", () => {
  const config = { payer: A(1), payerAuthorizer: A(2), receiver: A(3), receiverAuthorizer: A(4), token: USDG, withdrawDelay: 900, salt: keccak256("0x01") };
  const offer = { scheme: "batch-settlement", network: `eip155:${ROBINHOOD_CHAIN_ID}`, asset: USDG, amount: "100", payTo: A(3), maxTimeoutSeconds: 300, extra: { receiverAuthorizer: A(4), withdrawDelay: 900 } };
  const want = { network: `eip155:${ROBINHOOD_CHAIN_ID}`, config, maxAmount: 100n };
  assert.equal(relayerOfferProblem(offer as never, want), null);
  assert.match(String(relayerOfferProblem({ ...offer, amount: "101" } as never, want)), /more than/);
  assert.match(String(relayerOfferProblem({ ...offer, payTo: A(9) } as never, want)), /split/);
  assert.match(String(relayerOfferProblem({ ...offer, extra: { receiverAuthorizer: A(9), withdrawDelay: 900 } } as never, want)), /receiverAuthorizer/);
  assert.match(String(relayerOfferProblem({ ...offer, extra: { receiverAuthorizer: A(4), withdrawDelay: 901 } } as never, want)), /withdrawDelay/);
  assert.match(String(relayerOfferProblem({ ...offer, scheme: "exact" } as never, want)), /batch-settlement/);
  assert.match(String(relayerOfferProblem({ ...offer, asset: A(9) } as never, want)), /in /);
});

test("the OpenChannel spend of a request is found and read into its channel config", async () => {
  const chain = new WotsKeychain(MASTER, vaultKeychainId(ROBINHOOD_CHAIN_ID, USDG), new MemoryWotsStore());
  const vault = A(0xbb);
  const open = { payerAuthorizer: A(1), receiver: A(2), receiverAuthorizer: A(3), withdrawDelay: 900, salt: keccak256("0x02"), amount: 7n };
  const s = await signVaultOpenChannel(chain, { vault, nonce: 0n, keyRoot: bytesToHex(chain.keyRoot(0n)) }, { chainId: ROBINHOOD_CHAIN_ID, open });
  const data = encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [s.action, s.nextKeyRoot, s.params, s.signature] });
  const found = openChannelCall([{ to: A(0xcc), data: "0x12345678" }, { to: vault, data }], vault, USDG);
  assert.deepEqual(found, { config: vaultChannelConfig(vault, USDG, open), amount: 7n });
  assert.equal(openChannelCall([{ to: A(0xcc), data }], vault, USDG), null);
});

test("channel rules: splits as OstraSplit takes them, x402's withdraw delay range", () => {
  assert.deepEqual(parseRecipients([{ recipient: A(1).toLowerCase(), bps: 30 }]), [{ recipient: A(1), bps: 30 }]);
  assert.throws(() => parseRecipients([{ recipient: zeroAddress, bps: 30 }]));
  assert.throws(() => parseRecipients([{ recipient: A(1), bps: 30 }, { recipient: A(1), bps: 30 }]));
  assert.throws(() => parseRecipients([{ recipient: A(1), bps: 10_001 }]));
  assert.throws(() => parseRecipients(Array.from({ length: 33 }, (_, i) => ({ recipient: A(i + 1), bps: 1 }))));
  assert.equal(parseGracePeriod(900), 900);
  assert.equal(parseGracePeriod(2_592_000), 2_592_000);
  assert.throws(() => parseGracePeriod(899));
  assert.throws(() => parseGracePeriod(2_592_001));
  assert.throws(() => parseGracePeriod(900.5));
});

test("channel status and movement from the on-chain state", () => {
  const ch = (balance: bigint, totalClaimed: bigint, initiatedAt?: bigint) => ({ channelId: keccak256("0x03"), balance, totalClaimed, pendingWithdrawal: initiatedAt === undefined ? null : { amount: 1n, initiatedAt } });
  assert.equal(channelStatus(ch(10n, 0n)), "open");
  assert.equal(channelStatus(ch(10n, 10n)), "closed");
  assert.equal(channelStatus(ch(10n, 3n, 5n)), "closing");
  // The keeper refunded the rest: the withdrawal stays recorded, cut down to what was claimed.
  assert.equal(channelStatus(ch(4n, 4n, 5n)), "closed");
  assert.equal(channelMoved(ch(10n, 0n), ch(10n, 0n)), false);
  assert.equal(channelMoved(ch(10n, 0n), ch(10n, 4n)), true);
  assert.equal(channelMoved(ch(10n, 0n), ch(10n, 0n, 7n)), true);
  assert.equal(channelMoved(ch(10n, 0n, 7n), ch(10n, 0n, 8n)), true);
});

test("channel records: stored by salt, listed per chain and token, never replaced by create", async () => {
  const store = new ChannelStore(new MemoryFolder());
  const salt = keccak256("0x04").toLowerCase() as Hex;
  const config = { payer: A(1), payerAuthorizer: A(2), receiver: A(3), receiverAuthorizer: A(4), token: USDG, withdrawDelay: 900, salt };
  const record: ChannelRecord = {
    version: 1,
    salt,
    chainId: ROBINHOOD_CHAIN_ID,
    token: USDG,
    vault: A(1),
    channel: keccak256("0x05").toLowerCase() as Hex,
    config,
    payee: A(4),
    voucherKey: A(2),
    deposit: "5000000",
    gracePeriod: 900,
    recipients: [],
    createdAt: 1,
    closeRequested: false,
    finished: false,
    steps: [],
    pay: { url: "https://x", method: "GET", expiresAt: 2, cumulative: "1000000", voucher: null, closeSent: false, payments: [] },
  };
  await store.create(record);
  await assert.rejects(store.create(record));
  assert.equal((await store.list(ROBINHOOD_CHAIN_ID, USDG)).length, 1);
  assert.equal((await store.list(ROBINHOOD_CHAIN_ID, A(9))).length, 0);
  assert.equal(payCapacity((await store.load(salt)) as ChannelRecord), 4_000_000n);
  await store.remove(salt);
  assert.equal(await store.load(salt), null);
});

test("session keys: stored before use, listed per chain and token, the key matches its record", async () => {
  const store = new SessionStore(new MemoryFolder());
  const r = await store.create({ chainId: ROBINHOOD_CHAIN_ID, token: USDG, payTo: A(7), budget: 5n, now: 100, maxAgeSeconds: 10 });
  assert.equal(r.expiresAt, 110);
  assert.equal((await store.signer(r)).address, r.address);
  assert.equal((await store.list(ROBINHOOD_CHAIN_ID, USDG)).length, 1);
  assert.equal((await store.list(1, USDG)).length, 0);
});

test("a stored approval decodes back into its batch and state", () => {
  const a = { chainId: ROBINHOOD_CHAIN_ID, pool: A(8), key: keccak256("0x06"), batchId: 12n, state: keccak256("0x07"), nextKeyRoot: keccak256("0x08") };
  const decoded = decodeApproveMessage(approvalMessage(a));
  assert.deepEqual(decoded, a);
  assert.throws(() => decodeApproveMessage(new Uint8Array(176)));
});

test("an unshield waits a uniform random time within its window", () => {
  assert.equal(unshieldDelaySeconds(0), 0);
  for (let i = 0; i < 200; i++) {
    const s = unshieldDelaySeconds(1);
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 3600);
  }
  assert.throws(() => unshieldDelaySeconds(UNSHIELD_MAX_WINDOW_HOURS + 1));
  assert.throws(() => unshieldDelaySeconds(-1));
});
