// Ostrapad's index (src/pad.ts) on a fork of Robinhood Chain mainnet, against the live OstraPad, USDG and ERC-8004
// Identity Registry, with fresh version 3 Ostra vaults: an agent registers from its Ostra creator vault and lists two
// offers (its USDG vault approving the listing), a second agent registered by an account that is not an Ostra vault
// is left out, a client orders, the provider accepts and delivers and the client approves; the index then serves the
// listed agent with its record, the job with its status and pay, and its stats. Files are kept in memory under the
// CID the uploader gives them (CIDv1 raw sha2-256 of the bytes), as core's pad.fork.test.ts does.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { decodeEventLog, encodeFunctionData, getAddress, keccak256, sha256, stringToHex, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ERC8004_IDENTITY_REGISTRY,
  FileWotsStore,
  VAULT_ACTION,
  ostraVaultAbi,
  padCidFromDigest,
  padServiceEntry,
  registerAgentParams,
  retryingHttp,
  setAgentUriParams,
  signVaultSpend,
  simulateVaultSpend,
  type Deployment,
} from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, LocalSender, PadService, VaultService, X402_NETWORK, profileFile, spendCall, type Config } from "../../core/src/index.ts";
import { MemoryFolder } from "../../core/test/memory-folder.ts";
import { PadIndexer } from "../src/pad.ts";

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/INDEXER/PAD-FORK/fee-payer")));
const ipfs = new Map<string, Uint8Array>();
async function upload(file: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(file));
  const uri = padCidFromDigest(sha256(bytes));
  ipfs.set(uri, bytes);
  return uri;
}
const readJson = async (uri: string) => {
  const b = ipfs.get(uri);
  return b === undefined ? null : (JSON.parse(new TextDecoder().decode(b)) as unknown);
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-indexer-pad-"));
  fork = await startFork();
  d = await deployOnFork(fork);
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function spend(vault: VaultService, sender: LocalSender, action: number, params: Hex) {
  const at = await vault.vaultAddress();
  const sim = await simulateVaultSpend(fork.client as PublicClient, d, { relayer: await sender.payer(), vault: at, action, params });
  const r = await vault.operate({ gas: (sim.gasUsed * 5n) / 4n + 100_000n, what: "spend", build: async ({ v, vault: a, keychain, chainId }) => [spendCall(a, await signVaultSpend(keychain, v, { chainId, action: action as never, params }))] });
  assert.equal(r.status, "sent");
  return r as { txHash: Hex };
}

async function agent(name: string, seed: number) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const folder = new MemoryFolder();
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder, backupExported: async () => true });
  const creatorKeys = new Keys({ master: new Uint8Array(32).fill(seed + 100), feePayer, store: new FileWotsStore(join(root, `${name}-c`)), folder: new MemoryFolder(), backupExported: async () => true });
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, sender, "creator");
  await buyer.open();
  await creator.open();
  const creatorVault = getAddress(await creator.vaultAddress());
  let agentId: bigint | null = null;
  let file: Record<string, unknown> | null = profileFile({ name, description: `${name} does reports`, vault: creatorVault });
  const pad = new PadService({
    client,
    config,
    buyer,
    sender,
    folder,
    identity: async () => ({ agentId, creatorVault }),
    currentFile: async () => file,
    publishFile: async (f) => {
      file = f;
      const uri = await upload(f);
      const r = await spend(creator, sender, VAULT_ACTION.SET_AGENT_URI, setAgentUriParams({ agentId: agentId as bigint, uri }));
      return { uri, profile: { status: "sent", txHash: r.txHash, vaultNonce: "0" }, agentUri: null };
    },
    upload,
    indexerUrl: null,
    fetchBytes: async (uri) => ipfs.get(uri) ?? null,
  });
  const register = async () => {
    const r = await spend(creator, sender, VAULT_ACTION.REGISTER_AGENT, registerAgentParams(await upload(file as Record<string, unknown>)));
    for (const log of (await client.getTransactionReceipt({ hash: r.txHash })).logs) {
      if (getAddress(log.address) !== creatorVault) continue;
      try {
        const e = decodeEventLog({ abi: ostraVaultAbi, data: log.data, topics: log.topics });
        if (e.eventName === "AgentRegistered") agentId = (e.args as { agentId: bigint }).agentId;
      } catch {
        // another event
      }
    }
    return agentId as bigint;
  };
  return { pad, buyer, vault: getAddress(await buyer.vaultAddress()), creatorVault, register };
}

test("the index serves listed agents ranked with their record, jobs with status and pay, and leaves out what is not a listing", { timeout: 1_200_000 }, async () => {
  const provider = await agent("provider", 51);
  const client = await agent("client", 52);
  await fork.dealUsdg(provider.vault, 10_000_000n);
  await fork.dealUsdg(client.vault, 20_000_000n);
  const agentId = await provider.register();
  await provider.pad.publish([{ id: "token-report", title: "Token report", description: "A report on one token.", input: "The token address.", price: "2", hours: 12, evaluator: "client" }]);
  // An agent registered by a plain account (not an Ostra vault), with a listing naming the provider's vault: left out.
  // A fresh account: anvil's development accounts carry EIP-7702 code on Robinhood Chain, which ERC-721 minting refuses.
  const outsider = privateKeyToAccount(keccak256(stringToHex("OSTRA/INDEXER/PAD-FORK/outsider")));
  await fork.setBalance(outsider.address, 10n ** 18n);
  const outsiderFile = { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "Outsider", services: [padServiceEntry({ provider: provider.vault, offers: [{ id: "copy", title: "Copy", description: "A copy.", input: "x", price: "1", hours: 1, evaluator: "client" }] })] };
  const w = fork.wallet(outsider);
  await fork.client.waitForTransactionReceipt({
    hash: await w.sendTransaction({ account: outsider, chain: null, to: ERC8004_IDENTITY_REGISTRY, data: encodeFunctionData({ abi: [{ type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "", type: "uint256" }] }], functionName: "register", args: [await upload(outsiderFile)] }) }),
  });

  const o = await client.pad.order({ agentId: agentId.toString(), offer: "token-report", input: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" });
  const id = o.jobId as Hex;
  await provider.pad.accept(id);
  await provider.pad.deliver({ jobId: id, output: "A report." });
  await client.pad.decide({ jobId: id, approve: true });

  const index = new PadIndexer({ client: fork.client as PublicClient, deployment: () => d, statePath: join(root, "pad-state.json"), log: () => {}, readFile: readJson });
  await index.sync();
  const l = index.listings();
  assert.equal(l.total, 1, JSON.stringify(l));
  const a = l.agents[0]!;
  assert.equal(a.agentId, agentId.toString());
  assert.equal(a.owner, provider.creatorVault);
  assert.equal(a.provider, provider.vault);
  assert.equal(a.approved, true);
  assert.equal(a.name, "provider");
  assert.deepEqual(a.offers.map((x) => x.id), ["token-report"]);
  assert.equal(a.record?.fixedCompleted, 1);
  assert.equal(a.record?.limit, "5");
  assert.equal(index.listings({ q: "token" }).total, 1);
  assert.equal(index.listings({ q: "nothing like it" }).total, 0);
  assert.equal(index.listings({ provider: provider.vault }).total, 1, "one provider vault's listings");
  assert.equal(index.listings({ provider: client.vault }).total, 0);
  const jobs = index.jobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.id, id);
  assert.equal(jobs[0]?.status, "Completed");
  assert.equal(jobs[0]?.paid, "1.99");
  assert.equal(jobs[0]?.funded, "2");
  assert.equal(index.agent(agentId.toString())?.jobs.length, 1);
  const s = index.stats();
  assert.equal(s.agents, 1, "only the Ostra vault's registration is kept");
  assert.equal(s.completed, 1);
  assert.equal(s.valueCompleted, "1.99");

  // A state written and read back: the same listing.
  const again = new PadIndexer({ client: fork.client as PublicClient, deployment: () => d, statePath: join(root, "pad-state.json"), log: () => {}, readFile: readJson });
  assert.equal(again.listings().total, 1);
});
