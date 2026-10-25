// OstraBreaker for the agent's USDG vault (breaker.ts) and Ostra's breaker keeper (keeper/src/breaker.ts), on a fork of
// Robinhood Chain mainnet with Ostra (version 3 vaults) and OstraBreaker deployed fresh, against the live Steakhouse
// USDG, its liquidity market on Morpho Blue and USDe, with the agent's own fee payer sending (LocalSender):
//   * arming runs in the vault's order (guardian, the vault's approval of its limits, the limits sent) and a second arm
//     finds it all done; under the lock it is refused;
//   * the keeper reads the pair from the breaker's events, leaves a healthy vault alone, and trips it once a real
//     borrower takes the liquidity market past 99% use: the vault's shares come back to it as USDG;
//   * a vault without the lock (not armed): the MCP sweep's exit check leaves the cash vault itself, the market past
//     99% use, and does nothing for a vault holding no shares;
//   * arming stopped after the vault's approval (the limits' send failed) is finished by the next arm with the limits
//     approved then, approving nothing new; the keeper, with the real keeper Sender, leaves that vault (armed, its lock
//     off) alone as not armed, reads its lock each tick, and trips it as soon as the lock is on;
//   * arming stopped by the approval's send failing (the vault keeps the signed approval) is finished by the next arm
//     with the limits kept: the vault sends that approval first, and nothing else is approved.
// Each test sets the market's use it needs itself (borrowTo), so each runs on its own.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { decodeAbiParameters, getAddress, keccak256, parseAbi, stringToHex, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_BREAKER_LIMITS, FileWotsStore, MORPHO_BLUE, STEAKHOUSE_USDG, USDG, VAULT_ACTION, deployBreaker, ostraBreakerAbi, retryingHttp, type Deployment, type RelayCall } from "@ostraagent/sdk";
import { OUT_DIR, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { BorroService, BreakerService, Keys, LocalSender, StrategyService, VaultService, X402_NETWORK, type Config, type SendOptions } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";
import { splitLogsClient } from "./split-logs.ts";

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
let forkBlock: bigint;
const chainGasPrice = async () => (await fork.client.getBlock({ blockNumber: forkBlock })).baseFeePerGas as bigint;
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/BREAKER-FORK/fee-payer")));
const keeperAccount = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/BREAKER-FORK/keeper")));
const withdrawal = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/BREAKER-FORK/withdrawal"))).address;

const vaultV2Abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function liquidityData() view returns (bytes)", "function totalAssets() view returns (uint256)"]);
const morphoAbi = parseAbi([
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function supplyCollateral((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, address onBehalf, bytes data)",
  "function borrow((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
]);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
const erc20Abi = parseAbi(["function approve(address, uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const marketTuple = [{ type: "tuple", components: [{ name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" }, { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" }] }] as const;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-breaker-"));
  fork = await startFork();
  forkBlock = await fork.client.getBlockNumber({ cacheTime: 0 });
  const base = await deployOnFork(fork);
  d = await deployBreaker({ publicClient: fork.client, walletClient: fork.wallet(fork.accounts[0]!), outDir: OUT_DIR }, base);
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
  await fork.setBalance(keeperAccount.address, 10n ** 18n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** The agent's fee payer sending; after `pass` more sends, the next `failures` fail before anything is sent (an RPC gone, say). */
class FailingSender extends LocalSender {
  pass = 0;
  failures: number;
  constructor(client: PublicClient, failures: number) {
    super(client, retryingHttp(fork.url), feePayer);
    this.failures = failures;
  }
  failAfter(pass: number, failures = 1): void {
    this.pass = pass;
    this.failures = failures;
  }
  override async send(calls: RelayCall[], options: SendOptions = {}): Promise<Hash> {
    if (this.pass > 0) this.pass -= 1;
    else if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("the RPC could not be reached");
    }
    return super.send(calls, options);
  }
}

type BreakerKeeperLike = { refreshPairs(): Promise<void>; tick(): Promise<{ pair: { vault: Address; target: Address }; reasons: number; tx?: Hash; error?: string }[]>; pairs: readonly { vault: Address; target: Address }[] };

/** Ostra's breaker keeper (keeper/src/breaker.ts) sending its trips with the keeper's own Sender (keeper/src/chain.ts), as breaker-main.ts does. */
async function keeperOf(dir: string, events: { event: string; fields: Record<string, unknown> }[]): Promise<BreakerKeeperLike> {
  const { BreakerKeeper } = (await import(new URL("../../keeper/src/breaker.ts", import.meta.url).href)) as { BreakerKeeper: { open(p: unknown): Promise<BreakerKeeperLike> } };
  const { Sender } = (await import(new URL("../../keeper/src/chain.ts", import.meta.url).href)) as {
    Sender: new (c: PublicClient, t: ReturnType<typeof retryingHttp>, a: typeof keeperAccount, l: (e: string, f: Record<string, unknown>) => void) => { fromFeePayer(call: unknown): Promise<{ hash: Hash; gasUsed: bigint }> };
  };
  const log = (event: string, fields: Record<string, unknown>) => events.push({ event, fields });
  const sender = new Sender(fork.client as PublicClient, retryingHttp(fork.url), keeperAccount, log);
  const breaker = getAddress(d.breaker as Address);
  return BreakerKeeper.open({
    client: fork.client,
    logsClient: fork.client,
    breaker,
    fromBlock: forkBlock,
    feePayer: keeperAccount.address,
    trip: (p: { vault: Address; target: Address }) => sender.fromFeePayer({ address: breaker, abi: ostraBreakerAbi, functionName: "trip", args: [p.vault, p.target] }),
    dataDir: join(root, dir),
    log,
  });
}

function agent(name: string, seed: number, breakerSender?: LocalSender, mainSender?: LocalSender) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder: new MemoryFolder(), backupExported: async () => true });
  const sender = mainSender ?? new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const tokenVault = (token: Address) => new VaultService(client, transport, config, keys, sender, "token", null, token);
  const borro = new BorroService({ client, config, buyer, tokenVault, sender, ownVaults: async () => [await buyer.vaultAddress()], gasPrice: chainGasPrice });
  const breaker = new BreakerService({ client, config, buyer, borro, sender: breakerSender ?? sender, folder: keys.folder.folder("breaker") });
  const creator = new VaultService(client, transport, config, keys, sender, "creator");
  const strategy = new StrategyService({ client, logsClient: splitLogsClient(fork.url, forkBlock), config, buyer, tokenVault, creator, borro, folder: keys.folder.folder("strategy"), agentId: async () => null, ethClient: null, breaker });
  return { buyer, borro, breaker, strategy, folder: keys.folder.folder("breaker") };
}

/**
 * A real borrower takes Steakhouse USDG's liquidity market to at least `bps` of its supply, against USDe worth twice
 * the loan at its LLTV; a market used that much already is left as it is. Returns the use.
 */
async function borrowTo(bps: bigint): Promise<bigint> {
  const data = (await fork.client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2Abi, functionName: "liquidityData" })) as Hex;
  const [m] = decodeAbiParameters(marketTuple, data);
  const id = keccak256(data);
  const [supply, , borrowed] = (await fork.client.readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "market", args: [id] })) as readonly bigint[];
  if ((borrowed as bigint) * 10_000n >= (supply as bigint) * bps) return ((borrowed as bigint) * 10_000n) / (supply as bigint);
  const want = ((supply as bigint) * bps) / 10_000n - (borrowed as bigint);
  const price = (await fork.client.readContract({ address: m.oracle, abi: oracleAbi, functionName: "price" })) as bigint;
  const collateral = ((((want * 10n ** 36n) / price) * 10n ** 18n) / m.lltv) * 2n;
  const borrower = fork.accounts[2]!;
  await fork.setBalance(borrower.address, 10n ** 18n);
  await fork.dealToken(borrower.address, m.collateralToken, collateral);
  const w = fork.wallet(borrower);
  const wait = async (hash: Hash) => assert.equal((await fork.client.waitForTransactionReceipt({ hash })).status, "success");
  await wait(await w.writeContract({ address: m.collateralToken, abi: erc20Abi, functionName: "approve", args: [MORPHO_BLUE, collateral], account: borrower, chain: null }));
  await wait(await w.writeContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "supplyCollateral", args: [m, collateral, borrower.address, "0x"], account: borrower, chain: null }));
  await wait(await w.writeContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "borrow", args: [m, want, 0n, borrower.address, borrower.address], account: borrower, chain: null }));
  const [s2, , b2] = (await fork.client.readContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "market", args: [id] })) as readonly bigint[];
  return ((b2 as bigint) * 10_000n) / (s2 as bigint);
}

test("arming in the vault's order, found done again, refused under the lock; the keeper trips the vault when its liquidity market passes 99% use", { timeout: 900_000 }, async () => {
  const a = agent("armed", 81);
  const vault = getAddress((await a.buyer.open()).vault);
  const breaker = getAddress(d.breaker as Address);
  assert.equal(a.breaker.address, breaker);
  const before = await a.breaker.status();
  assert.equal(before.guardian, false);
  assert.equal(before.locked, false);
  assert.ok(before.watches.length === 1 && !before.watches[0]!.watched);

  await fork.dealUsdg(vault, 1_000_000_000n);
  assert.equal((await a.borro.lendCash(STEAKHOUSE_USDG, 1_000_000_000n)).status, "sent");
  const shares = (await fork.client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2Abi, functionName: "balanceOf", args: [vault] })) as bigint;
  assert.ok(shares > 0n);

  const total = (await fork.client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2Abi, functionName: "totalAssets" })) as bigint;
  const armed = await a.breaker.arm();
  assert.deepEqual(armed.steps.map((s) => `${s.step}:${s.done}`), ["guardian:now", "approve:now", "configure:now"]);
  const s = await a.breaker.status();
  assert.equal(s.guardian, true);
  const w = s.watches[0]!;
  assert.ok(w.watched);
  assert.deepEqual({ ...w.limits, assetsMarkCap: undefined }, { ...DEFAULT_BREAKER_LIMITS, assetsMarkCap: undefined });
  assert.ok(w.limits.assetsMarkCap >= total, "the run is measured from the total read when the vault signed");
  assert.equal(w.nonce, 1n);
  const configureTx = armed.steps.find((x) => x.step === "configure")!.txHash as Hash;
  const configureGas = (await fork.client.getTransactionReceipt({ hash: configureTx })).gasUsed;
  console.log(`configure gas: ${configureGas}`);
  // Arming again: all done, nothing sent.
  assert.deepEqual((await a.breaker.arm()).steps.map((x) => `${x.step}:${x.done}`), ["guardian:already", "configure:already"]);

  // The lock on (it drops the approval, now used); then arming is refused.
  assert.equal((await a.borro.setLock("USDG", withdrawal, 129_600, "1")).status, "sent");
  assert.equal((await a.breaker.status()).locked, true);
  await assert.rejects(a.breaker.arm(), /withdrawal lock is on/);

  // The keeper: found from the events, healthy, then tripped.
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const keeper = await keeperOf("keeper", events);
  await keeper.refreshPairs();
  assert.ok(keeper.pairs.some((p) => p.vault === vault && p.target === STEAKHOUSE_USDG), JSON.stringify(keeper.pairs));
  await fork.increaseTime(1);
  assert.deepEqual((await keeper.tick()).filter((t) => t.pair.vault === vault), [], "a healthy vault is left alone");

  const use = await borrowTo(9_950n);
  assert.ok(use >= 9_900n, `use ${use}`);
  await fork.increaseTime(1);
  const usdgBefore = (await fork.client.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [vault] })) as bigint;
  const tripped = (await keeper.tick()).filter((t) => t.pair.vault === vault);
  assert.equal(tripped.length, 1, JSON.stringify(events));
  assert.equal(tripped[0]!.reasons, 4, "UTILIZATION");
  assert.ok(tripped[0]!.tx !== undefined);
  assert.equal((await fork.client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2Abi, functionName: "balanceOf", args: [vault] })) as bigint, 0n, "every share came back");
  const usdgAfter = (await fork.client.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [vault] })) as bigint;
  assert.ok(usdgAfter - usdgBefore >= 999_000_000n, `back ${usdgAfter - usdgBefore}`);
  const tripEvent = events.find((e) => e.event === "tripped");
  assert.ok(tripEvent !== undefined);
  console.log(`trip gas: ${tripEvent.fields.gasUsed}; gas price ${await fork.client.getGasPrice()}`);
  // Nothing left to trip: the next tick sends nothing.
  await fork.increaseTime(1);
  assert.deepEqual((await keeper.tick()).filter((t) => t.pair.vault === vault), []);
});

test("without the lock: the sweep's exit check leaves a cash vault whose liquidity market is past 99% use, and leaves a vault with no shares alone", { timeout: 900_000 }, async () => {
  const a = agent("unlocked", 82);
  const vault = getAddress((await a.buyer.open()).vault);
  assert.deepEqual(await a.strategy.exitCheck(), { held: 0, left: [] }, "no shares: nothing read beyond them");
  await fork.dealUsdg(vault, 500_000_000n);
  assert.equal((await a.borro.lendCash(STEAKHOUSE_USDG, 500_000_000n)).status, "sent");
  // The market is still past 99% use (the borrower of the first test holds it).
  await fork.increaseTime(1);
  assert.ok((await borrowTo(9_950n)) >= 9_900n);
  await fork.increaseTime(1);
  const r = await a.strategy.exitCheck();
  assert.equal(r.held, 1);
  assert.equal(r.left.length, 1, JSON.stringify(r));
  assert.ok(r.left[0]!.reasons.some((x) => /99% used/.test(x)), JSON.stringify(r.left[0]));
  assert.equal(r.left[0]!.landed, true, JSON.stringify(r.left[0]));
  assert.equal((await fork.client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2Abi, functionName: "balanceOf", args: [vault] })) as bigint, 0n);
  assert.ok(((await fork.client.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [vault] })) as bigint) >= 499_000_000n);
});

test("arming stopped after the approval is finished with the limits approved then; the keeper leaves an armed vault without the lock alone, and trips it once the lock is on", { timeout: 900_000 }, async () => {
  const stops = new FailingSender(fork.client as PublicClient, 1);
  const a = agent("interrupted", 83, stops);
  const vault = getAddress((await a.buyer.open()).vault);
  await fork.dealUsdg(vault, 300_000_000n);
  assert.equal((await a.borro.lendCash(STEAKHOUSE_USDG, 300_000_000n)).status, "sent");
  const total = (await fork.client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2Abi, functionName: "totalAssets" })) as bigint;

  // The limits' send fails after the vault approved them: nothing is watched yet, the approval stays at nonce 0.
  await assert.rejects(a.breaker.arm(), /RPC could not be reached/);
  const mid = await a.breaker.status();
  assert.equal(mid.guardian, true);
  assert.equal(mid.watches[0]!.watched, false);
  assert.equal(mid.watches[0]!.nonce, 0n);
  // The next arm sends the limits approved then (the run measured from the total read before), approving nothing new.
  const armed = await a.breaker.arm();
  assert.deepEqual(armed.steps.map((s) => `${s.step}:${s.done}`), ["guardian:already", "approve:already", "configure:now"]);
  const w = (await a.breaker.status()).watches[0]!;
  assert.ok(w.watched);
  assert.equal(w.nonce, 1n);
  assert.ok(w.limits.assetsMarkCap >= total);
  assert.equal((await a.breaker.status()).locked, false);

  // Past 99% use, the keeper finds the pair but the vault refuses a trip without its lock: left alone as not armed.
  assert.ok((await borrowTo(9_950n)) >= 9_900n);
  await fork.increaseTime(1);
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const keeper = await keeperOf("keeper-interrupted", events);
  await keeper.refreshPairs();
  assert.ok(keeper.pairs.some((p) => p.vault === vault), JSON.stringify(keeper.pairs));
  const seen = (await keeper.tick()).filter((t) => t.pair.vault === vault);
  assert.deepEqual(seen.map((t) => ({ reasons: t.reasons, error: t.error, tx: t.tx })), [{ reasons: 4, error: "not locked", tx: undefined }], JSON.stringify(events));
  assert.ok(events.some((e) => e.event === "not_armed" && e.fields.vault === vault));
  assert.ok(!events.some((e) => e.event === "tripped" || e.event === "trip_failed"), JSON.stringify(events));
  // Backed off: the next tick does not look at it again.
  await fork.increaseTime(1);
  assert.deepEqual((await keeper.tick()).filter((t) => t.pair.vault === vault), []);
  assert.ok(((await fork.client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2Abi, functionName: "balanceOf", args: [vault] })) as bigint) > 0n);

  // The lock on: within the backoff, the keeper reads it at the next tick and trips the vault.
  assert.equal((await a.borro.setLock("USDG", withdrawal, 129_600, "1")).status, "sent");
  await fork.increaseTime(1);
  const tripped = (await keeper.tick()).filter((t) => t.pair.vault === vault);
  assert.equal(tripped.length, 1, JSON.stringify(events));
  assert.ok(tripped[0]!.tx !== undefined, JSON.stringify(tripped[0]));
  assert.equal((await fork.client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2Abi, functionName: "balanceOf", args: [vault] })) as bigint, 0n);
});

test("arming stopped by the approval's send failing is finished by the next arm with the limits kept: the vault sends that approval first", { timeout: 900_000 }, async () => {
  const main = new FailingSender(fork.client as PublicClient, 0);
  const a = agent("approval-kept", 84, undefined, main);
  const vault = getAddress((await a.buyer.open()).vault);
  const breaker = getAddress(d.breaker as Address);
  assert.equal((await a.buyer.setGuardian(breaker, true)).status, "sent");
  // The approval's send fails: the vault keeps the signed approval, and the limits are kept here.
  main.failAfter(0);
  await assert.rejects(a.breaker.arm(), /RPC could not be reached/);
  const kept = JSON.parse((await a.folder.read("pending.json")) as string) as { nonce: string; limits: { assetsMarkCap: string } };
  assert.equal(kept.nonce, "0");
  const pending = (await a.buyer.spendSlot())?.pending;
  assert.equal(pending?.action, VAULT_ACTION.APPROVE_HASH);
  assert.equal((await a.breaker.status()).watches[0]!.watched, false);
  // Steakhouse USDG's total moves (a deposit of another vault), so new limits would differ: the kept ones are sent.
  const b = agent("approval-kept-other", 85);
  const other = getAddress((await b.buyer.open()).vault);
  await fork.dealUsdg(other, 2_000_000_000n);
  assert.equal((await b.borro.lendCash(STEAKHOUSE_USDG, 2_000_000_000n)).status, "sent");
  const armed = await a.breaker.arm();
  assert.deepEqual(armed.steps.map((x) => `${x.step}:${x.done}`), ["guardian:already", "approve:now", "configure:now"], JSON.stringify(armed.steps));
  const w = (await a.breaker.status()).watches[0]!;
  assert.ok(w.watched);
  assert.equal(w.limits.assetsMarkCap, BigInt(kept.limits.assetsMarkCap), "the limits kept, not new ones");
  assert.equal(w.nonce, 1n);
  assert.equal((await a.buyer.spendSlot())?.pending, null);
  assert.equal(await a.folder.read("pending.json"), undefined);
});
