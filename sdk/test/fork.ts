// A local fork of Robinhood Chain mainnet for the tests: anvil forks the
// live chain (OSTRA_FORK_RPC, default the public RPC), so USDG,
// x402BatchSettlement, Chainlink and Multicall3 are the deployed contracts,
// and Ostra's contracts are deployed on it with deploy.ts from the Foundry
// build (../out). Accounts are anvil's well-known development keys.

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  numberToHex,
  type Address,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { upgradeableBeaconAbi } from "../src/abi.ts";
import { robinhoodChain } from "../src/chain.ts";
import { ROBINHOOD_PUBLIC_RPC, USDG } from "../src/constants.ts";
import { redact } from "../src/chain.ts";
import { deployLaunchpad, deployOstra } from "../src/deploy.ts";
import type { Deployment } from "../src/deployment.ts";

/** anvil's default development accounts 0..3 (public test keys, never used outside a local fork). */
const DEV_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f5f2b2a8ae56a8a0b82e3d9e0a6c0ce58b",
] as const;

export const OUT_DIR = fileURLToPath(new URL("../../out", import.meta.url));

export type Fork = {
  url: string;
  client: PublicClient;
  accounts: PrivateKeyAccount[];
  wallet: (account: PrivateKeyAccount) => WalletClient;
  /** Sets `holder`'s USDG balance (anvil_dealERC20, the fork equivalent of forge's deal). */
  dealUsdg: (holder: Address, amount: bigint) => Promise<void>;
  /** Sets `holder`'s balance of the ERC-20 `token` (anvil_dealERC20). */
  dealToken: (holder: Address, token: Address, amount: bigint) => Promise<void>;
  /** Sets `holder`'s ETH balance in wei (anvil_setBalance). */
  setBalance: (holder: Address, wei: bigint) => Promise<void>;
  /** Moves the fork's clock forward and mines a block. */
  increaseTime: (seconds: number) => Promise<void>;
  stop: () => Promise<void>;
};

export async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/**
 * Starts the fork: at the latest block, or at `blockNumber` (an older block needs an archive RPC as OSTRA_FORK_RPC:
 * the public RPC keeps only recent state).
 */
export async function startFork(opts: { blockNumber?: bigint } = {}): Promise<Fork> {
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const url = `http://127.0.0.1:${port}`;
  // OSTRA_FORK_RPC may carry an API key (an archive RPC such as Alchemy keeps the fork block's state, which the
  // public RPC drops after some minutes): anvil's errors are passed on line by line with the URL replaced.
  const forkUrl = process.env.OSTRA_FORK_RPC !== undefined && process.env.OSTRA_FORK_RPC !== "" ? process.env.OSTRA_FORK_RPC : ROBINHOOD_PUBLIC_RPC;
  const at = opts.blockNumber === undefined ? [] : ["--fork-block-number", opts.blockNumber.toString()];
  const child: ChildProcess = spawn("anvil", ["--fork-url", forkUrl, ...at, "--port", String(port), "--silent"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let pendingErr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    pendingErr += chunk.toString("utf8");
    const lines = pendingErr.split("\n");
    pendingErr = lines.pop() ?? "";
    for (const line of lines) process.stderr.write(`${redact(line, forkUrl)}\n`);
  });
  child.stderr?.on("end", () => {
    if (pendingErr !== "") process.stderr.write(`${redact(pendingErr, forkUrl)}\n`);
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  // anvil missing from PATH, for example: fail at once instead of waiting.
  let spawnError: Error | undefined;
  child.on("error", (err) => {
    spawnError = err;
    exited = true;
  });
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited) throw new Error(spawnError === undefined ? "anvil exited before the fork was ready" : `anvil could not be started: ${spawnError.message}`);
    try {
      await rpc(url, "eth_chainId", []);
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error("the fork did not start within 90 s");
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const client = createPublicClient({ chain: robinhoodChain, transport: http(url) }) as PublicClient;
  const accounts = DEV_KEYS.map((k) => privateKeyToAccount(k));
  return {
    url,
    client,
    accounts,
    wallet: (account) => createWalletClient({ account, chain: robinhoodChain, transport: http(url) }),
    dealUsdg: async (holder, amount) => {
      await rpc(url, "anvil_dealERC20", [holder, USDG, numberToHex(amount)]);
    },
    dealToken: async (holder, token, amount) => {
      await rpc(url, "anvil_dealERC20", [holder, token, numberToHex(amount)]);
    },
    setBalance: async (holder, wei) => {
      await rpc(url, "anvil_setBalance", [holder, numberToHex(wei)]);
    },
    increaseTime: async (seconds) => {
      await rpc(url, "evm_increaseTime", [seconds]);
      await rpc(url, "evm_mine", []);
    },
    stop: async () => {
      if (exited) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      });
    },
  };
}

/** Deploys Ostra on the fork: account 0 owns the beacons and is the pool authority; account 1 is the treasury. */
export async function deployOnFork(fork: Fork): Promise<Deployment> {
  const [deployer, treasury] = fork.accounts as [PrivateKeyAccount, PrivateKeyAccount];
  return deployOstra({
    publicClient: fork.client,
    walletClient: fork.wallet(deployer),
    outDir: OUT_DIR,
    beaconOwner: deployer.address,
    treasury: treasury.address,
    poolAuthority: deployer.address,
  });
}

/** Deploys the launchpad next to `d` on the fork (deployLaunchpad), owned by account 0. */
export async function deployLaunchpadOnFork(fork: Fork, d: Deployment): Promise<Deployment> {
  const [deployer] = fork.accounts as [PrivateKeyAccount];
  return deployLaunchpad({ publicClient: fork.client, walletClient: fork.wallet(deployer), outDir: OUT_DIR }, d);
}

/**
 * Hands live beacons to `to` on the fork: each beacon's current owner (an
 * account or a contract such as OstraUpgradeOwner) is impersonated and calls
 * transferOwnership. Nothing changes on mainnet.
 */
export async function handBeaconsTo(fork: Fork, beacons: readonly Address[], to: Address): Promise<void> {
  for (const beacon of beacons) {
    const owner = getAddress((await fork.client.readContract({ address: beacon, abi: upgradeableBeaconAbi, functionName: "owner" })) as Address);
    if (owner === getAddress(to)) continue;
    await rpc(fork.url, "anvil_impersonateAccount", [owner]);
    await rpc(fork.url, "anvil_setBalance", [owner, numberToHex(10n ** 18n)]);
    const wallet = createWalletClient({ account: owner, chain: robinhoodChain, transport: http(fork.url) });
    const hash = await wallet.writeContract({ address: beacon, abi: upgradeableBeaconAbi, functionName: "transferOwnership", args: [to], account: owner, chain: robinhoodChain });
    if ((await fork.client.waitForTransactionReceipt({ hash })).status !== "success") throw new Error(`transferOwnership of ${beacon} failed on the fork`);
    await rpc(fork.url, "anvil_stopImpersonatingAccount", [owner]);
  }
}
