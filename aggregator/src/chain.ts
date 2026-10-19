// Reads of the pool and the transaction sender of the aggregator account. As
// in the keeper (keeper/src/chain.ts): every call is simulated first (a
// revert is reported with its reason and nothing is sent), sends run one at a
// time (one nonce sequence), and a receipt that is not "success" is an error.

import { createWalletClient, getAddress, type Abi, type Address, type Hex, type PrivateKeyAccount, type PublicClient, type TransactionReceipt, type Transport } from "viem";
import { DEPOSIT_STATUS, ostraPoolAbi, robinhoodChain, type DepositState } from "@ostraagent/sdk";

/** A contract call: what the aggregator sends. */
export type Call = { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };

export class Sender {
  readonly #client: PublicClient;
  readonly #transport: Transport;
  readonly #account: PrivateKeyAccount;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(client: PublicClient, transport: Transport, account: PrivateKeyAccount) {
    this.#client = client;
    this.#transport = transport;
    this.#account = account;
  }

  get address(): Address {
    return this.#account.address;
  }

  /** Simulates `call` from the aggregator account, sends it after every earlier send has finished, and waits for its receipt. */
  send(call: Call): Promise<TransactionReceipt> {
    const run = async () => {
      const { request } = await this.#client.simulateContract({ ...call, account: this.#account } as Parameters<PublicClient["simulateContract"]>[0]);
      const wallet = createWalletClient({ account: this.#account, chain: robinhoodChain, transport: this.#transport });
      const hash = await wallet.writeContract(request as Parameters<typeof wallet.writeContract>[0]);
      const receipt = await this.#client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${call.functionName} transaction ${hash} reverted`);
      return receipt;
    };
    const next = this.#queue.catch(() => undefined).then(run);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

/** The deposits under `keys` in one multicall, in order (status "none" for a key without a deposit). */
export async function readDeposits(client: PublicClient, pool: Address, keys: readonly Hex[]): Promise<DepositState[]> {
  if (keys.length === 0) return [];
  const results = await client.multicall({
    contracts: keys.map((key) => ({ address: pool, abi: ostraPoolAbi, functionName: "getDeposit" as const, args: [key] as const })),
    allowFailure: false,
  });
  return results.map((d, i) => {
    const status = DEPOSIT_STATUS[d.status];
    if (status === undefined) throw new Error(`unknown deposit status ${d.status}`);
    return {
      key: keys[i] as Hex,
      status,
      createdAt: d.createdAt,
      amount: d.amount,
      refundOwner: getAddress(d.refundOwner),
      approvedBatch: d.approvedBatch === 0n ? null : d.approvedBatch - 1n,
      approvalKeyRoot: d.approvalKeyRoot,
      approvedState: /^0x0{64}$/.test(d.approvedState) ? null : d.approvedState,
    };
  });
}
