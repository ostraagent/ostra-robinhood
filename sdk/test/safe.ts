// A real Safe (1.4.1, SafeL2, one owner, threshold 1, the compatibility
// fallback handler) made on a fork with the Safe contracts deployed on
// Robinhood Chain: what the tests use as a withdrawal address, which vault
// version 5 requires to have code (test/utils/SafeWallet.sol is the same for
// the Foundry tests).

import { encodeFunctionData, getAddress, parseAbi, zeroAddress, type Address, type PrivateKeyAccount } from "viem";
import type { Fork } from "./fork.ts";

export const SAFE_PROXY_FACTORY: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
export const SAFE_L2: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
export const SAFE_FALLBACK_HANDLER: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";

const factoryAbi = parseAbi(["function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)"]);
const safeAbi = parseAbi([
  "function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
]);

/** Makes a Safe owned by `owner` (salt `salt`), sent from `from`; returns its address, which has code. */
export async function createSafe(fork: Fork, from: PrivateKeyAccount, owner: Address, salt: bigint): Promise<Address> {
  const initializer = encodeFunctionData({ abi: safeAbi, functionName: "setup", args: [[owner], 1n, zeroAddress, "0x", SAFE_FALLBACK_HANDLER, zeroAddress, 0n, zeroAddress] });
  const { request, result } = await fork.client.simulateContract({ address: SAFE_PROXY_FACTORY, abi: factoryAbi, functionName: "createProxyWithNonce", args: [SAFE_L2, initializer, salt], account: from });
  const hash = await fork.wallet(from).writeContract(request);
  const receipt = await fork.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("the Safe was not created");
  const safe = getAddress(result);
  const code = await fork.client.getCode({ address: safe });
  if (code === undefined || code === "0x") throw new Error(`no Safe at ${safe}`);
  return safe;
}
