// Runs the Ostra relayer end to end against the configured chain (the EVM
// port of the Solana gate-check.ts): the keeper (keeper/src/main.ts) and the
// relayer server (src/server.ts) each run as their own process. The agent
// holds no ETH at all: every one of its transactions is sent by the relayer
// and paid with vouchers from its vault's channel to the relayer, signed with
// the stock x402 batch-settlement client (@x402/evm). Nothing is simulated:
// every step is a real transaction.
//
//   0. Chainlink ETH/USD reads positive and fresh by chain time.
//   1. The relayer's seller vault is created and installs the keeper crank
//      (SetCrankKey); the relayer account gets ETH; the relayer server starts
//      on the vault and shows its terms.
//   2. Refused before anything is sent: a malformed request, a call outside
//      the relayer's policy (a USDG transfer), a vault spend sent to an
//      address that is not an Ostra vault. The relayer's account sends
//      nothing.
//   3. createVault relayed before payment: the vault owes its price (GET
//      /v1/vaults shows the debt); sent again it is answered with the same
//      transaction; nothing else is relayed for the vault (vault_in_debt).
//   4. The funder funds the vault (an outside transfer): the channel deposit,
//      20 times the price of the createVault (so the check runs at any gas
//      price), and six transfers of 0.01 tokens. An open to the
//      relayer off its terms is refused; the open on its terms is relayed
//      before payment (GET /v1/vaults shows it with the calls that pay it);
//      a second open and any other request wait until it is paid; sent again
//      it answers 402 for the open and the debt, and the channel's first
//      voucher pays both.
//   5. A paid spend Transfer: 402 for its price (checked against the quote
//      rule: gas x gas price + 10% at ETH/USD + 0.5%), paid by voucher,
//      sent; sent again, no second charge. Its WOTS signature was escrowed
//      before it was simulated (GET /v1/signatures shows it under the vault's
//      key root); another message signed with a key whose signature is
//      escrowed, from a wiped WOTS store, is refused with the escrowed record
//      (key_reused); once that key is used on-chain, the other message is not
//      escrowed and its simulation refuses it.
//   5b. A createVault paid up front (prepay) by the first vault's channel: 402
//      for its price, no debt. A request paid by voucher whose transaction a
//      third party landed first is not sent: what was paid becomes credit of
//      the vault (409 not_sent with the credit). A spend of the vault is then
//      paid from its credit alone; a voucher from another vault's channel
//      cannot spend that credit (wrong_payer); the vault's own channel pays
//      one base unit or more and the credit the rest.
//   5e. A Swap of the prepaid vault, which holds no USDG, fails inside the
//      PoolManager without reverting (SwapFailed): refused 422 swap_fails and
//      not quoted; with allowFailedSwaps it answers 402, priced with the
//      swapGas it reserves; quoted, it is
//      simulated again when sent back without allowFailedSwaps and refused
//      before any voucher; landed by a third party, it emits SwapFailed and
//      moves nothing.
//   6. requestClose of the vault's relayer channel through the relayer, paid
//      from its credit; the keeper claims the last voucher on the
//      WithdrawInitiated it watches, and the relayer's idle close (300 s)
//      refunds the rest through the keeper and pays the split out.
//   7. The CreateVault limit: two more vaults before payment, the fourth
//      from the same IP address is refused.
//   8. Accounting: tokens to the base unit (relayer vault, agent vault,
//      keeper fee, funder), the relayer account's ETH to the wei (the gas of
//      every transaction it sent), every quote recomputed from its logged
//      inputs, and what the vault's channel paid equal to the relayer's paid
//      log.
// Whether the checks pass or a step fails, the run then cleans up: any
// relayer channel still holding unclaimed escrow is closed through the keeper
// (signed with the relayer's merchant key), and the vaults (WOTS transfers),
// the relayer account and the facilitator account return their tokens and ETH
// to the funder.
//
// The Solana gate-check drove the operator's MCP server; that package comes
// later in the port, so this check creates the relayer's vault and signs the
// agent's spends with the SDK directly. The agent-check and shield-check of
// the Solana relayer drive the agents' MCP servers and the aggregator, and
// are ported with the MCP package.
//
// Environment: the keeper's variables (OSTRA_RPC_URL, OSTRA_DEPLOYMENT,
// OSTRA_KEEPER_SECRETS, OSTRA_KEEPER_DATA, OSTRA_KEEPER_LISTEN,
// OSTRA_KEEPER_FEE_RECIPIENT) with a keeper fee payer holding ETH, plus
//   OSTRA_RELAYER_LISTEN   host:port for the relayer server
//   OSTRA_CHECK_FUNDER     file (0600) with the 32-byte hex private key of an
//                          account holding ETH and tokens: 20 times the price of
//                          a createVault plus 0.05 (about 0.35 at 0.02 gwei);
//                          all of it comes back at the end but the gas
//   OSTRA_CHECK_STATE      directory (0700) for this check's keys and records;
//                          each run keeps its keys there, so funds can be
//                          recovered if a run stops half-way
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
  encodeFunctionData,
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
  MULTICALL3,
  USDG_DECIMALS,
  VAULT_SWAP_GAS,
  WotsKeychain,
  assertRobinhoodChain,
  chainlinkEthUsd,
  closeDigest,
  decodeVaultSpendMessage,
  failedSwaps,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  parseDeployment,
  readChannel,
  readVault,
  relayRequestBody,
  relayRequestHash,
  relayTransaction,
  retryingHttp,
  robinhoodChain,
  signVaultOpenChannel,
  signVaultSetCrankKey,
  signVaultSwap,
  signVaultTransfer,
  usdgAbi,
  vaultAddress,
  vaultChannelConfig,
  channelId as computeChannelId,
  weiToTokenUnits,
  withMargin,
  type ChannelConfig,
  type OpenChannelParams,
  type RelayCall,
  type SignedSpend,
} from "@ostraagent/sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme as BatchSettlementClient } from "@x402/evm/batch-settlement/client";
import { wireChannelConfig } from "../../merchant/src/forwarder.ts";
import { MerchantKeys, ensurePrivateDir, isPrivateKey } from "../../merchant/src/keys.ts";
import { CHANNELS_DIR } from "../../merchant/src/store.ts";
import { parseListen } from "../src/config.ts";
import { openRelayerAccount } from "../src/keys.ts";
import { CREATE_VAULTS_PER_IP } from "../src/ledger.ts";

const NETWORK = `eip155:${robinhoodChain.id}` as const;
/** Gas the relayer account is funded for, at the current fee: about forty relayed transactions. */
const RELAYER_GAS_BUDGET = 40n * 1_500_000n;
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

type Posted = { status: number; body: Record<string, unknown> | null; headers: Headers };

async function main(): Promise<void> {
  const rpcUrl = required("OSTRA_RPC_URL");
  const d = parseDeployment(JSON.parse(await readFile(required("OSTRA_DEPLOYMENT"), "utf8")));
  const token = d.token;
  const keeperListen = parseListen(required("OSTRA_KEEPER_LISTEN"));
  const relayerListen = parseListen(required("OSTRA_RELAYER_LISTEN"));
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
  const balance = (owner: Address) => client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [owner] });
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
  const relayerSecrets = join(runDir, "relayer-secrets");
  const relayerData = join(runDir, "relayer-data");
  const relayerEnv = (vault: Address): Record<string, string> => ({
    ...baseEnv,
    OSTRA_KEEPER_URL: keeperUrl,
    OSTRA_RELAYER_VAULT: vault,
    OSTRA_RELAYER_SECRETS: relayerSecrets,
    OSTRA_RELAYER_DATA: relayerData,
    OSTRA_RELAYER_LISTEN: `${relayerListen.host}:${relayerListen.port}`,
  });
  const serverScript = fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const keeper = new Proc("keeper", fileURLToPath(new URL("../../keeper/src/main.ts", import.meta.url)), keeperEnv);
  let relayer: Proc | undefined;

  // What the cleanup needs, set as each part of the run comes to exist.
  let merchantKeys: MerchantKeys | undefined;
  let feeSplit: { recipient: Address; bps: number } | undefined;
  let relayerAccount: PrivateKeyAccount | undefined;
  const vaults: { name: string; keys: WotsKeychain; vault: Address }[] = [];

  /** Closes every unfinished relayer channel through the keeper and returns the run's funds to the funder. */
  const cleanup = async () => {
    if (relayer !== undefined) {
      await relayer.stop();
      relayer = undefined;
    }
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
    for (const [channel, config] of channels) {
      try {
        const ch = await readChannel(client, d.batchSettlement, channel as Hex);
        if (ch.balance === ch.totalClaimed) continue;
        if (merchantKeys === undefined || feeSplit === undefined) throw new Error("the run's relayer merchant key is not loaded");
        const signature = await merchantKeys.signCloseRequest(d.chainId, channel as Hex);
        const res = await fetch(`${keeperUrl}/v1/close`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ merchant: merchantKeys.merchant, channelConfig: config, signature, splits: [feeSplit] }),
          signal: AbortSignal.timeout(240_000),
        });
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        check(res.status === 200, `cleanup: the keeper closed unfinished relayer channel ${channel} (unclaimed ${ch.balance - ch.totalClaimed})`, body ?? res.status);
      } catch (err) {
        check(false, `cleanup: close relayer channel ${channel}`, err instanceof Error ? err.message : String(err));
      }
    }
    for (const v of vaults) {
      try {
        // A spend the current key already signed (escrowed, never sent) is landed first, so the next key is free.
        const current = await readVault(client, d, v.vault);
        const pending = current === null ? undefined : await wotsStore.load(v.keys.keychainId, current.nonce);
        if (current !== null && pending !== undefined) {
          const signed = decodeVaultSpendMessage(hexToBytes(`0x${pending.message}`));
          await send(funder, v.vault, encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [signed.action, signed.nextKeyRoot, signed.params, `0x${pending.signature}`] }));
          console.log(`${v.name}: landed the spend its key ${current.nonce} had signed (action ${signed.action})`);
        }
        const amount = await balance(v.vault);
        const state = await readVault(client, d, v.vault);
        if (amount > 0n && state !== null) {
          await send(funder, v.vault, spendData(await signVaultTransfer(v.keys, state, { chainId: d.chainId, to: funder.address, amount })));
          console.log(`${v.name} returned ${amount} base units to the funder`);
        }
      } catch (err) {
        check(false, `cleanup: return the tokens of ${v.name}`, err instanceof Error ? err.message : String(err));
      }
    }
    try {
      if (relayerAccount !== undefined) console.log(`the relayer account returned ${await sweepEth(relayerAccount, funder.address)} wei to the funder`);
      if (merchantKeys !== undefined) console.log(`the facilitator account returned ${await sweepEth(merchantKeys.facilitator, funder.address)} wei to the funder`);
    } catch (err) {
      check(false, "cleanup: return the relayer's ETH", err instanceof Error ? err.message : String(err));
    }
  };

  let runError: unknown;
  try {
    await waitHttp(`${keeperUrl}/v1/health`, 60);
    const health = (await (await fetch(`${keeperUrl}/v1/health`)).json()) as Record<string, unknown>;
    if (BigInt(health.feePayerWei as string) === 0n) throw new Error(`the keeper fee payer ${String(health.feePayer)} has no ETH; fund it before running this check`);
    const terms = (await (await fetch(`${keeperUrl}/v1/terms`)).json()) as { feeRecipient: Address; feeBps: number; minGraceSeconds: number };
    const feeRecipient = getAddress(terms.feeRecipient);
    feeSplit = { recipient: feeRecipient, bps: terms.feeBps };

    // --- 1. the relayer: vault, keeper crank, account, server -----------------------
    if (recoverRun !== undefined) await stat(join(relayerSecrets, "merchant.key"));
    merchantKeys = await MerchantKeys.open(relayerSecrets);
    relayerAccount = await openRelayerAccount(relayerSecrets);
    const relayerKeys = new WotsKeychain(await secret("relayer-master.key"), await secret("relayer-keychain.id"), wotsStore);
    const relayerVault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot: bytesToHex(relayerKeys.keyRoot(0n)), initialCrank: zeroAddress });
    vaults.push({ name: "the relayer vault", keys: relayerKeys, vault: relayerVault });
    const agentKeys = new WotsKeychain(await secret("agent-master.key"), await secret("agent-keychain.id"), wotsStore);
    const agentVault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot: bytesToHex(agentKeys.keyRoot(0n)), initialCrank: zeroAddress });
    vaults.push({ name: "the agent vault", keys: agentKeys, vault: agentVault });
    const otherKeys = new WotsKeychain(await secret("other-master.key"), await secret("other-keychain.id"), wotsStore);
    const otherVault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot: bytesToHex(otherKeys.keyRoot(0n)), initialCrank: zeroAddress });
    vaults.push({ name: "the prepaid vault", keys: otherKeys, vault: otherVault });
    const session = privateKeyToAccount(bytesToHex(await secret("session.key", isPrivateKey)));
    if (recoverRun !== undefined) return;

    // --- 0. ETH/USD ----------------------------------------------------------------------
    const ethUsd = await chainlinkEthUsd(client)();
    const now = (await client.getBlock()).timestamp;
    check(ethUsd.answer > 0n && now - ethUsd.updatedAt <= 90_000n, "Chainlink ETH/USD reads positive and fresh by chain time", { answer: ethUsd.answer, ageSeconds: now - ethUsd.updatedAt });

    const crank = getAddress(((await (await fetch(`${keeperUrl}/v1/crank?merchant=${merchantKeys.merchant}`)).json()) as { crank: string }).crank);
    await send(funder, d.vaultFactory, encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [token, bytesToHex(relayerKeys.keyRoot(0n)), zeroAddress] }));
    const rv = await readVault(client, d, relayerVault);
    if (rv === null) throw new Error("relayer vault missing");
    await send(funder, relayerVault, spendData(await signVaultSetCrankKey(relayerKeys, rv, { chainId: d.chainId, crank })));
    check((await readVault(client, d, relayerVault))?.crank === crank, "the relayer vault installed the keeper crank of the relayer's merchant key", { relayerVault, crank });
    const { maxFeePerGas } = await client.estimateFeesPerGas();
    const relayerFunding = RELAYER_GAS_BUDGET * maxFeePerGas;
    await walletOf(funder)
      .sendTransaction({ account: funder, chain: robinhoodChain, to: relayerAccount.address, value: relayerFunding })
      .then((hash) => client.waitForTransactionReceipt({ hash }));
    relayer = new Proc("relayer", serverScript, relayerEnv(relayerVault));
    await waitHttp(`${relayerUrl}/v1/relayer`, 60);
    const facts = (await (await fetch(`${relayerUrl}/v1/relayer`)).json()) as Record<string, unknown>;
    const split = getAddress(facts.split as string);
    const grace = terms.minGraceSeconds;
    check(
      facts.feePayer === relayerAccount.address &&
        facts.vault === relayerVault &&
        facts.token === token &&
        facts.decimals === USDG_DECIMALS &&
        facts.gracePeriodSeconds === grace &&
        facts.maxCalls === 8 &&
        facts.merchant === merchantKeys.merchant &&
        facts.crank === crank &&
        toJson(facts.splits) === toJson([feeSplit]),
      "GET /v1/relayer: the relayer account, vault, token, the keeper's withdraw delay and fee split, its merchant key and crank",
      facts,
    );
    const ethAtStart = await client.getBalance({ address: relayerAccount.address });

    // --- agent helpers ----------------------------------------------------------------------
    const post = async (body: string, headers: Record<string, string> = {}): Promise<Posted> => {
      const res = await fetch(`${relayerUrl}/v1/relay`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, signal: AbortSignal.timeout(300_000) });
      return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null, headers: res.headers };
    };
    const vaultCall = async (keys: WotsKeychain, vault: Address, sign: (state: { vault: Address; nonce: bigint; keyRoot: Hex }) => Promise<SignedSpend>): Promise<RelayCall> => {
      const state = await readVault(client, d, vault);
      if (state === null) throw new Error(`${vault} is not a vault`);
      return { to: vault, data: spendData(await sign(state)) };
    };
    const createCall = (keys: WotsKeychain): RelayCall => ({ to: d.vaultFactory, data: encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [token, bytesToHex(keys.keyRoot(0n)), zeroAddress] }) });
    const transfer = (amount: bigint) => vaultCall(agentKeys, agentVault, (s) => signVaultTransfer(agentKeys, s, { chainId: d.chainId, to: funder.address, amount }));

    // The agent vault's channel to the relayer, paid with the stock x402 client: the vault is the
    // payer and cannot sign; the session key signs the vouchers.
    const salt = keccak256(new Uint8Array(randomBytes(32)));
    const vaultSigner = { address: agentVault, signTypedData: () => Promise.reject(new Error("a vault never signs")), readContract: (args: never) => client.readContract(args) };
    const scheme = new BatchSettlementClient(vaultSigner as never, { voucherSigner: toClientEvmSigner(session, client as never), payerAuthorizer: session.address, salt, depositStrategy: () => false });
    const x = new x402Client().register(NETWORK, scheme);
    x.setSpendControls({ allowedAssets: [{ network: NETWORK, asset: token }] });
    const http = new x402HTTPClient(x);
    let paidTotal = 0n;
    /** Posts `body`; a 402 is paid with the agent channel's next voucher. */
    const relayPaid = async (body: string) => {
      const first = await post(body);
      if (first.status !== 402) return { first, second: undefined, price: undefined };
      const requiredHeader = first.headers.get("payment-required");
      const required = http.getPaymentRequiredResponse((n) => first.headers.get(n), first.body);
      const price = BigInt(required.accepts[0]?.amount ?? "0");
      const payload = await http.createPaymentPayload(required);
      const second = await post(body, http.encodePaymentSignatureHeader(payload));
      if (second.headers.get("payment-response") !== null || second.status === 402) await http.processPaymentResult(payload, (n) => second.headers.get(n), second.status);
      if (second.headers.get("payment-response") !== null) paidTotal += price;
      return { first, second, price, requiredHeader, payload };
    };
    const vaultState = async (vault: Address) => (await (await fetch(`${relayerUrl}/v1/vaults/${vault}`)).json()) as { debt: string; credit: string; unpaidOpen: null | { channel: string; amount: string; txHash: string; calls: RelayCall[] } };

    // Requests that must be refused before any simulation are signed with a throwaway keychain:
    // their signatures are not by the vault's current key, so the escrow does not hold them and
    // the agent's own keys stay free for the messages it does send.
    let junkCount = 0;
    const junkCall = async (vault: Address, sign: (junk: WotsKeychain, state: { vault: Address; nonce: bigint; keyRoot: Hex }) => Promise<SignedSpend>): Promise<RelayCall> => {
      const state = await readVault(client, d, vault);
      if (state === null) throw new Error(`${vault} is not a vault`);
      const junk = new WotsKeychain(new Uint8Array(randomBytes(32)), new Uint8Array(randomBytes(32)), new FileWotsStore(join(runDir, `wots-junk-${junkCount++}`)));
      return { to: vault, data: spendData(await sign(junk, { vault, nonce: state.nonce, keyRoot: bytesToHex(junk.keyRoot(state.nonce)) })) };
    };
    const quoted = (body: string) => {
      const hash = relayRequestHash((JSON.parse(body) as { calls: RelayCall[] }).calls);
      return relayer?.events.find((e) => e.event === "quoted" && e.request === hash);
    };

    // --- 2. refused before anything is sent ------------------------------------------------------
    const nonceBefore = await client.getTransactionCount({ address: relayerAccount.address });
    const bad = await post("{not json");
    check(bad.status === 400 && bad.body?.error === "bad_transaction", "a malformed request is refused 400 bad_transaction", bad.body);
    const usdgTransfer = await post(relayRequestBody([{ to: token, data: encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [funder.address, 1n] }) }]));
    check(usdgTransfer.status === 422 && usdgTransfer.body?.error === "refused" && /is not relayed/.test(String(usdgTransfer.body?.message)), "a call outside the relayer's policy (a USDG transfer) is refused 422", usdgTransfer.body);
    const notVault = await post(relayRequestBody([{ to: funder.address, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [0, keccak256("0x01"), `0x${"00".repeat(64)}`, `0x${"00".repeat(1892)}`] }) }]));
    check(notVault.status === 422 && notVault.body?.error === "refused" && /is not an Ostra vault/.test(String(notVault.body?.message)), "a vault spend sent to an address that is not an Ostra vault is refused 422", notVault.body);
    check(
      (await client.getTransactionCount({ address: relayerAccount.address })) === nonceBefore && (await client.getBalance({ address: relayerAccount.address })) === ethAtStart,
      "the relayer account sent nothing for the refused requests",
    );

    // --- 3. createVault before payment -------------------------------------------------------------
    const createBody = relayRequestBody([createCall(agentKeys)]);
    const created = await post(createBody);
    const debt = BigInt(String(created.body?.debt ?? "0"));
    check(created.status === 200 && /^0x[0-9a-f]{64}$/.test(String(created.body?.txHash)) && debt > 0n, "createVault relayed before payment: the vault owes its price", created.body);
    check((await readVault(client, d, agentVault)) !== null, "the agent vault exists on-chain", agentVault);
    check((await vaultState(agentVault)).debt === debt.toString(), "GET /v1/vaults shows the vault's debt", await vaultState(agentVault));
    const again = await post(createBody);
    check(again.status === 200 && again.body?.txHash === created.body?.txHash && again.body?.repeated === true, "the same request sent again gets the same transaction, no second debt", again.body);
    // The channel deposit covers about twenty relayed transactions at this chain's gas price.
    const step = tokens("0.01");
    const deposit = ((20n * debt + step - 1n) / step) * step;
    const t = step;
    const funding = deposit + 6n * t;
    const inDebt = await post(relayRequestBody([await junkCall(agentVault, (junk, st) => signVaultTransfer(junk, st, { chainId: d.chainId, to: funder.address, amount: 1n }))]));
    check(inDebt.status === 403 && inDebt.body?.error === "vault_in_debt", "nothing else is relayed for a vault in debt (403 vault_in_debt)", inDebt.body);

    // --- 4. funding and the open to the relayer --------------------------------------------------------
    await send(funder, token, encodeFunctionData({ abi: usdgAbi, functionName: "transfer", args: [agentVault, funding] }));
    check((await balance(agentVault)) === funding, "the funder funded the agent vault: the channel deposit and six transfers", { deposit, funding });
    const openParams = (withdrawDelay: number, amount: bigint, s: Hex = salt): OpenChannelParams => ({ payerAuthorizer: session.address, receiver: split, receiverAuthorizer: relayerVault, withdrawDelay, salt: s, amount });
    const off = await post(relayRequestBody([await junkCall(agentVault, (junk, st) => signVaultOpenChannel(junk, st, { chainId: d.chainId, open: openParams(grace + 900, deposit) }))]));
    check(off.status === 400 && off.body?.error === "not_relayer_terms" && /grace period/.test(String(off.body?.message)), "an open to the relayer off its terms (withdraw delay) is refused 400", off.body);
    const openBody = relayRequestBody([await vaultCall(agentKeys, agentVault, (st) => signVaultOpenChannel(agentKeys, st, { chainId: d.chainId, open: openParams(grace, deposit) }))]);
    const opened = await post(openBody);
    const owed = BigInt(String(opened.body?.paymentDue ?? "0"));
    const openQuote = quoted(openBody);
    const channel = computeChannelId(vaultChannelConfig(agentVault, token, openParams(grace, deposit)), d.chainId, d.batchSettlement).toLowerCase() as Hex;
    check(
      opened.status === 200 && opened.body?.channel === channel && openQuote !== undefined && owed === BigInt(String(openQuote.amount)) + debt,
      "the open on the relayer's terms is relayed before payment; its first voucher owes the open's price and the debt",
      { body: opened.body, quote: openQuote?.amount, debt },
    );
    const ch0 = await readChannel(client, d.batchSettlement, channel);
    check(ch0.balance === deposit && ch0.totalClaimed === 0n, "the channel to the relayer holds the deposit", ch0);
    const pendingOpen = (await vaultState(agentVault)).unpaidOpen;
    check(
      pendingOpen !== null && pendingOpen.channel === channel && pendingOpen.amount === owed.toString() && pendingOpen.txHash === opened.body?.txHash && toJson(pendingOpen.calls) === toJson((JSON.parse(openBody) as { calls: RelayCall[] }).calls),
      "GET /v1/vaults shows the unpaid open with the calls that pay it",
      pendingOpen,
    );
    const waiting = await post(relayRequestBody([await junkCall(agentVault, (junk, st) => signVaultTransfer(junk, st, { chainId: d.chainId, to: funder.address, amount: 1n }))]));
    check(waiting.status === 403 && waiting.body?.error === "vault_in_debt", "any other request of the vault waits for the open to be paid", waiting.body);
    const secondOpen = await post(relayRequestBody([await junkCall(agentVault, (junk, st) => signVaultOpenChannel(junk, st, { chainId: d.chainId, open: openParams(grace, deposit, keccak256("0x02")) }))]));
    check(secondOpen.status === 403 && secondOpen.body?.error === "open_unpaid", "a second open waits for the first to be paid (403 open_unpaid)", secondOpen.body);
    const payOpen = await relayPaid(openBody);
    check(payOpen.first.status === 402 && payOpen.price === owed, "the open sent again answers 402 for the open and the debt", { status: payOpen.first.status, price: payOpen.price, owed });
    check(payOpen.second?.status === 200 && payOpen.second.body?.txHash === opened.body?.txHash && payOpen.second.body?.paid === owed.toString(), "the channel's first voucher pays the open and the debt", payOpen.second?.body);
    const afterOpen = await vaultState(agentVault);
    check(afterOpen.debt === "0" && afterOpen.unpaidOpen === null, "the vault owes nothing once the open is paid", afterOpen);
    const forwarded = await relayer.waitEvent((e) => e.event === "voucher_forwarded" && e.channel === channel && e.cumulative === owed.toString(), 30);
    check(forwarded?.accepted === true, "the voucher was forwarded to the keeper and accepted", forwarded ?? "not forwarded");

    // --- 5. a paid spend Transfer; the escrow ------------------------------------------------------------
    const fundsBefore = await balance(funder.address);
    const r1Call = await transfer(t);
    const r1 = relayRequestBody([r1Call]);
    const p1 = await relayPaid(r1);
    const q1 = quoted(r1);
    const rule = (q: Record<string, unknown> | undefined) =>
      q !== undefined &&
      BigInt(String(q.wei)) === BigInt(String(q.gas)) * BigInt(String(q.gasPrice)) &&
      BigInt(String(q.amount)) === weiToTokenUnits(withMargin(BigInt(String(q.wei))) + BigInt(String(q.value ?? "0")), { answer: BigInt(String(q.ethUsd)), roundId: 0n, updatedAt: 0n }, decimals);
    check(p1.first.status === 402 && q1 !== undefined && p1.price === BigInt(String(q1.amount)) && rule(q1), "a spend Transfer answers 402 for its price: gas x gas price + 10% at ETH/USD + 0.5%", { price: p1.price, quote: q1 });
    check(p1.second?.status === 200 && p1.second.body?.paid === p1.price?.toString() && (await balance(funder.address)) - fundsBefore === t, "paid by voucher, the transfer is sent", p1.second?.body);
    const r1Again = await post(r1);
    check(r1Again.status === 200 && r1Again.body?.repeated === true && r1Again.body?.txHash === p1.second?.body?.txHash, "the paid request sent again: the same transaction, no second charge", r1Again.body);
    const key1 = bytesToHex(agentKeys.keyRoot(1n));
    const escrowed = (await (await fetch(`${relayerUrl}/v1/signatures/${key1}`)).json()) as { call?: { data?: string }; kind?: string; nonce?: string };
    check(escrowed.kind === "vault" && escrowed.nonce === "1" && escrowed.call?.data === r1Call.data.toLowerCase(), "the transfer's WOTS signature was escrowed under the vault's key root", escrowed);

    // --- 5b. a createVault paid up front ------------------------------------------------------------------
    const prepayBody = relayRequestBody([createCall(otherKeys)], { prepay: true, payer: agentVault });
    const prepaid = await relayPaid(prepayBody);
    check(prepaid.first.status === 402 && prepaid.price === BigInt(String(quoted(prepayBody)?.amount ?? "-1")), "a createVault paid up front (prepay) answers 402 for its price", { price: prepaid.price });
    check(prepaid.second?.status === 200 && (await readVault(client, d, otherVault)) !== null && (await vaultState(otherVault)).debt === "0", "paid by the agent vault's channel: the vault exists and owes nothing", prepaid.second?.body);

    // --- 5c. paid but not sent: credit; a reused key ----------------------------------------------------
    // Four transfers of keys 2 to 5 in one request (Multicall3); a third party lands the same
    // transaction first, so the relayer's copy reverts and is not sent. Its price, credited, pays
    // the spends of 5d and 6.
    const signAt = (n: bigint) => signVaultTransfer(agentKeys, { vault: agentVault, nonce: n, keyRoot: bytesToHex(agentKeys.keyRoot(n)) }, { chainId: d.chainId, to: funder.address, amount: t });
    const r2Calls: RelayCall[] = [];
    for (const n of [2n, 3n, 4n, 5n]) r2Calls.push({ to: agentVault, data: spendData(await signAt(n)) });
    const r2 = relayRequestBody(r2Calls);
    const r2First = await post(r2);
    const r2Required = http.getPaymentRequiredResponse((n) => r2First.headers.get(n), r2First.body);
    const r2Price = BigInt(r2Required.accepts[0]?.amount ?? "0");
    check(r2First.status === 402 && r2Price > 0n, "four transfers in one request answer 402 for their price", { status: r2First.status, price: r2Price });
    const wipedKeys = new WotsKeychain(await readSecret(join(runDir, "agent-master.key")), await readSecret(join(runDir, "agent-keychain.id")), new FileWotsStore(join(runDir, "wots-wiped")));
    const otherMessage = relayRequestBody([
      { to: agentVault, data: spendData(await signVaultTransfer(wipedKeys, { vault: agentVault, nonce: 2n, keyRoot: bytesToHex(agentKeys.keyRoot(2n)) }, { chainId: d.chainId, to: funder.address, amount: 2n * t })) },
    ]);
    const reused = await post(otherMessage);
    const held = reused.body?.signature as { call?: { data?: string }; keyRoot?: string } | undefined;
    check(reused.status === 409 && reused.body?.error === "key_reused" && held?.call?.data === r2Calls[0]?.data.toLowerCase(), "another message signed with an escrowed key (a wiped WOTS store) is refused 409 key_reused with the escrowed record", reused.body);
    const multicall = JSON.parse(r2) as { calls: RelayCall[] };
    await send(funder, MULTICALL3, relayTransaction(multicall.calls).data);
    check((await readVault(client, d, agentVault))?.nonce === 6n, "a third party landed the four transfers first");
    const r2Payload = await http.createPaymentPayload(r2Required);
    const r2Paid = await post(r2, http.encodePaymentSignatureHeader(r2Payload));
    if (r2Paid.headers.get("payment-response") !== null) {
      await http.processPaymentResult(r2Payload, (n) => r2Paid.headers.get(n), r2Paid.status);
      paidTotal += r2Price;
    }
    const credit = r2Paid.body?.credit as { vault?: string; amount?: string } | undefined;
    check(r2Paid.status === 409 && r2Paid.body?.error === "not_sent" && credit?.vault === agentVault && credit.amount === r2Price.toString(), "paid by voucher but not sent: what was paid becomes the vault's credit (409 not_sent)", r2Paid.body);
    check((await vaultState(agentVault)).credit === r2Price.toString(), "GET /v1/vaults shows the credit", await vaultState(agentVault));
    const late = await post(otherMessage);
    check(late.status === 422 && late.body?.error === "simulation_failed", "once that key is used on-chain, the other message is not escrowed and its simulation refuses it", late.body);

    // --- 5d. paid from credit -------------------------------------------------------------------------------------
    const fromCreditBody = relayRequestBody([await transfer(t)]);
    const fromCredit = await post(fromCreditBody);
    const p5 = BigInt(String(quoted(fromCreditBody)?.amount ?? "0"));
    check(fromCredit.status === 200 && fromCredit.body?.paid === "0" && fromCredit.body?.fromCredit === p5.toString(), "a spend of the vault is paid from its credit alone, without a 402", fromCredit.body);
    let creditLeft = r2Price - p5;
    check((await vaultState(agentVault)).credit === creditLeft.toString(), "the credit it used is taken off", { credit: (await vaultState(agentVault)).credit, expected: creditLeft });
    const otherSpendBody = relayRequestBody([await vaultCall(otherKeys, otherVault, (st) => signVaultSetCrankKey(otherKeys, st, { chainId: d.chainId, crank: zeroAddress }))], { payer: agentVault });
    const fakeConfig = { payer: otherVault, payerAuthorizer: session.address, receiver: split, receiverAuthorizer: relayerVault, token, withdrawDelay: grace, salt };
    const fake = encodePaymentSignatureHeader({ x402Version: 2, accepted: {}, payload: { type: "voucher", channelConfig: fakeConfig, voucher: { channelId: computeChannelId(fakeConfig, d.chainId, d.batchSettlement), maxClaimableAmount: "1", signature: "0x" } } } as unknown as PaymentPayload);
    const wrong = await post(otherSpendBody, { "PAYMENT-SIGNATURE": fake });
    check(wrong.status === 403 && wrong.body?.error === "wrong_payer", "a voucher from another vault's channel cannot spend the agent vault's credit (403 wrong_payer)", wrong.body);
    const both = await relayPaid(otherSpendBody);
    const p6 = BigInt(String(quoted(otherSpendBody)?.amount ?? "0"));
    const used = creditLeft < p6 - 1n ? creditLeft : p6 - 1n;
    check(
      both.first.status === 402 && both.price === p6 - used && both.second?.status === 200 && both.second.body?.paid === (p6 - used).toString() && both.second.body?.fromCredit === used.toString(),
      "the agent vault's own channel pays at least one base unit and its credit the rest",
      { price: p6, used, first: both.first.status, body: both.second?.body },
    );
    creditLeft -= used;

    // --- 5e. a vault Swap that fails is refused unless asked for ----------------------------------------
    // The prepaid vault holds no USDG: its Swap fails inside the PoolManager (SwapFailed) without
    // reverting, so sent it would only use the vault's key up.
    const ethUsdg = { currency0: zeroAddress, currency1: token, fee: 500, tickSpacing: 10, hooks: zeroAddress };
    const failingSwap = await vaultCall(otherKeys, otherVault, (st) =>
      signVaultSwap(otherKeys, st, { chainId: d.chainId, token, swap: { key: ethUsdg, zeroForOne: false, amountIn: 10n ** BigInt(decimals), minOut: 0n, recipient: funder.address } }),
    );
    const swapBody = relayRequestBody([failingSwap], { payer: agentVault });
    const swapRefused = await post(swapBody);
    check(swapRefused.status === 422 && swapRefused.body?.error === "swap_fails" && quoted(swapBody) === undefined, "a vault Swap the simulation shows failing (SwapFailed) is refused 422 swap_fails and not quoted", swapRefused.body);
    const swapAllowedBody = relayRequestBody([failingSwap], { payer: agentVault, allowFailedSwaps: true });
    const swapAllowed = await post(swapAllowedBody);
    const swapQuote = quoted(swapAllowedBody);
    check(
      swapAllowed.status === 402 && swapQuote !== undefined && rule(swapQuote) && BigInt(String(swapQuote.gas)) > BigInt(VAULT_SWAP_GAS.DEFAULT),
      "asked for with allowFailedSwaps, the same Swap answers 402 for its price, which counts the swapGas it reserves",
      { status: swapAllowed.status, quote: swapQuote },
    );
    const swapAgain = await post(swapBody);
    check(swapAgain.status === 422 && swapAgain.body?.error === "swap_fails", "quoted, the Swap sent back without allowFailedSwaps is simulated again and refused before any voucher", swapAgain.body);
    const swapNonce = (await readVault(client, d, otherVault))?.nonce;
    const swapTx = await send(funder, otherVault, failingSwap.data);
    const landedFail = failedSwaps((await client.getTransactionReceipt({ hash: swapTx })).logs, [otherVault]);
    check(
      landedFail.length === 1 && (await balance(otherVault)) === 0n && (await readVault(client, d, otherVault))?.nonce === (swapNonce ?? -1n) + 1n,
      "landed by a third party, the Swap emits SwapFailed, moves nothing and uses the vault's key",
      landedFail,
    );

    // --- 6. requestClose through the relayer, paid from credit ----------------------------------------------
    const config = vaultChannelConfig(agentVault, token, openParams(grace, deposit));
    const before6 = await readChannel(client, d.batchSettlement, channel);
    const closeNonce = await client.readContract({ address: agentVault, abi: ostraVaultAbi, functionName: "closeNonce", args: [channel] });
    const deadline = (await client.getBlock()).timestamp + 3_600n;
    const amount = before6.balance - before6.totalClaimed;
    const closeSignature = await session.sign({ hash: closeDigest({ chainId: d.chainId, vault: agentVault, channelId: channel, amount, nonce: closeNonce, deadline }) });
    const closeBody = relayRequestBody([{ to: agentVault, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "requestClose", args: [config, amount, deadline, closeSignature] }) }]);
    const closePrice = BigInt(String((await (async () => {
      const r = await post(closeBody);
      check(r.status === 200 && r.body?.paid === "0", "requestClose of the relayer channel through the relayer, paid from the vault's credit", { body: r.body, creditLeft });
      return quoted(closeBody)?.amount ?? "0";
    })())));
    creditLeft -= closePrice;
    const closedCh = await (async () => {
      for (let i = 0; i < 60; i++) {
        const c = await readChannel(client, d.batchSettlement, channel);
        if (c.balance === c.totalClaimed && c.totalClaimed === paidTotal) return c;
        await sleep(3_000);
      }
      return readChannel(client, d.batchSettlement, channel);
    })();
    check(closedCh.totalClaimed === paidTotal && closedCh.balance === closedCh.totalClaimed, "the keeper claimed every paid voucher and refunded the rest on the WithdrawInitiated it watches", { channel: closedCh, paidTotal });

    // --- 7. the CreateVault limit -------------------------------------------------------------------------------
    for (const label of ["third", "fourth"]) {
      const keys = new WotsKeychain(await secret(`${label}-master.key`), await secret(`${label}-keychain.id`), wotsStore);
      const r = await post(relayRequestBody([createCall(keys)]));
      check(r.status === 200 && BigInt(String(r.body?.debt ?? "0")) > 0n, `the ${label === "third" ? "second" : "third"} vault of this IP address is created before payment`, r.body);
    }
    const fifthKeys = new WotsKeychain(new Uint8Array(randomBytes(32)), new Uint8Array(randomBytes(32)), wotsStore);
    const limited = await post(relayRequestBody([createCall(fifthKeys)]));
    check(limited.status === 403 && limited.body?.error === "create_vault_limit" && CREATE_VAULTS_PER_IP === 3, "the fourth vault before payment from the same IP address is refused (403 create_vault_limit)", limited.body);

    // --- 8. accounting -------------------------------------------------------------------------------------------
    const share = (x: bigint) => (x * BigInt(terms.feeBps)) / 10_000n;
    const payout = await (async () => {
      for (let i = 0; i < 40; i++) {
        if ((await balance(split)) === 0n && (await balance(relayerVault)) === paidTotal - share(paidTotal)) return true;
        await sleep(3_000);
      }
      return false;
    })();
    check(payout, "the relayer vault got everything the agent paid less the keeper fee, and its split holds nothing", { relayerVault: await balance(relayerVault), paidTotal });
    check((await balance(feeRecipient)) >= share(paidTotal), "the keeper fee recipient got its bps of the relayer channel");
    const ev = relayer.events;
    const sum = (names: string[], field: string) => ev.filter((e) => names.includes(String(e.event))).reduce((a, e) => a + BigInt(String(e[field] ?? "0")), 0n);
    check(sum(["relayer_channel_paid", "relayed", "paid_not_sent"], "amount") === paidTotal, "what the vault's channel paid equals the relayer's paid log", { logged: sum(["relayer_channel_paid", "relayed", "paid_not_sent"], "amount"), paidTotal });
    const quotes = ev.filter((e) => e.event === "quoted");
    check(quotes.length > 0 && quotes.every((q) => rule(q)), "every quote follows the rule from its logged gas, gas price and ETH/USD", quotes.length);
    // The gas of every landed transaction, the ETH a launch sent, and the gas of any that reverted on-chain.
    const gasSpent =
      ev.filter((e) => typeof e.gasUsed === "string" && typeof e.effectiveGasPrice === "string").reduce((a, e) => a + BigInt(e.gasUsed as string) * BigInt(e.effectiveGasPrice as string) + BigInt(String(e.value ?? "0")), 0n) +
      ev.reduce((a, e) => a + BigInt(String(e.spentWei ?? "0")), 0n);
    const ethNow = await client.getBalance({ address: relayerAccount.address });
    check(ethAtStart - ethNow === gasSpent, "the relayer account paid exactly the gas of the transactions it logged as landed", { spent: ethAtStart - ethNow, logged: gasSpent });
    check((await balance(agentVault)) === deposit - paidTotal, "the agent vault holds what was funded less its six transfers and what it paid the relayer", { vault: await balance(agentVault), deposit, paidTotal });
    const agentEnd = await vaultState(agentVault);
    check(agentEnd.debt === "0" && agentEnd.credit === creditLeft.toString() && agentEnd.unpaidOpen === null, "the agent vault owes nothing and keeps the credit it did not use", { agentEnd, creditLeft });
  } catch (err) {
    runError = err;
  } finally {
    try {
      if (merchantKeys !== undefined) await cleanup();
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
