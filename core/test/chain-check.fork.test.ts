// Runs scripts/chain-check.ts, unchanged, against a fork of Robinhood Chain
// mainnet with Ostra deployed on it: the keeper, the relayer and the seller
// server run as their own processes from their environment, as on the VPS.
// The launchpad is deployed next to Ostra (the launchpad step runs), and the
// pair steps run with NVDA, the real Robinhood stock token, and ETH
// (OSTRA_CHECK_PAIRS). The fork only stands in for funding: the funder gets
// 200 USDG (anvil_dealERC20; the check uses about 30 times the price of a
// createVault plus 1, for the launchpad step twice the price of a launch at
// the fork's gas price plus 2, for the pair steps three times that price plus
// 4: about 90 at the fork's gas price) and 0.2 NVDA
// (anvil_dealERC20, or from a holder of it on mainnet when that fails), and
// the keeper fee payer ETH (anvil_setBalance).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { bytesToHex, getAddress, keccak256, numberToHex, parseAbiItem, stringToHex, zeroAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, USDG, WotsKeychain, launchPair, ostraVaultFactoryAbi, usdgAbi, vaultAddress, type Deployment } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";

/** anvil's development account 2 (a public test key, used only on the fork; it only sends transactions). */
const FUNDER_KEY = "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
/** The keeper fee payer of this run (a test key, written where the keeper reads it). */
const FEE_PAYER_KEY = keccak256(stringToHex("OSTRA/EVM/CORE-CHECK/fee-payer"));
/** The stock token of the pair steps, and how much of it the funder gets (0.2, the check's PAIR_STOCK_FUNDING). */
const PAIR_STOCK = launchPair("NVDA");
const PAIR_STOCK_FUNDING = 200_000_000_000_000_000n;
/** PASS lines the check prints when everything passes: 35, and 10 for the pair steps. */
const EXPECTED_PASSES = 45;

let fork: Fork;
let d: Deployment;
let root: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address !== null && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(fork.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const balanceOf = (erc20: Address, owner: Address) => fork.client.readContract({ address: erc20, abi: usdgAbi, functionName: "balanceOf", args: [owner] });

/**
 * Gives `to` `amount` of `erc20` on the fork: anvil_dealERC20 when it sets the
 * balance balanceOf reports; otherwise a holder of at least `amount` on
 * mainnet, found in the token's Transfer logs before the fork block, is
 * impersonated and sends it.
 */
async function dealToken(erc20: Address, to: Address, amount: bigint): Promise<string> {
  const start = await balanceOf(erc20, to);
  try {
    await rpc("anvil_dealERC20", [to, erc20, numberToHex(start + amount)]);
    if ((await balanceOf(erc20, to)) === start + amount) return "anvil_dealERC20";
  } catch (err) {
    console.log(`anvil_dealERC20 of ${erc20}: ${(err as Error).message}`);
  }
  const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  let toBlock = await fork.client.getBlockNumber();
  let span = 100_000n;
  const seen = new Set<Address>();
  for (let queries = 0; queries < 400 && toBlock > 0n; queries++) {
    const fromBlock = toBlock > span ? toBlock - span + 1n : 0n;
    let logs;
    try {
      logs = await fork.client.getLogs({ address: erc20, event: transfer, fromBlock, toBlock });
    } catch (err) {
      if (span <= 1_000n) throw err;
      span /= 10n;
      continue;
    }
    for (const log of logs.reverse()) {
      const holder = getAddress(log.args.to as Address);
      if (holder === zeroAddress || seen.has(holder)) continue;
      seen.add(holder);
      if ((await balanceOf(erc20, holder)) < amount) continue;
      await rpc("anvil_impersonateAccount", [holder]);
      await rpc("anvil_setBalance", [holder, numberToHex(10n ** 18n)]);
      const hash = await fork.wallet(fork.accounts[0]!).writeContract({ address: erc20, abi: usdgAbi, functionName: "transfer", args: [to, amount], account: holder, chain: fork.client.chain });
      if ((await fork.client.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`the transfer of ${erc20} from ${holder} reverted`);
      await rpc("anvil_stopImpersonatingAccount", [holder]);
      if ((await balanceOf(erc20, to)) !== start + amount) throw new Error(`${to} did not receive exactly ${amount} of ${erc20}`);
      return `a transfer from the holder ${holder}`;
    }
    toBlock = fromBlock - 1n;
  }
  throw new Error(`no holder of ${amount} ${erc20} found in its Transfer logs`);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-check-"));
  fork = await startFork();
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("scripts/chain-check.ts passes against the keeper, relayer and seller server processes", async () => {
  const funder = fork.accounts[2]!;
  await fork.dealUsdg(funder.address, 200_000_000n);
  console.log(`the funder got ${PAIR_STOCK_FUNDING} base units of ${PAIR_STOCK.symbol} by ${await dealToken(PAIR_STOCK.address, funder.address, PAIR_STOCK_FUNDING)}`);
  // The Ostra operator vault that receives the keeper fee.
  const operator = new WotsKeychain(new Uint8Array(32).fill(3), keccak256(stringToHex("OSTRA/EVM/CORE-CHECK/operator"), "bytes"), new FileWotsStore(join(root, "operator-wots")));
  const root0 = bytesToHex(operator.keyRoot(0n));
  const deployer = fork.accounts[0]!;
  const hash = await fork.wallet(deployer).writeContract({ address: d.vaultFactory, abi: ostraVaultFactoryAbi, functionName: "createVault", args: [USDG, root0, zeroAddress], account: deployer, chain: fork.client.chain });
  assert.equal((await fork.client.waitForTransactionReceipt({ hash })).status, "success");
  const feeRecipient: Address = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: USDG, initialKeyRoot: root0, initialCrank: zeroAddress });

  const secrets = join(root, "keeper-secrets");
  await mkdir(secrets, { mode: 0o700 });
  await writeFile(join(secrets, "fee-payer.key"), `${FEE_PAYER_KEY.slice(2)}\n`, { mode: 0o600 });
  await fork.setBalance(privateKeyToAccount(FEE_PAYER_KEY).address, 10n ** 18n);
  await writeFile(join(root, "deployment.json"), JSON.stringify(d));
  await writeFile(join(root, "funder.key"), `${FUNDER_KEY}\n`, { mode: 0o600 });

  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? root,
    OSTRA_RPC_URL: fork.url,
    OSTRA_DEPLOYMENT: join(root, "deployment.json"),
    OSTRA_KEEPER_SECRETS: secrets,
    OSTRA_KEEPER_DATA: join(root, "keeper-data"),
    OSTRA_KEEPER_LISTEN: `127.0.0.1:${await freePort()}`,
    OSTRA_KEEPER_FEE_RECIPIENT: feeRecipient,
    OSTRA_RELAYER_LISTEN: `127.0.0.1:${await freePort()}`,
    OSTRA_MERCHANT_LISTEN: `127.0.0.1:${await freePort()}`,
    OSTRA_CHECK_FUNDER: join(root, "funder.key"),
    OSTRA_CHECK_STATE: join(root, "check"),
    OSTRA_CHECK_PAIRS: PAIR_STOCK.symbol,
  };
  const script = fileURLToPath(new URL("../scripts/chain-check.ts", import.meta.url));
  const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  const lines = out.split("\n");
  for (const line of lines.filter((l) => /^(PASS|FAIL) /.test(l))) console.log(line);
  assert.equal(code, 0, out);
  assert.ok(lines.includes("ALL CHECKS PASSED"), out);
  assert.equal(lines.filter((l) => l.startsWith("FAIL ")).length, 0, out);
  assert.equal(lines.filter((l) => l.startsWith("PASS ")).length, EXPECTED_PASSES, out);
});
