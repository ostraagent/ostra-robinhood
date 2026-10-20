// ABIs of the deployed contracts Ostra uses but did not write, limited to the
// functions the SDK and the services call. Every entry is exercised against
// the contract on chain 4663 by the fork tests.

import { parseAbi } from "viem";

/** USDG: ERC-20, EIP-3009 (v, r, s form) and the asset protection freeze check. */
export const usdgAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function isFrozen(address account) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Chainlink AggregatorV3Interface. */
export const chainlinkAggregatorAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/**
 * The parts of the Pons bonding curve (OSTRA_PONS_CURVE) Ostra uses, each checked against the deployed curve by
 * eth_call on chain 4663 on 20 Oct 2026 (selectors in its code, results, reverts). getReserves is the curve's virtual-plus-real ETH reserve and
 * its token reserve (tokenReserve()), and buy is constant product on them: a buy of x wei gets
 * y·T / (E + y) tokens, y = x less the curve's fees of 3% in all (exact for amounts in whole hundreds of wei, measured
 * at 0.0001, 0.1 and 1 ETH; other amounts round the fee up by a few wei). buy takes exactly msg.value == ethIn and
 * reverts below minTokensOut; the tokens go to `recipient`.
 */
export const ponsCurveAbi = parseAbi([
  "function token() view returns (address)",
  "function graduated() view returns (bool)",
  "function graduationThreshold() view returns (uint256)",
  "function getReserves() view returns (uint256 ethReserve, uint256 tokenReserve)",
  "function buy(uint256 ethIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
]);

/** Multicall3 aggregate3. */
export const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

/** Arbitrum NodeInterface (a virtual contract: callable with eth_call / eth_estimateGas only). */
export const nodeInterfaceAbi = parseAbi([
  "function gasEstimateComponents(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimate, uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);
