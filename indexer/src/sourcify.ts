// The source of every token the Ostra launchpad launches, verified on Sourcify (sourcify.dev), which passes the
// verification on to Robinhood Chain's Blockscout and Etherscan: scanners such as Go+ (GMGN, DEX Screener) report a
// token whose source is not verified as not open source. Robinhood Chain's Blockscout answers servers with a
// Cloudflare challenge (measured 23 Oct 2026), Sourcify does not, and it finds a factory-made contract's creation
// code by tracing the launch transaction.
//
// sourcify/ostra-token.input.json is OstraToken's standard JSON input: ostra-robinhood's sources of OstraToken and
// its imports with the deployment's settings (solc 0.8.30, optimizer 200 runs, cancun, no metadata hash). It
// compiles to the creation code of the tokens on mainnet (Sourcify: full match of creation and runtime code for
// tokens P and Ostra Test, 23 Oct 2026), and test/sourcify.test.ts checks its sources are the repository's.

import { readFileSync } from "node:fs";
import { getAddress, type Address, type Hash } from "viem";

export const SOURCIFY_API = "https://sourcify.dev/server";
export const TOKEN_INPUT_PATH = new URL("../sourcify/ostra-token.input.json", import.meta.url);
export const TOKEN_CONTRACT = "src/launchpad/OstraToken.sol:OstraToken";
export const TOKEN_COMPILER = "0.8.30+commit.73712a01";

export type SourcifyStatus = "verified" | "unverified";
export type SourcifyJob = { done: false } | { done: true; verified: boolean; error: string | null };

export type SourcifyOptions = { api?: string; chainId: number; input?: unknown; fetch?: typeof fetch; timeoutMs?: number };

export class Sourcify {
  readonly #api: string;
  readonly #chainId: number;
  readonly #input: unknown;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(o: SourcifyOptions) {
    this.#api = (o.api ?? SOURCIFY_API).replace(/\/+$/, "");
    this.#chainId = o.chainId;
    this.#input = o.input ?? JSON.parse(readFileSync(TOKEN_INPUT_PATH, "utf8"));
    this.#fetch = o.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = o.timeoutMs ?? 60_000;
  }

  async #json(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const res = await this.#fetch(`${this.#api}${path}`, { ...init, signal: AbortSignal.timeout(this.#timeoutMs), redirect: "error" });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  /** Whether Sourcify holds a verified source for `address` (a full or a partial match); throws when it cannot say. */
  async status(address: Address): Promise<SourcifyStatus> {
    const { status, body } = await this.#json(`/v2/contract/${this.#chainId}/${getAddress(address)}`);
    if (status === 404) return "unverified";
    if (status !== 200 || body === null) throw new Error(`Sourcify answered ${status} for ${address}`);
    return body.match === "match" || body.match === "exact_match" ? "verified" : "unverified";
  }

  /** Submits OstraToken's source for `address`, created in `creationTx`; the verification job's id. */
  async submit(address: Address, creationTx: Hash): Promise<string> {
    const { status, body } = await this.#json(`/v2/verify/${this.#chainId}/${getAddress(address)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stdJsonInput: this.#input, compilerVersion: TOKEN_COMPILER, contractIdentifier: TOKEN_CONTRACT, creationTransactionHash: creationTx }),
    });
    const id = body?.verificationId;
    if (status !== 202 || typeof id !== "string") throw new Error(`Sourcify refused the verification of ${address}: ${status} ${JSON.stringify(body).slice(0, 300)}`);
    return id;
  }

  /** The state of a verification job. */
  async job(id: string): Promise<SourcifyJob> {
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) throw new RangeError("not a verification id");
    const { status, body } = await this.#json(`/v2/verify/${id}`);
    if (status !== 200 || body === null) throw new Error(`Sourcify answered ${status} for job ${id}`);
    if (body.isJobCompleted !== true) return { done: false };
    const contract = (body.contract ?? null) as { match?: unknown } | null;
    const verified = contract?.match === "match" || contract?.match === "exact_match";
    const error = body.error === undefined || body.error === null ? null : JSON.stringify(body.error).slice(0, 300);
    return { done: true, verified, error };
  }
}
