// Sells the fees private spends paid the relayer (private.ts) for ETH, the relayer's gas, every SWEEP_INTERVAL_MS
// (decided 21 Oct 2026). Each token in the ledger's feeTokens the relayer's account holds is sold whole: WETH is
// unwrapped (WETH.withdraw), any other token is sold through OstraRouter.swap to native ETH along the best route now
// (@ostraagent/swap findRoute, at the relayer's own Ostra fee and DEFAULT_SLIPPAGE_BPS), after an approval of exactly
// the amount sold. A sale is skipped while it would bring less than SWEEP_MIN_WEI or less than SWEEP_GAS_MULTIPLE times
// what its transactions cost in gas; the token is tried again on the next sweep. Sales go through the RelaySender, on
// the same nonce sequence as relayed transactions.
//
// The relayer's account never gives agents a way to spend what it holds: no relayed call pulls tokens from the
// relayer (calls.ts allows no OstraRouter.swap, swapAtBaseFee or OstraPrivatePool.shield), and the approvals made here
// are of exactly what the sale that follows spends.

import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { ETH, WETH, findRoute, ostraStakeAbi, walletSwapCall, type PoolIndex } from "@ostraagent/swap";
import type { Log } from "./gate.ts";
import type { Ledger } from "./ledger.ts";
import { NotSentError, SendUnknownError, type Landed } from "./send.ts";
import { wethWithdrawData } from "./private.ts";

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** The least ETH a sale brings (0.0002 ETH). */
export const SWEEP_MIN_WEI = 200_000_000_000_000n;
/** A sale brings at least this many times what its transactions cost in gas. */
export const SWEEP_GAS_MULTIPLE = 4n;
/** Gas counted for an approval and a sale when deciding whether a sale is worth it. */
const APPROVE_GAS = 60_000n;
const SALE_GAS = 600_000n;
const UNWRAP_GAS = 40_000n;

export type SweepOptions = {
  client: PublicClient;
  logsClient: PublicClient;
  index: PoolIndex;
  router: Address;
  stake: Address;
  ledger: Ledger;
  sender: { readonly address: Address; send(tx: { to: Address; data: Hex }, o?: { maxGas?: bigint }): Promise<Landed> };
  log: Log;
  intervalMs?: number;
  /** The least ETH a sale brings (default SWEEP_MIN_WEI). */
  minWei?: bigint;
};

export type SweepResult = { token: Address; amount: bigint; outcome: "sold" | "unwrapped" | "skipped" | "failed"; txHash?: Hex; wei?: bigint; reason?: string };

export class FeeSweeper {
  readonly #o: SweepOptions;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<SweepResult[]> | null = null;

  constructor(o: SweepOptions) {
    this.#o = o;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.sweep().catch((err: unknown) => this.#o.log("sweep_error", { error: (err as Error).message }));
    }, this.#o.intervalMs ?? SWEEP_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One sweep of every fee token (a sweep already running is joined, not started again). */
  sweep(): Promise<SweepResult[]> {
    this.#running ??= this.#sweep().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #sweep(): Promise<SweepResult[]> {
    const tokens = this.#o.ledger.view().feeTokens ?? [];
    const out: SweepResult[] = [];
    for (const t of tokens) {
      const r = await this.#one(getAddress(t)).catch((err: unknown): SweepResult => ({ token: getAddress(t), amount: 0n, outcome: "failed", reason: (err as Error).message }));
      if (r.amount > 0n || r.outcome === "failed") this.#o.log("sweep", { token: r.token, amount: r.amount, outcome: r.outcome, txHash: r.txHash, wei: r.wei, reason: r.reason });
      out.push(r);
    }
    return out;
  }

  async #send(tx: { to: Address; data: Hex }, gas: bigint): Promise<Landed> {
    try {
      return await this.#o.sender.send(tx, { maxGas: gas * 3n });
    } catch (err) {
      if (err instanceof NotSentError || err instanceof SendUnknownError) throw new Error(`${err.name}: ${err.message}`);
      throw err;
    }
  }

  async #one(token: Address): Promise<SweepResult> {
    const { client } = this.#o;
    const me = this.#o.sender.address;
    const amount = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [me] });
    if (amount === 0n) return { token, amount, outcome: "skipped", reason: "none held" };
    const gasPrice = await client.getGasPrice();
    const minWei = this.#o.minWei ?? SWEEP_MIN_WEI;

    if (token === WETH) {
      if (amount < minWei || amount < SWEEP_GAS_MULTIPLE * UNWRAP_GAS * gasPrice) return { token, amount, outcome: "skipped", reason: "too little to unwrap" };
      const landed = await this.#send({ to: WETH, data: wethWithdrawData(amount) }, UNWRAP_GAS);
      return { token, amount, outcome: "unwrapped", txHash: landed.txHash, wei: amount };
    }

    const feeBps = Number(await client.readContract({ address: this.#o.stake, abi: ostraStakeAbi, functionName: "feeBps", args: [me] }));
    const route = await findRoute({ client, logsClient: this.#o.logsClient, index: this.#o.index, tokenIn: token, tokenOut: ETH, amountIn: amount, feeBps });
    const cost = (APPROVE_GAS + SALE_GAS) * gasPrice;
    if (route.minOut < minWei || route.minOut < SWEEP_GAS_MULTIPLE * cost) return { token, amount, outcome: "skipped", reason: `the sale brings ${route.minOut} wei at least` };

    const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [me, this.#o.router] });
    if (allowance !== amount) {
      if (allowance !== 0n) await this.#send({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.#o.router, 0n] }) }, APPROVE_GAS);
      await this.#send({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.#o.router, amount] }) }, APPROVE_GAS);
    }
    const call = walletSwapCall(this.#o.router, route, me);
    const landed = await this.#send({ to: call.to, data: call.data }, SALE_GAS);
    return { token, amount, outcome: "sold", txHash: landed.txHash, wei: route.expectedOut };
  }
}
