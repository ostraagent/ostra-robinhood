// Ostra Tide's score (src/tide-score.ts readTideWeek) end to end on a fork of Robinhood Chain mainnet: the live
// ERC-8004 Identity Registry, OstraRouter (ostra-swap's deployments/robinhood-mainnet.json), Uniswap's pools,
// Chainlink's feeds and OstraTide (its week 1 pot), with Ostra and its launchpad deployed fresh (version 3 vaults), an
// agent's own services as its MCP runs them (core's VaultService, SwapService, TideService), and the index's Tide API
// (indexer src/tide.ts) served on 127.0.0.1:
//   * agent A registers its creator vault in ERC-8004, then in the week swaps USDG for WETH from its buyer vault
//     (Ostra Swap, the WETH vault paid) and buys Raeto credits (USDG to Raeto's payTo); it links its vaults with
//     TideService.link (the link kept by the index first, each member vault's approval, then the identity vault's set
//     approval), and a second call sends nothing again;
//   * the index checks the link on chain when A posts it again after its approvals (verified): nine links someone else
//     posts for A afterwards do not push it out;
//   * agent B is one of Ostra's own (OSTRA_STATS_OWN): left out; agent C has a link the index keeps that nobody
//     approved on chain: unproven, only its identity vault counted, no points, and its poster is told only what it
//     lacks; C's vault registers a second identity, which is left out (it would count the same vault again);
//   * the state is read at the last block before the link deadline (the week's end + 23 hours);
//   * after the week: A's figures, read from the chain here apart from the score (the Swapped event's fee, the USDG
//     sent to payTo, each vault's USDG and WETH at the week's last block at Chainlink ETH/USD), match its breakdown;
//     A is the only one with points, so it gets the 20% cap of the pot and the rest stays; the tree's one leaf pays A's
//     OSTRA vault and verifies against the root;
//   * the index answers A its figures with the view key, and nobody else's.
// The week is the fork's own (readTideWeek's testStart): its blocks come after OstraTide's week 1 started.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createPublicClient, decodeEventLog, getAddress, http, keccak256, parseAbi, sha256, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHAINLINK_ETH_USD,
  FileWotsStore,
  OSTRA,
  OSTRA_TIDE,
  TIDE_RULES,
  TIDE_WEEK,
  USDG,
  VAULT_ACTION,
  WETH,
  chainlinkAggregatorAbi,
  ostraVaultAbi,
  padCidFromDigest,
  registerAgentParams,
  retryingHttp,
  robinhoodChain,
  signVaultSpend,
  simulateVaultSpend,
  tideLeaf,
  tideSortVaults,
  tideVerify,
  tideViewKey,
  transferParams,
  usdgAbi,
  type Deployment,
} from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
// Ostra Swap's SDK as core takes it (keeper does not depend on it): ostra-swap beside ostra-robinhood.
import { ostraRouterAbi, parseSwapDeployment, type SwapDeployment } from "../../../ostra-swap/sdk/src/index.ts";
import { Keys, LocalSender, SwapService, TideService, VaultService, X402_NETWORK, spendCall, type Config } from "../../core/src/index.ts";
import { MemoryFolder } from "../../core/test/memory-folder.ts";
import { splitLogsClient } from "../../core/test/split-logs.ts";
import { createIndexerServer } from "../../indexer/src/http.ts";
import type { Indexer } from "../../indexer/src/indexer.ts";
import { TideApi, tideLinkVerifier } from "../../indexer/src/tide.ts";
import { RAETO_PAY_TO, readTideWeek, type TideLinkRecord } from "../src/tide-score.ts";

const SWAP: SwapDeployment = parseSwapDeployment(JSON.parse(readFileSync(new URL("../../../ostra-swap/deployments/robinhood-mainnet.json", import.meta.url), "utf8")));
const tideAbi = parseAbi(["function potBalance(uint256 week) view returns (uint256)"]);

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
let forkBlock: bigint;
let tideApi: TideApi;
let indexerUrl: string;
let closeIndexer: () => Promise<void>;
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/KEEPER/TIDE-SCORE-FORK/fee-payer")));
const balanceOf = (token: Address, who: Address, blockNumber?: bigint) =>
  fork.client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [who], ...(blockNumber === undefined ? {} : { blockNumber }) }) as Promise<bigint>;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-keeper-tide-"));
  fork = await startFork();
  forkBlock = await fork.client.getBlockNumber({ cacheTime: 0 });
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
  // The index's Tide API, its clock the fork's.
  tideApi = new TideApi({ linksPath: join(root, "tide-links.json"), resultsDir: join(root, "results"), verify: tideLinkVerifier(fork.client as PublicClient, d.chainId, d.vaultBeacon) });
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

/** One spend of `vault`, simulated first for its gas. */
async function spend(vault: VaultService, sender: LocalSender, action: number, params: Hex): Promise<Hex> {
  const at = await vault.vaultAddress();
  const sim = await simulateVaultSpend(fork.client as PublicClient, d, { relayer: await sender.payer(), vault: at, action, params });
  const r = await vault.operate({ gas: (sim.gasUsed * 5n) / 4n + 100_000n, what: "spend", build: async ({ v, vault: a, keychain, chainId }) => [spendCall(a, await signVaultSpend(keychain, v, { chainId, action: action as never, params }))] });
  assert.equal(r.status, "sent", JSON.stringify(r));
  return (r as { txHash: Hex }).txHash;
}

/** An agent: its vaults (buyer, creator, token vaults), Ostra Swap, Ostra Tide, and its ERC-8004 registration. */
async function agent(name: string, seed: number) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder: new MemoryFolder(), backupExported: async () => true });
  const creatorKeys = await keys.forCreatorVault(d.chainId, USDG);
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, sender, "creator");
  const tokenVaults = new Map<Address, VaultService>();
  const tokenVault = (token: Address) => {
    const t = getAddress(token);
    if (t === getAddress(USDG)) return buyer;
    let v = tokenVaults.get(t);
    if (v === undefined) {
      v = new VaultService(client, transport, config, keys, sender, "token", null, t);
      tokenVaults.set(t, v);
    }
    return v;
  };
  // Quotes read many pools in one call, which a fork fetches slot by slot from upstream the first time.
  const quoteClient = createPublicClient({ chain: robinhoodChain, transport: http(fork.url, { timeout: 180_000 }) }) as PublicClient;
  const swap = new SwapService({ client: quoteClient, logsClient: splitLogsClient(fork.url, forkBlock), config, swap: SWAP, vaultFor: tokenVault, sender, folder: keys.folder.folder("ostra-swap") });
  await creator.open();
  const creatorVault = getAddress(await creator.vaultAddress());
  let agentId: bigint | null = null;
  const register = async () => {
    const tx = await spend(creator, sender, VAULT_ACTION.REGISTER_AGENT, registerAgentParams(padCidFromDigest(sha256(stringToHex(`{"name":"${name}"}`)))));
    for (const log of (await client.getTransactionReceipt({ hash: tx })).logs) {
      if (getAddress(log.address) !== creatorVault) continue;
      try {
        const e = decodeEventLog({ abi: ostraVaultAbi, data: log.data, topics: log.topics });
        if (e.eventName === "AgentRegistered") agentId = (e.args as { agentId: bigint }).agentId;
      } catch {
        // another event
      }
    }
    assert.ok(agentId !== null, `${name} registered without an AgentRegistered event`);
    return agentId;
  };
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
  return { keys, sender, buyer, creator, creatorVault, tokenVault, swap, tide, register, agentId: () => agentId as bigint };
}

test("a week of Ostra Tide: the link checked on chain, the points by source, the shares, the tree, and each agent's own view", { timeout: 1_800_000 }, async () => {
  const a = await agent("A", 41);
  const b = await agent("B", 42);
  const c = await agent("C", 43);
  const idA = await a.register();
  await b.register();
  const idC = await c.register();
  const idC2 = await c.register();
  assert.notEqual(idC2, idC);

  // A's vaults: the buyer vault with 100 USDG, its WETH vault and OSTRA vault (where its share is paid).
  await a.buyer.open();
  const buyerA = getAddress(await a.buyer.vaultAddress());
  await fork.dealUsdg(buyerA, 100_000_000n);
  await a.tokenVault(WETH).open();
  await a.tokenVault(OSTRA).open();
  const wethA = getAddress(await a.tokenVault(WETH).vaultAddress());
  const ostraA = getAddress(await a.tokenVault(OSTRA).vaultAddress());
  // 5 USDG in the identity vault, counted too.
  await fork.dealUsdg(a.creatorVault, 5_000_000n);

  // The week starts after the registrations (none of them before OstraTide's week 1: not early).
  await fork.increaseTime(5);
  const start = Number((await fork.client.getBlock({ blockTag: "latest" })).timestamp) + 1;
  await fork.increaseTime(5);

  // In the week: a swap of 20 USDG to WETH (the WETH vault paid, so the fee counts for A) and 1 USDG of Raeto credits.
  const swapped = await a.swap.swap({ tokenIn: USDG, tokenOut: WETH, amount: "20" });
  assert.ok(swapped.status === "sent" && swapped.swapped, JSON.stringify(swapped));
  let fee: { fee: bigint; hub: Address; block: bigint } | null = null;
  const receipt = await fork.client.getTransactionReceipt({ hash: swapped.txHash });
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(SWAP.router)) continue;
    try {
      const e = decodeEventLog({ abi: ostraRouterAbi, data: log.data, topics: log.topics });
      if (e.eventName !== "Swapped") continue;
      const x = e.args as { fee: bigint; hub: Address; recipient: Address };
      assert.equal(getAddress(x.recipient), wethA);
      fee = { fee: x.fee, hub: getAddress(x.hub), block: receipt.blockNumber };
    } catch {
      // another event
    }
  }
  assert.ok(fee !== null && fee.fee > 0n, "the swap paid no fee");
  let feeE6 = fee.fee;
  if (fee.hub === getAddress(WETH)) {
    const r = (await fork.client.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAggregatorAbi, functionName: "latestRoundData", blockNumber: fee.block })) as readonly [bigint, bigint, bigint, bigint, bigint];
    feeE6 = (fee.fee * r[1]) / 10n ** 20n;
  } else assert.equal(fee.hub, getAddress(USDG));
  await spend(a.buyer, a.sender, VAULT_ACTION.TRANSFER, transferParams({ to: RAETO_PAY_TO, amount: 1_000_000n }));

  // A links its vaults; a second call sends nothing again.
  const linked = await a.tide.link();
  assert.equal(linked.linked, true, JSON.stringify(linked));
  assert.equal(linked.verifiedByIndex, true, JSON.stringify(linked));
  assert.equal(linked.payee, ostraA);
  assert.deepEqual(linked.vaults, tideSortVaults([a.creatorVault, buyerA, wethA, ostraA]));
  assert.ok((linked.approvals as { status: string }[]).every((s) => s.status === "sent"), JSON.stringify(linked.approvals));
  const again = await a.tide.link();
  assert.ok((again.approvals as { status: string }[]).every((s) => s.status === "approved before"), JSON.stringify(again.approvals));
  // C's link names A's buyer vault: kept by the index, approved by nobody.
  const cLink = await fetch(`${indexerUrl}/api/v1/tide/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: idC.toString(), secret: keccak256(stringToHex("OSTRA/KEEPER/TIDE-SCORE-FORK/c-secret")), vaults: [c.creatorVault, buyerA], payee: null }),
  });
  assert.equal(cLink.status, 200);
  // A new link of A's own being made (posted before its approvals, unverified) does not replace the verified one.
  const partial = await fetch(`${indexerUrl}/api/v1/tide/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: idA.toString(), secret: a.keys.tideSecret(d.chainId, OSTRA_TIDE), vaults: [a.creatorVault, buyerA], payee: null }),
  });
  assert.equal(((await partial.json()) as { verified: boolean }).verified, false);
  const both = (JSON.parse(await readFile(join(root, "tide-links.json"), "utf8")) as (TideLinkRecord & { verified?: boolean })[]).filter((x) => x.agentId === idA.toString());
  assert.deepEqual(both.map((x) => x.verified === true), [true, false]);
  // Nine links someone else posts for A: A's verified link stays.
  for (let i = 0; i < 9; i++) {
    const junk = await fetch(`${indexerUrl}/api/v1/tide/link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: idA.toString(), secret: keccak256(stringToHex(`OSTRA/KEEPER/TIDE-SCORE-FORK/junk-${i}`)), vaults: [buyerA], payee: null }),
    });
    assert.equal(junk.status, 200);
    assert.equal(((await junk.json()) as { verified: boolean }).verified, false);
  }
  const keptA = (JSON.parse(await readFile(join(root, "tide-links.json"), "utf8")) as TideLinkRecord[]).filter((x) => x.agentId === idA.toString());
  assert.equal(keptA.length, 9, "the verified link and the 8 latest unverified ones (A's own partial one dropped first)");
  assert.equal(keptA.filter((x) => (x as { verified?: boolean }).verified === true).length, 1);
  // A's view before the score: the link is kept, no points yet.
  assert.equal((await a.tide.points()).note, "the link is kept; the points appear after the next score (every 30 minutes)");

  // The week's last block: everything A held then, read here.
  const last = await fork.client.getBlockNumber({ cacheTime: 0 });
  const eth = (await fork.client.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAggregatorAbi, functionName: "latestRoundData", blockNumber: last })) as readonly [bigint, bigint, bigint, bigint, bigint];
  const idleE6 = (await balanceOf(USDG, buyerA, last)) + (await balanceOf(USDG, a.creatorVault, last)) + ((await balanceOf(WETH, wethA, last)) * eth[1]) / 10n ** 20n;
  assert.ok(idleE6 > 80_000_000n);

  const deadline = start + TIDE_WEEK + 23 * 3_600;
  await fork.increaseTime(TIDE_WEEK + 23 * 3_600 + 60);
  const links = JSON.parse(await readFile(join(root, "tide-links.json"), "utf8")) as TideLinkRecord[];
  // Its multicalls read many feeds and oracles, which the fork fetches slot by slot from upstream the first time.
  const r = await readTideWeek({
    client: createPublicClient({ chain: robinhoodChain, transport: http(fork.url, { timeout: 180_000 }) }) as PublicClient,
    logsClient: splitLogsClient(fork.url, forkBlock),
    factory: d.vaultFactory,
    router: getAddress(SWAP.router),
    fromBlock: BigInt(d.fromBlock),
    week: 1,
    links,
    own: new Set([b.creatorVault]),
    linkDeadline: deadline,
    chainId: d.chainId,
    testStart: start,
  });
  assert.equal(r.final, true);
  assert.deepEqual(r.excluded, [
    { agentId: b.agentId().toString(), vault: b.creatorVault, reason: "Ostra's own" },
    { agentId: idC2.toString(), vault: c.creatorVault, reason: `another identity of a vault that takes part as agent ${idC}` },
  ]);
  // The state block: the last before the deadline (the chain moved past it in one block).
  assert.equal(r.stateBlock, last.toString());
  assert.deepEqual(r.agents.map((x) => x.agentId), [idA.toString(), idC.toString()]);

  const ra = r.agents[0]!;
  assert.equal(ra.identityVault, a.creatorVault);
  assert.equal(ra.link.status, "verified", JSON.stringify(ra.link));
  assert.deepEqual(ra.vaults, tideSortVaults([a.creatorVault, buyerA, wethA, ostraA]));
  assert.equal(ra.payee, ostraA);
  assert.deepEqual(ra.dropped, []);
  const bd = ra.breakdown;
  assert.equal(bd.fee.paidE6, feeE6.toString());
  assert.equal(bd.fee.countedE6, feeE6.toString(), "one way only: nothing netted out");
  assert.equal(bd.fee.points, ((feeE6 < TIDE_RULES.feeCapE6 ? feeE6 : TIDE_RULES.feeCapE6) * TIDE_RULES.feePointsPerUsd).toString());
  assert.equal(bd.raeto.paidE6, "1000000");
  assert.equal(bd.raeto.points, (1_000_000n * TIDE_RULES.raetoPointsPerUsd).toString());
  assert.equal(bd.balances.idleAvgE6, idleE6.toString(), "every day ended at the same block: the average is that day's");
  assert.equal(bd.balances.cashAvgE6, "0");
  assert.equal(bd.balances.borroAvgE6, "0");
  assert.equal(bd.balances.points, (idleE6 * TIDE_RULES.idlePointsPerUsd).toString());
  assert.equal(bd.basePoints, (BigInt(bd.fee.points) + BigInt(bd.raeto.points) + BigInt(bd.balances.points)).toString());
  assert.equal(bd.early, false);
  assert.equal(bd.activeDays.length, 1);
  assert.equal(bd.multiplierBps, "10000");
  assert.equal(bd.points, bd.basePoints);

  const rc = r.agents[1]!;
  assert.equal(rc.link.status, "unproven");
  assert.ok(rc.link.status === "unproven" && rc.link.missing.length === 1 && rc.link.missing[0]!.includes("set digest"), JSON.stringify(rc.link));
  assert.equal(rc.viewKey, null);
  assert.equal(ra.viewKey, tideViewKey(a.keys.tideSecret(d.chainId, OSTRA_TIDE)));
  assert.equal(ra.pending.length, 8, "the 8 others kept for A, each lacking the set approval");
  assert.deepEqual(rc.vaults, [c.creatorVault]);
  assert.equal(rc.breakdown.points, "0");
  assert.equal(rc.share, "0");

  // Shares: A alone has points, so it gets the cap (20% of the pot); the rest stays in the pot.
  const pot = (await fork.client.readContract({ address: OSTRA_TIDE, abi: tideAbi, functionName: "potBalance", args: [1n] })) as bigint;
  assert.equal(r.pot, pot.toString());
  assert.ok(pot > 0n);
  assert.equal(ra.share, ((pot * TIDE_RULES.shareCapBps) / 10_000n).toString());
  assert.equal(r.shared, ra.share);
  assert.ok(r.tree !== null);
  assert.equal(r.tree.leaves.length, 1);
  const leaf = r.tree.leaves[0]!;
  assert.deepEqual({ agentId: leaf.agentId, payee: leaf.payee, amount: leaf.amount }, { agentId: idA.toString(), payee: ostraA, amount: ra.share });
  assert.equal(tideVerify(r.tree.root, tideLeaf({ week: 1, agentId: idA.toString(), payee: ostraA, amount: BigInt(ra.share) }), leaf.proof), true);
  assert.equal(r.tree.total, ra.share);

  // The index answers A its own figures with its view key, and nobody's to a wrong key.
  await mkdir(join(root, "results"), { recursive: true });
  await writeFile(join(root, "results", "week-1.json"), JSON.stringify(r));
  const mine = await a.tide.points();
  assert.equal((mine.agent as { agentId: string }).agentId, idA.toString());
  assert.equal(((mine.agent as { breakdown: { points: string } }).breakdown).points, bd.points);
  assert.equal(JSON.stringify(mine).includes(idC.toString()), false);
  // A junk link's key gets only what it lacks; C's poster too.
  const junkView = await fetch(`${indexerUrl}/api/v1/tide/points`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: idA.toString(), viewKey: tideViewKey(keccak256(stringToHex("OSTRA/KEEPER/TIDE-SCORE-FORK/junk-8"))) }) });
  assert.equal(junkView.status, 202);
  const junkBody = (await junkView.json()) as { error: string; missing: string[] };
  assert.equal(junkBody.error, "not_verified");
  assert.equal(JSON.stringify(junkBody).includes(wethA), false, "nothing of A's link");
  const cView = await fetch(`${indexerUrl}/api/v1/tide/points`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: idC.toString(), viewKey: tideViewKey(keccak256(stringToHex("OSTRA/KEEPER/TIDE-SCORE-FORK/c-secret"))) }) });
  assert.equal(cView.status, 202);
  const wrong = await fetch(`${indexerUrl}/api/v1/tide/points`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: idA.toString(), viewKey: tideViewKey(keccak256(stringToHex("not A's"))) }) });
  assert.equal(wrong.status, 404);
  const dash = await a.tide.dashboard();
  assert.ok(dash.url.startsWith(`https://app.ostraagent.xyz/tide#agent=${idA.toString()}&key=0x`), dash.url);
});
