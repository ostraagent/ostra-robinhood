// Runs the core package's vault, relayer client and channel services end to
// end against the configured chain, as the MCP package and the web app use
// them: the keeper (keeper/src/main.ts), the relayer (relayer/src/server.ts)
// and a seller server (merchant/src/server.ts) each run as their own process.
// The agent holds no ETH: every transaction of its vaults is sent by the
// relayer and paid from its vault's channel to the relayer, signed by the
// core relayer client. Nothing is simulated: every step is a real transaction.
//
//   1. The relayer's vault is created and installs the keeper crank; the
//      relayer account gets ETH; the relayer server starts. The core relayer
//      client reads and checks its terms (its vault and split on-chain).
//   2. open_vault through the relayer: the buyer vault is created before
//      payment and owes its price; opened again, it is found, not created.
//   3. The funder funds the buyer vault. A withdrawal (0.01) through the
//      relayer: the client opens a channel to the relayer on its terms, the
//      channel's first voucher pays the open and the vault's debt, then the
//      withdrawal is paid by a voucher and lands.
//   4. The seller vault is created with the keeper crank of the agent's
//      merchant key, paid up front from the buyer vault's relayer channel
//      (prepay); the seller server starts on it.
//   5. open_channel from the buyer vault to the seller vault with the seller's
//      splits and grace period: the channel's receiver is the seller's
//      OstraSplit. Two requests to the seller's paid route are paid with
//      vouchers of that channel (stock x402 client, the vault as payer); the
//      seller server adopts the vault channel and forwards the vouchers.
//   6. close_channel: requestClose signed by the channel's voucher key, sent
//      through the relayer; the keeper claims the last voucher and refunds
//      the rest to the buyer vault on the WithdrawInitiated it watches; the
//      next close_channel finds nothing left and finishes the record.
//   7. rotate_crank and back: the seller vault installs its own crank, sent
//      by the agent's local fee payer (as without the relayer), then the
//      keeper crank again through the relayer; the same crank again is
//      unchanged.
//   8. Accounting: every token the buyer vault was funded with is in the
//      vault, in a channel, or withdrawn; the seller claimed exactly its two
//      prices; the relayer claimed no more than the vouchers signed.
//   9. The relayer's signature escrow, as a lost device needs it: a
//      withdrawal is signed, escrowed with the relayer (POST /v1/escrow) and
//      never sent (the device is lost). A device restored from the seed with
//      no WOTS records finds that signature in the escrow and sends it
//      instead of signing a second message with the same key; its next
//      withdrawal is escrowed before its fee payer sends it. A restored
//      device that cannot reach the escrow signs nothing.
//  10. The passkey backup of the seed (POST and GET /v1/backups/<name>): the
//      seed, encrypted under a passkey's PRF output (32 random bytes stand in
//      for an authenticator's), is kept by the relayer and opened by a new
//      device with the same passkey; another seed cannot replace it, another
//      passkey cannot open it, and the seed's backup key deletes it.
//  11. The launchpad through the relayer (when the deployment has one): the
//      creator vault is created before payment as its debt and funded; a
//      launch with a dev buy the contract would refuse is refused by its quote
//      and nothing is signed; a launch bundled with another call is refused by
//      the relayer's policy; the launch with a dev buy is sent from the
//      creator vault's own relayer channel, the relayer fronting the ETH launch
//      fee (its log shows the value) and charging it; every token the creator
//      vault was funded with is in the vault, its relayer channels or the dev
//      buy. A buy from the buyer vault creates the agent's token vault in the
//      same request; selling all of it back (the token vault's spend paid by
//      the buyer vault) returns USDG to the buyer vault.
//  12. A launch paired with a Robinhood stock token (when OSTRA_CHECK_PAIRS
//      names one): the pairs list names the agent's vaults for it; moving the
//      stock token from the agent's vault of it creates that vault and the
//      stock token's creator vault, paid up front from the buyer vault's
//      relayer channel; the launch with a dev buy in the stock token is sent
//      from that creator vault, the buyer vault's relayer channel fronting the
//      fee, at a starting market cap in US dollars set in the stock token at
//      its Chainlink price; a buy paid in the stock token from its vault, and
//      selling it all back into that vault; the pool's creator payout in the
//      stock token; the creator vault sending the stock token back.
//  13. A launch paired with ETH (with step 12): the WETH creator vault, funded
//      before it exists, pays a dev buy in WETH; the pool trades against ETH,
//      so a buy from a vault is refused and nothing is signed; the WETH
//      creator vault sends its WETH out.
// Whether the checks pass or a step fails, the run then cleans up: every
// relayer channel still holding unclaimed escrow is closed through the keeper
// (signed with the relayer's merchant key), and the vaults, the relayer
// account and the agent's fee payer return their tokens and ETH to the
// funder.
//
// Environment: the keeper's variables (OSTRA_RPC_URL, OSTRA_DEPLOYMENT,
// OSTRA_KEEPER_SECRETS, OSTRA_KEEPER_DATA, OSTRA_KEEPER_LISTEN,
// OSTRA_KEEPER_FEE_RECIPIENT) with a keeper fee payer holding ETH, plus
//   OSTRA_RELAYER_LISTEN   host:port for the relayer server
//   OSTRA_MERCHANT_LISTEN  host:port for the seller server
//   OSTRA_CHECK_FUNDER     file (0600) with the 32-byte hex private key of an
//                          account holding ETH and tokens: 30 times the price
//                          of a createVault plus 1 (about 0.4 at 0.02 gwei),
//                          plus, for the launchpad step, twice the price of a
//                          launch (gas and fee) plus 2 (about 4 at 0.02 gwei);
//                          all of it comes back at the end but the gas
//   OSTRA_CHECK_STATE      directory (0700) for this check's keys and records;
//                          each run keeps its keys there, so funds can be
//                          recovered if a run stops half-way
//   OSTRA_CHECK_RECOVER    optional: the name of a run directory (run-...) in
//                          OSTRA_CHECK_STATE whose cleanup did not finish; the
//                          check then runs only that cleanup, from that run's keys
//   OSTRA_CHECK_PAIRS      optional: the ticker of a stock token Ostra offers as a
//                          pair (pairs.ts), which runs steps 12 and 13; the funder
//                          then also holds PAIR_STOCK_FUNDING of that stock token
//                          and PAIR_WETH_FUNDING more ETH, and the relayer gets
//                          PAIR_RELAYER_GAS more; the buyer vault, whose relayer
//                          channel pays both launches, gets three times the price
//                          of a launch plus PAIR_BUYER_ROOM more USDG

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { bytesToHex, createPublicClient, createWalletClient, encodeFunctionData, getAddress, hexToBytes, parseAbi, parseEventLogs, zeroAddress, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme, type BatchSettlementClientContext } from "@x402/evm/batch-settlement/client";
import {
  CHAINLINK_ETH_USD,
  FileWotsStore,
  WETH,
  findLaunchPair,
  ostraDispatcherAbi,
  ostraLaunchpadAbi,
  readPairUsdPrice,
  usdToQuoteUnits,
  type LaunchPair,
  LAUNCHPAD,
  NO_DEV_BUY,
  WOTS_SIGNATURE_LEN,
  WotsKeychain,
  assertRobinhoodChain,
  chainlinkEthUsd,
  launchFromVaultData,
  launchParams,
  ostraTokenAbi,
  decodeVaultSpendMessage,
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
  weiToTokenUnits,
  withMargin,
  type ChannelConfig,
  type SignedSpend,
} from "@ostraagent/sdk";
import { wireChannelConfig } from "../../merchant/src/forwarder.ts";
import { MerchantKeys, ensurePrivateDir, isPrivateKey } from "../../merchant/src/keys.ts";
import { CHANNELS_DIR } from "../../merchant/src/store.ts";
import { parseListen } from "../../relayer/src/config.ts";
import { openRelayerAccount } from "../../relayer/src/keys.ts";
import { ChannelService, DEV_BUY_LAUNCH_GAS, Keys, LaunchpadService, LocalSender, PasskeyBackupClient, RelayerClient, RelayerError, SignatureEscrowClient, VaultService, X402_NETWORK, backupName, formatUnitsAmount, type Config } from "../src/index.ts";
import { MemoryFolder } from "../test/memory-folder.ts";

/** Gas the relayer account is funded for, at the current fee: about forty relayed transactions, and a launch (plus its fee, sent with it). */
const RELAYER_GAS_BUDGET = 40n * 1_500_000n + 5_000_000n;
/** Gas the agent's fee payer is funded for: three vault spends sent by itself, with headroom. */
const FEE_PAYER_GAS_BUDGET = 4n * 400_000n * 2n;
/** Steps 12 and 13: the stock token the funder sends to the agent's vault of it (base units, 18 decimals: 0.2). */
const PAIR_STOCK_FUNDING = 200_000_000_000_000_000n;
/** Step 13: the ETH the funder wraps and sends to the WETH creator vault (0.001). */
const PAIR_WETH_FUNDING = 1_000_000_000_000_000n;
/** Steps 12 and 13: more relayer gas (about twenty relayed transactions and two launches), plus two launch fees. */
const PAIR_RELAYER_GAS = 20n * 1_500_000n + 2n * 5_000_000n;
/** Steps 12 and 13: the buyer vault's relayer channel pays both launches (three times the price of a launch is sent for them) and every other operation of both steps (this much more USDG). */
const PAIR_BUYER_ROOM = "4";
/** A stock token's dev buy, buy and creator withdrawal in step 12 (0.05, 0.02, 0.01), and the WETH dev buy of step 13 (0.0005). */
const PAIR_DEV_BUY = "0.05";
const PAIR_BUY = "0.02";
const PAIR_WITHDRAW = "0.01";
const ETH_DEV_BUY = "0.0005";
const wethAbi = parseAbi(["function deposit() payable"]);
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
    if (this.child.stderr !== null) createInterface({ input: this.child.stderr }).on("line", (line) => console.log(`  ${name} ! ${line}`));
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
  const relayerListen = parseListen(required("OSTRA_RELAYER_LISTEN"));
  const merchantListen = parseListen(required("OSTRA_MERCHANT_LISTEN"));
  const funder = privateKeyToAccount(await readKey(required("OSTRA_CHECK_FUNDER")));
  const stateDir = required("OSTRA_CHECK_STATE");
  const recoverRun = process.env.OSTRA_CHECK_RECOVER === undefined || process.env.OSTRA_CHECK_RECOVER === "" ? undefined : process.env.OSTRA_CHECK_RECOVER;
  if (recoverRun !== undefined && !/^run-[0-9]+$/.test(recoverRun)) throw new Error("OSTRA_CHECK_RECOVER must be a run directory name (run-<number>)");
  const pairsText = process.env.OSTRA_CHECK_PAIRS === undefined || process.env.OSTRA_CHECK_PAIRS === "" ? undefined : process.env.OSTRA_CHECK_PAIRS;
  const stockPair: LaunchPair | undefined = pairsText === undefined ? undefined : (findLaunchPair(pairsText) ?? undefined);
  if (pairsText !== undefined && (stockPair === undefined || stockPair.kind !== "stock")) throw new Error(`OSTRA_CHECK_PAIRS must be the ticker of a stock token Ostra offers as a pair, not ${pairsText}`);

  const transport = retryingHttp(rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
  await assertRobinhoodChain(client);
  const decimals = await client.readContract({ address: token, abi: usdgAbi, functionName: "decimals" });
  const unit = 10n ** BigInt(decimals);
  const tokens = (text: string) => {
    const [whole, fraction = ""] = text.split(".");
    return BigInt(whole as string) * unit + BigInt(fraction.padEnd(decimals, "0"));
  };
  const balance = (owner: Address) => client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [owner] });
  /** `owner`'s balance of any ERC-20 (`usdgAbi` has the ERC-20 reads). */
  const balanceIn = (erc20: Address, owner: Address) => client.readContract({ address: erc20, abi: usdgAbi, functionName: "balanceOf", args: [owner] });
  const walletOf = (account: PrivateKeyAccount) => createWalletClient({ account, chain: robinhoodChain, transport });
  const send = async (account: PrivateKeyAccount, to: Address, data: Hex): Promise<Hex> => {
    const hash = await walletOf(account).sendTransaction({ account, chain: robinhoodChain, to, data });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} to ${to} reverted`);
    return hash;
  };
  const spendData = (s: SignedSpend) => encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [s.action, s.nextKeyRoot, s.params, s.signature] });
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

  await ensurePrivateDir(stateDir);
  const runDir = join(stateDir, recoverRun ?? `run-${Date.now()}`);
  if (recoverRun === undefined) await ensurePrivateDir(runDir);
  else if (!(await stat(runDir)).isDirectory()) throw new Error(`${runDir} is not a directory`);
  const secret = (name: string, valid?: (bytes: Uint8Array) => boolean) => (recoverRun === undefined ? newSecret(join(runDir, name), valid) : readSecret(join(runDir, name)));
  const wotsStore = new FileWotsStore(join(runDir, "wots"));
  // Step 9's restored device: the same seed with its own WOTS records (the cleanup lands what it signed too).
  const restoredStore = new FileWotsStore(join(runDir, "wots-restored"));
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
  const relayerUrl = `http://${relayerListen.host}:${relayerListen.port}`;
  const merchantUrl = `http://${merchantListen.host}:${merchantListen.port}`;
  const relayerSecrets = join(runDir, "relayer-secrets");
  const relayerData = join(runDir, "relayer-data");
  const merchantSecrets = join(runDir, "merchant-secrets");
  const merchantData = join(runDir, "merchant-data");
  const keeper = new Proc("keeper", fileURLToPath(new URL("../../keeper/src/main.ts", import.meta.url)), keeperEnv);
  let relayer: Proc | undefined;
  let merchant: Proc | undefined;

  // The agent: its master seed, fee payer and WOTS store in the run directory (so a stopped run can be
  // recovered); its records in memory (the MCP package keeps them on disk).
  const master = await secret("agent-master.key");
  const feePayer = privateKeyToAccount(bytesToHex(await secret("agent-fee-payer.key", isPrivateKey)));
  const keys = new Keys({ master, feePayer, store: wotsStore, folder: new MemoryFolder(), backupExported: async () => true });
  const config: Config = { chainId: d.chainId, rpcUrl, deployment: d, x402Network: X402_NETWORK, keeperUrl, relayerUrl, aggregatorUrl: null, aiUrl: null };
  const buyerKeys = keys.vaultKeychain(d.chainId, token);
  const sellerKeys = keys.sellerKeychain(d.chainId, token);
  const buyerVault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot: bytesToHex(buyerKeys.keyRoot(0n)), initialCrank: zeroAddress });

  // What the cleanup needs, set as each part of the run comes to exist.
  let relayerKeys: MerchantKeys | undefined;
  let feeSplit: { recipient: Address; bps: number } | undefined;
  let relayerAccount: PrivateKeyAccount | undefined;
  /** The run's vaults, each with its token (default USDG), whose tokens the cleanup returns to the funder. */
  const vaults: { name: string; keys: WotsKeychain; vault: Address; token?: Address }[] = [{ name: "the buyer vault", keys: buyerKeys, vault: buyerVault }];

  /** Closes every unfinished relayer channel through the keeper and returns the run's funds to the funder. */
  const cleanup = async () => {
    for (const p of [merchant, relayer]) if (p !== undefined) await p.stop();
    merchant = undefined;
    relayer = undefined;
    const channels = new Map<string, ChannelConfig>();
    try {
      for (const name of await readdir(join(relayerData, CHANNELS_DIR))) {
        if (!name.endsWith(".json")) continue;
        const record = JSON.parse(await readFile(join(relayerData, CHANNELS_DIR, name), "utf8")) as { channel: { channelId: string; channelConfig: ChannelConfig } };
        channels.set(record.channel.channelId.toLowerCase(), wireChannelConfig(record.channel.channelConfig));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const [channel, cfg] of channels) {
      try {
        const ch = await readChannel(client, d.batchSettlement, channel as Hex);
        if (ch.balance === ch.totalClaimed) continue;
        if (relayerKeys === undefined || feeSplit === undefined) throw new Error("the run's relayer merchant key is not loaded");
        const signature = await relayerKeys.signCloseRequest(d.chainId, channel as Hex);
        const res = await fetch(`${keeperUrl}/v1/close`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ merchant: relayerKeys.merchant, channelConfig: cfg, signature, splits: [feeSplit] }),
          signal: AbortSignal.timeout(240_000),
        });
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        // How many relayer channels are left open depends on the gas price, so a closed one is logged, not counted.
        if (res.status === 200) console.log(`cleanup: the keeper closed relayer channel ${channel} (unclaimed ${ch.balance - ch.totalClaimed})`);
        else check(false, `cleanup: close relayer channel ${channel}`, body ?? res.status);
      } catch (err) {
        check(false, `cleanup: close relayer channel ${channel}`, err instanceof Error ? err.message : String(err));
      }
    }
    for (const v of vaults) {
      try {
        // A spend the current key already signed (never landed) is landed first, so the next key is free.
        const current = await readVault(client, d, v.vault);
        const pending = current === null ? undefined : ((await wotsStore.load(v.keys.keychainId, current.nonce)) ?? (await restoredStore.load(v.keys.keychainId, current.nonce)));
        if (current !== null && pending !== undefined) {
          const signed = decodeVaultSpendMessage(hexToBytes(`0x${pending.message}`));
          await send(funder, v.vault, encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [signed.action, signed.nextKeyRoot, signed.params, `0x${pending.signature}`] }));
          console.log(`${v.name}: landed the spend its key ${current.nonce} had signed (action ${signed.action})`);
        }
        const amount = await balanceIn(v.token ?? token, v.vault);
        const state = await readVault(client, d, v.vault);
        if (amount > 0n && state !== null) {
          await send(funder, v.vault, spendData(await signVaultTransfer(v.keys, state, { chainId: d.chainId, to: funder.address, amount })));
          console.log(`${v.name} returned ${amount} base units${v.token === undefined ? "" : ` of ${v.token}`} to the funder`);
        }
      } catch (err) {
        check(false, `cleanup: return the tokens of ${v.name}`, err instanceof Error ? err.message : String(err));
      }
    }
    try {
      if (relayerAccount !== undefined) console.log(`the relayer account returned ${await sweepEth(relayerAccount, funder.address)} wei to the funder`);
      console.log(`the agent's fee payer returned ${await sweepEth(feePayer, funder.address)} wei to the funder`);
    } catch (err) {
      check(false, "cleanup: return the ETH", err instanceof Error ? err.message : String(err));
    }
  };

  let runError: unknown;
  try {
    await waitHttp(`${keeperUrl}/v1/health`, 60);
    const health = (await (await fetch(`${keeperUrl}/v1/health`)).json()) as Record<string, unknown>;
    if (BigInt(health.feePayerWei as string) === 0n) throw new Error(`the keeper fee payer ${String(health.feePayer)} has no ETH; fund it before running this check`);
    const terms = (await (await fetch(`${keeperUrl}/v1/terms`)).json()) as { feeRecipient: Address; feeBps: number; minGraceSeconds: number };
    feeSplit = { recipient: getAddress(terms.feeRecipient), bps: terms.feeBps };
    const crankOf = async (merchantKey: Address) => getAddress(((await (await fetch(`${keeperUrl}/v1/crank?merchant=${merchantKey}`)).json()) as { crank: string }).crank);

    // --- 1. the relayer ------------------------------------------------------------------------
    if (recoverRun !== undefined) await stat(join(relayerSecrets, "merchant.key"));
    relayerKeys = await MerchantKeys.open(relayerSecrets);
    relayerAccount = await openRelayerAccount(relayerSecrets);
    const relayerVaultKeys = new WotsKeychain(await secret("relayer-master.key"), await secret("relayer-keychain.id"), wotsStore);
    const relayerVault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot: bytesToHex(relayerVaultKeys.keyRoot(0n)), initialCrank: zeroAddress });
    vaults.push({ name: "the relayer vault", keys: relayerVaultKeys, vault: relayerVault });
    // The seller vault is created with the keeper crank of the agent's merchant key (part of its address).
    const sellerMerchant = privateKeyToAccount(keys.merchantKey(d.chainId, token));
    const keeperCrank = await crankOf(sellerMerchant.address);
    const sellerVault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot: bytesToHex(sellerKeys.keyRoot(0n)), initialCrank: keeperCrank });
    vaults.push({ name: "the seller vault", keys: sellerKeys, vault: sellerVault });
    const creatorChain = keys.creatorKeychain(d.chainId, token);
    const creatorVault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot: bytesToHex(creatorChain.keyRoot(0n)), initialCrank: zeroAddress });
    if (d.launchpad !== undefined) vaults.push({ name: "the creator vault", keys: creatorChain, vault: creatorVault });
    // Steps 12 and 13: the agent's vault of the stock token, the creator vaults of the stock token and of WETH.
    const vaultOf = (chain: WotsKeychain, inToken: Address) => vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: inToken, initialKeyRoot: bytesToHex(chain.keyRoot(0n)), initialCrank: zeroAddress });
    const stockChain = stockPair === undefined ? undefined : keys.vaultKeychain(d.chainId, stockPair.address);
    const stockCreatorChain = stockPair === undefined ? undefined : keys.creatorKeychain(d.chainId, stockPair.address);
    const wethCreatorChain = keys.creatorKeychain(d.chainId, WETH);
    const stockVault = stockPair === undefined || stockChain === undefined ? undefined : vaultOf(stockChain, stockPair.address);
    const stockCreatorVault = stockPair === undefined || stockCreatorChain === undefined ? undefined : vaultOf(stockCreatorChain, stockPair.address);
    const wethCreatorVault = vaultOf(wethCreatorChain, WETH);
    if (d.launchpad !== undefined && stockPair !== undefined && stockChain !== undefined && stockCreatorChain !== undefined && stockVault !== undefined && stockCreatorVault !== undefined) {
      vaults.push({ name: `the ${stockPair.symbol} vault`, keys: stockChain, vault: stockVault, token: stockPair.address });
      vaults.push({ name: `the ${stockPair.symbol} creator vault`, keys: stockCreatorChain, vault: stockCreatorVault, token: stockPair.address });
      vaults.push({ name: "the WETH creator vault", keys: wethCreatorChain, vault: wethCreatorVault, token: WETH });
    }
    if (recoverRun !== undefined) return;

    await send(funder, d.vaultFactory, encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [token, bytesToHex(relayerVaultKeys.keyRoot(0n)), zeroAddress] }));
    const rv = await readVault(client, d, relayerVault);
    if (rv === null) throw new Error("relayer vault missing");
    await send(funder, relayerVault, spendData(await signVaultSetCrankKey(relayerVaultKeys, rv, { chainId: d.chainId, crank: await crankOf(relayerKeys.merchant) })));
    const { maxFeePerGas } = await client.estimateFeesPerGas();
    await walletOf(funder)
      .sendTransaction({
        account: funder,
        chain: robinhoodChain,
        to: relayerAccount.address,
        value: RELAYER_GAS_BUDGET * maxFeePerGas + LAUNCHPAD.FEE_WEI + (stockPair === undefined ? 0n : PAIR_RELAYER_GAS * maxFeePerGas + 2n * LAUNCHPAD.FEE_WEI),
      })
      .then((hash) => client.waitForTransactionReceipt({ hash }));
    relayer = new Proc("relayer", fileURLToPath(new URL("../../relayer/src/server.ts", import.meta.url)), {
      ...baseEnv,
      OSTRA_KEEPER_URL: keeperUrl,
      OSTRA_RELAYER_VAULT: relayerVault,
      OSTRA_RELAYER_SECRETS: relayerSecrets,
      OSTRA_RELAYER_DATA: relayerData,
      OSTRA_RELAYER_LISTEN: `${relayerListen.host}:${relayerListen.port}`,
    });
    await waitHttp(`${relayerUrl}/v1/relayer`, 60);

    const relayerClient = new RelayerClient(client, config, keys, relayerUrl);
    const buyer = new VaultService(client, transport, config, keys, relayerClient, "buyer");
    relayerClient.attachBuyerVault(buyer);
    const channels = new ChannelService(client, config, keys, buyer, relayerClient);
    const seller = new VaultService(client, transport, config, keys, relayerClient, "seller");
    seller.setInitCrank(keeperCrank);
    const facts = await relayerClient.facts();
    check(facts.vault === relayerVault && facts.feePayer === relayerAccount.address && toJson(facts.splits) === toJson([feeSplit]), "the core relayer client read and checked the relayer's terms (its vault and split on-chain)", facts);

    // --- 2. open_vault through the relayer ------------------------------------------------------
    const opened = await buyer.open();
    const debt = BigInt((await relayerClient.vaultState(buyerVault)).debt);
    check(opened.created && opened.vault === buyerVault && (await readVault(client, d, buyerVault)) !== null && debt > 0n, "open_vault through the relayer: the buyer vault is created before payment and owes its price", { opened, debt });
    const again = await buyer.open();
    check(!again.created && again.vault === buyerVault && again.nonce === "0", "open_vault again finds the vault and creates nothing", again);

    // --- 3. funding; a withdrawal through the relayer -----------------------------------------------
    const funding = ((30n * debt + tokens("1") + tokens("0.01") - 1n) / tokens("0.01")) * tokens("0.01");
    await send(funder, token, encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [buyerVault, funding] }));
    const funderBefore = await balance(funder.address);
    const w = await buyer.withdraw(funder.address, "0.01");
    const relayerChannels = await relayerClient.channels();
    const vs = await relayerClient.vaultState(buyerVault);
    check(w.status === "sent" && (await balance(funder.address)) - funderBefore === tokens("0.01"), "withdraw through the relayer: the withdrawal landed", w);
    check(
      relayerChannels.length === 1 && vs.debt === 0n && vs.unpaidOpen === null && tokens(relayerChannels[0]?.spent ?? "0") > debt,
      "the client opened a channel to the relayer on its terms; its first voucher paid the open and the vault's debt, the next the withdrawal",
      { relayerChannels, vs },
    );
    const status = await buyer.status();
    check(status.nonce === "2" && status.pendingWithdrawal === null && status.pendingChannelOpen === null, "balance: the vault's nonce moved twice (the relayer channel open and the withdrawal), nothing pending", status);

    // --- 4. the seller vault, paid up front; the seller server ------------------------------------------
    const sellerOpened = await seller.open();
    const sv = await readVault(client, d, sellerVault);
    check(sellerOpened.created && sv !== null && sv.crank === keeperCrank && (await relayerClient.vaultState(sellerVault)).debt === 0n, "the seller vault is created with the keeper crank, paid up front from the buyer vault's relayer channel (prepay)", sellerOpened);
    await ensurePrivateDir(merchantSecrets);
    await writeFile(join(merchantSecrets, "merchant.key"), `${keys.merchantKey(d.chainId, token).slice(2)}\n`, { mode: 0o600, flag: "wx" });
    const price = tokens("0.02");
    merchant = new Proc("seller", fileURLToPath(new URL("../../merchant/src/server.ts", import.meta.url)), {
      ...baseEnv,
      OSTRA_KEEPER_URL: keeperUrl,
      OSTRA_MERCHANT_SECRETS: merchantSecrets,
      OSTRA_MERCHANT_DATA: merchantData,
      OSTRA_MERCHANT_VAULT: sellerVault,
      OSTRA_MERCHANT_LISTEN: `${merchantListen.host}:${merchantListen.port}`,
      OSTRA_MERCHANT_PRICE: price.toString(),
    });
    await waitHttp(`${merchantUrl}/v1/merchant`, 60);
    const sellerFacts = (await (await fetch(`${merchantUrl}/v1/merchant`)).json()) as { split: Address; splits: { recipient: Address; bps: number }[]; gracePeriodSeconds: number; merchant: Address };
    check(sellerFacts.merchant === sellerMerchant.address, "the seller server runs on the seller vault with the agent's merchant key", sellerFacts);

    // --- 5. open_channel to the seller; two paid requests ------------------------------------------------
    const ch = await channels.open({ payee: sellerVault, deposit: "0.1", gracePeriod: sellerFacts.gracePeriodSeconds, recipients: sellerFacts.splits });
    if (ch.status !== "open") throw new Error(`open_channel did not open: ${toJson(ch)}`);
    const onChain = await readChannel(client, d.batchSettlement, ch.channel);
    check(ch.receiver === getAddress(sellerFacts.split) && onChain.balance === tokens("0.1") && onChain.totalClaimed === 0n, "open_channel: the channel's receiver is the seller's OstraSplit and it holds the deposit", { ch, onChain });
    const [record] = (await channels.list()).filter((c) => c.channel === ch.channel);
    check(record?.status === "open" && record.deposit === "0.1", "the channel is listed open", record);
    let x402State: BatchSettlementClientContext | undefined;
    // The vault channel's voucher key, derived from the master seed and the channel's salt.
    const voucherKey = keys.channelVoucherSigner(d.chainId, token, ch.config.salt);
    const scheme = new BatchSettlementEvmScheme({ address: buyerVault, signTypedData: () => Promise.reject(new Error("a vault never signs")), readContract: (a: never) => client.readContract(a) } as never, {
      voucherSigner: toClientEvmSigner(voucherKey, client as never),
      payerAuthorizer: voucherKey.address,
      salt: ch.config.salt,
      depositStrategy: () => false,
      storage: { get: async () => x402State, set: async (_k, c) => void (x402State = c), delete: async () => void (x402State = undefined) },
    });
    const x = new x402Client().register(X402_NETWORK, scheme);
    x.setSpendControls({ allowedAssets: [{ network: X402_NETWORK, asset: token }] });
    const http = new x402HTTPClient(x);
    const paidGet = async () => {
      const first = await fetch(`${merchantUrl}/paid`);
      const firstBody = await first.json().catch(() => null);
      const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), firstBody);
      const payload = await http.createPaymentPayload(required);
      const second = await fetch(`${merchantUrl}/paid`, { headers: http.encodePaymentSignatureHeader(payload) });
      await http.processPaymentResult(payload, (n) => second.headers.get(n), second.status);
      return second.status;
    };
    const p1 = await paidGet();
    const p2 = await paidGet();
    check(p1 === 200 && p2 === 200, "two requests to the seller's paid route are paid with vouchers of the vault channel", { p1, p2 });
    const adopted = await merchant.waitEvent((e) => e.event === "vault_channel_adopted" && String(e.channel).toLowerCase() === ch.channel, 30);
    check(adopted !== undefined, "the seller server adopted the vault channel from its on-chain state", adopted ?? "not adopted");

    // --- 6. close_channel -----------------------------------------------------------------------------------
    const buyerBeforeClose = await balance(buyerVault);
    const closing = await channels.close(ch.channel);
    check(closing.sent.length === 1 && closing.sent[0]?.step === "request_close", "close_channel sends requestClose signed by the channel's voucher key, through the relayer", closing);
    const settled = await (async () => {
      for (let i = 0; i < 60; i++) {
        const c = await readChannel(client, d.batchSettlement, ch.channel);
        if (c.balance === c.totalClaimed) return c;
        await sleep(3_000);
      }
      return readChannel(client, d.batchSettlement, ch.channel);
    })();
    const refund = (await balance(buyerVault)) - buyerBeforeClose;
    check(settled.totalClaimed === 2n * price && settled.balance === settled.totalClaimed && refund >= tokens("0.1") - 2n * price - tokens("0.05"), "the keeper claimed the two vouchers and refunded the rest to the buyer vault on the close request", { settled, refund });
    const done = await channels.close(ch.channel);
    check(done.status === "closed" && done.sent.length === 0 && (await channels.list()).every((c) => c.channel !== ch.channel), "close_channel again: nothing is left unclaimed, the record is finished", done);

    // --- 7. rotate_crank and back -------------------------------------------------------------------------------
    await walletOf(funder)
      .sendTransaction({ account: funder, chain: robinhoodChain, to: feePayer.address, value: FEE_PAYER_GAS_BUDGET * maxFeePerGas })
      .then((hash) => client.waitForTransactionReceipt({ hash }));
    const self = keys.selfCrankSigner(d.chainId, token).address;
    const local = new LocalSender(client, transport, feePayer);
    const rotated = await seller.setCrankKey(self, local);
    check(rotated.status === "sent" && (await seller.currentCrank()) === self, "the seller vault installs its own crank, sent by the agent's own fee payer", rotated);
    const back = await seller.setCrankKey(keeperCrank);
    check(back.status === "sent" && (await seller.currentCrank()) === keeperCrank, "and the keeper crank again through the relayer", back);
    const same = await seller.setCrankKey(keeperCrank);
    check(same.status === "unchanged", "the same crank again is unchanged and signs nothing", same);

    // --- 8. accounting ---------------------------------------------------------------------------------------------
    let inRelayerChannels = 0n;
    let claimedByRelayer = 0n;
    let signedToRelayer = 0n;
    for (const c of await relayerClient.channels()) {
      const s = await readChannel(client, d.batchSettlement, c.channel);
      inRelayerChannels += s.balance;
      claimedByRelayer += s.totalClaimed;
      signedToRelayer += tokens(c.spent);
    }
    const sellerChannel = await readChannel(client, d.batchSettlement, ch.channel);
    const buyerNow = await balance(buyerVault);
    check(buyerNow + inRelayerChannels + sellerChannel.balance + tokens("0.01") === funding, "every token funded is in the buyer vault, in a channel, or withdrawn", { buyerNow, inRelayerChannels, seller: sellerChannel.balance, funding });
    check(sellerChannel.totalClaimed === 2n * price && claimedByRelayer <= signedToRelayer, "the seller claimed exactly its two prices; the relayer no more than the vouchers signed", { seller: sellerChannel.totalClaimed, claimedByRelayer, signedToRelayer });
    const swept = await relayerClient.sweep();
    check(swept.length === 0 && (await relayerClient.channels()).length >= 1, "the relayer client's sweep keeps channels younger than a day and retires none", swept);

    // --- 9. the signature escrow: a device lost after signing, a device restored from the seed ---------------------
    const escrow = new SignatureEscrowClient(relayerUrl);
    const nonceOf = async () => (await readVault(client, d, buyerVault))?.nonce;
    const lostAt = await nonceOf();
    if (lostAt === undefined) throw new Error("buyer vault missing");
    // The lost device escrows the signed withdrawal as its fee payer would before sending, then is gone.
    const lostDevice = new VaultService(client, transport, config, keys, new LocalSender(client, transport, feePayer, {
      escrow: async (calls) => {
        await escrow.escrow(calls);
        throw new Error("the device was lost after the escrow");
      },
    }), "buyer");
    const lostError = await lostDevice.withdraw(funder.address, "0.01").then(() => "", (err: unknown) => (err instanceof Error ? err.message : String(err)));
    const held = await escrow.lookup(bytesToHex(buyerKeys.keyRoot(lostAt)));
    check(/lost after the escrow/.test(lostError) && held !== null && (await nonceOf()) === lostAt, "a withdrawal signed on a device lost before sending it is held by the relayer's signature escrow, not on-chain", { lostError, held: held !== null });
    const restoredKeys = new Keys({ master, feePayer, store: restoredStore, folder: new MemoryFolder(), backupExported: async () => true, escrow });
    const restored = new VaultService(client, transport, config, restoredKeys, new LocalSender(client, transport, feePayer, escrow), "buyer");
    const funderBeforeRestore = await balance(funder.address);
    const resent = await restored.withdraw(funder.address, "0.02");
    check(
      resent.status === "resent_pending" && resent.resent.operation === "withdraw" && resent.resent.amount === "0.01" && (await balance(funder.address)) - funderBeforeRestore === tokens("0.01") && (await nonceOf()) === lostAt + 1n,
      "a device restored from the seed with no WOTS records finds that signature in the escrow and sends it instead of signing another message with the key",
      resent,
    );
    const next = await restored.withdraw(funder.address, "0.02");
    check(next.status === "sent" && (await balance(funder.address)) - funderBeforeRestore === tokens("0.03") && (await nonceOf()) === lostAt + 2n, "the restored device's next withdrawal is escrowed, then sent by its fee payer", next);
    const blindStore = new FileWotsStore(join(runDir, "wots-blind"));
    const blindKeys = new Keys({ master, feePayer, store: blindStore, folder: new MemoryFolder(), backupExported: async () => true, escrow: new SignatureEscrowClient("http://127.0.0.1:9") });
    const blind = new VaultService(client, transport, config, blindKeys, new LocalSender(client, transport, feePayer), "buyer");
    const blindError = await blind.withdraw(funder.address, "0.01").then(() => "", (err: unknown) => (err instanceof Error ? err.message : String(err)));
    check(/cannot be reached/.test(blindError) && (await nonceOf()) === lostAt + 2n && (await blindStore.load(buyerKeys.keychainId, lostAt + 2n)) === undefined, "a restored device that cannot reach the escrow signs nothing", blindError);

    // --- 10. the passkey backup of the seed ---------------------------------------------------------------------------
    const backups = new PasskeyBackupClient(relayerUrl, d.chainId);
    const credential = new Uint8Array(randomBytes(32));
    const prf = new Uint8Array(randomBytes(32));
    const saved = await backups.save(keys, credential, prf);
    const reopened = await backups.restore(credential, prf);
    check(saved.name === backupName(credential) && reopened !== null && bytesToHex(reopened) === bytesToHex(master), "the relayer keeps the seed's passkey backup and a new device with the same passkey decrypts it", saved);
    const intruder = new Keys({ master: new Uint8Array(randomBytes(32)), feePayer, store: new FileWotsStore(join(runDir, "wots-intruder")), folder: new MemoryFolder(), backupExported: async () => true });
    const taken = await backups.save(intruder, credential, prf).then(() => "", (err: unknown) => (err instanceof RelayerError ? `${err.status} ${err.code}` : String(err)));
    const wrongPasskey = await backups.restore(credential, new Uint8Array(randomBytes(32))).then(() => "", (err: unknown) => (err instanceof Error ? err.message : String(err)));
    check(taken === "409 owner_mismatch" && /does not open this backup/.test(wrongPasskey) && bytesToHex((await backups.restore(credential, prf)) ?? new Uint8Array()) === bytesToHex(master), "another seed cannot replace the backup and another passkey cannot open it", { taken, wrongPasskey });
    await backups.remove(keys, credential);
    const resaved = await backups.save(keys, credential, prf);
    await backups.remove(keys, credential);
    check((await backups.get(credential)) === null && resaved.updatedAt > saved.updatedAt, "the seed's backup key deletes the backup (and writes it again later)", resaved);

    // --- 11. the launchpad through the relayer ------------------------------------------------------------------------------
    if (d.launchpad !== undefined) {
      const lpd = d.launchpad;
      const creatorKeys = await keys.forCreatorVault(d.chainId, token);
      const creatorRelayer = new RelayerClient(client, config, creatorKeys, relayerUrl);
      const creator = new VaultService(client, transport, config, creatorKeys, creatorRelayer, "creator");
      creatorRelayer.attachBuyerVault(creator);
      const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: relayerClient, creator, creatorSender: creatorRelayer });
      const created = await creator.open();
      check(created.created && created.vault === creatorVault && (await creatorRelayer.vaultState(creatorVault)).debt > 0n, "the creator vault is created through the relayer before payment and owes its price", created);
      // What the launch's relayer channel needs (its gas at the current price, the launch fee), twice, plus the dev buy and room.
      const launchWei = withMargin(DEV_BUY_LAUNCH_GAS * (await client.getGasPrice())) + LAUNCHPAD.FEE_WEI;
      const launchUnits = weiToTokenUnits(launchWei, await chainlinkEthUsd(client, CHAINLINK_ETH_USD)(), decimals);
      const creatorFunding = ((2n * launchUnits + tokens("2") + tokens("0.01") - 1n) / tokens("0.01")) * tokens("0.01");
      await send(funder, token, encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [creatorVault, creatorFunding] }));

      const nonceOfCreator = async () => (await readVault(client, d, creatorVault))?.nonce;
      const before = await nonceOfCreator();
      const tooBig = await lp.launch({ name: "Too Big", symbol: "BIG", marketCap: "20", devBuy: { amount: "5" } }).then(() => "", (err: unknown) => (err instanceof Error ? err.message : String(err)));
      check(/launch fails now/.test(tooBig) && (await nonceOfCreator()) === before && (await creator.state()).pendingAction === null, "a launch whose dev buy the contract refuses (above 5% of the supply) is refused by its quote; nothing is signed", tooBig);
      const relayerEthBefore = await client.getBalance({ address: relayerAccount.address });
      const launched = await lp.launch({ name: "Ostra Check Launch", symbol: "OCHECK", marketCap: "20000", devBuy: { amount: "1", cliffDays: 7, vestingDays: 30 } });
      if (launched.status !== "launched") throw new Error(`the launch did not land: ${toJson(launched)}`);
      const relayedLaunch = await relayer.waitEvent((e) => e.event === "relayed" && e.txHash === launched.txHash, 30);
      const relayerEthSpent = relayerEthBefore - (await client.getBalance({ address: relayerAccount.address }));
      check(
        launched.devBuy !== null && relayedLaunch !== undefined && String(relayedLaunch.value) === LAUNCHPAD.FEE_WEI.toString() && relayerEthSpent >= LAUNCHPAD.FEE_WEI,
        "the launch with a dev buy is relayed from the creator vault's own relayer channel; the relayer fronts the ETH launch fee and charges it",
        { launched, relayedLaunch, relayerEthSpent },
      );
      let inCreatorChannels = 0n;
      for (const c of await creatorRelayer.channels()) inCreatorChannels += (await readChannel(client, d.batchSettlement, c.channel)).balance;
      const devPaid = tokens(launched.devBuy?.paid ?? "0");
      const creatorNow = await balance(creatorVault);
      check(creatorNow + inCreatorChannels + devPaid === creatorFunding, "every token the creator vault was funded with is in the vault, its relayer channels or the dev buy", { creatorNow, inCreatorChannels, devPaid });

      // A launch bundled with another call (the creator vault owes nothing now): the relayer launches only alone (a signature that is not the vault's key, never escrowed).
      const p0 = launchParams({ name: "Bundled", symbol: "BUNDLE", salt: bytesToHex(randomBytes(32)), quote: token, creatorVault, startTick: -400_000 });
      const fakeCall = { to: lpd.devBuy, data: launchFromVaultData(p0, NO_DEV_BUY, { nextKeyRoot: bytesToHex(randomBytes(32)), signature: `0x${"00".repeat(WOTS_SIGNATURE_LEN)}` }) };
      const bundled = await fetch(`${relayerUrl}/v1/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ calls: [fakeCall, fakeCall], payer: creatorVault }) });
      const bundledBody = (await bundled.json()) as { error?: string; message?: string };
      check(bundled.status === 422 && bundledBody.error === "refused" && /relayed alone/.test(String(bundledBody.message)), "a launch bundled with another call is refused by the relayer's policy", { status: bundled.status, bundledBody });

      const tokenBalanceOf = (who: Address) => client.readContract({ address: launched.token, abi: ostraTokenAbi, functionName: "balanceOf", args: [who] });
      const bought = await lp.buy({ token: launched.token, amount: "0.5" });
      const held = await tokenBalanceOf(launched.tokenVault);
      check(bought.status === "sent" && bought.swapped && (await readVault(client, d, launched.tokenVault)) !== null && held > 0n, "a buy through the relayer creates the agent's token vault in the same request and lands the tokens in it", bought);
      const sold = await lp.sell({ token: launched.token, amount: formatUnitsAmount(held, 18) });
      // The USDG the swap paid out went to the buyer vault (the vault's balance also moves with its relayer channels).
      const paidOut =
        sold.status === "sent"
          ? parseEventLogs({ abi: usdgAbi, logs: (await client.getTransactionReceipt({ hash: sold.txHash })).logs, eventName: "Transfer" }).filter((l) => getAddress(l.address) === token && getAddress(l.args.to) === buyerVault)
          : [];
      check(
        sold.status === "sent" && sold.swapped && sold.to === buyerVault && (await tokenBalanceOf(launched.tokenVault)) === 0n && paidOut.length === 1 && tokens(sold.amountOut) === paidOut[0]?.args.value,
        "selling it all back through the relayer (the token vault's spend paid by the buyer vault) pays the USDG to the buyer vault",
        { sold, paidOut: paidOut.map((l) => l.args.value) },
      );

      // --- 12. a launch paired with a stock token -----------------------------------------------------------------------------
      if (stockPair !== undefined && stockVault !== undefined && stockCreatorVault !== undefined) {
        const T = stockPair.symbol;
        const stock = stockPair.address;
        const units = (text: string) => {
          const [whole, fraction = ""] = text.split(".");
          return BigInt(whole as string) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
        };
        const funderStock = await balanceIn(stock, funder.address);
        if (funderStock < PAIR_STOCK_FUNDING) throw new Error(`the funder holds ${funderStock} base units of ${T}, less than the ${PAIR_STOCK_FUNDING} steps 12 and 13 need`);
        // The buyer vault's relayer channel pays every operation of these steps: the two launches at the fork's gas
        // price (step 11's launchUnits, three times for room) and the other operations.
        const pairBuyerFunding = ((3n * launchUnits + tokens(PAIR_BUYER_ROOM) + tokens("0.01") - 1n) / tokens("0.01")) * tokens("0.01");
        await send(funder, token, encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [buyerVault, pairBuyerFunding] }));

        const listed = await lp.pairs();
        const row = listed.find((r) => r.symbol === T);
        check(
          listed.length === 34 && listed[0]?.symbol === "USDG" && listed[1]?.symbol === "ETH" && row?.creatorVault === stockCreatorVault && row.tradingVault === stockVault && listed[1]?.creatorVault === wethCreatorVault,
          `the pairs list (USDG, ETH, 32 stock tokens) names the agent's ${T} creator vault, ${T} vault and WETH creator vault at the addresses of its keys`,
          { row, eth: listed[1] },
        );

        await send(funder, stock, encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [stockVault, PAIR_STOCK_FUNDING] }));
        const half = PAIR_STOCK_FUNDING / 2n;
        await lp.fundCreatorVault(formatUnitsAmount(half, 18), T);
        check(
          (await readVault(client, d, stockVault)) !== null &&
            (await readVault(client, d, stockCreatorVault)) !== null &&
            (await balanceIn(stock, stockVault)) === PAIR_STOCK_FUNDING - half &&
            (await balanceIn(stock, stockCreatorVault)) === half &&
            (await relayerClient.vaultState(stockVault)).debt === 0n &&
            (await relayerClient.vaultState(stockCreatorVault)).debt === 0n,
          `moving ${T} from the agent's ${T} vault creates it and the ${T} creator vault, paid up front from the buyer vault's relayer channel, and moves exactly the amount`,
          { stockVault: await balanceIn(stock, stockVault), creator: await balanceIn(stock, stockCreatorVault) },
        );

        const price = await readPairUsdPrice(client, stockPair);
        const relayerEthBeforeStock = await client.getBalance({ address: relayerAccount.address });
        const stockLaunch = await lp.launch({ name: "Ostra Stock Check", symbol: "OSTK", pair: T, marketCap: "20000", devBuy: { amount: PAIR_DEV_BUY, cliffDays: 7, vestingDays: 0 } });
        if (stockLaunch.status !== "launched") throw new Error(`the ${T} launch did not land: ${toJson(stockLaunch)}`);
        const stockLaunched = parseEventLogs({ abi: ostraLaunchpadAbi, logs: (await client.getTransactionReceipt({ hash: stockLaunch.txHash })).logs, eventName: "Launched" });
        const relayedStock = await relayer.waitEvent((e) => e.event === "relayed" && e.txHash === stockLaunch.txHash, 30);
        const devPaidStock = units(stockLaunch.devBuy?.paid ?? "0");
        check(
          stockLaunch.pair === T &&
            stockLaunched.length === 1 &&
            getAddress(stockLaunched[0]?.args.quote as Address) === stock &&
            getAddress(stockLaunched[0]?.args.creatorVault as Address) === stockCreatorVault &&
            stockLaunch.creatorVault === stockCreatorVault &&
            stockLaunch.marketCapUsd === "20000" &&
            stockLaunch.marketCapInPair === formatUnitsAmount(usdToQuoteUnits(20_000_000_000n, price.priceE8, 18), 18) &&
            stockLaunch.devBuy !== null &&
            devPaidStock > 0n &&
            (await balanceIn(stock, stockCreatorVault)) === half - devPaidStock &&
            relayedStock !== undefined &&
            String(relayedStock.value) === LAUNCHPAD.FEE_WEI.toString() &&
            relayerEthBeforeStock - (await client.getBalance({ address: relayerAccount.address })) >= LAUNCHPAD.FEE_WEI,
          `a launch paired with ${T}: the ${T} creator vault pays the dev buy in ${T}, the buyer vault's relayer channel the ETH fee the relayer fronts; the $20,000 market cap is set in ${T} at its Chainlink price`,
          { stockLaunch, quote: stockLaunched[0]?.args.quote, relayedStock, priceE8: price.priceE8 },
        );

        const ostkOf = (who: Address) => client.readContract({ address: stockLaunch.token, abi: ostraTokenAbi, functionName: "balanceOf", args: [who] });
        const stockBeforeBuy = await balanceIn(stock, stockVault);
        const stockBought = await lp.buy({ token: stockLaunch.token, amount: PAIR_BUY });
        const ostkHeld = await ostkOf(stockLaunch.tokenVault);
        check(
          stockBought.status === "sent" && stockBought.swapped && stockBought.from === stockVault && ostkHeld > 0n && stockBeforeBuy - (await balanceIn(stock, stockVault)) === units(stockBought.amountIn),
          `a buy of the ${T} pool is paid in ${T} from the agent's ${T} vault and lands the tokens in its token vault`,
          stockBought,
        );
        const stockSold = await lp.sell({ token: stockLaunch.token, amount: formatUnitsAmount(ostkHeld, 18) });
        const stockPaidOut =
          stockSold.status === "sent"
            ? parseEventLogs({ abi: usdgAbi, logs: (await client.getTransactionReceipt({ hash: stockSold.txHash })).logs, eventName: "Transfer" }).filter((l) => getAddress(l.address) === stock && getAddress(l.args.to) === stockVault)
            : [];
        check(
          stockSold.status === "sent" && stockSold.swapped && stockSold.to === stockVault && (await ostkOf(stockLaunch.tokenVault)) === 0n && stockPaidOut.length === 1 && units(stockSold.amountOut) === stockPaidOut[0]?.args.value,
          `selling it all back pays ${T} into the agent's ${T} vault`,
          { stockSold, paidOut: stockPaidOut.map((l) => l.args.value) },
        );

        const creatorBeforePayout = await balanceIn(stock, stockCreatorVault);
        const dispatched = await send(funder, lpd.dispatcher, encodeFunctionData({ abi: ostraDispatcherAbi, functionName: "dispatch", args: [stockLaunch.poolId] }));
        const payout = parseEventLogs({ abi: usdgAbi, logs: (await client.getTransactionReceipt({ hash: dispatched })).logs, eventName: "Transfer" }).filter((l) => getAddress(l.address) === stock && getAddress(l.args.to) === stockCreatorVault);
        const paidCreator = payout.reduce((sum, l) => sum + l.args.value, 0n);
        check(
          paidCreator > 0n && (await balanceIn(stock, stockCreatorVault)) - creatorBeforePayout === paidCreator,
          `the pool's creator payout (its share of the hook fee) is paid in ${T} to the ${T} creator vault`,
          { paidCreator },
        );

        const stockVaultBeforeWithdraw = await balanceIn(stock, stockVault);
        const creatorBeforeWithdraw = await balanceIn(stock, stockCreatorVault);
        const withdrawn = (await lp.creatorWithdraw({ amount: PAIR_WITHDRAW, pair: T })) as { status?: string };
        check(
          withdrawn.status === "sent" && (await balanceIn(stock, stockVault)) - stockVaultBeforeWithdraw === units(PAIR_WITHDRAW) && creatorBeforeWithdraw - (await balanceIn(stock, stockCreatorVault)) === units(PAIR_WITHDRAW),
          `the ${T} creator vault sends ${T} back to the agent's ${T} vault through the relayer`,
          withdrawn,
        );

        // --- 13. a launch paired with ETH -------------------------------------------------------------------------------------------
        await walletOf(funder)
          .writeContract({ account: funder, chain: robinhoodChain, address: WETH, abi: wethAbi, functionName: "deposit", value: PAIR_WETH_FUNDING })
          .then((hash) => client.waitForTransactionReceipt({ hash }));
        // Sent before the vault exists: its address is fixed by its keys.
        await send(funder, WETH, encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [wethCreatorVault, PAIR_WETH_FUNDING] }));
        const ethLaunch = await lp.launch({ name: "Ostra ETH Check", symbol: "OETH", pair: "ETH", marketCap: "20000", devBuy: { amount: ETH_DEV_BUY, cliffDays: 7, vestingDays: 0 } });
        if (ethLaunch.status !== "launched") throw new Error(`the ETH launch did not land: ${toJson(ethLaunch)}`);
        const ethLaunched = parseEventLogs({ abi: ostraLaunchpadAbi, logs: (await client.getTransactionReceipt({ hash: ethLaunch.txHash })).logs, eventName: "Launched" });
        const devPaidEth = units(ethLaunch.devBuy?.paid ?? "0");
        const wethLeft = await balanceIn(WETH, wethCreatorVault);
        check(
          ethLaunch.pair === "ETH" &&
            ethLaunched.length === 1 &&
            getAddress(ethLaunched[0]?.args.quote as Address) === zeroAddress &&
            ethLaunch.creatorVault === wethCreatorVault &&
            devPaidEth > 0n &&
            wethLeft + devPaidEth === PAIR_WETH_FUNDING,
          "a launch paired with ETH from the agent's WETH creator vault (funded before it existed): the dev buy is paid in WETH, the pool trades against ETH",
          { ethLaunch, quote: ethLaunched[0]?.args.quote, wethLeft },
        );
        const buyerNonceBefore = (await readVault(client, d, buyerVault))?.nonce;
        const ethBuy = await lp.buy({ token: ethLaunch.token, amount: "0.0001" }).then(() => "", (err: unknown) => (err instanceof Error ? err.message : String(err)));
        check(/traded from a wallet; nothing was signed/.test(ethBuy) && (await readVault(client, d, buyerVault))?.nonce === buyerNonceBefore, "an ETH pool is not bought from a vault: refused, nothing signed", ethBuy);
        const funderWethBefore = await balanceIn(WETH, funder.address);
        const wethOut = (await lp.creatorWithdraw({ amount: formatUnitsAmount(wethLeft, 18), pair: "ETH", destination: funder.address })) as { status?: string };
        check(
          wethOut.status === "sent" && (await balanceIn(WETH, wethCreatorVault)) === 0n && (await balanceIn(WETH, funder.address)) - funderWethBefore === wethLeft,
          "the WETH creator vault sends its WETH out through the relayer",
          wethOut,
        );
      }
    }
  } catch (err) {
    runError = err;
  } finally {
    try {
      if (relayerKeys !== undefined) await cleanup();
    } finally {
      await keeper.stop();
    }
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
