// The WOTS-keyed owner of Ostra's beacons (src/OstraUpgradeOwner.sol): every upgrade of the vaults or
// the pool is signed by a rotating WOTS one-time key and waits DELAY (72 hours) in public before anyone
// may execute it. The ECDSA deployer key only pays gas; it can authorize nothing once the beacons are
// handed over.
//
//   node scripts/upgrade-owner.ts init                          a new owner seed, encrypted under a
//                                                               passphrase, in OSTRA_OWNER_SEED_FILE
//   node scripts/upgrade-owner.ts deploy                        deploys OstraUpgradeOwner with key 0 and
//                                                               hands both beacons to it (ECDSA owner);
//                                                               run again, it resumes or only checks
//   node scripts/upgrade-owner.ts schedule-upgrade <beacon> <implementation>
//   node scripts/upgrade-owner.ts schedule <target> <calldata>  any other call (renounceOwnership, ...)
//   node scripts/upgrade-owner.ts cancel <id>
//   node scripts/upgrade-owner.ts execute <id>                  once DELAY has passed (anyone may)
//   node scripts/upgrade-owner.ts status
//
//   OSTRA_DEPLOYER_KEY_FILE   file (0600) with the deployer's hex private key (default /etc/ostra/deployer.key):
//                             the beacons' current ECDSA owner for deploy; afterwards it only pays gas
//   OSTRA_RPC_URL_FILE        file (0600) with the RPC URL (default /etc/ostra/robinhood-rpc.url); never printed
//   OSTRA_DEPLOYMENT          the deployment record; deploy rewrites its beaconOwner to the owner contract
//   OSTRA_OUT_DIR             the Foundry build (default ../../out)
//   OSTRA_OWNER_SEED_FILE     the encrypted owner seed (default /etc/ostra/owner-seed.json)
//   OSTRA_OWNER_STATE         directory (0700) of the WOTS signature records and the signed calls (default
//                             /etc/ostra/owner-state); no secrets, but it is what keeps a key from ever
//                             signing two messages: keep it, and back it up with the seed after every call
//
// The passphrase is read from the terminal without echo (or a line from stdin when stdin is not a
// terminal). The seed is never printed and never written unencrypted. The keychain is bound to the chain
// and to the owner contract's address, so one seed never signs for two owners. Key n signs the call at
// the owner's nonce n and names key n + 1 as the next key. A call is recorded before it is signed, and
// its transaction hash once sent; a signed call that did not land is sent again, identical, before
// anything new is signed, so no key ever signs two messages. One run at a time (a lock file).

import { randomBytes, createCipheriv, createDecipheriv, scrypt as scryptCb, type ScryptOptions } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  formatEther,
  getAddress,
  getContractAddress,
  hexToBytes,
  http,
  isAddress,
  keccak256,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ostraUpgradeOwnerAbi, upgradeableBeaconAbi } from "../src/abi.ts";
import { redact, robinhoodChain } from "../src/chain.ts";
import { ROBINHOOD_CHAIN_ID } from "../src/constants.ts";
import { checkDeployment } from "../src/deploy.ts";
import { parseDeployment, type Deployment } from "../src/deployment.ts";
import { UPGRADE_OWNER_ACTION, upgradeOwnerCancelPayload, upgradeOwnerMessage, upgradeOwnerSchedulePayload, type UpgradeOwnerAction } from "../src/messages.ts";
import { FileWotsStore } from "../src/wots-file.ts";
import { WotsKeychain } from "../src/wots.ts";

/** OstraUpgradeOwner.DELAY on mainnet: 72 hours, so every vault owner has three days to withdraw before an upgrade. */
export const UPGRADE_DELAY_SECONDS = 72n * 3600n;
const SEED_AAD = Buffer.from("OSTRA/OWNER-SEED/v1", "utf8");
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const MIN_PASSPHRASE = 16;
const WHOLE_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
/** How long a run waits for a transaction it finds pending from an earlier run. */
const PENDING_WAIT_MS = 120_000;

/** The owner keychain id: bound to the chain and the owner contract, so one seed never signs for two owners. */
export function ownerKeychainId(chainId: number, owner: Address): Uint8Array {
  return hexToBytes(keccak256(encodePacked(["string", "uint256", "address"], ["OSTRA/OWNER/KEYCHAIN/EVM/v1", BigInt(chainId), getAddress(owner)])));
}

type Intent = {
  version: 1;
  nonce: string;
  action: UpgradeOwnerAction;
  /** SCHEDULE: the call. CANCEL: the call id. */
  target?: Address;
  data?: Hex;
  id?: string;
  nextKeyRoot: Hex;
  /** The transaction that carried it, once sent. */
  txHash?: Hex;
  createdAt: string;
};

type DeployIntent = { version: 1; chainId: number; payer: Address; payerNonce: number; owner: Address; keyRoot0: Hex; txHash?: Hex };

function privateFile(path: string, what: string): string {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${what} ${path} must have mode 0600 (it has ${mode.toString(8)})`);
  return readFileSync(path, "utf8").trim();
}

function scrypt(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(passphrase, salt, 32, SCRYPT as ScryptOptions, (err, key) => (err === null ? resolve(key) : reject(err))));
}

async function sealSeed(seed: Uint8Array, passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await scrypt(passphrase, salt), iv);
  cipher.setAAD(SEED_AAD);
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  return `${JSON.stringify({ version: 1, kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, salt: salt.toString("hex"), iv: iv.toString("hex"), ciphertext: ciphertext.toString("hex"), tag: cipher.getAuthTag().toString("hex") })}\n`;
}

async function openSeed(text: string, passphrase: string): Promise<Uint8Array> {
  const b = JSON.parse(text) as { version?: unknown; kdf?: { name?: unknown; N?: unknown; r?: unknown; p?: unknown }; salt?: unknown; iv?: unknown; ciphertext?: unknown; tag?: unknown };
  if (b.version !== 1 || b.kdf?.name !== "scrypt" || b.kdf.N !== SCRYPT.N || b.kdf.r !== SCRYPT.r || b.kdf.p !== SCRYPT.p) throw new Error("not an Ostra owner seed (version 1)");
  for (const f of [b.salt, b.iv, b.ciphertext, b.tag]) if (typeof f !== "string" || !/^[0-9a-f]+$/.test(f)) throw new Error("not an Ostra owner seed");
  const decipher = createDecipheriv("aes-256-gcm", await scrypt(passphrase, Buffer.from(b.salt as string, "hex")), Buffer.from(b.iv as string, "hex"));
  decipher.setAAD(SEED_AAD);
  decipher.setAuthTag(Buffer.from(b.tag as string, "hex"));
  let seed: Buffer;
  try {
    seed = Buffer.concat([decipher.update(Buffer.from(b.ciphertext as string, "hex")), decipher.final()]);
  } catch {
    throw new Error("the passphrase does not open the owner seed");
  }
  if (seed.length !== 32) throw new Error("the owner seed is not 32 bytes");
  return new Uint8Array(seed);
}

/** Passphrase lines: hidden terminal prompts, or the lines of stdin when it is not a terminal. */
class Passphrases {
  #lines: string[] | undefined;

  async next(prompt: string): Promise<string> {
    if (process.stdin.isTTY) return hidden(prompt);
    if (this.#lines === undefined) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      this.#lines = Buffer.concat(chunks).toString("utf8").split("\n");
    }
    const line = this.#lines.shift();
    if (line === undefined || line === "") throw new Error("no passphrase on stdin");
    return line;
  }
}

function hidden(prompt: string): Promise<string> {
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${path} must not be accessible by other users (mode ${mode.toString(8)})`);
}

function writeJson(path: string, value: unknown, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
  renameSync(tmp, path);
}

class OwnerTool {
  readonly client: PublicClient;
  readonly wallet: WalletClient;
  readonly payer: PrivateKeyAccount;
  readonly recordPath: string;
  readonly state: string;
  readonly seedFile: string;
  readonly log: (event: string, fields?: Record<string, unknown>) => void;
  readonly passphrases = new Passphrases();
  #seed: Uint8Array | undefined;
  #lock: string | undefined;

  constructor(o: { client: PublicClient; wallet: WalletClient; payer: PrivateKeyAccount; recordPath: string; state: string; seedFile: string; log: OwnerTool["log"] }) {
    this.client = o.client;
    this.wallet = o.wallet;
    this.payer = o.payer;
    this.recordPath = o.recordPath;
    this.state = o.state;
    this.seedFile = o.seedFile;
    this.log = o.log;
  }

  /** One run at a time: an exclusive lock file in the state directory, removed when the run ends. */
  lock(): void {
    ensureDir(this.state);
    const path = join(this.state, "lock");
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`another run holds ${path}; if none is running, remove that file and run again`);
      throw err;
    }
    this.#lock = path;
  }

  unlock(): void {
    if (this.#lock !== undefined) unlinkSync(this.#lock);
    this.#lock = undefined;
  }

  record(): Deployment {
    return parseDeployment(JSON.parse(readFileSync(this.recordPath, "utf8")));
  }

  async keychain(owner: Address): Promise<WotsKeychain> {
    if (this.#seed === undefined) {
      this.#seed = await openSeed(readFileSync(this.seedFile, "utf8"), await this.passphrases.next("owner seed passphrase: "));
    }
    ensureDir(this.state);
    return new WotsKeychain(this.#seed, ownerKeychainId(ROBINHOOD_CHAIN_ID, owner), new FileWotsStore(join(this.state, "wots")));
  }

  async send(address: Address, abi: typeof ostraUpgradeOwnerAbi | typeof upgradeableBeaconAbi, functionName: string, args: readonly unknown[], sent?: (hash: Hex) => void): Promise<Hex> {
    const { request } = await this.client.simulateContract({ address, abi, functionName, args, account: this.payer } as Parameters<PublicClient["simulateContract"]>[0]);
    const hash = await this.wallet.writeContract(request as Parameters<WalletClient["writeContract"]>[0]);
    sent?.(hash);
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} ${hash} reverted`);
    this.log("sent", { functionName, tx: hash, gasUsed: receipt.gasUsed });
    return hash;
  }

  async read<T>(address: Address, abi: typeof ostraUpgradeOwnerAbi | typeof upgradeableBeaconAbi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (await this.client.readContract({ address, abi, functionName, args } as Parameters<PublicClient["readContract"]>[0])) as T;
  }

  /** The owner contract of the record (it need not own both beacons any more: one may have been released). */
  async owner(): Promise<Address> {
    const owner = this.record().beaconOwner;
    if ((await this.client.getCode({ address: owner })) === undefined) throw new Error(`the record's beaconOwner ${owner} is not a contract: run deploy first`);
    const delay = await this.read<bigint>(owner, ostraUpgradeOwnerAbi, "DELAY");
    if (delay !== UPGRADE_DELAY_SECONDS) throw new Error(`${owner} has DELAY ${delay}, not ${UPGRADE_DELAY_SECONDS}`);
    return owner;
  }

  #callsDir(owner: Address): string {
    return join(this.state, "calls", getAddress(owner));
  }

  #intentPath(owner: Address, nonce: bigint): string {
    return join(this.#callsDir(owner), `${nonce.toString().padStart(20, "0")}.json`);
  }

  #intents(owner: Address): Intent[] {
    const dir = this.#callsDir(owner);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => /^[0-9]{20}\.json$/.test(n))
      .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as Intent);
  }

  #payload(intent: Intent): Hex {
    if (intent.action === UPGRADE_OWNER_ACTION.schedule) return upgradeOwnerSchedulePayload(intent.target as Address, intent.data as Hex);
    return upgradeOwnerCancelPayload(BigInt(intent.id as string));
  }

  /**
   * Records `intent` (unless recorded already), signs it with key `nonce` and sends it, recording the
   * transaction hash. The key must be the owner's current key.
   */
  async #signAndSend(owner: Address, intent: Intent): Promise<void> {
    const keychain = await this.keychain(owner);
    const nonce = BigInt(intent.nonce);
    const current = await this.read<Hex>(owner, ostraUpgradeOwnerAbi, "keyRoot");
    if (bytesToHex(keychain.keyRoot(nonce)) !== current.toLowerCase()) throw new Error(`the owner's key root is not key ${nonce} of this seed`);
    if (intent.nextKeyRoot.toLowerCase() !== bytesToHex(keychain.keyRoot(nonce + 1n))) throw new Error("the recorded next key root is not this seed's next key");
    ensureDir(this.#callsDir(owner));
    const path = this.#intentPath(owner, nonce);
    if (!existsSync(path)) writeJson(path, intent, 0o600);
    const message = upgradeOwnerMessage({ chainId: ROBINHOOD_CHAIN_ID, owner, nonce, action: intent.action, payload: this.#payload(intent), nextKeyRoot: intent.nextKeyRoot });
    const signature = bytesToHex(await keychain.sign(nonce, message, hexToBytes(current)));
    const sent = (txHash: Hex) => writeJson(path, { ...intent, txHash }, 0o600);
    if (intent.action === UPGRADE_OWNER_ACTION.schedule) {
      await this.send(owner, ostraUpgradeOwnerAbi, "schedule", [intent.target, intent.data, intent.nextKeyRoot, signature], sent);
    } else {
      await this.send(owner, ostraUpgradeOwnerAbi, "cancel", [BigInt(intent.id as string), intent.nextKeyRoot, signature], sent);
    }
    const after = await this.read<bigint>(owner, ostraUpgradeOwnerAbi, "nonce");
    if (after !== nonce + 1n) throw new Error(`the owner's nonce is ${after} after the call, not ${nonce + 1n}`);
  }

  /**
   * The recorded call at the owner's current nonce, if any: a transaction of it still pending is waited
   * for; one signed and not landed is sent again (the identical message); one never signed is set aside.
   */
  async flushPending(owner: Address): Promise<void> {
    for (;;) {
      const nonce = await this.read<bigint>(owner, ostraUpgradeOwnerAbi, "nonce");
      const path = this.#intentPath(owner, nonce);
      if (!existsSync(path)) return;
      const intent = JSON.parse(readFileSync(path, "utf8")) as Intent;
      if ((await (await this.keychain(owner)).signed(nonce)) === undefined) {
        // Recorded, never signed: nothing left this machine.
        renameSync(path, `${path}.unsigned-${Date.now()}`);
        return;
      }
      if (intent.txHash !== undefined) {
        try {
          const receipt = await this.client.waitForTransactionReceipt({ hash: intent.txHash, timeout: PENDING_WAIT_MS });
          if (receipt.status === "success") continue;
        } catch (err) {
          const pending = await this.client.getTransaction({ hash: intent.txHash }).catch(() => null);
          if (pending !== null && pending.blockNumber === null) throw new Error(`transaction ${intent.txHash} of call nonce ${nonce} is still pending; run again once it is mined (${(err as Error).message})`);
        }
      }
      this.log("resending", { nonce, action: intent.action });
      await this.#signAndSend(owner, intent);
    }
  }

  async schedule(target: Address, data: Hex): Promise<void> {
    if (!WHOLE_BYTES.test(data) || data.length < 10) throw new Error("the calldata must be 0x hex of whole bytes, at least a selector");
    const owner = await this.owner();
    await this.flushPending(owner);
    if ((await this.client.getCode({ address: target })) === undefined) throw new Error(`${target} is not a contract`);
    const nonce = await this.read<bigint>(owner, ostraUpgradeOwnerAbi, "nonce");
    const keychain = await this.keychain(owner);
    const intent: Intent = { version: 1, nonce: nonce.toString(), action: UPGRADE_OWNER_ACTION.schedule, target: getAddress(target), data: data.toLowerCase() as Hex, nextKeyRoot: bytesToHex(keychain.keyRoot(nonce + 1n)), createdAt: new Date().toISOString() };
    await this.#signAndSend(owner, intent);
    const call = await this.read<{ target: Address; eta: bigint }>(owner, ostraUpgradeOwnerAbi, "getCall", [nonce]);
    this.log("scheduled", { id: nonce, target, data, executableFrom: new Date(Number(call.eta) * 1000).toISOString() });
  }

  async cancel(id: bigint): Promise<void> {
    const owner = await this.owner();
    await this.flushPending(owner);
    const call = await this.read<{ eta: bigint }>(owner, ostraUpgradeOwnerAbi, "getCall", [id]);
    if (call.eta === 0n) throw new Error(`call ${id} is not scheduled (never, executed or cancelled)`);
    const nonce = await this.read<bigint>(owner, ostraUpgradeOwnerAbi, "nonce");
    const keychain = await this.keychain(owner);
    await this.#signAndSend(owner, { version: 1, nonce: nonce.toString(), action: UPGRADE_OWNER_ACTION.cancel, id: id.toString(), nextKeyRoot: bytesToHex(keychain.keyRoot(nonce + 1n)), createdAt: new Date().toISOString() });
    this.log("cancelled", { id });
  }

  async execute(id: bigint): Promise<void> {
    const owner = await this.owner();
    const call = await this.read<{ target: Address; eta: bigint; dataHash: Hex }>(owner, ostraUpgradeOwnerAbi, "getCall", [id]);
    if (call.eta === 0n) throw new Error(`call ${id} is not scheduled (never, executed or cancelled)`);
    const intent = this.#intents(owner).find((i) => i.action === UPGRADE_OWNER_ACTION.schedule && i.nonce === id.toString());
    if (intent?.data === undefined || keccak256(intent.data) !== call.dataHash.toLowerCase()) throw new Error(`no recorded calldata for call ${id} matches the scheduled one`);
    const now = (await this.client.getBlock({ blockTag: "latest" })).timestamp;
    const grace = await this.read<bigint>(owner, ostraUpgradeOwnerAbi, "GRACE");
    if (now < call.eta) throw new Error(`call ${id} may be executed from ${new Date(Number(call.eta) * 1000).toISOString()} (chain time), in ${call.eta - now} seconds`);
    if (now > call.eta + grace) throw new Error(`call ${id} expired at ${new Date(Number(call.eta + grace) * 1000).toISOString()}`);
    await this.send(owner, ostraUpgradeOwnerAbi, "execute", [id, intent.data]);
    this.log("executed", { id, target: call.target });
  }

  /**
   * deploy: OstraUpgradeOwner at the address the payer's next nonce creates (its keychain is bound to that
   * address, so key 0 is known before it exists), both beacons handed to it, the record's beaconOwner
   * rewritten. The deployment is recorded before it is sent, so a run that stopped resumes with it.
   */
  async deploy(outDir: string): Promise<void> {
    const d = this.record();
    const intentPath = join(this.state, "deploy.json");
    const owners = await Promise.all([d.vaultBeacon, d.poolBeacon].map(async (b) => getAddress(await this.read<Address>(b, upgradeableBeaconAbi, "owner"))));
    const others = [...new Set(owners.filter((o) => o !== this.payer.address))];
    let intent: DeployIntent | undefined = existsSync(intentPath) ? (JSON.parse(readFileSync(intentPath, "utf8")) as DeployIntent) : undefined;
    if (intent !== undefined && (intent.chainId !== ROBINHOOD_CHAIN_ID || getAddress(intent.payer) !== this.payer.address)) {
      throw new Error(`${intentPath} records a deployment by ${intent.payer} on chain ${intent.chainId}, not by this deployer on ${ROBINHOOD_CHAIN_ID}`);
    }
    if (others.length > 1 || (others.length === 1 && others[0] !== intent?.owner)) throw new Error(`the beacons are owned by ${owners.join(" and ")}, not by this deployer or the recorded owner contract`);
    if (intent === undefined) {
      const payerNonce = await this.client.getTransactionCount({ address: this.payer.address, blockTag: "pending" });
      const owner = getContractAddress({ from: this.payer.address, nonce: BigInt(payerNonce) });
      const keyRoot0 = bytesToHex((await this.keychain(owner)).keyRoot(0n));
      intent = { version: 1, chainId: ROBINHOOD_CHAIN_ID, payer: this.payer.address, payerNonce, owner, keyRoot0 };
      writeJson(intentPath, intent, 0o600);
    }
    const owner = intent.owner;
    const keychain = await this.keychain(owner);
    if ((await this.client.getCode({ address: owner })) === undefined && intent.txHash !== undefined) {
      // A deployment sent by an earlier run: wait for it before deciding anything.
      const sent = intent.txHash;
      await this.client.waitForTransactionReceipt({ hash: sent, timeout: PENDING_WAIT_MS }).catch(async (err: unknown) => {
        const pending = await this.client.getTransaction({ hash: sent }).catch(() => null);
        if (pending !== null && pending.blockNumber === null) throw new Error(`the deployment ${sent} is still pending; run again once it is mined (${(err as Error).message})`);
      });
    }
    if ((await this.client.getCode({ address: owner })) === undefined) {
      const now = await this.client.getTransactionCount({ address: this.payer.address, blockTag: "pending" });
      if (now !== intent.payerNonce) throw new Error(`the recorded deployment of ${owner} needed the payer's nonce ${intent.payerNonce}, now ${now}, and nothing is at that address: remove ${intentPath} and run again`);
      const artifact = JSON.parse(readFileSync(`${outDir}/OstraUpgradeOwner.sol/OstraUpgradeOwner.json`, "utf8")) as { bytecode: { object: string } };
      if (!/^0x[0-9a-f]+$/.test(artifact.bytecode.object)) throw new Error("OstraUpgradeOwner: no creation code in the build");
      const hash = await this.wallet.deployContract({ abi: ostraUpgradeOwnerAbi, bytecode: artifact.bytecode.object as Hex, args: [intent.keyRoot0, UPGRADE_DELAY_SECONDS], account: this.payer, chain: robinhoodChain, nonce: intent.payerNonce });
      writeJson(intentPath, { ...intent, txHash: hash }, 0o600);
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success" || receipt.contractAddress === null || receipt.contractAddress === undefined) throw new Error(`OstraUpgradeOwner: deployment ${hash} failed`);
      if (getAddress(receipt.contractAddress) !== owner) throw new Error(`OstraUpgradeOwner landed at ${receipt.contractAddress}, not at ${owner}`);
      this.log("deployed", { name: "OstraUpgradeOwner", address: owner, tx: hash, gasUsed: receipt.gasUsed });
    } else {
      this.log("found", { owner });
    }
    const nonce = await this.read<bigint>(owner, ostraUpgradeOwnerAbi, "nonce");
    const keyRoot = (await this.read<Hex>(owner, ostraUpgradeOwnerAbi, "keyRoot")).toLowerCase();
    if (keyRoot !== bytesToHex(keychain.keyRoot(nonce))) throw new Error(`the owner contract ${owner} is not keyed by this seed`);
    const delay = await this.read<bigint>(owner, ostraUpgradeOwnerAbi, "DELAY");
    if (delay !== UPGRADE_DELAY_SECONDS) throw new Error(`the owner contract's DELAY is ${delay}, not ${UPGRADE_DELAY_SECONDS}`);
    for (const beacon of [d.vaultBeacon, d.poolBeacon]) {
      const now = getAddress(await this.read<Address>(beacon, upgradeableBeaconAbi, "owner"));
      if (now === owner) continue;
      if (now !== this.payer.address) throw new Error(`beacon ${beacon} is owned by ${now}`);
      await this.send(beacon, upgradeableBeaconAbi, "transferOwnership", [owner]);
      this.log("handed over", { beacon, owner });
    }
    const next: Deployment = { ...d, beaconOwner: owner };
    await checkDeployment(this.client, next);
    if (d.beaconOwner !== owner) {
      writeJson(this.recordPath, next, 0o644);
      this.log("written", { record: this.recordPath, beaconOwner: owner, previous: d.beaconOwner });
    }
    this.log("checked", { owner, keyRoot, nonce, delaySeconds: delay });
  }

  async status(): Promise<void> {
    const d = this.record();
    const out: Record<string, unknown> = { beaconOwner: d.beaconOwner };
    for (const [name, beacon] of [["vaultBeacon", d.vaultBeacon], ["poolBeacon", d.poolBeacon]] as const) {
      out[name] = { owner: await this.read<Address>(beacon, upgradeableBeaconAbi, "owner"), implementation: await this.read<Address>(beacon, upgradeableBeaconAbi, "implementation") };
    }
    if ((await this.client.getCode({ address: d.beaconOwner })) !== undefined) {
      const owner = d.beaconOwner;
      out.nonce = await this.read<bigint>(owner, ostraUpgradeOwnerAbi, "nonce");
      out.keyRoot = await this.read<Hex>(owner, ostraUpgradeOwnerAbi, "keyRoot");
      out.delaySeconds = await this.read<bigint>(owner, ostraUpgradeOwnerAbi, "DELAY");
      const grace = await this.read<bigint>(owner, ostraUpgradeOwnerAbi, "GRACE");
      const now = (await this.client.getBlock({ blockTag: "latest" })).timestamp;
      const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString();
      const calls: Record<string, unknown>[] = [];
      for (const i of this.#intents(owner)) {
        if (i.action !== UPGRADE_OWNER_ACTION.schedule) continue;
        const c = await this.read<{ eta: bigint }>(owner, ostraUpgradeOwnerAbi, "getCall", [BigInt(i.nonce)]);
        const state = c.eta === 0n ? "executed, cancelled or never landed" : now < c.eta ? `waiting until ${iso(c.eta)}` : now <= c.eta + grace ? `executable until ${iso(c.eta + grace)}` : `expired at ${iso(c.eta + grace)}`;
        calls.push({ id: i.nonce, target: i.target, data: i.data, state });
      }
      out.calls = calls;
    }
    this.log("status", out);
  }
}

async function main(): Promise<void> {
  const [command, a1, a2] = process.argv.slice(2);
  const seedFile = process.env.OSTRA_OWNER_SEED_FILE || "/etc/ostra/owner-seed.json";
  if (command === "init") {
    if (existsSync(seedFile)) throw new Error(`${seedFile} exists already; an owner seed is never replaced`);
    const passphrases = new Passphrases();
    const p = await passphrases.next(`new passphrase (at least ${MIN_PASSPHRASE} characters): `);
    if (p.length < MIN_PASSPHRASE) throw new Error(`the passphrase must be at least ${MIN_PASSPHRASE} characters`);
    if ((await passphrases.next("the same passphrase again: ")) !== p) throw new Error("the passphrases differ");
    writeFileSync(seedFile, await sealSeed(new Uint8Array(randomBytes(32)), p), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ event: "initialized", seedFile }));
    console.log(
      `keep a copy of ${seedFile} and its passphrase off this machine, and of the owner state directory after every call: ` +
        "without the seed and the passphrase the beacons can never be upgraded again; without the state a key could sign twice",
    );
    return;
  }
  const keyFile = process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key";
  const rpcFile = process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url";
  const recordPath = process.env.OSTRA_DEPLOYMENT;
  if (recordPath === undefined || recordPath === "") throw new Error("missing environment variable OSTRA_DEPLOYMENT");
  const state = process.env.OSTRA_OWNER_STATE || "/etc/ostra/owner-state";
  const outDir = process.env.OSTRA_OUT_DIR || fileURLToPath(new URL("../../out", import.meta.url));
  const rpcUrl = privateFile(rpcFile, "the RPC URL file");
  const key = privateFile(keyFile, "the deployer key file");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyFile} does not hold a 32-byte hex private key`);
  const payer = privateKeyToAccount(key as Hex);
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(redact(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)), rpcUrl));
  const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) }) as PublicClient;
  const wallet = createWalletClient({ account: payer, chain: robinhoodChain, transport: http(rpcUrl) });
  const tool = new OwnerTool({ client, wallet, payer, recordPath, state, seedFile, log });
  try {
    const chainId = await client.getChainId();
    if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`the RPC is chain ${chainId}, not Robinhood Chain (${ROBINHOOD_CHAIN_ID})`);
    log("payer", { address: payer.address, eth: formatEther(await client.getBalance({ address: payer.address })) });
    const address = (v: string | undefined, what: string): Address => {
      if (v === undefined || !isAddress(v, { strict: false })) throw new Error(`${what} must be an address`);
      return getAddress(v);
    };
    const id = (v: string | undefined): bigint => {
      if (v === undefined || !/^[0-9]{1,19}$/.test(v)) throw new Error("the call id must be a whole number");
      return BigInt(v);
    };
    if (command === "status") await tool.status();
    else if (command === "execute") await tool.execute(id(a1));
    else if (command === "deploy" || command === "schedule-upgrade" || command === "schedule" || command === "cancel") {
      tool.lock();
      try {
        if (command === "deploy") await tool.deploy(outDir);
        else if (command === "schedule-upgrade") await tool.schedule(address(a1, "the beacon"), encodeFunctionData({ abi: upgradeableBeaconAbi, functionName: "upgradeTo", args: [address(a2, "the implementation")] }));
        else if (command === "schedule") {
          if (a2 === undefined || !WHOLE_BYTES.test(a2) || a2.length < 10) throw new Error("the calldata must be 0x hex of whole bytes, at least a selector");
          await tool.schedule(address(a1, "the target"), a2.toLowerCase() as Hex);
        } else await tool.cancel(id(a1));
      } finally {
        tool.unlock();
      }
    } else throw new Error("usage: upgrade-owner.ts init | deploy | schedule-upgrade <beacon> <implementation> | schedule <target> <calldata> | cancel <id> | execute <id> | status");
    console.log("UPGRADE_OWNER_OK");
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err), rpcUrl));
  }
}

main().catch((err: unknown) => {
  console.error(`upgrade-owner failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
