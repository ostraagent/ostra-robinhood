// Channel records for the unit tests, in the shape the x402 server scheme stores.

import { keccak256, stringToHex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDG } from "@ostraagent/sdk";
import type { Channel } from "@x402/evm/batch-settlement/server";

export const address = (name: string): Address => privateKeyToAccount(keccak256(stringToHex(name))).address;

export function channelRecord(name: string, over: Partial<Channel> = {}): Channel {
  return {
    channelId: keccak256(stringToHex(`channel ${name}`)),
    channelConfig: {
      payer: address(`payer ${name}`),
      payerAuthorizer: address(`session ${name}`),
      receiver: address("split"),
      receiverAuthorizer: address("seller vault"),
      token: USDG,
      withdrawDelay: 900,
      salt: keccak256(stringToHex(`salt ${name}`)),
    },
    chargedCumulativeAmount: "0",
    signedMaxClaimable: "0",
    signature: "",
    balance: "2000000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    onchainSyncedAt: 1_800_000_000_000,
    lastRequestTimestamp: 1_800_000_000_000,
    ...over,
  };
}
