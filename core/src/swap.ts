// Ostra Swap from the agent's vaults (decided 22 Oct 2026: agents swap through MCP): any pair of the tokens an Ostra
// vault can hold and the relayer serves (USDG, WETH, OSTRA, the listed stock tokens, tokens the Ostra launchpad
// launched), routed through Uniswap v3 and v4 against USDG or WETH by @ostraagent/swap (findRoute), at the fee of the
// vault the output goes to (OstraStake.feeBps: lower with OSTRA locked for it).
//
// A vault can transfer but not approve, so a swap is an escrow order of OstraRouter (an immediate order): the vault
// of the input token signs one Transfer of the input to the order's escrow address (CREATE2 of the order's terms:
// tokens, amount, minOut, recipient, refund address, deadline, route), and the relayer sends that spend together
// with OstraRouter.executeEscrow in one transaction. The router swaps along the route the order names for at least
// minOut, paid to the agent's vault of the output token, or sends the input back to the vault it came from. Nobody
// can change where the tokens go: every term is in the escrow's address.
//
// The order is kept before its spend is signed: a spend that is signed and lands later on its own (the vault sends a
// signed spend again before anything else, maybe days later) leaves the input in the escrow, and finishPending
// executes it (or, past its deadline, has it refunded) once the escrow holds it. A record is dropped only once the
// vault's nonce has passed the signed Transfer and the escrow is empty: the order's terms (its salt among them) are
// what executes or refunds an escrow, and they are kept nowhere else.

import { decodeEventLog, getAddress, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { LAUNCH_PAIRS, VAULT_ACTION, WETH, ostraLaunchpadAbi, signVaultTransfer, transferParams, type LaunchpadDeployment, type RelayCall } from "@ostraagent/sdk";
import {
  ETH,
  PoolIndex,
  escrowAddress,
  executeEscrowData,
  findRoute,
  orderFor,
  orderHash,
  ostraRouterAbi,
  ostraStakeAbi,
  randomSalt,
  type Order,
  type PoolIndexData,
  type Route,
  type SwapDeployment,
} from "@ostraagent/swap";
import { formatUnitsAmount, parseUnitsAmount } from "./amount.ts";
import { chainTime, tokenBalance, tokenDecimals } from "./chain.ts";
import type { Config } from "./config.ts";
import { VAULT_SPEND_GAS, type Sender } from "./relay.ts";
import type { Folder } from "./storage.ts";
import { spendCall, type VaultOperationResult, type VaultService } from "./vault.ts";

/** The folder of Ostra Swap's records: the pool index, and each order until it is finished. */
export const SWAP_DIR = "ostra-swap";
/**
 * Gas an escrow swap is reserved for before it is signed: the vault's Transfer and executeEscrow priced at the gas
 * limit its swap needs (the relayer simulates it; measured on a fork 21 Oct 2026: about 570,000 for one Uniswap leg),
 * with room for two legs through hooks.
 */
export const ESCROW_SWAP_GAS = VAULT_SPEND_GAS + 1_600_000n;
/** Default and largest slippage of a swap, in bps. */
export const DEFAULT_SWAP_SLIPPAGE_BPS = 100;
export const MAX_SWAP_SLIPPAGE_BPS = 1_000;

const POOL_INDEX = "pool-index.json";
const ORDER_PREFIX = "order-";

/** An order sent or about to be, kept until its escrow is finished. */
type OrderRecord = {
  version: 1;
  hash: Hex;
  escrow: Address;
  tokenIn: Address;
  amountIn: string;
  /** The vault nonce the Transfer into the escrow is signed under. */
  vaultNonce: string;
  deadline: string;
  /** OstraRouter.executeEscrow calldata along the order's route. */
  execute: Hex;
  at: number;
};

export type SwapQuote = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  expectedOut: string;
  minOut: string;
  hub: Address;
  feeBps: number;
  fee: string;
  from: Address;
  to: Address;
};

export type OstraSwapResult =
  | (VaultOperationResult & { status: "resent_pending" })
  | { status: "sent"; txHash: Hash; swapped: boolean; amountIn: string; amountOut: string; minOut: string; from: Address; to: Address; note?: string };

/** A swap worked out before anything is signed. */
type Plan = { tokenIn: Address; tokenOut: Address; amountIn: bigint; inDecimals: number; outDecimals: number; from: VaultService; fromVault: Address; to: Address; route: Route };

export type SwapParts = {
  client: PublicClient;
  /** Serves eth_getLogs over the windows the pool index searches (Robinhood Chain's public RPC). */
  logsClient: PublicClient;
  config: Config;
  swap: SwapDeployment;
  /** The agent's vault for a token (the buyer vault for USDG). */
  vaultFor: (token: Address) => VaultService;
  /** Sends what finishes an order (executeEscrow alone), paid like the agent's other requests. */
  sender: Sender;
  folder: Folder;
};

const address = (text: string, what: string): Address => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new RangeError(`${what} is not an address`);
  return getAddress(text);
};

export class SwapService {
  readonly #p: SwapParts;
  #index: PoolIndex | null = null;

  constructor(p: SwapParts) {
    this.#p = p;
  }

  async #poolIndex(): Promise<PoolIndex> {
    if (this.#index !== null) return this.#index;
    const text = await this.#p.folder.read(POOL_INDEX);
    this.#index = new PoolIndex(text === undefined ? undefined : (JSON.parse(text) as PoolIndexData));
    return this.#index;
  }

  async #saveIndex(): Promise<void> {
    if (this.#index !== null) await this.#p.folder.write(POOL_INDEX, JSON.stringify(this.#index.data()));
  }

  /**
   * Refuses a token an Ostra vault cannot hold through the relayer: USDG, WETH, OSTRA, the listed stock tokens and
   * the tokens the Ostra launchpad launched are served (relayer gate.ts), anything else would stay in its vault.
   */
  async checkToken(token: Address): Promise<void> {
    if (token === ETH) throw new RangeError("an Ostra vault holds WETH, not native ETH: swap WETH");
    if (token === this.#p.config.deployment.token || token === WETH) return;
    if (LAUNCH_PAIRS.some((p) => (p.kind === "ostra" || p.kind === "stock") && getAddress(p.address) === token)) return;
    const lp: LaunchpadDeployment | undefined = this.#p.config.deployment.launchpad;
    if (lp !== undefined) {
      const id = (await this.#p.client.readContract({ address: lp.launchpad, abi: ostraLaunchpadAbi, functionName: "poolOf", args: [token] })) as Hex;
      if (BigInt(id) !== 0n) return;
    }
    throw new RangeError(`${token} is not a token an Ostra vault swaps: USDG, WETH, OSTRA, a listed stock token or a token the Ostra launchpad launched`);
  }

  async #plan(a: { tokenIn: string; tokenOut: string; amount: string; slippageBps?: number }): Promise<Plan> {
    const tokenIn = address(a.tokenIn, "tokenIn");
    const tokenOut = address(a.tokenOut, "tokenOut");
    if (tokenIn === tokenOut) throw new RangeError("tokenIn and tokenOut are the same");
    await this.checkToken(tokenIn);
    await this.checkToken(tokenOut);
    const slippageBps = a.slippageBps ?? DEFAULT_SWAP_SLIPPAGE_BPS;
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SWAP_SLIPPAGE_BPS) throw new RangeError(`slippage must be 0 to ${MAX_SWAP_SLIPPAGE_BPS} bps`);
    const [inDecimals, outDecimals] = await Promise.all([tokenDecimals(this.#p.client, tokenIn), tokenDecimals(this.#p.client, tokenOut)]);
    const amountIn = parseUnitsAmount(a.amount, inDecimals);
    if (amountIn === 0n) throw new RangeError("amount must be greater than zero");
    const from = this.#p.vaultFor(tokenIn);
    const to = await this.#p.vaultFor(tokenOut).vaultAddress();
    const fromVault = await from.vaultAddress();
    // The fee is the recipient's: the agent's vault of the output token (OSTRA locked for it lowers it).
    const feeBps = Number(await this.#p.client.readContract({ address: this.#p.swap.stake, abi: ostraStakeAbi, functionName: "feeBps", args: [to] }));
    const index = await this.#poolIndex();
    const route = await findRoute({ client: this.#p.client, logsClient: this.#p.logsClient, index, tokenIn, tokenOut, amountIn, feeBps, slippageBps });
    await this.#saveIndex();
    return { tokenIn, tokenOut, amountIn, inDecimals, outDecimals, from, fromVault, to, route };
  }

  #summary(p: Plan): SwapQuote {
    const r = p.route;
    // The fee is taken in the hub, between the two legs.
    const hubDecimals = r.hub === this.#p.config.deployment.token ? 6 : 18;
    return {
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      amountIn: formatUnitsAmount(p.amountIn, p.inDecimals),
      expectedOut: formatUnitsAmount(r.expectedOut, p.outDecimals),
      minOut: formatUnitsAmount(r.minOut, p.outDecimals),
      hub: r.hub,
      feeBps: r.feeBps,
      fee: formatUnitsAmount(r.fee, hubDecimals),
      from: p.fromVault,
      to: p.to,
    };
  }

  /** The route and amounts a swap from the agent's vault of tokenIn to its vault of tokenOut would take now. Nothing is signed. */
  async quote(a: { tokenIn: string; tokenOut: string; amount: string; slippageBps?: number }): Promise<SwapQuote> {
    return this.#summary(await this.#plan(a));
  }

  /** Swaps `amount` of tokenIn from the agent's vault of it to its vault of tokenOut (see the file comment). */
  async swap(a: { tokenIn: string; tokenOut: string; amount: string; slippageBps?: number }): Promise<OstraSwapResult> {
    const p = await this.#plan(a);
    const s = await p.from.state();
    if (!s.exists && p.from.kind === "buyer") throw new Error("this agent has no vault yet; call open_vault first");
    if (s.balance < p.amountIn) throw new Error(`the vault in ${p.tokenIn} (${p.fromVault}) holds ${formatUnitsAmount(s.balance, p.inDecimals)}, less than ${a.amount}; nothing was signed`);
    if (!s.exists) await p.from.open();
    let order: Order | null = null;
    const result = await p.from.operate({
      gas: ESCROW_SWAP_GAS,
      moves: p.amountIn,
      what: "swap",
      build: async ({ v, vault, keychain, chainId }) => {
        const balance = await tokenBalance(this.#p.client, p.tokenIn, vault);
        if (balance < p.amountIn) throw new Error(`the vault holds ${formatUnitsAmount(balance, p.inDecimals)} now, less than ${a.amount}; nothing was signed`);
        order = orderFor(p.route, vault, p.tokenIn, p.to, await chainTime(this.#p.client), randomSalt());
        const escrow = escrowAddress(this.#p.swap.router, order);
        const execute = executeEscrowData(order, p.route);
        await p.from.checkSpend(VAULT_ACTION.TRANSFER, transferParams({ to: escrow, amount: p.amountIn }), "the swap's transfer to its escrow", this.#p.sender);
        await this.#keep({ version: 1, hash: orderHash(order), escrow, tokenIn: p.tokenIn, amountIn: p.amountIn.toString(), vaultNonce: v.nonce.toString(), deadline: order.deadline.toString(), execute, at: Date.now() });
        const signed = await signVaultTransfer(keychain, v, { chainId, to: escrow, amount: p.amountIn });
        const calls: RelayCall[] = [spendCall(vault, signed), { to: this.#p.swap.router, data: execute }];
        return calls;
      },
    });
    if (result.status !== "sent") return result as OstraSwapResult;
    const placed = order as Order | null;
    if (placed === null) throw new Error("the swap was sent without its order");
    const outcome = await this.#outcome(result.txHash, orderHash(placed));
    await this.#p.folder.remove(`${ORDER_PREFIX}${orderHash(placed)}.json`);
    return {
      status: "sent",
      txHash: result.txHash,
      swapped: outcome.swapped,
      amountIn: formatUnitsAmount(p.amountIn, p.inDecimals),
      amountOut: formatUnitsAmount(outcome.amountOut, p.outDecimals),
      minOut: formatUnitsAmount(p.route.minOut, p.outDecimals),
      from: p.fromVault,
      to: p.to,
      ...(outcome.swapped ? {} : { note: "the swap could not pay its minimum when it ran (the price moved): the input went back to the vault; quote again" }),
    };
  }

  async #keep(r: OrderRecord): Promise<void> {
    await this.#p.folder.ensure();
    await this.#p.folder.write(`${ORDER_PREFIX}${r.hash}.json`, `${JSON.stringify(r)}\n`);
  }

  /** What the order did in `txHash`: its EscrowExecuted and, when it swapped, the router's Swapped. */
  async #outcome(txHash: Hash, hash: Hex): Promise<{ swapped: boolean; amountOut: bigint }> {
    const receipt = await this.#p.client.getTransactionReceipt({ hash: txHash });
    let swapped: boolean | null = null;
    let amountOut = 0n;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== getAddress(this.#p.swap.router)) continue;
      try {
        const e = decodeEventLog({ abi: ostraRouterAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        if (e.eventName === "EscrowExecuted" && (e.args as { orderHash: Hex }).orderHash.toLowerCase() === hash.toLowerCase()) swapped = (e.args as { swapped: boolean }).swapped;
        if (e.eventName === "Swapped") amountOut = (e.args as { amountOut: bigint }).amountOut;
      } catch {
        // another event of the router
      }
    }
    if (swapped === null) throw new Error(`transaction ${txHash} has no EscrowExecuted for order ${hash}`);
    return { swapped, amountOut: swapped ? amountOut : 0n };
  }

  /**
   * Finishes the orders whose escrow was paid without being executed (a signed spend sent again on its own):
   * executeEscrow sends the input along the order's route, or back to its vault past the deadline. Records of orders
   * whose Transfer landed (the vault's nonce is past it) and whose escrow holds less than the order are dropped. Returns what failed.
   */
  async finishPending(): Promise<{ order: Hex; error: string }[]> {
    const failures: { order: Hex; error: string }[] = [];
    for (const name of await this.#p.folder.list()) {
      if (!name.startsWith(ORDER_PREFIX)) continue;
      const text = await this.#p.folder.read(name);
      if (text === undefined) continue;
      const r = JSON.parse(text) as OrderRecord;
      try {
        // The nonce first: read after the escrow, a Transfer landing in between would look executed.
        const nonce = (await this.#p.vaultFor(r.tokenIn).state()).nonce;
        const held = await tokenBalance(this.#p.client, r.tokenIn, r.escrow);
        if (held >= BigInt(r.amountIn)) {
          await this.#p.sender.send([{ to: this.#p.swap.router, data: r.execute }]);
          await this.#p.folder.remove(name);
          continue;
        }
        // Landed and holding less than the order: executed (what is left was sent there by someone else).
        if (nonce !== null && nonce > BigInt(r.vaultNonce)) await this.#p.folder.remove(name);
      } catch (err) {
        failures.push({ order: r.hash, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return failures;
  }
}
