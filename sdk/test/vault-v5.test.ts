// Version 5's encoders, the agent key's message and the relay gas rules for its spends (vault-v5.ts, relayer.ts),
// without a chain: what OstraVaultModuleV5 refuses is refused before anything is signed. Against the deployed code in
// vault-v5.fork.test.ts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, padHex, toFunctionSelector, zeroAddress, type Hex, type Log } from "viem";
import { ostraVaultAbi, ostraVaultModuleV5Abi } from "../src/abi.ts";
import { ALLOW_KIND, GUARD_OP, ORDER_KIND, RAETO_USDG_VAULT, ROBINHOOD_CHAIN_ID, VAULT_ACTION, VAULT_AGENT_ACTIONS, VAULT_GUARD_EXIT_MIN_GAS, VAULT_GUARD_MIN_GAS, VAULT_PRIORS_MIN_GAS, VAULT_RAETO_USDG_MIN_GAS, VAULT_V5_LIMITS, VENUE_KIND } from "../src/constants.ts";
import { exitParams, guardParams, transferParams } from "../src/messages.ts";
import { failedModuleSpends, floorGasOf, moduleFailureText, SPEND_AS_AGENT_SELECTOR, spendFloorGas, unpricedFloorGas } from "../src/relayer.ts";
import {
  agentActionMask,
  agentActionsOf,
  agentMayUse,
  agentSpendMessage,
  allowValue,
  cancelOrderParams,
  checkPolicy,
  decodeAgentSpendMessage,
  decodePolicyParams,
  decodePriorsBorrowParams,
  decodeSetOrderParams,
  EMPTY_POLICY,
  policyParams,
  policyTighter,
  priorsBorrowParams,
  priorsConsentParams,
  priorsLeaveParams,
  priorsRepayParams,
  revokeAgentKeyParams,
  rootClaimFeesParams,
  rootFreezeParams,
  rootSponsorParams,
  rootStakeParams,
  rootUnlockParams,
  rootVouchParams,
  setAgentKeyParams,
  setAllowParams,
  setOrderParams,
  signAgentSpend,
  spendAsAgentCall,
  VAULT_V5_SLOT,
  type OrderParams,
  type Policy,
} from "../src/vault-v5.ts";
import { WotsKeychain, type WotsSignatureRecord, type WotsStore } from "../src/wots.ts";

const VAULT = getAddress("0x00000000000000000000000000000000000Ab5e5");
const DEST = getAddress("0x00000000000000000000000000000000000C0D51");
const ROOT = `0x${"11".repeat(32)}` as Hex;
const bytes = (h: Hex) => (h.length - 2) / 2;
/** An in-memory WotsStore (the interface's contract: one record per keychain and index). */
function memoryStore(): WotsStore {
  const records = new Map<string, WotsSignatureRecord>();
  const key = (keychain: string, index: string) => `${keychain}:${index}`;
  return {
    load: async (keychainId, index) => records.get(key(Buffer.from(keychainId).toString("hex"), index.toString())),
    saveIfAbsent: async (r) => {
      const k = key(r.keychain, r.index);
      if (records.has(k)) return false;
      records.set(k, r);
      return true;
    },
  };
}

test("the version 5 slot is ERC-7201's for ostra.vault.v5", async () => {
  const { keccak256, stringToHex, toHex, hexToBigInt } = await import("viem");
  const inner = hexToBigInt(keccak256(stringToHex("ostra.vault.v5"))) - 1n;
  const slot = hexToBigInt(keccak256(padHex(toHex(inner), { size: 32 }))) & ~0xffn;
  assert.equal(padHex(toHex(slot), { size: 32 }), VAULT_V5_SLOT);
});

test("every version 5 encoder has the length the vault accepts", () => {
  const order: OrderParams = { kind: ORDER_KIND.PAY, venueKind: 0, target: DEST, amount: 1n, threshold: 0n, interval: 3_600, runs: 1, endAt: 0n };
  const sponsor = { rootId: 1n, agentId: 2n, amount: 3n, premiumBps: 4n, maxPremiumBps: 5n, nonce: 6n, deadline: 7n, owner: DEST, v: 27, r: ROOT, s: ROOT };
  const lengths: [Hex, number][] = [
    [policyParams(EMPTY_POLICY), 416],
    [setAllowParams({ kind: ALLOW_KIND.RECIPIENT, value: allowValue(ALLOW_KIND.RECIPIENT, DEST), allowed: true }), 96],
    [setAgentKeyParams({ root: ROOT, expiry: 1n }), 64],
    [revokeAgentKeyParams(), 0],
    [setOrderParams(order), 256],
    [cancelOrderParams(0n), 32],
    [priorsBorrowParams({ agentId: 1n, amount: 1n, term: 1n, maxFee: 0n, jobs: [] }), 384],
    [priorsRepayParams({ loanId: 1n, maxDue: 1n }), 64],
    [priorsConsentParams({ agentId: 1n, sponsorId: 2n, maxPremiumBps: 3n, deadline: 4n }), 128],
    [priorsLeaveParams(1n), 32],
    [rootStakeParams(VAULT_ACTION.ROOT_ENROLL, { rootId: 1n, assets: 1n }), 64],
    [rootStakeParams(VAULT_ACTION.ROOT_ADD_STAKE, { rootId: 1n, assets: 1n }), 64],
    [rootSponsorParams(sponsor), 352],
    [rootVouchParams(VAULT_ACTION.ROOT_VOUCH, { rootId: 1n, agentId: 2n, amount: 3n }), 96],
    [rootVouchParams(VAULT_ACTION.ROOT_UNVOUCH, { rootId: 1n, agentId: 2n, amount: 3n }), 96],
    [rootFreezeParams({ agentId: 1n, frozen: true }), 64],
    [rootUnlockParams({ rootId: 1n, shares: 1n }), 64],
    [rootClaimFeesParams(1n), 32],
  ];
  for (const [params, length] of lengths) assert.equal(bytes(params), length);
  assert.deepEqual(decodeSetOrderParams(setOrderParams(order)), order);
});

test("a policy the module refuses is never encoded, and tighter is the module's rule", () => {
  const p: Policy = { ...EMPTY_POLICY, actions: agentActionMask([VAULT_ACTION.TRANSFER, VAULT_ACTION.SWAP]), perTx: 5n, daily: 10n, coverBps: 5_000, repayKind: VENUE_KIND.ERC4626, repayVenue: DEST };
  assert.deepEqual(decodePolicyParams(policyParams(p)), p);
  assert.throws(() => checkPolicy({ ...p, actions: 1n << 2n }), /may never use/); // SetCrankKey
  assert.throws(() => checkPolicy({ ...p, maxTerm: VAULT_V5_LIMITS.MAX_TERM + 1 }), /maxTerm/);
  assert.throws(() => checkPolicy({ ...p, maxPremiumBps: VAULT_V5_LIMITS.MAX_PREMIUM_BPS + 1 }), /maxPremiumBps/);
  assert.throws(() => checkPolicy({ ...p, repayLead: VAULT_V5_LIMITS.MAX_REPAY_LEAD + 1 }), /repayLead/);
  assert.throws(() => checkPolicy({ ...p, repayKind: 0 }), /needs its kind/);
  assert.throws(() => checkPolicy({ ...p, repayKind: VENUE_KIND.RAETO_STOCK }), /RAETO_USDG or ERC4626/);
  assert.throws(() => checkPolicy({ ...p, repayVenue: zeroAddress }), /RAETO_USDG or ERC4626/);
  assert.equal(policyTighter({ ...p, perTx: 4n, actions: agentActionMask([VAULT_ACTION.TRANSFER]) }, p), true);
  assert.equal(policyTighter({ ...p, perTx: 6n }, p), false);
  assert.equal(policyTighter({ ...p, coverBps: 0 }, p), false, "turning cover off loosens");
  assert.equal(policyTighter({ ...p, coverBps: 4_000 }, p), true);
  assert.equal(policyTighter({ ...p, coverBps: 1 }, { ...p, coverBps: 0 }), true, "no cover before: any cover tightens");
  assert.equal(policyTighter({ ...p, repayVenue: VAULT }, p), false, "the repay venue changed");
  assert.deepEqual(agentActionsOf(VAULT_AGENT_ACTIONS), [0, 1, 3, 5, 10, 11, 17, 18, 19, 20, 21, 22, 26, 27, 28, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 46]);
  assert.throws(() => agentActionMask([VAULT_ACTION.SET_AGENT_KEY]), /may ever use/);
  assert.equal(agentMayUse(p, VAULT_ACTION.SWAP), true);
  assert.equal(agentMayUse(p, VAULT_ACTION.OPEN_CHANNEL), false);
});

test("allowlist values, orders and Priors params the module refuses are refused", () => {
  assert.equal(allowValue(ALLOW_KIND.CHANNEL, DEST), padHex(DEST.toLowerCase() as Hex, { size: 32 }));
  assert.equal(allowValue(ALLOW_KIND.SPONSOR, 7n), padHex("0x7", { size: 32 }));
  assert.throws(() => allowValue(ALLOW_KIND.POOL, DEST), /32 bytes/);
  assert.throws(() => allowValue(ALLOW_KIND.RECIPIENT, 1n), /takes an address/);
  assert.throws(() => allowValue(ALLOW_KIND.BORROWER, 0n), /not be zero/);
  assert.throws(() => allowValue(7, 1n), /1 to 6/);
  assert.throws(() => setAllowParams({ kind: ALLOW_KIND.LEND, value: ROOT, allowed: true }), /is an address/);
  const pay: OrderParams = { kind: ORDER_KIND.PAY, venueKind: 0, target: DEST, amount: 1n, threshold: 0n, interval: 3_600, runs: 1, endAt: 0n };
  assert.throws(() => setOrderParams({ ...pay, runs: 0 }), /at least one run/);
  assert.throws(() => setOrderParams({ ...pay, interval: 3_599 }), /interval/);
  assert.throws(() => setOrderParams({ ...pay, amount: 0n }), /greater than zero/);
  assert.throws(() => setOrderParams({ ...pay, kind: ORDER_KIND.REFILL, venueKind: VENUE_KIND.RAETO_STOCK, runs: 0, threshold: 1n }), /RAETO_USDG or ERC4626/);
  assert.throws(() => setOrderParams({ ...pay, kind: ORDER_KIND.SWEEP, venueKind: 4, runs: 0 }), /version 4 venue kind/);
  assert.throws(() => setOrderParams({ ...pay, kind: 4 }), /not SWEEP/);
  const jobs = [`0x${"00".repeat(31)}02`, `0x${"00".repeat(31)}05`] as Hex[];
  assert.deepEqual(decodePriorsBorrowParams(priorsBorrowParams({ agentId: 1n, amount: 2n, term: 3n, maxFee: 4n, jobs })), { agentId: 1n, amount: 2n, term: 3n, maxFee: 4n, jobs });
  assert.throws(() => priorsBorrowParams({ agentId: 1n, amount: 2n, term: 3n, maxFee: 4n, jobs: [...jobs].reverse() }), /strictly rising/);
  assert.throws(() => priorsBorrowParams({ agentId: 1n, amount: 2n, term: 3n, maxFee: 4n, jobs: Array(9).fill(jobs[0]) }), /at most 8/);
  assert.throws(() => rootStakeParams(VAULT_ACTION.ROOT_ENROLL, { rootId: 1n, assets: 0n }), /greater than zero/);
  assert.throws(() => setAgentKeyParams({ root: `0x${"00".repeat(32)}`, expiry: 1n }), /not be zero/);
  assert.throws(() => priorsConsentParams({ agentId: 1n, sponsorId: 2n, maxPremiumBps: BigInt(VAULT_V5_LIMITS.MAX_PREMIUM_BPS) + 1n, deadline: 4n }), /maxPremiumBps/);
});

test("the agent message is domain, chain, vault, agent nonce, next root, action and params, and decodes back", async () => {
  const params = transferParams({ to: DEST, amount: 5n });
  const message = agentSpendMessage({ chainId: ROBINHOOD_CHAIN_ID, vault: VAULT, agentNonce: 3n, nextKeyRoot: ROOT, action: VAULT_ACTION.TRANSFER, params });
  const hex = bytesToHex(message);
  assert.equal(message.length, 24 + 32 + 20 + 8 + 32 + 1 + 64);
  assert.equal(Buffer.from(message.subarray(0, 24)).toString("utf8"), "OSTRA/VAULT/EVM/AGENT/v1");
  assert.equal(BigInt(`0x${hex.slice(2 + 48, 2 + 112)}`), BigInt(ROBINHOOD_CHAIN_ID));
  assert.equal(getAddress(`0x${hex.slice(2 + 112, 2 + 152)}`), VAULT);
  assert.equal(BigInt(`0x${hex.slice(2 + 152, 2 + 168)}`), 3n);
  assert.deepEqual(decodeAgentSpendMessage(message), { chainId: ROBINHOOD_CHAIN_ID, vault: VAULT, agentNonce: 3n, nextKeyRoot: ROOT, action: VAULT_ACTION.TRANSFER, params });
  const owner = message.slice();
  owner.set(Buffer.from("OSTRA/VAULT/EVM/SPEND/v1"), 0);
  assert.throws(() => decodeAgentSpendMessage(owner), /not an agent spend/);
  assert.throws(() => agentSpendMessage({ chainId: ROBINHOOD_CHAIN_ID, vault: VAULT, agentNonce: 3n, nextKeyRoot: ROOT, action: VAULT_ACTION.TRANSFER, params: "0x00" }), /64 bytes/);
  // A zero next root is a valid message (it ends the agent key), and reads back.
  const ending = agentSpendMessage({ chainId: ROBINHOOD_CHAIN_ID, vault: VAULT, agentNonce: 3n, nextKeyRoot: `0x${"00".repeat(32)}`, action: VAULT_ACTION.TRANSFER, params });
  assert.equal(decodeAgentSpendMessage(ending).nextKeyRoot, `0x${"00".repeat(32)}`);
  // Signing rotates to another key of the agent keychain, one that never signed and is not the vault's own key.
  const chain = new WotsKeychain(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), memoryStore());
  const root0 = bytesToHex(chain.keyRoot(0n));
  const k = { vault: VAULT, agentNonce: 3n, keyRoot: root0, vaultKeyRoot: ROOT, index: 0n, nextIndex: 1n };
  const a = { chainId: ROBINHOOD_CHAIN_ID, action: VAULT_ACTION.TRANSFER, params } as const;
  await assert.rejects(signAgentSpend(chain, { ...k, nextIndex: 0n }, a), /another key/);
  await assert.rejects(signAgentSpend(chain, { ...k, vaultKeyRoot: bytesToHex(chain.keyRoot(1n)) }, a), /vault's own key root/);
  await assert.rejects(signAgentSpend(chain, { ...k, keyRoot: ROOT }, a), /does not match/);
  await chain.sign(2n, new Uint8Array([1]));
  await assert.rejects(signAgentSpend(chain, { ...k, nextIndex: 2n }, a), /signed already/);
  const signed = await signAgentSpend(chain, k, a);
  assert.equal(signed.nextKeyRoot, bytesToHex(chain.keyRoot(1n)));
  assert.deepEqual(decodeAgentSpendMessage(signed.message).nextKeyRoot, signed.nextKeyRoot);
});

test("the relay gas rules count spendAsAgent as a spend, with the version 5 floors", () => {
  assert.equal(SPEND_AS_AGENT_SELECTOR, toFunctionSelector("spendAsAgent(uint8,bytes32,bytes,bytes)"));
  const signature = `0x${"ab".repeat(16 + 67 * 32)}` as Hex;
  const priors = priorsLeaveParams(1n);
  assert.deepEqual(floorGasOf(spendAsAgentCall(VAULT, { action: VAULT_ACTION.PRIORS_LEAVE, nextKeyRoot: ROOT, params: priors, signature })), [BigInt(VAULT_PRIORS_MIN_GAS)]);
  assert.deepEqual(floorGasOf(spendAsAgentCall(VAULT, { action: VAULT_ACTION.TRANSFER, nextKeyRoot: ROOT, params: transferParams({ to: DEST, amount: 1n }), signature })), []);
  for (const a of [VAULT_ACTION.PRIORS_BORROW, VAULT_ACTION.ROOT_CLAIM_FEES]) assert.equal(spendFloorGas(a, "0x"), BigInt(VAULT_PRIORS_MIN_GAS));
  // The agent key's Exit has no floor (OstraVaultModuleV5.agentExit), the owner's has its kind's; priced the same way.
  const exit = exitParams({ kind: VENUE_KIND.RAETO_USDG, venue: RAETO_USDG_VAULT, amount: 1n, minOut: 0n });
  assert.deepEqual(floorGasOf(spendAsAgentCall(VAULT, { action: VAULT_ACTION.EXIT, nextKeyRoot: ROOT, params: exit, signature })), []);
  assert.equal(unpricedFloorGas(spendAsAgentCall(VAULT, { action: VAULT_ACTION.EXIT, nextKeyRoot: ROOT, params: exit, signature })), 0n);
  const ownerExit = { to: VAULT, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [VAULT_ACTION.EXIT, ROOT, exit, signature] }) };
  assert.deepEqual(floorGasOf(ownerExit), [BigInt(VAULT_RAETO_USDG_MIN_GAS)]);
  assert.equal(spendFloorGas(VAULT_ACTION.SET_POLICY, policyParams(EMPTY_POLICY)), 0n);
  const guard = (op: typeof GUARD_OP.AGENT_STOP | typeof GUARD_OP.CLEAR_CRANK) => guardParams(DEST, { op });
  assert.equal(spendFloorGas(VAULT_ACTION.GUARD, guard(GUARD_OP.AGENT_STOP)), BigInt(VAULT_GUARD_MIN_GAS));
  assert.equal(spendFloorGas(VAULT_ACTION.GUARD, guard(GUARD_OP.CLEAR_CRANK)), BigInt(VAULT_GUARD_MIN_GAS));
  assert.equal(spendFloorGas(VAULT_ACTION.GUARD, guardParams(DEST, { op: GUARD_OP.EXIT, kind: VENUE_KIND.ERC4626, venue: DEST, amount: 0n })), BigInt(VAULT_GUARD_EXIT_MIN_GAS));
  assert.equal(spendFloorGas(VAULT_ACTION.GUARD, guardParams(DEST, { op: GUARD_OP.CANCEL })), BigInt(VAULT_GUARD_MIN_GAS));
});

test("a PriorsFailed of a vault reads as a failed priors spend, of that vault only", () => {
  const topics = encodeEventTopics({ abi: ostraVaultModuleV5Abi, eventName: "PriorsFailed", args: { action: VAULT_ACTION.PRIORS_BORROW } });
  const reason = toFunctionSelector("NotOwnAgent(uint256)");
  const log = { address: VAULT, topics, data: encodeAbiParameters([{ type: "bytes4" }], [reason]) } as unknown as Log;
  assert.deepEqual(failedModuleSpends([log], [VAULT]), [{ vault: VAULT, kind: "priors", action: VAULT_ACTION.PRIORS_BORROW, reason }]);
  assert.deepEqual(failedModuleSpends([log], [DEST]), []);
  assert.equal(moduleFailureText(reason), "NotOwnAgent");
});
