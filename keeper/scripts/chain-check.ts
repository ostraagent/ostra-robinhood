// Runs the keeper as a seller would use it, against the configured chain.
// Nothing is simulated: the keeper runs as its own process (src/main.ts) and
// every step is a real transaction to Ostra's contracts and to
// x402BatchSettlement.
//
//   1. A seller vault is created with the keeper crank of a fresh merchant key
//      (GET /v1/crank); a buyer vault is created and funded from the funder.
//   2. Channel A (deposit 2 tokens, withdraw delay 900 s, paid to the seller's
//      OstraSplit with the 30 bps keeper fee to the recipient GET /v1/terms
//      names): vouchers are forwarded to POST /v1/vouchers. Duplicates, a
//      foreign merchant key and a forged voucher are refused; at 1.2 tokens
//      unclaimed the keeper claims on its own (threshold 1 token). After a
//      voucher of 1.5, the buyer asks to close (OstraVault.requestClose,
//      signed by the voucher key); the keeper must claim the 1.5 voucher,
//      refund the rest to the buyer vault and pay the split out.
//   3. Channel B (deposit 0.5): a merchant key whose crank is not on the vault
//      is refused; a close request with a bad signature is refused; then the
//      seller's close request with a 0.2 voucher claims, refunds and pays out
//      at once.
//   4. Balances are checked to the base unit, then both test vaults send their
//      tokens back to the funder (WOTS transfers).
//
// Environment: the keeper's own variables (OSTRA_RPC_URL, OSTRA_DEPLOYMENT,
// OSTRA_KEEPER_SECRETS, OSTRA_KEEPER_DATA, OSTRA_KEEPER_LISTEN,
// OSTRA_KEEPER_FEE_RECIPIENT), plus a keeper fee payer holding ETH (GET
// /v1/health shows its address), plus
//   OSTRA_CHECK_FUNDER  file (0600) with the 32-byte hex private key of an
//                       account holding ETH and at least 2.5 tokens
//   OSTRA_CHECK_STATE   directory (0700) for this check's seeds and WOTS records

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { bytesToHex, createPublicClient, createWalletClient, keccak256, zeroAddress, type Address, type Hex, type PrivateKeyAccount, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  WotsKeychain,
  assertRobinhoodChain,
  channelId,
  closeRequestTypedData,
  fromHex,
  ostraSplitFactoryAbi,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  readChannel,
  readVault,
  retryingHttp,
  robinhoodChain,
  signVaultOpenChannel,
  signVaultTransfer,
  usdgAbi,
  vaultAddress,
  vaultChannelConfig,
  voucherTypedData,
  type ChannelConfig,
  type SignedSpend,
} from "@ostraagent/sdk";
import { loadConfig } from "../src/config.ts";
import { closeRequestMessage, ensurePrivateDir, isPrivateKey } from "../src/keys.ts";

const GRACE_SECONDS = 900;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(ok: boolean, what: string, detail: unknown = ""): void {
  if (!ok) failures++;
  const text = typeof detail === "string" ? detail : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail === "" ? "" : ` (${text})`}`);
}

async function readFunder(path: string): Promise<PrivateKeyAccount> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${path} must not be accessible by other users`);
  const text = (await readFile(path, "utf8")).trim().replace(/^0x/, "").toLowerCase();
  const bytes = fromHex(text);
  if (bytes.length !== 32 || !isPrivateKey(bytes)) throw new Error(`${path}: expected a 32-byte secp256k1 private key in hex`);
  return privateKeyToAccount(bytesToHex(bytes));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const d = config.deployment;
  const token = d.token;
  const funderFile = process.env.OSTRA_CHECK_FUNDER;
  const stateDir = process.env.OSTRA_CHECK_STATE;
  if (funderFile === undefined || funderFile === "" || stateDir === undefined || stateDir === "") {
    throw new Error("set OSTRA_CHECK_FUNDER and OSTRA_CHECK_STATE");
  }
  const transport = retryingHttp(config.rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
  await assertRobinhoodChain(client);
  const decimals = await client.readContract({ address: token, abi: usdgAbi, functionName: "decimals" });
  const unit = 10n ** BigInt(decimals);
  const tokens = (text: string) => {
    const [whole, fraction = ""] = text.split(".");
    return BigInt(whole!) * unit + BigInt(fraction.padEnd(decimals, "0"));
  };
  const funder = await readFunder(funderFile);
  const wallet = createWalletClient({ account: funder, chain: robinhoodChain, transport });
  const balance = (who: Address) => client.readContract({ address: token, abi: usdgAbi, functionName: "balanceOf", args: [who] });
  const send = async (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> => {
    const hash = await wallet.writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, account: funder, chain: robinhoodChain });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return hash;
  };
  const spend = (vault: Address, s: SignedSpend) => send(vault, ostraVaultAbi, "spend", [s.action, s.nextKeyRoot, s.params, s.signature]);

  if ((await client.getBalance({ address: funder.address })) === 0n) throw new Error(`the funder ${funder.address} has no ETH`);
  if ((await balance(funder.address)) < tokens("2.5")) throw new Error(`the funder ${funder.address} holds less than 2.5 tokens`);

  await ensurePrivateDir(stateDir);
  const runDir = join(stateDir, `run-${Date.now()}`);
  await ensurePrivateDir(runDir);
  const store = new FileWotsStore(join(runDir, "wots"));
  console.log(`funder ${funder.address}, run state ${runDir}`);

  // A vault's keychain; its seeds are kept in the run directory, so the vault
  // can still be spent from if the check stops half-way.
  const newKeychain = async (name: string): Promise<WotsKeychain> => {
    const master = new Uint8Array(randomBytes(32));
    const seed = new Uint8Array(randomBytes(32));
    await writeFile(join(runDir, `${name}.seeds.json`), `${JSON.stringify({ master: bytesToHex(master), seed: bytesToHex(seed) })}\n`, { mode: 0o600, flag: "wx" });
    return new WotsKeychain(master, seed, store);
  };
  const createVault = async (keys: WotsKeychain, crank: Address): Promise<Address> => {
    const root0 = bytesToHex(keys.keyRoot(0n));
    await send(d.vaultFactory, ostraVaultFactoryAbi, "createVault", [token, root0, crank]);
    return vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token, initialKeyRoot: root0, initialCrank: crank });
  };

  // --- the keeper, as its own process -------------------------------------
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "OSTRA_RPC_URL", "OSTRA_DEPLOYMENT", "OSTRA_KEEPER_SECRETS", "OSTRA_KEEPER_DATA", "OSTRA_KEEPER_LISTEN", "OSTRA_KEEPER_FEE_RECIPIENT"]) {
    const value = process.env[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  const keeperMain = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const child: ChildProcess = spawn(process.execPath, [keeperMain], { env, stdio: ["ignore", "pipe", "pipe"] });
  if (child.stdout !== null) createInterface({ input: child.stdout }).on("line", (line) => console.log(`  keeper | ${line}`));
  if (child.stderr !== null) createInterface({ input: child.stderr }).on("line", (line) => console.log(`  keeper ! ${line}`));
  const base = `http://${config.listen.host}:${config.listen.port}`;
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  try {
    for (let i = 0; ; i++) {
      try {
        if ((await call("GET", "/v1/health")).status === 200) break;
      } catch {
        // not listening yet
      }
      if (i >= 60) throw new Error("the keeper did not start");
      await sleep(1_000);
    }
    const health = (await call("GET", "/v1/health")).json;
    if (BigInt(health.feePayerWei as string) === 0n) {
      throw new Error(`the keeper fee payer ${String(health.feePayer)} has no ETH; fund it before running this check`);
    }
    console.log(`keeper fee payer ${String(health.feePayer)} holds ${String(health.feePayerWei)} wei`);

    // --- seller: a vault whose crank is the keeper crank of its merchant key ---
    const merchant = privateKeyToAccount(generatePrivateKey());
    const crankReply = await call("GET", `/v1/crank?merchant=${merchant.address}`);
    const crank = crankReply.json.crank as Address;
    check(crankReply.status === 200, "GET /v1/crank returns the merchant's crank", crank);
    const sellerKeys = await newKeychain("seller");
    const sellerVault = await createVault(sellerKeys, crank);
    check((await readVault(client, d, sellerVault))?.crank === crank, "seller vault created with the keeper crank", sellerVault);

    // --- buyer: a vault funded with 2.5 tokens ------------------------------
    const buyerKeys = await newKeychain("buyer");
    const buyerVault = await createVault(buyerKeys, zeroAddress);
    await send(token, usdgAbi, "transfer", [buyerVault, tokens("2.5")]);
    check((await balance(buyerVault)) === tokens("2.5"), "buyer vault funded with 2.5 tokens");

    const terms = (await call("GET", "/v1/terms")).json;
    const feeRecipient = terms.feeRecipient as Address;
    const feeBps = terms.feeBps as number;
    check(feeBps === 30 && terms.minGraceSeconds === GRACE_SECONDS && terms.chainId === d.chainId && terms.token === token, "GET /v1/terms returns the decided keeper fee, minimum withdraw delay, chain and token", terms);
    const splits = [{ recipient: feeRecipient, bps: feeBps }];
    const sellerSplit = await client.readContract({ address: d.splitFactory, abi: ostraSplitFactoryAbi, functionName: "splitAddress", args: [token, sellerVault, [feeRecipient], [feeBps]] });
    const feeBefore = await balance(feeRecipient);

    const open = async (deposit: bigint, voucherKey: PrivateKeyAccount): Promise<ChannelConfig> => {
      const v = await readVault(client, d, buyerVault);
      if (v === null) throw new Error("buyer vault missing");
      const params = {
        payerAuthorizer: voucherKey.address,
        receiver: sellerSplit,
        receiverAuthorizer: sellerVault,
        withdrawDelay: GRACE_SECONDS,
        salt: keccak256(new Uint8Array(randomBytes(32))),
        amount: deposit,
      };
      await spend(buyerVault, await signVaultOpenChannel(buyerKeys, v, { chainId: d.chainId, open: params }));
      return vaultChannelConfig(buyerVault, token, params);
    };
    const idOf = (c: ChannelConfig) => channelId(c, d.chainId, d.batchSettlement);
    const voucher = async (key: PrivateKeyAccount, c: ChannelConfig, amount: string) => {
      const id = idOf(c);
      const signature = await key.signTypedData(voucherTypedData({ channelId: id, maxClaimableAmount: tokens(amount), chainId: d.chainId, settlement: d.batchSettlement }));
      return { channelId: id, maxClaimableAmount: tokens(amount).toString(), signature };
    };
    const channel = (c: ChannelConfig) => readChannel(client, d.batchSettlement, idOf(c));
    const waitFor = async (done: () => Promise<boolean>, seconds: number): Promise<boolean> => {
      for (let i = 0; i < seconds; i += 3) {
        if (await done()) return true;
        await sleep(3_000);
      }
      return done();
    };

    // --- channel A: threshold claim, then the buyer closes -------------------
    const keyA = privateKeyToAccount(generatePrivateKey());
    const channelA = await open(tokens("2"), keyA);
    console.log(`channel A ${idOf(channelA)}`);
    const sellerBefore = await balance(sellerVault);
    let r = await call("POST", "/v1/vouchers", { merchant: merchant.address, channelConfig: channelA, voucher: await voucher(keyA, channelA, "0.3"), splits });
    check(r.status === 200 && r.json.accepted === true, "voucher 0.3 accepted with the splits", r.json);
    r = await call("POST", "/v1/vouchers", { merchant: merchant.address, channelConfig: channelA, voucher: await voucher(keyA, channelA, "0.3") });
    check(r.status === 200 && r.json.accepted === false && r.json.reason === "not_newer", "the same voucher again is not newer", r.json);
    const stranger = privateKeyToAccount(generatePrivateKey());
    r = await call("POST", "/v1/vouchers", { merchant: stranger.address, channelConfig: channelA, voucher: await voucher(keyA, channelA, "0.4") });
    check(r.status === 403 && r.json.error === "wrong_merchant", "another merchant key is refused", r.json);
    r = await call("POST", "/v1/vouchers", { merchant: merchant.address, channelConfig: channelA, voucher: await voucher(stranger, channelA, "0.4") });
    check(r.status === 400 && r.json.error === "bad_voucher_signature", "a voucher signed by another key is refused", r.json);
    r = await call("POST", "/v1/vouchers", { merchant: merchant.address, channelConfig: channelA, voucher: await voucher(keyA, channelA, "0.6") });
    check(r.status === 200 && r.json.accepted === true, "voucher 0.6 accepted (below the threshold)", r.json);
    await sleep(5_000);
    check((await channel(channelA)).totalClaimed === 0n, "nothing claimed below 1 token");
    r = await call("POST", "/v1/vouchers", { merchant: merchant.address, channelConfig: channelA, voucher: await voucher(keyA, channelA, "1.2") });
    check(r.status === 200 && r.json.accepted === true, "voucher 1.2 accepted", r.json);
    await waitFor(async () => (await channel(channelA)).totalClaimed === tokens("1.2"), 90);
    let ch = await channel(channelA);
    check(ch.totalClaimed === tokens("1.2") && ch.balance === tokens("2"), "the keeper claimed 1.2 on its own (threshold 1 token)", ch);
    r = await call("POST", "/v1/vouchers", { merchant: merchant.address, channelConfig: channelA, voucher: await voucher(keyA, channelA, "1.5") });
    check(r.status === 200 && r.json.accepted === true, "voucher 1.5 accepted", r.json);
    {
      const id = idOf(channelA);
      const nonce = await client.readContract({ address: buyerVault, abi: ostraVaultAbi, functionName: "closeNonce", args: [id] });
      const deadline = (await client.getBlock()).timestamp + 600n;
      const amount = ch.balance - ch.totalClaimed;
      const signature = await keyA.signTypedData(closeRequestTypedData({ chainId: d.chainId, vault: buyerVault, channelId: id, amount, nonce, deadline }));
      await send(buyerVault, ostraVaultAbi, "requestClose", [channelA, amount, deadline, signature]);
    }
    check((await channel(channelA)).pendingWithdrawal !== null, "the buyer's close request started a withdrawal on channel A");
    console.log("the buyer asked to close channel A; the keeper must claim and refund it within its 30 s watch interval");
    const paidA = tokens("1.5");
    const share = (amount: bigint) => (amount * BigInt(feeBps)) / 10_000n;
    await waitFor(async () => {
      const c = await channel(channelA);
      return c.balance === c.totalClaimed && (await balance(sellerVault)) - sellerBefore === paidA - share(paidA);
    }, 180);
    ch = await channel(channelA);
    check(ch.totalClaimed === paidA, "channel A claimed at the last voucher 1.5", ch.totalClaimed.toString());
    check(ch.balance === ch.totalClaimed, "channel A refunded: no unclaimed escrow left", ch);
    check((await balance(sellerVault)) - sellerBefore === paidA - share(paidA), "channel A paid out to the seller vault");

    // --- channel B: the seller's close request -------------------------------
    const keyB = privateKeyToAccount(generatePrivateKey());
    const channelB = await open(tokens("0.5"), keyB);
    const idB = idOf(channelB);
    console.log(`channel B ${idB}`);
    r = await call("POST", "/v1/vouchers", { merchant: stranger.address, channelConfig: channelB, voucher: await voucher(keyB, channelB, "0.1"), splits });
    check(r.status === 403 && r.json.error === "not_keeper_crank", "a merchant key whose crank is not on the vault is refused", r.json);
    const badSignature = await stranger.signMessage({ message: { raw: closeRequestMessage(d.chainId, idB) } });
    r = await call("POST", "/v1/close", { merchant: merchant.address, channelConfig: channelB, signature: badSignature, splits });
    check(r.status === 403 && r.json.error === "bad_signature", "a close request not signed by the merchant key is refused", r.json);
    const signature = await merchant.signMessage({ message: { raw: closeRequestMessage(d.chainId, idB) } });
    r = await call("POST", "/v1/close", { merchant: merchant.address, channelConfig: channelB, signature, voucher: await voucher(keyB, channelB, "0.2"), splits });
    check(r.status === 200 && typeof r.json.tx === "string", "the seller's close request claimed, refunded and paid out channel B", r.json);
    ch = await channel(channelB);
    check(ch.totalClaimed === tokens("0.2") && ch.balance === ch.totalClaimed, "channel B claimed at 0.2 with no unclaimed escrow left", ch);

    // --- balances ------------------------------------------------------------
    const paidB = tokens("0.2");
    const sellerExpected = paidA - share(paidA) + (paidB - share(paidB));
    const buyerExpected = tokens("2.5") - paidA - paidB;
    const sellerBalance = await balance(sellerVault);
    const buyerBalance = await balance(buyerVault);
    check(sellerBalance === sellerExpected, "seller vault holds both payments minus the 30 bps keeper fee", `${sellerBalance} vs ${sellerExpected}`);
    check(buyerBalance === buyerExpected, "buyer vault got every unspent deposit back", `${buyerBalance} vs ${buyerExpected}`);
    const feeAfter = await balance(feeRecipient);
    check(feeAfter - feeBefore === share(paidA) + share(paidB), "the keeper fee recipient got 30 bps of each channel", `${feeAfter - feeBefore}`);
    check((await balance(sellerSplit)) === 0n, "the seller's split holds nothing after release");

    // --- return the test tokens to the funder (WOTS transfers) ---------------
    for (const [name, vault, keys] of [["seller", sellerVault, sellerKeys], ["buyer", buyerVault, buyerKeys]] as const) {
      const amount = await balance(vault);
      const v = await readVault(client, d, vault);
      if (amount === 0n || v === null) continue;
      await spend(vault, await signVaultTransfer(keys, v, { chainId: d.chainId, to: funder.address, amount }));
      console.log(`${name} vault returned ${amount} base units to the funder`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  }
  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  const url = process.env.OSTRA_RPC_URL;
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(url === undefined || url === "" ? message : message.split(url).join("<rpc>"));
  process.exit(1);
});
