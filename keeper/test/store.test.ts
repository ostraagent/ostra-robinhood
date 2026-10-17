import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keccak256, stringToHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ChannelStore, type ChannelRecord } from "../src/store.ts";

let n = 0;
const address = (name: string): Address => privateKeyToAccount(keccak256(stringToHex(name))).address;

function record(): ChannelRecord {
  n++;
  const vault = address(`vault ${n}`);
  return {
    version: 1,
    channel: keccak256(stringToHex(`channel ${n}`)),
    config: {
      payer: address(`buyer ${n}`),
      payerAuthorizer: address(`session ${n}`),
      receiver: address(`split ${n}`),
      receiverAuthorizer: vault,
      token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      withdrawDelay: 900,
      salt: keccak256(stringToHex(`salt ${n}`)),
    },
    merchant: address(`merchant ${n}`),
    vault,
    split: address(`split ${n}`),
    token: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    recipients: [],
    voucher: null,
    unsettledSince: null,
    steps: [],
    done: false,
    createdAt: 1_800_000_000,
  };
}

test("records round-trip and the directory is private", async () => {
  const root = await mkdtemp(join(tmpdir(), "ostra-keeper-store-"));
  try {
    const store = new ChannelStore(root);
    await store.init();
    assert.equal((await stat(store.dir)).mode & 0o777, 0o700);
    const r = record();
    assert.equal(await store.load(r.channel), null);
    r.recipients = [{ recipient: address("operator"), bps: 30 }];
    r.voucher = { maxClaimableAmount: ((1n << 128n) - 1n).toString(), signature: `0x${"11".repeat(65)}` };
    await store.save(r);
    assert.deepEqual(await store.load(r.channel), r);
    assert.equal((await stat(join(store.dir, `${r.channel}.json`))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overlapping saves end with the latest state and leave no temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ostra-keeper-store-"));
  try {
    const store = new ChannelStore(root);
    await store.init();
    const r = record();
    const saves: Promise<void>[] = [];
    for (let i = 1; i <= 25; i++) {
      r.voucher = { maxClaimableAmount: String(i), signature: `0x${"22".repeat(65)}` };
      saves.push(store.save(r));
    }
    await Promise.all(saves);
    assert.equal((await store.load(r.channel))?.voucher?.maxClaimableAmount, "25");
    assert.deepEqual(await readdir(store.dir), [`${r.channel}.json`]);
    const other = record();
    await store.save(other);
    assert.equal((await store.loadAll()).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only a 32-byte lowercase channel id names a record", async () => {
  const root = await mkdtemp(join(tmpdir(), "ostra-keeper-store-"));
  try {
    const store = new ChannelStore(root);
    await store.init();
    const r = record();
    await assert.rejects(store.load("../escape"), /32 bytes of lowercase hex/);
    await assert.rejects(store.load(r.channel.toUpperCase().replace("0X", "0x")), /32 bytes of lowercase hex/);
    await assert.rejects(store.save({ ...r, channel: "0x12" }), /32 bytes of lowercase hex/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
