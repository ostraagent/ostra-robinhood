// The treasury of a version 4 vault end to end (MCP 0.1.18), on a fork of Robinhood Chain mainnet with Ostra's live
// deployment, through the keeper and relayer processes set up as on mainnet (relayer/scripts/setup-mainnet.ts) and the
// MCP server's own Agent, against the deployed Spark Savings USDG, Raeto's USDG and NVDA vaults, Steakhouse USDG and
// Morpho Blue:
//   * before the upgrade (vaults at version 3): every venue spend is refused before anything is signed, and the planner
//     plans as before (no treasury), keeping the owner's opt-in for later;
//   * the upgrade as the scheduled call executes it: OstraUpgradeOwner (impersonated) calls upgradeTo on the vault
//     beacon with the deployed version 4 implementation;
//   * plan and apply through the relayer: the tiers (cash, Spark, Raeto USDG for the owner's AI budget, the core), each
//     venue enabled and entered; the gas of each venue spend measured from its receipt;
//   * Raeto's credits accrue to the vault's principal, and strategy_report accounts each position with its fees;
//   * a payment the cash does not cover: refilled from Spark (and then Steakhouse), by strategy_refill and by the
//     payment itself (a vault_withdraw larger than the cash: the engine's refill runs first); a payment refused anyway
//     (to the vault itself, to the zero address, more than the cash and what can come in, over the lock's daily limit)
//     moves nothing; two payments at once are refilled one after the other, each from the balance as it is then, and a
//     payment started from inside a refill is refused at once; under the lock a payment to the withdrawal address, free
//     of the daily limit (withdrawalKeeps), is refilled and paid;
//   * Raeto's NVDA vault from the agent's NVDA vault (a stock vault's venue spends, sent through the relayer): enabled,
//     entered, exited; Forward to the linked USDG vault;
//   * the venue breaker: Raeto USDG's code changes (anvil_setCode on the venue, used only to simulate the venue changing
//     its code: the same code with one byte more, so its code hash differs), and strategy_check trips it at once
//     (tripVenue through the relayer, no key used): the position comes home;
//   * under the withdrawal lock, with a guardian vault: part of the Spark position home (guard op 5 through a Guard
//     spend), then the rest and every USDG of the vault to the withdrawal address (op 6); an enable waits the lock's
//     delay and the plan's Enter waits for it, then lands (a Spark Enter does not count against the daily limit);
//   * the break-even of each venue at mainnet's gas price and ETH/USD now, from the gas measured here and the L1 data
//     part read from the live chain, by the relayer's rule (a venue spend of sdk VENUE_CATALOG priced without its gas
//     floor): near the design's.
// Raeto's stock vault claimLiquidation is not reached: a liquidation needs NVDA's price to fall (the fork keeps the
// oracle as it is), so the Forward runs on USDG put into the stock vault with anvil_dealERC20.
// The relayer prices each request at Chainlink's ETH/USD, which on a fork stops at the fork block, and refuses an answer
// older than ETH_USD_MAX_AGE_SECONDS (25 hours): everything up to the lock's delay (36 hours) goes through the relayer,
// and the one Enter after that delay goes through the agent's own fee payer (OSTRA_RELAYER_URL off).
// Another holder's deposit into Raeto's USDG vault (450,000 USDG from a fresh account) stands for the vault's other
// depositors: Raeto USDG held 940 USDG on 1 Nov 2026, whose 5% cap is under any break-even. Needs anvil on PATH.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createPublicClient, createWalletClient, decodeFunctionData, formatUnits, getAddress, http, keccak256, numberToHex, parseAbi, parseUnits, stringToHex, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ARBITRUM_NODE_INTERFACE,
  BORRO_STOCKS,
  CHAINLINK_ETH_USD,
  ETH_USD_MAX_AGE_SECONDS,
  GUARD_OP,
  MULTICALL3,
  RAETO_NVDA_VAULT,
  RAETO_USDG_VAULT,
  ROBINHOOD_PUBLIC_RPC,
  SPARK_SAVINGS_USDG,
  STEAKHOUSE_USDG,
  USDG,
  VENUE_KIND,
  chainlinkEthUsd,
  checkDeployment,
  multicall3Abi,
  nodeInterfaceAbi,
  ostraVaultAbi,
  parseDeployment,
  pricedFloorGas,
  readVaultGuard,
  readWithdrawalKeeps,
  readWithdrawalSince,
  robinhoodChain,
  upgradeableBeaconAbi,
  usdgAbi,
  weiToTokenUnits,
  withMargin,
} from "@ostraagent/sdk";
import { rpc, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { breakEven, type Plan, type StepOutcome } from "@ostraagent/core";
import { setupMainnet } from "../../relayer/scripts/setup-mainnet.ts";
import { splitLogsClient } from "../../core/test/split-logs.ts";
import { Agent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const LIVE_DEPLOYMENT = here("../../deployments/robinhood-mainnet.json");
const RELAYER = here("../../relayer/src/server.ts");
const KEEPER = here("../../keeper/src/main.ts");
/** The scheduled upgrade: OstraUpgradeOwner calls upgradeTo(the deployed version 4 implementation) on the vault beacon. */
const UPGRADE_OWNER = getAddress("0x55533a51d9bd9b06F2D179d919BB31995EF96E5e");
const V4_IMPLEMENTATION = getAddress("0x8D16fd326b7d4f3D69A3c8d5efbeCCb25d29769a");
const V4_MODULE = getAddress("0x8Bd6321Fe66cF9c62DEF909092dDC3bbadDd72a2");
const URI = "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const PAYEE = getAddress("0x00000000000000000000000000000000000C0D11");
const JOB = getAddress("0x00000000000000000000000000000000000C0D12");
const WITHDRAWAL = getAddress("0x00000000000000000000000000000000000C0D13");
const NVDA = getAddress((BORRO_STOCKS.find((s) => s.symbol === "NVDA") as { token: Address }).token);
const USD = 10n ** 6n;
const LOCK_DELAY = 129_600;
const raetoAbi = parseAbi(["function deposit(uint256 amount) returns (uint256)", "function accrue()", "function principalOf(address) view returns (uint256)", "function totalPrincipal() view returns (uint256)"]);
const erc4626 = parseAbi(["function balanceOf(address) view returns (uint256)", "function convertToAssets(uint256) view returns (uint256)"]);
const raetoStockAbi = parseAbi(["function stockOf(address) view returns (uint256)"]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

let fork: Fork;
let dir: string;
let logsServer: Server | undefined;
const children: ChildProcess[] = [];

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-treasury-"));
});

after(async () => {
  for (const c of children) c.kill();
  logsServer?.closeAllConnections();
  await new Promise<void>((resolve) => (logsServer === undefined ? resolve() : logsServer.close(() => resolve())));
  await fork?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue;
    const at = line.indexOf("=");
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${url} did not answer within 60 s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A JSON-RPC endpoint over `split` (as mcp.fork.test.ts's): the chain's history from the public RPC, the fork's blocks from the fork. */
async function serveLogs(split: ReturnType<typeof splitLogsClient>): Promise<string> {
  type Req = { id?: unknown; method: string; params?: unknown[] };
  const one = async (m: Req) => {
    try {
      return { jsonrpc: "2.0", id: m.id ?? null, result: await split.request({ method: m.method, params: m.params } as never) };
    } catch (e) {
      return { jsonrpc: "2.0", id: m.id ?? null, error: { code: typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : -32603, message: (e as Error).message.split("\n")[0] } };
    }
  };
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      void (async () => {
        let out: unknown;
        try {
          const parsed = JSON.parse(body) as Req | Req[];
          out = Array.isArray(parsed) ? await Promise.all(parsed.map(one)) : await one(parsed);
        } catch (e) {
          out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: (e as Error).message } };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      })();
    });
  });
  logsServer = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** The vault spend a relayed transaction carries (alone, or among a Multicall3 batch): its vault, action and params. */
function spendOf(to: Address, input: Hex): { vault: Address; action: number; params: Hex } | null {
  const one = (target: Address, data: Hex) => {
    try {
      const d = decodeFunctionData({ abi: ostraVaultAbi, data });
      if (d.functionName !== "spend") return null;
      const args = d.args as readonly unknown[];
      return { vault: getAddress(target), action: Number(args[0]), params: args[2] as Hex };
    } catch {
      return null;
    }
  };
  if (getAddress(to) !== getAddress(MULTICALL3)) return one(to, input);
  const m = decodeFunctionData({ abi: multicall3Abi, data: input });
  for (const c of m.args[0] as readonly { target: Address; callData: Hex }[]) {
    const s = one(c.target, c.callData);
    if (s !== null) return s;
  }
  return null;
}

test("the treasury of a version 4 vault, end to end through the relayer: refused before the upgrade; plan, apply, credits, refill, a stock vault, the breaker, the lock and guard ops 5 and 6", { timeout: 5_400_000 }, async () => {
  const client = fork.client;
  const forkBlock = await client.getBlockNumber({ cacheTime: 0 });
  const live = parseDeployment(JSON.parse(readFileSync(LIVE_DEPLOYMENT, "utf8")));
  await checkDeployment(client, live);
  assert.equal(getAddress((await client.readContract({ address: live.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "implementation" })) as Address), live.vaultImplementation, "mainnet runs version 3 at the fork block");
  assert.equal(getAddress((await client.readContract({ address: live.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "owner" })) as Address), UPGRADE_OWNER);
  const logsUrl = await serveLogs(splitLogsClient(fork.url, forkBlock));
  // How far the clock may move while the relayer still prices requests (see the file comment).
  const start0 = (await client.getBlock({ blockNumber: forkBlock })).timestamp;
  const feedAt = (await client.readContract({ address: CHAINLINK_ETH_USD, abi: feedAbi, functionName: "latestRoundData" }))[3];
  const priced = Number(ETH_USD_MAX_AGE_SECONDS - (start0 - feedAt));
  console.log(`ETH/USD answered ${start0 - feedAt} s before the fork block: the relayer prices for ${priced} s more of the fork's clock`);
  assert.ok(priced > 3 * 3_600, "the feed's answer leaves under 3 hours: run again after its next round");

  // The services, set up as on mainnet (the keeper checks the deployment record at its start, before the upgrade).
  const base = join(dir, "robinhood");
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const listen = { keeper: `127.0.0.1:${port}`, relayer: `127.0.0.1:${port + 1}`, aggregator: `127.0.0.1:${port + 2}`, rpcProxy: `127.0.0.1:${port + 3}` };
  const setup = await setupMainnet({ base, deploymentPath: LIVE_DEPLOYMENT, deployer: fork.accounts[0] as PrivateKeyAccount, rpcUrl: fork.url, log: () => {}, listen });
  await fork.setBalance(setup.relayerAccount, 10n ** 19n);
  const logs = { keeper: join(dir, "keeper.log"), relayer: join(dir, "relayer.log") };
  const tails = () => Object.entries(logs).map(([n, f]) => `--- ${n}\n${readFileSync(f, "utf8").slice(-4_000)}`).join("\n");
  const start = (script: string, envFile: string, logFile: string, extra: Record<string, string> = {}) => {
    const out = openSync(logFile, "a");
    children.push(spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...readEnv(join(base, envFile)), ...extra }, stdio: ["ignore", out, out] }));
  };
  start(KEEPER, "keeper.env", logs.keeper);
  await waitFor(`http://${listen.keeper}/v1/health`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
  start(RELAYER, "relayer.env", logs.relayer, { OSTRA_RELAYER_CLIENT_IP: "socket" });
  await waitFor(`http://${listen.relayer}/v1/relayer`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));

  const open = async (home: string, relayer = true) => {
    await mkdir(home, { mode: 0o700, recursive: true });
    return Agent.open(
      await loadConfig({
        OSTRA_HOME: home,
        OSTRA_DEPLOYMENT: LIVE_DEPLOYMENT,
        OSTRA_RPC_URL: fork.url,
        OSTRA_LOGS_RPC_URL: logsUrl,
        OSTRA_RELAYER_URL: relayer ? `http://${listen.relayer}` : "off",
        OSTRA_KEEPER_URL: "off",
        OSTRA_AGGREGATOR_URL: "off",
        OSTRA_ETH_RPC_URL: "off",
        OSTRA_RAETO_URL: "off",
        OSTRA_PAD_INDEXER_URL: "off",
      }),
      () => {},
    );
  };
  const usdg = async (who: Address) => (await client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] })) as bigint;
  const nonceOf = async (v: Address) => (await client.readContract({ address: v, abi: ostraVaultAbi, functionName: "nonce" })) as bigint;
  const sparkShares = (who: Address) => client.readContract({ address: SPARK_SAVINGS_USDG, abi: erc4626, functionName: "balanceOf", args: [who] });
  const sparkAssets = async (who: Address) => client.readContract({ address: SPARK_SAVINGS_USDG, abi: erc4626, functionName: "convertToAssets", args: [await sparkShares(who)] });
  const steakShares = (who: Address) => client.readContract({ address: STEAKHOUSE_USDG, abi: erc4626, functionName: "balanceOf", args: [who] });
  const raetoPrincipal = (who: Address) => client.readContract({ address: RAETO_USDG_VAULT, abi: raetoAbi, functionName: "principalOf", args: [who] });
  const now = async () => Number((await client.getBlock({ blockTag: "latest" })).timestamp);
  const warpTo = async (t: number) => {
    const n = await now();
    if (t > n) await fork.increaseTime(t - n + 1);
  };
  /** The gas each relayed transaction used, by what it was (its receipt; anvil has no L1 data part). */
  const measured: { what: string; to: Address; input: Hex; gasUsed: bigint; spend: { vault: Address; action: number; params: Hex } | null }[] = [];
  const measure = async (what: string, txHash: Hex) => {
    const r = await client.getTransactionReceipt({ hash: txHash });
    assert.equal(r.status, "success", what);
    const tx = await client.getTransaction({ hash: txHash });
    measured.push({ what, to: getAddress(tx.to as Address), input: tx.input, gasUsed: r.gasUsed, spend: spendOf(tx.to as Address, tx.input) });
  };
  const sent = async (what: string, r: { status: string; txHash?: Hex }) => {
    assert.equal(r.status, "sent", `${what}: ${json(r)}`);
    await measure(what, r.txHash as Hex);
  };
  const record = async (outcomes: readonly StepOutcome[], prefix = "") => {
    for (const x of outcomes) if (x.result?.status === "sent") await measure(`${prefix}${x.kind} ${x.what}`, x.result.txHash);
  };
  const applyAll = async (a: Agent, plan: Plan): Promise<StepOutcome[]> => {
    const done: StepOutcome[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await a.strategy.apply(plan.id);
      done.push(...r.done);
      await record(r.done);
      if (r.next === null) return done;
      if (r.done.some((x) => !x.landed)) assert.fail(`a step did not take effect: ${json(r)}`);
      await warpTo(r.next.notBefore);
    }
    return assert.fail("the plan did not finish within 12 calls");
  };

  // --- Agent A, its vault at version 3 -----------------------------------------------------------------------------
  const a = await open(join(dir, "agent-a"));
  const vaultA = getAddress((await a.buyer.open()).vault);
  await fork.dealUsdg(vaultA, 120_000n * USD);
  assert.equal(Number(await client.readContract({ address: vaultA, abi: ostraVaultAbi, functionName: "VERSION" })), 3);
  const n0 = await nonceOf(vaultA);
  await assert.rejects(a.venues.setVenue("spark", true), /runs version 3; enable Spark Savings USDG opens once the vaults run version 4 \(.*executable from 2026-11-04T00:03:19Z\); nothing was signed/);
  await assert.rejects(a.venues.enter("raeto_usdg", "10"), /runs version 3; Enter of 10 USDG into Raeto's USDG vault opens once .*nothing was signed/);
  await assert.rejects(a.venues.exit("spark", "all"), /runs version 3; .*nothing was signed/);
  await assert.rejects(a.venues.trip("spark"), /runs version 3; the venue breaker opens once/);
  await assert.rejects(a.venues.forward("NVDA", "all"), /no NVDA vault yet; nothing was signed/);
  assert.equal(await nonceOf(vaultA), n0, "nothing was signed before the upgrade");
  // Registered in ERC-8004 (the strategies' gate), and a payment of 20,000 USDG: the payments the cash tier is read from.
  const launchpad = a.launchpad;
  assert.ok(launchpad !== null);
  await launchpad.fundCreatorVault("5");
  assert.equal(((await launchpad.registerAgent(URI)) as { status: string }).status, "sent");
  assert.equal((await a.buyer.withdraw(PAYEE, "20000")).status, "sent");
  const v3 = await a.strategy.plan({ aiBudget: 200n * USD });
  assert.equal(v3[0]?.profile, "conservative");
  assert.equal(v3[0]?.treasury, undefined, "below version 4 the planner plans as before");
  assert.deepEqual(await a.strategy.treasurySettings(), { aiBudget: 200n * USD, stockVaults: [] }, "the opt-in is kept for after the upgrade");

  // --- The upgrade, as the scheduled call executes it --------------------------------------------------------------
  await rpc(fork.url, "anvil_impersonateAccount", [UPGRADE_OWNER]);
  await rpc(fork.url, "anvil_setBalance", [UPGRADE_OWNER, numberToHex(10n ** 18n)]);
  const owner = createWalletClient({ account: UPGRADE_OWNER, chain: robinhoodChain, transport: http(fork.url) });
  const up = await owner.writeContract({ address: live.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "upgradeTo", args: [V4_IMPLEMENTATION], account: UPGRADE_OWNER, chain: robinhoodChain });
  assert.equal((await client.waitForTransactionReceipt({ hash: up })).status, "success");
  await rpc(fork.url, "anvil_stopImpersonatingAccount", [UPGRADE_OWNER]);
  assert.equal(Number(await client.readContract({ address: vaultA, abi: ostraVaultAbi, functionName: "VERSION" })), 4);
  assert.equal(getAddress((await client.readContract({ address: vaultA, abi: ostraVaultAbi, functionName: "MODULE_V4" })) as Address), V4_MODULE);

  // Raeto USDG's other depositors (see the file comment): 450,000 USDG from a fresh account.
  const holder = privateKeyToAccount(keccak256(stringToHex("OSTRA/MCP/TREASURY-FORK/raeto-holder")));
  await fork.setBalance(holder.address, 10n ** 18n);
  await fork.dealUsdg(holder.address, 450_000n * USD);
  const hw = createWalletClient({ account: holder, chain: robinhoodChain, transport: http(fork.url) });
  const approve = await hw.writeContract({ address: USDG, abi: usdgAbi, functionName: "approve", args: [RAETO_USDG_VAULT, 450_000n * USD], account: holder, chain: robinhoodChain });
  assert.equal((await client.waitForTransactionReceipt({ hash: approve })).status, "success");
  const dep = await hw.writeContract({ address: RAETO_USDG_VAULT, abi: raetoAbi, functionName: "deposit", args: [450_000n * USD], account: holder, chain: robinhoodChain });
  assert.equal((await client.waitForTransactionReceipt({ hash: dep })).status, "success");

  // --- Plan and apply ----------------------------------------------------------------------------------------------
  const t = (await a.strategy.plan())[0] as Plan;
  console.log(`treasury plan: ${json({ steps: t.steps, treasury: t.treasury, keep: t.keep, expected30d: t.expected30d })}`);
  assert.equal(t.profile, "treasury");
  const view = t.treasury;
  assert.ok(view !== undefined);
  assert.deepEqual(view.settings, { aiBudgetMonthly: "200", stockVaults: [] });
  for (const s of t.steps) assert.match(s.reason, /[0-9]/, `a step says why, with numbers: ${s.reason}`);
  const kinds = t.steps.map((s) => `${s.kind} ${s.what}`);
  assert.ok(kinds.includes("set_venue raeto_usdg") && kinds.includes("enter_venue raeto_usdg"), `Raeto USDG for the AI budget: ${kinds.join(", ")}`);
  assert.ok(kinds.includes("set_venue spark") && kinds.includes("enter_venue spark"), `Spark for the liquid tier: ${kinds.join(", ")}`);
  const done = await applyAll(a, t);
  assert.ok(done.every((x) => x.landed), json(done));
  const raetoHeld = await raetoPrincipal(vaultA);
  const raetoTotal = await client.readContract({ address: RAETO_USDG_VAULT, abi: raetoAbi, functionName: "totalPrincipal" });
  console.log(`after apply: idle ${formatUnits(await usdg(vaultA), 6)}, Spark ${formatUnits(await sparkAssets(vaultA), 6)}, Steakhouse shares ${await steakShares(vaultA)}, Raeto USDG ${formatUnits(raetoHeld, 6)} of ${formatUnits(raetoTotal, 6)}`);
  assert.ok(raetoHeld > 0n, "Raeto USDG holds the AI budget's principal");
  assert.ok(raetoHeld * 20n <= raetoTotal - raetoHeld + 20n, "at most 5% of the others' principal");
  assert.ok((await sparkShares(vaultA)) > 0n, "Spark holds the liquid tier");
  // The cash tier stays in the vault (each step keeps its own fee out of what it places; a relayer channel's deposit
  // may take a little more).
  const fees = t.steps.reduce((x, s) => x + BigInt(s.cost), 0n);
  assert.ok((await usdg(vaultA)) + fees >= parseUnits(view.tiers.cash, 6), `the cash tier ${view.tiers.cash} stays in the vault: ${formatUnits(await usdg(vaultA), 6)} idle`);
  // A part of the Raeto principal out through a spend of its own (its gas is a part of Raeto's round trip).
  await sent("exit_venue raeto_usdg", await a.venues.exit("raeto_usdg", formatUnits(raetoHeld / 4n, 6)));

  // --- Raeto credits and Spark's yield, and the accounts ------------------------------------------------------------
  await fork.increaseTime(Math.min(6 * 3_600, priced - 2 * 3_600));
  const anyone = fork.wallet(fork.accounts[1] as PrivateKeyAccount);
  const acc = await anyone.writeContract({ address: RAETO_USDG_VAULT, abi: raetoAbi, functionName: "accrue", args: [], account: fork.accounts[1] as PrivateKeyAccount, chain: robinhoodChain });
  assert.equal((await client.waitForTransactionReceipt({ hash: acc })).status, "success");
  const report = await a.strategy.report();
  console.log(`report: ${json(report)}`);
  const accounts = report.treasuryAccounts;
  assert.ok(accounts !== undefined);
  const raetoAcct = accounts.positions.find((p) => p.venue === "raeto_usdg");
  assert.ok(raetoAcct !== undefined && Number(raetoAcct.credits) > 0, "the principal earned Raeto credits");
  assert.ok(Number(accounts.positions.find((p) => p.venue === "spark")?.yield ?? "0") > 0, "Spark's yield is realized");
  assert.ok(Number(accounts.totals.fees) > 0, "the fees paid are counted");

  // --- A payment the cash does not cover: refilled from Spark -------------------------------------------------------
  const idle0 = await usdg(vaultA);
  const half = (await sparkAssets(vaultA)) / 2n;
  const need = idle0 + half;
  const r1 = await a.strategy.refill(need);
  console.log(`refill from Spark: ${json(r1)}`);
  assert.deepEqual(r1.steps.map((x) => `${x.kind} ${x.what} ${x.landed}`), ["exit_venue spark true"]);
  await record(r1.steps, "refill ");
  assert.ok((await usdg(vaultA)) >= need, "the vault holds the payment now");
  assert.equal((await a.buyer.withdraw(JOB, formatUnits(half, 6))).status, "sent");
  // A payment larger than the cash, sent as any payment is (vault_withdraw): the engine refills it from Spark first.
  const idle1 = await usdg(vaultA);
  const spark1 = await sparkAssets(vaultA);
  const payment = idle1 + spark1 / 4n;
  const jobBefore = await usdg(JOB);
  assert.equal((await a.buyer.withdraw(JOB, formatUnits(payment, 6))).status, "sent", "the payment is paid");
  assert.equal((await usdg(JOB)) - jobBefore, payment);
  assert.ok((await sparkAssets(vaultA)) < spark1, "Spark paid the part the cash did not cover");
  assert.ok((await sparkAssets(vaultA)) > spark1 / 2n, "only what the payment needed came out");
  // Payments refused anyway move nothing: to the vault itself, to the zero address, and more than the cash and what can
  // be refilled.
  {
    const held = { idle: await usdg(vaultA), spark: await sparkShares(vaultA), raeto: await raetoPrincipal(vaultA), nonce: await nonceOf(vaultA) };
    const big = formatUnits(held.idle + 1_000n * USD, 6);
    await assert.rejects(a.buyer.withdraw(vaultA, big), /the destination is the vault itself/);
    await assert.rejects(a.buyer.withdraw("0x0000000000000000000000000000000000000000", big), /zero address/);
    await assert.rejects(a.buyer.withdraw(JOB, formatUnits(held.idle + (await sparkAssets(vaultA)) + held.raeto + 1_000_000n * USD, 6)), /less than/);
    assert.deepEqual({ idle: await usdg(vaultA), spark: await sparkShares(vaultA), raeto: await raetoPrincipal(vaultA), nonce: await nonceOf(vaultA) }, held, "nothing moved");
  }
  // Two payments at once, each over the cash: the refills run one after the other, each from the balance as it is then
  // (the second waits for the first, then reads the balance again), so Spark gives no more than the payments paid need.
  {
    // The payment above left the vault almost no cash, less than the relayer channel the refill's Exit is paid from
    // needs (a few USDG): 100 USDG more stands for the cash tier the treasury keeps.
    await fork.dealUsdg(vaultA, (await usdg(vaultA)) + 100n * USD);
    const idle = await usdg(vaultA);
    const shares0 = await sparkShares(vaultA);
    const assets0 = await sparkAssets(vaultA);
    const d = assets0 / 8n;
    const both = await Promise.allSettled([a.buyer.withdraw(JOB, formatUnits(idle + d, 6)), a.buyer.withdraw(PAYEE, formatUnits(idle + d, 6))]);
    const paid = both.filter((x) => x.status === "fulfilled" && x.value.status === "sent").length;
    console.log(`two payments at once: ${json(both.map((x) => (x.status === "fulfilled" ? x.value.status : String(x.reason).split("\n")[0])))}`);
    assert.ok(paid >= 1, "a payment is paid");
    for (const x of both) if (x.status === "rejected") assert.match(String(x.reason), /less than/);
    const fell = assets0 - (await sparkAssets(vaultA));
    assert.ok((await sparkShares(vaultA)) < shares0);
    // Each refill takes what its payment lacks when it runs and three of its exit's fees (a few USDG on the fork): with
    // one payment paid, d; with both, d and then the whole second payment. Two refills from the same stale balance
    // would take d twice with one payment paid.
    const bound = paid === 1 ? d + 50n * USD : idle + 2n * d + 50n * USD;
    assert.ok(fell >= d && fell <= bound, `Spark fell by ${formatUnits(fell, 6)} for ${paid} payment(s) of ${formatUnits(idle + d, 6)} with ${formatUnits(idle, 6)} idle`);
  }
  // A payment started from inside a refill is refused at once (it would wait on the refill it runs in).
  {
    let inner = "";
    a.buyer.setRefill(async () => {
      inner = await a.buyer.withdraw(JOB, "1").then(
        (r) => `not refused: ${r.status}`,
        (e: unknown) => String(e),
      );
    });
    const outer = a.buyer.withdraw(JOB, formatUnits((await usdg(vaultA)) + 1_000n * USD, 6));
    const late = new Promise((_, reject) => setTimeout(() => reject(new Error("the payment waited on its own refill")), 120_000));
    await assert.rejects(Promise.race([outer, late]), /less than/);
    assert.match(inner, /a payment from inside the treasury's refill of this vault: refused \(it would wait on itself\); nothing was signed/);
    a.buyer.setRefill((need) => a.strategy.autoRefill(need));
  }
  // Earnings come in again (the guardian part below enters Spark from the cash).
  await fork.dealUsdg(vaultA, (await usdg(vaultA)) + 30_000n * USD);

  // --- Raeto's NVDA vault from the agent's NVDA vault ----------------------------------------------------------------
  const nvdaVault = getAddress((await a.vaultFor(NVDA).open()).vault);
  assert.equal(Number(await client.readContract({ address: nvdaVault, abi: ostraVaultAbi, functionName: "VERSION" })), 4);
  await fork.dealToken(nvdaVault, NVDA, 2n * 10n ** 18n);
  const stockPlan = (await a.strategy.plan({ stockVaults: ["NVDA"] }))[0] as Plan;
  console.log(`stock vaults in the plan: ${json(stockPlan.treasury?.stocks)}`);
  assert.equal(stockPlan.treasury?.stocks[0]?.symbol, "NVDA");
  await sent("set_venue raeto_nvda", await a.venues.setVenue("raeto_nvda", true));
  await sent("enter_venue raeto_nvda", await a.venues.enter("raeto_nvda", "0.5"));
  const stockNow = await client.readContract({ address: RAETO_NVDA_VAULT, abi: raetoStockAbi, functionName: "stockOf", args: [nvdaVault] });
  assert.ok(stockNow >= 5n * 10n ** 17n - 10n ** 6n, `stockOf ${stockNow}`);
  await sent("exit_venue raeto_nvda", await a.venues.exit("raeto_nvda", "0.2"));
  await sent("exit_venue raeto_nvda (all)", await a.venues.exit("raeto_nvda", "all"));
  assert.equal(await client.readContract({ address: RAETO_NVDA_VAULT, abi: raetoStockAbi, functionName: "stockOf", args: [nvdaVault] }), 0n);
  await assert.rejects(a.venues.exit("raeto_nvda", "liquidation"), /owes .* nothing from a liquidation; nothing was signed/);
  // Forward: only to the linked vault, which must be the USDG vault.
  await fork.dealUsdg(nvdaVault, 25n * USD);
  await assert.rejects(a.venues.forward("NVDA", "all"), /linked vault is none, not the USDG vault .*nothing was signed/);
  assert.equal((await a.borro.setLink("NVDA", vaultA)).status, "sent");
  const beforeForward = await usdg(vaultA);
  await sent("forward NVDA", await a.venues.forward("NVDA", "all"));
  assert.equal(await usdg(nvdaVault), 0n);
  assert.equal((await usdg(vaultA)) - beforeForward, 25n * USD, "the stock vault's USDG is in the USDG vault");
  assert.deepEqual((await a.strategy.treasurySettings()).stockVaults, ["NVDA"]);
  await a.strategy.plan({ stockVaults: [] });

  // --- The venue breaker: Raeto USDG's code changes ------------------------------------------------------------------
  assert.ok(!(await a.strategy.check({ execute: false })).actions.some((x) => x.kind === "trip_venue"), "nothing to trip while the venues are as pinned");
  // anvil_setCode only to simulate the venue changing its code (the same code with one byte more: another code hash).
  const code = (await client.getCode({ address: RAETO_USDG_VAULT })) as Hex;
  await rpc(fork.url, "anvil_setCode", [RAETO_USDG_VAULT, `${code}00`]);
  const tripped = await a.strategy.check({ execute: true });
  console.log(`check after the code change: ${json({ findings: tripped.findings, results: tripped.results })}`);
  const trip = tripped.results.find((x) => x.kind === "trip_venue" && x.what === "raeto_usdg");
  assert.ok(trip !== undefined && trip.landed === true && trip.result?.status === "sent", json(tripped.results));
  await measure("trip_venue raeto_usdg", trip.result.txHash);
  assert.equal(await raetoPrincipal(vaultA), 0n, "the breaker brought the Raeto position home");
  await assert.rejects(a.venues.enter("raeto_usdg", "100"), /changed since the vault enabled it \(code\).*nothing was signed/);

  // --- A payment past Spark: Spark, then Steakhouse ------------------------------------------------------------------
  if ((await steakShares(vaultA)) > 0n) {
    const need2 = (await usdg(vaultA)) + (await sparkAssets(vaultA)) + 100n * USD;
    const r2 = await a.strategy.refill(need2);
    console.log(`refill past Spark: ${json(r2)}`);
    assert.deepEqual(r2.steps.map((x) => `${x.kind} ${x.landed}`), ["exit_venue true", "redeem_cash true"]);
    await record(r2.steps, "refill ");
    assert.ok((await usdg(vaultA)) >= need2);
  }

  // --- Under the withdrawal lock, with a guardian vault ---------------------------------------------------------------
  const b = await open(join(dir, "agent-b"));
  const vaultB = getAddress((await b.buyer.open()).vault);
  await fork.dealUsdg(vaultB, 200n * USD);
  assert.equal((await a.buyer.setGuardian(vaultB, true)).status, "sent");
  await sent("enter_venue spark (venue_enter)", await a.venues.enter("spark", "20000"));
  // Spark disabled (at once: it stops new Enters only) before the lock goes on.
  await sent("set_venue spark (disable)", await a.venues.setVenue("spark", false));
  assert.equal((await a.borro.setLock("USDG", WITHDRAWAL, LOCK_DELAY, "1000")).status, "sent");
  // Under the lock, a payment over the daily limit (and over the cash) is refused, and nothing is refilled for it.
  {
    const held = { idle: await usdg(vaultA), spark: await sparkShares(vaultA), nonce: await nonceOf(vaultA) };
    assert.ok(held.spark > 0n);
    await assert.rejects(a.buyer.withdraw(JOB, formatUnits(held.idle + 5_000n * USD, 6)));
    assert.deepEqual({ idle: await usdg(vaultA), spark: await sparkShares(vaultA), nonce: await nonceOf(vaultA) }, held, "nothing moved under the lock");
    // The vault's own reading of when the lock went on and the withdrawal address was chosen (storage, no view).
    const since = await readWithdrawalSince(client, vaultA);
    const guard = await readVaultGuard(client, vaultA);
    assert.deepEqual([since.lockedSince, since.withdrawalSince, since.inForceSince], [guard.lockedSince, guard.lockedSince, guard.lockedSince]);
    // A Transfer to the withdrawal address that keeps what it gets (an address with no code, as withdrawalKeeps reads
    // it) is free of the daily limit: a payment to it over the limit and over the cash is refilled from Spark and paid.
    assert.equal(await readWithdrawalKeeps(client, vaultA), true);
    const toWithdrawal = held.idle + 3_000n * USD;
    const before = await usdg(WITHDRAWAL);
    assert.equal((await a.buyer.withdraw(WITHDRAWAL, formatUnits(toWithdrawal, 6))).status, "sent");
    assert.equal((await usdg(WITHDRAWAL)) - before, toWithdrawal);
    assert.ok((await sparkShares(vaultA)) < held.spark, "Spark paid the part the cash did not cover");
  }
  // Guard op 5 from the guardian vault: a third of the Spark position home.
  const sharesBefore = await sparkShares(vaultA);
  const usdgBefore = await usdg(vaultA);
  await sent("guard op 5 spark", await b.borro.guardOther(vaultA, { op: GUARD_OP.EXIT, kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: sharesBefore / 3n }));
  assert.equal(await sparkShares(vaultA), sharesBefore - sharesBefore / 3n);
  assert.ok((await usdg(vaultA)) > usdgBefore, "the USDG came back into the guarded vault");
  // Op 6: the rest home, and every USDG of the vault to its withdrawal address, in one call; a wrong address refused first.
  await assert.rejects(b.borro.guardOther(vaultA, { op: GUARD_OP.EXIT_SWEEP, kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 0n, expected: PAYEE }), /op 6 sweeps only to the one in force; nothing was signed/);
  const total = (await usdg(vaultA)) + (await sparkAssets(vaultA));
  await sent("guard op 6 spark", await b.borro.guardOther(vaultA, { op: GUARD_OP.EXIT_SWEEP, kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 0n, expected: WITHDRAWAL }));
  assert.equal(await sparkShares(vaultA), 0n);
  assert.equal(await usdg(vaultA), 0n);
  assert.ok((await usdg(WITHDRAWAL)) + 10n >= total, `the withdrawal address got ${await usdg(WITHDRAWAL)} of ${total}`);

  // The enable waits the lock's delay, and the plan's Enter waits for it.
  await fork.dealUsdg(vaultA, 30_000n * USD);
  const locked = (await a.strategy.plan())[0] as Plan;
  console.log(`plan under the lock: ${json(locked.steps)}`);
  assert.ok(locked.steps.some((s) => s.kind === "set_venue" && s.what === "spark") && locked.steps.some((s) => s.kind === "enter_venue" && s.what === "spark"), json(locked.steps));
  await warpTo(Math.max(...locked.steps.map((s) => s.notBefore)));
  const first = await a.strategy.apply(locked.id);
  console.log(`apply under the lock: ${json(first)}`);
  await record(first.done);
  const [on, , inForce, from] = (await client.readContract({ address: vaultA, abi: ostraVaultAbi, functionName: "venueOf", args: [VENUE_KIND.ERC4626, SPARK_SAVINGS_USDG] })) as readonly [boolean, boolean, boolean, bigint];
  assert.equal(on, true);
  assert.equal(inForce, false, "under the lock the enable is not in force yet");
  assert.ok(Number(from) >= (await now()) + LOCK_DELAY - 3_600);
  assert.ok(first.next !== null && first.next.notBefore === Number(from), json(first));
  assert.match(first.note ?? "", /the withdrawal lock's delay/);
  await assert.rejects(a.venues.enter("spark", "100"), /is not in force for .* until .*\(the lock's delay\); nothing was signed/);

  // After the delay (past the relayer's ETH/USD age on a fork, see the file comment): the agent's own fee payer.
  await warpTo(Number(from));
  const aLocal = await open(join(dir, "agent-a"), false);
  await fork.setBalance(await aLocal.local.payer(), 10n ** 18n);
  const second = await aLocal.strategy.apply(locked.id);
  console.log(`apply after the delay: ${json(second)}`);
  const entered = second.done.find((x) => x.kind === "enter_venue" && x.what === "spark");
  assert.ok(entered !== undefined && entered.landed, json(second));
  if (entered.result?.status === "sent") await measure("enter_venue spark (under the lock, own fee payer)", entered.result.txHash);
  assert.ok((await sparkAssets(vaultA)) > 1_000n * USD, "a Spark Enter does not count against the lock's daily limit of 1,000 USDG");

  // --- Gas measured, and each venue's break-even at mainnet's gas price and ETH/USD now --------------------------------
  const liveChain = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_PUBLIC_RPC) }) as PublicClient;
  const gasPrice = await liveChain.getGasPrice();
  const ethUsd = await chainlinkEthUsd(liveChain)();
  const rows: { what: string; gasUsed: string; floor: string; l1: string; usdg: string }[] = [];
  const price = new Map<string, bigint>();
  for (const m of measured) {
    const l1 = await liveChain
      .readContract({ address: ARBITRUM_NODE_INTERFACE, abi: nodeInterfaceAbi, functionName: "gasEstimateL1Component", args: [m.to, false, m.input] })
      .then((r) => (r as readonly [bigint, bigint, bigint])[0])
      .catch(() => 0n);
    // The relayer's rule: a venue spend of sdk VENUE_CATALOG without its floor, any other with it (sdk pricedFloorGas).
    const floor = m.spend === null ? 0n : pricedFloorGas(m.spend.action, m.spend.params);
    const units = weiToTokenUnits(withMargin((m.gasUsed + floor + l1) * gasPrice), ethUsd, 6);
    price.set(m.what, units);
    rows.push({ what: m.what, gasUsed: m.gasUsed.toString(), floor: floor.toString(), l1: l1.toString(), usdg: formatUnits(units, 6) });
  }
  console.log(`gas measured (mainnet gas price ${gasPrice} wei, ETH/USD ${ethUsd.answer} at ${ethUsd.updatedAt}): ${json(rows)}`);
  const rate = (r: string) => (r === "not known" ? null : parseUnits(r.replace("%", ""), 16));
  const be = (r: string, enter: string, exit: string) => {
    const e = price.get(enter);
    const x = price.get(exit);
    if (e === undefined || x === undefined) return { rate: r, roundTrip: null, breakEven: null };
    const b = breakEven(rate(r), e + x);
    return { rate: r, roundTrip: formatUnits(e + x, 6), breakEven: b === null ? null : formatUnits(b, 6) };
  };
  const breakEvens = {
    spark: { ...be(view.venues.spark.rateUsed, "enter_venue spark", "refill exit_venue spark"), spec: "about 29 USDG" },
    raeto_usdg: { ...be(view.venues.raeto_usdg.rateUsed, "enter_venue raeto_usdg", "exit_venue raeto_usdg"), spec: "about 88 USDG" },
    steakhouse: { ...be(view.venues.steakhouse.rateUsed, "lend_cash USDG", "refill redeem_cash USDG"), spec: "about 69 USDG" },
  };
  console.log(`break-even at mainnet's prices: ${json(breakEvens)}`);
  // Near the design's (measured on 30 Oct at that day's gas price and ETH/USD): within half to twice of it.
  for (const [name, spec] of [["spark", 29], ["raeto_usdg", 88]] as const) {
    const b = breakEvens[name].breakEven;
    assert.ok(b !== null && Number(b) >= spec / 2 && Number(b) <= spec * 2, `${name}'s break-even ${b} USDG is not near the design's ${spec} USDG`);
  }
});
