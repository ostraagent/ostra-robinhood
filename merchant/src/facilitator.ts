// This seller server's own x402 facilitator (design v0.4: the facilitator is
// run by Ostra itself; no public facilitator serves batch-settlement on
// Robinhood Chain). It is the stock @x402/evm batch-settlement facilitator,
// in-process:
//   * /verify of vouchers and refunds: read-only (signature and on-chain
//     channel state through Multicall3);
//   * /settle of deposits: x402BatchSettlement.deposit with the buyer's
//     EIP-3009 (or Permit2) authorization, sent from the facilitator key
//     (keys.ts facilitator.key), which pays the gas.
// It is given no receiver-authorizer key, so it advertises none and never
// signs claims or refunds (an Ostra vault authorizes those through its crank).

import { createWalletClient, type Address, type PrivateKeyAccount, type PublicClient, type Transport } from "viem";
import { robinhoodChain } from "@ostraagent/sdk";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme as BatchSettlementFacilitatorScheme } from "@x402/evm/batch-settlement/facilitator";

/** CAIP-2 id of Robinhood Chain. */
export const X402_NETWORK = `eip155:${robinhoodChain.id}` as const;

/** Gas limit = estimate + 20% (decided 17 Oct 2026, as relayer/src/send.ts and core/src/chain.ts): the L1 component of an estimate moves with the L1 price; unused gas is not paid. */
export const GAS_LIMIT_MARGIN_PERCENT = 20n;
const withMargin = (gas: bigint): bigint => gas + (gas * GAS_LIMIT_MARGIN_PERCENT) / 100n;

/** An x402 facilitator client served in-process by the stock batch-settlement facilitator. */
export function createFacilitator(client: PublicClient, transport: Transport, account: PrivateKeyAccount): FacilitatorClient & { address: Address } {
  const wallet = createWalletClient({ account, chain: robinhoodChain, transport });
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args) => client.readContract(args as Parameters<PublicClient["readContract"]>[0]),
    verifyTypedData: (args) => client.verifyTypedData(args as Parameters<PublicClient["verifyTypedData"]>[0]),
    // The gas limit x402 gives is kept; otherwise it is the estimate plus GAS_LIMIT_MARGIN_PERCENT.
    writeContract: async (args) => {
      const gas = args.gas ?? withMargin(await client.estimateContractGas({ ...args, account: account.address } as Parameters<PublicClient["estimateContractGas"]>[0]));
      return wallet.writeContract({ ...(args as Parameters<typeof wallet.writeContract>[0]), gas, account, chain: robinhoodChain });
    },
    sendTransaction: async (args) => {
      const given = (args as { gas?: bigint }).gas;
      const gas = given ?? withMargin(await client.estimateGas({ account: account.address, to: args.to, data: args.data }));
      return wallet.sendTransaction({ ...args, gas, account, chain: robinhoodChain });
    },
    waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
    getCode: (args) => client.getCode(args),
  });
  const facilitator = new x402Facilitator().register(X402_NETWORK, new BatchSettlementFacilitatorScheme(signer));
  return {
    address: account.address,
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    // The same kinds, with the network typed as CAIP-2 (x402Facilitator.getSupported types it as string).
    getSupported: () => Promise.resolve(facilitator.getSupported() as SupportedResponse),
  };
}
