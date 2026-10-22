// Ostra Swap through the MCP server as an agent runs it: spawned over stdio, on a fork of Robinhood Chain mainnet
// with Ostra and the launchpad deployed and Ostra Swap's contracts (OstraStake, OstraBuyback, OstraRouter,
// SpendVerifier, OstraPrivatePool) deployed from the ostra-swap Foundry build, without a relayer (the fee payer in
// OSTRA_HOME pays gas; private spends then carry no fee). Swaps between the agent's vaults as escrow orders (USDG to
// WETH and back, tokens named by symbol), a private note shielded from the vault, a private swap into a WETH note,
// an unshield of that note to a fresh address, refusals, and the notes found again by a second server on the same
// OSTRA_HOME, one without the prover refusing to spend, and one without OSTRA_PRIVATE_LOCAL_SPENDS refusing to spend
// without a relayer. The seed in a new OSTRA_HOME (as a restored backup) shields again the amount it first shielded:
// it finds its last shield nonce in the pool's events, so the note is new (a nonce used again would be refused as the
// same commitment). The pool index (Uniswap pools per pair) is searched once
// from Robinhood Chain's public RPC, as an agent's first swap does, and kept in OSTRA_HOME; the server searches the
// private pool's events on the fork (OSTRA_LOGS_RPC_URL). Needs ../../ostra-swap built (forge build; cd privacy &&
// cargo build --release --locked --bin ostra-prove) and anvil on PATH.

import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createPublicClient, formatUnits, getAddress, http, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { type Deployment } from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { OSTRA, OSTRA_PONS_CURVE, PONS_HOOK, PoolIndex, ROBINHOOD_PUBLIC_RPC, TREASURY, UNIVERSAL_ROUTER, USDG, WETH, erc20Abi, findRoute } from "@ostraagent/swap";

const SWAP_DIR = new URL("../../../ostra-swap/", import.meta.url);
const PROVER = fileURLToPath(new URL("privacy/target/release/ostra-prove", SWAP_DIR));
const RECIPIENT = getAddress("0x00000000000000000000000000000000000D0D1A");

let fork: Fork;
let d: Deployment;
let root: string;
let pool: Address;

function artifact(file: string, name: string): { abi: unknown[]; bytecode: Hex } {
  const a = JSON.parse(readFileSync(new URL(`out/${file}/${name}.json`, SWAP_DIR), "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
  return { abi: a.abi, bytecode: a.bytecode.object };
}

async function deploy(file: string, name: string, args: unknown[]): Promise<Address> {
  const a = artifact(file, name);
  const deployer = fork.accounts[0]!;
  const hash = await fork.wallet(deployer).deployContract({ account: deployer, chain: null, abi: a.abi, bytecode: a.bytecode, args, gas: 15_000_000n });
  const r = await fork.client.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `${name} deployed`);
  assert.ok(r.contractAddress);
  return getAddress(r.contractAddress);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-mcp-swap-"));
  fork = await startFork();
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  await writeFile(join(root, "deployment.json"), JSON.stringify(d));
  const deployer = fork.accounts[0]!.address;
  const stake = await deploy("OstraStake.sol", "OstraStake", [OSTRA]);
  const buyback = await deploy("OstraBuyback.sol", "OstraBuyback", [OSTRA, USDG, WETH, UNIVERSAL_ROUTER, OSTRA_PONS_CURVE, PONS_HOOK, deployer, deployer]);
  const router = await deploy("OstraRouter.sol", "OstraRouter", [UNIVERSAL_ROUTER, USDG, WETH, stake, buyback, TREASURY]);
  const spendVerifier = await deploy("SpendVerifier.sol", "SpendVerifier", []);
  const fromBlock = (await fork.client.getBlockNumber()) + 1n;
  pool = await deploy("OstraPrivatePool.sol", "OstraPrivatePool", [spendVerifier, router]);
  await writeFile(join(root, "swap.json"), JSON.stringify({ chainId: d.chainId, fromBlock: fromBlock.toString(), router, stake, buyback, spendVerifier, privatePool: pool }));
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function connect(home: string, o: { prover?: boolean; localSpends?: boolean } = {}): Promise<Client> {
  const prover = o.prover !== false;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [process.env.OSTRA_MCP_ENTRY ?? fileURLToPath(new URL("../src/server.ts", import.meta.url))],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      OSTRA_HOME: home,
      OSTRA_DEPLOYMENT: join(root, "deployment.json"),
      OSTRA_SWAP_DEPLOYMENT: join(root, "swap.json"),
      OSTRA_RPC_URL: fork.url,
      OSTRA_LOGS_RPC_URL: fork.url,
      OSTRA_RELAYER_URL: "off",
      OSTRA_KEEPER_URL: "off",
      OSTRA_AGGREGATOR_URL: "off",
      // No relayer here: the fee payer sends the private spends too (which links them to the agent).
      ...(o.localSpends !== false ? { OSTRA_PRIVATE_LOCAL_SPENDS: "yes" } : {}),
      ...(prover ? { OSTRA_PROVER: PROVER } : {}),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "ostra-mcp-swap-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

type Answer = { ok: boolean; text: string; json: Record<string, unknown> };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]?.text ?? "";
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { ok: r.isError !== true, text, json };
}

const balanceOf = (token: Address, who: Address) => fork.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

/** The pool index an agent's first swap of USDG and WETH builds, searched from the public RPC and kept where the server keeps it. */
async function keepPoolIndex(home: string): Promise<void> {
  const logsClient = createPublicClient({ transport: http(ROBINHOOD_PUBLIC_RPC, { retryCount: 6, retryDelay: 2_000 }) }) as PublicClient;
  const index = new PoolIndex();
  const client = createPublicClient({ transport: http(fork.url, { timeout: 180_000 }) }) as PublicClient;
  await findRoute({ client, logsClient, index, tokenIn: USDG, tokenOut: WETH, amountIn: parseUnits("100", 6), feeBps: 20, slippageBps: 100 });
  for (const dir of ["ostra-swap", "ostra-swap-private"]) {
    await mkdir(join(home, dir), { recursive: true, mode: 0o700 });
    await writeFile(join(home, dir, "pool-index.json"), JSON.stringify(index.data()), { mode: 0o600 });
  }
}

test("Ostra Swap over MCP: vault swaps by escrow order, a private note shielded, swapped and unshielded, refusals", { timeout: 1_800_000 }, async () => {
  const home = join(root, "home");
  const client = await connect(home);
  let usdgNote: string;
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const name of ["ostra_swap_quote", "ostra_swap", "private_shield", "private_balance", "private_swap", "private_unshield"]) assert.ok(tools.includes(name), `tool ${name}`);

    const status = (await call(client, "balance")).json.vault as { feePayer: Address };
    await fork.setBalance(status.feePayer, 10n ** 19n);
    const opened = await call(client, "open_vault");
    assert.ok(opened.ok, opened.text);
    const vault = getAddress(opened.json.vault as string);
    await fork.dealUsdg(vault, parseUnits("1000", 6));
    await keepPoolIndex(home);

    // Refused before anything is signed: an unknown symbol, the same token twice, a token no Ostra vault swaps.
    const unknown = await call(client, "ostra_swap_quote", { tokenIn: "USDG", tokenOut: "DOGE", amount: "1" });
    assert.ok(!unknown.ok && /^invalid_input: DOGE is not a symbol/.test(unknown.text), unknown.text);
    const same = await call(client, "ostra_swap_quote", { tokenIn: "ETH", tokenOut: WETH, amount: "1" });
    assert.ok(!same.ok && /the same/.test(same.text), same.text);
    const stray = await call(client, "ostra_swap", { tokenIn: "USDG", tokenOut: RECIPIENT, amount: "1" });
    assert.ok(!stray.ok && /not a token an Ostra vault swaps/.test(stray.text), stray.text);
    const tooMuch = await call(client, "ostra_swap", { tokenIn: "USDG", tokenOut: "ETH", amount: "5000" });
    assert.ok(!tooMuch.ok && /less than 5000; nothing was signed/.test(tooMuch.text), tooMuch.text);

    // USDG to WETH: the quote, then the swap into the agent's WETH vault.
    const quote = await call(client, "ostra_swap_quote", { tokenIn: "usdg", tokenOut: "ETH", amount: "100" });
    assert.ok(quote.ok && Number(quote.json.expectedOut) > 0 && Number(quote.json.minOut) > 0 && Number(quote.json.minOut) <= Number(quote.json.expectedOut), quote.text);
    assert.equal(getAddress(quote.json.from as string), vault);
    const wethVault = getAddress(quote.json.to as string);
    const swapped = await call(client, "ostra_swap", { tokenIn: "USDG", tokenOut: "ETH", amount: "100" });
    assert.ok(swapped.ok && swapped.json.status === "sent" && swapped.json.swapped === true, swapped.text);
    const wethOut = parseUnits(swapped.json.amountOut as string, 18);
    assert.ok(wethOut >= parseUnits(swapped.json.minOut as string, 18) && wethOut > 0n, swapped.text);
    assert.equal(await balanceOf(WETH, wethVault), wethOut);
    assert.equal(await balanceOf(USDG, vault), parseUnits("900", 6));

    // Half of it back to USDG, from the WETH vault (opened by the swap that paid it).
    const half = wethOut / 2n;
    const back = await call(client, "ostra_swap", { tokenIn: "WETH", tokenOut: "USDG", amount: formatUnits(half, 18) });
    assert.ok(back.ok && back.json.status === "sent" && back.json.swapped === true && Number(back.json.amountOut) > 0, back.text);
    assert.ok((await balanceOf(USDG, vault)) > parseUnits("900", 6));
    const orders = (await readdir(join(home, "ostra-swap"))).filter((n) => n.startsWith("order-"));
    assert.deepEqual(orders, [], "every order finished");

    // A private note: 200 USDG shielded from the vault.
    const notToken = await call(client, "private_shield", { token: RECIPIENT, amount: "1" });
    assert.ok(!notToken.ok && /not a token private notes hold/.test(notToken.text), notToken.text);
    const usdgBefore = await balanceOf(USDG, vault);
    const shielded = await call(client, "private_shield", { token: "USDG", amount: "200" });
    assert.ok(shielded.ok && shielded.json.status === "sent" && shielded.json.amount === "200", shielded.text);
    assert.equal(await balanceOf(USDG, pool), parseUnits("200", 6));
    assert.equal(await balanceOf(USDG, vault), usdgBefore - parseUnits("200", 6));
    const b1 = await call(client, "private_balance");
    assert.ok(b1.ok, b1.text);
    assert.deepEqual(b1.json.tokens, [{ token: getAddress(USDG), amount: "200", notes: 1, largestNote: "200" }]);

    // A private swap of 50 USDG into a WETH note; the change (150) stays a note.
    const tooBig = await call(client, "private_swap", { tokenIn: "USDG", tokenOut: "ETH", amount: "500" });
    assert.ok(!tooBig.ok && /no private note .* holds 500/.test(tooBig.text), tooBig.text);
    const pswap = await call(client, "private_swap", { tokenIn: "USDG", tokenOut: "ETH", amount: "50" });
    assert.ok(pswap.ok && pswap.json.status === "sent" && pswap.json.change === "150" && pswap.json.fee === "0" && Number(pswap.json.amountOut) > 0, pswap.text);
    const b2 = (await call(client, "private_balance")).json.tokens as { token: string; amount: string; notes: number }[];
    const wethNote = b2.find((t) => t.token === getAddress(WETH));
    assert.deepEqual(b2.find((t) => t.token === getAddress(USDG)), { token: getAddress(USDG), amount: "150", notes: 1, largestNote: "150" });
    assert.ok(wethNote !== undefined && wethNote.amount === pswap.json.amountOut && wethNote.notes === 1, JSON.stringify(b2));
    assert.equal(await balanceOf(WETH, pool), parseUnits(wethNote.amount, 18));

    // The whole WETH note to a fresh address: no change note is left.
    const out = await call(client, "private_unshield", { token: "ETH", amount: wethNote.amount, destination: RECIPIENT });
    assert.ok(out.ok && out.json.status === "sent" && out.json.change === "0", out.text);
    assert.equal(await balanceOf(WETH, RECIPIENT), parseUnits(wethNote.amount, 18));
    assert.equal(await balanceOf(WETH, pool), 0n);
    const b3 = (await call(client, "private_balance")).json.tokens as unknown[];
    assert.deepEqual(b3, [{ token: getAddress(USDG), amount: "150", notes: 1, largestNote: "150" }]);
    usdgNote = "150";
  } finally {
    await client.close();
  }

  // The same OSTRA_HOME without the prover: the notes are there; a spend is refused before anything is signed.
  const again = await connect(home, { prover: false });
  try {
    const b = await call(again, "private_balance");
    assert.ok(b.ok, b.text);
    assert.deepEqual(b.json.tokens, [{ token: getAddress(USDG), amount: usdgNote, notes: 1, largestNote: usdgNote }]);
    const refused = await call(again, "private_unshield", { token: "USDG", amount: "1" });
    assert.ok(!refused.ok && /ostra-prove\) is not installed/.test(refused.text), refused.text);
  } finally {
    await again.close();
  }

  // Without a relayer and without OSTRA_PRIVATE_LOCAL_SPENDS: a spend is refused, a shield is not.
  const linked = await connect(home, { localSpends: false });
  try {
    const refused = await call(linked, "private_swap", { tokenIn: "USDG", tokenOut: "ETH", amount: "1" });
    assert.ok(!refused.ok && /goes through the Ostra relayer/.test(refused.text), refused.text);
  } finally {
    await linked.close();
  }

  // The seed alone in a new OSTRA_HOME: the same vault; a shield of the same 200 USDG takes the next nonce.
  const restored = join(root, "restored");
  await mkdir(restored, { mode: 0o700 });
  for (const f of ["master.key", "fee-payer.key"]) await copyFile(join(home, f), join(restored, f));
  const fresh = await connect(restored);
  try {
    const opened = await call(fresh, "open_vault");
    assert.ok(opened.ok && opened.json.created === false, opened.text);
    const poolBefore = await balanceOf(USDG, pool);
    const shielded = await call(fresh, "private_shield", { token: "USDG", amount: "200" });
    assert.ok(shielded.ok && shielded.json.status === "sent" && shielded.json.amount === "200", shielded.text);
    assert.equal(await balanceOf(USDG, pool), poolBefore + parseUnits("200", 6));
  } finally {
    await fresh.close();
  }
});
