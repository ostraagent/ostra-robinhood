// The relayer's policy on OstraBreaker against the chain, on a fork of Robinhood Chain mainnet with Ostra (version 3
// vaults) and OstraBreaker deployed fresh: configure and trip on the deployment's breaker pass the policy and are
// simulated on the fork, where the breaker itself decides (a trip of a pair it does not watch reverts NotWatched,
// named in the answer); the same calls on another address are refused by the policy before any simulation.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { encodeFunctionData, getAddress, type Address } from "viem";
import { DEFAULT_BREAKER_LIMITS, STEAKHOUSE_USDG, deployBreaker, ostraBreakerAbi, type Deployment } from "@ostraagent/sdk";
import { OUT_DIR, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { RelayerGate } from "../src/gate.ts";
import { Ledger } from "../src/ledger.ts";

let fork: Fork;
let d: Deployment;
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-relayer-breaker-"));
  fork = await startFork();
  d = await deployBreaker({ publicClient: fork.client, walletClient: fork.wallet(fork.accounts[0]!), outDir: OUT_DIR }, await deployOnFork(fork));
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("configure and trip on the deployment's breaker reach the chain's simulation; on another address they are refused by the policy", { timeout: 600_000 }, async () => {
  const breaker = getAddress(d.breaker as Address);
  const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
  // Addresses with no code on Robinhood Chain: a vault the breaker does not watch, the relayer's account, another contract.
  const vault = at(0xa1);
  const gate = new RelayerGate({ client: fork.client, deployment: d, ledger: await Ledger.open(root), merchant: { token: d.token }, sender: { address: at(0xee) } } as never);
  const ask = async (to: Address, data: `0x${string}`) =>
    (await gate.relay({ body: JSON.stringify({ calls: [{ to, data }] }), req: { headers: {} } as never, ip: "127.0.0.1" })) as { status: number; body: { error: string; message: string } };
  const trip = encodeFunctionData({ abi: ostraBreakerAbi, functionName: "trip", args: [vault, STEAKHOUSE_USDG] });
  const configure = encodeFunctionData({ abi: ostraBreakerAbi, functionName: "configure", args: [vault, STEAKHOUSE_USDG, { ...DEFAULT_BREAKER_LIMITS, assetsMarkCap: 1n }] });

  // On the breaker: past the policy, the breaker's own checks refuse them in the simulation.
  const t = await ask(breaker, trip);
  assert.equal(t.status, 422, JSON.stringify(t.body));
  assert.equal(t.body.error, "simulation_failed", JSON.stringify(t.body));
  assert.match(t.body.message, /NotWatched/, t.body.message);
  const c = await ask(breaker, configure);
  assert.equal(c.status, 422, JSON.stringify(c.body));
  assert.equal(c.body.error, "simulation_failed", JSON.stringify(c.body));
  assert.match(c.body.message, /NotOstraVault/, c.body.message);

  // Elsewhere: refused by the policy.
  for (const data of [trip, configure]) {
    const r = await ask(at(0xb8), data);
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "refused");
    assert.match(r.body.message, /it is not this deployment's OstraBreaker/);
  }
});
