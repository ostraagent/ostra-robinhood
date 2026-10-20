// The $OSTRA buyback and burn (landing and docs: the buyback share is booked on
// chain, and the operator claims it to buy $OSTRA and burn it; design v0.4,
// "Hook Ostra di Robinhood Chain": the buyback buys OSTRA on its Pons pool and
// the OSTRA bought is burned). One run, as the hourly timer starts it:
//
//   1. checks: chain 4663; the account is OstraDispatcher's owner; OSTRA and its
//      Pons curve are the code the SDK checked (OSTRA_CODE_HASH,
//      OSTRA_PONS_CURVE_CODE_HASH); the curve trades OSTRA; what the run's state
//      says is waiting is held by the account;
//   2. a transaction a previous run sent and did not see land is looked up and
//      its effect applied, or it is sent again, signed again at its nonce with
//      fees now when the node refuses it (every transaction is signed and kept,
//      fsynced, in the state before it is sent: a run stopped at any point
//      neither loses nor double-counts anything). One whose nonce is used but
//      that has no receipt stops the run until it is looked at;
//   3. claims (OstraDispatcher.claimBuyback, to the account) the buyback share
//      owed in USDG, in ETH (paid as WETH) and in OSTRA once it is worth at
//      least the minimum (default 1 USD); USDG and ETH only while the curve has
//      not graduated, since they are spent on it. The share owed in a stock
//      token stays in the dispatcher: no route to ETH is wired for it yet;
//   4. USDG claimed is swapped for WETH on Uniswap v3 through the Universal
//      Router (Permit2), in the USDG/WETH pool that quotes best, at most
//      SWAP_SLIPPAGE_BPS below its quote, and only when the quote is within
//      ORACLE_TOLERANCE_BPS of Chainlink ETH/USD;
//   5. WETH is unwrapped, and the ETH buys OSTRA on the Pons curve
//      (buy(ethIn, minOut, account)), at most BUY_SLIPPAGE_BPS below what the
//      same buy simulates to, at most BUY_MAX_RESERVE_BPS of the curve's ETH
//      reserve in one run, and not at all when the curve's price rose more
//      than BUY_MAX_PRICE_RISE_BPS since the run started (the ETH then waits
//      for the next run);
//   6. the OSTRA claimed and bought is burned (burn(uint256): the supply falls).
//
// Only what the run claimed is ever spent: the state keeps what is waiting in
// each step (USDG, WETH, ETH, OSTRA), from the events of the run's own
// transactions, so the account's other funds (its gas ETH) are never touched.
// Nothing here can move funds anywhere but into the swap, the curve and the burn.

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  TransactionReceiptNotFoundError,
  createWalletClient,
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  keccak256,
  maxUint256,
  parseAbi,
  zeroAddress,
} from "viem";
import {
  CHAINLINK_ETH_USD,
  ETH_PRICE_MAX_AGE,
  LAUNCH_PAIRS,
  OSTRA,
  OSTRA_CODE_HASH,
  OSTRA_PONS_CURVE,
  OSTRA_PONS_CURVE_CODE_HASH,
  PERMIT2,
  ROBINHOOD_CHAIN_ID,
  UNISWAP_UNIVERSAL_ROUTER,
  USDG,
  WETH,
  chainlinkAggregatorAbi,
  launchPair,
  ostraDispatcherAbi,
  ponsCurveAbi,
  readPairUsdPrice,
  robinhoodChain,
  usdgAbi,
  type Deployment,
} from "@ostraagent/sdk";

/** Uniswap v3 on chain 4663 (Uniswap's deployments page; checked on chain 20 Oct 2026, and by the fork test): the USDG/WETH pools. */
export const UNISWAP_V3_FACTORY: Address = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
export const UNISWAP_V3_QUOTER_V2: Address = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
/** The v3 fee tiers searched for a USDG/WETH pool. */
export const V3_FEE_TIERS = [100, 500, 3_000, 10_000] as const;

/** The swap's minimum output: at most this far below the best quote (0.5%). */
export const SWAP_SLIPPAGE_BPS = 50n;
/** The best quote must be within this of Chainlink ETH/USD (1%), or nothing is swapped: a pool far from the market is not used. */
export const ORACLE_TOLERANCE_BPS = 100n;
/** The curve buy's minimum output: at most this far below the same buy simulated just before (1%). */
export const BUY_SLIPPAGE_BPS = 100n;
/**
 * The curve's price may have risen at most this much (1%) between the start of the run, before its first
 * transaction, and the buy: a price pushed up while the run claims and unwraps is not bought at (the ETH waits for
 * the next run).
 */
export const BUY_MAX_PRICE_RISE_BPS = 100n;
/**
 * One buy spends at most this share (0.99%) of the curve's ETH reserve, which moves its price by about 2%; the rest
 * of the ETH waits for the next run.
 */
export const BUY_MAX_RESERVE_BPS = 99n;
/** Seconds a swap may wait in the mempool before the router refuses it. */
export const SWAP_DEADLINE_SECONDS = 600n;
/** The Permit2 allowance given to the router lasts this long (seconds). */
export const PERMIT2_ALLOWANCE_SECONDS = 3_600n;
/** How long a run waits for a transaction it sent to land (ms). */
export const RECEIPT_TIMEOUT_MS = 180_000;
/** How long a kept transaction's receipt is looked for once its nonce is used (a node that lags behind; ms). */
export const LAGGING_NODE_MS = 30_000;
const RECEIPT_POLL_MS = 1_000;
/** A kept transaction is signed again at its nonce at most this many times; then the run stops for a look. */
export const MAX_RESIGNS = 4;

/** Universal Router command V3_SWAP_EXACT_IN (its input in this router has a sixth word, the per-hop price limits). */
const V3_SWAP_EXACT_IN = 0x00;
const BPS = 10_000n;

const quoterV2Abi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const v3FactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
const wethAbi = parseAbi([
  "function withdraw(uint256 wad)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed src, address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
]);
const ostraAbi = parseAbi([
  "function burn(uint256 value)",
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export type Step = "claim_usdg" | "claim_eth" | "claim_ostra" | "approve_permit2" | "permit2_allowance" | "swap" | "unwrap" | "buy" | "burn";

/**
 * A transaction signed and kept before it was sent: its call (to sign it again at the same nonce with new fees), the
 * amount it moves (an unwrap's WETH), and the hashes of earlier signatures of the same call at that nonce.
 */
export type Inflight = { step: Step; hash: Hex; raw: Hex; nonce: number; value: string; to: Address; data: Hex; amount: string; prior: Hex[]; at: string };

/** What a run keeps between runs (JSON, amounts as decimal strings of base units). */
export type BuybackState = {
  version: 1;
  account: Address;
  /** Claimed and not yet spent, per step: USDG to swap, WETH to unwrap, ETH to buy with, OSTRA to burn. */
  pending: { usdg: string; weth: string; eth: string; ostra: string };
  inflight: Inflight | null;
  /** OSTRA this account burned, in all runs. */
  burned: string;
};

export type BuybackOptions = {
  client: PublicClient;
  transport: Transport;
  account: PrivateKeyAccount;
  deployment: Deployment;
  /** The state file (its directory is created 0700 when missing). */
  statePath: string;
  /** The least a currency's buyback share must be worth to be claimed, in USD with 6 decimals. */
  minUsdE6: bigint;
  log: (event: string, fields?: Record<string, unknown>) => void;
};

export type BuybackSummary = {
  graduated: boolean;
  claimed: { currency: string; amount: string }[];
  burnedNow: string;
  burned: string;
  pending: BuybackState["pending"];
  waiting: { currency: string; owed: string; why: string }[];
  ostraSupply: string;
};

const big = (s: string) => BigInt(s);

/** "1", "0.5", "25.25": US dollars with at most 6 decimals, as base units of 6 decimals (OSTRA_BUYBACK_MIN_USD). */
export function parseUsd(text: string): bigint {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(text)) throw new Error(`OSTRA_BUYBACK_MIN_USD must be US dollars with at most 6 decimals, not ${JSON.stringify(text)}`);
  const [w, f = ""] = text.split(".");
  return BigInt(w as string) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}
const bps = (x: bigint, b: bigint) => (x * (BPS - b)) / BPS;

function emptyState(account: Address): BuybackState {
  return { version: 1, account, pending: { usdg: "0", weth: "0", eth: "0", ostra: "0" }, inflight: null, burned: "0" };
}

export function readState(path: string, account: Address): BuybackState {
  if (!existsSync(path)) return emptyState(account);
  const s = JSON.parse(readFileSync(path, "utf8")) as BuybackState;
  const f = s.inflight;
  if (f !== null) {
    const hex = (x: unknown) => typeof x === "string" && /^0x[0-9a-fA-F]*$/.test(x);
    const ok =
      typeof f === "object" &&
      hex(f.hash) &&
      hex(f.raw) &&
      hex(f.data) &&
      hex(f.to) &&
      Number.isInteger(f.nonce) &&
      /^[0-9]+$/.test(f.value) &&
      /^[0-9]+$/.test(f.amount) &&
      Array.isArray(f.prior) &&
      f.prior.every(hex);
    if (!ok) throw new Error(`${path}: the kept transaction is not complete (step, hash, raw, nonce, to, data, value, amount, prior)`);
  }
  if (s.version !== 1) throw new Error(`${path}: unknown state version ${String(s.version)}`);
  if (getAddress(s.account) !== getAddress(account)) throw new Error(`${path} is the state of ${s.account}, not of ${account}`);
  for (const k of ["usdg", "weth", "eth", "ostra"] as const) if (!/^[0-9]+$/.test(s.pending[k])) throw new Error(`${path}: pending.${k} is not an amount`);
  return s;
}

/** Writes the state atomically and durably: a temporary file, fsynced, renamed over it, then the directory fsynced; mode 0600. */
export function writeState(path: string, s: BuybackState): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(s, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** A process's start time (field 22 of /proc/<pid>/stat), or null where /proc cannot tell: with the pid, it names one process. */
function startTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Takes the run's lock: a file next to the state holding the pid and its start time. A lock whose process is gone, or
 * whose pid now names another process (a reboot reuses pids), is taken over.
 */
function lock(path: string): () => void {
  const file = `${path}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, `${process.pid} ${startTime(process.pid) ?? "-"}`);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const [pidText, started] = readFileSync(file, "utf8").trim().split(" ");
      const pid = Number(pidText);
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        const now = startTime(pid);
        if (alive && started !== undefined && started !== "-" && now !== null && now !== started) alive = false;
      }
      if (alive) throw new Error(`another buyback run (pid ${pid}) holds ${file}`);
      unlinkSync(file);
    }
  }
  throw new Error(`could not take ${file}`);
}

/** One buyback run (see the header). Throws when a check fails or a transaction fails; the state stays consistent. */
export async function runBuyback(o: BuybackOptions): Promise<BuybackSummary> {
  const { client, account, log } = o;
  const me = account.address;
  const lp = o.deployment.launchpad;
  if (lp === undefined) throw new Error("the deployment record has no launchpad");
  const dispatcher = lp.dispatcher;
  mkdirSync(dirname(o.statePath), { recursive: true, mode: 0o700 });
  const unlock = lock(o.statePath);
  try {
    const chainId = await client.getChainId();
    if (chainId !== ROBINHOOD_CHAIN_ID || o.deployment.chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`the RPC serves chain ${chainId}, not Robinhood Chain (${ROBINHOOD_CHAIN_ID})`);
    const owner = getAddress((await client.readContract({ address: dispatcher, abi: ostraDispatcherAbi, functionName: "owner" })) as Address);
    if (owner !== me) throw new Error(`OstraDispatcher ${dispatcher} is owned by ${owner}, not by this account ${me}`);
    const [ostraCode, curveCode] = await Promise.all([client.getCode({ address: OSTRA }), client.getCode({ address: OSTRA_PONS_CURVE })]);
    if (keccak256(ostraCode ?? "0x") !== OSTRA_CODE_HASH) throw new Error(`OSTRA ${OSTRA} is not the code the SDK checked`);
    if (keccak256(curveCode ?? "0x") !== OSTRA_PONS_CURVE_CODE_HASH) throw new Error(`the Pons curve ${OSTRA_PONS_CURVE} is not the code the SDK checked`);
    if (getAddress(await client.readContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "token" })) !== OSTRA) throw new Error("the Pons curve does not trade OSTRA");

    // The curve's reserves before the run's first transaction: the buy is refused if its price rose much since.
    const reservesAtStart = (await client.readContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "graduated" }))
      ? null
      : await client.readContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "getReserves" });

    const wallet = createWalletClient({ account, chain: robinhoodChain, transport: o.transport });
    const state = readState(o.statePath, me);
    const save = () => writeState(o.statePath, state);
    const add = (k: keyof BuybackState["pending"], x: bigint) => {
      const v = big(state.pending[k]) + x;
      if (v < 0n) throw new Error(`the ${k} waiting would fall below zero (${v}): the state does not match the chain`);
      state.pending[k] = v.toString();
    };
    const claimed: BuybackSummary["claimed"] = [];
    let burnedNow = 0n;

    /** Applies what a landed transaction of the run did to the state (from its own events). */
    const apply = async (f: Inflight, r: TransactionReceipt) => {
      // A cancel (a transfer of nothing to the account itself, signed at the nonce of a call that could no longer be
      // made) landed instead of the call: nothing happened.
      if (r.to !== null && getAddress(r.to) === me && getAddress(f.to) !== me) {
        log("cancelled", { step: f.step, hash: r.transactionHash });
        return;
      }
      const logs = r.logs.map((l) => ({ ...l, address: getAddress(l.address) }));
      const decode = <A extends readonly unknown[]>(abi: A, l: (typeof logs)[number]) => {
        try {
          return decodeEventLog({ abi: abi as never, topics: l.topics as [Hex, ...Hex[]], data: l.data }) as unknown as { eventName: string; args: Record<string, unknown> };
        } catch {
          return null;
        }
      };
      if (f.step === "claim_usdg" || f.step === "claim_eth" || f.step === "claim_ostra") {
        for (const l of logs) {
          if (l.address !== dispatcher) continue;
          const e = decode(ostraDispatcherAbi, l);
          if (e?.eventName !== "BuybackClaimed" || getAddress(e.args.to as Address) !== me) continue;
          const amount = e.args.amount as bigint;
          const currency = getAddress(e.args.currency as Address);
          const k = currency === USDG ? "usdg" : currency === zeroAddress ? "weth" : currency === OSTRA ? "ostra" : null;
          if (k === null) throw new Error(`a claim paid ${currency}, which this run does not handle`);
          add(k, amount);
          claimed.push({ currency: k === "weth" ? "ETH (as WETH)" : k.toUpperCase(), amount: amount.toString() });
        }
      } else if (f.step === "swap") {
        let usdgIn = 0n;
        let wethOut = 0n;
        for (const l of logs) {
          const e = l.address === USDG ? decode(usdgAbi, l) : l.address === WETH ? decode(wethAbi, l) : null;
          if (e?.eventName !== "Transfer") continue;
          const args = e.args as { from?: Address; to?: Address; src?: Address; dst?: Address; value?: bigint; wad?: bigint };
          const from = getAddress((args.from ?? args.src) as Address);
          const to = getAddress((args.to ?? args.dst) as Address);
          const v = (args.value ?? args.wad) as bigint;
          if (l.address === USDG && from === me) usdgIn += v;
          if (l.address === WETH && to === me) wethOut += v;
        }
        add("usdg", -usdgIn);
        add("weth", wethOut);
      } else if (f.step === "unwrap") {
        // withdraw(wad) unwraps exactly wad or reverts. (WETH on chain 4663 is a proxy whose withdraw emits no WETH9
        // Withdrawal event, seen on a fork on 20 Oct 2026, so the amount is the call's own, not an event's.)
        const wad = big(f.amount);
        add("weth", -wad);
        add("eth", wad);
      } else if (f.step === "buy") {
        let out = 0n;
        for (const l of logs) {
          if (l.address !== OSTRA) continue;
          const e = decode(ostraAbi, l);
          if (e?.eventName === "Transfer" && getAddress(e.args.from as Address) === OSTRA_PONS_CURVE && getAddress(e.args.to as Address) === me) out += e.args.value as bigint;
        }
        // The ETH is spent in full. A buy that made the curve graduate may have been filled only in part, with the rest
        // sent back: only then is the account's balance change in the block read, and what came back beyond the value
        // and the fee is counted as still waiting (at most the value; nothing when the block's balances cannot be read).
        let refund = 0n;
        if (await client.readContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "graduated" })) {
          try {
            const [before, after] = await Promise.all([client.getBalance({ address: me, blockNumber: r.blockNumber - 1n }), client.getBalance({ address: me, blockNumber: r.blockNumber })]);
            refund = after - before + big(f.value) + r.gasUsed * r.effectiveGasPrice;
          } catch (err) {
            log("buy_refund_unknown", { hash: r.transactionHash, reason: (err as Error).message.slice(0, 200) });
          }
          if (refund < 0n) refund = 0n;
          if (refund > big(f.value)) refund = big(f.value);
          if (refund !== 0n) log("buy_refund", { hash: r.transactionHash, wei: refund.toString() });
        }
        add("eth", -(big(f.value) - refund));
        add("ostra", out);
      } else if (f.step === "burn") {
        let burned = 0n;
        for (const l of logs) {
          if (l.address !== OSTRA) continue;
          const e = decode(ostraAbi, l);
          if (e?.eventName === "Transfer" && getAddress(e.args.from as Address) === me && getAddress(e.args.to as Address) === zeroAddress) burned += e.args.value as bigint;
        }
        add("ostra", -burned);
        state.burned = (big(state.burned) + burned).toString();
        burnedNow += burned;
      }
    };

    /** The receipt of `hash`, or null only when the node says it has none: any other error is thrown, never read as "none". */
    const receiptOf = async (hash: Hex): Promise<TransactionReceipt | null> => {
      try {
        return await client.getTransactionReceipt({ hash });
      } catch (err) {
        // By name: the client may come from another copy of viem than this module's (its class is then another one).
        if (err instanceof TransactionReceiptNotFoundError || (err as Error).name === "TransactionReceiptNotFoundError") return null;
        throw err;
      }
    };
    /** The receipt of `f` or of an earlier signature of it at the same nonce, looked for up to `ms`; null when none came. */
    const landedOf = async (f: Inflight, ms: number): Promise<TransactionReceipt | null> => {
      const deadline = Date.now() + ms;
      for (;;) {
        for (const h of [f.hash, ...f.prior]) {
          const r = await receiptOf(h);
          if (r !== null) return r;
        }
        if (Date.now() > deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
      }
    };

    /**
     * Waits for `f` to land and applies it: a reverted one is cleared with no effect and throws; one that has not
     * landed yet stays kept and throws, and the next run looks for it again.
     */
    const settle = async (f: Inflight, ms = RECEIPT_TIMEOUT_MS) => {
      const r = await landedOf(f, ms);
      if (r === null) throw new Error(`the ${f.step} transaction ${f.hash} (nonce ${f.nonce}) has not landed yet; it stays kept, and the next run looks for it again`);
      if (r.status !== "success") {
        state.inflight = null;
        save();
        log("reverted", { step: f.step, hash: r.transactionHash });
        throw new Error(`the ${f.step} transaction ${r.transactionHash} reverted`);
      }
      await apply(f, r);
      state.inflight = null;
      save();
      log("landed", { step: f.step, hash: r.transactionHash, gasUsed: r.gasUsed.toString() });
    };

    /** Signs `call` at `nonce` (or the next one) with fees now; one that would revert fails its gas estimate and is never signed. */
    const sign = async (step: Step, to: Address, data: Hex, value: bigint, amount: bigint, prior: Hex[], nonce?: number): Promise<Inflight> => {
      const req = await wallet.prepareTransactionRequest({ account, chain: robinhoodChain, to, data, value, ...(nonce === undefined ? {} : { nonce }) });
      const raw = await wallet.signTransaction(req as never);
      return { step, hash: keccak256(raw), raw, nonce: Number(req.nonce), value: value.toString(), to, data, amount: amount.toString(), prior, at: new Date().toISOString() };
    };

    /** Signs a transaction, keeps it in the state (durably) before it is sent, sends it and settles it. */
    const send = async (step: Step, to: Address, data: Hex, value = 0n, amount = 0n) => {
      const f = await sign(step, to, data, value, amount, []);
      state.inflight = f;
      save();
      await client.sendRawTransaction({ serializedTransaction: f.raw });
      log("sent", { step, hash: f.hash, nonce: f.nonce });
      await settle(f);
    };

    // 2. A transaction of an earlier run that was not seen landing.
    if (state.inflight !== null) {
      let f = state.inflight;
      const nonce = await client.getTransactionCount({ address: me, blockTag: "latest" });
      if (nonce > f.nonce) {
        // Its nonce is used: by one of its own signatures, whose receipt is looked for (a node may lag behind), or by
        // another transaction of this account. Which one cannot be told without a receipt, so the run stops.
        const r = await landedOf(f, LAGGING_NODE_MS);
        if (r === null) {
          throw new Error(
            `the kept ${f.step} transaction ${f.hash} (nonce ${f.nonce}) has no receipt, yet nonce ${f.nonce} is used: look it up on the explorer; ` +
              `if another transaction used that nonce, set "inflight" to null in ${o.statePath}; nothing was done`,
          );
        }
        log("recovered", { step: f.step, hash: r.transactionHash });
        await settle(f, 0);
      } else {
        // Not landed: sent again as signed; one the node refuses (its fee cap below the base fee now, say) is signed
        // again at the same nonce with fees now, and every signature's receipt is looked for.
        try {
          await client.sendRawTransaction({ serializedTransaction: f.raw });
          log("resent", { step: f.step, hash: f.hash });
        } catch (err) {
          if (!/already known|known transaction|already imported/i.test((err as Error).message)) {
            if (f.prior.length >= MAX_RESIGNS) throw new Error(`the kept ${f.step} transaction was signed ${f.prior.length + 1} times at nonce ${f.nonce} and is still refused: ${(err as Error).message.slice(0, 200)}`);
            const prior = [f.hash, ...f.prior];
            let next: Inflight;
            try {
              next = await sign(f.step, f.to, f.data, big(f.value), big(f.amount), prior, f.nonce);
            } catch (estimate) {
              // The call can no longer be made (a swap past its deadline, a buy below its minimum): its nonce is
              // used by a cancel instead, a transfer of nothing to the account itself; the kept call's fields stay,
              // so whichever of them lands is applied for what it is.
              const cancel = await sign(f.step, me, "0x", 0n, 0n, prior, f.nonce);
              next = { ...f, hash: cancel.hash, raw: cancel.raw, prior, at: cancel.at };
              log("cancelling", { step: f.step, nonce: f.nonce, reason: (estimate as Error).message.slice(0, 200) });
            }
            f = next;
            state.inflight = f;
            save();
            await client.sendRawTransaction({ serializedTransaction: f.raw });
            log("resigned", { step: f.step, hash: f.hash, nonce: f.nonce, refused: (err as Error).message.slice(0, 200) });
          }
        }
        await settle(f);
      }
    }

    // 1 (last part). What is waiting is held by the account.
    const [usdgHeld, wethHeld, ethHeld, ostraHeld] = await Promise.all([
      client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [me] }) as Promise<bigint>,
      client.readContract({ address: WETH, abi: wethAbi, functionName: "balanceOf", args: [me] }),
      client.getBalance({ address: me }),
      client.readContract({ address: OSTRA, abi: ostraAbi, functionName: "balanceOf", args: [me] }),
    ]);
    for (const [k, held] of [["usdg", usdgHeld], ["weth", wethHeld], ["eth", ethHeld], ["ostra", ostraHeld]] as const) {
      if (big(state.pending[k]) > held) throw new Error(`the state has ${state.pending[k]} ${k} waiting, but the account holds ${held}: nothing is done until that is explained`);
    }

    const graduated = await client.readContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "graduated" });
    if (graduated) log("graduated", { message: "OSTRA has graduated from its Pons curve: USDG and ETH are not claimed or spent until its new pool is wired; OSTRA is still claimed and burned" });
    const ethUsd = await readEthUsd(client);
    const ostraUsdE8 = graduated ? null : (await readPairUsdPrice(client, launchPair("OSTRA"))).priceE8;

    // 3. Claims.
    const owed = async (c: Address) => (await client.readContract({ address: dispatcher, abi: ostraDispatcherAbi, functionName: "buybackOwed", args: [c] })) as bigint;
    const claims: { step: Step; currency: Address; usdE6: (x: bigint) => bigint | null; spendable: boolean }[] = [
      { step: "claim_usdg", currency: USDG, usdE6: (x) => x, spendable: !graduated },
      { step: "claim_eth", currency: zeroAddress, usdE6: (x) => (x * ethUsd) / 10n ** 20n, spendable: !graduated },
      // OSTRA needs no route, only the burn: claimed even once the curve has graduated (then without a price to weigh it).
      { step: "claim_ostra", currency: OSTRA, usdE6: (x) => (ostraUsdE8 === null ? null : (x * ostraUsdE8) / 10n ** 20n), spendable: true },
    ];
    const waiting: BuybackSummary["waiting"] = [];
    for (const c of claims) {
      const amount = await owed(c.currency);
      if (amount === 0n) continue;
      const usd = c.usdE6(amount);
      if (!c.spendable) {
        waiting.push({ currency: c.currency, owed: amount.toString(), why: "OSTRA has graduated from its Pons curve" });
        continue;
      }
      if (usd !== null && usd < o.minUsdE6) {
        waiting.push({ currency: c.currency, owed: amount.toString(), why: `worth ${usd} (USD, 6 decimals), under the minimum ${o.minUsdE6}` });
        continue;
      }
      await send(c.step, dispatcher, encodeFunctionData({ abi: ostraDispatcherAbi, functionName: "claimBuyback", args: [c.currency, me] }));
    }
    for (const p of LAUNCH_PAIRS.filter((x) => x.kind === "stock")) {
      const amount = await owed(p.address);
      if (amount !== 0n) waiting.push({ currency: p.symbol, owed: amount.toString(), why: "no route from a stock token to ETH is wired yet" });
    }

    // 4. USDG to WETH.
    const usdgIn = big(state.pending.usdg);
    if (usdgIn > 0n && !graduated) {
      const best = await bestUsdgToWeth(client, usdgIn);
      if (best === null) throw new Error("no USDG/WETH v3 pool quotes the swap");
      // What Chainlink says the USDG is worth in wei: USDG units (6 decimals) at ethUsd (USD per ETH, 8 decimals).
      const fair = (usdgIn * 10n ** 20n) / ethUsd;
      if (best.out < bps(fair, ORACLE_TOLERANCE_BPS)) {
        throw new Error(`the best USDG/WETH quote (${best.out} wei for ${usdgIn} USDG units, fee ${best.fee}) is more than ${ORACLE_TOLERANCE_BPS} bps under Chainlink (${fair} wei): not swapped`);
      }
      const minOut = bps(best.out, SWAP_SLIPPAGE_BPS);
      if (minOut === 0n) throw new Error(`${usdgIn} USDG units quote to ${best.out} wei, too little to swap`);
      const erc20Allowance = (await client.readContract({ address: USDG, abi: usdgAbi, functionName: "allowance", args: [me, PERMIT2] })) as bigint;
      if (erc20Allowance < usdgIn) await send("approve_permit2", USDG, encodeFunctionData({ abi: usdgAbi, functionName: "approve", args: [PERMIT2, maxUint256] }));
      const [allowed, expiration] = await client.readContract({ address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [me, USDG, UNISWAP_UNIVERSAL_ROUTER] });
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (allowed < usdgIn || BigInt(expiration) < now + SWAP_DEADLINE_SECONDS) {
        await send("permit2_allowance", PERMIT2, encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [USDG, UNISWAP_UNIVERSAL_ROUTER, usdgIn, Number(now + PERMIT2_ALLOWANCE_SECONDS)] }));
      }
      const path = encodePacked(["address", "uint24", "address"], [USDG, best.fee, WETH]);
      // This Universal Router's V3_SWAP_EXACT_IN takes (recipient, amountIn, amountOutMin, path, payerIsUser,
      // minHopPricesX36): no per-hop price limits here, amountOutMin bounds the swap.
      const input = encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }, { type: "uint256[]" }],
        [me, usdgIn, minOut, path, true, []],
      );
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + SWAP_DEADLINE_SECONDS;
      log("swap", { usdg: usdgIn.toString(), fee: best.fee, quote: best.out.toString(), minOut: minOut.toString(), chainlink: fair.toString() });
      await send("swap", UNISWAP_UNIVERSAL_ROUTER, encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [encodePacked(["uint8"], [V3_SWAP_EXACT_IN]), [input], deadline] }));
    }

    // 5. WETH to ETH, ETH to OSTRA.
    const wethIn = big(state.pending.weth);
    if (wethIn > 0n && !graduated) await send("unwrap", WETH, encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [wethIn] }), 0n, wethIn);
    const ethWaiting = big(state.pending.eth);
    if (ethWaiting > 0n && !graduated && reservesAtStart !== null) {
      const [e, t] = await client.readContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "getReserves" });
      const [e0, t0] = reservesAtStart;
      // ETH per OSTRA now against at the start: e / t > e0 / t0 by more than BUY_MAX_PRICE_RISE_BPS is not bought at.
      if (e * t0 * BPS > e0 * t * (BPS + BUY_MAX_PRICE_RISE_BPS)) {
        log("buy_deferred", { message: "the curve's price rose more than the limit during the run; the ETH waits for the next run", wei: ethWaiting.toString() });
      } else {
        const cap = (e * BUY_MAX_RESERVE_BPS) / BPS;
        const ethIn = ethWaiting < cap ? ethWaiting : cap;
        const { result: expected } = await client.simulateContract({ address: OSTRA_PONS_CURVE, abi: ponsCurveAbi, functionName: "buy", args: [ethIn, 0n, me], value: ethIn, account });
        const minOut = bps(expected, BUY_SLIPPAGE_BPS);
        if (minOut === 0n) throw new Error(`a buy of ${ethIn} wei simulates to ${expected} OSTRA units, too little to buy`);
        log("buy", { wei: ethIn.toString(), waiting: ethWaiting.toString(), expected: expected.toString(), minOut: minOut.toString() });
        await send("buy", OSTRA_PONS_CURVE, encodeFunctionData({ abi: ponsCurveAbi, functionName: "buy", args: [ethIn, minOut, me] }), ethIn);
      }
    }

    // 6. Burn.
    const toBurn = big(state.pending.ostra);
    if (toBurn > 0n) await send("burn", OSTRA, encodeFunctionData({ abi: ostraAbi, functionName: "burn", args: [toBurn] }));

    const supply = await client.readContract({ address: OSTRA, abi: ostraAbi, functionName: "totalSupply" });
    const summary: BuybackSummary = { graduated, claimed, burnedNow: burnedNow.toString(), burned: state.burned, pending: { ...state.pending }, waiting, ostraSupply: supply.toString() };
    log("done", summary);
    return summary;
  } finally {
    unlock();
  }
}

/** Chainlink ETH/USD (8 decimals), refused when older than ETH_PRICE_MAX_AGE. */
async function readEthUsd(client: PublicClient): Promise<bigint> {
  const [round, block] = await Promise.all([client.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" }), client.getBlock()]);
  const answer = round[1];
  if (answer <= 0n) throw new Error(`Chainlink ETH/USD answers ${answer}`);
  if (Number(block.timestamp) - Number(round[3]) > ETH_PRICE_MAX_AGE) throw new Error("Chainlink ETH/USD is older than its heartbeat allows");
  return answer;
}

/** The USDG/WETH v3 pool that gives the most WETH for `amountIn` USDG units now (QuoterV2), or null. */
export async function bestUsdgToWeth(client: PublicClient, amountIn: bigint): Promise<{ fee: number; out: bigint } | null> {
  let best: { fee: number; out: bigint } | null = null;
  for (const fee of V3_FEE_TIERS) {
    const pool = (await client.readContract({ address: UNISWAP_V3_FACTORY, abi: v3FactoryAbi, functionName: "getPool", args: [USDG, WETH, fee] })) as Address;
    if (getAddress(pool) === zeroAddress) continue;
    try {
      const { data } = await client.call({
        to: UNISWAP_V3_QUOTER_V2,
        data: encodeFunctionData({ abi: quoterV2Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn: USDG, tokenOut: WETH, amountIn, fee, sqrtPriceLimitX96: 0n }] }),
        gas: 3_000_000n,
      });
      if (data === undefined) continue;
      const [out] = decodeFunctionResult({ abi: quoterV2Abi, functionName: "quoteExactInputSingle", data });
      if (best === null || out > best.out) best = { fee, out };
    } catch {
      // a pool that cannot quote this amount
    }
  }
  return best;
}
