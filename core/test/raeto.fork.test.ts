// Raeto from the agent's USDG vault (raeto.ts), against Raeto's live API (api.raeto.cc: its terms, a login challenge)
// and a fork of Robinhood Chain mainnet with Ostra (version 3 vaults) deployed fresh, the live Steakhouse USDG, and the
// agent's own fee payer sending. Skipped where api.raeto.cc cannot be reached.
//   * fundFromYield: what the shares earn is redeemed and sent to Raeto's payTo once, also when the transfer's send
//     failed and another operation of the vault sent the signed transfer first (it is found at its slot, not paid
//     again);
//   * login: Raeto checks the signature on Robinhood Chain mainnet, where this fork's vault does not exist, so it
//     refuses the login: the approval made for it is withdrawn, the error says so, and nothing is kept to withdraw;
//   * with a funded Raeto account's API key (OSTRA_RAETO_TEST_KEY_FILE, a 0600 file; on the VPS Ostra Agent's console
//     key, the account funded with 5 USDG on 25 Oct 2026): the models and the image models among them, the account
//     (me), a refused call (an unknown model) reported as Raeto's refusal, and one image from
//     google/gemini-2.5-flash-image (about 0.04 US dollars: 1,290 image tokens at 0.00003) decoded from the answer
//     and saved to OSTRA_RAETO_TEST_OUT when set; the key appears in no answer and no error. Skipped without the key.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getAddress, keccak256, parseAbi, parseAbiItem, stringToHex, type Hash, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FileWotsStore, STEAKHOUSE_USDG, USDG, retryingHttp, type Deployment, type RelayCall } from "@ostraagent/sdk";
import { deployOnFork, startFork, type Fork } from "@ostraagent/sdk/test/fork";
import { BorroService, Keys, LocalSender, RAETO_API, RAETO_PAY_TO, RaetoError, RaetoService, VaultService, X402_NETWORK, raetoImages, type Config, type SendOptions } from "../src/index.ts";
import { formatUnitsAmount } from "../src/amount.ts";
import { MemoryFolder } from "./memory-folder.ts";

const reachable = await fetch(`${RAETO_API}/v1/agents`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.ok).catch(() => false);
const skip = reachable ? false : "api.raeto.cc cannot be reached from here";
const keyFile = process.env.OSTRA_RAETO_TEST_KEY_FILE;
const keySkip = skip !== false ? skip : keyFile === undefined || keyFile === "" ? "no OSTRA_RAETO_TEST_KEY_FILE (a funded Raeto account's API key)" : false;
/** The image model of the paid test: Gemini 2.5 Flash Image, 1,290 output tokens an image at 0.00003 (GET /v1/models, 25 Oct 2026). */
const IMAGE_MODEL = "google/gemini-2.5-flash-image";

let fork: Fork;
let d: Deployment;
let root: string;
let config: Config;
let forkBlock: bigint;
const chainGasPrice = async () => (await fork.client.getBlock({ blockNumber: forkBlock })).baseFeePerGas as bigint;
const feePayer = privateKeyToAccount(keccak256(stringToHex("OSTRA/CORE/RAETO-FORK/fee-payer")));
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const erc1271Abi = parseAbi(["function isValidSignature(bytes32, bytes) view returns (bytes4)"]);
const hashApproved = parseAbiItem("event HashApproved(bytes32 indexed hash, uint64 validFrom)");

/** The agent's fee payer sending; after `pass` more sends, the next `failures` fail before anything is sent (an RPC gone). */
class FailingSender extends LocalSender {
  pass = 0;
  failures = 0;
  constructor(client: PublicClient) {
    super(client, retryingHttp(fork.url), feePayer);
  }
  failAfter(pass: number, failures = 1): void {
    this.pass = pass;
    this.failures = failures;
  }
  override async send(calls: RelayCall[], options: SendOptions = {}): Promise<Hash> {
    if (this.pass > 0) this.pass -= 1;
    else if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("the RPC could not be reached");
    }
    return super.send(calls, options);
  }
}

before(async () => {
  if (skip !== false) return;
  root = await mkdtemp(join(tmpdir(), "ostra-core-raeto-"));
  fork = await startFork();
  forkBlock = await fork.client.getBlockNumber({ cacheTime: 0 });
  d = await deployOnFork(fork);
  config = { chainId: d.chainId, rpcUrl: fork.url, deployment: d, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
  await fork.setBalance(feePayer.address, 10n ** 19n);
});

after(async () => {
  await fork?.stop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

function agent(name: string, seed: number) {
  const client = fork.client as PublicClient;
  const transport = retryingHttp(fork.url);
  const keys = new Keys({ master: new Uint8Array(32).fill(seed), feePayer, store: new FileWotsStore(join(root, name)), folder: new MemoryFolder(), backupExported: async () => true });
  const sender = new FailingSender(client);
  const buyer = new VaultService(client, transport, config, keys, sender, "buyer");
  const tokenVault = (token: `0x${string}`) => new VaultService(client, transport, config, keys, sender, "token", null, token);
  const borro = new BorroService({ client, config, buyer, tokenVault, sender, ownVaults: async () => [await buyer.vaultAddress()], gasPrice: chainGasPrice });
  const folder = keys.folder.folder("raeto");
  const raeto = new RaetoService({ client, buyer, borro, folder });
  return { sender, buyer, borro, raeto, folder };
}

const usdgOf = async (a: `0x${string}`) => (await fork.client.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [a] })) as bigint;

test("fundFromYield pays what the shares earned once, also when its transfer was sent first by another operation of the vault", { skip, timeout: 900_000 }, async () => {
  const a = agent("yield", 91);
  const vault = getAddress((await a.buyer.open()).vault);
  await fork.dealUsdg(vault, 5_000_000_000n);
  assert.equal((await a.borro.lendCash(STEAKHOUSE_USDG, 5_000_000_000n)).status, "sent");
  const first = await a.raeto.fundFromYield("1");
  assert.match(first.note ?? "", /the mark is set now/);
  // 60 days of Steakhouse USDG's yield.
  await fork.increaseTime(60 * 86_400);
  const payToBefore = await usdgOf(RAETO_PAY_TO);
  // The redeem goes out; the transfer's send fails: the signed transfer is kept in the vault, and `ready` here.
  a.sender.failAfter(1);
  await assert.rejects(a.raeto.fundFromYield("1"), /RPC could not be reached/);
  const kept = JSON.parse((await a.folder.read("yield.json")) as string) as { ready: string; readySlot?: { nonce: string } };
  const ready = BigInt(kept.ready);
  assert.ok(ready >= 1_000_000n, `ready ${ready}`);
  assert.ok(kept.readySlot !== undefined, JSON.stringify(kept));
  assert.equal(await usdgOf(RAETO_PAY_TO), payToBefore);
  // Another operation of the vault: it sends the signed transfer before its own (and not its own).
  const other = await a.borro.approveHash(keccak256(stringToHex("OSTRA/CORE/RAETO-FORK/other")), true);
  assert.equal(other.status, "resent_pending");
  assert.equal((await usdgOf(RAETO_PAY_TO)) - payToBefore, ready);
  // The next call finds the transfer at its slot: nothing is paid again.
  const again = await a.raeto.fundFromYield("1");
  assert.equal(again.sent, formatUnitsAmount(ready, 6));
  assert.match(again.note ?? "", /sent by an earlier operation/);
  const after = JSON.parse((await a.folder.read("yield.json")) as string) as { ready: string; readySlot?: unknown };
  assert.equal(after.ready, "0");
  assert.equal(after.readySlot, undefined);
  assert.equal((await usdgOf(RAETO_PAY_TO)) - payToBefore, ready, "paid once");
  // And once more: under the minimum now, nothing is sent.
  const quiet = await a.raeto.fundFromYield("1");
  assert.equal(quiet.sent, "0");
  assert.equal((await usdgOf(RAETO_PAY_TO)) - payToBefore, ready);
});

test("a login Raeto refuses: the approval made for it is withdrawn, the error says so, and nothing is kept to withdraw", { skip, timeout: 900_000 }, async () => {
  const a = agent("login", 92);
  const vault = getAddress((await a.buyer.open()).vault);
  let message = "";
  await assert.rejects(a.raeto.login({ name: "ostra-fork-test" }), (e: unknown) => {
    message = (e as Error).message;
    return /the login message's approval: 0x[0-9a-f]{64}/.test(message);
  });
  assert.equal(await a.folder.read("approvals.json"), undefined, "nothing kept to withdraw");
  assert.equal(await a.folder.read("account.json"), undefined);
  assert.equal((await a.buyer.spendSlot())?.pending, null, "nothing signed and left unsent");
  // The vault approved the login message once, and that approval reads no more.
  const approved = await fork.client.getLogs({ address: vault, event: hashApproved, fromBlock: forkBlock, toBlock: "latest" });
  assert.equal(approved.length, 1, JSON.stringify(approved.map((l) => l.args), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
  const valid = (await fork.client.readContract({ address: vault, abi: erc1271Abi, functionName: "isValidSignature", args: [approved[0]!.args.hash as `0x${string}`, "0x"] })) as string;
  assert.notEqual(valid.toLowerCase(), "0x1626ba7e");
});

test("with a funded account's API key: models, the account, a refused call, and one image decoded; the key is never shown", { skip: keySkip, timeout: 900_000 }, async () => {
  const key = (await readFile(keyFile as string, "utf8")).trim();
  assert.ok(/^\S{16,}$/.test(key), "the key file holds one key");
  const a = agent("console-key", 93);
  const vault = getAddress((await a.buyer.open()).vault);
  // The account the key belongs to stands in for the vault's own (which a login on mainnet gives it).
  await a.folder.write("account.json", JSON.stringify({ vault, apiKey: key, name: "ostra-console-test", at: Math.floor(Date.now() / 1000) }));
  const shown = (x: unknown) => JSON.stringify(x, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)).includes(key);

  const all = await a.raeto.models();
  assert.ok(all.total >= 400, `models: ${all.total}`);
  const images = await a.raeto.models("image");
  assert.ok(images.models.length >= 5 && images.models.length < all.total, `image models: ${images.models.length}`);
  const model = images.models.find((m) => m.id === IMAGE_MODEL);
  assert.ok(model !== undefined, `${IMAGE_MODEL} is not among the image models: ${images.models.map((m) => m.id).join(", ")}`);
  console.log(`models: ${all.total}, image models: ${images.models.map((m) => m.id).join(", ")}`);

  const me = await a.raeto.me();
  assert.ok(me !== null && typeof me === "object", "the account reads as an object");
  assert.ok(!shown(me), "the key is not in the account's answer");
  console.log(`me: fields ${Object.keys(me as object).join(", ")}`);

  // A call Raeto refuses: reported as Raeto's refusal, the key not in it.
  let refused: unknown;
  await assert.rejects(a.raeto.complete({ model: "ostra/no-such-model", messages: [{ role: "user", content: "hi" }] }), (e: unknown) => {
    refused = e;
    return e instanceof RaetoError;
  });
  assert.ok(!(refused as Error).message.includes(key), "the key is not in the refusal");
  console.log(`refused: ${(refused as RaetoError).status} ${(refused as Error).message.slice(0, 200)}`);

  // One image, paid from the account.
  const answer = await a.raeto.complete({ model: IMAGE_MODEL, modalities: ["image", "text"], messages: [{ role: "user", content: "A small flat illustration of a lighthouse at dawn, simple shapes, two colours." }] });
  assert.ok(!shown(answer), "the key is not in the answer");
  const got = raetoImages(answer);
  assert.ok(got.length >= 1, `no image in the answer: ${JSON.stringify(answer).slice(0, 600)}`);
  const img = got[0]!;
  assert.match(img.mediaType, /^image\/(png|jpeg|webp)$/);
  assert.ok(img.bytes.length > 1_000, `image of ${img.bytes.length} bytes`);
  const png = img.bytes[0] === 0x89 && img.bytes[1] === 0x50;
  const jpeg = img.bytes[0] === 0xff && img.bytes[1] === 0xd8;
  const webp = Buffer.from(img.bytes.subarray(8, 12)).toString("latin1") === "WEBP";
  assert.ok(png || jpeg || webp, "the bytes are an image");
  console.log(`image: ${img.mediaType}, ${img.bytes.length} bytes; usage ${JSON.stringify((answer as { usage?: unknown }).usage)}`);
  const out = process.env.OSTRA_RAETO_TEST_OUT;
  if (out !== undefined && out !== "") await writeFile(out, img.bytes, { mode: 0o644 });
});
