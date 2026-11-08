// An open of a vault's relayer channel that its agent key (version 5) left unpaid, on a fork of Robinhood Chain
// mainnet with Ostra deployed (version 5 vaults): once stale it becomes the vault's debt, so that the owner's own
// requests are no longer held by an open only the agent's voucher key could pay; while that debt stands, the agent key
// may not have another open relayed before payment; an owner's open still is (its first voucher pays the debt), and an
// agent's open is again once the debt is gone. The gate decides each before anything is priced or sent.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { encodeFunctionData, getAddress, keccak256, stringToHex, zeroAddress, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDG, VAULT_ACTION, WOTS_SIGNATURE_LEN, openChannelParams, relayRequestHash, ostraVaultAbi, ostraVaultFactoryAbi, vaultAddress, type Deployment } from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { AGENT_OPEN_TAKEOVER_MS, RelayerGate } from "../src/gate.ts";
import { Ledger } from "../src/ledger.ts";
import { SignatureEscrow } from "../src/signatures.ts";

const SPLIT = getAddress("0x00000000000000000000000000000000000C0D81");
const RELAYER_VAULT = getAddress("0x00000000000000000000000000000000000C0D82");
const GRACE = 900;

let fork: Fork;
let d: Deployment;
let root: string;
let sender: PrivateKeyAccount;
let vault: Address;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ostra-gate-agent-open-"));
  fork = await startFork();
  d = await deployOnFork(fork);
  sender = privateKeyToAccount(keccak256(stringToHex("OSTRA/EVM/RELAYER-GATE-AGENT-OPEN-TEST/sender")));
  await fork.setBalance(sender.address, 10n ** 18n);
  const initialKeyRoot = keccak256(stringToHex("OSTRA/EVM/RELAYER-GATE-AGENT-OPEN-TEST/root"));
  const hash = await fork.wallet(sender).sendTransaction({ account: sender, chain: fork.client.chain, to: d.vaultFactory, data: encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [USDG, initialKeyRoot, zeroAddress] }) });
  assert.equal((await fork.client.waitForTransactionReceipt({ hash })).status, "success");
  vault = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: USDG, initialKeyRoot, initialCrank: zeroAddress });
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

/** A relayer channel open from the vault on the relayer's terms, as the owner's spend or the agent key's. */
function openCall(fn: "spend" | "spendAsAgent", salt: number): { to: Address; data: Hex } {
  const params = openChannelParams({ payerAuthorizer: sender.address, receiver: SPLIT, receiverAuthorizer: RELAYER_VAULT, withdrawDelay: GRACE, salt: keccak256(stringToHex(`salt-${salt}`)), amount: 1_000_000n });
  // A signature of the right length that no key made: these requests are decided before any simulation.
  return { to: vault, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: fn, args: [VAULT_ACTION.OPEN_CHANNEL, keccak256(stringToHex(`next-${salt}`)), params, `0x${"ab".repeat(WOTS_SIGNATURE_LEN)}`] }) };
}

test("an agent key's stale unpaid open becomes the vault's debt; no other agent open before payment while it stands", { timeout: 600_000 }, async () => {
  const ledger = await Ledger.open(join(root, "ledger"));
  // The x402 payment itself is not what this test is about (merchant.fork.test.ts): the amount the gate asks is kept,
  // and the request is answered 402 as without a payment header.
  const asked: bigint[] = [];
  const payment = async (_req: unknown, o: { amount: bigint }) => {
    asked.push(o.amount);
    return { kind: "respond", response: { status: 402, headers: {}, body: { error: "payment_required" } } };
  };
  const gate = new RelayerGate({
    client: fork.client,
    deployment: d,
    ledger,
    escrow: await SignatureEscrow.open(join(root, "escrow")),
    merchant: { token: d.token, split: SPLIT, gracePeriodSeconds: GRACE, payment },
    sender: { address: sender.address },
    vault: RELAYER_VAULT,
    log: () => undefined,
    agentOpenTakeoverMs: 1_000,
  } as never);
  const ask = async (call: { to: Address; data: Hex }) => (await gate.relay({ body: JSON.stringify({ calls: [call] }), req: { headers: {} } as never, ip: "127.0.0.1" })) as { status: number; body: { error: string; message: string } };
  assert.equal(AGENT_OPEN_TAKEOVER_MS, 15 * 60_000);

  // An agent open relayed and left unpaid (as #openRelayerChannel records it), a moment ago: the vault is held.
  const takenOpen = openCall("spendAsAgent", 9);
  const record = { hash: relayRequestHash([takenOpen]), txHash: `0x${"02".repeat(32)}`, channel: `0x${"03".repeat(32)}`, amount: "5000", at: Date.now(), calls: [], byAgent: true };
  await ledger.update((data) => {
    data.opens[vault] = record;
  });
  const held = await ask(openCall("spend", 1));
  assert.equal(held.status, 403);
  assert.equal(held.body.error, "open_unpaid", held.body.message);

  // Stale: taken over as the vault's debt on the next request of the vault.
  await ledger.update((data) => {
    data.opens[vault] = { ...record, at: Date.now() - 5_000 };
  });
  const agentAgain = await ask(openCall("spendAsAgent", 2));
  assert.equal(agentAgain.status, 403);
  assert.equal(agentAgain.body.error, "vault_in_debt", agentAgain.body.message);
  const v = ledger.view();
  assert.equal(v.opens[vault], undefined, "the open is gone");
  assert.equal(v.debts[vault]?.amount, "5000", "and owed as the vault's debt");
  const taken = v.agentTakeovers?.[vault];
  assert.deepEqual(taken === undefined ? null : { hash: taken.hash, txHash: taken.txHash }, { hash: record.hash, txHash: record.txHash });
  // The taken-over open's own request, sent again (with a voucher of its channel), still pays: the whole debt.
  const paying = await ask(takenOpen);
  assert.equal(paying.status, 402, JSON.stringify(paying));
  assert.deepEqual(asked, [5000n]);
  // The owner's open is not refused upfront (its first voucher pays the debt): it goes on to be priced and simulated.
  const owner = await ask(openCall("spend", 3));
  assert.ok(!(owner.status === 403 && (owner.body.error === "vault_in_debt" || owner.body.error === "open_unpaid")), JSON.stringify(owner));

  // Once the debt is paid (the open's first voucher clears both), the agent key's open is relayed before payment again.
  await ledger.update((data) => {
    delete data.debts[vault];
    if (data.agentTakeovers !== undefined) delete data.agentTakeovers[vault];
  });
  const free = await ask(openCall("spendAsAgent", 4));
  assert.ok(!(free.status === 403 && free.body.error === "vault_in_debt"), JSON.stringify(free));
});
