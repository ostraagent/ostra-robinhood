// The evaluator bot's funding (scripts/fund-pad-evaluator.ts) run as on the VPS, on a fork of Robinhood Chain mainnet
// against the live OstraPad and USDG: with too little USDG in the funding account nothing is sent; the raeto phase
// (and the check before it says so) gives the fee payer its ETH and the credits' USDG and sends that USDG to Raeto's payTo, then waits until Raeto's
// account shows it; the pool phase gives four evaluator accounts their bonds and joins them to the pool (their gas
// topped up from the fee payer); a run again of either phase sends nothing. Raeto's API is not reached from a fork: a
// local server answers its two reads (GET /v1/agents and /v1/me, in the shapes Raeto's API gave on 31 Oct 2026), the
// credits read from the fork's chain (what the fee payer sent to the payTo). The live run checks Raeto itself.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { erc20Abi, keccak256, parseEther, stringToHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { OSTRAPAD, PAD, USDG, ostraPadAbi, readPadEvaluator } from "@ostraagent/sdk";
import { startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { openFeePayer } from "../src/keys.ts";

const run = promisify(execFile);
const RAETO_PAY_TO: Address = "0xF0Cc2FE5A90a3BB784De818f6E2061fd99c236Bf";
let fork: Fork;
let root: string;
let raeto: Server;
let raetoUrl: string;
const funderKey = keccak256(stringToHex("OSTRA/KEEPER/FUND-FORK/funder"));
const funder = privateKeyToAccount(funderKey);
const evaluatorKeys = [1, 2, 3, 4].map((i) => keccak256(stringToHex(`OSTRA/KEEPER/FUND-FORK/evaluator-${i}`)));
const evaluators = evaluatorKeys.map((k) => privateKeyToAccount(k));
let feePayer: Address;
let payToAtFork = 0n;
/** Credits the bot has spent, as Raeto would show them. */
let spent = 0;
const usdg = (a: Address) => fork.client.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const nonce = (a: Address) => fork.client.getTransactionCount({ address: a });

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-fund-pad-"));
  fork = await startFork();
  const secrets = join(root, "services", "pad-evaluator", "secrets");
  await mkdir(join(root, "services", "pad-evaluator", "data"), { recursive: true, mode: 0o700 });
  feePayer = (await openFeePayer(secrets)).address;
  await writeFile(join(secrets, "raeto.key"), "raeto-test-key\n", { mode: 0o600 });
  await writeFile(join(root, "rpc.url"), `${fork.url}\n`, { mode: 0o600 });
  await writeFile(join(root, "funder.key"), `${funderKey}\n`, { mode: 0o600 });
  for (const [i, k] of evaluatorKeys.entries()) await writeFile(join(root, `evaluator-${i + 1}.key`), `${k}\n`, { mode: 0o600 });
  await writeFile(join(root, "evaluators.json"), JSON.stringify(evaluators.map((a, i) => ({ n: i + 1, address: a.address }))));
  payToAtFork = await usdg(RAETO_PAY_TO);
  raeto = createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/v1/agents") return send(200, { chainId: 4663, usdg: { token: USDG, payTo: RAETO_PAY_TO } });
      if (req.url === "/v1/me" && req.headers.authorization === "Bearer raeto-test-key") {
        const credited = Number((await usdg(RAETO_PAY_TO)) - payToAtFork) / 1e6 - spent;
        return send(200, { object: "account", address: feePayer.toLowerCase(), balance_usd: credited, fee_pct: 8, key: { name: "Ostrapad evaluator", kind: "dev", spent_usd: 0, limit_usd: null, models: null }, available_usd: credited });
      }
      send(404, { error: "not_found" });
    })();
  });
  await new Promise<void>((r) => raeto.listen(0, "127.0.0.1", () => r()));
  const addr = raeto.address() as { port: number };
  raetoUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  raeto?.close();
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function fund(phase: "check" | "raeto" | "pool"): Promise<{ ok: boolean; out: string }> {
  const env = {
    ...process.env,
    OSTRA_RPC_URL_FILE: join(root, "rpc.url"),
    OSTRA_DEPLOYER_KEY_FILE: join(root, "funder.key"),
    OSTRA_SERVICES_DIR: join(root, "services"),
    OSTRA_PAD_EVALUATOR_KEYS: evaluatorKeys.map((_, i) => join(root, `evaluator-${i + 1}.key`)).join(","),
    OSTRA_PAD_EVALUATORS_RECORD: join(root, "evaluators.json"),
    OSTRA_RAETO_URL: raetoUrl,
  };
  try {
    const r = await run(process.execPath, ["scripts/fund-pad-evaluator.ts", phase], { env, cwd: join(import.meta.dirname, ".."), timeout: 1_200_000 });
    return { ok: true, out: r.stdout + r.stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

test("the bot is funded: ETH and Raeto credits, then four evaluator accounts bonded in the pool; a run again sends nothing", { timeout: 2_400_000 }, async () => {
  const c = fork.client as PublicClient;
  await fork.setBalance(funder.address, parseEther("0.0077"));
  await fork.dealUsdg(funder.address, 169_597n);
  // Too little USDG: the check says so, and the raeto phase sends nothing.
  let r = await fund("check");
  assert.equal(r.ok, false, r.out);
  assert.match(r.out, /USDG 10 for Raeto's credits and 200 for the bonds/);
  r = await fund("raeto");
  assert.equal(r.ok, false, r.out);
  assert.match(r.out, /nothing was sent/);
  assert.equal(await nonce(funder.address), 0);

  await fork.dealUsdg(funder.address, 210_169_597n);
  r = await fund("check");
  assert.ok(r.ok && r.out.includes("PAD_FUNDS_ENOUGH"), r.out);
  assert.equal(await nonce(funder.address), 0, "the check sends nothing");
  r = await fund("raeto");
  assert.ok(r.ok && r.out.includes("PAD_FUNDED_RAETO"), r.out);
  assert.equal((await usdg(RAETO_PAY_TO)) - payToAtFork, 10_000_000n, "10 USDG to Raeto's payTo");
  assert.equal(await usdg(feePayer), 0n);
  const feePayerEth = await c.getBalance({ address: feePayer });
  assert.ok(feePayerEth > parseEther("0.0049") && feePayerEth < parseEther("0.005"), String(feePayerEth));
  assert.equal(await usdg(funder.address), 200_169_597n);
  const sent = [await nonce(funder.address), await nonce(feePayer)];
  // Credits spent since (the checks' judgments): a run again neither sends nor waits for the first balance.
  spent = 0.4;
  const t0 = Date.now();
  r = await fund("raeto");
  assert.ok(r.ok && r.out.includes("PAD_FUNDED_RAETO") && r.out.includes("balance_usd now 9.6"), r.out);
  assert.ok(Date.now() - t0 < 15_000, "no wait for credits already shown");
  assert.deepEqual([await nonce(funder.address), await nonce(feePayer)], sent, "a run again sends nothing");

  const size = (await c.readContract({ address: OSTRAPAD, abi: ostraPadAbi, functionName: "poolSize" })) as bigint;
  r = await fund("pool");
  assert.ok(r.ok && r.out.includes("PAD_FUNDED_POOL"), r.out);
  const now = (await c.getBlock()).timestamp;
  for (const a of evaluators) {
    const e = await readPadEvaluator(c, a.address);
    assert.equal(e.inPool, true);
    assert.equal(e.bond, PAD.MIN_EVALUATOR_BOND);
    assert.ok(e.joinedAt >= now - 600n + PAD.STAKE_DELAY && e.joinedAt <= now + PAD.STAKE_DELAY, "counted STAKE_DELAY after the join");
    assert.equal(await usdg(a.address), 0n, "the bond is with OstraPad");
    assert.ok((await c.getBalance({ address: a.address })) > 0n, "gas topped up from the fee payer");
  }
  assert.equal((await c.readContract({ address: OSTRAPAD, abi: ostraPadAbi, functionName: "poolSize" })) as bigint, size + 4n);
  assert.equal(await usdg(funder.address), 169_597n, "200 USDG of bonds from the funding account");
  const joined = [await nonce(funder.address), await nonce(feePayer), ...(await Promise.all(evaluators.map((a) => nonce(a.address))))];
  r = await fund("pool");
  assert.ok(r.ok && r.out.includes("PAD_FUNDED_POOL") && (r.out.match(/in the pool already/g) ?? []).length === 4, r.out);
  assert.deepEqual([await nonce(funder.address), await nonce(feePayer), ...(await Promise.all(evaluators.map((a) => nonce(a.address))))], joined, "a run again sends nothing");
  // Nothing secret printed.
  assert.equal(r.out.includes(fork.url), false);
  assert.equal(r.out.includes("raeto-test-key"), false);
});
