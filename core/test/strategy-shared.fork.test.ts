// The planner where several agents meet and an NVDA carry, on its own fork of Robinhood Chain mainnet at block
// 95,228,009 (as strategy-pinned.fork.test.ts: Thursday 22 Oct 2026 15:50:00 UTC, the NYSE open, before Steakhouse
// USDG's curator submitted the caps of a new mGLO market). A fork of an older block needs an archive RPC as
// OSTRA_FORK_RPC. Ostra and its launchpad are deployed fresh; Borro's live NVDA market, Steakhouse USDG, Morpho Blue
// and the ERC-8004 Identity Registry are the deployed ones; USDe's price is Chainlink's on Ethereum as it was at the fork
// block's time (OSTRA_ETH_RPC, which must serve Ethereum's old state: eth-at.ts):
//   * shared capacity: one agent lends Steakhouse all but 500 USDG of the room Ostra vaults have there (5% of what it
//     can pay out, read here); a second agent then lends only what the room left, its USDG over the plan's keep
//     staying in its vault, and all Ostra vaults together hold at most 5% of what Steakhouse can pay out;
//   * an NVDA carry: planned at NVDA's opening level, 45% of the LLTV (within the vault's half-LLTV cap, the room
//     under 90% use and the market's liquidity, each read here), applied after its delay; a real borrower takes the
//     NVDA market to 99% use: the check calls for what the 90% rung asks; then, as the rate climbs over days at that
//     use (the IRM's rate at target adapts upward), a check whose two runs' rates average above the cash yield less 1
//     point closes the carry for its rate, and its plan repays the whole debt (USDG redeemed from the cash vault for it).
// Each part runs on a fork of its own, started for it: the NVDA part moves the clock days on, which no other test must
// see, and the shared-capacity part fills the room Ostra vaults have in Steakhouse, which the NVDA carry lends into.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createWalletClient, getAddress, http, keccak256, parseAbi, stringToHex, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BORRO_BUILDERS,
  BORRO_CODE,
  CASH_VAULTS,
  FileWotsStore,
  MORPHO_BLUE,
  OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS,
  STEAKHOUSE_USDG,
  USDG,
  borroStock,
  halfLltvMaxDebt,
  readBorroPosition,
  readVaultGuard,
  readVaultV2,
  retryingHttp,
  robinhoodChain,
  usdgAbi,
  vaultV2Abi,
  withdrawableNow,
  type Deployment,
} from "@ostraagent/sdk";
import { deployLaunchpadOnFork, deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import {
  BorroService,
  CARRY_MAX_UTILIZATION,
  JITTER_MAX_SECONDS,
  Keys,
  LAUNCHPAD_DIR,
  LaunchpadService,
  LocalSender,
  StrategyService,
  VaultService,
  WAD,
  X402_NETWORK,
  type Config,
} from "../src/index.ts";
import { MemoryFolder } from "./memory-folder.ts";
import { ethClientAt } from "./eth-at.ts";
import { splitLogsClient } from "./split-logs.ts";

const PINNED_BLOCK = 95_228_009n;
const forkRpc = process.env.OSTRA_FORK_RPC;
const ethRpc = process.env.OSTRA_ETH_RPC;
const skip =
  forkRpc === undefined || forkRpc === ""
    ? "needs an archive RPC as OSTRA_FORK_RPC (the fork is at block 95,228,009)"
    : ethRpc === undefined || ethRpc === ""
      ? "needs OSTRA_ETH_RPC (Chainlink USDe / USD on Ethereum, with its old state)"
      : false;

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
const forkBlock = PINNED_BLOCK;
const chainGasPrice = async () => (await fork.client.getBlock({ blockNumber: forkBlock })).baseFeePerGas as bigint;

const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/STRATEGY-SHARED-FORK/fee-payer")));
const morphoAbi = parseAbi([
  "function supplyCollateral((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, address onBehalf, bytes data)",
  "function borrow((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
]);
const vaultIn = parseAbi(["function deposit(uint256 assets, address onBehalf) returns (uint256)", "function convertToAssets(uint256 shares) view returns (uint256)"]);
const erc20 = parseAbi(["function approve(address, uint256) returns (bool)"]);
const buildersAbi = parseAbi(["function register(bytes32 code)", "function builders(bytes32 code) view returns (address)"]);
const BORRO_CODE_REGISTRANT: Address = "0x3D8a0670D278C125966f884DC66beA34944A4220";

async function anvil(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(fork.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const send = async (hash: `0x${string}`) => assert.equal((await fork.client.waitForTransactionReceipt({ hash })).status, "success");

/** A new fork at the pinned block (the one before it stopped), with Ostra and its launchpad deployed and Ostra's Borro code registered. */
async function freshFork() {
  await fork?.stop();
  root ??= await mkdtemp(join(tmpdir(), "ostra-core-strategy-shared-"));
  fork = await startFork({ blockNumber: PINNED_BLOCK });
  d = await deployLaunchpadOnFork(fork, await deployOnFork(fork));
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
  // Ostra's Borro builder code was registered on mainnet after this block (strategy-pinned.fork.test.ts): the same
  // registration, from the same account, or every Lend of a stock through BorroBuilders reverts NotRegistered.
  await anvil("anvil_impersonateAccount", [BORRO_CODE_REGISTRANT]);
  await fork.setBalance(BORRO_CODE_REGISTRANT, 10n ** 18n);
  const w = createWalletClient({ account: BORRO_CODE_REGISTRANT, chain: robinhoodChain, transport: http(fork.url) });
  await send(await w.writeContract({ address: BORRO_BUILDERS, abi: buildersAbi, functionName: "register", args: [BORRO_CODE], account: BORRO_CODE_REGISTRANT, chain: robinhoodChain }));
  await anvil("anvil_stopImpersonatingAccount", [BORRO_CODE_REGISTRANT]);
}

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** A registered agent: its seed and records, its vaults, Borro, the launchpad and the planner (with USDe's price). */
async function agent(name: string, seed: number) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const eth = (await ethClientAt(ethRpc as string, (await client.getBlock({ blockNumber: forkBlock })).timestamp)).client;
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder: new MemoryFolder(), backupExported: async () => true });
  const creatorKeys = await keys.forCreatorVault(d.chainId, USDG);
  const sender = new LocalSender(client, transport, feePayer);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const creator = new VaultService(client, transport, config, creatorKeys, sender, "creator");
  const tokenVaults = new Map<Address, VaultService>();
  const tokenVault = (token: Address) => {
    let v = tokenVaults.get(token);
    if (v === undefined) {
      v = new VaultService(client, transport, config, keys, sender, "token", null, token);
      tokenVaults.set(token, v);
    }
    return v;
  };
  const ownVaults = async () => [await buyer.vaultAddress(), ...(await Promise.all([...tokenVaults.values()].map((v) => v.vaultAddress())))];
  const borro = new BorroService({ client, config, buyer, tokenVault, sender, ownVaults, gasPrice: chainGasPrice });
  const lp = new LaunchpadService({ client, transport, config, keys, buyer, buyerSender: sender, creator, creatorSender: sender });
  const agentId = async () => {
    const t = await keys.folder.folder(LAUNCHPAD_DIR).read("agent.json");
    return t === undefined ? null : (JSON.parse(t) as { agentId: string }).agentId;
  };
  const s = new StrategyService({ client, logsClient: splitLogsClient(fork.url, forkBlock), config, buyer, tokenVault, creator, borro, folder: keys.folder.folder("strategy"), agentId, ethClient: eth });
  const usdgVault = (await buyer.open()).vault;
  // The 5 USDG the creator vault is funded with for the registration, dealt to the USDG vault first: it holds 0 after.
  await fork.dealUsdg(usdgVault, 5_000_000n);
  await lp.fundCreatorVault("5");
  assert.equal(await usdg(usdgVault), 0n);
  assert.equal((await lp.registerAgent("ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy")).status, "sent");
  return { client, buyer, usdgVault, tokenVault, s };
}

const usdg = (who: Address) => fork.client.readContract({ address: USDG, abi: usdgAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
const sharesOf = (vault: Address, who: Address) => fork.client.readContract({ address: vault, abi: vaultV2Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

/** What Steakhouse USDG can pay out now and what the given vaults hold there, read here (sdk readVaultV2, withdrawableNow). */
async function steakhouse(holders: Address[]): Promise<{ withdrawable: bigint; held: bigint }> {
  const v = await readVaultV2(fork.client as PublicClient, STEAKHOUSE_USDG);
  let shares = 0n;
  for (const h of holders) shares += await sharesOf(STEAKHOUSE_USDG, h);
  const held = shares === 0n ? 0n : ((await fork.client.readContract({ address: STEAKHOUSE_USDG, abi: vaultV2Abi, functionName: "convertToAssets", args: [shares] })) as bigint);
  return { withdrawable: withdrawableNow(v), held };
}

/** Applies plan `id`: its random delay waited out on the fork's clock when it has one. */
async function applyNow(s: StrategyService, id: string) {
  const first = await s.apply(id);
  if (first.next === null) return first;
  assert.deepEqual(first.done.filter((x) => !x.landed), []);
  await fork.increaseTime(JITTER_MAX_SECONDS + 1);
  return s.apply(id);
}

test("shared capacity: a second agent lends only the room the first left in Steakhouse USDG", { timeout: 2_400_000, skip }, async () => {
  assert.ok(CASH_VAULTS.includes(STEAKHOUSE_USDG));
  await freshFork();
  const keep = 100_000_000n;
  const a = await agent("first", 61);
  // The room Ostra vaults have there now, read here: 5% of what it can pay out (nothing of Ostra's is in it yet on this fork).
  const s0 = await steakhouse([a.usdgVault]);
  assert.equal(s0.held, 0n);
  const room0 = (s0.withdrawable * OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS) / 10_000n;
  assert.ok(room0 > 1_000_000_000n, `Steakhouse's room for Ostra is ${room0}`);
  await fork.dealUsdg(a.usdgVault, keep + room0 - 500_000_000n);
  const pa = (await a.s.plan({ buffer: keep })).find((p) => p.profile === "conservative")!;
  assert.deepEqual(pa.steps.map((x) => [x.kind, x.vault, x.amount]), [["lend_cash", STEAKHOUSE_USDG, "free"]], JSON.stringify(pa));
  const ra = await applyNow(a.s, pa.id);
  assert.equal(ra.next, null, JSON.stringify(ra));
  assert.equal(await usdg(a.usdgVault), keep, "the first agent lent everything over its keep: the room held it");

  // The second agent: 1,000 USDG more than the room left (read here; the first agent's deposit may have raised what
  // Steakhouse can pay out, and with it the room).
  const b = await agent("second", 62);
  const s1 = await steakhouse([a.usdgVault, b.usdgVault]);
  const left = (s1.withdrawable * OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS) / 10_000n - s1.held;
  assert.ok(left > 0n, `room left ${left}`);
  const dealt = keep + left + 1_000_000_000n;
  await fork.dealUsdg(b.usdgVault, dealt);
  const pb = (await b.s.plan({ buffer: keep })).find((p) => p.profile === "conservative")!;
  assert.deepEqual(pb.steps.map((x) => [x.kind, x.vault, x.amount]), [["lend_cash", STEAKHOUSE_USDG, "free"]], JSON.stringify(pb));
  const rb = await applyNow(b.s, pb.id);
  assert.equal(rb.next, null, JSON.stringify(rb));
  // It lent the room left (within 0.1%: the delay's interest moves it a little), and kept the rest over its keep.
  const lentB = dealt - (await usdg(b.usdgVault));
  assert.ok(lentB * 1_000n >= left * 999n && lentB * 1_000n <= left * 1_001n, `lent ${lentB}, room left ${left}`);
  const s2 = await steakhouse([a.usdgVault, b.usdgVault]);
  // All Ostra vaults together within 5% of what it can pay out (rounding of one share's assets aside).
  assert.ok(s2.held * 10_000n <= s2.withdrawable * OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS + 10_000n, `held ${s2.held} of ${s2.withdrawable}`);
  // And each check finds Steakhouse within its limits for both.
  for (const x of [a, b]) {
    const c = await x.s.check({ execute: false });
    assert.ok(c.findings.some((f) => f.startsWith(`${STEAKHOUSE_USDG}: every check passes`)), c.findings.join("\n"));
    assert.deepEqual(c.actions, []);
  }
});

test("an NVDA carry: opened at 45% of the LLTV, its market at 99% use, then closed for its rate as the rate climbs", { timeout: 3_600_000, skip }, async () => {
  await freshFork();
  const a = await agent("nvda", 63);
  const { client, s } = a;
  const nvda = borroStock("NVDA");
  await fork.dealUsdg(a.usdgVault, 1_000_000_000n);
  const at = (await a.tokenVault(nvda.token).open()).vault;
  // 20 NVDA: a carry on 10 (about 600 USDG at this block) earns 1.24 USDG in 30 days, under 3x its gas of 0.43 (the
  // VPS run of 25 Oct 2026), so the plan rightly leaves it out. The market has room for twice that loan at this block
  // (Morpho Blue's NVDA market: 6,804.93 USDG supplied, 804.25 borrowed, no event between block 95,228,009 and 97,607,007).
  const held = 20n * 10n ** 18n;
  await fork.dealToken(at, nvda.token, held);

  // What the carry should borrow, read here: 45% of the LLTV of the collateral the 20 NVDA buy, within the vault's
  // half-LLTV cap, the room under 90% use and the market's liquidity.
  const p0 = await readBorroPosition(client, at, nvda);
  const shares = (await client.readContract({ address: nvda.vault, abi: vaultV2Abi, functionName: "previewDeposit", args: [held] })) as bigint;
  const value = (shares * p0.price) / 10n ** 36n;
  let expected = (value * nvda.market.lltv * 4_500n) / (WAD * 10_000n);
  for (const x of [halfLltvMaxDebt(shares, p0.price, nvda.market.lltv), (p0.supply * CARRY_MAX_UTILIZATION) / WAD - p0.borrowed, p0.available]) if (x < expected) expected = x;
  assert.ok(expected > 0n);
  // The carry's USDG goes to Steakhouse: its room for Ostra vaults (5% of what it can pay out, read here) takes the
  // whole loan and the 1,000 USDG dealt, or the plan deposits less and may rightly leave the carry out (about 2.1
  // million USDG of room on 25 Oct 2026, block 97,612,014).
  const sh = await steakhouse([a.usdgVault]);
  const shRoom = (sh.withdrawable * OSTRA_MAX_SHARE_OF_WITHDRAWABLE_BPS) / 10_000n - sh.held;
  assert.ok(shRoom > expected + 1_000_000_000n, `Steakhouse's room for Ostra is ${shRoom}, the loan ${expected}`);
  const keepBuffer = 100_000_000n;
  const plans = await s.plan({ buffer: keepBuffer });
  const balanced = plans.find((p) => p.profile === "balanced");
  assert.ok(balanced !== undefined, plans.map((p) => p.risks.join("\n")).join("\n---\n"));
  assert.deepEqual(
    balanced.steps.map((x) => [x.kind, x.what]),
    [
      ["lend_stock", "NVDA"],
      ["post_collateral", "NVDA"],
      ["link", "NVDA"],
      ["borrow", "NVDA"],
      ["lend_cash", "USDG"],
    ],
  );
  const loan = BigInt(balanced.steps[3]!.amount);
  assert.equal(loan, expected);
  const applied = await applyNow(s, balanced.id);
  assert.equal(applied.next, null, JSON.stringify(applied, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
  assert.ok(applied.done.every((x) => x.landed && x.skipped === undefined), JSON.stringify(applied.done));
  const p1 = await readBorroPosition(client, at, nvda);
  assert.ok(p1.debt >= loan && p1.debt <= loan + 1_000n, `debt ${p1.debt}, loan ${loan}`);
  assert.equal((await readVaultGuard(client, at)).linkedVault, getAddress(a.usdgVault));

  // A real borrower takes the NVDA market to 99% use.
  const borrower = fork.accounts[2]!;
  const w = fork.wallet(borrower);
  await fork.setBalance(borrower.address, 10n ** 19n);
  const want = (p1.supply * 99n) / 100n - p1.borrowed;
  const needShares = (want * 10n ** 36n * WAD * 12n) / (p1.price * nvda.market.lltv * 10n) + 1n;
  const needAssets = ((await client.readContract({ address: nvda.vault, abi: vaultIn, functionName: "convertToAssets", args: [needShares] })) * 101n) / 100n + 1n;
  await fork.dealToken(borrower.address, nvda.token, needAssets);
  await send(await w.writeContract({ address: nvda.token, abi: erc20, functionName: "approve", args: [nvda.vault, needAssets], chain: null, account: borrower }));
  await send(await w.writeContract({ address: nvda.vault, abi: vaultIn, functionName: "deposit", args: [needAssets, borrower.address], chain: null, account: borrower }));
  const got = (await client.readContract({ address: nvda.vault, abi: vaultV2Abi, functionName: "balanceOf", args: [borrower.address] })) as bigint;
  await send(await w.writeContract({ address: nvda.vault, abi: erc20, functionName: "approve", args: [MORPHO_BLUE, got], chain: null, account: borrower }));
  await send(await w.writeContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "supplyCollateral", args: [nvda.market, got, borrower.address, "0x"], chain: null, account: borrower }));
  await send(await w.writeContract({ address: MORPHO_BLUE, abi: morphoAbi, functionName: "borrow", args: [nvda.market, want, 0n, borrower.address, borrower.address], chain: null, account: borrower }));

  // The 90% rung: the excess back, or the whole debt when the excess is that much or more (one run's rate alone never closes).
  const busy = await s.check({ execute: false });
  const p2 = await readBorroPosition(client, at, nvda);
  const over = p2.borrowed - (p2.supply * CARRY_MAX_UTILIZATION) / WAD;
  const rung = busy.actions.find((x) => x.what === "NVDA" && (x.kind === "repay" || x.kind === "close_carry"));
  assert.ok(rung !== undefined && !rung.urgent, JSON.stringify(busy.actions));
  if (over < p2.debt) assert.equal(rung.kind, "repay");
  else assert.match(rung.reason, /past 90% use by the whole debt/);

  // Days at 99% use: the IRM's rate at target climbs; the first check whose two runs' rates average above the cash
  // yield less 1 point closes the carry for its rate.
  let closed: Awaited<ReturnType<StrategyService["check"]>> | null = null;
  let lastRate = p2.borrowRatePerYear;
  for (let day = 3; day <= 60 && closed === null; day += 3) {
    await fork.increaseTime(3 * 86_400);
    const c = await s.check({ execute: false });
    const p = await readBorroPosition(client, at, nvda);
    assert.ok(p.borrowRatePerYear > lastRate, `day ${day}: the rate ${p.borrowRatePerYear} climbs from ${lastRate}`);
    lastRate = p.borrowRatePerYear;
    const x = c.actions.find((y) => y.what === "NVDA" && y.kind === "close_carry");
    if (x !== undefined && /rate/.test(x.reason)) closed = c;
  }
  assert.ok(closed !== null, "the rate rule closed the carry within 60 days at 99% use");
  assert.ok(closed.plan !== null);
  const paid = await applyNow(s, closed.plan);
  assert.equal(paid.next, null, JSON.stringify(paid.done));
  assert.equal((await readBorroPosition(client, at, nvda)).debt, 0n, "the whole debt repaid");
});
