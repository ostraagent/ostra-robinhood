// The payment wallet end to end on a fork of Robinhood Chain mainnet with Ostra's live deployment at version 5, the
// keeper and the relayer set up as on mainnet (relayer/scripts/setup-mainnet.ts), two MCP servers (a vault's owner and
// its agent, OSTRA_AGENT_OF) and a seller answering 402 with an x402 exact offer in USDG shaped as Autonomo's gateways
// name it (scheme exact on eip155:4663, USDG, maxTimeoutSeconds 300, extra Global Dollar version 1), which settles the
// payment itself with USDG's transferWithAuthorization on the fork, as a facilitator does. The owner sets the wallet up
// (a first top-up of 1 USDG) and pays; a price above maxPrice is refused before anything is signed; the vault's withdraw
// refuses the wallet as its destination; the agent's own wallet (its seed's) is topped up by the agent key once the
// owner puts it on the recipient allowlist (payment_wallet_setup with agentWallet), and pays; each wallet sends what
// is left back to the vault through the relayer (its rule for a transferWithAuthorization into the vault that pays for
// it). Needs anvil on PATH.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createWalletClient, getAddress, http, parseEventLogs, parseSignature, parseUnits, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { checkDeployment, robinhoodChain, usdgAbi, USDG } from "@ostraagent/sdk";
import { liveAtV5, startFork, vaultBeaconAtRecord, type Fork } from "@ostraagent/sdk/test/fork";
import { setupMainnet } from "../../relayer/scripts/setup-mainnet.ts";
import { Agent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const LIVE_DEPLOYMENT = here("../../deployments/robinhood-mainnet.json");
const RELAYER = here("../../relayer/src/server.ts");
const KEEPER = here("../../keeper/src/main.ts");
/** The seller's payTo: an address with no code on Robinhood Chain. */
const PAY_TO = getAddress("0x00000000000000000000000000000000000C0D71");
const PRICE = 10_000n;

let fork: Fork;
let dir: string;
let seller: Server | undefined;
const children: ChildProcess[] = [];

before(async () => {
  fork = await startFork();
  dir = mkdtempSync(join(tmpdir(), "ostra-payment-wallet-"));
});

after(async () => {
  for (const c of children) c.kill();
  await new Promise<void>((resolve) => (seller === undefined ? resolve() : seller.close(() => resolve())));
  await fork?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue;
    const at = line.indexOf("=");
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${url} did not answer within 60 s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as Record<string, unknown>;

type Authorization = { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };

/**
 * A seller on the fork: 402 with the exact offer, then for a PAYMENT-SIGNATURE header the payment settled by its own
 * account (transferWithAuthorization, v, r, s) before it answers 200 with PAYMENT-RESPONSE. `settled` lists what it settled.
 */
async function startSeller(account: PrivateKeyAccount): Promise<{ url: string; settled: Authorization[] }> {
  const settled: Authorization[] = [];
  const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(fork.url) });
  const offer = { scheme: "exact", network: "eip155:4663", amount: PRICE.toString(), asset: USDG, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "Global Dollar", version: "1" } };
  seller = createServer(async (req, res) => {
    const url = `http://${req.headers.host}${req.url}`;
    const header = req.headers["payment-signature"];
    if (typeof header !== "string") {
      res.writeHead(402, { "content-type": "application/json", "payment-required": b64({ x402Version: 2, error: "Payment required", resource: { url, description: "token price", mimeType: "application/json" }, accepts: [offer] }) });
      res.end("{}");
      return;
    }
    try {
      const payload = unb64(header) as { x402Version: number; accepted: typeof offer; payload: { authorization: Authorization; signature: Hex } };
      assert.equal(payload.x402Version, 2);
      assert.deepEqual(payload.accepted, offer);
      const a = payload.payload.authorization;
      assert.equal(getAddress(a.to), PAY_TO);
      assert.equal(a.value, PRICE.toString());
      const s = parseSignature(payload.payload.signature);
      const v = s.v !== undefined ? Number(s.v) : s.yParity + 27;
      const hash = await wallet.writeContract({
        address: USDG,
        abi: usdgAbi,
        functionName: "transferWithAuthorization",
        args: [getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, v, s.r, s.s],
      });
      assert.equal((await fork.client.waitForTransactionReceipt({ hash })).status, "success");
      settled.push(a);
      res.writeHead(200, { "content-type": "application/json", "payment-response": b64({ success: true, transaction: hash, network: "eip155:4663", payer: a.from }) });
      res.end(JSON.stringify({ symbol: "AUTONOMO", priceUsd: "0.01" }));
    } catch (err) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  await new Promise<void>((resolve) => seller!.listen(port, "127.0.0.1", () => resolve()));
  return { url: `http://127.0.0.1:${port}/x/token-price/price/autonomo`, settled };
}

test("the payment wallet: set up, an exact payment, the agent key's top-up and payment, withdrawals through the relayer", { timeout: 1_800_000 }, async () => {
  const d = await liveAtV5(fork, LIVE_DEPLOYMENT);
  const record = join(dir, "robinhood-v5.json");
  writeFileSync(record, `${JSON.stringify(d, null, 2)}\n`);
  assert.equal(await vaultBeaconAtRecord(fork, d), "upgraded on the fork as scheduled");
  await checkDeployment(fork.client, d);
  const base = join(dir, "robinhood");
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const listen = { keeper: `127.0.0.1:${port}`, relayer: `127.0.0.1:${port + 1}`, aggregator: `127.0.0.1:${port + 2}`, rpcProxy: `127.0.0.1:${port + 3}` };
  const setup = await setupMainnet({ base, deploymentPath: record, deployer: fork.accounts[0] as PrivateKeyAccount, rpcUrl: fork.url, log: () => {}, listen });
  await fork.setBalance(setup.relayerAccount, 10n ** 18n);
  const logs = { keeper: join(dir, "keeper.log"), relayer: join(dir, "relayer.log") };
  const tails = () => Object.entries(logs).map(([n, f]) => `--- ${n}\n${readFileSync(f, "utf8").slice(-4_000)}`).join("\n");
  const start = (script: string, envFile: string, logFile: string, extra: Record<string, string> = {}) => {
    const out = openSync(logFile, "a");
    children.push(spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...readEnv(join(base, envFile)), ...extra }, stdio: ["ignore", out, out] }));
  };
  start(KEEPER, "keeper.env", logs.keeper);
  await waitFor(`http://${listen.keeper}/v1/health`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));
  start(RELAYER, "relayer.env", logs.relayer, { OSTRA_RELAYER_CLIENT_IP: "socket" });
  await waitFor(`http://${listen.relayer}/v1/relayer`).catch((err: unknown) => assert.fail(`${String(err)}\n${tails()}`));

  const sellerAccount = fork.accounts[3] as PrivateKeyAccount;
  await fork.setBalance(sellerAccount.address, 10n ** 18n);
  const shop = await startSeller(sellerAccount);

  const open = async (name: string, agentOf?: Address) => {
    const home = join(dir, name);
    await mkdir(home, { recursive: true, mode: 0o700 });
    return Agent.open(
      await loadConfig({
        OSTRA_HOME: home,
        OSTRA_DEPLOYMENT: record,
        OSTRA_RPC_URL: fork.url,
        OSTRA_LOGS_RPC_URL: fork.url,
        OSTRA_RELAYER_URL: `http://${listen.relayer}`,
        OSTRA_KEEPER_URL: "off",
        OSTRA_AGGREGATOR_URL: "off",
        OSTRA_ETH_RPC_URL: "off",
        OSTRA_RAETO_URL: "off",
        OSTRA_PAD_INDEXER_URL: "off",
        ...(agentOf === undefined ? {} : { OSTRA_AGENT_OF: agentOf }),
      }),
      () => {},
    );
  };
  const usdg = async (who: Address) => (await fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] })) as bigint;

  const owner = await open("owner");
  const vault = getAddress((await owner.buyer.open()).vault);
  await fork.dealUsdg(vault, parseUnits("40", 6));
  assert.equal((await owner.v5.status()).version, 5);

  // Without a wallet set up: refused, nothing paid.
  await assert.rejects(owner.payments.pay({ url: shop.url, maxPrice: "0.02" }), /payment_wallet_setup/);
  assert.equal(shop.settled.length, 0);

  // Set up as the owner: 1 USDG from the vault (an owner's Transfer needs no allowlist).
  const set = await owner.paymentWallet.setup();
  const wallet = set.address;
  assert.equal(set.created, true);
  assert.equal(set.allowlist, undefined, JSON.stringify(set));
  assert.equal(set.toppedUp?.amount, "1", JSON.stringify(set));
  assert.equal(await usdg(wallet), parseUnits("1", 6));
  // Called again: nothing more is signed (1 USDG is free).
  const again = await owner.paymentWallet.setup();
  assert.equal(again.created, false);
  assert.equal(again.toppedUp, undefined);
  // Refused before anything is signed: above the wallet's limit, its own wallet given as an agent's.
  await assert.rejects(owner.paymentWallet.setup("4.5"), /above its limit/);
  await assert.rejects(owner.paymentWallet.setup("0", wallet), /this server's own wallet/);

  // A price above maxPrice: refused before anything is signed.
  await assert.rejects(owner.payments.pay({ url: shop.url, maxPrice: "0.005" }), /more than maxPrice/);
  assert.equal(shop.settled.length, 0);

  // Paid from the wallet.
  const paid = await owner.payments.pay({ url: shop.url, maxPrice: "0.02" });
  assert.equal(paid.status, 200, JSON.stringify(paid));
  assert.equal(paid.paid, "0.01");
  assert.deepEqual(paid.wallet, { address: wallet, left: "0.99" });
  assert.equal(JSON.parse(paid.body).symbol, "AUTONOMO");
  assert.equal(await usdg(PAY_TO), PRICE);
  assert.equal(shop.settled.length, 1);
  const st = await owner.paymentWallet.status();
  assert.equal(st.balance, "0.99");
  assert.equal(st.reserved, "0", "a settled authorization holds nothing");
  assert.equal(st.recent.length, 1);
  assert.match(st.recent[0]!.transaction ?? "", /^0x[0-9a-f]{64}$/);

  // The agent: its own wallet (another seed), topped up by the agent key once the owner allowlists it.
  const agent = await open("agent", vault);
  const request = await agent.agentKey!.request();
  const facts = await owner.relayer!.facts();
  assert.equal((await owner.v5.setPolicy({ actions: ["transfer", "open_channel"], perTx: "5", daily: "20" })).status, "sent");
  assert.equal((await owner.v5.setAllow("channel", facts.split, true)).status, "sent");
  assert.equal((await owner.v5.setAgentKey(request.root, 30)).status, "sent");
  const agentWallet = await agent.paymentWallet.address();
  assert.notEqual(agentWallet, wallet, "one wallet per seed");
  const pending = await agent.paymentWallet.setup();
  assert.equal(pending.toppedUp, undefined);
  assert.equal(pending.agentTopUp?.allowlisted, false);
  assert.equal(pending.agentTopUp?.transferAllowed, true);
  assert.match(pending.note ?? "", new RegExp(`payment_wallet_setup with agentWallet ${agentWallet} on the owner's server`));
  await assert.rejects(agent.paymentWallet.setup("0", wallet), /from the owner's server/);
  await assert.rejects(agent.payments.pay({ url: shop.url, maxPrice: "0.02" }), /was not topped up from the vault.*allowlist/);
  assert.equal(shop.settled.length, 1);
  // The owner puts the agent's wallet on the allowlist (no top-up of its own wallet: amount 0).
  const listed = await owner.paymentWallet.setup("0", agentWallet);
  assert.equal(listed.allowlist?.status, "sent", JSON.stringify(listed));
  assert.equal(listed.toppedUp, undefined);
  assert.equal((await owner.v5.status()).allowlist.some((e) => e.kind === "recipient" && e.inForce && getAddress(`0x${e.value.slice(-40)}`) === agentWallet), true);
  assert.equal((await owner.v5.status()).allowlist.some((e) => e.kind === "recipient" && getAddress(`0x${e.value.slice(-40)}`) === wallet), false, "the owner's own wallet is never allowlisted");
  assert.equal((await owner.paymentWallet.setup("0", agentWallet)).allowlist?.status, "listed", "nothing more is signed for an entry already there");
  assert.equal((await agent.paymentWallet.status()).agentTopUp?.allowlisted, true);
  const agentPaid = await agent.payments.pay({ url: shop.url, maxPrice: "0.02" });
  assert.equal(agentPaid.status, 200, `${JSON.stringify(agentPaid)}\n${tails()}`);
  assert.equal(agentPaid.paid, "0.01");
  assert.match(agentPaid.note ?? "", /topped up with 1 USDG from the vault/);
  assert.deepEqual(agentPaid.wallet, { address: agentWallet, left: "0.99" });
  assert.equal(await usdg(PAY_TO), 2n * PRICE);

  // What is left goes back to the vault through the relayer, paid from the vault's relayer channel.
  const back = await agent.paymentWallet.withdraw();
  assert.equal(back.status, "sent", `${JSON.stringify(back)}\n${tails()}`);
  assert.equal(back.amount, "0.99");
  assert.equal(await usdg(agentWallet), 0n);
  assert.deepEqual(await moved(back.txHash), [{ from: agentWallet, to: vault, value: parseUnits("0.99", 6) }]);
  const ownerBack = await owner.paymentWallet.withdraw("0.5");
  assert.equal(ownerBack.status, "sent", `${JSON.stringify(ownerBack)}\n${tails()}`);
  assert.equal(ownerBack.left, "0.49");
  assert.deepEqual(await moved(ownerBack.txHash), [{ from: wallet, to: vault, value: parseUnits("0.5", 6) }]);
  await assert.rejects(owner.paymentWallet.withdraw("1"), /less than 1/);
});

/** The USDG transfers in transaction `hash`. */
async function moved(hash: Hex): Promise<{ from: Address; to: Address; value: bigint }[]> {
  const receipt = await fork.client.getTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  const logs = parseEventLogs({ abi: usdgAbi, eventName: "Transfer", logs: receipt.logs }).filter((l) => getAddress(l.address) === USDG);
  return logs.map((l) => ({ from: getAddress(l.args.from), to: getAddress(l.args.to), value: l.args.value }));
}
