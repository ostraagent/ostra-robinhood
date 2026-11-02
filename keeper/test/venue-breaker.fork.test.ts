// The venue breaker keeper (src/venue-breaker-main.ts, set up by scripts/setup-venue-breaker.ts) on a fork of Robinhood
// Chain mainnet with Ostra's live deployment after the version 4 upgrade, run as the scheduled call executes it
// (OstraUpgradeOwner, impersonated, calls upgradeTo on the vault beacon with the deployed version 4 implementation), and
// the record as sdk scripts/upgrade-vault.ts finalize writes it:
//   * an agent's vault (core's VaultService, as its MCP has it) enables Spark Savings USDG and enters 500 USDG, and its
//     agent goes offline: nothing of it runs from then on; the vault has also entered a venue outside the first
//     release: OpenZeppelin's plain ERC-4626 of USDG (PlainVault, test/VaultV4.fork.t.sol, the contract tests' own
//     build in out/), deployed here as anyone could deploy it, which the keeper never trips;
//   * the keeper, run once, finds the position from the vault's Entered event and sends nothing (Spark is as pinned);
//   * Spark's code changes, and PlainVault's (anvil_setCode on each venue, used only to simulate a venue changing its
//     code: the same code with one byte more, so its code hash differs from the one the vault pinned);
//   * with its fee payer holding no ETH the keeper sends nothing and says so (low_eth);
//   * funded, it trips Spark's position: tripVenue(ERC4626, Spark, 0) from its own key, the shares redeemed into the
//     vault; PlainVault's position stays (not in the catalog: it is not even read);
//   * run again it sends nothing (the position holds nothing).
// Needs anvil on PATH.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { createWalletClient, decodeEventLog, getAddress, http, keccak256, numberToHex, parseAbi, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  SPARK_SAVINGS_USDG,
  VAULT_ACTION,
  VENUE_KIND,
  enterParams,
  ostraVaultAbi,
  parseDeployment,
  retryingHttp,
  robinhoodChain,
  setVenueParams,
  signVaultSpend,
  simulateVaultSpend,
  spendFloorGas,
  upgradeableBeaconAbi,
  venueTrippedEvent,
  type Deployment,
} from "@ostraagent/sdk";
import { OUT_DIR, rpc, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, LocalSender, VaultService, X402_NETWORK, spendCall, type Config } from "../../core/src/index.ts";
import { MemoryFolder } from "../../core/test/memory-folder.ts";
import { setupVenueBreaker } from "../scripts/setup-venue-breaker.ts";

const run = promisify(execFile);
const service = fileURLToPath(new URL("../src/venue-breaker-main.ts", import.meta.url));
const UPGRADE_OWNER = getAddress("0x55533a51d9bd9b06F2D179d919BB31995EF96E5e");
/** The version 4 record: the deployed implementation, OstraVaultModule and OstraVaultModuleV4 (the design's contract side). */
const V4 = { vaultImplementation: "0x8D16fd326b7d4f3D69A3c8d5efbeCCb25d29769a", vaultModule: "0x405A0e88e3929A7A9EE01a5169DCd1D02d95C5EC", vaultModuleV4: "0x8Bd6321Fe66cF9c62DEF909092dDC3bbadDd72a2" };
const USD = 10n ** 6n;
const sparkAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/KEEPER/VENUE-BREAKER-FORK/agent-fee-payer")));

let fork: Fork;
let root: string;
let d: Deployment;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-venue-breaker-"));
  fork = await startFork();
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

function readEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const at = line.indexOf("=");
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

test("the venue breaker trips an offline agent's position after its venue's code changes, once, from its own key", { timeout: 1_800_000 }, async () => {
  const client = fork.client as PublicClient;
  const fromBlock = await client.getBlockNumber({ cacheTime: 0 });
  const liveRecord = JSON.parse(await readFile(new URL("../../deployments/robinhood-mainnet.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const live = parseDeployment(liveRecord);

  // The upgrade, as the scheduled call executes it, and the record finalize writes after it.
  await rpc(fork.url, "anvil_impersonateAccount", [UPGRADE_OWNER]);
  await rpc(fork.url, "anvil_setBalance", [UPGRADE_OWNER, numberToHex(10n ** 18n)]);
  const owner = createWalletClient({ account: UPGRADE_OWNER, chain: robinhoodChain, transport: http(fork.url) });
  const up = await owner.writeContract({ address: live.vaultBeacon, abi: upgradeableBeaconAbi, functionName: "upgradeTo", args: [getAddress(V4.vaultImplementation)], account: UPGRADE_OWNER, chain: robinhoodChain });
  assert.equal((await client.waitForTransactionReceipt({ hash: up })).status, "success");
  await rpc(fork.url, "anvil_stopImpersonatingAccount", [UPGRADE_OWNER]);
  const recordPath = join(root, "robinhood-mainnet.json");
  await writeFile(recordPath, JSON.stringify({ ...liveRecord, ...V4 }, null, 2));
  d = parseDeployment(JSON.parse(await readFile(recordPath, "utf8")));

  // An agent's vault enters Spark, then its agent goes offline.
  const config: Config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 18n);
  const keys = new Keys({ master: new Uint8Array(32).fill(91), feePayer, store: new FileWotsStore(join(root, "wots")), folder: new MemoryFolder(), backupExported: async () => true });
  const transport = retryingHttp(fork.url);
  const sender = new LocalSender(client, transport, feePayer);
  const vault = new VaultService(client, transport, config, keys, sender, "buyer");
  await vault.open();
  const at = getAddress(await vault.vaultAddress());
  assert.equal(Number(await client.readContract({ address: at, abi: ostraVaultAbi, functionName: "VERSION" })), 4);
  await fork.dealUsdg(at, 1_000n * USD);
  const spend = async (action: number, params: Hex) => {
    const sim = await simulateVaultSpend(client, d, { relayer: feePayer.address, vault: at, action, params });
    const r = await vault.operate({ gas: (sim.gasUsed * 5n) / 4n + 100_000n + spendFloorGas(action, params), what: "spend", build: async ({ v, vault: a, keychain, chainId }) => [spendCall(a, await signVaultSpend(keychain, v, { chainId, action: action as never, params }))] });
    assert.equal(r.status, "sent", JSON.stringify(r));
  };
  await spend(VAULT_ACTION.SET_VENUE, setVenueParams({ kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, enabled: true }));
  await spend(VAULT_ACTION.ENTER, enterParams({ kind: VENUE_KIND.ERC4626, venue: SPARK_SAVINGS_USDG, amount: 500n * USD, minPosition: 0n }));
  // A venue outside the first release, deployed by anyone and entered by the vault.
  const plainArtifact = JSON.parse(readFileSync(join(OUT_DIR, "VaultV4.fork.t.sol", "PlainVault.json"), "utf8")) as { abi: readonly unknown[]; bytecode: { object: Hex } };
  await fork.setBalance(fork.accounts[3]!.address, 10n ** 18n);
  const deployer = fork.wallet(fork.accounts[3]!);
  const deployTx = await deployer.deployContract({ abi: plainArtifact.abi as never, bytecode: plainArtifact.bytecode.object, args: [d.token] as never, account: fork.accounts[3]!, chain: robinhoodChain });
  const plain = getAddress((await client.waitForTransactionReceipt({ hash: deployTx })).contractAddress as Address);
  await spend(VAULT_ACTION.SET_VENUE, setVenueParams({ kind: VENUE_KIND.ERC4626, venue: plain, enabled: true }));
  await spend(VAULT_ACTION.ENTER, enterParams({ kind: VENUE_KIND.ERC4626, venue: plain, amount: 100n * USD, minPosition: 0n }));
  const plainShares = await client.readContract({ address: plain, abi: sparkAbi, functionName: "balanceOf", args: [at] });
  assert.ok(plainShares > 0n, "the vault holds PlainVault shares");
  const shares = await client.readContract({ address: SPARK_SAVINGS_USDG, abi: sparkAbi, functionName: "balanceOf", args: [at] });
  assert.ok(shares > 0n, "the vault holds Spark shares");
  const usdgBefore = await client.readContract({ address: d.token, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [at] });

  // The keeper, set up as on the VPS (its environment file, directories and key), run once at a time.
  const services = join(root, "services");
  const setup = await setupVenueBreaker({ servicesDir: services, deploymentPath: recordPath, rpcUrl: fork.url, fromBlock, log: () => {} });
  assert.equal(setup.funded, false, "its fee payer holds no ETH yet");
  const env = { PATH: process.env.PATH ?? "", ...readEnv(await readFile(join(services, "venue-breaker.env"), "utf8")), OSTRA_LOGS_RPC_URL: fork.url };
  const once = async () => {
    const r = await run(process.execPath, [service, "once"], { env, timeout: 600_000 });
    const lines = r.stdout.trim().split("\n");
    const events = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
    const last = (lines.at(-1) ?? "").split(" ");
    assert.equal(last[0], "VENUE_BREAKER_ONCE", r.stdout + r.stderr);
    assert.equal(r.stdout.includes(fork.url), false, "the RPC URL is never printed");
    return { sent: Number(last[1]), failed: Number(last[2]), events, out: r.stdout };
  };
  const nonce = () => client.getTransactionCount({ address: setup.feePayer });

  let r = await once();
  assert.deepEqual([r.sent, r.failed], [0, 0], r.out);
  assert.ok(r.events.some((e) => e.event === "position" && e.vault === at && e.venue === SPARK_SAVINGS_USDG), r.out);
  assert.ok(r.events.some((e) => e.event === "not_in_catalog" && e.vault === at && e.venue === plain), r.out);
  assert.ok(!r.events.some((e) => e.event === "position" && e.venue === plain), "the venue outside the catalog is not kept");

  // anvil_setCode only to simulate the venue changing its code (the same code with one byte more: another code hash).
  const code = (await client.getCode({ address: SPARK_SAVINGS_USDG })) as Hex;
  await rpc(fork.url, "anvil_setCode", [SPARK_SAVINGS_USDG, `${code}00`]);
  const plainCode = (await client.getCode({ address: plain })) as Hex;
  await rpc(fork.url, "anvil_setCode", [plain, `${plainCode}00`]);

  // No ETH: nothing is sent, and the log says why.
  r = await once();
  assert.deepEqual([r.sent, r.failed], [0, 0], r.out);
  assert.ok(r.events.some((e) => e.event === "low_eth" && e.feePayer === setup.feePayer), r.out);
  assert.equal(await nonce(), 0);
  assert.equal(await client.readContract({ address: SPARK_SAVINGS_USDG, abi: sparkAbi, functionName: "balanceOf", args: [at] }), shares);

  // Funded: the trip, from the keeper's own key.
  await fork.setBalance(setup.feePayer, 10n ** 16n);
  r = await once();
  assert.deepEqual([r.sent, r.failed], [1, 0], r.out);
  const tripped = r.events.find((e) => e.event === "tripped");
  assert.ok(tripped !== undefined && tripped.vault === at && JSON.stringify(tripped.reasons) === JSON.stringify(["code"]) && tripped.mode === "home", r.out);
  assert.equal(await nonce(), 1);
  assert.equal(await client.readContract({ address: SPARK_SAVINGS_USDG, abi: sparkAbi, functionName: "balanceOf", args: [at] }), 0n, "the position came home");
  assert.equal(await client.readContract({ address: plain, abi: sparkAbi, functionName: "balanceOf", args: [at] }), plainShares, "the venue outside the catalog is left alone");
  const usdgAfter = await client.readContract({ address: d.token, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [at] });
  assert.ok(usdgAfter >= usdgBefore + 500n * USD - 10n, `the vault holds ${usdgAfter} USDG`);
  const receipt = await client.getTransactionReceipt({ hash: tripped.tx as Hex });
  const ev = receipt.logs.filter((l) => getAddress(l.address) === at).map((l) => {
    try {
      return decodeEventLog({ abi: [venueTrippedEvent], data: l.data, topics: l.topics });
    } catch {
      return null;
    }
  }).find((x) => x !== null);
  assert.ok(ev !== undefined && ev !== null && getAddress(ev.args.by as Address) === setup.feePayer && Number(ev.args.reasons) === 1, JSON.stringify(ev, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  console.log(`trip gas: ${receipt.gasUsed}`);

  // Run again: nothing to send.
  r = await once();
  assert.deepEqual([r.sent, r.failed], [0, 0], r.out);
  assert.equal(await nonce(), 1, "nothing sent again");
});
