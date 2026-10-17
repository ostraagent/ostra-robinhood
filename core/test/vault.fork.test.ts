// The vault and channel services on a fork of Robinhood Chain mainnet, with
// the agent's own fee payer sending (LocalSender, as without the relayer):
//   * a spend signed and not landed blocks the vault until it is sent: it is
//     reported as pending and sent first by the next call;
//   * a withdrawal to an address USDG froze is refused before anything is
//     signed (USDG's real asset protection role freezes it on the fork);
//   * a channel to a vault without a crank: close_channel sends requestClose,
//     waits out the grace period, then finalizeWithdraw returns the deposit;
//     a machine restored from the seed (no records) closes it after reading
//     its config back from the chain.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { encodeFunctionData, keccak256, numberToHex, parseAbi, stringToHex, zeroAddress, type Address, type Hash, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, USDG, ostraVaultFactoryAbi, readChannel, retryingHttp, usdgAbi, vaultAddress, type Deployment, type RelayCall } from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { ChannelService, Keys, LocalSender, VaultService, X402_NETWORK, type Config, type Reservation, type Sender, type SendOptions } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";

/** USDG's asset protection role holder on Robinhood Chain (checked on the fork by test/Pool.fork.t.sol). */
const ASSET_PROTECTION: Address = "0x3Af3e85f4f97De7AD0f000B724Fb77fE5ffc024B";
const freezeAbi = parseAbi(["function freeze(address account)", "function unfreeze(address account)"]);

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;

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

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(fork.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function agent(dir: string, master: Uint8Array, folder = new MemoryFolder()) {
  const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/VAULT-FORK/fee-payer")));
  const keys = new Keys({ master, feePayer, store: new FileWotsStore(join(root, dir)), folder, backupExported: async () => true });
  return { keys, feePayer };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-vault-"));
  fork = await startFork();
  d = await deployOnFork(fork);
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("a signed spend that did not land is reported and sent first; a frozen destination is refused before signing", async () => {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const { keys, feePayer } = agent("wots-a", new Uint8Array(32).fill(11));
  await fork.setBalance(feePayer.address, 10n ** 18n);
  const flaky = new StopOnce(new LocalSender(client, transport, feePayer));
  const vault = new VaultService(client, transport, config, keys, flaky, "buyer");
  const opened = await vault.open();
  assert.equal(opened.created, true);
  await fork.dealUsdg(opened.vault, 5_000_000n);
  const [a, b] = [fork.accounts[2]!.address, fork.accounts[3]!.address];
  const balanceOf = (x: Address) => client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [x] });
  const aBefore = await balanceOf(a);
  const bBefore = await balanceOf(b);

  flaky.armed = true;
  await assert.rejects(vault.withdraw(a, "0.5"), /the signed withdrawal is kept/);
  const s = await vault.status();
  assert.equal(s.nonce, "0");
  assert.deepEqual(s.pendingWithdrawal, { destination: a, amount: "0.5" });

  const other = await vault.withdraw(b, "0.1");
  assert.equal(other.status, "resent_pending");
  assert.equal(other.status === "resent_pending" && other.resent.operation, "withdraw");
  assert.equal((await balanceOf(a)) - aBefore, 500_000n);
  assert.equal((await vault.status()).pendingWithdrawal, null);
  const now = await vault.withdraw(b, "0.1");
  assert.equal(now.status, "sent");
  assert.equal((await balanceOf(b)) - bBefore, 100_000n);

  // The same withdrawal as the one pending: sending the pending one is the answer.
  flaky.armed = true;
  await assert.rejects(vault.withdraw(b, "0.2"), /kept/);
  const same = await vault.withdraw(b, "0.2");
  assert.equal(same.status, "sent");
  assert.equal((await balanceOf(b)) - bBefore, 300_000n);
  assert.equal((await vault.status()).nonce, "3");

  // A frozen destination: refused, nothing signed.
  await rpc("anvil_impersonateAccount", [ASSET_PROTECTION]);
  await rpc("anvil_setBalance", [ASSET_PROTECTION, numberToHex(10n ** 18n)]);
  const freeze = (fn: "freeze" | "unfreeze") => rpc("eth_sendTransaction", [{ from: ASSET_PROTECTION, to: USDG, data: encodeFunctionData({ abi: freezeAbi, functionName: fn, args: [b] }) }]);
  const tx = (await freeze("freeze")) as Hash;
  assert.equal((await client.waitForTransactionReceipt({ hash: tx })).status, "success");
  await assert.rejects(vault.withdraw(b, "0.1"), /frozen/);
  const after = await vault.status();
  assert.equal(after.nonce, "3");
  assert.equal(after.pendingWithdrawal, null);
  await client.waitForTransactionReceipt({ hash: (await freeze("unfreeze")) as Hash });
  await rpc("anvil_stopImpersonatingAccount", [ASSET_PROTECTION]);
});

test("a channel to a vault without a crank closes on the payer path: requestClose, the grace period, finalizeWithdraw; restored from the seed", async () => {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const master = new Uint8Array(32).fill(12);
  const { keys, feePayer } = agent("wots-b", master);
  await fork.setBalance(feePayer.address, 10n ** 18n);
  const local = new LocalSender(client, transport, feePayer);
  const vault = new VaultService(client, transport, config, keys, local, "buyer");
  const channels = new ChannelService(client, config, keys, vault, local);
  const opened = await vault.open();
  await fork.dealUsdg(opened.vault, 3_000_000n);

  // The payee: an Ostra vault created by someone else, without a crank (nobody claims or refunds for it).
  const root0 = keccak256(stringToHex("OSTRA/CORE/VAULT-FORK/payee"));
  const deployer = fork.accounts[0]!;
  const h = await fork.wallet(deployer).writeContract({ address: d.vaultFactory, abi: ostraVaultFactoryAbi, functionName: "createVault", args: [USDG, root0, zeroAddress], account: deployer, chain: fork.client.chain });
  await client.waitForTransactionReceipt({ hash: h });
  const payee = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: USDG, initialKeyRoot: root0, initialCrank: zeroAddress });

  await assert.rejects(channels.open({ payee: fork.accounts[3]!.address, deposit: "1", gracePeriod: 900 }), /not an Ostra vault/);
  await assert.rejects(channels.open({ payee, deposit: "1", gracePeriod: 899 }), /gracePeriod/);
  const ch = await channels.open({ payee, deposit: "1", gracePeriod: 900 });
  assert.equal(ch.status, "open");
  if (ch.status !== "open") return;
  assert.equal((await readChannel(client, d.batchSettlement, ch.channel)).balance, 1_000_000n);
  assert.equal((await channels.list())[0]?.status, "open");

  // A machine restored from the seed: same master seed and WOTS store, no records.
  const restored = agent("wots-b", master).keys;
  const vault2 = new VaultService(client, transport, config, restored, local, "buyer");
  const channels2 = new ChannelService(client, config, restored, vault2, local);
  const first = await channels2.close(ch.channel);
  assert.deepEqual(first.sent.map((s) => s.step), ["request_close"]);
  assert.equal(first.status, "closing");
  assert.match(String(first.next), /grace period ends/);
  await fork.increaseTime(901);
  assert.deepEqual(await channels2.continueClosing(), []);
  const after = await readChannel(client, d.batchSettlement, ch.channel);
  assert.equal(after.balance, 0n);
  assert.equal(after.pendingWithdrawal, null);
  assert.equal(await client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [opened.vault] }), 3_000_000n);
  const done = await channels2.close(ch.channel);
  assert.equal(done.status, "closed");
  assert.deepEqual(done.sent, []);
  assert.deepEqual(await channels2.list(), []);
});
