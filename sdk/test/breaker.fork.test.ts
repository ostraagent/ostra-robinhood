// OstraBreaker's deployment and reads (src/breaker.ts, deploy.ts: deployBreaker, scripts/deploy-breaker.ts) on a
// fork of Robinhood Chain mainnet, against the live Steakhouse USDG, Morpho Blue and Morpho's factories, next to a
// fresh Ostra deployment (version 3 vaults):
//   * deployBreaker deploys it bound to the record's factory and Morpho's contracts, the record carries it and
//     checkDeployment checks it; a record without a vault module, or with a breaker already, is refused;
//   * breakerLimitsHash is the contract's limitsHash, and the limits it refuses are the ones the contract refuses;
//   * readBreaker reads Steakhouse USDG's liquidity market, what it can pay out, and a vault that watches nothing;
//   * scripts/deploy-breaker.ts as it runs on mainnet: 0600 files, the record written once, a second run that checks,
//     and a stopped run finished by adopting the address it printed, never one another account deployed.
// (The trips themselves, by real borrowers, depositors and the curator, are test/Breaker.fork.t.sol.)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256, stringToHex, type Address, type PrivateKeyAccount } from "viem";
import { ostraBreakerAbi } from "../src/abi.ts";
import { BREAKER_REASON, DEFAULT_BREAKER_LIMITS, breakerLimitsFor, breakerLimitsHash, breakerReasons, checkBreakerLimits, readBreaker, type BreakerLimits } from "../src/breaker.ts";
import { MORPHO_BLUE, MORPHO_MARKET_V1_ADAPTER_V2_FACTORY, MORPHO_VAULT_V2_FACTORY } from "../src/constants.ts";
import { checkBreakerCode, checkDeployment, deployBreaker } from "../src/deploy.ts";
import { parseDeployment, type Deployment } from "../src/deployment.ts";
import { STEAKHOUSE_USDG } from "../src/strategy.ts";
import { OUT_DIR, deployOnFork, rpc, startFork, type Fork } from "./fork.ts";

const script = fileURLToPath(new URL("../scripts/deploy-breaker.ts", import.meta.url));
/** anvil's development account 3 (a public test key, used on the fork only). */
const DEV_KEY_3 = "0x7c852118294e51e653712a81e05800f5f2b2a8ae56a8a0b82e3d9e0a6c0ce58b";

let fork: Fork;
let d: Deployment;
let dir: string;

before(async () => {
  fork = await startFork();
  d = await deployOnFork(fork);
  dir = mkdtempSync(join(tmpdir(), "ostra-breaker-"));
});

after(async () => {
  await fork?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

let withBreaker: Deployment;

test("deployBreaker binds OstraBreaker to the record's factory and Morpho's contracts, and the record carries it", async () => {
  assert.ok(d.vaultModule !== undefined, "deployOstra makes version 3 vaults");
  const deployer = fork.accounts[0] as PrivateKeyAccount;
  const events: Record<string, unknown>[] = [];
  withBreaker = await deployBreaker({ publicClient: fork.client, walletClient: fork.wallet(deployer), outDir: OUT_DIR, log: (_, f) => events.push(f) }, d);
  const breaker = withBreaker.breaker as Address;
  const read = (functionName: "FACTORY" | "VAULT_V2_FACTORY" | "MORPHO" | "ADAPTER_FACTORY") => fork.client.readContract({ address: breaker, abi: ostraBreakerAbi, functionName });
  assert.equal(getAddress(await read("FACTORY")), d.vaultFactory);
  assert.equal(getAddress(await read("VAULT_V2_FACTORY")), MORPHO_VAULT_V2_FACTORY);
  assert.equal(getAddress(await read("MORPHO")), MORPHO_BLUE);
  assert.equal(getAddress(await read("ADAPTER_FACTORY")), MORPHO_MARKET_V1_ADAPTER_V2_FACTORY);
  const gas = events[0]?.gasUsed as bigint;
  assert.ok(gas > 0n && gas < 3_000_000n, `deployment gas ${gas} within BREAKER_GAS_BUDGET`);
  console.log(`OstraBreaker deployment gas: ${gas}`);
  await checkDeployment(fork.client, withBreaker);
  assert.deepEqual(parseDeployment(JSON.parse(JSON.stringify(withBreaker))), withBreaker);
  // A record with a breaker must be a version 3 record; and a breaker is deployed once.
  const { vaultModule: _, ...v2 } = withBreaker;
  assert.throws(() => parseDeployment(JSON.parse(JSON.stringify(v2))), /a deployment with a breaker has a vaultModule/);
  await assert.rejects(deployBreaker({ publicClient: fork.client, walletClient: fork.wallet(deployer), outDir: OUT_DIR }, withBreaker), /has OstraBreaker already/);
  const { vaultModule: __, ...noModule } = d;
  await assert.rejects(deployBreaker({ publicClient: fork.client, walletClient: fork.wallet(deployer), outDir: OUT_DIR }, noModule as Deployment), /do not run version 3/);
  // checkDeployment catches a record naming another contract as the breaker.
  await assert.rejects(checkDeployment(fork.client, { ...withBreaker, breaker: d.registry }), /FACTORY/);
  // The code is this build's, byte for byte but for the immutables; code differing in one byte (one opcode of its
  // first instructions here) is refused even with the same immutables, and so is code using one immutable with two
  // values (the getter's right, another use not).
  await checkBreakerCode(fork.client, breaker, OUT_DIR);
  await assert.rejects(checkBreakerCode(fork.client, d.vaultFactory, OUT_DIR), /not this build's OstraBreaker/);
  const code = (await fork.client.getCode({ address: breaker })) as string;
  const other = "0x0000000000000000000000000000000000b4ea4e";
  const at = (i: number, b: string) => `${code.slice(0, 2 + 2 * i)}${b}${code.slice(4 + 2 * i)}`;
  assert.equal(code.slice(2, 6), "6080", "the code starts PUSH1 0x80");
  await rpc(fork.url, "anvil_setCode", [other, at(1, "a0")]);
  await assert.rejects(checkBreakerCode(fork.client, other, OUT_DIR), /not this build's OstraBreaker/);
  const refs = (JSON.parse(readFileSync(join(OUT_DIR, "OstraBreaker.sol", "OstraBreaker.json"), "utf8")) as { deployedBytecode: { immutableReferences: Record<string, { start: number; length: number }[]> } }).deployedBytecode.immutableReferences;
  const second = Object.values(refs).find((r) => r.length > 1)?.[1] as { start: number; length: number };
  const lastByte = code.slice(2 + 2 * (second.start + second.length - 1), 4 + 2 * (second.start + second.length - 1));
  await rpc(fork.url, "anvil_setCode", [other, at(second.start + second.length - 1, lastByte === "00" ? "01" : "00")]);
  await assert.rejects(checkBreakerCode(fork.client, other, OUT_DIR), /with different values/);
  await rpc(fork.url, "anvil_setCode", [other, code]);
  await checkBreakerCode(fork.client, other, OUT_DIR);
});

test("breakerLimitsHash is OstraBreaker.limitsHash, and the limits it refuses are the contract's", async () => {
  const breaker = withBreaker.breaker as Address;
  const vault = getAddress(keccak256(stringToHex("a vault")).slice(0, 42));
  const cases: [BreakerLimits, bigint][] = [
    [breakerLimitsFor(543_436_706_081_589n), 0n],
    [{ priceDropBps: 9_999, assetsDropBps: 1, maxUtilizationBps: 10_000, minLiquidityBps: 1_000_000, assetsMarkCap: 2n ** 128n - 1n }, 7n],
    [{ priceDropBps: 0, assetsDropBps: 0, maxUtilizationBps: 0, minLiquidityBps: 0, assetsMarkCap: 0n }, 2n ** 64n - 1n],
  ];
  for (const [l, nonce] of cases) {
    const onChain = await fork.client.readContract({
      address: breaker,
      abi: ostraBreakerAbi,
      functionName: "limitsHash",
      args: [vault, STEAKHOUSE_USDG, { priceDropBps: l.priceDropBps, assetsDropBps: l.assetsDropBps, maxUtilizationBps: l.maxUtilizationBps, minLiquidityBps: l.minLiquidityBps, assetsMarkCap: l.assetsMarkCap }, nonce],
    });
    assert.equal(breakerLimitsHash(d.chainId, breaker, vault, STEAKHOUSE_USDG, l, nonce), onChain);
  }
  const ok = breakerLimitsFor(1_000_000n);
  assert.equal(ok.assetsMarkCap, 1_000_000n);
  assert.equal(breakerLimitsFor(1_000_000n, { ...DEFAULT_BREAKER_LIMITS, assetsDropBps: 0 }).assetsMarkCap, 0n, "no run limit, no cap");
  assert.throws(() => checkBreakerLimits({ ...ok, priceDropBps: 10_000 }), /priceDropBps/);
  assert.throws(() => checkBreakerLimits({ ...ok, assetsDropBps: 10_000 }), /assetsDropBps/);
  assert.throws(() => checkBreakerLimits({ ...ok, maxUtilizationBps: 10_001 }), /maxUtilizationBps/);
  assert.throws(() => checkBreakerLimits({ ...ok, minLiquidityBps: 1_000_001 }), /minLiquidityBps/);
  assert.throws(() => checkBreakerLimits({ ...ok, priceDropBps: 1.5 }), /priceDropBps/);
  assert.throws(() => checkBreakerLimits({ ...ok, assetsMarkCap: 0n }), /needs an assetsMarkCap/);
  assert.throws(() => checkBreakerLimits({ ...ok, assetsMarkCap: 2n ** 128n }), /uint128/);
  assert.deepEqual(breakerReasons(BREAKER_REASON.PRICE | BREAKER_REASON.LIQUIDITY), ["price", "liquidity"]);
});

test("readBreaker reads Steakhouse USDG's liquidity market and a vault that watches nothing", async () => {
  const breaker = withBreaker.breaker as Address;
  const vault = getAddress(keccak256(stringToHex("a vault")).slice(0, 42));
  const s = await readBreaker(fork.client, breaker, vault, STEAKHOUSE_USDG);
  assert.equal(s.watched, false);
  assert.equal(s.nonce, 0n);
  assert.equal(s.shares, 0n);
  assert.equal(s.position, 0n);
  assert.equal(s.priceMark, 0n, "nothing marked the price yet");
  assert.ok(s.hasLiquidityMarket, "Steakhouse USDG's liquidity adapter serves a USDG market");
  assert.ok(s.payout > 0n && s.totalAssets > s.payout, `payout ${s.payout} of ${s.totalAssets}`);
  assert.ok(s.price > 0n);
  assert.ok(s.utilizationBps > 0n && s.utilizationBps <= 10_000n);
  // With no limits nothing is crossed, whatever the market.
  assert.equal(s.reasons, 0);
  // poke marks the price.
  const deployer = fork.accounts[0] as PrivateKeyAccount;
  const hash = await fork.wallet(deployer).writeContract({ address: breaker, abi: ostraBreakerAbi, functionName: "poke", args: [STEAKHOUSE_USDG], account: deployer, chain: null });
  assert.equal((await fork.client.waitForTransactionReceipt({ hash })).status, "success");
  const marked = await readBreaker(fork.client, breaker, vault, STEAKHOUSE_USDG);
  assert.ok(marked.priceMark > 0n && marked.priceMark <= marked.price);
});

test("scripts/deploy-breaker.ts deploys once from 0600 files and then only checks", async () => {
  const key = join(dir, "deployer.key");
  const rpc = join(dir, "rpc.url");
  const record = join(dir, "deployment.json");
  writeFileSync(key, `${DEV_KEY_3}\n`, { mode: 0o600 });
  writeFileSync(rpc, `${fork.url}\n`, { mode: 0o600 });
  const run = () =>
    spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? "", OSTRA_DEPLOYER_KEY_FILE: key, OSTRA_RPC_URL_FILE: rpc, OSTRA_DEPLOYMENT: record },
      encoding: "utf8",
      timeout: 300_000,
    });
  // A version 2 record is refused before anything is sent.
  const { vaultModule: _, ...v2 } = d;
  writeFileSync(record, `${JSON.stringify(v2, null, 2)}\n`, { mode: 0o644 });
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not a version 3 record/);

  writeFileSync(record, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o644 });
  const deployer = fork.accounts[3]?.address as Address;
  await fork.setBalance(deployer, 10n ** 18n);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /BREAKER_OK/);
  assert.ok(!first.stdout.includes(DEV_KEY_3.slice(2)) && !first.stderr.includes(DEV_KEY_3.slice(2)), "the key is never printed");
  assert.ok(!first.stdout.includes(fork.url), "the RPC URL is never printed");
  const written = parseDeployment(JSON.parse(readFileSync(record, "utf8")));
  assert.ok(written.breaker !== undefined);
  await checkDeployment(fork.client, written);

  const nonce = await fork.client.getTransactionCount({ address: deployer });
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /"event":"found"/);
  assert.equal(await fork.client.getTransactionCount({ address: deployer }), nonce, "a record with a breaker sends nothing");
  assert.deepEqual(parseDeployment(JSON.parse(readFileSync(record, "utf8"))), written);
  // The address printed before sending is where it landed; a run that stopped before writing adopts it, sending nothing.
  assert.match(first.stdout, new RegExp(`"event":"deploying","breaker":"${written.breaker}"`));
  writeFileSync(record, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o644 });
  const adopt = (breaker: string) =>
    spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? "", OSTRA_DEPLOYER_KEY_FILE: key, OSTRA_RPC_URL_FILE: rpc, OSTRA_DEPLOYMENT: record, OSTRA_BREAKER: breaker },
      encoding: "utf8",
      timeout: 300_000,
    });
  // A real breaker another account deployed, bound to the same factory, is never adopted: only the deployer's own.
  const foreign = adopt(withBreaker.breaker as string);
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /was not created by the deployer/);
  assert.deepEqual(parseDeployment(JSON.parse(readFileSync(record, "utf8"))), d, "a refused adoption writes nothing");
  const adopted = adopt(written.breaker as string);
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.match(adopted.stdout, /"adopted":true/);
  assert.equal(await fork.client.getTransactionCount({ address: deployer }), nonce);
  assert.deepEqual(parseDeployment(JSON.parse(readFileSync(record, "utf8"))), written);
});
