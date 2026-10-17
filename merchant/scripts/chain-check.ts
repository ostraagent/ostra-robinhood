// Runs the seller server as a seller would use it, against the configured
// chain, with the stock x402 batch-settlement client (@x402/evm) as the
// buyer. Nothing is simulated: the keeper (keeper/src/main.ts) and the seller
// server (src/server.ts) run as their own processes and every step is a real
// transaction to Ostra's contracts, x402BatchSettlement and its deposit
// collector.
//
//   1. The seller's merchant key is created (OSTRA_MERCHANT_SECRETS in the run
//      directory) and its vault is created without a crank. The server must
//      refuse to start on an address that is not an Ostra vault and on a vault
//      whose crank is not the keeper crank; the vault then installs the keeper
//      crank with SetCrankKey (a WOTS-signed spend) and the server starts. Its
//      facilitator account gets ETH for the buyers' deposit transactions.
//   2. A buyer wallet (a fresh key) is funded with 2.5 tokens and ETH for its
//      cleanup transfers. Price 0.3 tokens.
//   3. Channel A: the 402 must name the seller's split as payTo, the seller
//      vault as receiverAuthorizer, the keeper's minimum withdraw delay, the
//      price and the suggested deposit (2). The first paid request deposits 2
//      with an EIP-3009 authorization (sent by the server's facilitator); three
//      more paid requests (vouchers 0.6 .. 1.2) get the resource and are
//      forwarded to the keeper, which claims 1.2 on its own (threshold 1
//      token). A replayed voucher is answered 409 and a voucher below the price
//      402. The server is restarted and a fifth paid request (1.5) still works
//      from its stored channel. The buyer's x402 refund goes to the keeper,
//      which claims 1.5, refunds the rest and pays out.
//   4. Channel B (deposit 0.5): one paid request (0.3), then the buyer goes
//      silent; after the idle timeout the server closes it through the keeper.
//   5. Balances are checked to the base unit.
// Whether the checks pass or a step fails, the run then cleans up: every
// channel it opened that still holds unclaimed escrow is closed through the
// keeper (signed by the run's merchant key), and the seller vault (WOTS
// transfer), the buyer wallet and the facilitator account return their
// tokens and ETH to the funder (an account keeps at most the fee margin of
// its last transfer).
//
// Environment: the keeper's variables (OSTRA_RPC_URL, OSTRA_DEPLOYMENT,
// OSTRA_KEEPER_SECRETS, OSTRA_KEEPER_DATA, OSTRA_KEEPER_LISTEN,
// OSTRA_KEEPER_FEE_RECIPIENT) with a keeper fee payer holding ETH, plus
//   OSTRA_MERCHANT_LISTEN  host:port for the seller server
//   OSTRA_CHECK_FUNDER     file (0600) with the 32-byte hex private key of an
//                          account holding ETH and at least 2.5 tokens
//   OSTRA_CHECK_STATE      directory (0700) for this check's keys and records;
//                          each run keeps its seller and buyer keys there, so
//                          funds can be recovered if a run stops half-way
//   OSTRA_CHECK_RECOVER    optional: the name of a run directory (run-...) in
//                          OSTRA_CHECK_STATE whose cleanup did not finish; the
//                          check then runs only that cleanup, from that run's keys

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  getAddress,
  hexToBytes,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  WotsKeychain,
  assertRobinhoodChain,
  channelId as computeChannelId,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  parseDeployment,
  readChannel,
  readVault,
  retryingHttp,
  robinhoodChain,
  signVaultSetCrankKey,
  signVaultTransfer,
  usdgAbi,
  vaultAddress,
  voucherTypedData,
  type ChannelConfig,
  type SignedSpend,
} from "@ostraagent/sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme as BatchSettlementClient } from "@x402/evm/batch-settlement/client";
import { parseListen } from "../src/config.ts";
import { wireChannelConfig } from "../src/forwarder.ts";
import { MerchantKeys, ensurePrivateDir, isPrivateKey } from "../src/keys.ts";
import { IDLE_TIMEOUT_SECONDS } from "../src/lifecycle.ts";
import { CHANNELS_DIR } from "../src/store.ts";

const NETWORK = `eip155:${robinhoodChain.id}` as const;
/** Deposit transactions the facilitator account is funded for, at the current fee. */
const FACILITATOR_DEPOSITS = 10n;
/** Gas of one deposit transaction, an upper bound (x402BatchSettlement.deposit through the ERC-3009 collector). */
const DEPOSIT_GAS = 300_000n;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const toJson = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

let failures = 0;
function check(ok: boolean, what: string, detail: unknown = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === "" ? "" : ` (${typeof detail === "string" ? detail : toJson(detail)})`}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`set ${name}`);
  return value;
}

async function readKey(path: string): Promise<Hex> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${path} must not be accessible by other users`);
  const text = (await readFile(path, "utf8")).trim().replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text) || !isPrivateKey(hexToBytes(`0x${text}`))) throw new Error(`${path}: expected a 32-byte secp256k1 private key in hex`);
  return `0x${text}`;
}

/** A fresh 32-byte secret written (0600) to `path` before use, so it survives a crash. */
async function newSecret(path: string, valid: (bytes: Uint8Array) => boolean = () => true): Promise<Uint8Array> {
  let secret: Uint8Array;
  do secret = new Uint8Array(randomBytes(32));
  while (!valid(secret));
  await writeFile(path, `${bytesToHex(secret).slice(2)}\n`, { mode: 0o600, flag: "wx" });
  return secret;
}

/** A 32-byte secret an earlier run wrote with newSecret. */
async function readSecret(path: string): Promise<Uint8Array> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${path} must not be accessible by other users`);
  const text = (await readFile(path, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${path}: expected 32 bytes of hex`);
  return hexToBytes(`0x${text}`);
}

/** A child process whose JSON log lines are kept for checks and echoed with a prefix. */
class Proc {
  readonly name: string;
  readonly child: ChildProcess;
  readonly events: Record<string, unknown>[] = [];
  readonly stderr: string[] = [];
  readonly exited: Promise<number | null>;

  constructor(name: string, script: string, env: Record<string, string>) {
    this.name = name;
    this.child = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
    if (this.child.stdout !== null) {
      createInterface({ input: this.child.stdout }).on("line", (line) => {
        console.log(`  ${name} | ${line}`);
        try {
          this.events.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // not a log event
        }
      });
    }
    if (this.child.stderr !== null) {
      createInterface({ input: this.child.stderr }).on("line", (line) => {
        console.log(`  ${name} ! ${line}`);
        this.stderr.push(line);
      });
    }
  }

  async waitEvent(match: (e: Record<string, unknown>) => boolean, seconds: number): Promise<Record<string, unknown> | undefined> {
    for (let i = 0; i < seconds * 4; i++) {
      const found = this.events.find(match);
      if (found !== undefined) return found;
      await sleep(250);
    }
    return this.events.find(match);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      await this.exited;
    }
  }
}

async function waitHttp(url: string, seconds: number): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(5_000) })).ok) return;
    } catch {
      // not listening yet
    }
    if (i >= seconds) throw new Error(`${url} did not answer`);
    await sleep(1_000);
  }
}

async function main(): Promise<void> {
  const rpcUrl = required("OSTRA_RPC_URL");
  const d = parseDeployment(JSON.parse(await readFile(required("OSTRA_DEPLOYMENT"), "utf8")));
  const token = d.token;
  const keeperListen = parseListen(required("OSTRA_KEEPER_LISTEN"));
  const merchantListen = parseListen(required("OSTRA_MERCHANT_LISTEN"));
  const funder = privateKeyToAccount(await readKey(required("OSTRA_CHECK_FUNDER")));
  const stateDir = required("OSTRA_CHECK_STATE");
  const recoverRun = process.env.OSTRA_CHECK_RECOVER === undefined || process.env.OSTRA_CHECK_RECOVER === "" ? undefined : process.env.OSTRA_CHECK_RECOVER;
  if (recoverRun !== undefined && !/^run-[0-9]+$/.test(recoverRun)) throw new Error("OSTRA_CHECK_RECOVER must be a run directory name (run-<number>)");

  const transport = retryingHttp(rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
  await assertRobinhoodChain(client);
  const decimals = await client.readContract({ address: token, abi: usdgAbi, functionName: "decimals" });
  const unit = 10n ** BigInt(decimals);
  const tokens = (text: string) => {
    const [whole, fraction = ""] = text.split(".");
    return BigInt(whole as string) * unit + BigInt(fraction.padEnd(decimals, "0"));
  };
  const price = tokens("0.3");
  const balance = (owner: Address) => client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [owner] });
  const walletOf = (account: PrivateKeyAccount) => createWalletClient({ account, chain: robinhoodChain, transport });
  const call = async (account: PrivateKeyAccount, address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> => {
    const hash = await walletOf(account).writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, account, chain: robinhoodChain });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return hash;
  };
  const spend = (vault: Address, s: SignedSpend) => call(funder, vault, ostraVaultAbi, "spend", [s.action, s.nextKeyRoot, s.params, s.signature]);
  /** Sends `account`'s ETH to `to`, keeping what the transfer may cost in fees. */
  const sweepEth = async (account: PrivateKeyAccount, to: Address): Promise<bigint> => {
    const held = await client.getBalance({ address: account.address });
    const gas = await client.estimateGas({ account: account.address, to, value: 0n });
    const { maxFeePerGas } = await client.estimateFeesPerGas();
    const fee = gas * maxFeePerGas;
    if (held <= fee) return 0n;
    const hash = await walletOf(account).sendTransaction({ account, chain: robinhoodChain, to, value: held - fee, gas, maxFeePerGas });
    await client.waitForTransactionReceipt({ hash });
    return held - fee;
  };
  const sendEth = async (to: Address, value: bigint) => {
    const hash = await walletOf(funder).sendTransaction({ account: funder, chain: robinhoodChain, to, value });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`ETH transfer to ${to} reverted`);
  };

  await ensurePrivateDir(stateDir);
  const runDir = join(stateDir, recoverRun ?? `run-${Date.now()}`);
  if (recoverRun === undefined) await ensurePrivateDir(runDir);
  else if (!(await stat(runDir)).isDirectory()) throw new Error(`${runDir} is not a directory`);
  const secret = (name: string, valid?: (bytes: Uint8Array) => boolean) => (recoverRun === undefined ? newSecret(join(runDir, name), valid) : readSecret(join(runDir, name)));
  const wotsStore = new FileWotsStore(join(runDir, "wots"));
  console.log(`funder ${funder.address}, run state ${runDir}${recoverRun === undefined ? "" : " (recovery only)"}`);

  const baseEnv: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "OSTRA_RPC_URL", "OSTRA_DEPLOYMENT"]) {
    const value = process.env[name];
    if (value !== undefined && value !== "") baseEnv[name] = value;
  }
  const keeperEnv: Record<string, string> = { ...baseEnv };
  for (const name of ["OSTRA_KEEPER_SECRETS", "OSTRA_KEEPER_DATA", "OSTRA_KEEPER_LISTEN", "OSTRA_KEEPER_FEE_RECIPIENT"]) {
    const value = process.env[name];
    if (value !== undefined && value !== "") keeperEnv[name] = value;
  }
  const keeperUrl = `http://${keeperListen.host}:${keeperListen.port}`;
  const merchantUrl = `http://${merchantListen.host}:${merchantListen.port}`;
  const merchantSecrets = join(runDir, "merchant-secrets");
  const merchantData = join(runDir, "merchant-data");
  const merchantEnv = (vault: Address): Record<string, string> => ({
    ...baseEnv,
    OSTRA_MERCHANT_SECRETS: merchantSecrets,
    OSTRA_MERCHANT_DATA: merchantData,
    OSTRA_MERCHANT_VAULT: vault,
    OSTRA_KEEPER_URL: keeperUrl,
    OSTRA_MERCHANT_LISTEN: `${merchantListen.host}:${merchantListen.port}`,
    OSTRA_MERCHANT_PRICE: price.toString(),
    OSTRA_MERCHANT_DEPOSIT: tokens("2").toString(),
  });
  const serverScript = fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const keeper = new Proc("keeper", fileURLToPath(new URL("../../keeper/src/main.ts", import.meta.url)), keeperEnv);
  let server: Proc | undefined;

  // What the cleanup needs, set as each part of the run comes to exist.
  const opened = new Map<string, ChannelConfig>();
  let merchantKeys: MerchantKeys | undefined;
  let feeSplit: { recipient: Address; bps: number } | undefined;
  let sellerKeys: WotsKeychain | undefined;
  let sellerVault: Address | undefined;
  let buyer: PrivateKeyAccount | undefined;

  /** Closes every unfinished channel of the run through the keeper and returns the run's funds to the funder. */
  const cleanup = async () => {
    if (server !== undefined) {
      await server.stop();
      server = undefined;
    }
    const channels = new Map(opened);
    try {
      for (const name of await readdir(join(merchantData, CHANNELS_DIR))) {
        if (!name.endsWith(".json")) continue;
        const record = JSON.parse(await readFile(join(merchantData, CHANNELS_DIR, name), "utf8")) as { channel: { channelId: string; channelConfig: ChannelConfig } };
        channels.set(record.channel.channelId.toLowerCase(), wireChannelConfig(record.channel.channelConfig));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const [channel, config] of channels) {
      try {
        const ch = await readChannel(client, d.batchSettlement, channel as Hex);
        if (ch.balance === ch.totalClaimed) continue;
        if (merchantKeys === undefined || feeSplit === undefined) throw new Error("the run's merchant key is not loaded");
        const signature = await merchantKeys.signCloseRequest(d.chainId, channel as Hex);
        const res = await fetch(`${keeperUrl}/v1/close`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ merchant: merchantKeys.merchant, channelConfig: config, signature, splits: [feeSplit] }),
          signal: AbortSignal.timeout(240_000),
        });
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        check(res.status === 200, `cleanup: the keeper closed unfinished channel ${channel} (unclaimed ${ch.balance - ch.totalClaimed})`, body ?? res.status);
      } catch (err) {
        check(false, `cleanup: close channel ${channel}`, err instanceof Error ? err.message : String(err));
      }
    }
    try {
      if (sellerKeys !== undefined && sellerVault !== undefined) {
        const amount = await balance(sellerVault);
        const v = await readVault(client, d, sellerVault);
        if (amount > 0n && v !== null) {
          await spend(sellerVault, await signVaultTransfer(sellerKeys, v, { chainId: d.chainId, to: funder.address, amount }));
          console.log(`seller vault returned ${amount} base units to the funder`);
        }
      }
    } catch (err) {
      check(false, "cleanup: return the seller vault's tokens", err instanceof Error ? err.message : String(err));
    }
    try {
      if (buyer !== undefined) {
        const left = await balance(buyer.address);
        if (left > 0n) await call(buyer, token, usdgAbi, "transfer", [funder.address, left]);
        const eth = await sweepEth(buyer, funder.address);
        console.log(`buyer wallet returned ${left} base units and ${eth} wei to the funder`);
      }
    } catch (err) {
      check(false, "cleanup: return the buyer wallet's tokens and ETH", err instanceof Error ? err.message : String(err));
    }
    try {
      if (merchantKeys !== undefined) {
        const eth = await sweepEth(merchantKeys.facilitator, funder.address);
        console.log(`the facilitator account returned ${eth} wei to the funder`);
      }
    } catch (err) {
      check(false, "cleanup: return the facilitator account's ETH", err instanceof Error ? err.message : String(err));
    }
  };

  let runError: unknown;
  try {
    await waitHttp(`${keeperUrl}/v1/health`, 60);
    const health = (await (await fetch(`${keeperUrl}/v1/health`)).json()) as Record<string, unknown>;
    if (BigInt(health.feePayerWei as string) === 0n) {
      throw new Error(`the keeper fee payer ${String(health.feePayer)} has no ETH; fund it before running this check`);
    }
    console.log(`keeper fee payer ${String(health.feePayer)} holds ${String(health.feePayerWei)} wei`);
    const terms = (await (await fetch(`${keeperUrl}/v1/terms`)).json()) as { feeRecipient: Address; feeBps: number; minGraceSeconds: number };
    const feeRecipient = getAddress(terms.feeRecipient);
    feeSplit = { recipient: feeRecipient, bps: terms.feeBps };

    // --- 1. seller: merchant key, vault, keeper crank ------------------------
    if (recoverRun !== undefined) await stat(join(merchantSecrets, "merchant.key"));
    merchantKeys = await MerchantKeys.open(merchantSecrets);
    const crank = getAddress(((await (await fetch(`${keeperUrl}/v1/crank?merchant=${merchantKeys.merchant}`)).json()) as { crank: string }).crank);
    console.log(`merchant key ${merchantKeys.merchant}, keeper crank ${crank}`);
    sellerKeys = new WotsKeychain(await secret("seller-master.key"), await secret("seller-keychain.id"), wotsStore);
    const root0 = bytesToHex(sellerKeys.keyRoot(0n));
    const vault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot: root0, initialCrank: zeroAddress });
    if (recoverRun !== undefined) {
      sellerVault = vault;
      buyer = privateKeyToAccount(bytesToHex(await secret("buyer.key")));
      return;
    }
    await call(funder, d.vaultFactory, ostraVaultFactoryAbi, "createVault", [token, root0, zeroAddress]);
    sellerVault = vault;
    check((await readVault(client, d, vault))?.crank === null, "seller vault created without a crank", vault);

    const refused = async (target: Address, pattern: RegExp, what: string) => {
      const p = new Proc("merchant", serverScript, merchantEnv(target));
      const code = await Promise.race([p.exited, sleep(60_000).then(() => "timeout" as const)]);
      if (code === "timeout") await p.stop();
      check(code === 1 && p.stderr.some((line) => pattern.test(line)), what, p.stderr.at(-1) ?? String(code));
    };
    await refused(funder.address, /is not an Ostra vault/, "the server refuses an address that is not an Ostra vault");
    await refused(vault, /install it with SetCrankKey first/, "the server refuses a vault whose crank is not the keeper crank");

    const sellerState = await readVault(client, d, vault);
    if (sellerState === null) throw new Error("seller vault missing");
    await spend(vault, await signVaultSetCrankKey(sellerKeys, sellerState, { chainId: d.chainId, crank }));
    check((await readVault(client, d, vault))?.crank === crank, "SetCrankKey installed the keeper crank on the seller vault");

    const { maxFeePerGas } = await client.estimateFeesPerGas();
    await sendEth(merchantKeys.facilitator.address, FACILITATOR_DEPOSITS * DEPOSIT_GAS * maxFeePerGas);
    server = new Proc("merchant", serverScript, merchantEnv(vault));
    await waitHttp(`${merchantUrl}/v1/merchant`, 60);
    const facts = (await (await fetch(`${merchantUrl}/v1/merchant`)).json()) as Record<string, unknown>;
    const split = facts.split as Address;
    check(
      facts.merchant === merchantKeys.merchant &&
        facts.vault === vault &&
        facts.crank === crank &&
        facts.token === token &&
        facts.price === price.toString() &&
        facts.gracePeriodSeconds === terms.minGraceSeconds &&
        facts.facilitator === merchantKeys.facilitator.address &&
        toJson(facts.splits) === toJson([{ recipient: feeRecipient, bps: terms.feeBps }]),
      "GET /v1/merchant: vault, keeper crank, split, price, the keeper's minimum withdraw delay and fee split, the facilitator",
      facts,
    );

    // --- 2. buyer wallet ------------------------------------------------------
    const wallet = privateKeyToAccount(bytesToHex(await secret("buyer.key", isPrivateKey)));
    buyer = wallet;
    await call(funder, token, usdgAbi, "transfer", [wallet.address, tokens("2.5")]);
    const transferGas = await client.estimateContractGas({ account: wallet.address, address: token, abi: usdgAbi, functionName: "transfer", args: [funder.address, 1n] });
    const ethGas = await client.estimateGas({ account: wallet.address, to: funder.address, value: 0n });
    await sendEth(wallet.address, 2n * (transferGas + ethGas) * maxFeePerGas);
    check((await balance(wallet.address)) === tokens("2.5"), "buyer wallet funded with 2.5 tokens and ETH", wallet.address);
    const feeBefore = await balance(feeRecipient);
    const sellerBefore = await balance(vault);

    // --- x402 buyer helpers ---------------------------------------------------
    const newClient = (salt: Hex, deposit?: bigint) => {
      const scheme = new BatchSettlementClient(toClientEvmSigner(wallet, client as never), {
        salt,
        ...(deposit === undefined ? {} : { depositStrategy: () => deposit.toString() }),
      });
      const x = new x402Client().register(NETWORK, scheme);
      x.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: token }] });
      return { scheme, http: new x402HTTPClient(x) };
    };
    type Buyer = ReturnType<typeof newClient>;
    const challenge = async () => {
      const res = await fetch(`${merchantUrl}/paid`);
      if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`);
      return decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
    };
    const send = async (b: Buyer, payload: PaymentPayload) => {
      const res = await fetch(`${merchantUrl}/paid`, { headers: b.http.encodePaymentSignatureHeader(payload), signal: AbortSignal.timeout(240_000) });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const required402 = res.headers.get("payment-required");
      if (res.status !== 409) await b.http.processPaymentResult(payload, (n) => res.headers.get(n), res.status);
      return { status: res.status, body, error: required402 === null ? undefined : decodePaymentRequiredHeader(required402).error };
    };
    let lastPaid: PaymentPayload | undefined;
    const paid = async (b: Buyer, label: string, cumulative: bigint) => {
      const payload = await b.http.createPaymentPayload(await challenge());
      const config = (payload.payload as { channelConfig: ChannelConfig }).channelConfig;
      const id = computeChannelId(wireChannelConfig(config), d.chainId, d.batchSettlement).toLowerCase();
      opened.set(id, wireChannelConfig(config));
      const r = await send(b, payload);
      lastPaid = payload;
      check(r.status === 200 && r.body?.ok === true, `paid request ${label}: the resource is served`, { status: r.status, body: r.body, error: r.error });
      const forwarded = await server?.waitEvent((e) => e.event === "voucher_forwarded" && e.channel === id && e.cumulative === cumulative.toString(), 30);
      check(forwarded?.accepted === true, `voucher ${label} forwarded to the keeper and accepted`, forwarded ?? "not forwarded");
      return id as Hex;
    };
    const waitChannel = async (channel: Hex, done: (ch: Awaited<ReturnType<typeof readChannel>>) => boolean, seconds: number) => {
      for (let i = 0; i < seconds; i += 3) {
        const ch = await readChannel(client, d.batchSettlement, channel);
        if (done(ch)) return ch;
        await sleep(3_000);
      }
      return readChannel(client, d.batchSettlement, channel);
    };

    // --- 3. channel A -----------------------------------------------------------
    const offer = (await challenge()).accepts[0];
    check(
      offer !== undefined &&
        offer.scheme === "batch-settlement" &&
        offer.network === NETWORK &&
        offer.payTo === split &&
        offer.amount === price.toString() &&
        offer.asset === token &&
        offer.extra.receiverAuthorizer === vault &&
        offer.extra.withdrawDelay === terms.minGraceSeconds &&
        offer.extra.minDeposit === tokens("2").toString(),
      "the 402 names the seller's split, the seller vault, the price, the keeper's withdraw delay and the suggested deposit",
      offer ?? "none",
    );
    const buyerA = newClient(keccak256(new Uint8Array(randomBytes(32))));
    const channelA = await paid(buyerA, "0.3 (deposit 2 with an EIP-3009 authorization)", price);
    console.log(`channel A ${channelA}`);
    let ch = await readChannel(client, d.batchSettlement, channelA);
    check(ch.balance === tokens("2") && ch.totalClaimed === 0n, "the facilitator deposited 2 into channel A", ch);
    for (const label of ["0.6", "0.9"]) await paid(buyerA, label, tokens(label));
    if (lastPaid === undefined) throw new Error("no paid request");
    const replay = await send(buyerA, lastPaid);
    check(replay.status === 409 && replay.body?.error === "voucher_replayed", "a replayed voucher is refused 409 without the resource", replay);
    const under = structuredClone(lastPaid);
    const voucher = (under.payload as { voucher: { maxClaimableAmount: string; signature: Hex } }).voucher;
    voucher.maxClaimableAmount = (tokens("0.9") + price - 1n).toString();
    voucher.signature = await wallet.signTypedData(voucherTypedData({ channelId: channelA, maxClaimableAmount: BigInt(voucher.maxClaimableAmount), chainId: d.chainId, settlement: d.batchSettlement }));
    const short = await fetch(`${merchantUrl}/paid`, { headers: buyerA.http.encodePaymentSignatureHeader(under) });
    const shortError = decodePaymentRequiredHeader(short.headers.get("payment-required") ?? "").error;
    check(short.status === 402 && shortError === "invalid_batch_settlement_evm_cumulative_amount_mismatch", "a voucher below the price is refused 402", { status: short.status, error: shortError });
    check((await readChannel(client, d.batchSettlement, channelA)).totalClaimed === 0n, "nothing claimed below the keeper threshold of 1 token");
    await paid(buyerA, "1.2", tokens("1.2"));
    ch = await waitChannel(channelA, (c) => c.totalClaimed === tokens("1.2"), 90);
    check(ch.totalClaimed === tokens("1.2") && ch.balance === tokens("2"), "the keeper claimed 1.2 on its own (threshold 1 token)", ch);

    await server.stop();
    server = new Proc("merchant", serverScript, merchantEnv(vault));
    await waitHttp(`${merchantUrl}/v1/merchant`, 60);
    await paid(buyerA, "1.5 after a server restart", tokens("1.5"));

    const refund = await buyerA.scheme.refund(`${merchantUrl}/paid`);
    check(
      refund.success && /^0x[0-9a-f]{64}$/.test(refund.transaction) && refund.amount === tokens("0.5").toString(),
      "the buyer's refund is closed through the keeper: claimed 1.5, 0.5 refunded",
      refund,
    );
    ch = await readChannel(client, d.batchSettlement, channelA);
    check(ch.totalClaimed === tokens("1.5") && ch.balance === ch.totalClaimed, "channel A holds no unclaimed escrow, claimed at 1.5", ch);

    // --- 4. channel B: the buyer goes silent ---------------------------------------
    const buyerB = newClient(keccak256(new Uint8Array(randomBytes(32))), tokens("0.5"));
    const channelB = await paid(buyerB, "0.3 on channel B (deposit 0.5)", price);
    console.log(`channel B ${channelB}; the server must close it after ${IDLE_TIMEOUT_SECONDS} s without activity`);
    const idleClose = await server.waitEvent((e) => e.event === "channel_closed_by_keeper" && e.channel === channelB && e.why === "idle", IDLE_TIMEOUT_SECONDS + 240);
    check(idleClose !== undefined, "the idle channel B was closed by the server through the keeper", idleClose ?? "no close");
    ch = await waitChannel(channelB, (c) => c.balance === c.totalClaimed, 60);
    check(ch.totalClaimed === price && ch.balance === ch.totalClaimed, "channel B claimed at 0.3 with nothing left unclaimed", ch);

    // --- 5. balances -------------------------------------------------------------
    const share = (amount: bigint) => (amount * BigInt(terms.feeBps)) / 10_000n;
    const paidA = tokens("1.5");
    const paidB = price;
    const sellerGot = (await balance(vault)) - sellerBefore;
    check(sellerGot === paidA - share(paidA) + (paidB - share(paidB)), "seller vault holds both payments minus the keeper fee", `${sellerGot}`);
    const feeGot = (await balance(feeRecipient)) - feeBefore;
    check(feeGot === share(paidA) + share(paidB), "the keeper fee recipient got its bps of each channel", `${feeGot}`);
    check((await balance(split)) === 0n, "the seller's split holds nothing after release");
    const buyerLeft = await balance(wallet.address);
    check(buyerLeft === tokens("2.5") - paidA - paidB, "the buyer wallet got every unspent deposit back", `${buyerLeft}`);
  } catch (err) {
    runError = err;
  } finally {
    try {
      if (merchantKeys !== undefined || buyer !== undefined) await cleanup();
    } finally {
      await keeper.stop();
    }
    // Reported here so the recovery-only path, which returns early, is reported too.
    if (runError === undefined) {
      if (recoverRun !== undefined) console.log(failures === 0 ? "RECOVERY DONE" : `RECOVERY: ${failures} STEP(S) FAILED`);
      else console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
      process.exitCode = failures === 0 ? 0 : 1;
    }
  }
  if (runError !== undefined) throw runError;
}

main().catch((err: unknown) => {
  const url = process.env.OSTRA_RPC_URL;
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(url === undefined || url === "" ? message : message.split(url).join("<rpc>"));
  process.exit(1);
});
