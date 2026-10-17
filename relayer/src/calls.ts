// Reads a relay request's calls (the Solana relayer decoded a v1 transaction
// and its instructions here, tx.ts). A request is {"calls": [{to, data}],
// "prepay"?, "payer"?}; the relayer sends one call as it is and several
// through Multicall3 (sdk relayTransaction), and the request hash binds a
// quote and a payment to exactly that transaction (sdk relayRequestHash).
//
// The Ostra calls the relayer recognises (src/*.sol):
//
//   OstraVaultFactory.createVault(token, initialKeyRoot, initialCrank)
//   OstraVault.spend(action, nextKeyRoot, params, signature)    WOTS
//     OpenChannel (action 1) params abi.encode(payerAuthorizer, receiver,
//                 receiverAuthorizer, withdrawDelay, salt, amount)
//   OstraVault.requestClose(config, amount, deadline, signature)
//   OstraVault.finalizeWithdraw(config)
//   OstraPool.spendLeaf(batchId, leafIndex, destination, signature)  WOTS
//   OstraPool.approveBatch(key, batchId, state, nextKeyRoot, signature)  WOTS
//   OstraPool.depositWithAuthorization(...), cancelDeposit(key), closeDeposit(key)
//
// Anything else is read as an unknown call; the relayer's policy (gate.ts)
// refuses it, as Kora's allowed-program list did.

import { decodeFunctionData, getAddress, toFunctionSelector, type AbiFunction, type Address, type Hex } from "viem";
import {
  VAULT_ACTION,
  decodeOpenChannelParams,
  ostraPoolAbi,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  relayCalls,
  relayRequestHash,
  relayTransaction,
  vaultAddress,
  type ChannelConfig,
  type Deployment,
  type OpenChannelParams,
  type RelayCall,
} from "@ostraagent/sdk";

/** A call of the request, read by its function. */
export type ParsedCall =
  | { fn: "createVault"; to: Address; token: Address; initialKeyRoot: Hex; initialCrank: Address }
  | { fn: "spend"; to: Address; action: number; nextKeyRoot: Hex; params: Hex; signature: Hex }
  | { fn: "requestClose"; to: Address; config: ChannelConfig; amount: bigint; deadline: bigint; signature: Hex }
  | { fn: "finalizeWithdraw"; to: Address; config: ChannelConfig }
  | { fn: "spendLeaf"; to: Address; batchId: bigint; leafIndex: number; destination: Address; signature: Hex }
  | { fn: "approveBatch"; to: Address; key: Hex; batchId: bigint; state: Hex; nextKeyRoot: Hex; signature: Hex }
  | { fn: "depositWithAuthorization"; to: Address }
  | { fn: "cancelDeposit"; to: Address; key: Hex }
  | { fn: "closeDeposit"; to: Address; key: Hex }
  | { fn: null; to: Address; selector: Hex };

export type RelayTx = {
  /** sdk relayRequestHash: what a quote and a payment are bound to. */
  hash: Hex;
  /** The transaction the relayer sends (sdk relayTransaction). */
  to: Address;
  data: Hex;
  calls: RelayCall[];
  parsed: ParsedCall[];
};

/** The Ostra functions the relayer reads, by selector. */
const KNOWN = new Map<Hex, readonly unknown[]>();
for (const [abi, names] of [
  [ostraVaultFactoryAbi, ["createVault"]],
  [ostraVaultAbi, ["spend", "requestClose", "finalizeWithdraw"]],
  [ostraPoolAbi, ["spendLeaf", "approveBatch", "depositWithAuthorization", "cancelDeposit", "closeDeposit"]],
] as const) {
  for (const name of names) {
    const item = (abi as readonly { type: string; name?: string }[]).find((x) => x.type === "function" && x.name === name);
    if (item === undefined) throw new Error(`the Ostra ABI has no function ${name}`);
    KNOWN.set(toFunctionSelector(item as AbiFunction).toLowerCase() as Hex, [item]);
  }
}

function toConfig(c: { payer: Address; payerAuthorizer: Address; receiver: Address; receiverAuthorizer: Address; token: Address; withdrawDelay: number; salt: Hex }): ChannelConfig {
  return {
    payer: getAddress(c.payer),
    payerAuthorizer: getAddress(c.payerAuthorizer),
    receiver: getAddress(c.receiver),
    receiverAuthorizer: getAddress(c.receiverAuthorizer),
    token: getAddress(c.token),
    withdrawDelay: Number(c.withdrawDelay),
    salt: c.salt,
  };
}

/** Reads one call by its selector; throws for an Ostra function whose arguments do not decode. */
export function parseCall(call: RelayCall, index = 0): ParsedCall {
  const selector = call.data.slice(0, 10).toLowerCase() as Hex;
  const abi = KNOWN.get(selector);
  if (abi === undefined) return { fn: null, to: call.to, selector };
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: abi as never, data: call.data }) as typeof decoded;
  } catch {
    throw new Error(`calls[${index}]: malformed ${(abi[0] as { name: string }).name} calldata`);
  }
  const a = decoded.args;
  const to = call.to;
  switch (decoded.functionName) {
    case "createVault":
      return { fn: "createVault", to, token: getAddress(a[0] as Address), initialKeyRoot: a[1] as Hex, initialCrank: getAddress(a[2] as Address) };
    case "spend":
      return { fn: "spend", to, action: Number(a[0]), nextKeyRoot: a[1] as Hex, params: a[2] as Hex, signature: a[3] as Hex };
    case "requestClose":
      return { fn: "requestClose", to, config: toConfig(a[0] as never), amount: a[1] as bigint, deadline: a[2] as bigint, signature: a[3] as Hex };
    case "finalizeWithdraw":
      return { fn: "finalizeWithdraw", to, config: toConfig(a[0] as never) };
    case "spendLeaf":
      return { fn: "spendLeaf", to, batchId: a[0] as bigint, leafIndex: Number(a[1]), destination: getAddress(a[2] as Address), signature: a[3] as Hex };
    case "approveBatch":
      return { fn: "approveBatch", to, key: a[0] as Hex, batchId: a[1] as bigint, state: a[2] as Hex, nextKeyRoot: a[3] as Hex, signature: a[4] as Hex };
    case "depositWithAuthorization":
      return { fn: "depositWithAuthorization", to };
    case "cancelDeposit":
      return { fn: "cancelDeposit", to, key: a[0] as Hex };
    default:
      return { fn: "closeDeposit", to, key: a[0] as Hex };
  }
}

/** Reads a relay request body's calls; throws with the reason (answered 400 bad_transaction). */
export function decodeRelayRequest(body: { calls?: unknown }): RelayTx {
  const calls = relayCalls(body.calls);
  const parsed = calls.map((c, i) => parseCall(c, i));
  const tx = relayTransaction(calls);
  return { hash: relayRequestHash(calls), to: tx.to, data: tx.data, calls, parsed };
}

/** The vault created by a createVault call to the deployment's factory. */
export type CreateVaultCall = { vault: Address; token: Address; initialKeyRoot: Hex; initialCrank: Address };
/** An OpenChannel spend: its vault, its params and the channel it opens. */
export type OpenChannelCall = { vault: Address; open: OpenChannelParams };
export type SpendLeafCall = { pool: Address; batchId: bigint; leafIndex: number; destination: Address };

export type Classified =
  | { kind: "create_vault"; ix: CreateVaultCall }
  | { kind: "open_relayer_channel"; ix: OpenChannelCall }
  | { kind: "spend_leaf"; ix: SpendLeafCall }
  | { kind: "unshield_vault"; create: CreateVaultCall; leaf: SpendLeafCall }
  | { kind: "other"; vaults: Address[] };

function createVaultCall(c: ParsedCall, d: Deployment): CreateVaultCall | null {
  if (c.fn !== "createVault" || c.to !== d.vaultFactory) return null;
  return {
    vault: vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: c.token, initialKeyRoot: c.initialKeyRoot, initialCrank: c.initialCrank }),
    token: c.token,
    initialKeyRoot: c.initialKeyRoot,
    initialCrank: c.initialCrank,
  };
}

function spendLeafCall(c: ParsedCall, d: Deployment): SpendLeafCall | null {
  if (c.fn !== "spendLeaf" || c.to !== d.pool) return null;
  return { pool: c.to, batchId: c.batchId, leafIndex: c.leafIndex, destination: c.destination };
}

/** The vault a call acts for: the one createVault makes, or the vault a spend, close request or withdrawal is sent to; null for the pool's calls. */
export function vaultOf(c: ParsedCall, d: Deployment): Address | null {
  const created = createVaultCall(c, d);
  if (created !== null) return created.vault;
  if (c.fn === "spend" || c.fn === "requestClose" || c.fn === "finalizeWithdraw") return c.to;
  return null;
}

/**
 * The relayer's reading of a request (design v0.3, decided 15 Oct 2026):
 * the four kinds relayed before payment, each the whole request, or any other
 * request with the vaults it acts for. A createVault the request asks to pay
 * for up front (`prepay`) is an ordinary paid request for its vault.
 */
export function classify(tx: RelayTx, d: Deployment, relayerVault: Address, prepay = false): Classified {
  const p = tx.parsed;
  if (p.length === 1) {
    const only = p[0] as ParsedCall;
    const created = createVaultCall(only, d);
    if (created !== null && !prepay) return { kind: "create_vault", ix: created };
    if (only.fn === "spend" && only.action === VAULT_ACTION.OPEN_CHANNEL) {
      let open: OpenChannelParams;
      try {
        open = decodeOpenChannelParams(only.params);
      } catch (err) {
        throw new Error(`malformed OpenChannel params: ${(err as Error).message}`);
      }
      if (getAddress(open.receiverAuthorizer) === relayerVault) return { kind: "open_relayer_channel", ix: { vault: only.to, open } };
    }
    const leaf = spendLeafCall(only, d);
    if (leaf !== null) return { kind: "spend_leaf", ix: leaf };
  }
  if (p.length === 2 && !prepay) {
    const created = createVaultCall(p[0] as ParsedCall, d);
    const leaf = spendLeafCall(p[1] as ParsedCall, d);
    if (created !== null && leaf !== null) return { kind: "unshield_vault", create: created, leaf };
  }
  const vaults: Address[] = [];
  for (const c of p) {
    const v = vaultOf(c, d);
    if (v !== null && !vaults.includes(v)) vaults.push(v);
  }
  return { kind: "other", vaults };
}
