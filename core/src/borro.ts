// Borro and the version 3 vault settings, for the agent (OstraVault version 3; Borro through Morpho):
//   * lend a stock from the agent's vault of that stock, or USDG from the buyer vault, into Borro's Morpho Vault V2
//     of it (through BorroBuilders with Ostra's builder code when Borro lists the vault there), and redeem;
//   * post the stock vault's Borro shares as collateral on the stock's USDG market, borrow USDG into the buyer vault
//     (the stock vault's linked vault), repay from the buyer vault, and take the collateral back;
//   * the withdrawal lock, the linked vault and EIP-1271 hash approvals of any of the agent's vaults.
// Every spend is simulated with a throwaway key first (sdk simulateVaultSpend), and refused before anything is
// signed when it would fail (a Morpho spend that fails lands as MorphoFailed and uses the key for nothing). The
// vault contract also caps a loan at half of what the market's LLTV allows, so a fresh loan is liquidated only after
// the stock loses about half its value; the reads here show the same limit.
//
// Borro's own "Lend APR" counts its $BORRO Drip, which Borro pays to wallets only, not to contracts such as an Ostra
// vault (borro.markets/developers): an Ostra vault earns the vault's own yield, about 0% on 24 Oct 2026.

import { encodeFunctionData, getAddress, isAddress, keccak256, toHex, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import {
  BORRO_USDG_VAULT,
  VAULT_GUARD_MIN_GAS,
  MAX_RECOVERY_DELAY,
  MIN_RECOVERY_DELAY,
  QuoteError,
  VAULT_ACTION,
  VAULT_MORPHO_MIN_GAS,
  VAULT_V3,
  approveHashParams,
  borroStock,
  borroStocks,
  borrowParams,
  cancelPendingChangesParams,
  failedModuleSpends,
  guardParams,
  lendParams,
  moduleFailureText,
  ostraVaultAbi,
  readBorroPosition,
  readBorroUsdg,
  readVault,
  readVaultGuard,
  redeemParams,
  repayParams,
  setLinkedVaultParams,
  setWithdrawalLockParams,
  signVaultSpend,
  simulateVaultSpend,
  vaultV2Abi,
  withdrawCollateralParams,
  postCollateralParams,
  WOTS_SIGNATURE_LEN,
  chainlinkEthUsd,
  l1DataGas,
  weiToTokenUnits,
  withMargin,
  type BorroStock,
  type EthUsdSource,
  type GuardCall,
  type VaultGuardState,
} from "@ostraagent/sdk";
import { formatUnitsAmount, parseUnitsAmount, TOKEN_DECIMALS } from "./amount.ts";
import type { Config } from "./config.ts";
import { VAULT_SPEND_GAS, type Sender } from "./relay.ts";
import { spendCall, type VaultOperationResult, type VaultService } from "./vault.ts";

/** Slippage allowed on a Lend's shares and a Redeem's assets against the vault's preview (a Vault V2's share price only grows). */
export const BORRO_PREVIEW_SLIPPAGE_BPS = 10n;
/** A repay of the whole debt pays at most the debt read now plus this much (interest accrues until it lands). */
export const BORRO_REPAY_BUFFER_BPS = 100n;
const SPEND_GAS_HEADROOM = 100_000n;

export type BorroParts = {
  client: PublicClient;
  config: Config;
  /** The buyer vault (USDG): it lends USDG, receives loans and repays them. */
  buyer: VaultService;
  /** The agent's vault of a token (a stock): it lends the stock and posts its shares. */
  tokenVault: (token: Address) => VaultService;
  /** Who pays for the spends (the buyer vault's sender). */
  sender: Sender;
  /** Every vault address this agent's seed controls that is known here: a withdrawal address is never one of them. */
  ownVaults: () => Promise<Address[]>;
  /** ETH/USD for pricing spends in USDG (default: the chain's Chainlink feed, as the relayer prices them). */
  ethUsd?: EthUsdSource;
  /**
   * The gas price spends are priced at (default: the RPC's eth_gasPrice, as the relayer prices them). A fork test
   * passes the fork block's base fee: anvil adds a 1 gwei priority fee to eth_gasPrice that Robinhood Chain does not
   * charge (1.02 gwei on a fork against the chain's 0.0202, read 24 Oct 2026).
   */
  gasPrice?: () => Promise<bigint>;
};

function isoTime(unix: bigint): string {
  return new Date(Number(unix) * 1000).toISOString();
}

function amountText(text: string, decimals: number, what: string): bigint {
  const a = parseUnitsAmount(text, decimals);
  if (a === 0n) throw new RangeError(`${what} must be greater than zero`);
  return a;
}

function less(x: bigint, bps: bigint): bigint {
  return (x * (10_000n - bps)) / 10_000n;
}

/**
 * The gas a Morpho spend and a Guard spend must have left to run (MORPHO_MIN_GAS, GUARD_MIN_GAS); the relayer prices
 * this floor on top of the gas the spend uses (sdk reservedSwapGas).
 */
function gasFloor(action: number): bigint {
  return action >= VAULT_ACTION.LEND && action <= VAULT_ACTION.REPAY ? BigInt(VAULT_MORPHO_MIN_GAS) : action === VAULT_ACTION.GUARD ? BigInt(VAULT_GUARD_MIN_GAS) : 0n;
}

/** A stand-in signature of a WOTS signature's length, for measuring a spend's L1 data (random-looking, as one is). */
function standInSignature(): Hex {
  let out = "";
  let h = keccak256(toHex("OSTRA/STRATEGY/L1-DATA"));
  while (out.length < WOTS_SIGNATURE_LEN * 2) {
    out += h.slice(2);
    h = keccak256(h);
  }
  return `0x${out.slice(0, WOTS_SIGNATURE_LEN * 2)}`;
}

export class BorroService {
  readonly #p: BorroParts;

  constructor(p: BorroParts) {
    this.#p = p;
  }

  /** The vault that holds `what` ("USDG" or a Borro stock) and that stock (null for USDG). */
  #vaultOf(what: string): { vault: VaultService; stock: BorroStock | null; decimals: number } {
    if (what.toUpperCase() === "USDG") return { vault: this.#p.buyer, stock: null, decimals: TOKEN_DECIMALS };
    const stock = borroStock(what);
    return { vault: this.#p.tokenVault(stock.token), stock, decimals: 18 };
  }

  async #v3(vault: Address): Promise<void> {
    const version = Number(await this.#p.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "VERSION" }));
    if (version < VAULT_V3) throw new Error(`the vault ${vault} runs version ${version}; Borro and the withdrawal lock open once the vaults run version ${VAULT_V3} (the upgrade waits its public delay in OstraUpgradeOwner); nothing was signed`);
  }

  /** Runs the spend with a throwaway key (sdk simulateVaultSpend): refused when it reverts or lands as a failure. */
  async #simulate(address: Address, action: number, params: Hex, what: string): Promise<bigint> {
    const sim = await simulateVaultSpend(this.#p.client, this.#p.config.deployment, { relayer: await this.#p.sender.payer(), vault: address, action, params });
    const first = failedModuleSpends(sim.logs, [address])[0];
    if (first !== undefined) throw new QuoteError("spend_fails", `${what} fails now: ${moduleFailureText(first.reason)}; nothing was signed`);
    return sim.gasUsed;
  }

  /**
   * Simulates `action` with `params` from `vault` to size its gas, then, inside the vault's queue (after a spend
   * signed earlier was sent, a recovery finished and the relayer paid for), simulates it again right before it is
   * signed, and sends it alone (a failed Morpho spend lands only as a transaction's own call). `moves`: what it
   * takes out of the vault (a relayer channel opened for it leaves that much there).
   */
  async #spend(vault: VaultService, action: number, params: Hex, what: string, moves = 0n): Promise<VaultOperationResult> {
    const address = await vault.vaultAddress();
    await this.#v3(address);
    const gasUsed = await this.#simulate(address, action, params, what);
    const floor = gasFloor(action);
    let gas = (gasUsed * 5n) / 4n + SPEND_GAS_HEADROOM + floor;
    if (gas < VAULT_SPEND_GAS + floor) gas = VAULT_SPEND_GAS + floor;
    return vault.operate({
      gas,
      moves,
      what,
      build: async ({ v, vault: at, keychain, chainId }) => {
        const again = await this.#simulate(at, action, params, what);
        // What it uses now, with the floor and the headroom, still fits what was reserved (its margin absorbs the rest).
        if (again + SPEND_GAS_HEADROOM + floor > gas) throw new QuoteError("spend_fails", `${what} needs more gas now than it was reserved for; call again; nothing was signed`);
        return [spendCall(at, await signVaultSpend(keychain, v, { chainId, action: action as never, params }))];
      },
    });
  }

  async #address(vault: VaultService, what: string): Promise<Address> {
    const a = await vault.vaultAddress();
    if ((await readVault(this.#p.client, this.#p.config.deployment, a)) === null) throw new Error(`this agent has no ${what} vault yet`);
    return a;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Borro's stock markets: listed, the USDG they can lend now, the borrow rate, the LLTV and half of it (the vault's cap). */
  async markets(): Promise<unknown[]> {
    const out = [];
    for (const s of borroStocks()) {
      const p = await readBorroPosition(this.#p.client, zeroAddress, s);
      out.push({
        symbol: s.symbol,
        token: s.token,
        borroVault: s.vault,
        throughBorroBuilders: s.builders,
        marketId: s.marketId,
        listed: p.listed,
        usdgAvailable: formatUnitsAmount(p.available, TOKEN_DECIMALS),
        borrowRatePerYear: `${formatUnitsAmount(p.borrowRatePerYear * 100n, 18)}%`,
        lltv: `${formatUnitsAmount(s.market.lltv * 100n, 18)}%`,
        maxLoanToValue: `${formatUnitsAmount((s.market.lltv * 100n) / 2n, 18)}%`,
      });
    }
    return out;
  }

  /** The agent's Borro positions: USDG lent from the buyer vault, and per stock vault its shares, collateral and debt. */
  async positions(): Promise<unknown> {
    const buyer = await this.#p.buyer.vaultAddress();
    const usdg = await readBorroUsdg(this.#p.client, buyer);
    const stocks = [];
    for (const s of borroStocks()) {
      const v = await this.#p.tokenVault(s.token).vaultAddress();
      if ((await readVault(this.#p.client, this.#p.config.deployment, v)) === null) continue;
      const p = await readBorroPosition(this.#p.client, v, s);
      if (p.shares === 0n && p.collateral === 0n && p.borrowShares === 0n) continue;
      stocks.push({
        symbol: s.symbol,
        vault: v,
        lentShares: p.shares.toString(),
        lentValue: formatUnitsAmount(p.sharesValue, 18),
        collateralShares: p.collateral.toString(),
        debtUsdg: formatUnitsAmount(p.debt, TOKEN_DECIMALS),
        maxDebtUsdg: formatUnitsAmount(p.maxDebt, TOKEN_DECIMALS),
        debtOfLiquidationLimit: `${(Number(p.ltvOfLltvBps) / 100).toFixed(2)}%`,
        warning: p.ltvOfLltvBps >= 8_000n ? "the debt is at 80% or more of what the LLTV allows: repay or post more collateral before it is liquidated" : null,
      });
    }
    return { buyerVault: buyer, usdgLent: { shares: usdg.shares.toString(), value: formatUnitsAmount(usdg.value, TOKEN_DECIMALS) }, stocks };
  }

  // -------------------------------------------------------------------------
  // Lend and redeem
  // -------------------------------------------------------------------------

  /** Lends `amount` of `what` ("USDG" or a Borro stock) into Borro's vault of it. */
  async lend(what: string, amount: string): Promise<VaultOperationResult & { borroVault: Address }> {
    const { vault, stock, decimals } = this.#vaultOf(what);
    const assets = amountText(amount, decimals, "amount");
    const target = stock === null ? BORRO_USDG_VAULT : stock.vault;
    await this.#address(vault, stock === null ? "USDG" : stock.symbol);
    const preview = (await this.#p.client.readContract({ address: target, abi: vaultV2Abi, functionName: "previewDeposit", args: [assets] })) as bigint;
    const r = await this.#spend(vault, VAULT_ACTION.LEND, lendParams({ vault: target, assets, minShares: less(preview, BORRO_PREVIEW_SLIPPAGE_BPS) }), `Borro lend of ${amount} ${what.toUpperCase()}`, assets);
    return { ...r, borroVault: target };
  }

  /** Redeems `shares` ("all": every share the vault holds) of Borro's vault of `what` back into the agent's vault. */
  async redeem(what: string, sharesText: string): Promise<VaultOperationResult> {
    const { vault, stock } = this.#vaultOf(what);
    const target = stock === null ? BORRO_USDG_VAULT : stock.vault;
    const at = await this.#address(vault, stock === null ? "USDG" : stock.symbol);
    const held = (await this.#p.client.readContract({ address: target, abi: vaultV2Abi, functionName: "balanceOf", args: [at] })) as bigint;
    const shares = sharesText === "all" ? held : amountText(sharesText, 0, "shares");
    if (shares === 0n) throw new Error(`the vault holds no shares of ${target}; nothing was signed`);
    if (shares > held) throw new Error(`the vault holds ${held} shares of ${target}, fewer than ${shares}; nothing was signed`);
    const preview = (await this.#p.client.readContract({ address: target, abi: vaultV2Abi, functionName: "previewRedeem", args: [shares] })) as bigint;
    return this.#spend(vault, VAULT_ACTION.REDEEM, redeemParams({ vault: target, shares, minAssets: less(preview, BORRO_PREVIEW_SLIPPAGE_BPS) }), `Borro redeem of ${shares} shares`);
  }

  /**
   * Lends `assets` USDG from the USDG vault into `target`, a Morpho Vault V2 of USDG that is not Borro's (Strategy 1's
   * cash vault, checked by the caller: sdk checkCashVault). Under the withdrawal lock it counts against the daily limit.
   */
  async lendCash(target: Address, assets: bigint): Promise<VaultOperationResult> {
    if (assets <= 0n) throw new RangeError("the amount must be greater than zero");
    await this.#address(this.#p.buyer, "USDG");
    const preview = (await this.#p.client.readContract({ address: target, abi: vaultV2Abi, functionName: "previewDeposit", args: [assets] })) as bigint;
    return this.#spend(this.#p.buyer, VAULT_ACTION.LEND, lendParams({ vault: target, assets, minShares: less(preview, BORRO_PREVIEW_SLIPPAGE_BPS) }), `lend of ${formatUnitsAmount(assets, TOKEN_DECIMALS)} USDG to ${target}`, assets);
  }

  /**
   * Redeems `shares` of `target` into the USDG vault. `emergency`: with minAssets 0 (design: an exit must not fail and
   * use a key for nothing; the caller sizes it to what the vault can pay out now). Otherwise at most
   * BORRO_PREVIEW_SLIPPAGE_BPS under the preview.
   */
  async redeemCash(target: Address, shares: bigint, emergency = false): Promise<VaultOperationResult> {
    const at = await this.#address(this.#p.buyer, "USDG");
    const held = (await this.#p.client.readContract({ address: target, abi: vaultV2Abi, functionName: "balanceOf", args: [at] })) as bigint;
    if (shares <= 0n || shares > held) throw new Error(`the USDG vault holds ${held} shares of ${target}, not ${shares}; nothing was signed`);
    const preview = (await this.#p.client.readContract({ address: target, abi: vaultV2Abi, functionName: "previewRedeem", args: [shares] })) as bigint;
    const minAssets = emergency ? 0n : less(preview, BORRO_PREVIEW_SLIPPAGE_BPS);
    return this.#spend(this.#p.buyer, VAULT_ACTION.REDEEM, redeemParams({ vault: target, shares, minAssets }), `${emergency ? "emergency " : ""}redeem of ${shares} shares of ${target}`);
  }

  /**
   * What a spend of `action` with `params` from the vault holding `what` ("USDG" or a Borro stock) costs through the
   * relayer now, in USDG base units, by the relayer's own rule: the gas it uses (simulated with a throwaway key: it
   * must not fail now), the floor a Morpho or Guard spend reserves, the L1 data of its calldata, at the gas price, with
   * the relayer's margin, at the Chainlink price.
   */
  async spendCost(what: string, action: number, params: Hex, label: string): Promise<{ gas: bigint; usdg: bigint }> {
    const { vault } = this.#vaultOf(what);
    const at = await vault.vaultAddress();
    return this.spendCostAt(what, action, params, await this.#simulate(at, action, params, label));
  }

  /**
   * spendCost for a spend whose gas is `gasUsed` instead of simulated: one that can run only after spends before it
   * land (a loan before its collateral is posted), priced at a measured gas.
   */
  async spendCostAt(what: string, action: number, params: Hex, gasUsed: bigint): Promise<{ gas: bigint; usdg: bigint }> {
    const { vault } = this.#vaultOf(what);
    const at = await vault.vaultAddress();
    const data = encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [action, keccak256(toHex("OSTRA/STRATEGY/NEXT-ROOT")), params, standInSignature()] });
    const [l1, gasPrice] = await Promise.all([l1DataGas(this.#p.client, at, data), this.#p.gasPrice === undefined ? this.#p.client.getGasPrice() : this.#p.gasPrice()]);
    const gas = gasUsed + gasFloor(action) + l1;
    const ethUsd = await (this.#p.ethUsd ?? chainlinkEthUsd(this.#p.client))();
    return { gas, usdg: weiToTokenUnits(withMargin(gas * gasPrice), ethUsd, TOKEN_DECIMALS) };
  }

  // -------------------------------------------------------------------------
  // Collateral, loans, repayment
  // -------------------------------------------------------------------------

  /** Posts `shares` ("all") of the stock vault's Borro shares as collateral on the stock's USDG market. */
  async postCollateral(symbol: string, sharesText: string): Promise<VaultOperationResult> {
    const stock = borroStock(symbol);
    const vault = this.#p.tokenVault(stock.token);
    const at = await this.#address(vault, stock.symbol);
    const held = (await this.#p.client.readContract({ address: stock.vault, abi: vaultV2Abi, functionName: "balanceOf", args: [at] })) as bigint;
    const shares = sharesText === "all" ? held : amountText(sharesText, 0, "shares");
    if (shares === 0n || shares > held) throw new Error(`the vault holds ${held} shares of Borro's ${stock.symbol} vault (lend ${stock.symbol} first); nothing was signed`);
    return this.#spend(vault, VAULT_ACTION.POST_COLLATERAL, postCollateralParams({ market: stock.market, shares }), `Borro collateral of ${shares} shares`);
  }

  /** Takes `shares` ("all") of the stock vault's collateral back (the debt must stay within half the LLTV). */
  async withdrawCollateral(symbol: string, sharesText: string): Promise<VaultOperationResult> {
    const stock = borroStock(symbol);
    const vault = this.#p.tokenVault(stock.token);
    const at = await this.#address(vault, stock.symbol);
    const p = await readBorroPosition(this.#p.client, at, stock);
    const shares = sharesText === "all" ? p.collateral : amountText(sharesText, 0, "shares");
    if (shares === 0n || shares > p.collateral) throw new Error(`the vault has ${p.collateral} shares of collateral; nothing was signed`);
    return this.#spend(vault, VAULT_ACTION.WITHDRAW_COLLATERAL, withdrawCollateralParams({ market: stock.market, shares }), `Borro collateral withdrawal of ${shares} shares`);
  }

  /**
   * Links the stock vault to the buyer vault (a loan is paid only to the linked vault) when it is not yet: a spend.
   * Returns null once linked, or what to answer instead of the loan (the link waits the lock's delay, or a spend
   * signed earlier was sent instead).
   */
  async #ensureLinked(stockVault: VaultService, stockAt: Address, buyerAt: Address): Promise<(VaultOperationResult & { note: string }) | null> {
    const s = await readVaultGuard(this.#p.client, stockAt);
    if (s.linkedVault === buyerAt) return null;
    if (s.pendingLink?.vault === buyerAt) throw new Error(`the stock vault's link to the buyer vault takes effect at ${isoTime(s.pendingLink.at)} (its withdrawal lock's delay); borrow then; nothing was signed`);
    const r = await this.#spend(stockVault, VAULT_ACTION.SET_LINKED_VAULT, setLinkedVaultParams(buyerAt), "link of the stock vault to the buyer vault");
    if (r.status !== "sent") return { ...r, note: `${r.note}; the link was not signed yet` };
    const again = await readVaultGuard(this.#p.client, stockAt);
    if (again.linkedVault === buyerAt) return null;
    return { ...r, note: `the stock vault is locked, so its link to the buyer vault takes effect after the lock's delay, at ${isoTime(again.pendingLink?.at ?? 0n)}; borrow again then (no loan was signed)` };
  }

  /** Borrows `amount` USDG on the stock's Borro market against the stock vault's collateral, paid to the buyer vault. */
  async borrow(symbol: string, amount: string): Promise<VaultOperationResult & { note?: string; linked?: boolean }> {
    const stock = borroStock(symbol);
    const assets = amountText(amount, TOKEN_DECIMALS, "amount");
    const vault = this.#p.tokenVault(stock.token);
    const at = await this.#address(vault, stock.symbol);
    const buyerAt = await this.#address(this.#p.buyer, "USDG");
    await this.#v3(at);
    if ((await readVaultGuard(this.#p.client, at)).lockedSince !== 0n && (await readVaultGuard(this.#p.client, buyerAt)).lockedSince === 0n) {
      throw new Error("the stock vault is locked, so a loan goes only to a linked vault that was locked already when the link was decided: lock the buyer vault first (vault_lock), then borrow (the link then waits the stock vault's delay); nothing was signed");
    }
    const p = await readBorroPosition(this.#p.client, at, stock);
    if (!p.listed) throw new Error(`Borro no longer lists the ${stock.symbol} market; nothing was signed`);
    if (p.debt + assets > p.maxDebt) {
      throw new Error(`the collateral allows a debt of at most ${formatUnitsAmount(p.maxDebt, TOKEN_DECIMALS)} USDG (half of the LLTV, the vault's cap); the debt is ${formatUnitsAmount(p.debt, TOKEN_DECIMALS)}: post more collateral or borrow less; nothing was signed`);
    }
    if (assets > p.available) throw new Error(`the market can lend ${formatUnitsAmount(p.available, TOKEN_DECIMALS)} USDG now; nothing was signed`);
    const linkedBefore = (await readVaultGuard(this.#p.client, at)).linkedVault === buyerAt;
    const waiting = await this.#ensureLinked(vault, at, buyerAt);
    if (waiting !== null) return waiting;
    let r: VaultOperationResult;
    try {
      r = await this.#spend(vault, VAULT_ACTION.BORROW, borrowParams({ market: stock.market, assets }), `Borro loan of ${amount} USDG`);
    } catch (err) {
      if (err instanceof QuoteError && /: Locked;/.test(err.message)) {
        throw new QuoteError("spend_fails", `${err.message} (the buyer vault's lock was turned on after the stock vault linked to it: unlink and link again, vault_link, and the new link waits the stock vault's delay)`);
      }
      throw err;
    }
    return linkedBefore ? r : { ...r, linked: true };
  }

  /** Repays `amount` USDG ("all": the whole debt) of the stock vault's debt from the buyer vault. */
  async repay(symbol: string, amount: string): Promise<VaultOperationResult & { note?: string }> {
    const stock = borroStock(symbol);
    const stockAt = await this.#address(this.#p.tokenVault(stock.token), stock.symbol);
    await this.#address(this.#p.buyer, "USDG");
    const p = await readBorroPosition(this.#p.client, stockAt, stock);
    if (p.borrowShares === 0n) throw new Error(`the ${stock.symbol} vault owes nothing; nothing was signed`);
    let all = amount === "all";
    let assets = all ? 0n : amountText(amount, TOKEN_DECIMALS, "amount");
    // At least the debt read now: the whole debt by its shares (the contract would switch to that, and the interest
    // accrued until it lands is paid from the buffer).
    const whole = !all && assets >= p.debt;
    if (whole) [all, assets] = [true, 0n];
    const maxAssets = all ? p.debt + (p.debt * BORRO_REPAY_BUFFER_BPS) / 10_000n + 1n : assets;
    const params = repayParams({ market: stock.market, assets, shares: all ? p.borrowShares : 0n, onBehalf: stockAt, maxAssets });
    const r = await this.#spend(this.#p.buyer, VAULT_ACTION.REPAY, params, `Borro repayment of ${all ? "the whole debt" : `${amount} USDG`}`, maxAssets);
    if (!whole || r.status !== "sent") return r;
    return { ...r, note: `${amount} USDG covers the whole debt, so the whole debt was repaid by its shares: what it was when the repayment landed (the interest accrued until then included, at most ${formatUnitsAmount(maxAssets, TOKEN_DECIMALS)} USDG)` };
  }

  // -------------------------------------------------------------------------
  // Withdrawal lock, link, EIP-1271
  // -------------------------------------------------------------------------

  /** A vault's lock, link and pending changes ("USDG" or a Borro stock). */
  async guard(what: string): Promise<VaultGuardState & { vault: Address }> {
    const { vault } = this.#vaultOf(what);
    const at = await this.#address(vault, what.toUpperCase());
    return { vault: at, ...(await readVaultGuard(this.#p.client, at)) };
  }

  /**
   * Turns the withdrawal lock of the vault of `what` on (a withdrawal address, a delay, a daily limit in the vault's
   * token) or changes it; `withdrawal` "off" turns it off (that waits the delay). The withdrawal address must keep
   * what it gets: a wallet on another device, or an Ostra vault of another seed that is locked already. Never one of
   * this agent's own vaults (the same seed), refused. An address with no code is taken for a wallet (the chain cannot
   * tell it from an Ostra vault not created yet, which could be created unlocked): a warning says so.
   */
  async setLock(what: string, withdrawalText: string, delaySeconds: number, dailyLimit: string): Promise<VaultOperationResult & { warning?: string }> {
    const c = await this.checkLock(what, withdrawalText, delaySeconds, dailyLimit);
    const r = await this.#spend(c.vault, VAULT_ACTION.SET_WITHDRAWAL_LOCK, c.params, c.off ? "turning the withdrawal lock off" : "withdrawal lock");
    return c.warning === undefined ? r : { ...r, warning: c.warning };
  }

  /**
   * setLock's checks, nothing signed: refused for what setLock refuses (a bad delay, one of this agent's own vaults, an
   * unlocked withdrawal vault or one in another token), with the warning it would give. vault_lock runs them before it
   * sets OstraBreaker up, so that no spend is made for a lock that would be refused.
   */
  async checkLock(what: string, withdrawalText: string, delaySeconds: number, dailyLimit: string): Promise<{ vault: VaultService; off: boolean; params: Hex; warning?: string }> {
    const { vault, decimals, stock } = this.#vaultOf(what);
    const at = await this.#address(vault, what.toUpperCase());
    const off = withdrawalText === "off";
    if (!off && !isAddress(withdrawalText, { strict: false })) throw new RangeError(`${withdrawalText} is not an address`);
    const withdrawal = off ? zeroAddress : getAddress(withdrawalText);
    let warning: string | undefined;
    if (!off) {
      if (!Number.isInteger(delaySeconds) || delaySeconds < MIN_RECOVERY_DELAY || delaySeconds > MAX_RECOVERY_DELAY) {
        throw new RangeError(`the delay is ${MIN_RECOVERY_DELAY} to ${MAX_RECOVERY_DELAY} seconds (36 hours to 14 days)`);
      }
      const own = (await this.#p.ownVaults()).map((a) => getAddress(a));
      if (own.includes(withdrawal) || withdrawal === at) throw new Error("the withdrawal address is one of this agent's own vaults: the same seed controls it, so a stolen seed would reach it too; nothing was signed");
      const code = await this.#p.client.getCode({ address: withdrawal });
      if (code === undefined || code === "0x") {
        warning = `${withdrawal} has no code: the vault takes it for a wallet (the chain cannot tell a wallet from an Ostra vault not created yet); it must be a wallet whose key is not on this device`;
      } else {
        const other = await readVault(this.#p.client, this.#p.config.deployment, withdrawal);
        if (other !== null) {
          const token = stock === null ? this.#p.config.deployment.token : stock.token;
          if (other.token !== token) throw new Error(`the withdrawal vault holds ${other.token}, not this vault's token; nothing was signed`);
          const g = await readVaultGuard(this.#p.client, withdrawal);
          if (g.lockedSince === 0n) throw new Error("the withdrawal vault is not locked: lock it first (with a withdrawal address of its own), or a stolen seed of it could take what it gets; nothing was signed");
        }
      }
    }
    const limit = off ? 0n : parseUnitsAmount(dailyLimit, decimals);
    // The buyer vault pays the relayer through channels it opens: under the lock each open's deposit is an outflow.
    if (!off && stock === null && this.#p.sender.relayed) {
      const note = "under the lock every relayer channel this vault opens counts its deposit against the daily limit, and so does a Borro repayment of a stock vault this vault does not link back to; a limit used up stops relayed operations until it refills";
      warning = warning === undefined ? note : `${warning}; ${note}`;
    }
    const params = setWithdrawalLockParams({ withdrawal, delay: off ? 0 : delaySeconds, dailyLimit: limit });
    return { vault, off, params, ...(warning === undefined ? {} : { warning }) };
  }

  /** Sets (or with "none" removes) the linked vault of the vault of `what`: under the lock a new link waits its delay. */
  async setLink(what: string, linkText: string): Promise<VaultOperationResult> {
    const { vault } = this.#vaultOf(what);
    const at = await this.#address(vault, what.toUpperCase());
    const none = linkText === "none";
    if (!none && !isAddress(linkText, { strict: false })) throw new RangeError(`${linkText} is not an address`);
    const link = none ? zeroAddress : getAddress(linkText);
    if (link === at) throw new RangeError("a vault does not link to itself");
    return this.#spend(vault, VAULT_ACTION.SET_LINKED_VAULT, setLinkedVaultParams(link), none ? "unlink" : `link to ${link}`);
  }

  /** Drops the lock and link changes of the vault of `what` that still wait. */
  async cancelPending(what: string): Promise<VaultOperationResult> {
    const { vault } = this.#vaultOf(what);
    const at = await this.#address(vault, what.toUpperCase());
    const g = await readVaultGuard(this.#p.client, at);
    if (g.pendingLock === null && g.pendingLink === null) throw new Error("nothing waits; nothing was signed");
    return this.#spend(vault, VAULT_ACTION.CANCEL_PENDING_CHANGES, cancelPendingChangesParams(), "cancel of the waiting changes");
  }

  /**
   * As a guardian of another (locked) vault, from the buyer vault: drops its waiting changes, withdraws one of its
   * hash approvals, sends its whole balance to its withdrawal address, or takes its Borro shares or collateral back
   * into it (OstraVault.guard through a Guard spend).
   */
  async guardOther(vaultText: string, call: GuardCall): Promise<VaultOperationResult> {
    if (!isAddress(vaultText, { strict: false })) throw new RangeError(`${vaultText} is not an address`);
    const target = getAddress(vaultText);
    await this.#v3(target);
    const g = await readVaultGuard(this.#p.client, target);
    if (g.lockedSince === 0n) throw new Error(`${target} is not locked: guardians act on a vault only while its withdrawal lock is on; nothing was signed`);
    const names = ["cancel", "revoke", "sweep", "redeem", "withdraw collateral"];
    return this.#spend(this.#p.buyer, VAULT_ACTION.GUARD, guardParams(target, call), `guard (${names[call.op] ?? call.op}) of ${target}`);
  }

  /** Approves (or withdraws) `hash` for EIP-1271 on the buyer vault: under the lock an approval waits its delay. */
  async approveHash(hash: Hex, approved: boolean): Promise<VaultOperationResult> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash) || /^0x0{64}$/.test(hash)) throw new RangeError("the hash is 32 bytes of 0x hex, not zero");
    return this.#spend(this.#p.buyer, VAULT_ACTION.APPROVE_HASH, approveHashParams({ hash, approved }), approved ? "EIP-1271 approval" : "EIP-1271 approval withdrawal");
  }
}
