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
  http,
  numberToHex,
  type Address,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain } from "../src/chain.ts";
import { ROBINHOOD_PUBLIC_RPC, USDG } from "../src/constants.ts";
import { deployOstra } from "../src/deploy.ts";
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
  /** Moves the fork's clock forward and mines a block. */
  increaseTime: (seconds: number) => Promise<void>;
  stop: () => Promise<void>;
};

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export async function startFork(): Promise<Fork> {
  const port = 20_000 + Math.floor(Math.random() * 30_000);
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn("anvil", ["--fork-url", process.env.OSTRA_FORK_RPC ?? ROBINHOOD_PUBLIC_RPC, "--port", String(port), "--silent"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited) throw new Error("anvil exited before the fork was ready");
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
