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
//   * the vesting released after its cliff;
//   * an OSTRA pair: OSTRA in the agent's OSTRA vault (dealt: OSTRA graduated
//     from its Pons curve on 22 Oct 2026, so the curve sells no more), the
//     OSTRA creator vault funded from it, a launch at a market cap in US
//     dollars (ETH/USD times OSTRA's price in its pool) with a dev buy in OSTRA,
//     a buy paid in OSTRA from the OSTRA vault and a sale back into it, the
//     creator vault's OSTRA withdrawn to the OSTRA vault by default, and the
//     dispatcher owing the $OSTRA buyback share in OSTRA, which its owner
//     claims straight to the burn address (as ostra-swap's buyback does).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createWalletClient, formatUnits, http, keccak256, stringToHex, type Address, type Hash, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  OSTRA,
  USDG,
  ostraDispatcherAbi,
  ostraTokenAbi,
  readVault,
  retryingHttp,
  usdgAbi,
  type Deployment,
  type RelayCall,
} from "@ostraagent/sdk";
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

// Runs first: the next test moves the fork's clock 7 days on, past Chainlink ETH/USD's heartbeat, and OSTRA's
// price needs ETH/USD.
test("an OSTRA pair: fund, launch at a market cap in US dollars with a dev buy, buy and sell in OSTRA, withdraw, the buyback owed in OSTRA", { timeout: 900_000 }, async () => {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/LAUNCHPAD-FORK/ostra-fee-payer")));
  await fork.setBalance(feePayer.address, 10n ** 19n);
  const keys = new Keys({ master: new Uint8Array(32).fill(22), feePayer, store: new FileWotsStore(join(root, "wots-ostra")), folder: new MemoryFolder(), backupExported: async () => true });
  const creatorKeys = await keys.forCreatorVault(d.chainId, USDG);
  const local = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, local, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, local, "creator");
  const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: local, creator, creatorSender: local });
  await buyer.open();

  // OSTRA straight into the agent's OSTRA vault (not created yet): about what 0.3 ETH buys in its pool.
  const ostraVault = await lp.tokenVault(OSTRA).vaultAddress();
  await fork.dealToken(ostraVault, OSTRA, 7_000_000n * 10n ** 18n);
  const held = await tokens(OSTRA, ostraVault);
  assert.ok(held > 0n);

  // The pairs list names OSTRA third, priced, with the agent's OSTRA vault as its trading vault.
  const rows = await lp.pairs({ prices: true });
  assert.deepEqual(rows.slice(0, 3).map((r) => r.symbol), ["USDG", "ETH", "OSTRA"]);
  const row = rows[2];
  assert.ok(row !== undefined && row.kind === "ostra" && row.tradingVault === ostraVault && row.priceUsd !== null && Number(row.priceUsd) > 0, JSON.stringify(row));

  // Half of it into the OSTRA creator vault (the OSTRA vault is created first).
  const half = held / 2n;
  await lp.fundCreatorVault(formatUnits(half, 18), "OSTRA");
  const { vault: ostraCreator } = await lp.pairCreator("OSTRA");
  const ostraCreatorVault = await ostraCreator.vaultAddress();
  assert.equal(await tokens(OSTRA, ostraCreatorVault), half);
  assert.equal(await tokens(OSTRA, ostraVault), held - half);

  // A launch paired with OSTRA at $20,000, with a dev buy of 1,000,000 OSTRA.
  const launched = await lp.launch({ name: "Ostra Pair", symbol: "OPAIR", pair: "OSTRA", marketCap: "20000", devBuy: { amount: "1000000", cliffDays: 7 } });
  assert.equal(launched.status, "launched");
  if (launched.status !== "launched") return;
  assert.equal(launched.pair, "OSTRA");
  assert.equal(launched.creatorVault, ostraCreatorVault);
  assert.equal(launched.marketCapUsd, "20000");
  assert.ok(launched.pairPriceUsd !== null && Number(launched.pairPriceUsd) > 0);
  // The market cap in OSTRA is the dollars at the price used (to its 8 decimals).
  assert.ok(Math.abs(Number(launched.marketCapInPair) * Number(launched.pairPriceUsd) - 20_000) / 20_000 < 0.002, `${launched.marketCapInPair} OSTRA at ${launched.pairPriceUsd}`);
  assert.ok(launched.devBuy !== null && Number(launched.devBuy.paid) > 0 && Number(launched.devBuy.paid) <= 1_000_000);
  const token = launched.token;

  // A buy paid in OSTRA from the OSTRA vault, into the agent's vault for the token; half of it sold back into the OSTRA vault.
  const ostraBefore = await tokens(OSTRA, ostraVault);
  const bought = await lp.buy({ token, amount: "2000000" });
  assert.ok(bought.status === "sent" && bought.swapped && bought.from === ostraVault && bought.to === launched.tokenVault, JSON.stringify(bought));
  assert.equal(await tokens(OSTRA, ostraVault), ostraBefore - 2_000_000n * 10n ** 18n);
  const got = await tokens(token, launched.tokenVault);
  const sold = await lp.sell({ token, amount: formatUnits(got / 2n, 18) });
  assert.ok(sold.status === "sent" && sold.swapped && sold.to === ostraVault, JSON.stringify(sold));
  assert.ok((await tokens(OSTRA, ostraVault)) > ostraBefore - 2_000_000n * 10n ** 18n);

  // The OSTRA creator vault sends OSTRA to the agent's OSTRA vault when no destination is named.
  const beforeWithdraw = await tokens(OSTRA, ostraVault);
  const withdrawn = (await lp.creatorWithdraw({ amount: "1000", pair: "OSTRA" })) as { status?: string };
  assert.equal(withdrawn.status, "sent", JSON.stringify(withdrawn));
  assert.equal(await tokens(OSTRA, ostraVault), beforeWithdraw + 1_000n * 10n ** 18n);

  // The hook booked the $OSTRA buyback share of these swaps in OSTRA.
  const lpd = d.launchpad;
  assert.ok(lpd !== undefined);
  const owed = (await fork.client.readContract({ address: lpd.dispatcher, abi: ostraDispatcherAbi, functionName: "buybackOwed", args: [OSTRA] })) as bigint;
  assert.ok(owed > 0n);
  // The buyback (ostra-swap sdk/scripts/buyback.ts) claims the part owed in OSTRA straight to the burn address.
  const owner = (await fork.client.readContract({ address: lpd.dispatcher, abi: ostraDispatcherAbi, functionName: "owner" })) as Address;
  await fork.client.request({ method: "anvil_impersonateAccount" as never, params: [owner] as never });
  await fork.setBalance(owner, 10n ** 18n);
  const dead: Address = "0x000000000000000000000000000000000000dEaD";
  const deadBefore = await tokens(OSTRA, dead);
  const claim = await createWalletClient({ account: owner, chain: fork.client.chain, transport: http(fork.url) }).writeContract({ address: lpd.dispatcher, abi: ostraDispatcherAbi, functionName: "claimBuyback", args: [OSTRA, dead], account: owner, chain: fork.client.chain });
  assert.equal((await fork.client.waitForTransactionReceipt({ hash: claim })).status, "success");
  assert.equal(await tokens(OSTRA, dead), deadBefore + owed, "the OSTRA owed went to the burn address");
  assert.equal(await fork.client.readContract({ address: lpd.dispatcher, abi: ostraDispatcherAbi, functionName: "buybackOwed", args: [OSTRA] }), 0n);
});

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
