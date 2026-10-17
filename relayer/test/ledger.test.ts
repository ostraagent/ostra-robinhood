import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CREATE_VAULTS_PER_IP,
  CREATE_VAULT_WINDOW_MS,
  Ledger,
  LedgerRefusal,
  QUOTE_RETENTION_MS,
  creditOf,
  creditPlan,
  debtOf,
  pruneQuotes,
  takeCreateVaultSlot,
  type Quote,
} from "../src/ledger.ts";

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ostra-relayer-ledger-"));
  await chmod(dir, 0o700);
  return dir;
}

const quote = (createdAt: number): Quote => ({ amount: "573", wei: "5000", gas: "50", gasPrice: "100", ethUsd: "400000000000", to: "0x0000000000000000000000000000000000000001", data: "0x00000000", kind: "other", vaults: [], createdAt });

test("updates are saved (0600) and survive reopening", async () => {
  const dir = await freshDir();
  try {
    const ledger = await Ledger.open(dir);
    await ledger.update((d) => {
      d.debts.V = { amount: "100", txs: ["h1"] };
      d.credits.W = "7";
    });
    const path = join(dir, "relayer-ledger.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const again = await Ledger.open(dir);
    assert.equal(debtOf(again.view(), "V"), 100n);
    assert.equal(creditOf(again.view(), "W"), 7n);
    assert.equal(debtOf(again.view(), "X"), 0n);
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a throwing update changes nothing, in memory or on disk", async () => {
  const dir = await freshDir();
  try {
    const ledger = await Ledger.open(dir);
    await ledger.update((d) => {
      d.credits.W = "1";
    });
    await assert.rejects(
      ledger.update((d) => {
        d.credits.W = "2";
        throw new LedgerRefusal("x", "refused");
      }),
      LedgerRefusal,
    );
    assert.equal(creditOf(ledger.view(), "W"), 1n);
    assert.equal(creditOf((await Ledger.open(dir)).view(), "W"), 1n);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("concurrent updates run one after another", async () => {
  const dir = await freshDir();
  try {
    const ledger = await Ledger.open(dir);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        ledger.update(async (d) => {
          const now = creditOf(d, "W");
          await new Promise((r) => setTimeout(r, 1));
          d.credits.W = (now + 1n).toString();
        }),
      ),
    );
    assert.equal(creditOf(ledger.view(), "W"), 20n);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("view() is a copy", async () => {
  const dir = await freshDir();
  try {
    const ledger = await Ledger.open(dir);
    ledger.view().credits.W = "5";
    assert.equal(creditOf(ledger.view(), "W"), 0n);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a directory other users can reach is refused", async () => {
  const dir = await freshDir();
  try {
    await chmod(dir, 0o755);
    await assert.rejects(Ledger.open(dir), /accessible by other users/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("CreateVault before payment: 3 per IP in a rolling 24 hours", async () => {
  const dir = await freshDir();
  try {
    const ledger = await Ledger.open(dir);
    const d = ledger.view();
    const t0 = 1_000_000;
    assert.equal(CREATE_VAULTS_PER_IP, 3);
    assert.equal(CREATE_VAULT_WINDOW_MS, 86_400_000);
    for (let i = 0; i < CREATE_VAULTS_PER_IP; i++) takeCreateVaultSlot(d, "1.2.3.4", t0 + i);
    assert.throws(() => takeCreateVaultSlot(d, "1.2.3.4", t0 + 10), (e: unknown) => e instanceof LedgerRefusal && e.code === "create_vault_limit");
    takeCreateVaultSlot(d, "5.6.7.8", t0 + 10);
    // The first slot leaves the window 24 hours after it was taken.
    assert.throws(() => takeCreateVaultSlot(d, "1.2.3.4", t0 + CREATE_VAULT_WINDOW_MS - 1), LedgerRefusal);
    takeCreateVaultSlot(d, "1.2.3.4", t0 + CREATE_VAULT_WINDOW_MS);
    assert.deepEqual(d.createVaults["1.2.3.4"], [t0 + 1, t0 + 2, t0 + CREATE_VAULT_WINDOW_MS]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("quotes and paid records are dropped after QUOTE_RETENTION_MS (an entry exactly that old is kept)", () => {
  const now = 10_000_000;
  const d = { version: 1 as const, quotes: { old: quote(now - QUOTE_RETENTION_MS - 1), edge: quote(now - QUOTE_RETENTION_MS) }, paid: { old: { txHash: "0x01", amount: "1", at: now - QUOTE_RETENTION_MS - 1 }, new: { txHash: "0x02", amount: "1", at: now } }, debts: {}, opens: {}, credits: {}, createVaults: {} };
  pruneQuotes(d, now);
  assert.deepEqual(Object.keys(d.quotes), ["edge"]);
  assert.deepEqual(Object.keys(d.paid), ["new"]);
});

test("credit of a vault the transaction acts for alone pays up to all of it", () => {
  assert.deepEqual(creditPlan({ price: 573n, credit: 0n, actsForCreditVault: true }), { used: 0n, owed: 573n, voucherFromCreditVault: false });
  assert.deepEqual(creditPlan({ price: 573n, credit: 100n, actsForCreditVault: true }), { used: 100n, owed: 473n, voucherFromCreditVault: false });
  assert.deepEqual(creditPlan({ price: 573n, credit: 573n, actsForCreditVault: true }), { used: 573n, owed: 0n, voucherFromCreditVault: false });
  assert.deepEqual(creditPlan({ price: 573n, credit: 10_000n, actsForCreditVault: true }), { used: 573n, owed: 0n, voucherFromCreditVault: false });
});

test("credit of the named payer leaves at least one base unit for a voucher from that vault's channel", () => {
  assert.deepEqual(creditPlan({ price: 573n, credit: 0n, actsForCreditVault: false }), { used: 0n, owed: 573n, voucherFromCreditVault: false });
  assert.deepEqual(creditPlan({ price: 573n, credit: 100n, actsForCreditVault: false }), { used: 100n, owed: 473n, voucherFromCreditVault: true });
  assert.deepEqual(creditPlan({ price: 573n, credit: 10_000n, actsForCreditVault: false }), { used: 572n, owed: 1n, voucherFromCreditVault: true });
  assert.deepEqual(creditPlan({ price: 1n, credit: 10_000n, actsForCreditVault: false }), { used: 0n, owed: 1n, voucherFromCreditVault: false });
});

test("a price below one base unit or a negative credit is refused", () => {
  assert.throws(() => creditPlan({ price: 0n, credit: 0n, actsForCreditVault: true }), RangeError);
  assert.throws(() => creditPlan({ price: 1n, credit: -1n, actsForCreditVault: true }), RangeError);
});
