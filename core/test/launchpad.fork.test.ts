// The launchpad service on a fork of Robinhood Chain mainnet, with the agent's
// own fee payer sending (LocalSender, as without the relayer; the relayer path
// runs in scripts/chain-check.ts):
//   * a launch the contract would refuse (a dev buy above 5% of the supply)
//     is refused by its quote before anything is signed;
//   * a launch from the creator vault with a dev buy: the vault pays the dev
//     buy inside the launch it signed, the tokens vest to the agent's token
//     vault; a launch signed and not landed is sent first by the next call on
//     the creator vault, from the launch kept before signing;
//   * buy (creating the token vault in the same transaction) and sell back,
//     with a referrer whose earnings are then claimed;
//   * pool settings and creator shares from the creator vault, refused before
//     signing when the hook would refuse them;
//   * an airdrop round: bought into OstraAirdrop, started with its tree,
//     claimed for an account, closed after the claim period;
//   * the vesting released after its cliff.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { keccak256, stringToHex, type Address, type Hash, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, USDG, ostraTokenAbi, readVault, retryingHttp, usdgAbi, type Deployment, type RelayCall } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, LaunchpadService, LocalSender, VaultService, X402_NETWORK, type Config, type Reservation, type Sender, type SendOptions } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;

/** A sender that fails its next send without sending, when armed: the process stopped after the spend was signed. */
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

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-launchpad-"));
  fork = await startFork();
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** A fresh address for `name` (no key is used). */
const someone = (name: string): Address => privateKeyToAccount(keccak256(stringToHex(`OSTRA/CORE/LAUNCHPAD-FORK/${name}`))).address;
const usdg = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] });
const tokens = (token: Address, who: Address) => fork.client.readContract({ address: token, abi: ostraTokenAbi, functionName: "balanceOf", args: [who] });

test("the launchpad service: launch with a dev buy, buy and sell, settings, shares, an airdrop round, the vesting", { timeout: 900_000 }, async () => {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/LAUNCHPAD-FORK/fee-payer")));
  await fork.setBalance(feePayer.address, 10n ** 18n);
  const keys = new Keys({ master: new Uint8Array(32).fill(21), feePayer, store: new FileWotsStore(join(root, "wots")), folder: new MemoryFolder(), backupExported: async () => true });
  const creatorKeys = await keys.forCreatorVault(d.chainId, USDG);
  const local = new LocalSender(client, transport, feePayer);
  const creatorSender = new StopOnce(local);
  const buyer = new VaultService(client, transport, config, keys, local, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, creatorSender, "creator");
  const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: local, creator, creatorSender });

  const opened = await buyer.open();
  await fork.dealUsdg(opened.vault, 500_000_000n);
  await lp.fundCreatorVault("200");
  const creatorVault = await creator.vaultAddress();
  assert.equal(await usdg(creatorVault), 200_000_000n);

  // A dev buy of 150 USDG at a 1,000 USDG market cap buys far more than 5% of the supply: refused by the quote.
  const nonceBefore = (await readVault(client, d, creatorVault))?.nonce;
  await assert.rejects(lp.launch({ name: "Too Big", symbol: "BIG", marketCap: "1000", devBuy: { amount: "150" } }), /launch fails now/);
  assert.equal((await readVault(client, d, creatorVault))?.nonce, nonceBefore);
  assert.equal((await creator.state()).pendingAction, null);

  // The launch: signed, then the process stops before sending it.
  creatorSender.armed = true;
  await assert.rejects(lp.launch({ name: "Ostra Core Launch", symbol: "OCORE", marketCap: "50000", devBuy: { amount: "50", cliffDays: 7, vestingDays: 30 } }), /signed launch is kept/);
  assert.equal((await creator.state()).pendingAction, 9);
  // The next operation of the creator vault sends the launch first (from the launch kept before signing).
  const second = await lp.launch({ name: "Another", symbol: "ANOTHER", marketCap: "50000" });
  assert.equal(second.status, "resent_pending");
  assert.equal(await usdg(creatorVault), 150_000_000n);
  assert.equal((await creator.state()).pendingAction, null);
  // A launch without a dev buy pays nothing from the vault.
  const plain = await lp.launch({ name: "Plain Launch", symbol: "PLAIN", marketCap: "20000" });
  assert.equal(plain.status, "launched");
  assert.equal(await usdg(creatorVault), 150_000_000n);
  assert.equal(plain.status === "launched" && plain.devBuy, null);

  // The launch with the dev buy, sent again: its token is in the pool records the launchpad keeps.
  const launched = await lp.launch({ name: "Ostra Core Launch 2", symbol: "OCORE2", marketCap: "50000", devBuy: { amount: "40", cliffDays: 7, vestingDays: 30 } });
  assert.equal(launched.status, "launched");
  if (launched.status !== "launched") return;
  assert.ok(launched.devBuy !== null && Number(launched.devBuy.paid) > 0 && Number(launched.devBuy.paid) <= 40);
  const token = launched.token;
  const info = await lp.poolInfo(token);
  assert.equal(info.creatorVault, creatorVault);
  assert.equal(info.symbol, "OCORE2");
  assert.ok(Number(info.marketCap) > 40_000, info.marketCap);
  assert.ok(info.band !== null);

  // Buy into the agent's token vault (created in the same transaction), with a referrer.
  const referrer = someone("referrer");
  const quoted = await lp.quote({ side: "buy", token, amount: "10" });
  assert.ok(Number(quoted.expectedOut) > 0);
  const bought = await lp.buy({ token, amount: "10", referrer });
  assert.equal(bought.status, "sent");
  if (bought.status !== "sent") return;
  assert.equal(bought.swapped, true);
  const tokenVault = launched.tokenVault;
  assert.equal(bought.to, tokenVault);
  assert.ok((await readVault(client, d, tokenVault)) !== null, "the token vault was created with the buy");
  const held = await tokens(token, tokenVault);
  assert.ok(held > 0n);
  assert.equal((await lp.tokenVaultInfo(token)).exists, true);
  // Sell half back: USDG into the buyer vault.
  const usdgBefore = await usdg(opened.vault);
  const sold = await lp.sell({ token, amount: (Number(held / 2n) / 1e18).toFixed(6) });
  assert.equal(sold.status, "sent");
  assert.ok(sold.status === "sent" && sold.swapped);
  assert.ok((await usdg(opened.vault)) > usdgBefore);
  const earned = await lp.claimReferral({ referrer });
  assert.ok(Number(earned.amount) > 0);
  assert.ok((await usdg(referrer)) > 0n);

  // Pool settings: the hook refuses a change that is not in the traders' favour, so nothing is signed.
  const creatorNonce = (await readVault(client, d, creatorVault))?.nonce;
  await assert.rejects(lp.setPoolSetting({ token, setting: "max_tx_move", value: "1500" }), /fails now/);
  assert.equal((await readVault(client, d, creatorVault))?.nonce, creatorNonce);
  const loosened = await lp.setPoolSetting({ token, setting: "max_tx_move", value: "3000" });
  assert.equal(loosened.status, "sent");
  const share = await lp.setCreatorShare({ token, recipient: someone("share"), bps: 2_000 });
  assert.equal(share.status, "sent");
  assert.deepEqual((await lp.poolInfo(token)).creatorShares, [{ recipient: someone("share"), bps: 2_000 }]);

  // An airdrop round: bought into OstraAirdrop, started with its tree, one claim, closed after the claim period.
  const funded = await lp.airdropFund({ token, amount: "20" });
  assert.ok(funded.status === "sent" && funded.swapped);
  const [a1, a2] = [someone("a1"), someone("a2")];
  const started = await lp.airdropStart({ token, entries: [{ account: a1, amount: "1000" }, { account: a2, amount: "2500.5" }] });
  assert.equal(started.round, 1);
  assert.equal(started.total, "3500.5");
  assert.equal(started.sent.length, 2);
  const claim = await lp.airdropClaim({ token, account: a1 });
  assert.equal(claim.amount, "1000");
  assert.equal(await tokens(token, a1), 1_000n * 10n ** 18n);
  await assert.rejects(lp.airdropClaim({ token, account: a1 }), /claimed round 1 already/);
  await assert.rejects(lp.airdropClose(token), /can be closed from/);
  await fork.increaseTime(7 * 86_400 + 10);
  const closed = await lp.airdropClose(token);
  assert.equal(closed.burned, "2500.5");
  assert.equal((await lp.poolInfo(token)).airdrop.open, false);

  // The vesting: the cliff (7 days) is over, part of the 30 days has vested.
  const vest = await lp.vestingInfo({ token });
  assert.equal(vest.beneficiary, tokenVault);
  const beforeRelease = await tokens(token, tokenVault);
  const released = await lp.vestingRelease({ token });
  assert.ok(Number(released.amount) > 0);
  assert.ok((await tokens(token, tokenVault)) > beforeRelease);
  assert.equal((await lp.launches()).length, 2);
});
