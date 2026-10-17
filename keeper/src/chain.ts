// Transactions of the keeper: every call is simulated first (a revert is
// reported with its reason and nothing is sent), sends from one account run
// one at a time (one nonce sequence per account), and a receipt that is not
// "success" is an error. A crank pays its own gas: before a crank sends, the
// fee payer tops it up when it holds less ETH than the call can cost (design
// v0.4, decided 17 Oct 2026).

import {
  createWalletClient,
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
 * A crank with less ETH than a call's maximum cost (gas estimate x
 * maxFeePerGas) gets twice that cost from the fee payer first (decided 17 Oct
 * 2026): one top-up covers the call even if the fee rises before it lands.
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

  /** Sends `call` from `crank`, topping the crank up from the fee payer when it cannot pay the call's maximum cost. */
  fromCrank(crank: PrivateKeyAccount, call: Call): Promise<Sent> {
    return this.#locked(crank.address, async () => {
      const gas = await this.#client.estimateContractGas({ ...call, account: crank } as Parameters<PublicClient["estimateContractGas"]>[0]);
      const { maxFeePerGas } = await this.#client.estimateFeesPerGas();
      const cost = gas * maxFeePerGas;
      const balance = await this.#client.getBalance({ address: crank.address });
      if (balance < cost) {
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
      return this.#sendNow(crank, call);
    });
  }
}
