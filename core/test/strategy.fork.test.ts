// The strategy planner (StrategyService) through the core services, on a fork of Robinhood Chain mainnet with Ostra
// and its launchpad deployed fresh (version 3 vaults), against the live Steakhouse USDG, Borro, Morpho Blue and the
// ERC-8004 Identity Registry, with the agent's own fee payer sending (LocalSender):
//   * the ERC-8004 gate: an agent whose creator vault holds no identity is refused; after register_agent it plans,
//     found from agent.json and from the Registered events alike; another agent cannot claim that identity;
//   * without USDe's price (no Ethereum RPC) nothing goes into Steakhouse USDG, whose caps reach a USDe market, and it
//     has no other problem (the cash path with USDe's price is strategy-pinned.fork.test.ts, at a block before the
//     curator's 23 Oct submission);
//   * last (it moves the fork's clock 36 days on): mGLO's NAV older than 35 days holds new deposits only: a vault
//     holding Steakhouse USDG shares is not taken out by the sweep's exit check nor by check(), which says why.
// The vaults list comes from the fresh factory's VaultCreated events on the fork.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getAddress, keccak256, parseAbi, stringToHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, STEAKHOUSE_USDG, USDG, retryingHttp, type Deployment } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import {
  BorroService,
  Keys,
  LAUNCHPAD_DIR,
  LaunchpadService,
  LocalSender,
  StrategyGateError,
  StrategyService,
  VaultService,
  X402_NETWORK,
  type Config,
} from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";
import { splitLogsClient } from "./split-logs.ts";

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
let forkBlock: bigint;
/** Robinhood Chain's gas price: the fork block's base fee (anvil's eth_gasPrice adds a 1 gwei tip the chain does not charge). */
const chainGasPrice = async () => (await fork.client.getBlock({ blockNumber: forkBlock })).baseFeePerGas as bigint;

const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/STRATEGY-FORK/fee-payer")));
const vaultV2BalanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** An agent: its own seed and records, its USDG, token and creator vaults, Borro, the launchpad and the planner. */
async function agent(name: string, seed: number, ethClient: PublicClient | null, agentId?: () => Promise<string | null>) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const folder = new MemoryFolder();
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder, backupExported: async () => true });
  const creatorKeys = await keys.forCreatorVault(d.chainId, USDG);
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, sender, "creator");
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
  const borro = new BorroService({ client, config, buyer, tokenVault, sender, ownVaults, gasPrice: chainGasPrice });
  const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: sender, creator, creatorSender: sender });
  const recorded = async () => {
    const t = await keys.folder.folder(LAUNCHPAD_DIR).read("agent.json");
    return t === undefined ? null : (JSON.parse(t) as { agentId: string }).agentId;
  };
  const planner = (id: () => Promise<string | null>, e: PublicClient | null) =>
    new StrategyService({ client, logsClient: splitLogsClient(fork.url, forkBlock), config, buyer, tokenVault, creator, borro, folder: keys.folder.folder("strategy"), agentId: id, ethClient: e });
  return { keys, buyer, creator, tokenVault, borro, lp, recorded, strategy: planner(agentId ?? recorded, ethClient), planner };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-strategy-"));
  fork = await startFork();
  forkBlock = await fork.client.getBlockNumber({ cacheTime: 0 });
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});


let registered: Awaited<ReturnType<typeof agent>>;

test("the ERC-8004 gate: refused without an identity; after register_agent, found from agent.json and from the Registered events; not claimable by another agent", { timeout: 900_000 }, async () => {
  const a = await agent("registered", 71, null);
  const buyer = (await a.buyer.open()).vault;
  await fork.dealUsdg(buyer, 2_000_000_000n);
  await assert.rejects(a.strategy.plan(), (e: unknown) => e instanceof StrategyGateError && /register_agent/.test((e as Error).message));
  await a.lp.fundCreatorVault("5");
  const r = await a.lp.registerAgent("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
  assert.equal(r.status, "sent");
  assert.ok(r.agentId !== undefined);
  const creatorVault = getAddress(await a.creator.vaultAddress());
  assert.deepEqual(await a.strategy.gate(), { agentId: r.agentId, creatorVault });
  // Without agent.json: the Registered events of the creator vault.
  assert.deepEqual(await a.planner(async () => null, null).gate(), { agentId: r.agentId, creatorVault });
  // Another agent, claiming that identity, and with none.
  const b = await agent("other", 72, null, async () => r.agentId as string);
  await assert.rejects(b.strategy.gate(), (e: unknown) => e instanceof StrategyGateError && new RegExp(`agent ${r.agentId} is not`).test((e as Error).message));
  await assert.rejects(b.planner(async () => null, null).gate(), (e: unknown) => e instanceof StrategyGateError && /it has none/.test((e as Error).message));
  // The vaults list holds the agent's USDG and creator vaults, from the fresh factory's events.
  const listed = await a.strategy.ostraVaults(USDG);
  assert.ok(listed.includes(getAddress(buyer)) && listed.includes(creatorVault), JSON.stringify(listed));
  registered = a;
});

test("without USDe's price nothing goes into Steakhouse USDG, whose caps reach a USDe market", { timeout: 900_000 }, async () => {
  const a = registered;
  const plans = await a.strategy.plan({ buffer: 100_000_000n });
  assert.equal(plans.length, 1);
  const p = plans[0]!;
  assert.equal(p.profile, "conservative");
  assert.deepEqual(p.steps, []);
  assert.ok(p.risks.some((x) => x.includes(STEAKHOUSE_USDG) && /USDe's price is not known: no Ethereum RPC is set/.test(x)), p.risks.join("\n"));
  const c = (await a.strategy.cashVaults()).find((x) => x.vault === STEAKHOUSE_USDG)!;
  assert.equal(c.usdeExposed, true);
  assert.match(c.usdeProblem ?? "", /no Ethereum RPC is set/);
  assert.equal(c.ok, false);
  // No other problem: the new mGLO market its curator submitted on 23 Oct 2026 is accepted since 25 Oct (within the mGLO
  // limits, which hold while its NAV is fresh); the old setIsSentinel submission can never be executed.
  assert.deepEqual(c.problems, []);
  for (const x of c.collateralHolds) assert.match(x, /mGLO's NAV was last published/, x);
  assert.ok(c.pendingIgnored.some((x) => x.startsWith("0x920ed706")), JSON.stringify(c.pendingIgnored));
});

// Last: it moves the fork's clock 36 days on.
test("a stale mGLO NAV holds new deposits only: shares held are not taken out by the exit check nor by check()", { timeout: 900_000 }, async () => {
  const a = registered;
  const vault = getAddress(await a.buyer.vaultAddress());
  assert.equal((await a.borro.lendCash(STEAKHOUSE_USDG, 500_000_000n)).status, "sent");
  const shares = (await fork.client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2BalanceAbi, functionName: "balanceOf", args: [vault] })) as bigint;
  assert.ok(shares > 0n);
  // 36 days on, with no new NAV published on the fork.
  await fork.increaseTime(36 * 86_400);
  const c = (await a.strategy.cashVaults()).find((x) => x.vault === STEAKHOUSE_USDG)!;
  assert.ok(c.collateralHolds.some((x) => /mGLO's NAV was last published/.test(x)), JSON.stringify(c.collateralHolds));
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.exitReasons, []);
  assert.deepEqual(await a.strategy.exitCheck(), { held: 1, left: [] });
  const r = await a.strategy.check({ execute: true });
  assert.ok(!r.actions.some((x) => x.kind === "redeem_cash"), JSON.stringify(r.actions));
  assert.ok(r.findings.some((f) => f.startsWith(`${STEAKHOUSE_USDG}: held `) && /kept \(no exit reason\); new deposits wait: .*mGLO's NAV was last published/.test(f)), r.findings.join("\n"));
  assert.equal((await fork.client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2BalanceAbi, functionName: "balanceOf", args: [vault] })) as bigint, shares);
});
