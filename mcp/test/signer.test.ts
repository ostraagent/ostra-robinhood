// Ostra Cloud's signer (src/signer.ts) over its real Unix socket: the seed is created and sealed on the signer's own
// volume and opens again after a restart, every typed operation answers with signatures that recover to the keys it
// reports (vouchers, close requests, EIP-3009 transfers, Ostrapad posts, agent spends checked as WOTS signatures), a
// WOTS key never signs twice (also under concurrent requests), tokens are per agent and revocable, and fields, actions,
// framing and the rate limits are enforced.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getAddress, keccak256, recoverAddress, recoverMessageAddress, recoverTypedDataAddress, stringToHex, type Address, type Hex } from "viem";
import {
  OSTRAPAD,
  ROBINHOOD_CHAIN_ID,
  USDG,
  VAULT_ACTION,
  closeDigest,
  padKeyCommit,
  padNewJobKey,
  padReserveMessage,
  padWrapKey,
  transferParams,
  voucherTypedData,
  wotsVerify,
} from "@ostraagent/sdk";
import { TRANSFER_WITH_AUTHORIZATION_TYPE } from "@ostraagent/core";
import { Signer, socketPath, type SignerOptions } from "../src/signer.ts";
import { MAX_LINE, adminToken, agentToken, attestReportData } from "../src/signer-protocol.ts";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const adminKey = randomBytes(32);
const sealKey = randomBytes(32);
const epochs = new Map<string, number>();
let dir: string;
let sockets: string;
let signer: Signer;
let seq = 0;

async function start(o: Partial<SignerOptions> = {}) {
  signer = new Signer({ sockets, root: join(dir, "root"), adminKey, sealKey, rate: 1000, workRate: 100_000, ...o });
  await signer.listen();
}

async function restart(o: Partial<SignerOptions> = {}) {
  await signer.close();
  await start(o);
}

type Answer = { id: unknown; ok: boolean; result?: any; error?: string };

const ADMIN = "#admin";

/**
 * Sends raw text on a new connection to `principal`'s socket (an agent id, or ADMIN) and resolves with the first
 * answer line; `halfClose` ends the writing side after it.
 */
function raw(principal: string, text: string, halfClose = false): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const s = connect(socketPath(sockets, principal));
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        s.destroy();
        resolve(JSON.parse(buf.slice(0, i)));
      }
    });
    s.on("error", reject);
    s.write(text);
    if (halfClose) s.end();
  });
}

const call = (principal: string, req: Record<string, unknown>) => raw(principal, `${JSON.stringify({ id: ++seq, ...req })}\n`);
const admin = (op: string, agent: string) => call(ADMIN, { admin: adminToken(adminKey), op, args: { agent } });
const as = (agent: string, op: string, args: Record<string, unknown>) => call(agent, { agent, token: agentToken(adminKey, agent, epochs.get(agent) ?? 0), op, args });
async function ok(agent: string, op: string, args: Record<string, unknown>) {
  const r = await as(agent, op, args);
  assert.equal(r.ok, true, `${op}: ${r.error}`);
  return r.result;
}

/** The signer's log lines (stderr) written while `f` runs. */
async function logged(f: () => Promise<void>): Promise<string> {
  const write = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    await f();
  } finally {
    process.stderr.write = write;
  }
  return out;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ostra-signer-"));
  sockets = join(dir, "sockets");
  await mkdir(sockets, { mode: 0o750 });
  await start();
});

after(async () => {
  await signer.close();
  await rm(dir, { recursive: true, force: true });
});

test("agents: created by the admin only, sealed on the signer's volume, each token opens its own agent only", async () => {
  assert.equal((await call(ADMIN, { admin: "00".repeat(32), op: "agent.create", args: { agent: "alice" } })).error, "not authorized");
  assert.deepEqual((await admin("agent.create", "alice")).result, { created: true, epoch: 0 });
  assert.deepEqual((await admin("agent.create", "alice")).result, { created: false, epoch: 0 });
  assert.deepEqual((await admin("agent.create", "bob")).result, { created: true, epoch: 0 });
  // Created at once by several admins: one seed.
  const many = await Promise.all(Array.from({ length: 8 }, () => admin("agent.create", "carl")));
  assert.equal(many.filter((r) => r.result?.created === true).length, 1);
  const root = join(dir, "root");
  const sealed = join(root, "agents", "alice", "seed.sealed");
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "agents", "alice"))).mode & 0o777, 0o700);
  assert.equal((await stat(sealed)).mode & 0o777, 0o600);
  assert.equal((await stat(socketPath(sockets, ADMIN))).mode & 0o777, 0o660);
  assert.equal((await stat(socketPath(sockets, "alice"))).mode & 0o777, 0o660);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(sealed, "utf8"))).sort(), ["ct", "iv", "tag", "v"]);
  // A token opens its own agent only, an agent's socket serves that agent only, and an agent with no seed has no socket.
  assert.equal((await call("alice", { agent: "alice", token: agentToken(adminKey, "bob", 0), op: "tide.secret", args: { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) } })).error, "not authorized");
  assert.equal((await call("alice", { agent: "bob", token: agentToken(adminKey, "bob", 0), op: "tide.secret", args: { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) } })).error, "this socket serves another principal");
  await assert.rejects(as("carol", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) }), /ENOENT/);
  // Different seeds: different secrets.
  assert.notEqual(await ok("alice", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) }), await ok("bob", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) }));
  // A sealed seed opens only as the agent it was made for (the agent id is its associated data): the caller learns
  // nothing of why, and the signer logs it.
  await mkdir(join(root, "agents", "mallory"), { recursive: true, mode: 0o700 });
  await copyFile(sealed, join(root, "agents", "mallory", "seed.sealed"));
  await restart();
  let r: Answer | undefined;
  const log = await logged(async () => {
    r = await as("mallory", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) });
  });
  assert.equal(r?.error, "the signer could not answer this request");
  assert.match(log, /"event":"unseal_failed","agent":"mallory"/);
});

test("tokens: agent.rotate revokes an agent's tokens only; admin and agent tokens are not interchangeable", async () => {
  const old = agentToken(adminKey, "bob", 0);
  assert.deepEqual((await admin("agent.rotate", "bob")).result, { epoch: 1 });
  assert.equal((await call("bob", { agent: "bob", token: old, op: "tide.secret", args: { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) } })).error, "not authorized");
  epochs.set("bob", 1);
  await ok("bob", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) });
  await ok("alice", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) });
  // The epoch is kept on the signer's volume.
  await restart();
  await ok("bob", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) });
  assert.deepEqual((await admin("agent.create", "bob")).result, { created: false, epoch: 1 });
  assert.match((await admin("agent.rotate", "nobody")).error ?? "", /no seed/);
  assert.equal((await call(ADMIN, { admin: agentToken(adminKey, "alice", 0), op: "agent.rotate", args: { agent: "alice" } })).error, "not authorized");
  assert.equal((await call("alice", { agent: "alice", token: adminToken(adminKey), op: "tide.secret", args: { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) } })).error, "not authorized");
  // The admin's socket serves the admin only, and an agent's socket never runs an admin op.
  assert.equal((await call(ADMIN, { agent: "alice", token: agentToken(adminKey, "alice", 0), op: "tide.secret", args: { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) } })).error, "this socket serves another principal");
  assert.equal((await call("alice", { admin: adminToken(adminKey), op: "agent.rotate", args: { agent: "alice" } })).error, "this socket serves another principal");
});

test("attest: the admin's only, its nonce 32 bytes of lower case hex, refused outside a TEE (a seal from a file)", async () => {
  const nonce = "ab".repeat(32);
  // The report data: SHA-256 of the domain and the nonce's 32 bytes (the enclave's quote commits to it).
  assert.equal(attestReportData(nonce), createHash("sha256").update(Buffer.concat([Buffer.from("OSTRA/CLOUD/ATTEST/v1"), Buffer.from(nonce, "hex")])).digest("hex"));
  for (const bad of ["AB".repeat(32), "ab".repeat(31), "ab".repeat(33), `0x${"ab".repeat(32)}`, ""]) assert.throws(() => attestReportData(bad), /nonce must be 32 bytes/);
  const attest = (args: Record<string, unknown>, token = adminToken(adminKey)) => call(ADMIN, { admin: token, op: "attest", args });
  assert.equal((await attest({ nonce })).error, "no attestation here: the signer runs outside a TEE (its seal is from a file)");
  assert.equal((await attest({ nonce: "AB".repeat(32) })).error, "nonce must be 32 bytes, lower case hex");
  assert.equal((await attest({ nonce: 7 })).error, "nonce must be 32 bytes, lower case hex");
  assert.equal((await attest({ nonce, more: 1 })).error, "attest takes exactly nonce");
  assert.equal((await attest({ nonce }, agentToken(adminKey, "alice", 0))).error, "not authorized");
  assert.equal((await call("alice", { admin: adminToken(adminKey), op: "attest", args: { nonce } })).error, "this socket serves another principal");
});

test("vouchers, close requests, EIP-3009 transfers and Ostrapad posts recover to the keys the signer reports", async () => {
  const salt = keccak256(stringToHex("salt"));
  const voucher = (await ok("alice", "voucher.address", { chainId: ROBINHOOD_CHAIN_ID, token: USDG, salt })) as Address;
  const channelId = keccak256(stringToHex("channel"));
  const vSig = (await ok("alice", "voucher.sign", { chainId: ROBINHOOD_CHAIN_ID, token: USDG, salt, channelId, maxClaimableAmount: "7" })) as Hex;
  assert.equal(await recoverTypedDataAddress({ ...voucherTypedData({ channelId, maxClaimableAmount: 7n, chainId: ROBINHOOD_CHAIN_ID }), signature: vSig }), voucher);
  const close = { vault: A(0xb5), channelId, amount: "5", nonce: "1", deadline: "1800000000" };
  const cSig = (await ok("alice", "voucher.signClose", { chainId: ROBINHOOD_CHAIN_ID, token: USDG, salt, ...close })) as Hex;
  assert.equal(await recoverAddress({ hash: closeDigest({ chainId: ROBINHOOD_CHAIN_ID, vault: A(0xb5), channelId, amount: 5n, nonce: 1n, deadline: 1_800_000_000n }), signature: cSig }), voucher);

  const wallet = (await ok("alice", "payment.address", { chainId: ROBINHOOD_CHAIN_ID, token: USDG, vault: A(0xb5) })) as Address;
  const nonce = keccak256(stringToHex("n"));
  const tSig = (await ok("alice", "payment.signTransfer", { chainId: ROBINHOOD_CHAIN_ID, token: USDG, vault: A(0xb5), name: "Global Dollar", version: "1", to: A(0xc2), value: "3", validAfter: "0", validBefore: "1800000000", nonce })) as Hex;
  const td = {
    domain: { name: "Global Dollar", version: "1", chainId: ROBINHOOD_CHAIN_ID, verifyingContract: USDG },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPE },
    primaryType: "TransferWithAuthorization",
    message: { from: wallet, to: A(0xc2), value: 3n, validAfter: 0n, validBefore: 1_800_000_000n, nonce },
  } as const;
  assert.equal(await recoverTypedDataAddress({ ...td, signature: tSig }), wallet);

  const posting = (await ok("alice", "pad.postingAddress", { chainId: ROBINHOOD_CHAIN_ID, pad: OSTRAPAD })) as Address;
  const jobId = keccak256(stringToHex("job"));
  const pSig = (await ok("alice", "pad.signPost", { chainId: ROBINHOOD_CHAIN_ID, pad: OSTRAPAD, message: { kind: "reserve", jobId, bytes: "1000", seq: "2" } })) as Hex;
  assert.equal(await recoverMessageAddress({ message: { raw: padReserveMessage({ chainId: ROBINHOOD_CHAIN_ID, pad: OSTRAPAD, jobId, bytes: 1000n, seq: 2n }) }, signature: pSig }), posting);

  // The KEM: a wrap to the agent under its public key opens to the job key; to another recipient, to nothing.
  const pk = Buffer.from(((await ok("alice", "pad.kemPublicKey", { chainId: ROBINHOOD_CHAIN_ID, pad: OSTRAPAD })) as string).slice(2), "hex");
  const k = padNewJobKey();
  const w = padWrapKey(k, { chainId: ROBINHOOD_CHAIN_ID, pad: OSTRAPAD, jobId, round: 0 }, A(0xd1), pk);
  const hexOf = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
  const wire = { recipient: w.recipient, pkHash: hexOf(w.pkHash), ct: hexOf(w.ct), wrapped: hexOf(w.wrapped) };
  assert.equal(await ok("alice", "pad.unwrap", { chainId: ROBINHOOD_CHAIN_ID, pad: OSTRAPAD, wrap: wire, recipient: A(0xd1), keyCommit: hexOf(padKeyCommit(k)) }), hexOf(k));
  assert.equal(await ok("alice", "pad.unwrap", { chainId: ROBINHOOD_CHAIN_ID, pad: OSTRAPAD, wrap: wire, recipient: A(0xd2), keyCommit: hexOf(padKeyCommit(k)) }), null);
});

test("agent spends: roots in batches, a WOTS signature for the root, recorded, never twice, and kept after a restart", async () => {
  const vault = A(0xb6);
  const roots = (await ok("alice", "agent.keyRoots", { chainId: ROBINHOOD_CHAIN_ID, vault, from: "0", count: 4 })) as Hex[];
  assert.equal(roots.length, 4);
  assert.equal(new Set(roots).size, 4);
  const key = { vault, agentNonce: "4", keyRoot: roots[0], vaultKeyRoot: keccak256(stringToHex("vault key")), index: "0", nextIndex: "1" };
  const spend = { chainId: ROBINHOOD_CHAIN_ID, action: VAULT_ACTION.TRANSFER, params: transferParams({ to: A(0xc1), amount: 5n }) };
  const signed = (await ok("alice", "agent.signSpend", { key, spend })) as { signature: Hex; message: Hex; nextKeyRoot: Hex };
  assert.equal(signed.nextKeyRoot, roots[1]);
  assert.equal(wotsVerify(Buffer.from(signed.signature.slice(2), "hex"), Buffer.from(signed.message.slice(2), "hex"), Buffer.from(roots[0]!.slice(2), "hex")), true);
  const records = (await ok("alice", "agent.records", { chainId: ROBINHOOD_CHAIN_ID, vault, from: "0", count: 2 })) as (Record<string, string> | null)[];
  assert.equal(records[0]?.signature, signed.signature.slice(2));
  assert.equal(records[1], null);
  // The same message again: the same signature (safe to resubmit). Another message: refused (a one-time key signs once).
  assert.equal(((await ok("alice", "agent.signSpend", { key, spend })) as { signature: Hex }).signature, signed.signature);
  const other = { ...spend, params: transferParams({ to: A(0xc1), amount: 6n }) };
  assert.equal((await as("alice", "agent.signSpend", { key, spend: other })).ok, false);
  // A wrong key root, and a next key that signed already: refused.
  assert.equal((await as("alice", "agent.signSpend", { key: { ...key, index: "2", nextIndex: "3", keyRoot: roots[3] }, spend })).ok, false);
  assert.match((await as("alice", "agent.signSpend", { key: { ...key, index: "2", nextIndex: "0", keyRoot: roots[2] }, spend })).error ?? "", /signed already/);
  // Ten different messages for one key at once, each on its own connection: exactly one is signed.
  const race = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      as("alice", "agent.signSpend", { key: { ...key, index: "2", nextIndex: "3", keyRoot: roots[2] }, spend: { ...spend, params: transferParams({ to: A(0xc1), amount: BigInt(10 + i) }) } }),
    ),
  );
  assert.equal(race.filter((r) => r.ok).length, 1);
  // After a restart the seed opens again from its sealed file, and the records are still there.
  await restart();
  assert.deepEqual(await ok("alice", "agent.keyRoots", { chainId: ROBINHOOD_CHAIN_ID, vault, from: "0", count: 4 }), roots);
  assert.equal(((await ok("alice", "agent.records", { chainId: ROBINHOOD_CHAIN_ID, vault, from: "0", count: 1 })) as Record<string, string>[])[0]?.signature, signed.signature.slice(2));
  assert.equal((await as("alice", "agent.signSpend", { key, spend: other })).ok, false);
  // Many vaults: the agent's keys are opened afresh past the keychain cap, with the same roots and records.
  for (let i = 0; i < 20; i++) await ok("alice", "agent.keyRoots", { chainId: ROBINHOOD_CHAIN_ID, vault: A(0x1000 + i), from: "0", count: 1 });
  assert.deepEqual(await ok("alice", "agent.keyRoots", { chainId: ROBINHOOD_CHAIN_ID, vault, from: "0", count: 4 }), roots);
  assert.equal((await as("alice", "agent.signSpend", { key, spend: other })).ok, false);
});

test("requests: every field typed, no field more, only an agent key's actions, framing, rate limits", async () => {
  const salt = keccak256(stringToHex("salt"));
  const refused = async (op: string, args: Record<string, unknown>, why: RegExp) => {
    const r = await as("alice", op, args);
    assert.equal(r.ok, false, op);
    assert.match(r.error ?? "", why);
  };
  await refused("voucher.sign", { chainId: ROBINHOOD_CHAIN_ID, token: USDG, salt, channelId: keccak256("0x01"), maxClaimableAmount: "7", settlement: A(0xaa) }, /takes exactly/);
  await refused("voucher.sign", { chainId: ROBINHOOD_CHAIN_ID, token: USDG, salt, channelId: keccak256("0x01"), maxClaimableAmount: 7 }, /decimal string/);
  await refused("voucher.sign", { chainId: ROBINHOOD_CHAIN_ID, token: USDG, salt: "0x01", channelId: keccak256("0x01"), maxClaimableAmount: "7" }, /32 bytes/);
  await refused("payment.signTransfer", { chainId: ROBINHOOD_CHAIN_ID, token: "0x12", vault: A(1), name: "x", version: "1", to: A(2), value: "1", validAfter: "0", validBefore: "1", nonce: keccak256("0x01") }, /address/);
  await refused("pad.signPost", { chainId: ROBINHOOD_CHAIN_ID, pad: OSTRAPAD, message: { kind: "raw", hash: keccak256("0x01") } }, /reserve, upload or wrap/);
  await refused("sign", { hash: keccak256("0x01") }, /unknown op/);
  const key = { vault: A(0xb7), agentNonce: "0", keyRoot: keccak256("0x01"), vaultKeyRoot: keccak256("0x02"), index: "0", nextIndex: "1" };
  await refused("agent.signSpend", { key, spend: { chainId: ROBINHOOD_CHAIN_ID, action: VAULT_ACTION.SET_CRANK_KEY, params: "0x" } }, /not one an agent key may sign/);
  await refused("agent.signSpend", { key, spend: { chainId: ROBINHOOD_CHAIN_ID, action: VAULT_ACTION.TRANSFER, params: "0x01" } }, /params/);
  await refused("agent.keyRoots", { chainId: ROBINHOOD_CHAIN_ID, vault: A(1), from: "0", count: 65 }, /0 to 64/);

  // Framing: one JSON object per line; a line over the limit closes the connection; a client that half-closes after
  // its request still gets its answer.
  assert.match((await raw("alice", "not json\n")).error ?? "", /one JSON object/);
  assert.equal((await raw("alice", `${"x".repeat(MAX_LINE + 10)}`)).error, "request too large");
  const half = await raw("alice", `${JSON.stringify({ id: 1, agent: "alice", token: agentToken(adminKey, "alice", 0), op: "voucher.address", args: { chainId: ROBINHOOD_CHAIN_ID, token: USDG, salt } })}\n`, true);
  assert.equal(half.ok, true);

  // The rate limits: signing operations per minute, and key roots per minute (reads of addresses are not counted).
  await restart({ rate: 2, workRate: 70 });
  const sign = () => as("alice", "voucher.sign", { chainId: ROBINHOOD_CHAIN_ID, token: USDG, salt, channelId: keccak256("0x01"), maxClaimableAmount: "1" });
  assert.equal((await sign()).ok, true);
  assert.equal((await sign()).ok, true);
  assert.match((await sign()).error ?? "", /rate limit/);
  assert.equal((await as("alice", "voucher.address", { chainId: ROBINHOOD_CHAIN_ID, token: USDG, salt })).ok, true);
  await ok("alice", "agent.keyRoots", { chainId: ROBINHOOD_CHAIN_ID, vault: A(1), from: "0", count: 64 });
  assert.match((await as("alice", "agent.keyRoots", { chainId: ROBINHOOD_CHAIN_ID, vault: A(1), from: "64", count: 8 })).error ?? "", /rate limit/);
  // Another agent has its own budget.
  assert.equal((await as("bob", "voucher.sign", { chainId: ROBINHOOD_CHAIN_ID, token: USDG, salt, channelId: keccak256("0x01"), maxClaimableAmount: "1" })).ok, true);
  await restart();
});

test("connections: a socket's own cap, closed without an authorized request, and the seal key checked", async () => {
  // Sixteen connections that never ask anything fill bob's socket only: the seventeenth is closed, alice is served.
  await restart({ authMs: 1_500 });
  const idle = await Promise.all(
    Array.from({ length: 16 }, () => new Promise<ReturnType<typeof connect>>((resolve) => {
      const s = connect(socketPath(sockets, "bob"), () => resolve(s));
      s.on("error", () => undefined);
    })),
  );
  const refused = await new Promise<boolean>((resolve) => {
    const s = connect(socketPath(sockets, "bob"));
    s.on("close", () => resolve(true));
    s.on("error", () => undefined);
    setTimeout(() => resolve(false), 1_000);
  });
  assert.equal(refused, true);
  await ok("alice", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) });
  // They make no authorized request in time: closed, and bob is served again.
  await Promise.all(idle.map((s) => new Promise<void>((resolve) => (s.destroyed ? resolve() : s.on("close", () => resolve())))));
  await ok("bob", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) });

  // Another seal key does not open the canary: the signer refuses to start rather than seal seeds that would not open.
  await signer.close();
  await assert.rejects(start({ sealKey: randomBytes(32) }), /canary/);
  // With no canary (gone, or a volume from before it), another key must still open the seeds that are there.
  await rm(join(dir, "root", "canary.sealed"));
  await assert.rejects(start({ sealKey: randomBytes(32) }), /no canary/);
  await start();
  await ok("alice", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) });
});

test("sockets: a directory that would make a socket path too long, a second signer, a flood of lines", async () => {
  assert.throws(() => new Signer({ sockets: `/${"x".repeat(40)}`, root: join(dir, "root"), adminKey, sealKey, rate: 1 }), /at most 32 bytes/);
  // A second signer on the same root and sockets does not take them over from the one running (its lease is kept).
  await restart({ leaseMs: 300 });
  const second = new Signer({ sockets, root: join(dir, "root"), adminKey, sealKey, rate: 1000, leaseMs: 300 });
  await assert.rejects(second.listen(), /another signer holds/);
  await ok("alice", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) });
  // Lines past the per-minute limit, refused ones too, close the connection; the other agents are served.
  const flooded = await new Promise<boolean>((resolve) => {
    const s = connect(socketPath(sockets, "carl"));
    s.on("close", () => resolve(true));
    s.on("error", () => undefined);
    // Its answers are read (and dropped), so that the close is seen.
    s.resume();
    const line = `${JSON.stringify({ id: 1, agent: "carl", token: agentToken(adminKey, "carl", 0), op: "nope", args: {} })}\n`;
    s.write(line.repeat(1_300));
    setTimeout(() => resolve(false), 3_000);
  });
  assert.equal(flooded, true);
  await ok("bob", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) });
  // The root's lease: one kept by another signer (touched here as it would) refuses this one; one that lapsed, or
  // that cannot be read, is taken over once it lapses.
  await signer.close();
  const { writeFile, utimes } = await import("node:fs/promises");
  const lock = join(dir, "root", "signer.lock");
  await writeFile(lock, "another-signer 300\n", { mode: 0o600 });
  const keep = setInterval(() => void utimes(lock, new Date(), new Date()).catch(() => undefined), 50);
  await assert.rejects(start({ leaseMs: 300 }), /another signer holds/);
  clearInterval(keep);
  await writeFile(lock, "", { mode: 0o600 });
  const t0 = Date.now();
  await start({ leaseMs: 300 });
  assert.ok(Date.now() - t0 >= 250, "an unreadable lease is held until it lapses");
  assert.notEqual((await readFile(lock, "utf8")).trim(), "");
  // Close releases only its own lease.
  await signer.close();
  assert.equal(existsSync(lock), false);
  await start();
  // An agent whose socket cannot open gets no seed (here its socket directory is taken by a file).
  await writeFile(join(sockets, "agent-zed"), "not a directory");
  assert.equal((await admin("agent.create", "zed")).ok, false);
  assert.equal(existsSync(join(dir, "root", "agents", "zed", "seed.sealed")), false);
  await rm(join(sockets, "agent-zed"));
  assert.deepEqual((await admin("agent.create", "zed")).result, { created: true, epoch: 0 });
  // The socket directories are 0750, whatever they were.
  assert.equal((await stat(join(sockets, "agent-zed"))).mode & 0o777, 0o750);
  // A signer whose lease was taken over stops serving at once (here the lock is made another signer's).
  await restart({ leaseMs: 300 });
  await ok("alice", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) });
  const { writeFile: write2 } = await import("node:fs/promises");
  await write2(join(dir, "root", "signer.lock"), "someone-else 300\n");
  await new Promise((r) => setTimeout(r, 400));
  await assert.rejects(as("alice", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) }));
  assert.equal((await readFile(join(dir, "root", "signer.lock"), "utf8")).trim(), "someone-else 300", "it never removes another's lease");
  await start();
  await ok("alice", "tide.secret", { chainId: ROBINHOOD_CHAIN_ID, tide: A(1) });
});
