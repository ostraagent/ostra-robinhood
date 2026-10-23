// What the RPC proxy forwards on /logs (design: RPC proxy, the logs route): the log scans of the web app's private
// balance and swap routes, which need an RPC that serves eth_getLogs over LOG_WINDOW_BLOCKS blocks (Robinhood Chain's
// public RPC; the upstream of / serves 10 blocks a request). A browser that cannot reach the public RPC itself (seen
// 23 Oct 2026: a network refusing its IPv4 address) reads the same answers through this route, and the app needs no
// other origin than Ostra's.
//
// Only the requests the web app's logsClient makes (core/src/private-balance.ts, ostra-swap sdk/src/private.ts and
// pools.ts, read 23 Oct 2026), all against one node so the logs and the state they are checked against agree:
//   eth_getLogs      of OstraPrivatePool: Shielded, Unshielded, PrivateSwapped, NoteAdded (one event a request);
//                    of Uniswap v4's PoolManager: Initialize (one pair's pools)
//   eth_call         to OstraPrivatePool: currentTree(), treeSize(uint256), currentRoot() (PoolTrees.sync)
//   eth_blockNumber, eth_chainId
// One event per request (topic0 one value, never a list), other topics one value or null, at most LOG_WINDOW_BLOCKS
// blocks. Up to "latest" only the pool's logs from its first block on (core's searches for one shield or spend,
// from the block it was sent at).

import { getAbiItem, isAddress, parseAbiItem, toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction, type Address, type Hex } from "viem";
import { ostraPrivatePoolAbi } from "../../../ostra-swap/sdk/src/abi.ts";
import { LOG_WINDOW_BLOCKS } from "../../core/src/channels.ts";
import { BYTES32, QUANTITY, checkEnvelope, refuse, type Checked } from "./policy.ts";

/** Uniswap v4's PoolManager on Robinhood Chain (ostra-swap sdk/src/constants.ts UNISWAP_V4_POOL_MANAGER; the tests compare them). */
export const UNISWAP_V4_POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

/** The pool's events served, from the ABI of the contract deployed (ostra-swap sdk/src/abi.ts, generated from its build). */
export const POOL_EVENTS = (["Shielded", "Unshielded", "PrivateSwapped", "NoteAdded"] as const).map((name) => getAbiItem({ abi: ostraPrivatePoolAbi, name }) as AbiEvent);

/** Uniswap v4's Initialize, as the swap SDK declares it (sdk/src/uniswap.ts initializeEvent; the tests compare them). */
export const INITIALIZE_EVENT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);

/** The pool's functions served by eth_call (PoolTrees.sync), by selector, with the length of their calldata. */
export const POOL_READS: ReadonlyMap<Hex, { name: string; bytes: number }> = new Map(
  (["currentTree", "treeSize", "currentRoot"] as const).map((name) => {
    const f = getAbiItem({ abi: ostraPrivatePoolAbi, name }) as AbiFunction;
    return [toFunctionSelector(f), { name, bytes: 4 + 32 * f.inputs.length }] as const;
  }),
);

export const LOGS_METHODS: ReadonlySet<string> = new Set(["eth_blockNumber", "eth_chainId", "eth_call", "eth_getLogs"]);

export type LogsPolicy = {
  /** OstraPrivatePool (ostra-swap deployments/robinhood-mainnet.json privatePool). */
  privatePool: Address;
  /** The first block of its searches (the same record's fromBlock). */
  fromBlock: bigint;
};

/** topic0 served per contract (lower-case addresses and topics). */
export function servedTopics(p: LogsPolicy): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map([
    [p.privatePool.toLowerCase(), new Set(POOL_EVENTS.map((e) => toEventSelector(e)))],
    [UNISWAP_V4_POOL_MANAGER.toLowerCase(), new Set([toEventSelector(INITIALIZE_EVENT)])],
  ]);
}

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const BLOCK = (x: unknown): x is string => typeof x === "string" && (x === "latest" || QUANTITY.test(x));

function logsQuery(params: unknown[] | undefined, topics: ReadonlyMap<string, ReadonlySet<string>>, policy: LogsPolicy): string | null {
  if (params === undefined || params.length !== 1 || !isObject(params[0])) return "one filter object";
  const f = params[0];
  if (Object.keys(f).some((k) => k !== "address" && k !== "topics" && k !== "fromBlock" && k !== "toBlock")) return "a filter of address, topics, fromBlock and toBlock only";
  if (typeof f.address !== "string" || !isAddress(f.address, { strict: false })) return "one contract address";
  const served = topics.get(f.address.toLowerCase());
  if (served === undefined) return "the logs of OstraPrivatePool or Uniswap v4's PoolManager";
  if (!Array.isArray(f.topics) || f.topics.length < 1 || f.topics.length > 4) return "a list of one to four topics";
  const [topic0, ...rest] = f.topics as unknown[];
  if (typeof topic0 !== "string" || !served.has(topic0.toLowerCase())) return "one of the events the web app reads";
  if (rest.some((t) => t !== null && (typeof t !== "string" || !BYTES32.test(t)))) return "topics of one value or null";
  if (typeof f.fromBlock !== "string" || !QUANTITY.test(f.fromBlock)) return "a fromBlock number";
  if (!BLOCK(f.toBlock)) return 'a toBlock number or "latest"';
  const from = BigInt(f.fromBlock);
  if (f.toBlock === "latest") {
    if (f.address.toLowerCase() !== policy.privatePool.toLowerCase() || from < policy.fromBlock) return 'toBlock "latest" only for the pool\'s logs from its first block on';
    return null;
  }
  const to = BigInt(f.toBlock);
  if (to < from || to - from + 1n > LOG_WINDOW_BLOCKS) return `at most ${LOG_WINDOW_BLOCKS} blocks`;
  return null;
}

function poolRead(params: unknown[] | undefined, pool: string): string | null {
  if (params === undefined || params.length !== 2 || !isObject(params[0]) || !BLOCK(params[1])) return 'a call object and a block number or "latest"';
  const c = params[0];
  if (Object.keys(c).some((k) => k !== "to" && k !== "data")) return "a call of to and data only";
  if (typeof c.to !== "string" || c.to.toLowerCase() !== pool) return "a call to OstraPrivatePool";
  if (typeof c.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(c.data)) return "calldata";
  const read = POOL_READS.get(c.data.slice(0, 10).toLowerCase() as Hex);
  if (read === undefined || (c.data.length - 2) / 2 !== read.bytes) return "currentTree(), treeSize(uint256) or currentRoot()";
  return null;
}

/** Checks a parsed request body for /logs; the request to forward, or the JSON-RPC error that refuses it. */
export function checkLogsRequest(body: unknown, policy: LogsPolicy, topics: ReadonlyMap<string, ReadonlySet<string>> = servedTopics(policy)): Checked {
  const checked = checkEnvelope(body);
  if (!checked.ok) return checked;
  const { id, method, params } = checked.request;
  if (!LOGS_METHODS.has(method)) return refuse(id, 403, -32601, `${method} is not served on /logs: it serves the web app's log scans only (eth_getLogs, eth_call, eth_blockNumber, eth_chainId)`);
  if (method === "eth_getLogs") {
    const wrong = logsQuery(params, topics, policy);
    if (wrong !== null) return refuse(id, 403, -32602, `eth_getLogs on /logs needs ${wrong}`);
  }
  if (method === "eth_call") {
    const wrong = poolRead(params, policy.privatePool.toLowerCase());
    if (wrong !== null) return refuse(id, 403, -32602, `eth_call on /logs needs ${wrong}`);
  }
  if ((method === "eth_blockNumber" || method === "eth_chainId") && params !== undefined && params.length !== 0) return refuse(id, 403, -32602, `${method} takes no params`);
  return checked;
}
