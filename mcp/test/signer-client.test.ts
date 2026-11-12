// A hosted agent's side of Ostra Cloud's signer (src/signer-client.ts) against the real signer (src/signer.ts) on its
// Unix sockets: the gateway's admin requests (create, rotate), a seedless Keys (core keys.ts) whose AgentSeed operations
// are the signer's (signatures that recover to the keys it reports, an agent spend checked as the spend asked for and as
// a WOTS signature, Ostrapad's KEM round trip, records), the agent's own seed refused for everything else (keychains
// when used, the other secrets at once), a token revoked by a rotation, more requests at once than one connection may
// hold, a signer restarted under a live connection, the gateway's admin requests on one connection, an agent key
// search within the signer's work budget, and openKeys and loadConfig for a hosted home.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { getAddress, keccak256, recoverMessageAddress, recoverTypedDataAddress, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  OSTRAPAD,
  ROBINHOOD_CHAIN_ID,
  USDG,
  VAULT_ACTION,
  closeRequestTypedData,
  padKeyCommit,
  padNewJobKey,
  padReserveMessage,
  padWrapKey,
  transferParams,
  voucherTypedData,
  wotsVerify,
  type WotsStore,
} from "@ostraagent/sdk";
import { HostedRefusedError, Keys, TRANSFER_WITH_AUTHORIZATION_TYPE } from "@ostraagent/core";
import { DiskFolder } from "../src/disk.ts";
import { MASTER_FILE, openKeys } from "../src/keys.ts";
import { loadConfig } from "../src/config.ts";
import { ADMIN, Signer, socketPath } from "../src/signer.ts";
import { SignerAdmin, SignerError, SignerSeed } from "../src/signer-client.ts";
import { agentToken } from "../src/signer-protocol.ts";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const adminKey = randomBytes(32);
const sealKey = randomBytes(32);
let dir: string;
let sockets: string;
let signer: Signer;
let admin: SignerAdmin;

async function start(workRate = 100_000): Promise<void> {
  signer = new Signer({ sockets, root: join(dir, "root"), adminKey, sealKey, rate: 1000, workRate });
  await signer.listen();
}

/** A seedless Keys of `agent` over its socket, with the token of its epoch now. */
function seedless(agent: string, epoch: number): { seed: SignerSeed; keys: Keys } {
  const seed = new SignerSeed(socketPath(sockets, agent), agent, agentToken(adminKey, agent, epoch));
  const store: WotsStore = { load: async () => undefined, saveIfAbsent: async () => true };
  const keys = new Keys({ remote: seed, feePayer: privateKeyToAccount(generatePrivateKey()), store, folder: new DiskFolder(join(dir, `home-${agent}`)), backupExported: async () => true, escrow: null });
  return { seed, keys };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ostra-sc-"));
  sockets = join(dir, "s");
  await mkdir(sockets, { mode: 0o750 });
  await start();
  admin = new SignerAdmin(socketPath(sockets, ADMIN), adminKey);
});

after(async () => {
  await signer.close();
  await rm(dir, { recursive: true, force: true });
});

test("the gateway's admin requests: create makes the seed once, rotate raises the epoch; a wrong admin key is refused", async () => {
  assert.deepEqual(await admin.create("carol"), { created: true, epoch: 0 });
  assert.deepEqual(await admin.create("carol"), { created: false, epoch: 0 });
  assert.equal(await admin.rotate("carol"), 1);
  assert.equal(await admin.rotate("carol"), 2);
  const wrong = new SignerAdmin(socketPath(sockets, ADMIN), randomBytes(32));
  await assert.rejects(wrong.create("carol"), (e: Error) => e instanceof SignerError && /not authorized/.test(e.message));
  wrong.close();
  await assert.rejects(admin.create("Not An Id"), RangeError);
  // More than the signer takes new admin connections in a minute (120): one connection carries them all.
  for (let i = 0; i < 150; i++) assert.equal(await admin.rotate("carol"), 3 + i);
});

test("a seedless Keys: every AgentSeed operation is the signer's, checked; the agent's own seed is refused", async () => {
  await admin.create("dave");
  const { seed, keys } = seedless("dave", 0);
  try {
    assert.equal(keys.seedless, true);
    const chainId = ROBINHOOD_CHAIN_ID;
    const salt = keccak256(stringToHex("salt")) as Hex;

    // A channel's voucher key: its address, x402 vouchers and close requests that recover to it.
    const voucher = await keys.channelVoucherSigner(chainId, USDG, salt);
    assert.equal(voucher.address, await seed.voucherAddress(chainId, USDG, salt));
    const channelId = keccak256(stringToHex("channel"));
    const vSig = await voucher.signTypedData(voucherTypedData({ channelId, maxClaimableAmount: 7n, chainId }));
    assert.equal(await recoverTypedDataAddress({ ...voucherTypedData({ channelId, maxClaimableAmount: 7n, chainId }), signature: vSig }), voucher.address);
    const close = { vault: A(0xa1), channelId, amount: 3n, nonce: 1n, deadline: 2_000_000_000n };
    const cSig = await voucher.signClose(close);
    assert.equal(await recoverTypedDataAddress({ ...closeRequestTypedData({ chainId, ...close }), signature: cSig }), voucher.address);

    // The payment wallet: EIP-3009 transfers from itself.
    const wallet = await keys.paymentWalletSigner(chainId, USDG, A(0xa2));
    const transfer = { from: wallet.address, to: A(0xa3), value: 5n, validAfter: 0n, validBefore: 2_000_000_000n, nonce: keccak256(stringToHex("n")) };
    const typed = { domain: { name: "Global Dollar", version: "1", chainId, verifyingContract: USDG }, types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPE }, primaryType: "TransferWithAuthorization" as const, message: transfer };
    const tSig = await wallet.signTypedData(typed);
    assert.equal(await recoverTypedDataAddress({ ...typed, signature: tSig }), wallet.address);

    // Ostrapad's private jobs: posts that recover to the posting key, and a job key wrapped to the KEM key opens.
    const poster = await keys.padPosting(chainId, OSTRAPAD);
    const jobId = keccak256(stringToHex("job"));
    const pSig = await poster.signPost({ kind: "reserve", jobId, bytes: 1000n, seq: 2n });
    assert.equal(await recoverMessageAddress({ message: { raw: padReserveMessage({ chainId, pad: OSTRAPAD, jobId, bytes: 1000n, seq: 2n }) }, signature: pSig }), poster.address);
    const pk = await keys.padKemPublicKey(chainId, OSTRAPAD);
    const k = padNewJobKey();
    const w = padWrapKey(k, { chainId, pad: OSTRAPAD, jobId, round: 0 }, A(0xd1), pk);
    assert.deepEqual(await keys.padUnwrap(chainId, OSTRAPAD, w, A(0xd1), padKeyCommit(k)), k);
    assert.equal(await keys.padUnwrap(chainId, OSTRAPAD, w, A(0xd2), padKeyCommit(k)), null);

    // Tide's link secret: the same each time, 32 bytes.
    const tide = await keys.tideSecret(chainId, A(0xe1));
    assert.match(tide, /^0x[0-9a-f]{64}$/);
    assert.equal(await keys.tideSecret(chainId, A(0xe1)), tide);

    // The agent key: roots, a spend signed by the key asked for (decoded and verified here), recorded in the signer.
    const vault = A(0xb7);
    const roots = await Promise.all([0n, 1n, 2n].map((i) => keys.agentKeyRoot(chainId, vault, i)));
    assert.equal(new Set(roots).size, 3);
    assert.equal(await keys.agentSigned(chainId, vault, 0n), undefined);
    const key = { vault, agentNonce: 4n, keyRoot: roots[0] as Hex, vaultKeyRoot: keccak256(stringToHex("vault key")), index: 0n, nextIndex: 1n };
    const spend = { chainId, action: VAULT_ACTION.TRANSFER, params: transferParams({ to: A(0xc1), amount: 5n }) };
    const signed = await keys.signAgentSpend(key, spend);
    assert.equal(signed.nextKeyRoot, roots[1]);
    assert.equal(wotsVerify(Buffer.from(signed.signature.slice(2), "hex"), signed.message, Buffer.from((roots[0] as Hex).slice(2), "hex")), true);
    const rec = await keys.agentRecorded(chainId, vault, 0n);
    assert.equal(rec?.signature, signed.signature.slice(2));
    assert.deepEqual(await keys.agentSigned(chainId, vault, 0n), rec);
    assert.equal(await keys.agentRecorded(chainId, vault, 1n), undefined);
    // Another message for the same key: refused before the signer is asked (its record says what key 0 signed).
    await assert.rejects(keys.signAgentSpend(key, { ...spend, params: transferParams({ to: A(0xc1), amount: 6n }) }), (e: Error) => e.name === "WotsKeyReuseError");
    // The same message again: the same signature. A next key that signed already: refused before the signer is asked.
    assert.equal((await keys.signAgentSpend(key, spend)).signature, signed.signature);
    await assert.rejects(keys.signAgentSpend({ ...key, keyRoot: roots[2] as Hex, index: 2n, nextIndex: 0n }, spend), (e: Error) => e instanceof RangeError && /signed already/.test(e.message));
    // The signer itself refuses another message for a signed key too (asked directly).
    await assert.rejects(seed.signAgentSpend(key, { ...spend, params: transferParams({ to: A(0xc1), amount: 6n }) }), (e: Error) => e instanceof SignerError);

    // The agent's own seed: its keychains refuse when used, its other secrets at once; nothing reaches a seed.
    const refused = (e: unknown) => e instanceof HostedRefusedError;
    assert.throws(() => keys.vaultKeychain(chainId, USDG).keyRoot(0n), refused);
    assert.throws(() => keys.creatorKeychain(chainId, USDG).keyRoot(0n), refused);
    assert.throws(() => keys.sellerKeychain(chainId, USDG).keyRoot(0n), refused);
    assert.throws(() => keys.privateVaultKeychain(chainId, USDG, 0n).keyRoot(0n), refused);
    await assert.rejects(keys.vaultKeychain(chainId, USDG).sign(0n, new Uint8Array(32)), refused);
    await assert.rejects(keys.creatorKeychain(chainId, USDG).signed(0n), refused);
    await assert.rejects(keys.shieldLeafKeychain(chainId, USDG, 0n).sign(0n, new Uint8Array(32)), refused);
    assert.throws(() => keys.merchantKey(chainId, USDG), refused);
    assert.throws(() => keys.selfCrankSigner(chainId, USDG), refused);
    assert.throws(() => keys.shieldSigner(chainId, USDG, 0n), refused);
    assert.throws(() => keys.shieldDepositId(chainId, USDG, 0n), refused);
    assert.throws(() => keys.noteSecret(chainId, A(0xf1), "sk", 0n), refused);
    assert.throws(() => keys.spendNoteSecret(chainId, A(0xf1), "change", keccak256(stringToHex("note"))), refused);
    assert.throws(() => keys.backupSigner(), refused);
    await assert.rejects(async () => keys.passkeyBackup(new Uint8Array(32), new Uint8Array(16)), refused);
    assert.match(String((() => { try { keys.merchantKey(chainId, USDG); } catch (e) { return (e as Error).message; } })()), /nothing was signed/);
    // A Keys of another folder is seedless too, with the same signer.
    await mkdir(join(dir, "home-dave"), { recursive: true });
    const creator = await keys.forCreatorVault(chainId, USDG);
    assert.equal(creator.seedless, true);
    assert.equal(await creator.voucherAddress(chainId, USDG, salt), voucher.address);
    assert.throws(() => creator.creatorKeychain(chainId, USDG).keyRoot(0n), refused);
    // A Keys holds a seed or a signer, one of the two.
    assert.throws(() => new Keys({ master: new Uint8Array(32), remote: seed, feePayer: privateKeyToAccount(generatePrivateKey()), store: { load: async () => undefined, saveIfAbsent: async () => true }, folder: new DiskFolder(dir), backupExported: async () => true }));
  } finally {
    seed.close();
  }
});

test("a token revoked by a rotation is refused; more requests than a connection holds wait their turn; a restarted signer is reached again", async () => {
  await admin.create("erin");
  const old = seedless("erin", 0);
  const salt = keccak256(stringToHex("s2")) as Hex;
  const address = await old.keys.voucherAddress(ROBINHOOD_CHAIN_ID, USDG, salt);
  const epoch = await admin.rotate("erin");
  await assert.rejects(old.keys.voucherAddress(ROBINHOOD_CHAIN_ID, USDG, salt), (e: Error) => e instanceof SignerError && /not authorized/.test(e.message));
  old.seed.close();
  const now = seedless("erin", epoch);
  try {
    // Forty at once on one connection (the signer takes sixteen open on it): every one answered, the same address.
    const many = await Promise.all(Array.from({ length: 40 }, () => now.keys.voucherAddress(ROBINHOOD_CHAIN_ID, USDG, salt)));
    assert.deepEqual(new Set(many), new Set([address]));
    // The signer restarts under the live connection: the next request opens a new one, and the seed is the same.
    await signer.close();
    await start();
    assert.equal(await now.keys.voucherAddress(ROBINHOOD_CHAIN_ID, USDG, salt), address);
  } finally {
    now.seed.close();
  }
});

test("agent key searches up and down (roots and records, as AgentKey rebuilds its mark and finds a root) fit the signer's work budget of 800 a minute (one request asked per index would take 1200)", async () => {
  await signer.close();
  await start(800);
  try {
    await admin.create("gina");
    const { seed, keys } = seedless("gina", 0);
    try {
      const vault = A(0xb9);
      const roots = new Set<Hex>();
      for (let i = 0n; i < 300n; i++) {
        roots.add(await keys.agentKeyRoot(ROBINHOOD_CHAIN_ID, vault, i));
        assert.equal(await keys.agentSigned(ROBINHOOD_CHAIN_ID, vault, i), undefined);
      }
      assert.equal(roots.size, 300);
      // Down again past what was read (as AgentKey.indexOf searches from its newest key): blocks of eight too.
      for (let i = 599n; i >= 300n; i--) {
        roots.add(await keys.agentKeyRoot(ROBINHOOD_CHAIN_ID, vault, i));
        assert.equal(await keys.agentRecorded(ROBINHOOD_CHAIN_ID, vault, i), undefined);
      }
      assert.equal(roots.size, 600);
    } finally {
      seed.close();
    }
  } finally {
    await signer.close();
    await start();
  }
});

test("a hosted home: openKeys makes no seed and refuses a home holding one; loadConfig takes OSTRA_SIGNER_* only whole and hosted", async () => {
  await admin.create("frank");
  const epoch = await admin.rotate("frank");
  const tokenFile = join(dir, "frank.token");
  await writeFile(tokenFile, `${agentToken(adminKey, "frank", epoch)}\n`, { mode: 0o600 });
  const home = join(dir, "home-frank");
  const signerConfig = { socket: socketPath(sockets, "frank"), agent: "frank", tokenFile };
  // Its connection is closed by the signer's close (after).
  const keys = await openKeys(home, null, signerConfig);
  assert.equal(keys.seedless, true);
  assert.equal(existsSync(join(home, MASTER_FILE)), false, "no seed in the home");
  assert.equal(existsSync(join(home, "fee-payer.key")), true, "the fee payer stays in the home");
  assert.match(await keys.agentKeyRoot(ROBINHOOD_CHAIN_ID, A(0xb8), 0n), /^0x[0-9a-f]{64}$/);
  // A token file others can read is refused; so is a home that holds a seed.
  const loose = join(dir, "loose.token");
  await writeFile(loose, `${agentToken(adminKey, "frank", epoch)}\n`, { mode: 0o644 });
  await assert.rejects(openKeys(join(dir, "home-loose"), null, { ...signerConfig, tokenFile: loose }), /chmod 600/);
  const owned = join(dir, "home-owned");
  await openKeys(owned, null);
  assert.equal(existsSync(join(owned, MASTER_FILE)), true);
  await assert.rejects(openKeys(owned, null, signerConfig), /holds a seed/);

  const base = { OSTRA_HOME: home, OSTRA_DEPLOYMENT: fileURLToPath(new URL("../../deployments/robinhood-mainnet.json", import.meta.url)) };
  const vars = { OSTRA_SIGNER_SOCKET: signerConfig.socket, OSTRA_SIGNER_AGENT: "frank", OSTRA_SIGNER_TOKEN_FILE: tokenFile };
  const hosted = { OSTRA_AGENT_OF: A(0xb8), OSTRA_HOSTED: "yes" };
  assert.equal((await loadConfig(base)).signer, null);
  assert.deepEqual((await loadConfig({ ...base, ...hosted, ...vars })).signer, { socket: signerConfig.socket, agent: "frank", tokenFile });
  await assert.rejects(loadConfig({ ...base, ...hosted, OSTRA_SIGNER_SOCKET: signerConfig.socket }), /together/);
  await assert.rejects(loadConfig({ ...base, ...vars }), /hosted agent/);
  await assert.rejects(loadConfig({ ...base, OSTRA_HOSTED: "yes", ...vars }), /hosted agent/);
  await assert.rejects(loadConfig({ ...base, ...hosted, ...vars, OSTRA_SIGNER_AGENT: "Frank" }), /agent id/);
});
