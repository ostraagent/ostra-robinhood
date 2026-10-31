// Funds Ostrapad's evaluator bot (decided by Edu on 30 and 31 Oct 2026: four evaluator accounts with a bond of
// 50 USDG each, 10 USDG of Raeto credits, 0.005 ETH for gas) from the funding account, in two phases:
//
//   raeto   the fee payer gets the ETH (all of it: it pays its own sends and tops the evaluator accounts up as they
//           send, Sender.fromCrank) and the credits' USDG from the funding account, then sends that USDG to Raeto's
//           payTo (checked against Raeto's terms and the address pinned in core): the credits of the bot's Raeto
//           account (the fee payer's wallet). Then Raeto's account is read until the credits show (15 minutes at most).
//   pool    each evaluator account not in OstraPad's pool gets the bond's USDG from the funding account, approves
//           OstraPad for it and joins the pool (msg.sender), its gas topped up from the fee payer. Its bond counts for
//           draws STAKE_DELAY (2 days) after it joins.
//
// Each send is recorded in the bot's data directory (fund-pad-evaluator.json) before its receipt is awaited, and a
// step recorded is never sent again: a run stopped at any point is run again to finish. Before a phase sends
// anything, the funding account is checked to hold all that phase needs.
//
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) of the funding account (default /etc/ostra/deployer.key)
//   OSTRA_SERVICES_DIR        the services' directory (default /etc/ostra/robinhood): the bot's fee payer key in
//                             pad-evaluator/secrets (made by setup-pad-evaluator.ts; refused if missing), its data in
//                             pad-evaluator/data, its Raeto key in pad-evaluator/secrets/raeto.key
//   OSTRA_PAD_EVALUATOR_KEYS  the evaluator accounts' key files, comma-separated, as the service has them; each one's
//                             account must be among those recorded when the keys were made
//   OSTRA_PAD_EVALUATORS_RECORD  that record (default /etc/ostra/pad-evaluators.json)
//   OSTRA_RAETO_URL           Raeto's API (default https://api.raeto.cc)
//   OSTRA_PAD_FUND_ETH        ETH for the fee payer (default 0.005)
//   OSTRA_PAD_FUND_CREDITS    USDG of Raeto credits (default 10)
//
//   check   sends nothing: whether the funding account holds what both phases still need (exit 1 when it does not)
//
//   node scripts/fund-pad-evaluator.ts check|raeto|pool
// The last line is PAD_FUNDS_ENOUGH, PAD_FUNDED_RAETO or PAD_FUNDED_POOL.

import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, keccak256, parseEther, parseUnits, type Address, type Hash, type Hex, type PrivateKeyAccount, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { OSTRAPAD, PAD, USDG, assertRobinhoodChain, ostraPadAbi, readPadEvaluator, redact, retryingHttp, robinhoodChain } from "@ostraagent/sdk";
import { openFeePayer } from "../src/keys.ts";

/** Where Raeto takes USDG for credits, as core/src/raeto.ts pins it (read 25 Oct 2026). */
const RAETO_PAY_TO: Address = "0xF0Cc2FE5A90a3BB784De818f6E2061fd99c236Bf";
/** ETH the funding account keeps for its own sends' gas, beyond what it sends. */
const FUNDER_GAS_RESERVE = parseEther("0.0005");
const CREDIT_WAIT_MS = 15 * 60_000;

const secretsSeen: string[] = [];
const scrub = (text: string) => secretsSeen.reduce((t, s) => (s === "" ? t : redact(t, s).split(s).join("<secret>")), text);
const say = (line: string) => console.log(scrub(line));

async function privateText(path: string, what: string): Promise<string> {
  const mode = (await stat(path)).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${what} ${path} must be readable by its owner alone (it has mode ${mode.toString(8)})`);
  return (await readFile(path, "utf8")).split("\n")[0]!.trim();
}

async function keyAccount(path: string, what: string): Promise<PrivateKeyAccount> {
  const key = await privateText(path, what);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${path} is not a 0x-prefixed private key`);
  return privateKeyToAccount(key as Hex);
}

/** Each step's transaction, and the Raeto balance before the credits were sent ("raeto:before"). */
type Kept = Record<string, string>;

async function main(): Promise<void> {
  const phase = process.argv[2];
  if (phase !== "check" && phase !== "raeto" && phase !== "pool") throw new Error("usage: node scripts/fund-pad-evaluator.ts check|raeto|pool");
  const rpcUrl = await privateText(process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url", "the RPC URL file");
  secretsSeen.push(rpcUrl);
  const servicesDir = process.env.OSTRA_SERVICES_DIR || "/etc/ostra/robinhood";
  const secrets = join(servicesDir, "pad-evaluator", "secrets");
  const data = join(servicesDir, "pad-evaluator", "data");
  // The fee payer the service runs with: its key file must exist already (openFeePayer would make a new one).
  await stat(join(secrets, "fee-payer.key"));
  const feePayer = await openFeePayer(secrets);
  const funder = await keyAccount(process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key", "the funding key");
  const keyFiles = (process.env.OSTRA_PAD_EVALUATOR_KEYS || "").split(",").map((f) => f.trim()).filter((f) => f !== "");
  if (keyFiles.length === 0) throw new Error("OSTRA_PAD_EVALUATOR_KEYS names no key file");
  const evaluators = await Promise.all(keyFiles.map((f) => keyAccount(f, "the evaluator key")));
  if (new Set(evaluators.map((a) => a.address)).size !== evaluators.length) throw new Error("two evaluator key files hold the same account");
  const recordPath = process.env.OSTRA_PAD_EVALUATORS_RECORD || "/etc/ostra/pad-evaluators.json";
  const recorded = new Set((JSON.parse(await readFile(recordPath, "utf8")) as { address: string }[]).map((r) => getAddress(r.address)));
  for (const a of evaluators) if (!recorded.has(getAddress(a.address))) throw new Error(`${a.address} is not among the accounts recorded in ${recordPath}`);

  const transport: Transport = retryingHttp(rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
  await assertRobinhoodChain(client);
  const eth = (a: Address) => client.getBalance({ address: a });
  const usdg = (a: Address) => client.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
  const keptFile = join(data, "fund-pad-evaluator.json");
  let kept: Kept = {};
  try {
    kept = JSON.parse(await readFile(keptFile, "utf8")) as Kept;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const save = async () => {
    await writeFile(`${keptFile}.tmp`, JSON.stringify(kept, null, 1), { mode: 0o600 });
    await rename(`${keptFile}.tmp`, keptFile);
  };
  const record = async (step: string, value: string) => {
    kept[step] = value;
    await save();
  };
  // The record is written once before anything is sent: a directory it cannot be written to stops the run here.
  await save();

  /**
   * One step's transaction from `account`: estimated (which simulates it), signed here, and recorded (its hash and its
   * signed bytes) before it is sent. A step recorded is never signed again: its own signed transaction is sent again
   * if the chain does not know it (same nonce, so it lands at most once), then its receipt awaited.
   */
  const step = async (name: string, account: PrivateKeyAccount, tx: { to: Address; data?: Hex; value?: bigint }) => {
    let hash = kept[name] as Hash | undefined;
    let raw = kept[`${name}:raw`] as Hex | undefined;
    if (hash === undefined || raw === undefined) {
      const wallet = createWalletClient({ account, chain: robinhoodChain, transport });
      const gas = await client.estimateGas({ account: account.address, to: tx.to, data: tx.data, value: tx.value });
      const request = await wallet.prepareTransactionRequest({ account, chain: robinhoodChain, to: tx.to, data: tx.data, value: tx.value ?? 0n, gas: gas + gas / 5n });
      raw = await wallet.signTransaction(request as Parameters<typeof wallet.signTransaction>[0]);
      hash = keccak256(raw);
      kept[`${name}:raw`] = raw;
      await record(name, hash);
    }
    const known = await client.getTransaction({ hash }).then(() => true, () => false);
    if (!known) {
      try {
        await client.sendRawTransaction({ serializedTransaction: raw });
      } catch (err) {
        // Already known, or its nonce used by itself: the receipt below says which.
        say(`${name}: sending ${hash} again answered: ${((err as Error).message ?? String(err)).split("\n")[0]}`);
      }
    }
    const r = await client.waitForTransactionReceipt({ hash, timeout: 300_000 });
    if (r.status !== "success") throw new Error(`${name}: transaction ${hash} reverted`);
    say(`SENT ${name}: ${hash}`);
  };
  const transfer = (to: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });

  say(`funding account ${funder.address}: ETH ${formatEther(await eth(funder.address))} USDG ${formatUnits(await usdg(funder.address), 6)}`);
  say(`fee payer ${feePayer.address}: ETH ${formatEther(await eth(feePayer.address))} USDG ${formatUnits(await usdg(feePayer.address), 6)}`);

  const ethAmount = parseEther(process.env.OSTRA_PAD_FUND_ETH || "0.005");
  const credits = parseUnits(process.env.OSTRA_PAD_FUND_CREDITS || "10", 6);
  const bond = PAD.MIN_EVALUATOR_BOND;
  /** What the raeto phase still sends from the funding account. */
  const raetoNeeds = async () => {
    const feePayerUsdg = await usdg(feePayer.address);
    return {
      eth: kept["raeto:eth"] === undefined ? ethAmount : 0n,
      usdg: kept["raeto:credits"] === undefined && kept["raeto:usdg"] === undefined && feePayerUsdg < credits ? credits - feePayerUsdg : 0n,
    };
  };
  /** The evaluator accounts not in the pool, and the USDG each still needs from the funding account for its bond. */
  const poolNeeds = async () => {
    const out: { a: PrivateKeyAccount; need: bigint }[] = [];
    for (const a of evaluators) {
      const e = await readPadEvaluator(client, a.address);
      if (e.inPool) {
        say(`evaluator ${a.address}: in the pool already (bond ${formatUnits(e.bond, 6)})`);
        continue;
      }
      if (e.exitAt !== 0n || e.removed) throw new Error(`evaluator ${a.address} is leaving or was removed (exitAt ${e.exitAt}, removed ${e.removed}): not joined here`);
      const held = await usdg(a.address);
      out.push({ a, need: kept[`pool:usdg:${a.address}`] === undefined && held + e.bond < bond ? bond - held - e.bond : 0n });
    }
    return out;
  };

  if (phase === "check") {
    const r = await raetoNeeds();
    const poolUsdg = (await poolNeeds()).reduce((t, x) => t + x.need, 0n);
    const [fEth, fUsdg] = [await eth(funder.address), await usdg(funder.address)];
    const okEth = fEth >= r.eth + FUNDER_GAS_RESERVE;
    const okUsdg = fUsdg >= r.usdg + poolUsdg;
    say(`still needed from the funding account: ETH ${formatEther(r.eth)} (and ${formatEther(FUNDER_GAS_RESERVE)} for its gas), USDG ${formatUnits(r.usdg, 6)} for Raeto's credits and ${formatUnits(poolUsdg, 6)} for the bonds`);
    if (!okEth || !okUsdg) throw new Error(`the funding account ${funder.address} holds ETH ${formatEther(fEth)} and USDG ${formatUnits(fUsdg, 6)}: not enough; nothing was sent`);
    say("PAD_FUNDS_ENOUGH");
    return;
  }

  if (phase === "raeto") {
    const raeto = (process.env.OSTRA_RAETO_URL || "https://api.raeto.cc").replace(/\/+$/, "");
    const raetoKey = await privateText(join(secrets, "raeto.key"), "the Raeto key");
    secretsSeen.push(raetoKey);
    const call = async (path: string, key?: string): Promise<Record<string, unknown>> => {
      const res = await fetch(`${raeto}${path}`, { headers: { accept: "application/json", ...(key === undefined ? {} : { authorization: `Bearer ${key}` }) }, signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`Raeto answered ${res.status} to GET ${path}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as Record<string, unknown>;
    };
    const terms = (await call("/v1/agents")) as { chainId?: unknown; usdg?: { token?: unknown; payTo?: unknown } };
    if (terms.chainId !== 4663 || typeof terms.usdg?.payTo !== "string" || getAddress(terms.usdg.payTo) !== RAETO_PAY_TO || typeof terms.usdg.token !== "string" || getAddress(terms.usdg.token) !== USDG) {
      throw new Error(`Raeto's terms are not USDG on chain 4663 to ${RAETO_PAY_TO}: ${JSON.stringify(terms).slice(0, 300)}`);
    }
    const me = await call("/v1/me", raetoKey);
    if (typeof me.address !== "string" || getAddress(me.address) !== getAddress(feePayer.address)) throw new Error(`Raeto's account is not the fee payer's: ${JSON.stringify(me.address)}`);
    const balance = (m: Record<string, unknown>) => (typeof m.balance_usd === "number" ? m.balance_usd : Number.NaN);
    const before = balance(me);
    if (!Number.isFinite(before)) throw new Error(`Raeto's /v1/me has no balance_usd: ${JSON.stringify(me).slice(0, 300)}`);
    say(`Raeto account ${feePayer.address}: balance_usd ${before}`);

    // What this phase still sends, all checked against the funding account before the first send.
    const { eth: needEth, usdg: needUsdg } = await raetoNeeds();
    const [fEth, fUsdg] = [await eth(funder.address), await usdg(funder.address)];
    if (fEth < needEth + FUNDER_GAS_RESERVE || fUsdg < needUsdg) {
      throw new Error(`the funding account ${funder.address} holds ETH ${formatEther(fEth)} and USDG ${formatUnits(fUsdg, 6)}; this phase needs ETH ${formatEther(needEth)} (and ${formatEther(FUNDER_GAS_RESERVE)} for its gas) and USDG ${formatUnits(needUsdg, 6)}; nothing was sent`);
    }
    if (needEth > 0n) await step("raeto:eth", funder, { to: feePayer.address, value: needEth });
    if (needUsdg > 0n) await step("raeto:usdg", funder, { to: USDG, data: transfer(feePayer.address, needUsdg) });
    if (kept["raeto:credits"] === undefined && (await usdg(feePayer.address)) < credits) throw new Error(`the fee payer holds less than ${formatUnits(credits, 6)} USDG; nothing was sent to Raeto`);
    // The balance before the credits, kept once: a run again after they were sent waits for the same balance.
    if (kept["raeto:before"] === undefined) await record("raeto:before", String(before));
    await step("raeto:credits", feePayer, { to: USDG, data: transfer(RAETO_PAY_TO, credits) });

    // The credits, as Raeto shows them; once seen, kept (credits spent later lower the balance, and a run again does not wait).
    if (kept["raeto:shown"] === undefined) {
      const want = Number(kept["raeto:before"]) + Number(formatUnits(credits, 6)) * 0.99;
      const until = Date.now() + CREDIT_WAIT_MS;
      let now = before;
      while (now < want && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 20_000));
        now = balance(await call("/v1/me", raetoKey));
      }
      if (now < want) throw new Error(`Raeto's balance_usd is ${now} after 15 minutes, not ${want} or more; run this phase again to wait (nothing is sent twice)`);
      await record("raeto:shown", String(now));
    }
    say(`Raeto account ${feePayer.address}: credits shown (balance_usd ${kept["raeto:shown"]}), balance_usd now ${balance(await call("/v1/me", raetoKey))}`);
    say(`fee payer ${feePayer.address}: ETH ${formatEther(await eth(feePayer.address))} USDG ${formatUnits(await usdg(feePayer.address), 6)}`);
    say("PAD_FUNDED_RAETO");
    return;
  }

  // pool: every evaluator account not in the pool, its bond from the funding account.
  const out = await poolNeeds();
  const needUsdg = out.reduce((s, x) => s + x.need, 0n);
  const fUsdg = await usdg(funder.address);
  if (fUsdg < needUsdg) throw new Error(`the funding account ${funder.address} holds USDG ${formatUnits(fUsdg, 6)}; the pool's bonds need ${formatUnits(needUsdg, 6)}; nothing was sent`);
  if ((await eth(feePayer.address)) === 0n) throw new Error(`the fee payer ${feePayer.address} holds no ETH to top the evaluator accounts up (run the raeto phase first)`);
  for (const { a, need } of out) {
    if (need > 0n) await step(`pool:usdg:${a.address}`, funder, { to: USDG, data: transfer(a.address, need) });
  }
  // Each account's own sends: gas topped up from the fee payer as the keeper does (twice the call's maximum cost).
  const topUp = async (a: PrivateKeyAccount, data: Hex, to: Address) => {
    const gas = await client.estimateGas({ account: a.address, to, data, prepare: false } as Parameters<PublicClient["estimateGas"]>[0]);
    const { maxFeePerGas } = await client.estimateFeesPerGas({ chain: robinhoodChain, type: "eip1559" });
    const cost = (gas + gas / 5n) * maxFeePerGas;
    if ((await eth(a.address)) < cost) await step(`pool:gas:${a.address}:${kept[`pool:approve:${a.address}`] === undefined ? "approve" : "join"}`, feePayer, { to: a.address, value: cost * 2n });
  };
  for (const { a } of out) {
    const allowance = (await client.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [a.address, OSTRAPAD] })) as bigint;
    const e = await readPadEvaluator(client, a.address);
    if (allowance < bond - e.bond && kept[`pool:approve:${a.address}`] === undefined) {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OSTRAPAD, bond - e.bond] });
      await topUp(a, data, USDG);
      await step(`pool:approve:${a.address}`, a, { to: USDG, data });
    }
    if (!(await readPadEvaluator(client, a.address)).inPool) {
      const data = encodeFunctionData({ abi: ostraPadAbi, functionName: "joinPool", args: [a.address, bond - e.bond] });
      await client.simulateContract({ address: OSTRAPAD, abi: ostraPadAbi, functionName: "joinPool", args: [a.address, bond - e.bond], account: a });
      await topUp(a, data, OSTRAPAD);
      await step(`pool:join:${a.address}`, a, { to: OSTRAPAD, data });
    }
  }
  const size = (await client.readContract({ address: OSTRAPAD, abi: ostraPadAbi, functionName: "poolSize" })) as bigint;
  for (const a of evaluators) {
    const e = await readPadEvaluator(client, a.address);
    if (!e.inPool) throw new Error(`evaluator ${a.address} is not in the pool after this run`);
    say(`evaluator ${a.address}: in the pool, bond ${formatUnits(e.bond, 6)} USDG, counted for draws from ${new Date(Number(e.joinedAt) * 1000).toISOString()}, ETH ${formatEther(await eth(a.address))}`);
  }
  say(`OstraPad pool: ${size} members (draws need ${PAD.MIN_POOL_FOR_DRAW})`);
  say(`funding account ${funder.address}: ETH ${formatEther(await eth(funder.address))} USDG ${formatUnits(await usdg(funder.address), 6)}`);
  say(`fee payer ${feePayer.address}: ETH ${formatEther(await eth(feePayer.address))}`);
  say("PAD_FUNDED_POOL");
}

main().catch((err: unknown) => {
  console.error(scrub(`STOPPED: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
