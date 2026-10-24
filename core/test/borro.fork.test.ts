// Borro and the version 3 vault settings through the core services, on a fork of Robinhood Chain mainnet (Borro's
// live Morpho markets, Vault V2s and BorroBuilders), with the agent's own fee payer sending (LocalSender):
//   * NVDA: lent from the agent's NVDA vault through BorroBuilders, the shares posted as collateral, a loan above
//     half the LLTV refused before signing, a loan paid into the USDG vault (linking the NVDA vault to it first), a
//     collateral withdrawal the loan does not allow refused before signing (the simulation lands it as
//     MorphoFailed), the whole debt repaid from the USDG vault, the collateral taken back and the shares redeemed;
//   * USDG lent from the USDG vault into Borro's USDG vault and redeemed;
//   * the withdrawal lock: one of the agent's own vaults refused as the withdrawal address; on at once; a withdrawal
//     over the daily limit and a guardian change refused before signing (nothing signed, no spend kept); the
//     withdrawal address free of the limit; an EIP-1271 approval valid only after the delay; a loosening that
//     waits, cancelled;
//   * a recovery under the lock, while the old key spends on: the new seed's first operation finishes it with
//     finishRecovery first and signs with the key supported at the earlier nonce; the approvals given before stop
//     counting.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { formatUnits, keccak256, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BORRO_USDG_VAULT,
  DEFAULT_RECOVERY_DELAY,
  FileWotsStore,
  USDG,
  borroStock,
  ostraVaultAbi,
  readBorroPosition,
  readVault,
  readVaultGuard,
  retryingHttp,
  usdgAbi,
  vaultV2Abi,
  type Deployment,
} from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { BorroService, Keys, LocalSender, VaultService, X402_NETWORK, type Config } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;

const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/BORRO-FORK/fee-payer")));
const someone = (name: string): Address => privateKeyToAccount(keccak256(stringToHex(`OSTRA/CORE/BORRO-FORK/${name}`))).address;
const ERC1271_MAGIC = "0x1626ba7e";

/** A device: its own seed, records and vaults (the USDG vault and its token vaults), and Borro from them. */
function device(name: string, seed: number) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder: new MemoryFolder(), backupExported: async () => true });
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const tokenVaults = new Map<Address, VaultService>();
  const tokenVault = (token: Address) => {
    let v = tokenVaults.get(token);
    if (v === undefined) {
      v = new VaultService(client, transport, config, keys, sender, "token", null, token);
      tokenVaults.set(token, v);
    }
    return v;
  };
  const ownVaults = async () => [await buyer.vaultAddress(), ...(await Promise.all([...tokenVaults.values()].map((v) => v.vaultAddress())))];
  const borro = new BorroService({ client, config, buyer, tokenVault, sender, ownVaults });
  return { keys, buyer, tokenVault, borro };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-borro-"));
  fork = await startFork();
  d = await deployOnFork(fork);
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const usdg = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const sharesOf = (vault: Address, who: Address) => fork.client.readContract({ address: vault, abi: vaultV2Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const nonceOf = async (vault: Address) => (await readVault(fork.client as PublicClient, d, vault))?.nonce;

test("NVDA on Borro: lend, collateral, a loan into the USDG vault, repay, take back; USDG lent and redeemed", { timeout: 900_000 }, async () => {
  const client = fork.client as PublicClient;
  const a = device("borro", 61);
  const nvda = borroStock("NVDA");
  const buyer = (await a.buyer.open()).vault;
  await fork.dealUsdg(buyer, 1_000_000_000n);
  const stockVault = (await a.tokenVault(nvda.token).open()).vault;
  await fork.dealToken(stockVault, nvda.token, 10n * 10n ** 18n);
  assert.equal(Number(await client.readContract({ address: buyer, abi: ostraVaultAbi, functionName: "VERSION" })), 3);

  const markets = (await a.borro.markets()) as { symbol: string; listed: boolean; throughBorroBuilders: boolean }[];
  assert.equal(markets.length, 12);
  assert.deepEqual(
    markets.find((m) => m.symbol === "NVDA"),
    { ...markets.find((m) => m.symbol === "NVDA"), listed: true, throughBorroBuilders: true },
  );

  // Lend the NVDA and post every share.
  assert.equal((await a.borro.lend("NVDA", "10")).status, "sent");
  const shares = await sharesOf(nvda.vault, stockVault);
  assert.ok(shares > 0n);
  assert.equal(await fork.client.readContract({ address: nvda.token, abi: usdgAbi, functionName: "balanceOf", args: [stockVault] }), 0n);
  assert.equal((await a.borro.postCollateral("NVDA", "all")).status, "sent");
  let p = await readBorroPosition(client, stockVault, nvda);
  assert.equal(p.collateral, shares);
  assert.equal(p.debt, 0n);
  assert.ok(p.maxDebt > 0n, "the collateral allows a loan");
  assert.ok(p.available > 1_000_000n, `the NVDA market can lend ${p.available} USDG units now`);

  // Over half the LLTV: refused before anything is signed.
  const n0 = await nonceOf(stockVault);
  await assert.rejects(a.borro.borrow("NVDA", formatUnits(p.maxDebt + 1_000_000n, 6)), /at most .* USDG \(half of the LLTV/);
  assert.equal(await nonceOf(stockVault), n0);

  // A loan within the cap, paid into the USDG vault; the NVDA vault is linked to it first.
  let loan = p.maxDebt / 4n < p.available / 2n ? p.maxDebt / 4n : p.available / 2n;
  loan -= loan % 1_000n;
  const before = await usdg(buyer);
  const b = await a.borro.borrow("NVDA", formatUnits(loan, 6));
  assert.equal(b.status, "sent");
  assert.equal((b as { linked?: boolean }).linked, true);
  assert.equal((await readVaultGuard(client, stockVault)).linkedVault, buyer);
  assert.equal((await usdg(buyer)) - before, loan);
  p = await readBorroPosition(client, stockVault, nvda);
  assert.ok(p.debt >= loan && p.debt <= loan + 1n);

  // Every share of collateral back while the loan is open: the simulation lands it as MorphoFailed, so nothing is signed.
  const n1 = await nonceOf(stockVault);
  await assert.rejects(a.borro.withdrawCollateral("NVDA", "all"), /fails now: .*; nothing was signed/);
  assert.equal(await nonceOf(stockVault), n1);

  // Repay the whole debt from the USDG vault, take the collateral back and redeem.
  assert.equal((await a.borro.repay("NVDA", "all")).status, "sent");
  p = await readBorroPosition(client, stockVault, nvda);
  assert.equal(p.borrowShares, 0n);
  assert.equal((await a.borro.withdrawCollateral("NVDA", "all")).status, "sent");
  assert.equal(await sharesOf(nvda.vault, stockVault), shares);
  assert.equal((await a.borro.redeem("NVDA", "all")).status, "sent");
  assert.equal(await sharesOf(nvda.vault, stockVault), 0n);
  const back = (await fork.client.readContract({ address: nvda.token, abi: usdgAbi, functionName: "balanceOf", args: [stockVault] })) as bigint;
  assert.ok(back >= 10n * 10n ** 18n - 10n ** 12n, `NVDA back: ${back}`);
  await assert.rejects(a.borro.repay("NVDA", "all"), /owes nothing/);

  // USDG into Borro's USDG vault and back.
  assert.equal((await a.borro.lend("USDG", "100")).status, "sent");
  const lent = await sharesOf(BORRO_USDG_VAULT, buyer);
  assert.ok(lent > 0n);
  const pos = (await a.borro.positions()) as { usdgLent: { value: string } };
  assert.ok(Number(pos.usdgLent.value) >= 99.99);
  assert.equal((await a.borro.redeem("USDG", "all")).status, "sent");
  assert.equal(await sharesOf(BORRO_USDG_VAULT, buyer), 0n);
});

test("the withdrawal lock: own vault refused, limit and guardian change refused before signing, EIP-1271 after the delay; a recovery under the lock finishes with finishRecovery", { timeout: 900_000 }, async () => {
  const client = fork.client as PublicClient;
  const owner = device("lock-owner", 71);
  const guardian = device("lock-guardian", 72);
  const vault = (await owner.buyer.open()).vault;
  const guardianVault = (await guardian.buyer.open()).vault;
  await fork.dealUsdg(vault, 500_000_000n);
  const stockVault = (await owner.tokenVault(borroStock("NVDA").token).open()).vault;

  // Guardians before the lock: the lock refuses guardian and policy changes.
  assert.equal((await owner.buyer.setGuardian(guardianVault, true)).status, "sent");
  assert.equal((await owner.buyer.setRecoveryPolicy(1, DEFAULT_RECOVERY_DELAY)).status, "sent");

  const wallet = someone("withdrawal-wallet");
  await assert.rejects(owner.borro.setLock("USDG", stockVault, 129_600, "100"), /one of this agent's own vaults/);
  await assert.rejects(owner.borro.cancelPending("USDG"), /nothing waits/);
  const on = await owner.borro.setLock("USDG", wallet, 129_600, "100");
  assert.equal(on.status, "sent");
  assert.match(on.warning ?? "", /has no code/);
  let g = await readVaultGuard(client, vault);
  assert.equal(g.lock.withdrawal, wallet);
  assert.equal(g.outflowAvailable, 100_000_000n);

  // Over the daily limit, and a guardian change under the lock: refused before signing, no spend kept.
  const n0 = await nonceOf(vault);
  await assert.rejects(owner.buyer.withdraw(someone("payee"), "150"), /nothing was signed/);
  await assert.rejects(owner.buyer.setGuardian(someone("guardian-2"), true), /nothing was signed/);
  assert.equal(await nonceOf(vault), n0);
  assert.equal((await owner.buyer.status()).pendingOperation, undefined);

  // Within the limit; to the withdrawal address, free of it.
  // The used part drains at the limit a day: a few seconds of blocks give back a few hundred units at most.
  const near = (got: bigint | null, want: bigint) => assert.ok(got !== null && got >= want && got <= want + 100_000n, `${got} is not about ${want}`);
  assert.equal((await owner.buyer.withdraw(someone("payee"), "40")).status, "sent");
  near((await readVaultGuard(client, vault)).outflowAvailable, 60_000_000n);
  assert.equal((await owner.buyer.withdraw(wallet, "300")).status, "sent");
  assert.equal(await usdg(wallet), 300_000_000n);
  near((await readVaultGuard(client, vault)).outflowAvailable, 60_000_000n);

  // An EIP-1271 approval under the lock counts only after the delay.
  const hash = keccak256(stringToHex("OSTRA/CORE/BORRO-FORK/order")) as Hex;
  assert.equal((await owner.borro.approveHash(hash, true)).status, "sent");
  const valid = () => client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "isValidSignature", args: [hash, "0x"] }) as Promise<Hex>;
  assert.notEqual(await valid(), ERC1271_MAGIC);

  // A loosening waits the delay; cancelled.
  assert.equal((await owner.borro.setLock("USDG", wallet, 129_600, "200")).status, "sent");
  g = await readVaultGuard(client, vault);
  assert.equal(g.pendingLock?.lock.dailyLimit, 200_000_000n);
  assert.equal(g.lock.dailyLimit, 100_000_000n);
  assert.equal((await owner.borro.cancelPending("USDG")).status, "sent");
  assert.equal((await readVaultGuard(client, vault)).pendingLock, null);

  await fork.increaseTime(129_600 + 1);
  assert.equal(await valid(), ERC1271_MAGIC);

  // A recovery under the lock: the guardian supports a new seed; after the delay its first operation sends
  // finishRecovery first (the new key's own spend does not finish a recovery under the lock), then lands.
  const fresh = device("lock-new-device", 73);
  const asked = await fresh.buyer.requestRecovery(vault);
  assert.equal((await guardian.buyer.supportRecovery(vault, asked.newKeyRoot)).status, "sent");
  const waiting = await fresh.buyer.requestRecovery(vault);
  assert.equal(waiting.status, "waiting_for_delay");
  assert.match(waiting.note, /does not cancel it/);
  // The old key (a thief holding the old seed, say) spends within the limit meanwhile: under the lock that does not
  // cancel the recovery, but it moves the nonce past the key the guardians supported.
  assert.equal((await owner.buyer.withdraw(someone("thief"), "1")).status, "sent");
  assert.equal(await nonceOf(vault), BigInt(asked.nonce) + 1n);
  await fork.increaseTime(DEFAULT_RECOVERY_DELAY + 1);
  const payee = someone("payee-after-recovery");
  assert.equal((await fresh.buyer.withdraw(payee, "1")).status, "sent");
  assert.equal(await usdg(payee), 1_000_000n);
  // The recovery finished to the key supported at the earlier nonce, which signed this withdrawal; then the keys run on.
  assert.equal(await nonceOf(vault), BigInt(asked.nonce) + 2n);
  assert.equal((await fresh.buyer.requestRecovery(vault)).status, "recovered");
  assert.equal((await fresh.buyer.withdraw(payee, "1")).status, "sent");
  assert.equal(await usdg(payee), 2_000_000n);
  // The approval given before the recovery no longer counts.
  assert.notEqual(await valid(), ERC1271_MAGIC);
  await assert.rejects(owner.buyer.withdraw(payee, "1"), /does not match the expected key root/);
});
