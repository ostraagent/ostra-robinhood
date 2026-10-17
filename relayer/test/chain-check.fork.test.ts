// Runs scripts/chain-check.ts, unchanged, against a fork of Robinhood Chain
// mainnet with Ostra deployed on it: the keeper and the relayer run as their
// own processes from their environment, as on the VPS. The fork only stands
// in for funding: the funder gets 20 USDG (anvil_dealERC20; the check uses
// about 20 times the price of a createVault) and the keeper fee payer ETH
// (anvil_setBalance).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { bytesToHex, keccak256, stringToHex, zeroAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, USDG, WotsKeychain, ostraVaultFactoryAbi, vaultAddress, type Deployment } from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";

/** anvil's development account 2 (a public test key, used only on the fork; it only sends transactions). */
const FUNDER_KEY = "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
/** The keeper fee payer of this run (a test key, written where the keeper reads it). */
const FEE_PAYER_KEY = keccak256(stringToHex("OSTRA/EVM/RELAYER-CHECK/fee-payer"));
/** PASS lines the check prints when everything passes. */
const EXPECTED_PASSES = 51;

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

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-relayer-check-"));
  fork = await startFork();
  d = await deployOnFork(fork);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("scripts/chain-check.ts passes against the keeper and relayer processes", async () => {
  const funder = fork.accounts[2]!;
  await fork.dealUsdg(funder.address, 20_000_000n);
  // The Ostra operator vault that receives the keeper fee.
  const operator = new WotsKeychain(new Uint8Array(32).fill(3), keccak256(stringToHex("OSTRA/EVM/RELAYER-CHECK/operator"), "bytes"), new FileWotsStore(join(root, "operator-wots")));
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
    OSTRA_CHECK_FUNDER: join(root, "funder.key"),
    OSTRA_CHECK_STATE: join(root, "check"),
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
