// Ostra Swap of any ERC-20 from an agent's vaults (MCP 0.1.20) through the core services, on a fork of Robinhood
// Chain mainnet pinned at FORK_BLOCK (an archive RPC as OSTRA_FORK_RPC), against the live OstraRouter (ostra-swap's
// deployments/robinhood-mainnet.json) and real tokens, with Ostra deployed fresh and the agent's own fee payer
// sending (LocalSender):
//   * a token that is not USDG, WETH, OSTRA, a listed stock token or a launched one, whose only pool is a hookless
//     native ETH pool of Uniswap v4, passes the token check: quoted, bought from the USDG vault into the agent's vault
//     of it (token_vault shows its balance, no dividends), and sold back from there into the USDG vault;
//   * a token whose pools take over MAX_HOOKLESS_V4_FEE of every swap is refused before anything is signed, with the
//     check's reason, and the USDG vault's nonce does not move;
//   * selling is never held to the check: checkToken passes any token sold but native ETH.
// The pool index is searched from the public RPC (the fork's history), as an agent's first swap does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createPublicClient, formatUnits, getAddress, http, keccak256, parseUnits, stringToHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, USDG, retryingHttp, robinhoodChain, usdgAbi, type Deployment } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { ETH, parseSwapDeployment, type SwapDeployment } from "@ostraagent/swap";
import { Keys, LaunchpadService, LocalSender, SwapService, VaultService, X402_NETWORK, type Config } from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";
import { splitLogsClient } from "./split-logs.ts";

const SWAP: SwapDeployment = parseSwapDeployment(JSON.parse(readFileSync(new URL("../../../ostra-swap/deployments/robinhood-mainnet.json", import.meta.url), "utf8")));
/** The block the fork is pinned at (5 Nov 2026), where the tokens below are as described. */
const FORK_BLOCK = 106_774_787n;
/** Its one pool: native ETH / token, hookless, 1% fee (ostra-swap sdk/test/tokencheck.fork.test.ts). */
const OTHER: Address = "0xf858011999Dfb3c82Dd7b11e65b1b73579b1F515";
/** Its pools that hold liquidity take 85.563% (native ETH) and 99.0099% (USDG) of every swap. */
const TRAP_FEE_TOKEN: Address = "0x85EA47E3B981279E237BdD5953e91E4e79ECB909";

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
let forkBlock: bigint;
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/SWAP-ANY-TOKEN-FORK/fee-payer")));
/** Quotes read many pools in one call, which a fork fetches slot by slot from its upstream the first time. */
const quoteClient = () => createPublicClient({ chain: robinhoodChain, transport: http(fork.url, { timeout: 300_000 }) }) as PublicClient;
const balanceOf = (token: Address, who: Address) => fork.client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
/** A block mined now: an escrow order's deadline counts from the latest block's time, and anvil mines only for a transaction. */
const blockNow = () => fork.increaseTime(0);

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-core-swap-any-"));
  fork = await startFork({ blockNumber: FORK_BLOCK });
  forkBlock = await fork.client.getBlockNumber({ cacheTime: 0 });
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

function agent(name: string, seed: number) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder: new MemoryFolder(), backupExported: async () => true });
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const tokenVaults = new Map<Address, VaultService>();
  const tokenVault = (token: Address) => {
    const t = getAddress(token);
    if (t === getAddress(USDG)) return buyer;
    let v = tokenVaults.get(t);
    if (v === undefined) {
      v = new VaultService(client, transport, config, keys, sender, "token", null, t);
      tokenVaults.set(t, v);
    }
    return v;
  };
  const swap = new SwapService({ client: quoteClient(), logsClient: splitLogsClient(fork.url, forkBlock), config, swap: SWAP, vaultFor: tokenVault, sender, folder: keys.folder.folder("ostra-swap") });
  return { keys, buyer, tokenVault, swap, sender, client, transport };
}

test("a token that passes the check: quoted, bought into its own vault, shown by token_vault, sold back", { timeout: 2_400_000 }, async () => {
  const a = agent("buyer", 51);
  const usdgVault = (await a.buyer.open()).vault;
  await fork.dealUsdg(usdgVault, parseUnits("50", 6));
  const quoted = await a.swap.quote({ tokenIn: USDG, tokenOut: OTHER, amount: "10" });
  assert.ok(parseUnits(quoted.expectedOut, 18) > 0n, JSON.stringify(quoted));
  await blockNow();
  const bought = await a.swap.swap({ tokenIn: USDG, tokenOut: OTHER, amount: "10" });
  assert.ok(bought.status === "sent" && bought.swapped, JSON.stringify(bought));
  const otherVault = getAddress(await a.tokenVault(OTHER).vaultAddress());
  const held = await balanceOf(OTHER, otherVault);
  assert.equal(held, parseUnits(bought.amountOut, 18));
  assert.ok(held >= parseUnits(bought.minOut, 18));
  assert.equal(await balanceOf(USDG, usdgVault), parseUnits("40", 6));

  // token_vault: any token's vault, its balance in the token's decimals, no dividends.
  const creator = new VaultService(a.client, a.transport, config, await a.keys.forCreatorVault(d.chainId, USDG), a.sender, "creator");
  const lp = new LaunchpadService({ client: a.client, transport: a.transport, config, keys: a.keys, buyer: a.buyer, buyerSender: a.sender, creator, creatorSender: a.sender });
  const info = await lp.tokenVaultInfo(OTHER);
  assert.equal(info.vault, otherVault);
  assert.equal(info.exists, false, "tokens arrive at the vault's address before the vault is created");
  assert.equal(info.balance, formatUnits(held, 18));
  assert.equal(info.dividends, null);

  // Sold back: the token vault is created and its Transfer funds the escrow order.
  await blockNow();
  const sold = await a.swap.swap({ tokenIn: OTHER, tokenOut: USDG, amount: formatUnits(held, 18) });
  assert.ok(sold.status === "sent" && sold.swapped, JSON.stringify(sold));
  assert.equal(await balanceOf(OTHER, otherVault), 0n);
  assert.equal(await balanceOf(USDG, usdgVault), parseUnits("40", 6) + parseUnits(sold.amountOut, 6));
  assert.equal((await lp.tokenVaultInfo(OTHER)).exists, true);
});

test("a token the check refuses is not bought and nothing is signed; selling is never held to the check", { timeout: 2_400_000 }, async () => {
  const a = agent("refused", 52);
  const usdgVault = (await a.buyer.open()).vault;
  await fork.dealUsdg(usdgVault, parseUnits("5", 6));
  const nonce = (await a.buyer.state()).nonce;
  await assert.rejects(a.swap.quote({ tokenIn: USDG, tokenOut: TRAP_FEE_TOKEN, amount: "1" }), new RegExp(`${getAddress(TRAP_FEE_TOKEN)} is not a token Ostra Swap buys: .*no Uniswap v3 or v4 pool.*; nothing was signed`));
  await assert.rejects(a.swap.swap({ tokenIn: USDG, tokenOut: TRAP_FEE_TOKEN, amount: "1" }), /is not a token Ostra Swap buys/);
  assert.equal((await a.buyer.state()).nonce, nonce, "nothing was signed");
  assert.equal(await balanceOf(USDG, usdgVault), parseUnits("5", 6));
  // A token sold is what a vault holds: no check (its route decides); native ETH is refused either way.
  await a.swap.checkToken(getAddress(TRAP_FEE_TOKEN), "sell");
  await assert.rejects(a.swap.checkToken(ETH, "sell"), /holds WETH, not native ETH/);
});
