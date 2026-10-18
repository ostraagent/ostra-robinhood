// The relayer gate (design v0.3, decided 15 Oct 2026; on Robinhood Chain,
// design v0.4). An agent posts calls to Ostra's contracts; the gate
//   1. checks the relayer's rules that need no simulation (debts, unpaid
//      opens, the terms of an open to the relayer, the CreateVault limit per
//      IP address);
//   2. checks the calls against its policy (the Kora allowed-program list on
//      Solana): createVault on the deployment's vault factory; spend,
//      requestClose and finalizeWithdraw on an Ostra vault of the deployment
//      in its token; spendLeaf, approveBatch, depositWithAuthorization,
//      cancelDeposit and closeDeposit on the deployment's pool; and on its
//      launchpad (design v0.4, D2): OstraDevBuy.launchFromVault alone, from a
//      creator vault in the relayer's token or in WETH (the relayer fronts
//      the ETH launch fee and charges it), OstraAirdrop claim and close,
//      OstraDispatcher.claimReferral, OstraCreatorSplit.release, and release
//      and claimDividends of an OstraVesting OstraDevBuy made
//      (vestingPool). Vaults in another token (a WETH creator vault, a vault
//      holding a token the launchpad launched, launchpad.poolOf) spend only
//      Transfer, Swap and ClaimDividend (a WETH vault ConfigurePool too),
//      paid by a `payer` vault in the relayer's token; dividends (a vesting's,
//      a launched-token vault's ClaimDividend) only of a pool paying them in
//      USDG, WETH or a launched token. Nothing else is sent, so the relayer's
//      account is never the caller of anything that gives a caller a role,
//      and no code runs but Ostra's, USDG's, WETH's and the launchpad's,
//      except the pool, hook and tokens a vault Swap names (within the gas cap
//      the request paid for);
//   3. prices the transaction: the gas it uses, simulated from the relayer
//      (eth_simulateV1), with its L1 data component and the swapGas each
//      vault Swap in it reserves, x eth_gasPrice, + 10%, at Chainlink
//      ETH/USD + 0.5% (@ostraagent/sdk relayer.ts, the same rules an agent
//      checks the price with). A vault Swap the simulation shows failing
//      (SwapFailed) is refused, 422 swap_fails, unless the request asks for
//      it with allowFailedSwaps: such a spend moves nothing and is only worth
//      sending to use the key up. A Swap quoted while it passed is simulated
//      again when the request comes back to be paid, before the voucher is
//      taken (one that reverts then is refused 422, a node that cannot
//      simulate it 503), and once more just before it is sent
//      (relayer/src/send.ts): the price can move in between. What moves in
//      the moment between that last simulation and the block is the agent's
//      (its minOut and swapGas). Every transaction is sent with a gas limit
//      of at most what it was priced at plus the margin (relayGasCap): code
//      that uses more gas when sent than simulated (a hook or a contract the
//      agent picks) cannot make the relayer pay more than it was paid, and a
//      transaction that needs more than that now is not sent. A request with
//      a WOTS signature the escrow did not take (not by the key the chain
//      holds, as the relayer rebuilds its message) that simulates fine is
//      refused (422 signature_not_escrowed): its message is not the one the
//      escrow would protect;
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
// The request body is {"calls", "prepay"?, "payer"?, "allowFailedSwaps"?}: `prepay` makes a
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
//
// POST /v1/escrow (escrow) takes the same {"calls"} body and only escrows its
// WOTS signatures, for an agent that sends the transaction with its own fee
// payer: 200 once they are held (or can never pass the contract), 409
// key_reused with the stored record, 503 escrow_unavailable, 400 for a body
// without a WOTS signature.

import type { IncomingMessage } from "node:http";
import { getAddress, isAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  MAX_RELAY_CALLS,
  RelaySimulationError,
  VAULT_ACTION,
  WETH,
  channelId,
  estimateRelay,
  failedSwaps,
  ostraDevBuyAbi,
  ostraHookAbi,
  ostraLaunchpadAbi,
  readVault,
  relayGasCap,
  relayPriceWei,
  relayValue,
  relayTransactionHash,
  simulateRelay,
  vaultChannelConfig,
  weiToTokenUnits,
  withMargin,
  type Deployment,
  type EthUsd,
  type EthUsdSource,
  type RelayMeasure,
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
  sender: { readonly address: Address; send(tx: { to: Address; data: `0x${string}` }, o?: { refuseFailedSwaps?: readonly Address[]; maxGas?: bigint; value?: bigint }): Promise<Landed> };
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
type RelayRequest = { prepay: boolean; payer: Address | null; allowFailedSwaps: boolean };

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

/** The vaults a request spends from with a Swap: only a vault Swap fails without reverting (SwapFailed), moving nothing and using the spend. */
function swapVaults(tx: RelayTx): Address[] {
  return tx.parsed.flatMap((c) => (c.fn === "spend" && c.action === VAULT_ACTION.SWAP ? [c.to] : []));
}

/** Throws swap_fails if a Swap of the vaults `swaps` fails among the simulated `logs`. */
function refuseFailedSwaps(logs: RelayMeasure["logs"], swaps: readonly Address[]): void {
  if (swaps.length === 0) return;
  const failed = failedSwaps(logs, swaps);
  if (failed.length === 0) return;
  const which = failed.map((f) => `vault ${f.vault} in pool ${f.poolId} (${f.reason})`).join(", ");
  throw new QuoteError("swap_fails", `the Swap of ${which} fails now and would move nothing; send it with allowFailedSwaps to use the spend up anyway`);
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
    let body: { calls?: unknown; prepay?: unknown; payer?: unknown; allowFailedSwaps?: unknown };
    try {
      body = JSON.parse(input.body) as typeof body;
      if (body === null || typeof body !== "object") throw new Error("the request must be a JSON object");
      tx = decodeRelayRequest(body);
    } catch (err) {
      return json(400, { error: "bad_transaction", message: (err as Error).message });
    }
    // The WOTS signatures in it have left the client: escrowed before anything else.
    const escrowed = await this.#escrow(tx);
    if (escrowed.answer !== null) return escrowed.answer;
    let request: RelayRequest;
    try {
      if (body.prepay !== undefined && typeof body.prepay !== "boolean") throw new Error("prepay must be true or false");
      if (body.payer !== undefined && (typeof body.payer !== "string" || !isAddress(body.payer, { strict: false }))) throw new Error("payer must be a vault address");
      if (body.allowFailedSwaps !== undefined && typeof body.allowFailedSwaps !== "boolean") throw new Error("allowFailedSwaps must be true or false");
      request = {
        prepay: body.prepay === true,
        payer: body.payer === undefined ? null : getAddress(body.payer as string),
        allowFailedSwaps: body.allowFailedSwaps === true,
      };
    } catch (err) {
      return json(400, { error: "bad_transaction", message: (err as Error).message });
    }
    if (request.payer !== null) {
      const v = await readVault(this.#o.client, this.#o.deployment, request.payer).catch(() => null);
      if (v === null || v.token !== this.#o.merchant.token) return json(400, { error: "bad_payer", message: `payer ${request.payer} is not an Ostra vault in ${this.#o.merchant.token}` });
    }
    return this.#serialized(tx.hash, () => this.#relay(tx, request, input, escrowed.unescrowed));
  }

  /** POST /v1/escrow: escrows the WOTS signatures of `calls` without relaying them. */
  async escrow(input: { body: string }): Promise<Answer> {
    let tx: RelayTx;
    try {
      const body = JSON.parse(input.body) as { calls?: unknown };
      if (body === null || typeof body !== "object") throw new Error("the request must be a JSON object");
      tx = decodeRelayRequest(body);
      if (wotsClaims(tx.parsed, tx.calls, this.#o.deployment).length === 0) {
        return json(400, { error: "no_signatures", message: "the calls carry no WOTS signature to escrow" });
      }
    } catch (err) {
      return json(400, { error: "bad_transaction", message: (err as Error).message });
    }
    const refused = (await this.#escrow(tx)).answer;
    return refused ?? json(200, { escrowed: true, request: tx.hash });
  }

  /**
   * Escrows every WOTS signature in `tx` (signatures.ts): the answer refusing
   * the request, or null to go on, and how many of its signatures were not
   * escrowed (not by the key the chain holds now, as rebuilt here).
   */
  async #escrow(tx: RelayTx): Promise<{ answer: Answer | null; unescrowed: number }> {
    const go = (unescrowed = 0) => ({ answer: null, unescrowed });
    const stop = (answer: Answer) => ({ answer, unescrowed: 0 });
    let claims: WotsClaim[];
    try {
      claims = wotsClaims(tx.parsed, tx.calls, this.#o.deployment);
    } catch (err) {
      return stop(json(400, { error: "bad_transaction", message: (err as Error).message }));
    }
    if (claims.length === 0) return go();
    // Sent again after it was relayed: escrowed then, and its keys may be used by now.
    const view = this.#o.ledger.view();
    if (view.paid[tx.hash] !== undefined || Object.values(view.opens).some((o) => o.hash === tx.hash)) return go();
    const unavailable = (what: string, err: unknown) => {
      this.#o.log("escrow_unavailable", { request: tx.hash, what, error: err instanceof Error ? err.message : String(err) });
      return stop(json(503, { error: "escrow_unavailable", message: `the WOTS signatures could not be escrowed (${what}); nothing was sent, try again` }));
    };
    let records: (SignatureRecord | null)[];
    try {
      records = await escrowRecords(this.#o.client, this.#o.deployment, claims, Date.now());
    } catch (err) {
      return unavailable("chain read failed", err);
    }
    // A signature not by the key the chain holds now is not stored: the contract refuses it (the simulation decides).
    const current = records.filter((r): r is SignatureRecord => r !== null);
    const unescrowed = records.length - current.length;
    if (current.length === 0) return go(unescrowed);
    let put: { conflict: SignatureRecord | null; added: string[] };
    try {
      put = await this.#o.escrow.put(current);
    } catch (err) {
      return unavailable("escrow write failed", err);
    }
    if (put.conflict !== null) {
      return stop(
        json(409, {
          error: "key_reused",
          message: `WOTS key ${put.conflict.keyRoot} already signed another message; send that signed message again instead`,
          signature: put.conflict,
        }),
      );
    }
    if (put.added.length > 0) this.#o.log("signatures_escrowed", { request: tx.hash, keyRoots: put.added });
    return go(unescrowed);
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

  async #relay(tx: RelayTx, request: RelayRequest, input: RelayInput, unescrowed: number): Promise<Answer> {
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

    // The vaults whose Swap in this request must not fail (SwapFailed); none with allowFailedSwaps.
    const swaps = request.allowFailedSwaps ? [] : swapVaults(tx);
    let quote: Quote;
    try {
      quote = await this.#quote(tx, classified, leafVault, swaps, request, unescrowed);
    } catch (err) {
      if (err instanceof PolicyRefusal) return json(422, { error: "refused", message: err.message });
      if (err instanceof QuoteError) return json(err.code === "price_unavailable" || err.code === "simulation_unavailable" ? 503 : 422, { error: err.code, message: err.message });
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
      return await this.#paid(tx, classified.vaults, quote, input, request.payer, swaps);
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
  async #policyProblem(tx: RelayTx, request: RelayRequest): Promise<string | null> {
    const d = this.#o.deployment;
    const l = d.launchpad;
    const token = this.#o.merchant.token;
    const wethOrLaunched = async (t: Address): Promise<"weth" | "launched" | null> => {
      if (t === WETH) return "weth";
      if (l === undefined) return null;
      const id = (await this.#o.client.readContract({ address: l.launchpad, abi: ostraLaunchpadAbi, functionName: "poolOf", args: [t] })) as Hex;
      return BigInt(id) === 0n ? null : "launched";
    };
    // Dividends move the pool's dividend token: relayed only when its code is known (USDG, WETH, a launched token).
    const dividendProblem = async (i: number, id: Hex): Promise<string | null> => {
      if (l === undefined) return null;
      const c = (await this.#o.client.readContract({ address: l.hook, abi: ostraHookAbi, functionName: "poolConfig", args: [id] })) as { dividendToken: Address };
      const t = getAddress(c.dividendToken);
      if (t === token || t === WETH || BigInt(t) === 0n) return null;
      if ((await wethOrLaunched(t)) === "launched") return null;
      return `calls[${i}]: the pool pays dividends in ${t}, not USDG, WETH or a launched token; its dividends are not relayed`;
    };
    for (const [i, c] of tx.parsed.entries()) {
      const name = c.fn ?? c.selector;
      if (c.to === d.vaultFactory) {
        if (c.fn !== "createVault") return `calls[${i}]: ${name} on the vault factory ${c.to} is not relayed`;
        if (c.token !== token) {
          if ((await wethOrLaunched(c.token)) === null) return `calls[${i}]: vaults are created in ${token}, WETH or a token the Ostra launchpad launched, not ${c.token}`;
          if (request.payer === null) return `calls[${i}]: a vault in ${c.token} is paid for by a payer vault in ${token}`;
        }
        continue;
      }
      if (c.to === d.pool) {
        if (c.fn === null || !POOL_FNS.has(c.fn)) return `calls[${i}]: ${name} on the pool ${c.to} is not relayed`;
        continue;
      }
      if (l !== undefined && c.fn === "launchFromVault" && c.to === l.devBuy) {
        if (tx.parsed.length !== 1) return `calls[${i}]: a launch is relayed alone`;
        const v = await readVault(this.#o.client, d, c.vault);
        if (v === null) return `calls[${i}]: the creator vault ${c.vault} is not an Ostra vault`;
        if (v.token !== token && v.token !== WETH) return `calls[${i}]: the relayer launches from creator vaults in ${token} or WETH`;
        if (v.token !== token && request.payer === null) return `calls[${i}]: a launch from a WETH creator vault is paid for by a payer vault in ${token}`;
        continue;
      }
      if (l !== undefined && (c.fn === "airdropClaim" || c.fn === "airdropClose")) {
        if (c.to !== l.airdrop) return `calls[${i}]: ${name} on ${c.to} is not relayed`;
        continue;
      }
      if (l !== undefined && c.fn === "claimReferral") {
        if (c.to !== l.dispatcher) return `calls[${i}]: ${name} on ${c.to} is not relayed`;
        continue;
      }
      if (l !== undefined && c.fn === "splitRelease") {
        if (c.to !== l.creatorSplit) return `calls[${i}]: ${name} on ${c.to} is not relayed`;
        continue;
      }
      if (l !== undefined && (c.fn === "vestingRelease" || c.fn === "vestingClaimDividends")) {
        const id = (await this.#o.client.readContract({ address: l.devBuy, abi: ostraDevBuyAbi, functionName: "vestingPool", args: [c.to] })) as Hex;
        if (BigInt(id) === 0n) return `calls[${i}]: ${c.to} is not an Ostra dev buy's vesting`;
        if (c.fn === "vestingClaimDividends") {
          const p = await dividendProblem(i, id);
          if (p !== null) return p;
        }
        continue;
      }
      if (c.fn === null || !VAULT_FNS.has(c.fn)) return `calls[${i}]: ${name} on ${c.to} is not relayed`;
      const v = await readVault(this.#o.client, d, c.to);
      if (v === null) return `calls[${i}]: ${c.to} is not an Ostra vault`;
      if (v.token === token) continue;
      // A vault in another token: only what that vault needs, its token's code the launchpad's (or WETH's), paid by a payer vault.
      const kind = await wethOrLaunched(v.token);
      if (kind === null) return `calls[${i}]: ${c.to} is not an Ostra vault in ${token}, WETH or a token the Ostra launchpad launched`;
      if (request.payer === null) return `calls[${i}]: a vault in ${v.token} is paid for by a payer vault in ${token}`;
      const allowed: readonly number[] =
        kind === "weth"
          ? [VAULT_ACTION.TRANSFER, VAULT_ACTION.SWAP, VAULT_ACTION.CONFIGURE_POOL, VAULT_ACTION.CLAIM_DIVIDEND]
          : [VAULT_ACTION.TRANSFER, VAULT_ACTION.SWAP, VAULT_ACTION.CLAIM_DIVIDEND];
      if (c.fn !== "spend" || !allowed.includes(c.action)) return `calls[${i}]: a vault in ${v.token} is relayed only for ${kind === "weth" ? "Transfer, Swap, ConfigurePool and ClaimDividend" : "Transfer, Swap and ClaimDividend"}`;
      if (kind === "launched" && c.action === VAULT_ACTION.CLAIM_DIVIDEND && l !== undefined) {
        const id = (await this.#o.client.readContract({ address: l.launchpad, abi: ostraLaunchpadAbi, functionName: "poolOf", args: [v.token] })) as Hex;
        const p = await dividendProblem(i, id);
        if (p !== null) return p;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Quote
  // -------------------------------------------------------------------------

  async #quote(tx: RelayTx, classified: Classified, leafVault: Address | null, swaps: readonly Address[], request: RelayRequest, unescrowed: number): Promise<Quote> {
    const known = this.#o.ledger.view().quotes[tx.hash];
    if (known !== undefined) {
      // The quote is kept by the calls alone: what the policy decides from the request (its payer) is decided again.
      const again = await this.#policyProblem(tx, request);
      if (again !== null) throw new PolicyRefusal(again);
      // Its signatures were escrowed when it was quoted; a key used since makes the send fail (not sent: credit).
      if (swaps.length !== 0) {
        let logs: RelayMeasure["logs"];
        try {
          logs = (await simulateRelay(this.#o.client, { relayer: this.#o.sender.address, to: tx.to, data: tx.data, value: relayValue(this.#o.deployment, tx) })).logs;
        } catch (err) {
          // A Swap that reverts now, or that the node cannot simulate, is refused before anything is charged.
          if (err instanceof RelaySimulationError) throw new QuoteError(err.code, err.message);
          throw err;
        }
        refuseFailedSwaps(logs, swaps);
      }
      return known;
    }
    const problem = await this.#policyProblem(tx, request);
    if (problem !== null) throw new PolicyRefusal(problem);

    let m: RelayMeasure;
    try {
      m = await estimateRelay(this.#o.client, { relayer: this.#o.sender.address, to: tx.to, data: tx.data, value: relayValue(this.#o.deployment, tx) });
    } catch (err) {
      if (err instanceof RelaySimulationError) throw new QuoteError(err.code, err.message);
      throw err;
    }
    // It passes the contract with a signature the escrow did not take: its message is not the one rebuilt here.
    if (unescrowed !== 0) {
      throw new QuoteError("signature_not_escrowed", "a WOTS signature in the request passes the contract but is not the message the relayer escrows; nothing is relayed for it");
    }
    refuseFailedSwaps(m.logs, swaps);

    let amount: bigint;
    let price: EthUsd;
    try {
      price = await this.#o.ethUsd();
      amount = weiToTokenUnits(relayPriceWei(m), price, this.#o.merchant.decimals);
    } catch (err) {
      throw new QuoteError("price_unavailable", `no usable ETH/USD price: ${(err as Error).message}`);
    }

    const quote: Quote = {
      amount: amount.toString(),
      wei: m.wei.toString(),
      value: m.value.toString(),
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
    this.#o.log("quoted", { request: tx.hash, kind: quote.kind, gas: quote.gas, gasPrice: quote.gasPrice, wei: quote.wei, value: quote.value, ethUsd: quote.ethUsd, amount: quote.amount, vaults: quote.vaults });
    return quote;
  }

  /**
   * Sends the quoted transaction with a gas limit of at most what it was priced at (relayGasCap); `swaps`: the
   * vaults whose Swap in it must not fail (the sender checks it just before sending).
   */
  async #send(quote: Quote, swaps: readonly Address[] = []): Promise<Landed> {
    const tx = { to: getAddress(quote.to), data: quote.data as `0x${string}` };
    try {
      return await this.#o.sender.send(tx, { refuseFailedSwaps: swaps, maxGas: relayGasCap(BigInt(quote.gas)), value: BigInt(quote.value ?? "0") });
    } catch (err) {
      // Its quote no longer holds: the request sent again is priced anew.
      if (err instanceof NotSentError && err.overCap) {
        const hash = relayTransactionHash(tx);
        await this.#o.ledger.update((data) => {
          delete data.quotes[hash];
        });
      }
      throw err;
    }
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

  async #paid(tx: RelayTx, vaults: readonly Address[], quote: Quote, input: RelayInput, payer: Address | null, swaps: readonly Address[]): Promise<Answer> {
    // Credit belongs to a vault: the payer the request names, else the one vault the request acts for.
    const creditVault = payer ?? (vaults.length === 1 ? (vaults[0] as Address) : null);
    if (creditVault === null) return this.#paidWithCredit(tx, vaults, quote, input, null, swaps);
    // A vault's credit is read and changed by one request at a time.
    return this.#serialized(`credit:${creditVault}`, () => this.#paidWithCredit(tx, vaults, quote, input, creditVault, swaps));
  }

  /**
   * What the relayer keeps of `upTo` (base units) when `err` is a transaction that reverted on-chain: its gas,
   * with the margin, at the quote's ETH/USD (0 for anything else, which cost the relayer nothing).
   */
  #keptOnRevert(err: unknown, quote: Quote, upTo: bigint): bigint {
    if (!(err instanceof NotSentError) || err.spentWei === 0n) return 0n;
    const cost = weiToTokenUnits(withMargin(err.spentWei), { answer: BigInt(quote.ethUsd), roundId: 0n, updatedAt: 0n }, this.#o.merchant.decimals);
    return cost < upTo ? cost : upTo;
  }

  async #paidWithCredit(tx: RelayTx, vaults: readonly Address[], quote: Quote, input: RelayInput, creditVault: Address | null, swaps: readonly Address[]): Promise<Answer> {
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
      // Paid from credit: nothing is charged, and the credit is used only if the transaction lands (less the gas
      // of one that reverted on-chain, which the relayer paid).
      let landed: Landed;
      try {
        landed = await this.#send(quote, swaps);
      } catch (err) {
        if (err instanceof SendUnknownError) return this.#unknown(tx, err);
        const kept = this.#keptOnRevert(err, quote, plan.used);
        if (kept > 0n && creditVault !== null) {
          await this.#o.ledger.update((data) => {
            const left = creditOf(data, creditVault) - kept;
            if (left > 0n) data.credits[creditVault] = left.toString();
            else delete data.credits[creditVault];
          });
          this.#o.log("credit_spent_on_revert", { request: tx.hash, amount: kept, creditVault, spentWei: (err as NotSentError).spentWei });
        }
        return json(409, {
          error: "not_sent",
          message: (err as Error).message,
          credit: { vault: creditVault, amount: (plan.used - kept).toString(), note: kept > 0n ? `the gas of the reverted transaction, ${kept}, was taken from the credit` : "unchanged" },
        });
      }
      await this.#o.ledger.update((data) => landedIn(data, landed.txHash, 0n));
      this.#o.log("relayed_from_credit", { request: tx.hash, txHash: landed.txHash, gasUsed: landed.gasUsed, effectiveGasPrice: landed.effectiveGasPrice, value: landed.value, amount: quote.amount, creditVault });
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
    // What is paid for a transaction that is not sent becomes credit: of the credit vault, or else of the Ostra
    // vault in the relayer's token whose channel the voucher is from.
    let creditTo = creditVault;
    if (creditTo === null) {
      const header = input.req.headers["payment-signature"];
      const channel = paymentChannel(Array.isArray(header) ? header.join(", ") : header);
      if (channel !== undefined && channel !== null) {
        const v = await readVault(this.#o.client, this.#o.deployment, channel.payer).catch(() => null);
        if (v !== null && v.token === this.#o.merchant.token) creditTo = channel.payer;
      }
    }
    const outcome = await this.#o.merchant.payment(input.req, { description: RELAY_DESCRIPTION, amount: owed });
    if (outcome.kind === "respond") return fromInstructions(outcome.response);
    // Paid: the voucher is charged first, then the transaction is sent.
    const settled = await outcome.complete();
    if (!settled.ok) return fromInstructions(settled.response);
    let landed: Landed;
    try {
      landed = await this.#send(quote, swaps);
    } catch (err) {
      if (err instanceof SendUnknownError) return this.#unknown(tx, err, settled.headers);
      if (!(err instanceof NotSentError)) this.#o.log("send_failed", { request: tx.hash, error: (err as Error).message });
      // The agent paid `owed` for a transaction that was not sent: it becomes credit (the credit it used is still
      // unspent), less the gas of one that reverted on-chain, which the relayer paid.
      const kept = this.#keptOnRevert(err, quote, owed);
      const credited = owed - kept;
      await this.#o.ledger.update((data) => {
        if (creditTo !== null && credited > 0n) data.credits[creditTo] = (creditOf(data, creditTo) + credited).toString();
      });
      this.#o.log("paid_not_sent", { request: tx.hash, amount: owed, kept, creditVault: creditTo, spentWei: err instanceof NotSentError ? err.spentWei : 0n, error: (err as Error).message });
      return json(
        409,
        {
          error: "not_sent",
          message: (err as Error).message,
          credit: creditTo === null ? null : { vault: creditTo, amount: credited.toString(), note: "taken off the vault's next relayed transaction" },
          ...(kept > 0n ? { kept: kept.toString() } : {}),
        },
        settled.headers,
      );
    }
    await this.#o.ledger.update((data) => landedIn(data, landed.txHash, owed));
    this.#o.log("relayed", { request: tx.hash, txHash: landed.txHash, gasUsed: landed.gasUsed, effectiveGasPrice: landed.effectiveGasPrice, value: landed.value, amount: owed, creditUsed: plan.used, creditVault, channel: outcome.channelId });
    return json(200, { txHash: landed.txHash, paid: owed.toString(), ...(plan.used > 0n ? { fromCredit: plan.used.toString() } : {}) }, settled.headers);
  }
}
