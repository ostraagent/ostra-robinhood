// A stock vault that holds stock but was never created (MCP 0.1.22), at the live deployment (vaults of version 5),
// through the core services on a fork of Robinhood Chain mainnet, against the live OstraRouter, Raeto's NVDA vault and
// the ERC-8004 Identity Registry, with the agent's own fee payer sending (LocalSender):
//   * NVDA bought through Ostra Swap into the NVDA vault, which does not exist: the venues read it as a vault with no
//     venue (venueOf, state) instead of failing; the treasury, with NVDA opted in, plans for it (its row in the plan's
//     stocks) instead of passing over it; the treasury's set_venue step for Raeto's NVDA vault, run through
//     StrategyService.apply, creates the vault first, then enables it (in force at once: no withdrawal lock);
//   * an empty vault not created is never created: venue_set refuses it as before, and the set_venue step is skipped.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createPublicClient, getAddress, http, keccak256, stringToHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, USDG, borroStock, readVault, retryingHttp, robinhoodChain, usdgAbi, type Deployment } from "@ostraagent/sdk";
import { liveAtV5, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { parseSwapDeployment, type SwapDeployment } from "@ostraagent/swap";
import { BorroService, Keys, LaunchpadService, LocalSender, StrategyService, SwapService, VaultService, VenueService, X402_NETWORK, venueByName, type Config, type Step } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";
import { splitLogsClient } from "./split-logs.ts";

const SWAP: SwapDeployment = parseSwapDeployment(JSON.parse(readFileSync(new URL("../../../ostra-swap/deployments/robinhood-mainnet.json", import.meta.url), "utf8")));
const LIVE_DEPLOYMENT = fileURLToPath(new URL("../../deployments/robinhood-mainnet.json", import.meta.url));

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
let forkBlock: bigint;
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/UNCREATED-VAULT-V5-FORK/fee-payer")));
const chainGasPrice = async () => (await fork.client.getBlock({ blockNumber: forkBlock })).baseFeePerGas as bigint;
const quoteClient = () => createPublicClient({ chain: robinhoodChain, transport: http(fork.url, { timeout: 300_000 }) }) as PublicClient;
const balanceOf = (token: Address, who: Address) => fork.client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const exists = async (vault: Address) => (await readVault(fork.client as PublicClient, d, vault)) !== null;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-uncreated-v5-"));
  fork = await startFork();
  forkBlock = await fork.client.getBlockNumber({ cacheTime: 0 });
  d = await liveAtV5(fork, LIVE_DEPLOYMENT);
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** Runs a set_venue step of `venue` through StrategyService.apply, as a plan kept in the planner's folder. */
async function applyEnable(a: { keys: Keys; strategy: StrategyService }, venue: string, n: number) {
  const id = `${Math.floor(Date.now() / 1000)}-${n}`;
  const dir = a.keys.folder.folder("strategy").folder("plans");
  await dir.ensure();
  const steps: Step[] = [{ kind: "set_venue", what: venue, amount: "1", urgent: false, notBefore: 0, cost: "0", reason: "the test's step" }];
  await dir.write(`${id}.json`, JSON.stringify({ id, profile: "treasury", at: 0, steps, keep: "0", expected30d: "0", cashApy: "0", trading: null, risks: [], stopWhen: [], breaker: "" }));
  return a.strategy.apply(id);
}

async function agent(name: string, seed: number) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder: new MemoryFolder(), backupExported: async () => true });
  const creatorKeys = await keys.forCreatorVault(d.chainId, USDG);
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, sender, "creator");
  const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: sender, creator, creatorSender: sender });
  const tokenVault = (token: Address) => lp.tokenVault(token);
  const swap = new SwapService({ client: quoteClient(), logsClient: splitLogsClient(fork.url, forkBlock), config, swap: SWAP, vaultFor: tokenVault, sender, folder: keys.folder.folder("ostra-swap") });
  const ownVaults = async () => [await buyer.vaultAddress(), await creator.vaultAddress()];
  const borro = new BorroService({ client, config, buyer, tokenVault, sender, ownVaults, gasPrice: chainGasPrice });
  const venues = new VenueService({ client, logsClient: splitLogsClient(fork.url, forkBlock), config, buyer, tokenVault, sender, borro, folder: keys.folder.folder("strategy") });
  const strategy = new StrategyService({ client, logsClient: splitLogsClient(fork.url, forkBlock), config, buyer, tokenVault, creator, borro, folder: keys.folder.folder("strategy"), agentId: async () => null, ethClient: null, venues });
  const opened = await buyer.open();
  await fork.dealUsdg(opened.vault, 500_000_000n);
  return { keys, lp, tokenVault, swap, venues, strategy };
}

test("NVDA in a vault not created yet: read as a vault with no venue, planned by the treasury, created by venue_set's enable", { timeout: 1_800_000 }, async () => {
  const a = await agent("nvda", 91);
  const nvda = borroStock("NVDA");
  const def = venueByName("raeto_nvda");
  const vault = getAddress(await a.tokenVault(nvda.token).vaultAddress());
  assert.equal(await exists(vault), false);

  // Empty and not created: venue_set refuses it as before, the treasury's set_venue step is skipped, nothing is created.
  await assert.rejects(a.venues.setVenue("raeto_nvda", true), /has no NVDA vault yet/);
  await a.lp.fundCreatorVault("5");
  const reg = await a.lp.registerAgent("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
  assert.equal(reg.status, "sent");
  const skipped = await applyEnable(a, "raeto_nvda", 1);
  assert.equal(skipped.next, null, JSON.stringify(skipped));
  assert.deepEqual(skipped.done.map((x) => [x.kind, x.landed, x.skipped]), [["set_venue", true, "the NVDA vault was never created and holds no NVDA: nothing to enable Raeto's NVDA vault for"]]);
  assert.equal(await exists(vault), false);

  await fork.increaseTime(0);
  const bought = await a.swap.swap({ tokenIn: USDG, tokenOut: nvda.token, amount: "50" });
  assert.ok(bought.status === "sent" && bought.swapped, JSON.stringify(bought));
  assert.equal(await exists(vault), false);
  const held = await balanceOf(nvda.token, vault);
  assert.ok(held > 0n);

  // Read as a vault with no venue.
  assert.deepEqual(await a.venues.venueOf(def, vault), { enabled: false, entered: false, inForce: false, from: 0n });
  const st = await a.venues.state(def, vault);
  assert.equal(st.enabled, false);
  assert.equal(st.position, 0n);

  // The treasury with NVDA opted in plans for it.
  const plans = await a.strategy.plan({ stockVaults: ["NVDA"], aiBudget: 0n });
  const treasury = plans.find((p) => p.profile === "treasury" || p.treasury !== undefined);
  assert.ok(treasury?.treasury !== undefined, JSON.stringify(plans.map((p) => p.profile)));
  const row = treasury.treasury.stocks.find((s) => s.symbol === "NVDA");
  assert.ok(row !== undefined, `the treasury planned for the NVDA vault not created yet: ${JSON.stringify(treasury.treasury.stocks)}`);
  assert.doesNotMatch(row.note, /does not exist yet/);
  const enable = treasury.steps.find((s) => s.kind === "set_venue" && s.what === "raeto_nvda");
  if (enable !== undefined) assert.match(enable.reason, /never created/);
  assert.equal(await exists(vault), false, "planning signs nothing");

  // The treasury's set_venue step: the enable creates the vault first.
  const set = await applyEnable(a, "raeto_nvda", 2);
  assert.equal(set.next, null, JSON.stringify(set));
  assert.deepEqual(set.done.map((x) => [x.kind, x.landed, x.skipped]), [["set_venue", true, undefined]]);
  assert.equal(await exists(vault), true);
  assert.equal(await balanceOf(nvda.token, vault), held);
  const vf = await a.venues.venueOf(def, vault);
  assert.equal(vf.enabled, true);
  assert.equal(vf.inForce, true);
});
