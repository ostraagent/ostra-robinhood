// The MCP tools. Every tool checks its inputs, and every vault operation is
// checked (quoted or simulated with a throwaway key) before the agent's
// one-time key signs it, so a refusal means nothing was signed or spent
// unless its message says otherwise. Amounts are decimal strings: USDG with
// at most 6 decimals, launched tokens with at most 18.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RelayerError, RelayerUnavailableError, UNSHIELD_DEFAULT_WINDOW_HOURS, UNSHIELD_MAX_WINDOW_HOURS, formatTokenAmount } from "@ostraagent/core";
import { QuoteError, redact } from "@ostraagent/sdk";
import type { Agent } from "./agent.ts";

const toJson = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an address: 0x and 40 hex characters");
const usdg = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/, "a USDG amount: a plain decimal with at most 6 decimals");
const units = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/, "an amount: a plain decimal with at most 18 decimals");
const slippage = z.number().int().min(0).max(1_000).optional().describe("slippage in bps (default 100 = 1%, at most 1000)");
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "32 bytes of 0x hex");

/** A tool's answer: its result as JSON, or the error, with what kind of error it is. */
async function run(fn: () => Promise<unknown>, rpcUrl: string): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: toJson(await fn()) }] };
  } catch (err) {
    let kind = "error";
    if (err instanceof RelayerUnavailableError) kind = "relayer_unavailable";
    else if (err instanceof RelayerError) kind = `relayer_refused ${err.status} ${err.code}`;
    else if (err instanceof QuoteError) kind = `refused_before_signing ${err.code}`;
    else if (err instanceof RangeError) kind = "invalid_input";
    // The RPC URL may carry an API key (viem's errors print it): never passed on.
    const message = redact(err instanceof Error ? err.message : String(err), rpcUrl);
    return { isError: true, content: [{ type: "text", text: `${kind}: ${message}` }] };
  }
}

export function registerTools(server: McpServer, agent: Agent): void {
  const lp = () => {
    if (agent.launchpad === null) throw new Error("this deployment has no launchpad");
    return agent.launchpad;
  };
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: shape }, ((args: z.infer<z.ZodObject<S>>) => run(() => fn(args), agent.config.rpcUrl)) as never);

  // --- the vault ---------------------------------------------------------------------------------
  tool("open_vault", "Creates the agent's vault (USDG on Robinhood Chain, post-quantum WOTS keys) or finds it. With the Ostra relayer, its creation is paid later from the vault.", {}, () => agent.buyer.open());
  tool("balance", "The vault's balance, nonce, any operation signed and not landed, the relayer channels, and the creator vault.", {}, async () => ({
    vault: await agent.buyer.status(),
    relayerChannels: agent.relayer === null ? null : await agent.relayer.channels(),
    creatorVault: await agent.creator.state().then((s) => ({ vault: s.vault, exists: s.exists, balance: formatTokenAmount(s.balance), pendingOperation: s.pendingAction })),
    relayer: agent.config.relayerUrl !== null,
  }));
  tool("withdraw", "Sends USDG from the vault to an address.", { destination: address, amount: usdg }, (a) => agent.buyer.withdraw(a.destination, a.amount));

  // --- channels and payments ------------------------------------------------------------------------
  tool(
    "open_channel",
    "Opens an x402 batch-settlement channel from the vault to another Ostra vault (a seller), with the seller's splits and grace period.",
    { payee: address, deposit: usdg, gracePeriodSeconds: z.number().int().min(900).max(86_400).default(900), recipients: z.array(z.object({ recipient: address, bps: z.number().int().min(1).max(10_000) })).max(32).optional() },
    (a) => agent.channels.open({ payee: a.payee, deposit: a.deposit, gracePeriod: a.gracePeriodSeconds, recipients: a.recipients }),
  );
  tool("list_channels", "The channels opened from the vault that are not finished, with their on-chain state.", {}, () => agent.channels.list());
  tool("close_channel", "Closes a channel on the payer path (requestClose, then finalizeWithdraw after the grace period); call again to continue.", { channel: bytes32 }, (a) => agent.channels.close(a.channel));
  tool(
    "pay",
    "Sends an HTTP request; when the route answers 402 with an x402 batch-settlement offer in USDG from an Ostra seller, pays it from a channel of the vault (opening one when needed) and returns the answer. Refused before anything is signed when the price is above maxPrice.",
    { url: z.string().url(), method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"), headers: z.record(z.string(), z.string()).optional(), body: z.string().max(1_000_000).optional(), maxPrice: usdg, deposit: usdg.optional() },
    (a) => agent.payments.pay({ url: a.url, method: a.method, maxPrice: a.maxPrice, ...(a.headers === undefined ? {} : { headers: a.headers }), ...(a.body === undefined ? {} : { body: a.body }), ...(a.deposit === undefined ? {} : { deposit: a.deposit }) }),
  );

  // --- the seller vault -------------------------------------------------------------------------------
  tool("accept_payments", "Sets up the seller side: the seller vault with the Ostra keeper's crank (it claims vouchers), and the merchant key for the seller server (merchant/).", {}, () => agent.acceptPayments());
  tool("seller_balance", "The seller vault: balance, nonce, crank.", {}, async () => {
    if (!(await agent.sellerReady())) throw new Error("this agent has no seller vault yet; call accept_payments first");
    return agent.seller.status();
  });
  tool("seller_withdraw", "Sends USDG from the seller vault (default: to the agent's vault).", { amount: usdg, destination: address.optional() }, async (a) => {
    if (!(await agent.sellerReady())) throw new Error("this agent has no seller vault yet; call accept_payments first");
    return agent.seller.withdraw(a.destination ?? (await agent.buyer.vaultAddress()), a.amount);
  });

  // --- the shielded pool --------------------------------------------------------------------------------
  tool("shield", "Deposits `leaves` standard leaves from the vault into the shielded pool (through the Ostra aggregator's batches).", { leaves: z.number().int().min(1).max(64) }, (a) => agent.shield.shield(a.leaves));
  tool(
    "unshield",
    `Spends \`leaves\` shielded leaves, each into a new private vault at a random time within windowHours (default ${UNSHIELD_DEFAULT_WINDOW_HOURS}, at most ${UNSHIELD_MAX_WINDOW_HOURS}; 0: now, which lets the spends be timed together).`,
    { leaves: z.number().int().min(1).max(64), windowHours: z.number().min(0).max(UNSHIELD_MAX_WINDOW_HOURS).default(UNSHIELD_DEFAULT_WINDOW_HOURS) },
    (a) => agent.unshield.unshield(a.leaves, a.windowHours),
  );
  tool("shield_status", "Shield deposits, scheduled unshields and the private vaults.", {}, async () => ({ deposits: await agent.shield.list(), unshields: await agent.unshield.list(), privateVaults: await agent.unshield.vaults() }));
  tool("auto_shield", "Turns the creator vault's auto-shield on or off (it shields what the vault holds beyond `keep` USDG).", { enabled: z.boolean(), keep: usdg.optional() }, (a) => agent.creatorShield.setAutoShield(a.enabled, a.keep));
  tool("private_withdraw", "Sends USDG from one of the agent's private vaults.", { vault: address, destination: address, amount: usdg }, async (a) => {
    const ctx = await agent.privateVault(await agent.unshield.indexOf(a.vault));
    return ctx.vault.withdraw(a.destination, a.amount);
  });

  // --- recovery ----------------------------------------------------------------------------------------
  tool("recovery_status", "The vault's guardians, recovery policy and any recovery waiting.", {}, () => agent.buyer.recovery());
  tool("set_guardian", "Adds or removes a guardian of the vault (another Ostra vault keeps the recovery post-quantum).", { guardian: address, enabled: z.boolean() }, (a) => agent.buyer.setGuardian(a.guardian, a.enabled));
  tool("set_recovery_policy", "How many guardians must support a recovery, and how long it then waits (0 and 0: off).", { threshold: z.number().int().min(0).max(255), delaySeconds: z.number().int().min(0).max(31_536_000) }, (a) => agent.buyer.setRecoveryPolicy(a.threshold, a.delaySeconds));
  tool("cancel_recovery", "Cancels a recovery of the vault that waits (the owner still holds the key).", {}, () => agent.buyer.cancelRecovery());
  tool("support_recovery", "As a guardian, supports moving another vault to the key root its owner's new device gave.", { vault: address, newKeyRoot: bytes32 }, (a) => agent.buyer.supportRecovery(a.vault, a.newKeyRoot));
  tool("request_recovery", "On a new device that lost the old seed: adopts a vault and says what its recovery still needs.", { vault: address }, (a) => agent.buyer.requestRecovery(a.vault));

  // --- the launchpad: trading -------------------------------------------------------------------------------
  tool("pool_info", "A token the Ostra launchpad launched: price, market cap, taxes, circuit breaker band, airdrop round, creator shares.", { token: address }, (a) => lp().poolInfo(a.token));
  tool(
    "quote_swap",
    "Quotes a buy (USDG in) or sell (token in) as it would be signed now: expected and minimum output, the gas the swap reserves, the share of the circuit breaker's room used. Nothing is signed.",
    { side: z.enum(["buy", "sell"]), token: address, amount: units, slippageBps: slippage, referrer: address.optional() },
    (a) => lp().quote({ side: a.side, token: a.token, amount: a.amount, ...(a.slippageBps === undefined ? {} : { slippageBps: a.slippageBps }), ...(a.referrer === undefined ? {} : { referrer: a.referrer }) }),
  );
  tool(
    "buy",
    "Buys a launched token with USDG from the vault; the tokens go to the agent's vault for that token (created in the same transaction).",
    { token: address, amount: usdg, slippageBps: slippage, referrer: address.optional() },
    (a) => lp().buy({ token: a.token, amount: a.amount, ...(a.slippageBps === undefined ? {} : { slippageBps: a.slippageBps }), ...(a.referrer === undefined ? {} : { referrer: a.referrer }) }),
  );
  tool(
    "sell",
    "Sells a launched token from the agent's token vault for USDG into the vault.",
    { token: address, amount: units, slippageBps: slippage, referrer: address.optional() },
    (a) => lp().sell({ token: a.token, amount: a.amount, ...(a.slippageBps === undefined ? {} : { slippageBps: a.slippageBps }), ...(a.referrer === undefined ? {} : { referrer: a.referrer }) }),
  );
  tool("token_vault", "The agent's vault for a launched token: address, balance, dividends to claim.", { token: address }, (a) => lp().tokenVaultInfo(a.token));
  tool("transfer_token", "Sends a launched token from the agent's token vault to an address.", { token: address, destination: address, amount: units }, (a) => lp().transferToken(a));
  tool("claim_dividends", "Claims the dividends the agent's token vault earned, into the agent's vault of the dividend token.", { token: address }, (a) => lp().claimDividends(a.token));
  tool("claim_referral", "Claims the USDG that swaps naming `referrer` (default: the agent's vault) earned it.", { referrer: address.optional() }, (a) => lp().claimReferral(a.referrer === undefined ? {} : { referrer: a.referrer }));

  // --- the launchpad: launching (the creator vault) ------------------------------------------------------------
  tool("fund_creator_vault", "Moves USDG from the vault into the creator vault, which pays launches, dev buys and airdrops (and its own relayer requests).", { amount: usdg }, (a) => lp().fundCreatorVault(a.amount));
  tool("creator_withdraw", "Sends USDG from the creator vault (default: to the agent's vault): creator payouts it received, for example.", { amount: usdg, destination: address.optional() }, async (a) => agent.creator.withdraw(a.destination ?? (await agent.buyer.vaultAddress()), a.amount));
  tool(
    "launch",
    "Launches a token on the Ostra launchpad from the creator vault (USDG pool, 1 billion supply), optionally with a dev buy paid by the creator vault in the same transaction and vesting to the agent's token vault. The relayer fronts the 0.0002 ETH launch fee and charges it in USDG. The launch is simulated first; nothing is signed if it would fail. `options` sets LaunchParams fields (taxes, buckets, anti-snipe, limits, graduation, circuit breaker) beyond Ostra's defaults.",
    {
      name: z.string().min(1).max(64),
      symbol: z.string().regex(/^[A-Za-z0-9]{1,11}$/),
      marketCap: usdg.optional().describe("the starting market cap in USDG (or startTick)"),
      startTick: z.number().int().optional(),
      devBuy: z.object({ amount: usdg, cliffDays: z.number().min(7).max(365).optional(), vestingDays: z.number().min(0).max(365).optional() }).optional(),
      options: z.record(z.string(), z.unknown()).optional(),
    },
    (a) =>
      lp().launch({
        name: a.name,
        symbol: a.symbol,
        ...(a.marketCap === undefined ? {} : { marketCap: a.marketCap }),
        ...(a.startTick === undefined ? {} : { startTick: a.startTick }),
        ...(a.devBuy === undefined ? {} : { devBuy: { amount: a.devBuy.amount, ...(a.devBuy.cliffDays === undefined ? {} : { cliffDays: a.devBuy.cliffDays }), ...(a.devBuy.vestingDays === undefined ? {} : { vestingDays: a.devBuy.vestingDays }) } }),
        ...(a.options === undefined ? {} : { options: launchOptions(a.options) }),
      }),
  );
  tool("launches", "The launches this agent made.", {}, () => lp().launches());
  tool(
    "set_pool_setting",
    "Changes a rule of the agent's pool, only in the traders' favour: buy_tax, sell_tax, post_buy_tax, post_sell_tax (lower, bps), tax_end_at (earlier, unix s), anti_snipe (lower), max_buy (higher, or 0 none), release_limits (0), volatility_fee (0: off), max_tx_move (looser ticks, or 0 off).",
    { token: address, setting: z.enum(["buy_tax", "sell_tax", "post_buy_tax", "post_sell_tax", "tax_end_at", "anti_snipe", "max_buy", "release_limits", "volatility_fee", "max_tx_move"]), value: z.string().regex(/^(0|[1-9][0-9]*)$/) },
    (a) => lp().setPoolSetting(a),
  );
  tool("set_creator_share", "Sets a recipient's share (bps; 0 removes it) of the pool's creator payouts; the creator vault keeps the rest.", { token: address, recipient: address, bps: z.number().int().min(0).max(10_000) }, (a) => lp().setCreatorShare(a));
  tool("release_creator_payout", "Pays out what the creator split owes an account (default: the creator vault) for a pool.", { token: address, account: address.optional() }, (a) => lp().releaseCreatorPayout({ token: a.token, ...(a.account === undefined ? {} : { account: a.account }) }));
  tool("airdrop_fund", "Buys the token with USDG from the creator vault into OstraAirdrop, for the pool's next airdrop round.", { token: address, amount: usdg, slippageBps: slippage }, (a) => lp().airdropFund({ token: a.token, amount: a.amount, ...(a.slippageBps === undefined ? {} : { slippageBps: a.slippageBps }) }));
  tool(
    "airdrop_start",
    "Starts the pool's next airdrop round sharing the entries (account, amount of the token; at most 10% of the supply), claimable for 7 days.",
    { token: address, entries: z.array(z.object({ account: address, amount: units })).min(1).max(10_000) },
    (a) => lp().airdropStart(a),
  );
  tool("airdrop_claim", "Sends an account's claim of the pool's open airdrop round (the tokens go to that account).", { token: address, account: address, amount: units.optional(), proof: z.array(bytes32).optional() }, (a) =>
    lp().airdropClaim({ token: a.token, account: a.account, ...(a.amount === undefined ? {} : { amount: a.amount }), ...(a.proof === undefined ? {} : { proof: a.proof as `0x${string}`[] }) }),
  );
  tool("airdrop_close", "Closes the pool's airdrop round after its claim period (what was not claimed is burned).", { token: address }, (a) => lp().airdropClose(a.token));
  tool("vesting_info", "The dev buy vesting of a token: schedule, what it holds, what it can release.", { token: address, vesting: address.optional() }, (a) => lp().vestingInfo({ token: a.token, ...(a.vesting === undefined ? {} : { vesting: a.vesting }) }));
  tool("vesting_release", "Releases what the dev buy vesting has vested, to the agent's token vault.", { token: address, vesting: address.optional() }, (a) => lp().vestingRelease({ token: a.token, ...(a.vesting === undefined ? {} : { vesting: a.vesting }) }));
  tool("vesting_claim_dividends", "Claims the dividends the vesting's tokens earned, to its dividend recipient.", { token: address, vesting: address.optional() }, (a) => lp().vestingClaimDividends({ token: a.token, ...(a.vesting === undefined ? {} : { vesting: a.vesting }) }));
}

const BIGINT_FIELDS = new Set(["minDividendBalance", "maxBuy", "maxWallet", "graduationThreshold"]);
const ALLOWED_OPTIONS = new Set([
  "tiers",
  "buyTaxBps",
  "sellTaxBps",
  "postBuyTaxBps",
  "postSellTaxBps",
  "taxDuration",
  "creatorBucketBps",
  "dividendBucketBps",
  "burnBucketBps",
  "lpBucketBps",
  "floorBucketBps",
  "dividendToken",
  "dividendKey",
  "minDividendBalance",
  "antiSnipeBps",
  "antiSnipeDuration",
  "maxBuy",
  "maxWallet",
  "limitsDuration",
  "antiFarmerDuration",
  "graduationKind",
  "graduationThreshold",
  "volatilityFee",
  "maxTxMoveTicks",
]);

/** LaunchParams fields from JSON: whole numbers for uint fields (strings for the large ones), checked by the launch's simulation. */
function launchOptions(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!ALLOWED_OPTIONS.has(k)) throw new RangeError(`unknown launch option ${k}; one of ${[...ALLOWED_OPTIONS].join(", ")}`);
    if (BIGINT_FIELDS.has(k)) {
      if ((typeof v !== "string" && typeof v !== "number") || !/^(0|[1-9][0-9]*)$/.test(String(v))) throw new RangeError(`${k} is a whole number (as a string for large values)`);
      out[k] = BigInt(String(v));
    } else if (k === "tiers") {
      if (!Array.isArray(v)) throw new RangeError("tiers is a list of {width, supplyBps}");
      out[k] = v.map((t: { width?: unknown; supplyBps?: unknown }) => ({ width: Number(t.width), supplyBps: Number(t.supplyBps) }));
    } else {
      out[k] = v;
    }
  }
  return out;
}
