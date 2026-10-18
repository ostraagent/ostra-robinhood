// Guardian recovery through the vault service on a fork of Robinhood Chain
// mainnet, with the agent's own fee payer sending (LocalSender):
//   * the owner sets three guardian vaults and a policy of 2 of 3 after the
//     default delay; what is already set signs nothing;
//   * a new device with a new seed (the old seed and device lost) adopts the
//     vault and gets the key root its guardians support; two of them do;
//   * before the delay is over the new seed signs nothing; after it, the new
//     seed's first withdrawal finishes the recovery and lands, and the old
//     seed can no longer spend;
//   * guardians starting a recovery to another key: the vault's current key
//     cancels it with any spend, and that key root never gets the vault;
//   * a recovery operation signed and not landed is reported and sent first.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { bytesToHex, keccak256, stringToHex, type Address, type Hash, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_RECOVERY_DELAY, FileWotsStore, USDG, VAULT_ACTION, readVault, retryingHttp, usdgAbi, type Deployment, type RelayCall } from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, LocalSender, VaultService, X402_NETWORK, type Config, type Reservation, type Sender, type SendOptions } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;

const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/RECOVERY-FORK/fee-payer")));

/** A sender that fails its next send without sending: the process stopped after the spend was signed. */
class StopOnce implements Sender {
  readonly relayed = false;
  readonly #inner: Sender;
  armed = false;
  constructor(inner: Sender) {
    this.#inner = inner;
  }
  payer(): Promise<Address> {
    return this.#inner.payer();
  }
  async send(calls: RelayCall[], options?: SendOptions): Promise<Hash> {
    if (this.armed) {
      this.armed = false;
      throw new Error("stopped before sending");
    }
    return this.#inner.send(calls, options);
  }
  reserve(): Promise<Reservation | null> {
    return Promise.resolve(null);
  }
  release(): void {}
}

/** A device: its own seed, WOTS store and records; every one sends with the same fee payer. */
function device(name: string, seed: number): { keys: Keys; vault: VaultService } {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder: new MemoryFolder(), backupExported: async () => true });
  return { keys, vault: new VaultService(client, transport, config, keys, new LocalSender(client, transport, feePayer), "buyer") };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-recovery-"));
  fork = await startFork();
  d = await deployOnFork(fork);
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("guardian recovery: 2 of 3 guardians support a new seed, the delay passes, the new seed's first withdrawal finishes it; the current key cancels another", async () => {
  const client = fork.client as PublicClient;
  const balanceOf = (x: Address) => client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [x] });
  const payee = fork.accounts[3]!.address;

  // The owner's vault and three guardian vaults (other Ostra vaults: the recovery stays post-quantum).
  const owner = device("owner", 41);
  const vault = (await owner.vault.open()).vault;
  await fork.dealUsdg(vault, 5_000_000n);
  const guardians = [device("guardian-1", 42), device("guardian-2", 43), device("guardian-3", 44)];
  const guardianVaults: Address[] = [];
  for (const g of guardians) guardianVaults.push((await g.vault.open()).vault);

  const none = await owner.vault.recovery();
  assert.deepEqual(none, { vault, guardianCount: 0, threshold: 0, delaySeconds: 0, pending: null });
  await assert.rejects(owner.vault.setRecoveryPolicy(2, DEFAULT_RECOVERY_DELAY), /fewer than a threshold of 2/);
  await assert.rejects(owner.vault.setRecoveryPolicy(2, 3_600), /delay must be/);
  await assert.rejects(owner.vault.setGuardian(vault, true), /its own guardian/);
  for (const g of guardianVaults) assert.equal((await owner.vault.setGuardian(g, true)).status, "sent");
  assert.equal((await owner.vault.setGuardian(guardianVaults[0]!, true)).status, "unchanged");
  assert.equal((await owner.vault.setRecoveryPolicy(2, DEFAULT_RECOVERY_DELAY)).status, "sent");
  assert.equal((await owner.vault.setRecoveryPolicy(2, DEFAULT_RECOVERY_DELAY)).status, "unchanged");
  assert.deepEqual(await owner.vault.recovery(), { vault, guardianCount: 3, threshold: 2, delaySeconds: DEFAULT_RECOVERY_DELAY, pending: null });
  assert.equal((await owner.vault.status()).nonce, "4");

  // A vault without recovery cannot be taken over by a new seed.
  await assert.rejects(device("nobody", 45).vault.requestRecovery(guardianVaults[2]!), /no guardian recovery set/);

  // The device and the seed are lost: a new device with a new seed adopts the vault.
  const fresh = device("new-device", 46);
  const asked = await fresh.vault.requestRecovery(vault);
  assert.equal(asked.status, "waiting_for_guardians");
  assert.equal(asked.nonce, "4");
  assert.equal(asked.newKeyRoot, bytesToHex(fresh.keys.vaultKeychain(d.chainId, USDG).keyRoot(4n)));
  assert.equal(await fresh.vault.vaultAddress(), vault);

  assert.equal((await guardians[0]!.vault.supportRecovery(vault, asked.newKeyRoot)).status, "sent");
  assert.equal((await guardians[0]!.vault.supportRecovery(vault, asked.newKeyRoot)).status, "unchanged");
  assert.equal((await fresh.vault.requestRecovery(vault)).status, "waiting_for_guardians");
  await assert.rejects(owner.vault.supportRecovery(guardianVaults[0]!, asked.newKeyRoot), /is not a guardian of/);
  assert.equal((await guardians[1]!.vault.supportRecovery(vault, asked.newKeyRoot)).status, "sent");
  const waiting = await fresh.vault.requestRecovery(vault);
  assert.equal(waiting.status, "waiting_for_delay");
  assert.equal(waiting.recovery.pending?.mine, true);
  assert.equal(waiting.recovery.pending?.ready, false);

  // Before the delay is over the new seed signs nothing.
  await assert.rejects(fresh.vault.withdraw(payee, "1"), /past its delay/);
  assert.equal((await readVault(client, d, vault))?.nonce, 4n);

  await fork.increaseTime(DEFAULT_RECOVERY_DELAY + 1);
  assert.equal((await fresh.vault.requestRecovery(vault)).status, "ready");
  const payeeBefore = await balanceOf(payee);
  const w = await fresh.vault.withdraw(payee, "1");
  assert.equal(w.status, "sent");
  assert.equal((await balanceOf(payee)) - payeeBefore, 1_000_000n);
  const v = await readVault(client, d, vault);
  assert.equal(v?.nonce, 5n);
  assert.equal(v?.keyRoot.toLowerCase(), bytesToHex(fresh.keys.vaultKeychain(d.chainId, USDG).keyRoot(5n)));
  assert.equal((await fresh.vault.requestRecovery(vault)).status, "recovered");
  const s = await fresh.vault.status();
  assert.equal(s.vault, vault);
  assert.equal(s.balance, "4");
  assert.equal(s.nonce, "5");
  // The old seed (a thief holding it, say) no longer spends the vault.
  await assert.rejects(owner.vault.withdraw(payee, "1"), /does not match the expected key root/);

  // Guardians start a recovery to another seed's key: the vault's current key cancels it.
  const other = device("other-device", 47);
  const theirs = await other.vault.requestRecovery(vault);
  assert.equal(theirs.status, "waiting_for_guardians");
  assert.equal((await guardians[0]!.vault.supportRecovery(vault, theirs.newKeyRoot)).status, "sent");
  assert.equal((await guardians[2]!.vault.supportRecovery(vault, theirs.newKeyRoot)).status, "sent");
  const started = await fresh.vault.recovery();
  assert.equal(started.pending?.newKeyRoot, theirs.newKeyRoot);
  assert.equal(started.pending?.mine, false);
  assert.equal((await fresh.vault.cancelRecovery()).status, "sent");
  assert.equal((await fresh.vault.recovery()).pending, null);
  assert.deepEqual(await fresh.vault.cancelRecovery(), { status: "nothing_to_cancel" });
  await fork.increaseTime(DEFAULT_RECOVERY_DELAY + 1);
  await assert.rejects(other.vault.withdraw(payee, "1"), /past its delay/);
  assert.equal((await other.vault.requestRecovery(vault)).status, "waiting_for_guardians");
  assert.equal(await balanceOf(vault), 4_000_000n);

  // A recovery operation signed and not landed: reported, then sent before the next one.
  const flaky = new StopOnce(new LocalSender(client, retryingHttp(fork.url), feePayer));
  flaky.armed = true;
  await assert.rejects(fresh.vault.setGuardian(guardianVaults[2]!, false, flaky), /the next call on this vault sends it again/);
  assert.deepEqual((await fresh.vault.status()).pendingOperation, { action: VAULT_ACTION.SET_GUARDIAN });
  const resent = await fresh.vault.setRecoveryPolicy(1, DEFAULT_RECOVERY_DELAY);
  assert.equal(resent.status, "resent_pending");
  assert.deepEqual(resent.status === "resent_pending" && { operation: resent.resent.operation, action: resent.resent.operation === "vault_spend" && resent.resent.action }, { operation: "vault_spend", action: VAULT_ACTION.SET_GUARDIAN });
  assert.equal((await fresh.vault.status()).pendingOperation, undefined);
  assert.equal((await fresh.vault.recovery()).guardianCount, 2);
  await assert.rejects(fresh.vault.setGuardian(guardianVaults[1]!, false), /fewer than the threshold of 2/);
  assert.equal((await fresh.vault.setRecoveryPolicy(1, DEFAULT_RECOVERY_DELAY)).status, "sent");
  assert.equal((await fresh.vault.recovery()).threshold, 1);
});
