// publish_profile (LaunchpadService.publishProfile) carrying on after a call that stopped, on a fork of Robinhood Chain
// mainnet with Ostra deployed fresh (version 3 vaults) and the live ERC-8004 Identity Registry, the agent's own fee
// payer sending (LocalSender), and the Ostra uploader's files pinned on IPFS for real: the uploader run on this machine
// (the release run's copy at 127.0.0.1, with Pinata's key) named by OSTRA_IPFS_GATEWAYS, and OSTRA_IPFS_LIVE=1.
//   * The first call stops after the creator vault signed the profile spend (the process stopped before sending it):
//     nothing is registered and the signed spend is kept.
//   * The second call sends that kept spend first (resent_pending), then registers the agent with Ostra's profile and
//     publishes its numbered profile, all in that one call (before 0.1.13 it stopped after the resent spend and only
//     the next call registered): the identity points at the numbered profile and OstraRegistry holds it.
//   * A call that stops after the registration spend was signed: the next call's profile spend sends that kept
//     registration, which is read from its receipt (agent id, and the file it registered with from the Identity
//     Registry's event), and the numbered profile follows. With agent.json gone and the logs RPC behind the chain RPC,
//     the next call waits for the logs RPC to reach the chain's head and finds the registration: the agent is never
//     registered twice (before 0.1.13 the search ended at the logs RPC's own head, missed it, and registered again).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createPublicClient, custom, keccak256, parseAbi, stringToHex, type Address, type Hash, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC8004_IDENTITY_REGISTRY, FileWotsStore, USDG, VAULT_ACTION, retryingHttp, robinhoodChain, type Deployment, type RelayCall } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { Keys, LAUNCHPAD_DIR, LaunchpadService, LocalSender, VaultService, X402_NETWORK, type Config, type Reservation, type Sender, type SendOptions } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";
import { splitLogsClient } from "./split-logs.ts";

// The uploader: the first OSTRA_IPFS_GATEWAYS entry when it is a local uploader's /v1/ipfs/ and OSTRA_IPFS_LIVE=1.
const firstGateway = (process.env.OSTRA_IPFS_GATEWAYS ?? "").split(",")[0]?.trim() ?? "";
const uploader = process.env.OSTRA_IPFS_LIVE === "1" && /^http:\/\/127\.0\.0\.1:[0-9]+\/v1\/ipfs\/$/.test(firstGateway) ? firstGateway.replace(/\/v1\/ipfs\/$/, "") : null;
const skip = uploader === null ? "needs OSTRA_IPFS_LIVE=1 and OSTRA_IPFS_GATEWAYS naming a local Ostra uploader (http://127.0.0.1:<port>/v1/ipfs/), which pins on IPFS" : false;

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
let forkBlock: bigint;

const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/PUBLISH-FORK/fee-payer")));
const identityAbi = parseAbi(["function tokenURI(uint256 tokenId) view returns (string)", "function ownerOf(uint256 tokenId) view returns (address)", "function balanceOf(address owner) view returns (uint256)"]);

/** A sender that fails its next send without sending, when armed: the process stopped after the spend was signed. */
class StopOnce implements Sender {
  readonly relayed = false;
  readonly #inner: Sender;
  armed = false;
  /** Sends this many first, then fails the next one (when armed). */
  skip = 0;
  constructor(inner: Sender) {
    this.#inner = inner;
  }
  payer(): Promise<Address> {
    return this.#inner.payer();
  }
  async send(calls: RelayCall[], options?: SendOptions): Promise<Hash> {
    if (this.armed) {
      if (this.skip > 0) this.skip--;
      else {
        this.armed = false;
        throw new Error("stopped before sending");
      }
    }
    return this.#inner.send(calls, options);
  }
  reserve(): Promise<Reservation | null> {
    return Promise.resolve(null);
  }
  release(): void {}
}

before(async () => {
  if (skip !== false) return;
  root = await mkdtemp(join(tmpdir(), "ostra-core-publish-"));
  fork = await startFork();
  forkBlock = await fork.client.getBlockNumber({ cacheTime: 0 });
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: uploader, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

test("publish_profile after a call that stopped with the profile spend signed: one call sends it, registers the agent and publishes its numbered profile", { skip, timeout: 900_000 }, async () => {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const folder = new MemoryFolder();
  const keys = new Keys({ master: new Uint8Array(32).fill(91), feePayer, store: new FileWotsStore(join(root, "agent")), folder, backupExported: async () => true });
  const sender = new LocalSender(client, transport, feePayer);
  const flaky = new StopOnce(sender);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, await keys.forCreatorVault(d.chainId, USDG), flaky, "creator");
  const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: sender, creator, creatorSender: flaky });
  const recorded = async () => {
    const t = await keys.folder.folder(LAUNCHPAD_DIR).read("agent.json");
    return t === undefined ? null : (JSON.parse(t) as { agentId: string; uri: string });
  };

  const vault = (await buyer.open()).vault;
  await fork.dealUsdg(vault, 20_000_000n);
  await lp.fundCreatorVault("5");
  const creatorVault = await creator.vaultAddress();
  const nonceBefore = (await creator.state()).nonce;

  // The first call stops after the profile spend was signed: nothing registered, the signed spend kept.
  flaky.armed = true;
  await assert.rejects(lp.publishProfile(), /stopped before sending/);
  assert.equal(await recorded(), null);
  assert.notEqual((await creator.spendSlot())?.pending ?? null, null);
  assert.equal((await creator.state()).nonce, nonceBefore);

  // The next call: the kept spend first, then the registration and the numbered profile, in this one call.
  const r = await lp.publishProfile();
  assert.equal(r.unnumbered?.profile.status, "resent_pending", JSON.stringify(r.unnumbered));
  assert.equal(r.registration?.status, "sent", JSON.stringify(r.registration));
  assert.ok(r.agentId !== null && /^[0-9]+$/.test(r.agentId), `agentId ${r.agentId}`);
  assert.equal(r.profile.status, "sent");
  assert.equal(r.agentUri?.status, "sent");
  const rec = await recorded();
  assert.equal(rec?.agentId, r.agentId);

  // On chain: the creator vault owns the identity, which points at the numbered profile; OstraRegistry holds it too.
  const id = BigInt(r.agentId);
  assert.equal((await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityAbi, functionName: "ownerOf", args: [id] })).toLowerCase(), creatorVault.toLowerCase());
  assert.equal(await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityAbi, functionName: "tokenURI", args: [id] }), r.uri);
  const p = await lp.profile();
  assert.equal(p.profileUri, r.uri);
  assert.equal(p.agentId, r.agentId);
  assert.equal((p.profile as { name?: unknown }).name, `Ostra Agent #${r.agentId}`);

  // Called again: registered already, the same profile published again (no second registration).
  const again = await lp.publishProfile();
  assert.equal(again.agentId, r.agentId);
  assert.equal(again.registration, null);
  assert.equal(again.profile.status, "sent");
});

test("publish_profile after a call that stopped with the registration signed, then with agent.json gone and the logs RPC behind: registered once", { skip, timeout: 900_000 }, async () => {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  // The logs RPC: the chain's history from the public RPC and the fork's own blocks from the fork (split-logs.ts),
  // its head reported 10 blocks behind the fork's for the first few reads once `behind` is set (a logs RPC that lags).
  const split = splitLogsClient(fork.url, forkBlock);
  let behind = 0;
  const logsClient = createPublicClient({
    chain: robinhoodChain,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        const real = await split.request({ method, params } as never);
        if (method === "eth_blockNumber" && behind > 0) {
          behind--;
          return `0x${(BigInt(real as string) - 10n).toString(16)}`;
        }
        return real;
      },
    }),
  }) as PublicClient;
  const folder = new MemoryFolder();
  const keys = new Keys({ master: new Uint8Array(32).fill(92), feePayer, store: new FileWotsStore(join(root, "agent-2")), folder, backupExported: async () => true });
  const sender = new LocalSender(client, transport, feePayer);
  const flaky = new StopOnce(sender);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, await keys.forCreatorVault(d.chainId, USDG), flaky, "creator");
  const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: sender, creator, creatorSender: flaky, logsClient });
  const launchpadFolder = keys.folder.folder(LAUNCHPAD_DIR);
  const recorded = async () => {
    const t = await launchpadFolder.read("agent.json");
    return t === undefined ? null : (JSON.parse(t) as { agentId: string; uri: string });
  };

  const vault = (await buyer.open()).vault;
  await fork.dealUsdg(vault, 20_000_000n);
  await lp.fundCreatorVault("5");
  const creatorVault = await creator.vaultAddress();
  const identities = async () => (await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityAbi, functionName: "balanceOf", args: [creatorVault] })) as bigint;

  // The first call: the profile without a number is set, then it stops after the registration was signed.
  flaky.armed = true;
  flaky.skip = 1;
  await assert.rejects(lp.publishProfile(), /stopped before sending/);
  assert.equal(await recorded(), null);
  assert.equal((await creator.spendSlot())?.pending?.action, VAULT_ACTION.REGISTER_AGENT);
  assert.equal(await identities(), 0n);

  // The next call: its profile spend sends the kept registration, read from the receipt; the numbered profile follows.
  const r = await lp.publishProfile();
  assert.equal(r.unnumbered?.profile.status, "resent_pending", JSON.stringify(r.unnumbered));
  assert.equal(r.registration, null);
  assert.ok(r.agentId !== null && /^[0-9]+$/.test(r.agentId), `agentId ${r.agentId}`);
  assert.equal(r.profile.status, "sent");
  assert.equal(r.agentUri?.status, "sent");
  assert.equal((await recorded())?.agentId, r.agentId);
  assert.equal(await identities(), 1n);
  const id = BigInt(r.agentId);
  assert.equal(await client.readContract({ address: ERC8004_IDENTITY_REGISTRY, abi: identityAbi, functionName: "tokenURI", args: [id] }), r.uri);

  // agent.json gone and the logs RPC behind: the call waits for it, finds the registration, and registers nothing.
  await launchpadFolder.remove("agent.json");
  behind = 3;
  const again = await lp.publishProfile();
  assert.equal(await identities(), 1n, "registered once");
  assert.equal(again.registration, null);
  assert.equal(again.agentId, r.agentId);
  assert.equal(again.profile.status, "sent");
  assert.equal(behind, 0, "the logs RPC was read until it reached the chain's head");
  assert.equal((await recorded())?.agentId, r.agentId);
});
