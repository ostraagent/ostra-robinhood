// Transactions of the keeper: every call is simulated first (a revert is
// reported with its reason and nothing is sent), sends from one account run
// one at a time (one nonce sequence per account), and a receipt that is not
// "success" is an error. A crank pays its own gas: before a crank sends, the
// fee payer tops it up when it holds less ETH than the call can cost (design
// v0.4, decided 17 Oct 2026).

import {
  createWalletClient,
  encodeFunctionData,
  formatEther,
  type Abi,
  type Address,
  type Hash,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
} from "viem";
import { robinhoodChain } from "@ostraagent/sdk";

/** A contract call: what the keeper sends. */
export type Call = { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };

export type Sent = { hash: Hash; gasUsed: bigint };

/**
 * A crank with less ETH than a call's maximum cost (the transaction's
 * estimated gas x maxFeePerGas) gets twice that cost from the fee payer
 * first (decided 17 Oct 2026): the call is signed with that maxFeePerGas,
 * and the extra covers the crank's next calls even if the fee rises.
 */
export const CRANK_TOP_UP_FACTOR = 2n;

export class Sender {
  readonly #client: PublicClient;
  readonly #transport: Transport;
  readonly #feePayer: PrivateKeyAccount;
  readonly #locks = new Map<Address, Promise<unknown>>();
  readonly #log: (event: string, fields: Record<string, unknown>) => void;

  constructor(client: PublicClient, transport: Transport, feePayer: PrivateKeyAccount, log: (event: string, fields: Record<string, unknown>) => void) {
    this.#client = client;
    this.#transport = transport;
    this.#feePayer = feePayer;
    this.#log = log;
  }

  /** Runs `work` after every earlier send of `account` has finished. */
  #locked<T>(account: Address, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(account) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const tail = next.catch(() => undefined);
    this.#locks.set(account, tail);
    void tail.then(() => {
      if (this.#locks.get(account) === tail) this.#locks.delete(account);
    });
    return next;
  }

  async #sendNow(account: PrivateKeyAccount, call: Call): Promise<Sent> {
    const { request } = await this.#client.simulateContract({ ...call, account } as Parameters<PublicClient["simulateContract"]>[0]);
    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: this.#transport });
    const hash = await wallet.writeContract(request as Parameters<typeof wallet.writeContract>[0]);
    const receipt = await this.#client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${call.functionName} transaction ${hash} reverted`);
    return { hash, gasUsed: receipt.gasUsed };
  }

  /** Sends `call` from the fee payer. */
  fromFeePayer(call: Call): Promise<Sent> {
    return this.#locked(this.#feePayer.address, () => this.#sendNow(this.#feePayer, call));
  }

  /** Tops `crank` up from the fee payer with CRANK_TOP_UP_FACTOR x `cost` when it holds less than `cost`. */
  async #topUp(crank: PrivateKeyAccount, cost: bigint): Promise<void> {
    if ((await this.#client.getBalance({ address: crank.address })) >= cost) return;
    const value = cost * CRANK_TOP_UP_FACTOR;
    const hash = await this.#locked(this.#feePayer.address, async () => {
      const wallet = createWalletClient({ account: this.#feePayer, chain: robinhoodChain, transport: this.#transport });
      const sent = await wallet.sendTransaction({ to: crank.address, value });
      const receipt = await this.#client.waitForTransactionReceipt({ hash: sent });
      if (receipt.status !== "success") throw new Error(`crank top-up ${sent} reverted`);
      return sent;
    });
    this.#log("crank_topped_up", { crank: crank.address, eth: formatEther(value), tx: hash });
  }

  /**
   * Sends `call` from `crank`, topping the crank up from the fee payer when it cannot pay the call's maximum cost.
   * The call is simulated first (a revert is reported with its reason; nothing is topped up or sent). Its gas is then
   * estimated with no fee given: a node checks that the sender can pay gas x fee only when a fee is given, so a crank
   * with no ETH (a new one, or one its sends used up) could otherwise never be estimated, and so never topped up
   * (seen on mainnet 22 Oct 2026: "insufficient funds for transfer"). The transaction is built here from that gas and
   * the current fees (no further estimate that checks the balance), the crank is topped up when it holds less than
   * gas x maxFeePerGas, and that exact transaction is signed and sent.
   */
  fromCrank(crank: PrivateKeyAccount, call: Call): Promise<Sent> {
    return this.#locked(crank.address, async () => {
      await this.#client.simulateContract({ ...call, account: crank } as Parameters<PublicClient["simulateContract"]>[0]);
      const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as Parameters<typeof encodeFunctionData>[0]);
      const estimated = await this.#client.estimateGas({ account: crank.address, to: call.address, data, prepare: false });
      const { maxFeePerGas, maxPriorityFeePerGas } = await this.#client.estimateFeesPerGas({ chain: robinhoodChain, type: "eip1559" });
      await this.#topUp(crank, estimated * maxFeePerGas);
      const nonce = await this.#client.getTransactionCount({ address: crank.address, blockTag: "pending" });
      const wallet = createWalletClient({ account: crank, chain: robinhoodChain, transport: this.#transport });
      const serializedTransaction = await wallet.signTransaction({
        to: call.address,
        data,
        gas: estimated,
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce,
        type: "eip1559",
        chain: robinhoodChain,
      });
      const hash = await wallet.sendRawTransaction({ serializedTransaction });
      const receipt = await this.#client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${call.functionName} transaction ${hash} reverted`);
      return { hash, gasUsed: receipt.gasUsed };
    });
  }
}
