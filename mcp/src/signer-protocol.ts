// The protocol between a hosted agent (Ostra Cloud) and its signer (signer.ts): one JSON object per line over a Unix
// socket, each request answered by one line with the same id. Every operation is typed: the signer builds every message
// it signs from the fields below and checks each field's type and range itself, so a request can never make it sign a
// hash or a message of the caller's choosing. bigints travel as decimal strings, bytes as 0x hex.
//
//   request   {"id": n, "agent": "<agent id>", "token": "<hex>", "op": "<op>", "args": {...}}
//   admin     {"id": n, "admin": "<hex>", "op": "agent.create" | "agent.rotate", "args": {"agent": "<agent id>"}}
//             {"id": n, "admin": "<hex>", "op": "attest", "args": {"nonce": "<64 hex>"}}
//   answer    {"id": n, "ok": true, "result": ...} or {"id": n, "ok": false, "error": "<message>"}
//
// The agent token is HMAC-SHA256(admin key, TOKEN_DOMAIN || agent id || "/" || epoch) and the admin token
// HMAC-SHA256(admin key, ADMIN_DOMAIN): whoever holds the admin key (the gateway) hands each agent process its own
// token, and a token opens that agent's seed only. agent.create and agent.rotate answer the agent's epoch; agent.rotate
// raises it, so every token handed out before stops working (a leaked token is revoked without touching the others).
// attest answers the enclave's attestation (the dstack guest agent's) over report data the signer derives from the
// nonce (attestReportData), so whoever chose the nonce knows the quote is fresh and made for this request.

import { createHash, createHmac } from "node:crypto";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { VAULT_AGENT_ACTIONS, type VaultAction } from "@ostraagent/sdk";

export const TOKEN_DOMAIN = "OSTRA/CLOUD/SIGNER/TOKEN/v1";
export const ADMIN_DOMAIN = "OSTRA/CLOUD/SIGNER/ADMIN/v1";
/** What an attestation's report data commits to, before the nonce (attestReportData). */
export const ATTEST_DOMAIN = "OSTRA/CLOUD/ATTEST/v1";
/** An attestation nonce: 32 bytes, lower case hex. */
export const ATTEST_NONCE = /^[0-9a-f]{64}$/;
/** An agent id: what the gateway names a home by (remote.ts USER_ID). */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The largest request line taken. */
export const MAX_LINE = 64 * 1024;
/** The most key roots or records one batch asks for. */
export const MAX_BATCH = 64;
/** The requests one connection may have open at once, and one agent across all its connections. */
export const MAX_OPEN = 16;

export const AGENT_OPS = [
  "agent.keyRoots",
  "agent.records",
  "agent.signSpend",
  "voucher.address",
  "voucher.sign",
  "voucher.signClose",
  "payment.address",
  "payment.signTransfer",
  "pad.postingAddress",
  "pad.signPost",
  "pad.kemPublicKey",
  "pad.unwrap",
  "tide.secret",
] as const;
export type AgentOp = (typeof AGENT_OPS)[number];
export const ADMIN_OPS = ["agent.create", "agent.rotate", "attest"] as const;
/** The operations that sign or open something (counted against the rate limit). */
export const SIGNING_OPS: ReadonlySet<string> = new Set(["agent.signSpend", "voucher.sign", "voucher.signClose", "payment.signTransfer", "pad.signPost", "pad.unwrap"]);

export function agentToken(adminKey: Uint8Array, agent: string, epoch: number): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RangeError("epoch must be a non-negative integer");
  return createHmac("sha256", adminKey).update(`${TOKEN_DOMAIN}${agent}/${epoch}`).digest("hex");
}

/** The report data of an attestation for `nonce` (ATTEST_NONCE): SHA-256(ATTEST_DOMAIN || the nonce's 32 bytes), hex. */
export function attestReportData(nonce: string): string {
  if (!ATTEST_NONCE.test(nonce)) throw new BadRequest("nonce must be 32 bytes, lower case hex");
  return createHash("sha256").update(ATTEST_DOMAIN).update(Buffer.from(nonce, "hex")).digest("hex");
}

export function adminToken(adminKey: Uint8Array): string {
  return createHmac("sha256", adminKey).update(ADMIN_DOMAIN).digest("hex");
}

/** A request the signer refuses as malformed (its message names the field). */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

type Args = Record<string, unknown>;

export function obj(v: unknown, what: string): Args {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new BadRequest(`${what} must be an object`);
  return v as Args;
}

/** `o` has exactly `keys` (no more, no fewer). */
export function exact(o: Args, keys: readonly string[], what: string): Args {
  const k = Object.keys(o);
  if (k.length !== keys.length || !keys.every((x) => Object.hasOwn(o, x))) throw new BadRequest(`${what} takes exactly ${keys.join(", ")}`);
  return o;
}

export function chainId(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new BadRequest("chainId must be a positive integer");
  return v;
}

export function address(v: unknown, what: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new BadRequest(`${what} must be an address`);
  return getAddress(v);
}

export function hex(v: unknown, what: string, bytes?: number): Hex {
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new BadRequest(`${what} must be 0x hex`);
  if (bytes !== undefined && v.length !== 2 + 2 * bytes) throw new BadRequest(`${what} must be ${bytes} bytes`);
  return v.toLowerCase() as Hex;
}

export function bytes(v: unknown, what: string, length?: number): Uint8Array {
  return Buffer.from(hex(v, what, length).slice(2), "hex");
}

export function uint(v: unknown, what: string, bits = 256): bigint {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(v)) throw new BadRequest(`${what} must be a decimal string`);
  const n = BigInt(v);
  if (n >= 1n << BigInt(bits)) throw new BadRequest(`${what} is out of range`);
  return n;
}

export function smallInt(v: unknown, what: string, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max) throw new BadRequest(`${what} must be an integer from 0 to ${max}`);
  return v;
}

/** An action an agent key may ever sign (OstraVaultModuleV5.AGENT_ACTIONS). */
export function agentAction(v: unknown): VaultAction {
  const a = smallInt(v, "action", 63);
  if (((VAULT_AGENT_ACTIONS >> BigInt(a)) & 1n) === 0n) throw new BadRequest(`action ${a} is not one an agent key may sign`);
  return a as VaultAction;
}

/** JSON of a value with bigints as decimal strings and bytes as 0x hex. */
export function encode(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString("hex")}`;
  if (Array.isArray(v)) return v.map(encode);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}
