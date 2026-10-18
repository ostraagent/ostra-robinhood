// The WOTS signature escrow: real one-time keys (the SDK's WotsKeychain with
// FileWotsStore in a temporary folder) signing the SDK's own messages, read
// back from relay request calls as the gate reads them. The chain reads
// (readKeyStates) run against the deployed contracts in the fork tests.

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bytesToHex, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import {
  FileWotsStore,
  VAULT_ACTION,
  WotsKeychain,
  devBuyParams,
  launchFromVaultData,
  launchHash,
  launchParams,
  signVaultDevBuy,
  ostraPoolAbi,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  signApproveBatch,
  signSpendLeaf,
  signVaultOpenChannel,
  signVaultSetCrankKey,
  signVaultSwap,
  signVaultTransfer,
  type Deployment,
  type SignedSpend,
} from "@ostraagent/sdk";
import { decodeRelayRequest } from "../src/calls.ts";
import { SignatureEscrow, escrowRecord, keyUsed, wotsClaims, type KeyState, type SignatureRecord } from "../src/signatures.ts";

const CHAIN = 4663;
const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
// Stand-in deployment: only the pool and factory addresses matter here.
const d: Deployment = {
  version: 1,
  chainId: CHAIN,
  token: at(0x5f),
  batchSettlement: at(0x40),
  vaultImplementation: at(0x10),
  vaultBeacon: at(0x11),
  vaultFactory: at(0x12),
  poolImplementation: at(0x13),
  poolBeacon: at(0x14),
  pool: at(0x15),
  splitFactory: at(0x16),
  beaconOwner: at(0x17),
  fromBlock: "1",
};
const vault = at(0xaa01);
const destination = at(0xaa02);
const LEAF = 10_000_000n;
const block = 1_234_567n;

async function keychain(): Promise<{ keys: WotsKeychain; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ostra-escrow-wots-"));
  return { keys: new WotsKeychain(new Uint8Array(32).fill(11), new Uint8Array(32).fill(12), new FileWotsStore(dir)), done: () => rm(dir, { recursive: true, force: true }) };
}

const spendCall = (to: Address, s: SignedSpend) => ({ to, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [s.action, s.nextKeyRoot, s.params, s.signature] }) });
const claimsOf = (calls: { to: Address; data: Hex }[]) => {
  const tx = decodeRelayRequest({ calls });
  return wotsClaims(tx.parsed, tx.calls, d);
};
const vaultState = (keys: WotsKeychain, nonce: bigint): KeyState & { kind: "vault" } => ({ kind: "vault", keyRoot: bytesToHex(keys.keyRoot(nonce)), nonce });

test("spend Transfer: escrowed at the vault's nonce under the key root it recovers", async () => {
  const k = await keychain();
  try {
    const nonce = 3n;
    const state = vaultState(k.keys, nonce);
    const s = await signVaultTransfer(k.keys, { vault, nonce, keyRoot: state.keyRoot }, { chainId: CHAIN, to: destination, amount: 100n });
    const call = spendCall(vault, s);
    const [claim] = claimsOf([call]);
    assert.ok(claim !== undefined && claim.kind === "vault");
    const r = escrowRecord(claim, state, block, 7, CHAIN);
    assert.ok(r !== null);
    assert.equal(r.keyRoot, state.keyRoot.toLowerCase());
    assert.equal(r.kind, "vault");
    assert.equal(r.account, vault);
    assert.equal(r.nonce, "3");
    assert.equal(r.message, bytesToHex(s.message));
    assert.equal(r.signature, s.signature.toLowerCase());
    assert.deepEqual(r.call, { to: vault, data: call.data.toLowerCase() });
    assert.equal(r.block, block.toString());
    assert.equal(r.at, 7);
  } finally {
    await k.done();
  }
});

test("spend: a signature not by the vault's current key is never escrowed", async () => {
  const k = await keychain();
  try {
    const s = await signVaultTransfer(k.keys, { vault, nonce: 3n, keyRoot: bytesToHex(k.keys.keyRoot(3n)) }, { chainId: CHAIN, to: destination, amount: 100n });
    const [claim] = claimsOf([spendCall(vault, s)]);
    assert.ok(claim !== undefined);
    // The vault moved on to nonce 4: its key root is key 4's.
    assert.equal(escrowRecord(claim, vaultState(k.keys, 4n), block, 1, CHAIN), null);
    // Same key root but another nonce: the message the vault would check differs.
    assert.equal(escrowRecord(claim, { kind: "vault", keyRoot: bytesToHex(k.keys.keyRoot(3n)), nonce: 4n }, block, 1, CHAIN), null);
    // No vault at that address.
    assert.equal(escrowRecord(claim, null, block, 1, CHAIN), null);
    // Another chain id signs another message.
    assert.equal(escrowRecord(claim, vaultState(k.keys, 3n), block, 1, 1), null);
  } finally {
    await k.done();
  }
});

test("spend OpenChannel and SetCrankKey: the whole params are signed", async () => {
  const k = await keychain();
  try {
    const open = { payerAuthorizer: at(0xbb01), receiver: at(0xbb02), receiverAuthorizer: at(0xbb03), withdrawDelay: 900, salt: `0x${"07".repeat(32)}` as Hex, amount: 5_000_000n };
    const s1 = await signVaultOpenChannel(k.keys, { vault, nonce: 0n, keyRoot: bytesToHex(k.keys.keyRoot(0n)) }, { chainId: CHAIN, open });
    const [c1] = claimsOf([spendCall(vault, s1)]);
    assert.ok(c1 !== undefined);
    assert.ok(escrowRecord(c1, vaultState(k.keys, 0n), block, 1, CHAIN) !== null);
    // The same signature with another deposit amount is not by that key.
    const tampered = { ...s1, params: `${s1.params.slice(0, -2)}01` as Hex };
    const [c1b] = claimsOf([spendCall(vault, tampered)]);
    assert.ok(c1b !== undefined);
    assert.equal(escrowRecord(c1b, vaultState(k.keys, 0n), block, 1, CHAIN), null);

    const s2 = await signVaultSetCrankKey(k.keys, { vault, nonce: 1n, keyRoot: bytesToHex(k.keys.keyRoot(1n)) }, { chainId: CHAIN, crank: at(0xcc01) });
    const [c2] = claimsOf([spendCall(vault, s2)]);
    assert.ok(c2 !== undefined);
    assert.ok(escrowRecord(c2, vaultState(k.keys, 1n), block, 1, CHAIN) !== null);
  } finally {
    await k.done();
  }
});

test("spendLeaf: escrowed with the pool's leaf amount while the leaf is unspent", async () => {
  const k = await keychain();
  try {
    const leafRoot = bytesToHex(k.keys.keyRoot(9n));
    const s = await signSpendLeaf(k.keys, { index: 9n, leafKeyRoot: leafRoot }, { chainId: CHAIN, pool: d.pool, batchId: 4n, leafIndex: 17, destination, leafAmount: LEAF });
    const call = { to: d.pool, data: encodeFunctionData({ abi: ostraPoolAbi, functionName: "spendLeaf", args: [s.batchId, s.leafIndex, s.destination, s.signature] }) };
    const [claim] = claimsOf([call]);
    assert.ok(claim !== undefined && claim.kind === "leaf");
    const r = escrowRecord(claim, { kind: "leaf", keyRoot: leafRoot, leafAmount: LEAF, spent: false }, block, 1, CHAIN);
    assert.ok(r !== null);
    assert.equal(r.batchId, "4");
    assert.equal(r.leafIndex, 17);
    assert.equal(r.account, d.pool);
    assert.equal(escrowRecord(claim, { kind: "leaf", keyRoot: leafRoot, leafAmount: LEAF, spent: true }, block, 1, CHAIN), null);
    assert.equal(escrowRecord(claim, { kind: "leaf", keyRoot: leafRoot, leafAmount: LEAF + 1n, spent: false }, block, 1, CHAIN), null);
    // A spendLeaf to anything but the deployment's pool is not a claim.
    assert.deepEqual(claimsOf([{ to: destination, data: call.data }]), []);
  } finally {
    await k.done();
  }
});

test("approveBatch: escrowed from the call alone while the deposit is pending", async () => {
  const k = await keychain();
  try {
    const key = `0x${"21".repeat(32)}` as Hex;
    const state = `0x${"22".repeat(32)}` as Hex;
    const current = bytesToHex(k.keys.keyRoot(2n));
    const s = await signApproveBatch(k.keys, { index: 2n, currentKeyRoot: current }, { chainId: CHAIN, pool: d.pool, key, batchId: 6n, state });
    const call = { to: d.pool, data: encodeFunctionData({ abi: ostraPoolAbi, functionName: "approveBatch", args: [s.key, s.batchId, s.state, s.nextKeyRoot, s.signature] }) };
    const [claim] = claimsOf([call]);
    assert.ok(claim !== undefined && claim.kind === "approval");
    const r = escrowRecord(claim, { kind: "approval", keyRoot: current, pending: true }, block, 1, CHAIN);
    assert.ok(r !== null);
    assert.equal(r.depositKey, key);
    assert.equal(r.batchId, "6");
    assert.equal(escrowRecord(claim, { kind: "approval", keyRoot: current, pending: false }, block, 1, CHAIN), null);
  } finally {
    await k.done();
  }
});

test("only Ostra WOTS calls are claims, and a malformed one is refused", async () => {
  const k = await keychain();
  try {
    const s = await signVaultTransfer(k.keys, { vault, nonce: 0n, keyRoot: bytesToHex(k.keys.keyRoot(0n)) }, { chainId: CHAIN, to: destination, amount: 1n });
    const create = { to: d.vaultFactory, data: encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [d.token, bytesToHex(k.keys.keyRoot(0n)), at(0)] }) };
    const claims = claimsOf([create, spendCall(vault, s)]);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.kind, "vault");
    // A spend whose signature is cut short.
    const short = { ...s, signature: s.signature.slice(0, -2) as Hex };
    assert.throws(() => claimsOf([spendCall(vault, short)]), /signature is not 1892 bytes/);
    // A spend whose params do not fit its action.
    const bad = { ...s, params: `${s.params}00` as Hex };
    assert.throws(() => claimsOf([spendCall(vault, bad)]), /params must be 64 bytes/);
  } finally {
    await k.done();
  }
});

test("spend Swap with a referrer: a claim escrowed like any spend", async () => {
  const k = await keychain();
  try {
    const nonce = 5n;
    const state = vaultState(k.keys, nonce);
    const key = { currency0: at(0), currency1: d.token, fee: 0x800000, tickSpacing: 200, hooks: at(0x28cc) };
    const s = await signVaultSwap(k.keys, { vault, nonce, keyRoot: state.keyRoot }, { chainId: CHAIN, token: d.token, swap: { key, zeroForOne: false, amountIn: 10n, minOut: 1n, recipient: destination, referrer: at(0xaa03) } });
    assert.equal((s.params.length - 2) / 2, 352);
    const [claim] = claimsOf([spendCall(vault, s)]);
    assert.ok(claim !== undefined && claim.kind === "vault");
    assert.equal(claim.params, s.params);
    assert.ok(escrowRecord(claim, state, block, 7, CHAIN) !== null);
    // A referrer word with dirty upper bytes, which the vault would refuse, is refused here too.
    const dirty = `${s.params.slice(0, 2 + 288 * 2)}01${s.params.slice(2 + 288 * 2 + 2)}` as Hex;
    assert.throws(() => claimsOf([spendCall(vault, { ...s, params: dirty })]), /referrer is not a clean address word/);
    // Any other length is still refused for a Swap.
    assert.throws(() => claimsOf([spendCall(vault, { ...s, params: `${s.params}${"00".repeat(32)}` as Hex })]), /params must be 352 bytes/);
  } finally {
    await k.done();
  }
});

test("a key is used once the chain moves past it, or its account is gone", () => {
  const root = `0x${"41".repeat(32)}` as Hex;
  const next = `0x${"42".repeat(32)}` as Hex;
  const record = (kind: SignatureRecord["kind"], extra: Partial<SignatureRecord> = {}): SignatureRecord => ({
    keyRoot: root,
    kind,
    account: vault,
    message: "0x",
    signature: "0x",
    call: { to: vault, data: "0x" },
    block: block.toString(),
    at: 0,
    ...extra,
  });
  const v = record("vault", { nonce: "4" });
  assert.equal(keyUsed(v, { kind: "vault", keyRoot: root, nonce: 4n }), false);
  assert.equal(keyUsed(v, { kind: "vault", keyRoot: next, nonce: 5n }), true);
  assert.equal(keyUsed(v, { kind: "vault", keyRoot: root, nonce: 5n }), true);
  assert.equal(keyUsed(v, null), true);
  const a = record("approval");
  assert.equal(keyUsed(a, { kind: "approval", keyRoot: root, pending: true }), false);
  assert.equal(keyUsed(a, { kind: "approval", keyRoot: next, pending: true }), true);
  assert.equal(keyUsed(a, { kind: "approval", keyRoot: root, pending: false }), true);
  assert.equal(keyUsed(a, null), true);
  const l = record("leaf", { leafIndex: 0 });
  assert.equal(keyUsed(l, { kind: "leaf", keyRoot: root, leafAmount: LEAF, spent: false }), false);
  assert.equal(keyUsed(l, { kind: "leaf", keyRoot: root, leafAmount: LEAF, spent: true }), true);
  assert.equal(keyUsed(l, null), true);
  // A state that is not the kind the record names.
  assert.equal(keyUsed(l, { kind: "vault", keyRoot: root, nonce: 0n }), true);
});

test("the escrow keeps one message per key root, on disk, until the key is used", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ostra-escrow-"));
  // One master seed, two WOTS stores: a browser whose records were wiped signs again.
  const first = await keychain();
  const wiped = await keychain();
  try {
    const nonce = 3n;
    const state = vaultState(first.keys, nonce);
    const sent = await signVaultTransfer(first.keys, { vault, nonce, keyRoot: state.keyRoot }, { chainId: CHAIN, to: destination, amount: 100n });
    const other = await signVaultTransfer(wiped.keys, { vault, nonce, keyRoot: state.keyRoot }, { chainId: CHAIN, to: destination, amount: 200n });
    const [c1] = claimsOf([spendCall(vault, sent)]);
    const [c2] = claimsOf([spendCall(vault, other)]);
    assert.ok(c1 !== undefined && c2 !== undefined);
    const r1 = escrowRecord(c1, state, block, 1, CHAIN) as SignatureRecord;
    const r2 = escrowRecord(c2, state, block, 2, CHAIN) as SignatureRecord;
    assert.ok(r1 !== null && r2 !== null);
    assert.equal(r1.keyRoot, r2.keyRoot);
    assert.notEqual(r1.message, r2.message);

    const escrow = await SignatureEscrow.open(dir);
    assert.deepEqual(await escrow.put([r1]), { conflict: null, added: [r1.keyRoot] });
    // The same message again is held as it is.
    assert.deepEqual(await escrow.put([{ ...r1, at: 9, block: "1" }]), { conflict: null, added: [] });
    assert.deepEqual(escrow.get(r1.keyRoot), r1);
    assert.deepEqual(escrow.get(r1.keyRoot.toUpperCase().replace("0X", "0x")), r1);
    // Another message for that key root: refused with the record held.
    assert.deepEqual(await escrow.put([r2]), { conflict: r1, added: [] });
    // All or none: a request whose second signature conflicts stores neither.
    const fresh = { ...r1, keyRoot: `0x${"51".repeat(32)}` };
    assert.deepEqual(await escrow.put([fresh, r2]), { conflict: r1, added: [] });
    assert.equal(escrow.get(fresh.keyRoot), undefined);
    assert.deepEqual(escrow.records(), [r1]);

    const file = join(dir, "relayer-signatures.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, records: { [r1.keyRoot]: r1 } });
    const reopened = await SignatureEscrow.open(dir);
    assert.deepEqual(reopened.get(r1.keyRoot), r1);

    await reopened.remove([r1.keyRoot, fresh.keyRoot]);
    assert.equal(reopened.get(r1.keyRoot), undefined);
    assert.deepEqual((await SignatureEscrow.open(dir)).records(), []);
    // Once the key is used, nothing holds it.
    assert.deepEqual(await reopened.put([r2]), { conflict: null, added: [r2.keyRoot] });
  } finally {
    await first.done();
    await wiped.done();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the escrow folder must be private to its owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ostra-escrow-open-"));
  try {
    await chmod(dir, 0o755);
    await assert.rejects(SignatureEscrow.open(dir), /accessible by other users/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a vault-funded launch: its DevBuy signature is a claim of the creator vault (action 9 over the launch hash), escrowed with the launch call", async () => {
  const k = await keychain();
  try {
    const devBuy = at(0x76);
    const dl: Deployment = { ...d, launchpad: { hook: at(0x70), fees: at(0x71), launchpad: at(0x72), creatorSplit: at(0x73), dispatcher: at(0x74), locker: at(0x75), devBuy, vesting: at(0x77), airdrop: at(0x78), owner: at(0x79) } };
    const nonce = 2n;
    const state = vaultState(k.keys, nonce);
    const p = launchParams({ name: "Escrowed", symbol: "ESC", salt: `0x${"06".repeat(32)}`, quote: d.token, creatorVault: vault, startTick: -400_000 });
    const dev = { quoteIn: 3_000_000n, beneficiary: destination, dividendRecipient: at(0), cliff: 604_800, duration: 86_400 };
    const s = await signVaultDevBuy(k.keys, { vault, nonce, keyRoot: state.keyRoot }, { chainId: CHAIN, devBuy, launch: p, dev });
    const call = { to: devBuy, data: launchFromVaultData(p, dev, s) };
    const tx = decodeRelayRequest({ calls: [call] });
    const [claim] = wotsClaims(tx.parsed, tx.calls, dl);
    assert.ok(claim !== undefined && claim.kind === "vault");
    assert.equal(claim.account, vault);
    assert.equal(claim.action, VAULT_ACTION.DEV_BUY);
    assert.equal(claim.params, devBuyParams({ devBuy, launchHash: launchHash(p, dev), amount: 3_000_000n }));
    const r = escrowRecord(claim, state, block, 9, CHAIN);
    assert.ok(r !== null);
    assert.equal(r.account, vault);
    assert.equal(r.message, bytesToHex(s.message));
    assert.deepEqual(r.call, { to: devBuy, data: call.data.toLowerCase() });
    // The same call to another contract than the deployment's OstraDevBuy carries no claim the escrow keeps.
    const elsewhere = decodeRelayRequest({ calls: [{ to: at(0x99), data: call.data }] });
    assert.deepEqual(wotsClaims(elsewhere.parsed, elsewhere.calls, dl), []);
    // Another launch under the same key is another message: never the escrowed one.
    const other = await signVaultDevBuy(k.keys, { vault, nonce: nonce + 1n, keyRoot: bytesToHex(k.keys.keyRoot(nonce + 1n)) }, { chainId: CHAIN, devBuy, launch: { ...p, symbol: "ESC2" }, dev });
    const [otherClaim] = wotsClaims(...((t) => [t.parsed, t.calls, dl] as const)(decodeRelayRequest({ calls: [{ to: devBuy, data: launchFromVaultData({ ...p, symbol: "ESC2" }, dev, other) }] })));
    assert.ok(otherClaim !== undefined);
    assert.equal(escrowRecord(otherClaim, state, block, 9, CHAIN), null);
  } finally {
    await k.done();
  }
});
