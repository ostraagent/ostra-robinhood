// The relayer's request limits: the client key (an IPv6 address by its /64) and the sliding window (rate.ts) that
// bound fresh quotes, quoted requests and private relay requests per client, and the revert limits of private spends (private.ts), kept in the ledger so that they survive a restart.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { GLOBAL_PAUSE_MS, GLOBAL_REVERTS, IP_REVERTS, NOTE_REVERTS, REVERT_WINDOW_MS, privateRevertRefusal, recordPrivateRevert } from "../src/private.ts";
import { RateWindow, clientKey } from "../src/rate.ts";

test("a rate window: `limit` requests per key in any window, a refused request not counted, keys apart", () => {
  const w = new RateWindow(3, 60_000);
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(w.take("a", t0 + i), true);
  assert.equal(w.take("a", t0 + 10), false);
  assert.equal(w.take("b", t0 + 10), true);
  // The first request leaves the window 60 s after it was made; the refused one never counted.
  assert.equal(w.take("a", t0 + 59_999), false);
  assert.equal(w.take("a", t0 + 60_000), true);
  assert.equal(w.take("a", t0 + 60_001), true);
  assert.equal(w.take("a", t0 + 60_002), true);
  assert.equal(w.take("a", t0 + 60_003), false);
  assert.throws(() => new RateWindow(0, 1), RangeError);
});

test("private reverts: per note, per IP address and in all, each in its window, kept across reopening the ledger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ostra-limits-"));
  try {
    const ledger = await Ledger.open(join(dir, "data"));
    const t0 = 2_000_000_000_000;
    const note = `0x${"ab".repeat(32)}`;
    assert.equal(privateRevertRefusal(ledger.view(), "1.1.1.1", note, t0), null);

    // One note's spends from two addresses: the note is refused after NOTE_REVERTS, the addresses are not.
    for (let i = 0; i < NOTE_REVERTS; i++) await ledger.update((d) => recordPrivateRevert(d, `2.2.2.${i}`, note.toUpperCase().replace("0X", "0x"), `0x${i}`, t0 + i));
    const reopened = await Ledger.open(join(dir, "data"));
    const byNote = privateRevertRefusal(reopened.view(), "3.3.3.3", note, t0 + 10);
    assert.equal(byNote?.status, 409);
    assert.equal((byNote?.body as { error: string }).error, "reverted_before");
    assert.equal(privateRevertRefusal(reopened.view(), "3.3.3.3", `0x${"cd".repeat(32)}`, t0 + 10), null);
    assert.equal(privateRevertRefusal(reopened.view(), "3.3.3.3", note, t0 + NOTE_REVERTS - 1 + REVERT_WINDOW_MS), null, "the note's window passed");

    // One address with IP_REVERTS reverts of different notes: refused, for any note.
    const ledger2 = await Ledger.open(join(dir, "ip"));
    for (let i = 0; i < IP_REVERTS; i++) await ledger2.update((d) => recordPrivateRevert(d, "4.4.4.4", `0x${String(i).repeat(64)}`, "0x", t0 + i));
    assert.equal(privateRevertRefusal(ledger2.view(), "4.4.4.4", note, t0 + 10)?.status, 403);
    assert.equal(privateRevertRefusal(ledger2.view(), "5.5.5.5", note, t0 + 10), null);
    assert.equal(privateRevertRefusal(ledger2.view(), "4.4.4.4", note, t0 + IP_REVERTS - 1 + REVERT_WINDOW_MS), null);

    // GLOBAL_REVERTS reverts from anyone within GLOBAL_PAUSE_MS pause everyone, and stop doing so once older.
    const ledger3 = await Ledger.open(join(dir, "all"));
    for (let i = 0; i < GLOBAL_REVERTS; i++) await ledger3.update((d) => recordPrivateRevert(d, `6.6.6.${i}`, `0x${String(i).repeat(64)}`, "0x", t0 + i));
    const paused = privateRevertRefusal((await Ledger.open(join(dir, "all"))).view(), "7.7.7.7", note, t0 + 10);
    assert.equal(paused?.status, 503);
    assert.equal(privateRevertRefusal(ledger3.view(), "7.7.7.7", note, t0 + GLOBAL_REVERTS - 1 + GLOBAL_PAUSE_MS), null);

    // The same revert recorded twice (a write that carries one kept in memory) counts once.
    const ledger4 = await Ledger.open(join(dir, "twice"));
    for (let i = 0; i < 2; i++) await ledger4.update((d) => recordPrivateRevert(d, "9.9.9.9", note, "0xaa", t0));
    assert.equal(ledger4.view().privateReverts?.[note]?.length, 1);
    assert.deepEqual(ledger4.view().privateIpReverts?.["9.9.9.9"], [t0]);
    assert.deepEqual(ledger4.view().privateRecentReverts, [t0]);

    // Old entries are dropped when a new revert is recorded.
    await ledger3.update((d) => recordPrivateRevert(d, "8.8.8.8", note, "0x", t0 + 2 * REVERT_WINDOW_MS));
    const v = ledger3.view();
    assert.deepEqual(Object.keys(v.privateReverts ?? {}), [note]);
    assert.deepEqual(Object.keys(v.privateIpReverts ?? {}), ["8.8.8.8"]);
    assert.deepEqual(v.privateRecentReverts, [t0 + 2 * REVERT_WINDOW_MS]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("client keys: IPv4 as it is, IPv4-mapped IPv6 as IPv4, IPv6 by its /64 in any spelling", () => {
  assert.equal(clientKey("203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey("2001:db8:aa:bb:1:2:3:4"), "2001:db8:aa:bb::/64");
  assert.equal(clientKey("2001:0DB8:00AA:00bb:ffff:0:0:1"), "2001:db8:aa:bb::/64");
  assert.equal(clientKey("2001:db8:aa:bb::9"), "2001:db8:aa:bb::/64");
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey("::1"), "0:0:0:0::/64");
  assert.equal(clientKey(""), "");
  assert.equal(clientKey("not an ip"), "not an ip");
});
