// Runs scripts/aggregator-check.ts, unchanged, against a fork of Robinhood
// Chain mainnet with Ostra deployed on it: the aggregator runs as its own
// process from its environment, as on the VPS. The fork only stands in for
// funding: the funder gets 200 USDG (anvil_dealERC20; sixteen deposits of
// one leaf take about 160.48) and keeps anvil's development ETH. The check waits
// out the 900-second approval window once, so this test takes about 20
// minutes.
//
// Every block anvil mines runs the EIP-2935 system call, which writes the
// parent block's hash into slot (number - 1) mod 393,168 (Arbitrum's history
// window) of the history storage contract; anvil first reads that slot's old
// value from the forked RPC, at the fork block. The public RPC stops serving
// the fork block's state after some minutes ("historical state ... is not
// available", seen on the first 20-minute run at closeBatch), so the test
// reads the slots of the next PREFETCH_BLOCKS blocks right after the fork
// starts, while that state is still served; anvil keeps them cached. The
// same holds for USDG's storage (the second run failed at sealBatch, after
// the wait, on a USDG slot not read before): the check seals a batch before
// it waits, so every USDG slot a seal and a leaf spend touch is read early.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { numberToHex, type Address } from "viem";
import type { Deployment } from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";

/** anvil's development account 2 (a public test key, used only on the fork; it only sends transactions). */
const FUNDER_KEY = "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
/** PASS lines the check prints when everything passes. */
const EXPECTED_PASSES = 38;
/** EIP-2935 history storage contract and Arbitrum's history window (blocks). */
const HISTORY_STORAGE: Address = "0x0000F90827F1C53a10cb7A02335B175320002935";
const HISTORY_WINDOW = 393_168n;
/** Blocks whose history slot is read ahead: the check mines about 120. */
const PREFETCH_BLOCKS = 400n;

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
  root = await mkdtemp(join(tmpdir(), "ostra-aggregator-check-"));
  fork = await startFork();
  const latest = await fork.client.getBlockNumber();
  for (let n = latest; n < latest + PREFETCH_BLOCKS; n++) {
    await fork.client.getStorageAt({ address: HISTORY_STORAGE, slot: numberToHex(n % HISTORY_WINDOW, { size: 32 }) });
  }
  d = await deployOnFork(fork);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("scripts/aggregator-check.ts passes against the aggregator process", async () => {
  const funder = fork.accounts[2]!;
  await fork.dealUsdg(funder.address, 200_000_000n);
  await writeFile(join(root, "deployment.json"), JSON.stringify(d));
  await writeFile(join(root, "funder.key"), `${FUNDER_KEY}\n`, { mode: 0o600 });

  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? root,
    OSTRA_RPC_URL: fork.url,
    OSTRA_DEPLOYMENT: join(root, "deployment.json"),
    OSTRA_AGGREGATOR_SECRETS: join(root, "aggregator-secrets"),
    OSTRA_AGGREGATOR_DATA: join(root, "aggregator-data"),
    OSTRA_AGGREGATOR_LISTEN: `127.0.0.1:${await freePort()}`,
    OSTRA_CHECK_FUNDER: join(root, "funder.key"),
    OSTRA_CHECK_STATE: join(root, "check"),
  };
  const script = fileURLToPath(new URL("../scripts/aggregator-check.ts", import.meta.url));
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
