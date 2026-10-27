// The relayer's policy on OstraPad against the chain, on a fork of Robinhood Chain mainnet with the live OstraPad
// (OSTRAPAD) and a fresh Ostra deployment: a call on OstraPad passes the policy and is simulated, where OstraPad itself
// decides (a job that does not exist reverts WrongStatus, named in the answer); a call whose terms, job or account
// names the relayer's account or Multicall3 in a role is refused by the policy before any simulation (anyone could
// act in that role through the relayer); an OstraPad function on another address is not relayed.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { encodeFunctionData, getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { MULTICALL3, OSTRAPAD, USDG, ostraPadAbi, padJobId, usdgAbi, type Deployment, type PadTerms } from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { RelayerGate } from "../src/gate.ts";
import { Ledger } from "../src/ledger.ts";

let fork: Fork;
let d: Deployment;
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-relayer-pad-"));
  fork = await startFork();
  d = await deployOnFork(fork);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const RELAYER = at(0xee);

test("OstraPad calls reach the simulation; roles naming the relayer's account or Multicall3 are refused; elsewhere not relayed", { timeout: 600_000 }, async () => {
  const gate = new RelayerGate({ client: fork.client, deployment: d, ledger: await Ledger.open(root), merchant: { token: d.token }, sender: { address: RELAYER }, pad: OSTRAPAD } as never);
  const ask = async (to: Address, data: Hex) =>
    (await gate.relay({ body: JSON.stringify({ calls: [{ to, data }] }), req: { headers: {} } as never, ip: "127.0.0.1" })) as { status: number; body: { error: string; message: string } };
  const call = (functionName: string, args: readonly unknown[]) => encodeFunctionData({ abi: ostraPadAbi, functionName: functionName as never, args: args as never });
  const terms = (t: Partial<PadTerms>): PadTerms => ({ client: at(0xc1), provider: at(0xc2), evaluator: at(0xc3), budget: 1_000_000n, description: keccak256(stringToHex("d")), clientCommit: `0x${"00".repeat(32)}`, salt: keccak256(stringToHex("s")), ...t });

  // Past the policy: OstraPad's own checks refuse them in the simulation.
  const settle = await ask(OSTRAPAD, call("settle", [keccak256(stringToHex("no such job"))]));
  assert.equal(settle.status, 422, JSON.stringify(settle.body));
  assert.equal(settle.body.error, "simulation_failed", JSON.stringify(settle.body));
  assert.match(settle.body.message, /WrongStatus/, settle.body.message);
  const create = await ask(OSTRAPAD, call("create", [terms({})]));
  assert.equal(create.status, 422, JSON.stringify(create.body));
  assert.equal(create.body.error, "simulation_failed", JSON.stringify(create.body));

  // Roles naming the relayer's account or Multicall3: refused before any simulation.
  for (const [name, data] of [
    ["client", call("create", [terms({ client: RELAYER })])],
    ["provider", call("create", [terms({ provider: RELAYER })])],
    ["evaluator", call("create", [terms({ evaluator: getAddress(MULTICALL3) })])],
    ["pool", call("joinPool", [RELAYER, 50_000_000n])],
    ["bond", call("depositProviderBond", [getAddress(MULTICALL3), 1_000_000n])],
    ["sweep", call("sweepJobBox", [terms({ client: RELAYER })])],
    ["claim", call("claim", [RELAYER])],
  ] as const) {
    const r = await ask(OSTRAPAD, data);
    assert.equal(r.status, 422, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "refused", `${name}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.message, /in a role/, r.body.message);
  }

  // A job on chain whose provider is the relayer's account (created directly, not through the relayer): acting on it
  // through the relayer is refused, read from the job itself.
  const clientAccount = fork.accounts[0]!;
  const w = fork.wallet(clientAccount);
  await fork.dealUsdg(clientAccount.address, 2_000_000n);
  const t = terms({ client: getAddress(clientAccount.address), provider: RELAYER, evaluator: getAddress(fork.accounts[1]!.address) });
  await fork.client.waitForTransactionReceipt({ hash: await w.sendTransaction({ account: clientAccount, chain: null, to: USDG, data: encodeFunctionData({ abi: usdgAbi, functionName: "approve", args: [OSTRAPAD, 1_000_000n] }) }) });
  await fork.client.waitForTransactionReceipt({ hash: await w.sendTransaction({ account: clientAccount, chain: null, to: OSTRAPAD, data: call("create", [t]) }) });
  const id = padJobId(t);
  for (const data of [call("accept", [id, `0x${"00".repeat(32)}`]), call("submit", [id, keccak256(stringToHex("x"))]), call("settle", [id])]) {
    const r = await ask(OSTRAPAD, data);
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error, "refused", JSON.stringify(r.body));
    assert.match(r.body.message, /in a role/, r.body.message);
  }

  // An OstraPad function on another address: not relayed.
  const elsewhere = await ask(at(0xb8), call("settle", [id]));
  assert.equal(elsewhere.status, 422);
  assert.equal(elsewhere.body.error, "refused");
  assert.match(elsewhere.body.message, /is not relayed/);
});
