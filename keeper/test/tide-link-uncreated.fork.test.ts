// Ostra Tide's link (core TideService.link) of a token vault that holds its token but was never created (MCP 0.1.22,
// decided by Edu on 10 Nov 2026), on a fork of Robinhood Chain mainnet: the live ERC-8004 Identity Registry and
// OstraRouter (ostra-swap's deployments/robinhood-mainnet.json), Ostra and its launchpad deployed fresh, the agent's
// own services as its MCP runs them, and the index's Tide API (indexer src/tide.ts) served on 127.0.0.1:
//   * the agent buys OSTRA through Ostra Swap into its OSTRA vault, which does not exist (the buy pays its address);
//     link creates that vault, then sends its member approval: the vault is in the set, it is the payee (inside the
//     list, so what it holds counts), and the index verifies the link on chain;
//   * its WETH vault, empty and never created, is not created and not linked;
//   * a second link sends nothing again.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createPublicClient, getAddress, http, keccak256, stringToHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, OSTRA, USDG, WETH, readVault, retryingHttp, robinhoodChain, tideSortVaults, usdgAbi, type Deployment } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
// Ostra Swap's SDK as core takes it (keeper does not depend on it): ostra-swap beside ostra-robinhood.
import { parseSwapDeployment, type SwapDeployment } from "../../../ostra-swap/sdk/src/index.ts";
import { Keys, LaunchpadService, LocalSender, SwapService, TideService, VaultService, X402_NETWORK, type Config } from "../../core/src/index.ts";
import { MemoryFolder } from "../../core/test/memory-folder.ts";
import { splitLogsClient } from "../../core/test/split-logs.ts";
import { createIndexerServer } from "../../indexer/src/http.ts";
import type { Indexer } from "../../indexer/src/indexer.ts";
import { TideApi, tideLinkVerifier, tidePayeeChecker } from "../../indexer/src/tide.ts";

const SWAP: SwapDeployment = parseSwapDeployment(JSON.parse(readFileSync(new URL("../../../ostra-swap/deployments/robinhood-mainnet.json", import.meta.url), "utf8")));

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
let forkBlock: bigint;
let indexerUrl: string;
let closeIndexer: () => Promise<void>;
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/KEEPER/TIDE-LINK-UNCREATED-FORK/fee-payer")));
const balanceOf = (token: Address, who: Address) => fork.client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const exists = async (vault: Address) => (await readVault(fork.client as PublicClient, d, vault)) !== null;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-keeper-tide-link-uncreated-"));
  fork = await startFork();
  forkBlock = await fork.client.getBlockNumber({ cacheTime: 0 });
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
  const tideApi = new TideApi({
    linksPath: join(root, "tide-links.json"),
    resultsDir: join(root, "results"),
    verify: tideLinkVerifier(fork.client as PublicClient, d.chainId, d.vaultBeacon),
    factory: d,
    payee: tidePayeeChecker(fork.client as PublicClient),
  });
  await tideApi.load();
  const server = createIndexerServer({} as Indexer, () => {}, null, tideApi);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  indexerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeIndexer = () => new Promise((r) => server.close(() => r()));
});

after(async () => {
  await closeIndexer?.();
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("link creates a token vault that holds its token, links it and names it the payee; an empty one is left alone", { timeout: 1_800_000 }, async () => {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const keys = new Keys({ master: new Uint8Array(32).fill(51), feePayer, store: new FileWotsStore(join(root, "agent")), folder: new MemoryFolder(), backupExported: async () => true });
  const creatorKeys = await keys.forCreatorVault(d.chainId, USDG);
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, sender, "creator");
  const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: sender, creator, creatorSender: sender });
  const tokenVault = (token: Address) => lp.tokenVault(token);
  const quoteClient = createPublicClient({ chain: robinhoodChain, transport: http(fork.url, { timeout: 300_000 }) }) as PublicClient;
  const swap = new SwapService({ client: quoteClient, logsClient: splitLogsClient(fork.url, forkBlock), config, swap: SWAP, vaultFor: tokenVault, sender, folder: keys.folder.folder("ostra-swap") });

  const opened = await buyer.open();
  const buyerVault = getAddress(opened.vault);
  await fork.dealUsdg(buyerVault, 100_000_000n);
  await lp.fundCreatorVault("5");
  const reg = await lp.registerAgent("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
  assert.equal(reg.status, "sent");
  const agentId = BigInt(reg.agentId as string);
  const creatorVault = getAddress(await creator.vaultAddress());
  const tide = new TideService({
    client,
    config,
    keys,
    identity: async () => ({ agentId, vault: creatorVault }),
    identityVault: creator,
    vaults: async () => [buyer, tokenVault(WETH), tokenVault(OSTRA)],
    payer: () => sender.payer(),
    indexerUrl,
    folder: keys.folder.folder("tide"),
    gap: () => 0,
    sleep: async () => {},
  });

  // OSTRA bought into the OSTRA vault, which does not exist.
  const ostraVault = getAddress(await tokenVault(OSTRA).vaultAddress());
  const wethVault = getAddress(await tokenVault(WETH).vaultAddress());
  await fork.increaseTime(0);
  const bought = await swap.swap({ tokenIn: USDG, tokenOut: OSTRA, amount: "5" });
  assert.ok(bought.status === "sent" && bought.swapped, JSON.stringify(bought));
  const held = await balanceOf(OSTRA, ostraVault);
  assert.ok(held > 0n);
  assert.equal(await exists(ostraVault), false);
  assert.equal(await exists(wethVault), false);

  const linked = await tide.link();
  assert.equal(linked.linked, true, JSON.stringify(linked));
  assert.equal(linked.verifiedByIndex, true, JSON.stringify(linked));
  assert.equal(await exists(ostraVault), true, "link created the OSTRA vault that holds OSTRA");
  assert.equal(await balanceOf(OSTRA, ostraVault), held);
  assert.deepEqual(linked.vaults, tideSortVaults([creatorVault, buyerVault, ostraVault]));
  assert.equal(linked.payee, ostraVault);
  assert.equal(linked.payeeCreation, undefined, "the payee is in the list, not named by its creation params");
  assert.ok((linked.approvals as { status: string }[]).every((s) => s.status === "sent"), JSON.stringify(linked.approvals));
  assert.equal(await exists(wethVault), false, "an empty vault is never created");

  const again = await tide.link();
  assert.ok((again.approvals as { status: string }[]).every((s) => s.status === "approved before"), JSON.stringify(again.approvals));
  assert.deepEqual(again.vaults, linked.vaults);
});
