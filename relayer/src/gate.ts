// The relayer gate (design v0.3, decided 15 Oct 2026; on Robinhood Chain,
// design v0.4). An agent posts calls to Ostra's contracts; the gate
//   1. checks the relayer's rules that need no simulation (debts, unpaid
//      opens, the terms of an open to the relayer, the CreateVault limit per
//      IP address);
//   2. checks the calls against its policy (the Kora allowed-program list on
//      Solana): createVault on the deployment's vault factory; spend,
//      requestClose and finalizeWithdraw on an Ostra vault of the deployment
//      in its token; spendLeaf, approveBatch, depositWithAuthorization,
//      cancelDeposit and closeDeposit on the deployment's pool. Nothing else
//      is sent, so the relayer's account is never the caller of anything
//      that gives a caller a role;
//   3. prices the transaction: eth_estimateGas from the relayer x eth_gasPrice,
//      + 10%, at Chainlink ETH/USD + 0.5% (@ostraagent/sdk relayer.ts, the
//      same rules an agent checks the price with);
//   4. answers 402 with an x402 batch-settlement challenge for that price,
//      paid to the relayer's OstraSplit with its vault as receiverAuthorizer
//      (merchant/src/merchant.ts); a voucher for it pays, and only then is
//      the transaction sent. A paid request sent again gets the same
//      transaction without a second charge.
// The challenge carries the price of this request; a voucher pays it only
// when it is worth exactly that price on top of the channel's charge, and it
// pays for the request it comes with (x402 has no per-request binding like
// the MPP `meta.tx` on Solana).
//
// Four kinds are relayed before payment, each the whole request: createVault
// on the factory (a debt of that vault, at most CREATE_VAULTS_PER_IP per IP
// address a day); spendLeaf alone into an Ostra vault in the relayer's token
// (a debt of that vault); createVault followed by spendLeaf into that new
// vault (unshield: one leaf into one new vault, which holds nothing else to
// pay with, so its creation and the leaf are its debt; no CreateVault slot of
// the IP address is taken); and an OpenChannel spend from a vault to the
// relayer on the relayer's terms, whose first voucher then pays the open and
// the vault's debt. A vault in debt, or with such an open unpaid, gets nothing
// else relayed but a spendLeaf into it while no open is unpaid.
//
// The request body is {"calls", "prepay"?, "payer"?}: `prepay` makes a
// createVault an ordinary paid request instead of a debt; `payer` names the
// Ostra vault whose relayer channel pays. That vault's credit is taken off the
// price (with a voucher from one of its channels, at least one base unit,
// authorizing it). GET /v1/vaults/<vault> (vaultState) shows a vault's debt,
// credit and unpaid open. On Solana the relayer fronted channel rent and
// credited lamports it got back; on Robinhood Chain there is no rent, so the
// fronted-channel limit, the rent sweeper and refunds are gone.
//
// Before anything else happens to a request, every WOTS signature in its
// calls is escrowed (signatures.ts). One whose key root already holds another
// message is refused with the stored record (409 key_reused), and nothing
// goes on when the chain or the escrow cannot be read or written (503
// escrow_unavailable). A signature not by the key the chain holds now can
// never pass the contract: it is not stored, and the request goes on as
// before (its simulation refuses it). A request sent again after it was
// relayed (paid, or an open to the relayer sent again to pay for it) was
// escrowed the first time, so the chain is not read for it again.

import type { IncomingMessage } from "node:http";
import { getAddress, isAddress, type Address, type PublicClient } from "viem";
import {
  MAX_RELAY_CALLS,
  RelaySimulationError,
  channelId,
  estimateRelay,
  readVault,
  vaultChannelConfig,
  weiToTokenUnits,
  withMargin,
  type Deployment,
  type EthUsd,
  type EthUsdSource,
} from "@ostraagent/sdk";
import { decodePaymentSignatureHeader, type HTTPResponseInstructions } from "@x402/core/http";
import type { OstraMerchant } from "../../merchant/src/merchant.ts";
import { classify, decodeRelayRequest, type Classified, type CreateVaultCall, type OpenChannelCall, type RelayTx, type SpendLeafCall } from "./calls.ts";
import {
  Ledger,
  LedgerRefusal,
  createVaultLimitReached,
  creditOf,
  creditPlan,
  debtOf,
  pruneQuotes,
  returnCreateVaultSlot,
  takeCreateVaultSlot,
  type LedgerData,
  type Quote,
} from "./ledger.ts";
import { NotSentError, SendUnknownError, type Landed } from "./send.ts";
import { escrowRecords, wotsClaims, type SignatureEscrow, type SignatureRecord, type WotsClaim } from "./signatures.ts";

export type Log = (event: string, fields?: Record<string, unknown>) => void;

/** What the gate answers: status, headers and a JSON body. */
export type Answer = { status: number; headers: Record<string, string>; body: unknown };

/** The parts of the relayer's Ostra seller method the gate uses (merchant.ts createOstraMerchant). */
export type GateMerchant = Pick<OstraMerchant, "payment" | "splits" | "split" | "gracePeriodSeconds" | "token" | "decimals">;

export type GateOptions = {
  client: PublicClient;
  deployment: Deployment;
  ledger: Ledger;
  /** Where the WOTS signatures of relay requests are escrowed (signatures.ts). */
  escrow: SignatureEscrow;
  merchant: GateMerchant;
  /** Sends the relayed transactions (send.ts): the relayer's account. */
  sender: { readonly address: Address; send(tx: { to: Address; data: `0x${string}` }): Promise<Landed> };
  /** The relayer's Ostra vault: the receiverAuthorizer of its channels. */
  vault: Address;
  /** The Chainlink feed ETH/USD is read from (shown in the relayer's terms). */
  priceFeed: Address;
  /** ETH/USD, checked and fresh (the SDK's chainlinkEthUsd on priceFeed). */
  ethUsd: EthUsdSource;
  log: Log;
};

export type RelayInput = { body: string; req: IncomingMessage; ip: string };

/** What the request body asks besides the calls. */
type RelayRequest = { prepay: boolean; payer: Address | null };

const RELAY_DESCRIPTION = "Ostra relayer: one transaction";
const DEBT_NOTE = "the vault owes this amount; it is paid with the first voucher of the vault's channel to the relayer, and nothing else is relayed for the vault until then";

/**
 * The channel an x402 payment header pays from: undefined without a
 * PAYMENT-SIGNATURE header (the 402 follows), null when it names none. Only
 * read to choose whose credit applies; the x402 scheme verifies the payment.
 */
export function paymentChannel(header: string | undefined): { payer: Address; receiverAuthorizer: Address } | null | undefined {
  if (header === undefined || header === "") return undefined;
  try {
    const payload = decodePaymentSignatureHeader(header);
    const config = (payload.payload as { channelConfig?: { payer?: unknown; receiverAuthorizer?: unknown } } | undefined)?.channelConfig;
    if (config === undefined || typeof config.payer !== "string" || typeof config.receiverAuthorizer !== "string") return null;
    if (!isAddress(config.payer, { strict: false }) || !isAddress(config.receiverAuthorizer, { strict: false })) return null;
    return { payer: getAddress(config.payer), receiverAuthorizer: getAddress(config.receiverAuthorizer) };
  } catch {
    return null;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Answer {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers }, body };
}

function fromInstructions(r: HTTPResponseInstructions): Answer {
  return { status: r.status, headers: { ...r.headers }, body: r.body };
}

/** The quote could not be made (answered 422, or 503 without a usable price). */
export class QuoteError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "QuoteError";
    this.code = code;
  }
}

/** The calls are outside the relayer's policy (answered 422 refused, as a Kora refusal was). */
export class PolicyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyRefusal";
  }
}

const POOL_FNS = new Set(["spendLeaf", "approveBatch", "depositWithAuthorization", "cancelDeposit", "closeDeposit"]);
const VAULT_FNS = new Set(["spend", "requestClose", "finalizeWithdraw"]);

export class RelayerGate {
  readonly #o: GateOptions;
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(o: GateOptions) {
    this.#o = o;
  }

  /** Public terms of the relayer. */
  facts(): Record<string, unknown> {
    return {
      chainId: this.#o.deployment.chainId,
      feePayer: this.#o.sender.address,
      vault: this.#o.vault,
      token: this.#o.merchant.token,
      decimals: this.#o.merchant.decimals,
      gracePeriodSeconds: this.#o.merchant.gracePeriodSeconds,
      splits: this.#o.merchant.splits,
      split: this.#o.merchant.split,
      priceFeed: this.#o.priceFeed,
      maxCalls: MAX_RELAY_CALLS,
    };
  }

  /** What the relayer holds for `vault`: its debt, its credit, and an open to the relayer relayed before payment with the calls that pay it when sent again. */
  vaultState(vault: Address): Record<string, unknown> {
    const view = this.#o.ledger.view();
    const open = view.opens[vault];
    return {
      vault,
      debt: debtOf(view, vault).toString(),
      credit: creditOf(view, vault).toString(),
      unpaidOpen: open === undefined ? null : { channel: open.channel, amount: open.amount, txHash: open.txHash, calls: open.calls },
    };
  }

  async relay(input: RelayInput): Promise<Answer> {
    let tx: RelayTx;
    let body: { calls?: unknown; prepay?: unknown; payer?: unknown };
    try {
      body = JSON.parse(input.body) as typeof body;
      if (body === null || typeof body !== "object") throw new Error("the request must be a JSON object");
      tx = decodeRelayRequest(body);
    } catch (err) {
      return json(400, { error: "bad_transaction", message: (err as Error).message });
    }
    // The WOTS signatures in it have left the client: escrowed before anything else.
    const escrowed = await this.#escrow(tx);
    if (escrowed !== null) return escrowed;
    let request: RelayRequest;
    try {
      if (body.prepay !== undefined && typeof body.prepay !== "boolean") throw new Error("prepay must be true or false");
      if (body.payer !== undefined && (typeof body.payer !== "string" || !isAddress(body.payer, { strict: false }))) throw new Error("payer must be a vault address");
      request = { prepay: body.prepay === true, payer: body.payer === undefined ? null : getAddress(body.payer as string) };
    } catch (err) {
      return json(400, { error: "bad_transaction", message: (err as Error).message });
    }
    if (request.payer !== null) {
      const v = await readVault(this.#o.client, this.#o.deployment, request.payer).catch(() => null);
      if (v === null || v.token !== this.#o.merchant.token) return json(400, { error: "bad_payer", message: `payer ${request.payer} is not an Ostra vault in ${this.#o.merchant.token}` });
    }
    return this.#serialized(tx.hash, () => this.#relay(tx, request, input));
  }

  /**
   * Escrows every WOTS signature in `tx` (signatures.ts); the answer refusing
   * the request, or null to go on.
   */
  async #escrow(tx: RelayTx): Promise<Answer | null> {
    let claims: WotsClaim[];
    try {
      claims = wotsClaims(tx.parsed, tx.calls, this.#o.deployment);
    } catch (err) {
      return json(400, { error: "bad_transaction", message: (err as Error).message });
    }
    if (claims.length === 0) return null;
    // Sent again after it was relayed: escrowed then, and its keys may be used by now.
    const view = this.#o.ledger.view();
    if (view.paid[tx.hash] !== undefined || Object.values(view.opens).some((o) => o.hash === tx.hash)) return null;
    const unavailable = (what: string, err: unknown) => {
      this.#o.log("escrow_unavailable", { request: tx.hash, what, error: err instanceof Error ? err.message : String(err) });
      return json(503, { error: "escrow_unavailable", message: `the WOTS signatures could not be escrowed (${what}); nothing was sent, try again` });
    };
    let records: (SignatureRecord | null)[];
    try {
      records = await escrowRecords(this.#o.client, this.#o.deployment, claims, Date.now());
    } catch (err) {
      return unavailable("chain read failed", err);
    }
    // A signature not by the key the chain holds now is not stored: the contract refuses it.
    const current = records.filter((r): r is SignatureRecord => r !== null);
    if (current.length === 0) return null;
    let put: { conflict: SignatureRecord | null; added: string[] };
    try {
      put = await this.#o.escrow.put(current);
    } catch (err) {
      return unavailable("escrow write failed", err);
    }
    if (put.conflict !== null) {
      return json(409, {
        error: "key_reused",
        message: `WOTS key ${put.conflict.keyRoot} already signed another message; send that signed message again instead`,
        signature: put.conflict,
      });
    }
    if (put.added.length > 0) this.#o.log("signatures_escrowed", { request: tx.hash, keyRoots: put.added });
    return null;
  }

  /** Runs `run` after every earlier run with the same key has finished. */
  async #serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const next = prev.then(run, run);
    const tail = next.catch(() => undefined);
    this.#locks.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }

  async #relay(tx: RelayTx, request: RelayRequest, input: RelayInput): Promise<Answer> {
    const done = this.#o.ledger.view().paid[tx.hash];
    if (done !== undefined) return json(200, { txHash: done.txHash, paid: done.amount, repeated: true });

    let classified: Classified;
    try {
      classified = classify(tx, this.#o.deployment, this.#o.vault, request.prepay);
    } catch (err) {
      return json(400, { error: "bad_transaction", message: (err as Error).message });
    }
    // An open to the relayer that was relayed before payment is paid by sending it again.
    if (classified.kind === "open_relayer_channel") {
      const pending = this.#o.ledger.view().opens[classified.ix.vault];
      if (pending !== undefined && pending.hash === tx.hash) return this.#payOpen(tx, classified.ix.vault, pending.txHash, BigInt(pending.amount), input);
    }

    // A spendLeaf relayed before payment acts for the vault it pays into.
    let leafVault: Address | null = null;
    if (classified.kind === "spend_leaf") {
      const resolved = await this.#leafVault(classified.ix);
      if (!(typeof resolved === "string")) return resolved;
      leafVault = resolved;
    }
    if (classified.kind === "unshield_vault") {
      const problem = await this.#unshieldProblem(classified.create, classified.leaf);
      if (problem !== null) return problem;
    }
    if (classified.kind === "create_vault") {
      const problem = await this.#createProblem(classified.ix);
      if (problem !== null) return problem;
    }
    let openProblem: string | null = null;
    if (classified.kind === "open_relayer_channel") openProblem = await this.#termsProblem(classified.ix);

    const early = this.#refusedUpfront(classified, input.ip, leafVault, openProblem);
    if (early !== null) return early;

    let quote: Quote;
    try {
      quote = await this.#quote(tx, classified, leafVault);
    } catch (err) {
      if (err instanceof PolicyRefusal) return json(422, { error: "refused", message: err.message });
      if (err instanceof QuoteError) return json(err.code === "price_unavailable" ? 503 : 422, { error: err.code, message: err.message });
      throw err;
    }

    try {
      // Everything relayed before payment changes debts and opens under one lock,
      // so the debt a vault has is in what its open's first voucher owes, or waits for it.
      if (classified.kind === "spend_leaf") {
        const vault = leafVault as Address;
        return await this.#serialized("debts", () => this.#spendLeaf(tx, vault, quote));
      }
      if (classified.kind === "unshield_vault") {
        const vault = classified.create.vault;
        return await this.#serialized("debts", () => this.#unshieldVault(tx, vault, quote));
      }
      if (classified.kind === "create_vault") {
        const vault = classified.ix.vault;
        return await this.#serialized("debts", () => this.#createVault(tx, vault, quote, input.ip));
      }
      if (classified.kind === "open_relayer_channel") {
        const ix = classified.ix;
        return await this.#serialized("debts", () => this.#openRelayerChannel(tx, ix, quote));
      }
      return await this.#paid(tx, classified.vaults, quote, input, request.payer);
    } catch (err) {
      if (err instanceof LedgerRefusal) return json(403, { error: err.code, message: err.message });
      throw err;
    }
  }

  /** The answer to a request the relayer's rules refuse before any simulation, or null. */
  #refusedUpfront(classified: Classified, ip: string, leafVault: Address | null, openProblem: string | null): Answer | null {
    const view = this.#o.ledger.view();
    if (classified.kind === "spend_leaf") return this.#openUnpaid(view.opens[leafVault as Address], leafVault as Address);
    // The vault an unshield creates owes nothing yet; its token and destination were checked (#unshieldProblem).
    if (classified.kind === "unshield_vault") return null;
    if (classified.kind === "create_vault") {
      const limit = createVaultLimitReached(view, ip, Date.now());
      return limit === null ? null : json(403, { error: limit.code, message: limit.message });
    }
    if (classified.kind === "open_relayer_channel") {
      const pending = view.opens[classified.ix.vault];
      if (pending !== undefined) return json(403, { error: "open_unpaid", message: `pay for the open of channel ${pending.channel} first: send that request again with a voucher` });
      return openProblem === null ? null : json(400, { error: "not_relayer_terms", message: openProblem });
    }
    for (const v of classified.vaults) {
      if (view.debts[v] !== undefined || view.opens[v] !== undefined) {
        return json(403, {
          error: "vault_in_debt",
          message: `vault ${v} owes the relayer; open a channel to the relayer's vault ${this.#o.vault} and pay its first voucher first`,
        });
      }
    }
    return null;
  }

  /** 403 when `vault` has an open to the relayer that is not paid yet (`pending`), or null. */
  #openUnpaid(pending: { channel: string } | undefined, vault: Address): Answer | null {
    if (pending === undefined) return null;
    return json(403, { error: "open_unpaid", message: `vault ${vault} has the open of channel ${pending.channel} unpaid: send that request again with a voucher first` });
  }

  /**
   * The Ostra vault a spendLeaf relayed before payment pays into: its
   * destination must be an Ostra vault in the relayer's token. Otherwise the
   * answer refusing it. (On Solana: the vault's associated token account.)
   */
  async #leafVault(ix: SpendLeafCall): Promise<Address | Answer> {
    const token = this.#o.merchant.token;
    const v = await readVault(this.#o.client, this.#o.deployment, ix.destination);
    if (v === null) return json(400, { error: "not_a_vault", message: `a spendLeaf is relayed before payment only into an Ostra vault in ${token}: ${ix.destination} is not an Ostra vault` });
    if (v.token !== token) return json(400, { error: "wrong_mint", message: `the relayer serves vaults in ${token}` });
    return v.vault;
  }

  /** Why a createVault relayed before payment is refused (another token, or a vault that exists already), or null. */
  async #createProblem(ix: CreateVaultCall): Promise<Answer | null> {
    if (ix.token !== this.#o.merchant.token) return json(400, { error: "wrong_mint", message: `the relayer serves vaults in ${this.#o.merchant.token}` });
    const code = await this.#o.client.getCode({ address: ix.vault });
    if (code !== undefined && code !== "0x") return json(400, { error: "vault_exists", message: `vault ${ix.vault} exists already` });
    return null;
  }

  /**
   * Why a createVault followed by spendLeaf is not an unshield the relayer
   * pays for (the leaf must land in the new vault, in the relayer's token),
   * or null.
   */
  async #unshieldProblem(create: CreateVaultCall, leaf: SpendLeafCall): Promise<Answer | null> {
    if (create.token !== this.#o.merchant.token) return json(400, { error: "wrong_mint", message: `the relayer serves vaults in ${this.#o.merchant.token}` });
    if (leaf.destination !== create.vault) return json(400, { error: "not_a_vault", message: `an unshield must spend the leaf into the vault it creates, ${create.vault}` });
    const code = await this.#o.client.getCode({ address: create.vault });
    if (code !== undefined && code !== "0x") return json(400, { error: "not_a_vault", message: `an unshield must create a new vault; ${create.vault} exists already` });
    return null;
  }

  /** Why an open to the relayer is not on the relayer's terms (the deposit aside), or null. */
  async #termsProblem(ix: OpenChannelCall): Promise<string | null> {
    const token = this.#o.merchant.token;
    const v = await readVault(this.#o.client, this.#o.deployment, ix.vault);
    if (v === null) return `${ix.vault} is not an Ostra vault`;
    if (v.token !== token) return `the channel must be in ${token}`;
    if (getAddress(ix.open.receiver) !== this.#o.merchant.split) return `the splits must be the relayer's splits: the channel must pay the relayer's split ${this.#o.merchant.split}`;
    if (ix.open.withdrawDelay !== this.#o.merchant.gracePeriodSeconds) return `the grace period must be ${this.#o.merchant.gracePeriodSeconds} s`;
    if (/^0x0{40}$/i.test(ix.open.payerAuthorizer)) return "the channel has no voucher key (payerAuthorizer)";
    return null;
  }

  /** Why the calls are outside the relayer's policy, or null (see the header). */
  async #policyProblem(tx: RelayTx): Promise<string | null> {
    const d = this.#o.deployment;
    for (const [i, c] of tx.parsed.entries()) {
      const name = c.fn ?? c.selector;
      if (c.to === d.vaultFactory) {
        if (c.fn !== "createVault") return `calls[${i}]: ${name} on the vault factory ${c.to} is not relayed`;
        continue;
      }
      if (c.to === d.pool) {
        if (c.fn === null || !POOL_FNS.has(c.fn)) return `calls[${i}]: ${name} on the pool ${c.to} is not relayed`;
        continue;
      }
      if (c.fn === null || !VAULT_FNS.has(c.fn)) return `calls[${i}]: ${name} on ${c.to} is not relayed`;
      const v = await readVault(this.#o.client, d, c.to);
      if (v === null || v.token !== this.#o.merchant.token) return `calls[${i}]: ${c.to} is not an Ostra vault in ${this.#o.merchant.token}`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Quote
  // -------------------------------------------------------------------------

  async #quote(tx: RelayTx, classified: Classified, leafVault: Address | null): Promise<Quote> {
    const known = this.#o.ledger.view().quotes[tx.hash];
    if (known !== undefined) return known;
    const problem = await this.#policyProblem(tx);
    if (problem !== null) throw new PolicyRefusal(problem);

    let m: { gas: bigint; gasPrice: bigint; wei: bigint };
    try {
      m = await estimateRelay(this.#o.client, { relayer: this.#o.sender.address, to: tx.to, data: tx.data });
    } catch (err) {
      if (err instanceof RelaySimulationError) throw new QuoteError(err.code, err.message);
      throw err;
    }

    let amount: bigint;
    let price: EthUsd;
    try {
      price = await this.#o.ethUsd();
      amount = weiToTokenUnits(withMargin(m.wei), price, this.#o.merchant.decimals);
    } catch (err) {
      throw new QuoteError("price_unavailable", `no usable ETH/USD price: ${(err as Error).message}`);
    }

    const quote: Quote = {
      amount: amount.toString(),
      wei: m.wei.toString(),
      gas: m.gas.toString(),
      gasPrice: m.gasPrice.toString(),
      ethUsd: price.answer.toString(),
      to: tx.to,
      data: tx.data,
      kind: classified.kind,
      vaults:
        classified.kind === "other"
          ? classified.vaults
          : classified.kind === "spend_leaf"
            ? [leafVault as Address]
            : classified.kind === "unshield_vault"
              ? [classified.create.vault]
              : [classified.ix.vault],
      createdAt: Date.now(),
    };
    await this.#o.ledger.update((data) => {
      pruneQuotes(data, Date.now());
      data.quotes[tx.hash] = quote;
    });
    this.#o.log("quoted", { request: tx.hash, kind: quote.kind, gas: quote.gas, gasPrice: quote.gasPrice, wei: quote.wei, ethUsd: quote.ethUsd, amount: quote.amount, vaults: quote.vaults });
    return quote;
  }

  #send(quote: Quote): Promise<Landed> {
    return this.#o.sender.send({ to: getAddress(quote.to), data: quote.data as `0x${string}` });
  }

  #unknown(tx: RelayTx, err: SendUnknownError, headers: Record<string, string> = {}): Answer {
    this.#o.log("send_unknown", { request: tx.hash, txHash: err.txHash, error: err.message });
    return json(503, { error: "send_unknown", txHash: err.txHash, message: `${err.message}; it may still land: check the transaction before sending the request again` }, headers);
  }

  // -------------------------------------------------------------------------
  // Kinds
  // -------------------------------------------------------------------------

  async #createVault(tx: RelayTx, vault: Address, quote: Quote, ip: string): Promise<Answer> {
    const now = Date.now();
    await this.#o.ledger.update((data) => {
      takeCreateVaultSlot(data, ip, now);
      const prior = data.debts[vault];
      data.debts[vault] = { amount: (BigInt(prior?.amount ?? "0") + BigInt(quote.amount)).toString(), txs: [...(prior?.txs ?? []), tx.hash] };
    });
    let landed: Landed;
    try {
      landed = await this.#send(quote);
    } catch (err) {
      if (err instanceof SendUnknownError) return this.#unknown(tx, err);
      await this.#o.ledger.update((data) => {
        returnCreateVaultSlot(data, ip, now);
        const d = data.debts[vault];
        if (d !== undefined) {
          const rest = BigInt(d.amount) - BigInt(quote.amount);
          const txs = d.txs.filter((h) => h !== tx.hash);
          if (rest > 0n && txs.length > 0) data.debts[vault] = { amount: rest.toString(), txs };
          else delete data.debts[vault];
        }
      });
      return json(409, { error: "not_sent", message: (err as Error).message });
    }
    await this.#o.ledger.update((data) => {
      data.paid[tx.hash] = { txHash: landed.txHash, amount: "0", at: Date.now() };
    });
    this.#o.log("vault_created_on_credit", { request: tx.hash, vault, txHash: landed.txHash, gasUsed: landed.gasUsed, effectiveGasPrice: landed.effectiveGasPrice, debt: quote.amount });
    return json(200, { txHash: landed.txHash, debt: quote.amount, note: DEBT_NOTE });
  }

  async #spendLeaf(tx: RelayTx, vault: Address, quote: Quote): Promise<Answer> {
    const unpaid = this.#openUnpaid(this.#o.ledger.view().opens[vault], vault);
    if (unpaid !== null) return unpaid;
    return this.#relayAsDebt(tx, vault, quote, "leaf_spent_on_credit");
  }

  /** createVault and spendLeaf into it (unshield): the new vault owes both. */
  async #unshieldVault(tx: RelayTx, vault: Address, quote: Quote): Promise<Answer> {
    return this.#relayAsDebt(tx, vault, quote, "vault_unshielded_on_credit");
  }

  /** Sends `tx` with its price added to `vault`'s debt (taken back if it is not sent). */
  async #relayAsDebt(tx: RelayTx, vault: Address, quote: Quote, event: string): Promise<Answer> {
    await this.#o.ledger.update((data) => {
      const prior = data.debts[vault];
      data.debts[vault] = { amount: (BigInt(prior?.amount ?? "0") + BigInt(quote.amount)).toString(), txs: [...(prior?.txs ?? []), tx.hash] };
    });
    let landed: Landed;
    try {
      landed = await this.#send(quote);
    } catch (err) {
      if (err instanceof SendUnknownError) return this.#unknown(tx, err);
      await this.#o.ledger.update((data) => {
        const d = data.debts[vault];
        if (d !== undefined) {
          const rest = BigInt(d.amount) - BigInt(quote.amount);
          const txs = d.txs.filter((h) => h !== tx.hash);
          if (rest > 0n && txs.length > 0) data.debts[vault] = { amount: rest.toString(), txs };
          else delete data.debts[vault];
        }
      });
      return json(409, { error: "not_sent", message: (err as Error).message });
    }
    await this.#o.ledger.update((data) => {
      data.paid[tx.hash] = { txHash: landed.txHash, amount: "0", at: Date.now() };
    });
    this.#o.log(event, { request: tx.hash, vault, txHash: landed.txHash, gasUsed: landed.gasUsed, effectiveGasPrice: landed.effectiveGasPrice, debt: quote.amount });
    return json(200, { txHash: landed.txHash, debt: quote.amount, note: DEBT_NOTE });
  }

  async #openRelayerChannel(tx: RelayTx, ix: OpenChannelCall, quote: Quote): Promise<Answer> {
    const view = this.#o.ledger.view();
    const pending = view.opens[ix.vault];
    if (pending !== undefined) return json(403, { error: "open_unpaid", message: `pay for the open of channel ${pending.channel} first: send that request again with a voucher` });
    const owed = BigInt(quote.amount) + debtOf(view, ix.vault);
    if (ix.open.amount < owed) return json(400, { error: "not_relayer_terms", message: `the deposit ${ix.open.amount} does not cover the ${owed} the first voucher must pay` });
    const d = this.#o.deployment;
    const channel = channelId(vaultChannelConfig(ix.vault, this.#o.merchant.token, ix.open), d.chainId, d.batchSettlement).toLowerCase();
    let landed: Landed;
    try {
      landed = await this.#send(quote);
    } catch (err) {
      if (err instanceof SendUnknownError) return this.#unknown(tx, err);
      return json(409, { error: "not_sent", message: (err as Error).message });
    }
    await this.#o.ledger.update((data) => {
      data.opens[ix.vault] = { hash: tx.hash, txHash: landed.txHash, channel, amount: owed.toString(), at: Date.now(), calls: tx.calls.map((c) => ({ to: c.to, data: c.data })) };
    });
    this.#o.log("relayer_channel_opened", { request: tx.hash, vault: ix.vault, channel, txHash: landed.txHash, gasUsed: landed.gasUsed, effectiveGasPrice: landed.effectiveGasPrice, owed });
    return json(200, {
      txHash: landed.txHash,
      channel,
      paymentDue: owed.toString(),
      note: "the open is relayed; send this request again and pay the 402 with the first voucher of this channel",
    });
  }

  async #payOpen(tx: RelayTx, vault: Address, txHash: string, owed: bigint, input: RelayInput): Promise<Answer> {
    const outcome = await this.#o.merchant.payment(input.req, { description: RELAY_DESCRIPTION, amount: owed });
    if (outcome.kind === "respond") return fromInstructions(outcome.response);
    const settled = await outcome.complete();
    if (!settled.ok) return fromInstructions(settled.response);
    await this.#o.ledger.update((data) => {
      delete data.opens[vault];
      delete data.debts[vault];
      data.paid[tx.hash] = { txHash, amount: owed.toString(), at: Date.now() };
    });
    this.#o.log("relayer_channel_paid", { request: tx.hash, vault, amount: owed, channel: outcome.channelId });
    return json(200, { txHash, paid: owed.toString() }, settled.headers);
  }

  async #paid(tx: RelayTx, vaults: readonly Address[], quote: Quote, input: RelayInput, payer: Address | null): Promise<Answer> {
    // Credit belongs to a vault: the payer the request names, else the one vault the request acts for.
    const creditVault = payer ?? (vaults.length === 1 ? (vaults[0] as Address) : null);
    if (creditVault === null) return this.#paidWithCredit(tx, vaults, quote, input, null);
    // A vault's credit is read and changed by one request at a time.
    return this.#serialized(`credit:${creditVault}`, () => this.#paidWithCredit(tx, vaults, quote, input, creditVault));
  }

  async #paidWithCredit(tx: RelayTx, vaults: readonly Address[], quote: Quote, input: RelayInput, creditVault: Address | null): Promise<Answer> {
    const view = this.#o.ledger.view();
    for (const v of vaults) {
      if (view.debts[v] !== undefined || view.opens[v] !== undefined) {
        throw new LedgerRefusal("vault_in_debt", `vault ${v} owes the relayer; open a channel to the relayer's vault ${this.#o.vault} and pay its first voucher first`);
      }
    }
    const price = BigInt(quote.amount);
    const plan = creditPlan({
      price,
      credit: creditVault === null ? 0n : creditOf(view, creditVault),
      actsForCreditVault: creditVault !== null && vaults.length === 1 && vaults[0] === creditVault,
    });
    /** Records a landed transaction: the credit it used, and its hash. */
    const landedIn = (data: LedgerData, txHash: string, paid: bigint) => {
      if (creditVault !== null) {
        const left = creditOf(data, creditVault) - plan.used;
        if (left > 0n) data.credits[creditVault] = left.toString();
        else delete data.credits[creditVault];
      }
      data.paid[tx.hash] = { txHash, amount: paid.toString(), at: Date.now() };
    };

    if (plan.owed === 0n) {
      // Paid from credit: nothing is charged, and the credit is used only if the transaction lands.
      let landed: Landed;
      try {
        landed = await this.#send(quote);
      } catch (err) {
        if (err instanceof SendUnknownError) return this.#unknown(tx, err);
        return json(409, { error: "not_sent", message: (err as Error).message, credit: { vault: creditVault, amount: plan.used.toString(), note: "unchanged" } });
      }
      await this.#o.ledger.update((data) => landedIn(data, landed.txHash, 0n));
      this.#o.log("relayed_from_credit", { request: tx.hash, txHash: landed.txHash, gasUsed: landed.gasUsed, effectiveGasPrice: landed.effectiveGasPrice, amount: quote.amount, creditVault });
      return json(200, { txHash: landed.txHash, paid: "0", fromCredit: quote.amount });
    }
    if (plan.voucherFromCreditVault) {
      // The credit is used only with a voucher from a channel of that vault: checked before the voucher is taken.
      const header = input.req.headers["payment-signature"];
      const channel = paymentChannel(Array.isArray(header) ? header.join(", ") : header);
      if (channel !== undefined && (channel === null || channel.payer !== creditVault || channel.receiverAuthorizer !== this.#o.vault)) {
        return json(403, {
          error: "wrong_payer",
          message: `the credit of vault ${creditVault} is used only with a voucher from a channel of that vault to the relayer's vault ${this.#o.vault}`,
        });
      }
    }
    const owed = plan.owed;
    const outcome = await this.#o.merchant.payment(input.req, { description: RELAY_DESCRIPTION, amount: owed });
    if (outcome.kind === "respond") return fromInstructions(outcome.response);
    // Paid: the voucher is charged first, then the transaction is sent.
    const settled = await outcome.complete();
    if (!settled.ok) return fromInstructions(settled.response);
    let landed: Landed;
    try {
      landed = await this.#send(quote);
    } catch (err) {
      if (err instanceof SendUnknownError) return this.#unknown(tx, err, settled.headers);
      if (!(err instanceof NotSentError)) this.#o.log("send_failed", { request: tx.hash, error: (err as Error).message });
      // The agent paid `owed` for a transaction that was not sent: it becomes credit (the credit it used is still unspent).
      await this.#o.ledger.update((data) => {
        if (creditVault !== null) data.credits[creditVault] = (creditOf(data, creditVault) + owed).toString();
      });
      this.#o.log("paid_not_sent", { request: tx.hash, amount: owed, creditVault, error: (err as Error).message });
      return json(
        409,
        {
          error: "not_sent",
          message: (err as Error).message,
          credit: creditVault === null ? null : { vault: creditVault, amount: owed.toString(), note: "taken off the vault's next relayed transaction" },
        },
        settled.headers,
      );
    }
    await this.#o.ledger.update((data) => landedIn(data, landed.txHash, owed));
    this.#o.log("relayed", { request: tx.hash, txHash: landed.txHash, gasUsed: landed.gasUsed, effectiveGasPrice: landed.effectiveGasPrice, amount: owed, creditUsed: plan.used, creditVault, channel: outcome.channelId });
    return json(200, { txHash: landed.txHash, paid: owed.toString(), ...(plan.used > 0n ? { fromCredit: plan.used.toString() } : {}) }, settled.headers);
  }
}
