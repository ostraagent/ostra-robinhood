// The parts of the core package that need no chain: amounts, encodings, the
// key derivations, the pending-spend decoders, the relayer client's checks,
// the channel rules and records, sessions, approvals and unshield timing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, encodeFunctionData, getAddress, keccak256, recoverAddress, recoverMessageAddress, recoverTypedDataAddress, stringToHex, zeroAddress, type Hex } from "viem";
import {
  CHAINLINK_ETH_USD,
  MAX_RELAY_CALLS,
  OSTRAPAD,
  PAD_KEM_DOMAIN,
  ROBINHOOD_CHAIN_ID,
  USDG,
  VAULT_ACTION,
  WotsKeychain,
  approvalMessage,
  closeDigest,
  ostraVaultAbi,
  padKemKeys,
  padKemSeed,
  padKeyCommit,
  padNewJobKey,
  padPostingAccount,
  padReserveMessage,
  padWrapKey,
  signAgentSpend,
  signVaultOpenChannel,
  signVaultSetCrankKey,
  signVaultTransfer,
  transferParams,
  vaultChannelConfig,
  voucherTypedData,
  type WotsSignatureRecord,
  type WotsStore,
} from "@ostraagent/sdk";
import {
  ChannelStore,
  Keys,
  RELAYER_CHANNEL_DEPOSIT,
  TRANSFER_WITH_AUTHORIZATION_TYPE,
  agentKeychainId,
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
  exactOfferProblem,
  parseAutonomoGateways,
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
  notLandedError,
  relayerSpendPlan,
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

test("the agent's seed operations (AgentSeed) answer as the seed's own keychains and keys do", async () => {
  const k = keys();
  const vault = A(0xb5);
  const chain = new WotsKeychain(MASTER, agentKeychainId(ROBINHOOD_CHAIN_ID, vault), new MemoryWotsStore());
  // The agent key roots: this seed's agent keychain of the vault, per vault and chain.
  assert.equal(await k.agentKeyRoot(ROBINHOOD_CHAIN_ID, vault, 3n), bytesToHex(chain.keyRoot(3n)));
  assert.notEqual(await k.agentKeyRoot(ROBINHOOD_CHAIN_ID, vault, 3n), await k.agentKeyRoot(ROBINHOOD_CHAIN_ID, A(0xb6), 3n));
  assert.notEqual(await k.agentKeyRoot(ROBINHOOD_CHAIN_ID, vault, 3n), await k.agentKeyRoot(ROBINHOOD_CHAIN_ID + 1, vault, 3n));
  // An agent spend: the same signature as the keychain's (WOTS signs deterministically), recorded, and one key signs once.
  const spendKey = { vault, agentNonce: 4n, keyRoot: bytesToHex(chain.keyRoot(0n)), vaultKeyRoot: keccak256(stringToHex("vault key")), index: 0n, nextIndex: 1n };
  const a = { chainId: ROBINHOOD_CHAIN_ID, action: VAULT_ACTION.TRANSFER, params: transferParams({ to: A(0xc1), amount: 5n }) } as const;
  assert.equal(await k.agentSigned(ROBINHOOD_CHAIN_ID, vault, 0n), undefined);
  const signed = await k.signAgentSpend(spendKey, a);
  assert.deepEqual(signed, await signAgentSpend(chain, spendKey, a));
  assert.equal((await k.agentRecorded(ROBINHOOD_CHAIN_ID, vault, 0n))?.signature, signed.signature.slice(2));
  assert.equal((await k.agentSigned(ROBINHOOD_CHAIN_ID, vault, 0n))?.message, bytesToHex(signed.message).slice(2));
  assert.equal(await k.agentRecorded(ROBINHOOD_CHAIN_ID, A(0xb6), 0n), undefined);
  await assert.rejects(k.signAgentSpend({ ...spendKey, nextIndex: 2n }, a));
  // Ostrapad's private jobs: the posting key signs Ostrapad's messages built from their fields.
  const poster = await k.padPosting(ROBINHOOD_CHAIN_ID, OSTRAPAD);
  assert.equal(poster.address, padPostingAccount(MASTER, ROBINHOOD_CHAIN_ID, OSTRAPAD).address);
  const reserve = { jobId: keccak256(stringToHex("job")), bytes: 1000n, seq: 2n };
  const posted = await poster.signPost({ kind: "reserve", ...reserve });
  assert.equal(await recoverMessageAddress({ message: { raw: padReserveMessage({ chainId: ROBINHOOD_CHAIN_ID, pad: OSTRAPAD, ...reserve }) }, signature: posted }), poster.address);
  const pk = await k.padKemPublicKey(ROBINHOOD_CHAIN_ID, OSTRAPAD);
  assert.deepEqual(pk, padKemKeys(padKemSeed(MASTER, PAD_KEM_DOMAIN.mcp, ROBINHOOD_CHAIN_ID, OSTRAPAD)).publicKey);
  const jobKey = padNewJobKey();
  const ctx = { chainId: ROBINHOOD_CHAIN_ID, pad: OSTRAPAD, jobId: keccak256(stringToHex("job")), round: 0 };
  const wrap = padWrapKey(jobKey, ctx, A(0xd1), pk);
  assert.deepEqual(await k.padUnwrap(ROBINHOOD_CHAIN_ID, OSTRAPAD, wrap, A(0xd1), padKeyCommit(jobKey)), jobKey);
  assert.equal(await k.padUnwrap(ROBINHOOD_CHAIN_ID, OSTRAPAD, wrap, A(0xd2), padKeyCommit(jobKey)), null);
  assert.equal(await keys().padUnwrap(ROBINHOOD_CHAIN_ID + 1, OSTRAPAD, wrap, A(0xd1), padKeyCommit(jobKey)), null);
  // A channel's voucher key: x402 Vouchers and close requests, nothing else.
  const salt = keccak256(stringToHex("salt"));
  const voucher = await k.channelVoucherSigner(ROBINHOOD_CHAIN_ID, USDG, salt);
  assert.equal(voucher.address, await k.voucherAddress(ROBINHOOD_CHAIN_ID, USDG, salt));
  const v = voucherTypedData({ channelId: keccak256(stringToHex("channel")), maxClaimableAmount: 7n, chainId: ROBINHOOD_CHAIN_ID });
  const vSig = await voucher.signTypedData(v);
  assert.equal(await recoverTypedDataAddress({ ...v, signature: vSig }), voucher.address);
  assert.equal(vSig, await k.signVoucher(ROBINHOOD_CHAIN_ID, USDG, salt, v.message));
  // A field the operation does not take (another settlement contract) changes nothing.
  assert.equal(await k.signVoucher(ROBINHOOD_CHAIN_ID, USDG, salt, { ...v.message, settlement: A(0xaa) } as never), vSig);
  // As the x402 client hands it over: the amount as a decimal string.
  assert.equal(await voucher.signTypedData({ ...v, message: { ...v.message, maxClaimableAmount: "7" } } as never), vSig);
  const close = { vault: A(0xb5), channelId: keccak256(stringToHex("channel")), amount: 5n, nonce: 1n, deadline: 1_800_000_000n };
  const cSig = await voucher.signClose(close);
  assert.equal(await recoverAddress({ hash: closeDigest({ chainId: ROBINHOOD_CHAIN_ID, ...close }), signature: cSig }), voucher.address);
  await assert.rejects(voucher.signMessage({ message: "hello" }), /signs only/);
  await assert.rejects(voucher.signTypedData({ ...v, domain: { ...v.domain, verifyingContract: A(0x99) } }), /signs only/);
  await assert.rejects(voucher.signTypedData({ ...v, domain: { ...v.domain, chainId: ROBINHOOD_CHAIN_ID + 1 } }), /signs only/);
  await assert.rejects(voucher.signTypedData({ ...v, primaryType: "Other", types: { Other: v.types.Voucher } } as never), /signs only/);
  await assert.rejects(voucher.signTypedData({ ...v, message: { ...v.message, extra: 1n } } as never), /signs only/);
  // The payment wallet: EIP-3009 transfers from itself on its own token, nothing else.
  const wallet = await k.paymentWalletSigner(ROBINHOOD_CHAIN_ID, USDG, vault);
  assert.equal(wallet.address, await k.paymentWalletAddress(ROBINHOOD_CHAIN_ID, USDG, vault));
  const transfer = {
    domain: { name: "Global Dollar", version: "1", chainId: ROBINHOOD_CHAIN_ID, verifyingContract: USDG },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPE },
    primaryType: "TransferWithAuthorization",
    message: { from: wallet.address, to: A(0xc2), value: 3n, validAfter: 0n, validBefore: 1_800_000_000n, nonce: keccak256(stringToHex("n")) },
  } as const;
  const tSig = await wallet.signTypedData(transfer);
  assert.equal(await recoverTypedDataAddress({ ...transfer, signature: tSig }), wallet.address);
  await assert.rejects(wallet.signTypedData({ ...transfer, message: { ...transfer.message, from: A(0xc3) } }), /signs only/);
  await assert.rejects(wallet.signTypedData({ ...transfer, domain: { ...transfer.domain, verifyingContract: A(0xc4) } }), /signs only/);
  await assert.rejects(wallet.signTypedData(v as never), /signs only/);
  await assert.rejects(wallet.signMessage({ message: "hello" }), /signs only/);
  // The Tide link secret: per chain and OstraTide, the same from the same seed.
  assert.match(await k.tideSecret(ROBINHOOD_CHAIN_ID, A(0xe1)), /^0x[0-9a-f]{64}$/);
  assert.equal(await k.tideSecret(ROBINHOOD_CHAIN_ID, A(0xe1)), await keys().tideSecret(ROBINHOOD_CHAIN_ID, A(0xe1)));
  assert.notEqual(await k.tideSecret(ROBINHOOD_CHAIN_ID, A(0xe1)), await k.tideSecret(ROBINHOOD_CHAIN_ID, A(0xe2)));
});

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

test("key derivations: separate per vault kind, chain, token and index; secp256k1 accounts", async () => {
  const k = keys();
  const v = vaultKeychainId(ROBINHOOD_CHAIN_ID, USDG);
  assert.notEqual(bytesToHex(v), bytesToHex(sellerKeychainId(ROBINHOOD_CHAIN_ID, USDG)));
  assert.notEqual(bytesToHex(v), bytesToHex(vaultKeychainId(ROBINHOOD_CHAIN_ID + 1, USDG)));
  assert.notEqual(bytesToHex(v), bytesToHex(vaultKeychainId(ROBINHOOD_CHAIN_ID, A(1))));
  assert.notEqual(bytesToHex(shieldApprovalKeychainId(ROBINHOOD_CHAIN_ID, USDG, 0n)), bytesToHex(shieldLeafKeychainId(ROBINHOOD_CHAIN_ID, USDG, 0n)));
  assert.notEqual(bytesToHex(privateVaultKeychainId(ROBINHOOD_CHAIN_ID, USDG, 0n)), bytesToHex(privateVaultKeychainId(ROBINHOOD_CHAIN_ID, USDG, 1n)));
  const salt1 = keccak256(stringToHex("a"));
  const salt2 = keccak256(stringToHex("b"));
  assert.equal((await k.channelVoucherSigner(ROBINHOOD_CHAIN_ID, USDG, salt1)).address, (await keys().channelVoucherSigner(ROBINHOOD_CHAIN_ID, USDG, salt1)).address);
  assert.notEqual((await k.channelVoucherSigner(ROBINHOOD_CHAIN_ID, USDG, salt1)).address, (await k.channelVoucherSigner(ROBINHOOD_CHAIN_ID, USDG, salt2)).address);
  assert.notEqual(k.shieldSigner(ROBINHOOD_CHAIN_ID, USDG, 0n).address, k.shieldSigner(ROBINHOOD_CHAIN_ID, USDG, 1n).address);
  assert.notEqual(k.shieldDepositId(ROBINHOOD_CHAIN_ID, USDG, 0n), k.shieldDepositId(ROBINHOOD_CHAIN_ID, USDG, 1n));
  assert.match(k.merchantKey(ROBINHOOD_CHAIN_ID, USDG), /^0x[0-9a-f]{64}$/);
  assert.notEqual(k.selfCrankSigner(ROBINHOOD_CHAIN_ID, USDG).address, accountFromSecret(new Uint8Array(32).fill(9)).address);
  // The payment wallet: one per vault, chain and token, the same from the same seed.
  const wallet = (await k.paymentWalletSigner(ROBINHOOD_CHAIN_ID, USDG, A(0xa1))).address;
  assert.equal(wallet, (await keys().paymentWalletSigner(ROBINHOOD_CHAIN_ID, USDG, A(0xa1))).address);
  assert.notEqual(wallet, (await k.paymentWalletSigner(ROBINHOOD_CHAIN_ID, USDG, A(0xa2))).address);
  assert.notEqual(wallet, (await k.paymentWalletSigner(ROBINHOOD_CHAIN_ID + 1, USDG, A(0xa1))).address);
  assert.notEqual(wallet, (await k.paymentWalletSigner(ROBINHOOD_CHAIN_ID, A(1), A(0xa1))).address);
  assert.notEqual(wallet, k.selfCrankSigner(ROBINHOOD_CHAIN_ID, USDG).address);
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

test("notLandedError names the relayer's last not_sent reason, at most 500 characters, or none", () => {
  const reason = "the transaction needs 110124 gas now, more than the 106986 it was priced for, so it was not sent; sent again, it is priced anew";
  assert.equal(notLandedError(3, reason).message, `the relayer could not land the request in 3 attempts; it answered last: ${reason}`);
  assert.equal(notLandedError(3, "  ").message, "the relayer could not land the request in 3 attempts");
  assert.equal(notLandedError(3, "x".repeat(900)).message.length, "the relayer could not land the request in 3 attempts; it answered last: ".length + 500);
});

test("relayerSpendPlan replays reserve's payment: channel room first, then a new channel from the vault", () => {
  // Mainnet-sized: a spend reserved at 0.02 USDG, an open's own spend 0.02, a debt of 0.01.
  const a = 20_000n;
  const base = { amounts: [a, a], debt: 10_000n, openCost: 20_000n };
  // Without debt, a channel with room for both: nothing else needed; room for one only and an empty vault: the second
  // cannot be paid.
  assert.equal(relayerSpendPlan({ ...base, debt: 0n, rooms: [2n * a], balance: 0n }), true);
  assert.equal(relayerSpendPlan({ ...base, debt: 0n, rooms: [a], balance: 0n }), false);
  // In debt, room in a channel does not pay (the relayer takes only an open then): an empty vault cannot pay at all;
  // with what one open needs, its leftover room pays the second.
  assert.equal(relayerSpendPlan({ ...base, rooms: [10n * a], balance: 0n }), false);
  assert.equal(relayerSpendPlan({ ...base, rooms: [10n * a], balance: base.debt + base.openCost + 2n * a }), true);
  // No channel: one open pays the debt, its own spend and the first; its deposit (all the vault holds, under
  // RELAYER_CHANNEL_DEPOSIT) must leave room for the second.
  const need = base.debt + base.openCost + 2n * a;
  assert.equal(relayerSpendPlan({ ...base, rooms: [], balance: need }), true);
  assert.equal(relayerSpendPlan({ ...base, rooms: [], balance: need - 1n }), false);
  // Over RELAYER_CHANNEL_DEPOSIT the deposit is that much, which leaves the second spend room too.
  assert.equal(relayerSpendPlan({ ...base, rooms: [], balance: 5_000_000n }), true);
  // Fork-sized spends (over a deposit each): the second needs a second open, without the debt.
  const big = { amounts: [1_200_000n, 1_200_000n], rooms: [], debt: 100_000n, openCost: 1_300_000n };
  const two = big.debt + big.openCost + 1_200_000n + big.openCost + 1_200_000n;
  assert.equal(relayerSpendPlan({ ...big, balance: two }), true);
  assert.equal(relayerSpendPlan({ ...big, balance: two - 1n }), false);
});

test("the payment wallet pays x402 exact offers in USDG on Robinhood Chain by EIP-3009 only", () => {
  const network = `eip155:${ROBINHOOD_CHAIN_ID}`;
  // Autonomo's token-price offer, as its 402 named it on 8 Nov 2026.
  const offer = {
    scheme: "exact",
    network,
    amount: "10000",
    asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    payTo: "0xc66181e50aF128ffEe6048E8d4097bDC84776313",
    maxTimeoutSeconds: 300,
    extra: { name: "Global Dollar", version: "1" },
  } as never;
  const o = offer as { [k: string]: unknown };
  assert.equal(exactOfferProblem(offer, network, USDG), null);
  assert.equal(exactOfferProblem({ ...o, asset: String(o.asset).toLowerCase() } as never, network, USDG), null);
  assert.equal(exactOfferProblem({ ...o, extra: { name: "Global Dollar", version: "1", assetTransferMethod: "eip3009" } } as never, network, USDG), null);
  assert.match(exactOfferProblem({ ...o, scheme: "batch-settlement" } as never, network, USDG) ?? "", /^batch-settlement/);
  assert.match(exactOfferProblem({ ...o, network: "eip155:8453" } as never, network, USDG) ?? "", /on eip155:8453/);
  assert.match(exactOfferProblem({ ...o, asset: A(0xe8) } as never, network, USDG) ?? "", /in 0x/);
  assert.match(exactOfferProblem({ ...o, extra: { name: "Global Dollar", version: "1", assetTransferMethod: "permit2" } } as never, network, USDG) ?? "", /through permit2/);
  assert.match(exactOfferProblem({ ...o, extra: {} } as never, network, USDG) ?? "", /EIP-712 name and version/);
});

test("Autonomo's gateway list: the gateways priced in USDG under autonomo.fun, each with how to call it", () => {
  // The first two entries of https://autonomo.fun/api/v1/gateways as it answered on 8 Nov 2026, and two that are refused.
  const body = {
    data: [
      {"slug":"token-price","name":"Token Price","description":"show live $autonomo token price, just an example of an api","url":"https://autonomo.fun/x/token-price","usage":"/price/autonomo","price":{"autonomo":100,"usdg":0.01},"project":"https://autonomo.fun/projects/token-price","verified":true,"trackRecord":{"windowDays":30,"new":true,"outsidePayers":1,"repeatPayers":1,"privateCalls":0,"paidCalls":38,"settledCalls":35,"refusedCalls":4,"failedCalls":0,"successRate":1,"medianMs":3379,"liveSince":"2026-10-28T12:40:15.245Z"}},
      {"slug":"new-launches","name":"New Launches","description":"Newest token launches on Robinhood Chain: name, age, buys, sells, market cap and bonding curve progress for each new token.","url":"https://autonomo.fun/x/new-launches","usage":"/launches?limit=10","price":{"autonomo":100,"usdg":0.01},"project":"https://autonomo.fun/projects/new-launches","verified":true,"trackRecord":{"windowDays":30,"new":true,"outsidePayers":2,"repeatPayers":1,"privateCalls":0,"paidCalls":24,"settledCalls":22,"refusedCalls":2,"failedCalls":0,"successRate":1,"medianMs":2516,"liveSince":"2026-10-29T02:26:00.553Z"}},
      { slug: "elsewhere", name: "Elsewhere", url: "https://example.com/x/elsewhere", usage: "/a", price: { usdg: 0.01 } },
      { slug: "no-usdg", name: "No USDG", url: "https://autonomo.fun/x/no-usdg", usage: "/a", price: { autonomo: 100 } },
      { slug: "plain", name: "Plain", url: "http://autonomo.fun/x/plain", usage: "/a", price: { usdg: 0.01 } },
      { slug: "other-path", name: "Other path", url: "https://autonomo.fun/y/other-path", usage: "/a", price: { usdg: 0.01 } },
      { slug: "fragment", name: "Fragment", url: "https://autonomo.fun/x/fragment#", usage: "/a", price: { usdg: 0.01 } },
      { slug: "no-slash", name: "No slash", url: "https://autonomo.fun/x/no-slash", usage: "a", price: { usdg: 0.01 } },
    ],
  };
  const { gateways, skipped, cut } = parseAutonomoGateways(body);
  assert.equal(skipped, 6);
  assert.equal(cut, 0);
  assert.deepEqual(gateways.map((g) => [g.slug, g.example, g.priceUsdg, g.verified]), [
    ["token-price", "https://autonomo.fun/x/token-price/price/autonomo", "0.01", true],
    ["new-launches", "https://autonomo.fun/x/new-launches/launches?limit=10", "0.01", true],
  ]);
  assert.deepEqual(gateways[0]!.trackRecord, { windowDays: 30, paidCalls: 38, settledCalls: 35, failedCalls: 0, successRate: 1, medianMs: 3379, outsidePayers: 1, repeatPayers: 1, liveSince: "2026-10-28T12:40:15.245Z" });
  assert.throws(() => parseAutonomoGateways({}), /no data array/);
  // At most 50 gateways, descriptions cut to 500 characters, prices never as an exponent.
  const many = Array.from({ length: 60 }, (_, i) => ({ slug: `g${i}`, name: `G${i}`, description: "d".repeat(900), url: `https://autonomo.fun/x/g${i}`, usage: "/a", price: { usdg: 0.0000001 + i } }));
  const big = parseAutonomoGateways({ data: many });
  assert.equal(big.gateways.length, 50);
  assert.equal(big.cut, 10);
  assert.equal(big.gateways[0]!.description.length, 500);
  assert.equal(big.gateways[0]!.priceUsdg, "0");
  assert.equal(big.gateways[1]!.priceUsdg, "1");
});
