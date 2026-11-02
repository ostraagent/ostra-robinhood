// Writes test/vectors/reputation.json: what OstraReputation itself computes, for test/reputation.test.ts to check
// reputation.ts against. The contract is ostra-swap's Foundry build (../../ostra-swap/out, `forge build` there),
// deployed on a local anvil (no fork; chain id 4663, as on mainnet) and asked through eth_call: its SNAPSHOT_DOMAIN,
// snapshotDigest, tierOf, bindHash and currentEpoch. The record, leaf, scope and public value vectors are those of
// ostra-swap privacy/contracts/test/RepVectors.sol (made by privacy/tools rep.rs from the circuit, and checked there
// against Reputation.sol by RepTest.t.sol). Run from sdk/ with anvil on PATH:
//   node scripts/reputation-vectors.ts

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain } from "../src/chain.ts";
import { ostraReputationAbi } from "../src/reputation-abi.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const ARTIFACT = here("../../../ostra-swap/out/OstraReputation.sol/OstraReputation.json");
const SOL_VECTORS = here("../../../ostra-swap/privacy/contracts/test/RepVectors.sol");
const OUT = here("../test/vectors/reputation.json");
/** anvil's development account 0 (a public test key). */
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PAD: Address = "0x1BE28c4F08a548598fE0AA9b16DFD564C82E8055";
const FACTORY: Address = "0x043a15c514CFE2c797d33520bFF91a5DCdbf2979";
const VERIFIER: Address = "0x00000000000000000000000000000000000ce001";

const sol = readFileSync(SOL_VECTORS, "utf8");
const constant = (name: string): string => {
  const m = new RegExp(`constant ${name} = (?:bytes32\\()?(0x[0-9a-fA-F]+|[0-9]+)\\)?;`).exec(sol);
  if (m === null) throw new Error(`RepVectors.sol has no ${name}`);
  return m[1] as string;
};
const array = (name: string): string[] => {
  const m = new RegExp(`function ${name}\\(\\) internal pure returns \\(uint256\\[\\d+\\] memory\\) \\{ return \\[uint256\\(([0-9]+)\\),? ?([0-9, ]*)\\]; \\}`).exec(sol);
  if (m === null) throw new Error(`RepVectors.sol has no ${name}`);
  return [m[1] as string, ...(m[2] as string).split(",").map((x) => x.trim()).filter((x) => x !== "")];
};

const port = 40_000 + Math.floor(Math.random() * 10_000);
const url = `http://127.0.0.1:${port}`;
const anvil = spawn("anvil", ["--chain-id", "4663", "--port", String(port), "--silent"], { stdio: "ignore" });
try {
  const client = createPublicClient({ chain: robinhoodChain, transport: http(url) });
  for (let i = 0; ; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      if (i > 200) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const account = privateKeyToAccount(DEV_KEY);
  const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(url) });
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { bytecode: { object: Hex } };
  const hash = await wallet.deployContract({ abi: ostraReputationAbi, bytecode: artifact.bytecode.object, args: [PAD, FACTORY, VERIFIER] });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const rep = getAddress(receipt.contractAddress as Address);
  const read = (functionName: string, args: readonly unknown[] = []) => client.readContract({ address: rep, abi: ostraReputationAbi, functionName: functionName as never, args: args as never }) as Promise<unknown>;

  const digests = [];
  for (const c of [
    { vault: "0xb63673010Ab32eCd07A06ED5B7634d2306b7e069", idc: constant("IDC_0"), nonce: 0n, epoch: 0n },
    { vault: "0x0a42c8254abeac3e36b3dacba085520e46e9ecd1", idc: constant("IDC_1"), nonce: 7n, epoch: 3n },
    { vault: "0x00000000000000000000000000000000000000A1", idc: constant("IDC_2"), nonce: (1n << 64n) + 5n, epoch: 1_073_741_823n },
  ]) {
    digests.push({ vault: getAddress(c.vault), idc: c.idc, nonce: c.nonce.toString(), epoch: c.epoch.toString(), digest: (await read("snapshotDigest", [getAddress(c.vault), c.idc as Hex, c.nonce, c.epoch])) as Hex });
  }
  const tiers = [];
  // Each tier's bounds, met and missed by one (completed, clients, volume, rejected ratio), with expired ignored.
  for (const r of [
    [0, 0, 0n, 0, 0],
    [10, 5, 100_000_000n, 2, 0],
    [10, 5, 100_000_000n, 3, 0],
    [9, 5, 100_000_000n, 0, 0],
    [10, 4, 100_000_000n, 0, 0],
    [10, 5, 99_999_999n, 0, 0],
    [50, 20, 1_000_000_000n, 5, 9],
    [50, 20, 1_000_000_000n, 6, 0],
    [200, 50, 10_000_000_000n, 10, 0],
    [200, 50, 10_000_000_000n, 11, 0],
    [4_000_000_000, 4_000_000_000, (1n << 128n) - 1n, 0, 65_535],
  ] as const) {
    const [completed, clients, volume, rejected, expired] = r;
    const p = { bond: 0n, lastEnd: 0n, active: 0, completed, rejected, expired, clients, fixedCompleted: 0, volume };
    tiers.push({ completed, clients, volume: volume.toString(), rejected, expired, tier: Number((await read("tierOf", [p])) as bigint) });
  }
  const scope = constant("SCOPE") as Hex;
  const recipient = getAddress(constant("RECIPIENT"));
  const challenge = constant("CHALLENGE") as Hex;
  const base = (await read("BASE")) as bigint;
  // The epoch at its boundaries: one second before epoch 3 and epoch 3's first second.
  const epochs = [];
  for (const t of [base + 3n * 604_800n - 1n, base + 3n * 604_800n]) {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_setNextBlockTimestamp", params: [Number(t)] }) });
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_mine", params: [] }) });
    epochs.push({ timestamp: t.toString(), epoch: ((await read("currentEpoch")) as bigint).toString() });
  }
  const out = {
    source:
      "OstraReputation (ostra-swap out/OstraReputation.sol, Foundry build) on a local anvil with chain id 4663, read by eth_call; records, leaves, scopes and public values from ostra-swap privacy/contracts/test/RepVectors.sol (privacy/tools rep.rs, checked against Reputation.sol by RepTest.t.sol). Written by sdk/scripts/reputation-vectors.ts.",
    chainId: 4663,
    reputation: rep,
    snapshotDomain: (await read("SNAPSHOT_DOMAIN")) as Hex,
    base: base.toString(),
    epochs,
    digests,
    tiers,
    bind: { scope, recipient, challenge, contract: (await read("bindHash", [scope, recipient, challenge])) as Hex, vectors: constant("BIND_HASH") },
    records: [0, 1, 2].map((i) => ({ fields: array(`record${i}`), idc: constant(`IDC_${i}`), record: constant(`RECORD_${i}`), leaf: constant(`LEAF_${i}`) })),
    scopes: [0, 1, 2].map((i) => ({ scope: constant(`SCOPE_${i}`), elements: array(`scopeElements${i}`) })),
    publicValues: { root: constant("ROOT"), pseudonym: constant("PSEUDONYM"), scope, bindHash: constant("BIND_HASH"), epoch: constant("EPOCH"), thresholds: array("thresholds"), values: array("publics") },
  };
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  process.stdout.write(`${OUT}: ${digests.length} digests, ${tiers.length} tiers, contract at ${rep}\n`);
} finally {
  anvil.kill();
}
