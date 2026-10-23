// What the RPC proxy forwards (design: RPC proxy, read and simulation only,
// for the web app, with a rate per client IP address).
//
// Only one JSON-RPC 2.0 request per HTTP request, and only the eth_ methods
// the web app's code calls through viem (core/src and sdk/src, read 19 Oct
// 2026): readContract, multicall and call are eth_call; simulateBlocks (the
// relayer price quotes and the throwaway-key quotes before signing) is
// eth_simulateV1; waitForTransactionReceipt polls eth_blockNumber and reads
// eth_getTransactionReceipt, eth_getTransactionByHash and
// eth_getBlockByNumber. No method that sends is among them
// (eth_sendRawTransaction, eth_sendTransaction): every transaction of the web
// app goes through the relayer. Node-specific methods (anvil_, debug_,
// txpool_, filters and subscriptions) are not served either.
//
// eth_getLogs, the EVM counterpart of Solana's getProgramAccounts, is
// forwarded only as core's channel recovery asks it (recoverChannelConfig):
// the ChannelOpened logs of one channel of one vault, over at most
// LOG_WINDOW_BLOCKS blocks, never as a scan.

import { ostraVaultAbi } from "@ostraagent/sdk";
import { getAbiItem, isAddress, toEventSelector, type AbiEvent } from "viem";
import { LOG_WINDOW_BLOCKS } from "../../core/src/channels.ts";

/** The methods forwarded. */
export const READ_METHODS: ReadonlySet<string> = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_simulateV1",
]);

/** topic0 of OstraVault's ChannelOpened(bytes32 indexed channelId, uint128 amount). */
export const CHANNEL_OPENED_TOPIC = toEventSelector(getAbiItem({ abi: ostraVaultAbi, name: "ChannelOpened" }) as AbiEvent);

/** The most blocks one eth_getLogs may span (core's LOG_WINDOW_BLOCKS). */
export const MAX_LOG_BLOCKS = LOG_WINDOW_BLOCKS;

/** The length of the window the rates count requests in: a rate is requests a second. */
export const RATE_WINDOW_MS = 1_000;

export type RpcId = string | number | null;

/** A request the proxy forwards, as it forwards it (nothing else of the client's body). */
export type ForwardedRequest = { jsonrpc: "2.0"; id: RpcId; method: string; params?: unknown[] };

export type Checked = { ok: true; request: ForwardedRequest } | { ok: false; id: RpcId; status: number; code: number; message: string };

export const refuse = (id: RpcId, status: number, code: number, message: string): Checked => ({ ok: false, id, status, code, message });

export const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
export const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** True when `params` ask eth_getLogs as core's recoverChannelConfig does (core/src/channels.ts). */
function channelOpenedQuery(params: unknown[] | undefined): boolean {
  if (params === undefined || params.length !== 1) return false;
  const filter = params[0];
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) return false;
  const f = filter as Record<string, unknown>;
  if (Object.keys(f).some((k) => k !== "address" && k !== "topics" && k !== "fromBlock" && k !== "toBlock")) return false;
  if (typeof f.address !== "string" || !isAddress(f.address, { strict: false })) return false;
  if (!Array.isArray(f.topics) || f.topics.length !== 2) return false;
  const [topic0, channel] = f.topics as unknown[];
  if (typeof topic0 !== "string" || topic0.toLowerCase() !== CHANNEL_OPENED_TOPIC) return false;
  if (typeof channel !== "string" || !BYTES32.test(channel)) return false;
  if (typeof f.fromBlock !== "string" || typeof f.toBlock !== "string" || !QUANTITY.test(f.fromBlock) || !QUANTITY.test(f.toBlock)) return false;
  const from = BigInt(f.fromBlock);
  const to = BigInt(f.toBlock);
  return to >= from && to - from + 1n <= MAX_LOG_BLOCKS;
}

/**
 * The JSON-RPC 2.0 envelope of a parsed body, checked: one request object, with its method and params as the
 * request to forward (nothing else of the body), or the error that refuses it. The method is not checked here.
 */
export function checkEnvelope(body: unknown): Checked {
  if (Array.isArray(body)) return refuse(null, 400, -32600, "batch requests are not served; send one request at a time");
  if (body === null || typeof body !== "object") return refuse(null, 400, -32600, "the body must be a JSON-RPC 2.0 request object");
  const r = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: RpcId = typeof r.id === "string" || typeof r.id === "number" ? r.id : null;
  if (r.jsonrpc !== "2.0") return refuse(id, 400, -32600, 'jsonrpc must be "2.0"');
  if (r.id !== undefined && r.id !== null && typeof r.id !== "string" && typeof r.id !== "number") return refuse(null, 400, -32600, "id must be a string, a number or null");
  if (typeof r.method !== "string") return refuse(id, 400, -32600, "method must be a string");
  if (r.params !== undefined && !Array.isArray(r.params)) return refuse(id, 400, -32602, "params must be an array");
  const params = r.params as unknown[] | undefined;
  return { ok: true, request: { jsonrpc: "2.0", id, method: r.method, ...(params === undefined ? {} : { params }) } };
}

/** Checks a parsed request body; the request to forward, or the JSON-RPC error that refuses it. */
export function checkRequest(body: unknown): Checked {
  const checked = checkEnvelope(body);
  if (!checked.ok) return checked;
  const { id, method, params } = checked.request;
  if (!READ_METHODS.has(method)) return refuse(id, 403, -32601, `${method} is not served: this proxy only reads and simulates; send transactions through the relayer`);
  if (method === "eth_getLogs" && !channelOpenedQuery(params)) {
    return refuse(id, 403, -32602, `eth_getLogs is served only for the ChannelOpened logs of one channel of one vault over at most ${MAX_LOG_BLOCKS} blocks (core channel recovery)`);
  }
  return checked;
}

/**
 * Requests counted over the last RATE_WINDOW_MS, per client and in total:
 * a request is taken only while its client has sent fewer than `perClient`
 * and all clients fewer than `total` in that window. Refused requests are not
 * counted. Memory stays within `total` entries.
 */
export class RateLimiter {
  readonly #perClient: number;
  readonly #total: number;
  /** Every taken request in the window, oldest first. */
  readonly #all: { at: number; client: string }[] = [];
  /** Per client, the times of its taken requests in the window, oldest first. */
  readonly #clients = new Map<string, number[]>();

  constructor(perClient: number, total: number) {
    if (!Number.isSafeInteger(perClient) || !Number.isSafeInteger(total) || perClient < 1 || total < perClient) throw new RangeError("rates must be whole numbers with 1 <= perClient <= total");
    this.#perClient = perClient;
    this.#total = total;
  }

  /** Takes one request of `client` at `now` (ms); why it is refused, or null when taken. */
  take(client: string, now: number): "client" | "total" | null {
    this.#expire(now);
    if (this.#all.length >= this.#total) return "total";
    const times = this.#clients.get(client) ?? [];
    if (times.length >= this.#perClient) return "client";
    times.push(now);
    this.#clients.set(client, times);
    this.#all.push({ at: now, client });
    return null;
  }

  /** Requests counted now (for tests and logs). */
  size(): { total: number; clients: number } {
    return { total: this.#all.length, clients: this.#clients.size };
  }

  #expire(now: number): void {
    // Entries leave in the order they came, so the oldest of #all is the oldest of its client.
    while (this.#all.length > 0 && now - (this.#all[0] as { at: number }).at >= RATE_WINDOW_MS) {
      const { client } = this.#all.shift() as { at: number; client: string };
      const times = this.#clients.get(client);
      times?.shift();
      if (times !== undefined && times.length === 0) this.#clients.delete(client);
    }
  }
}
