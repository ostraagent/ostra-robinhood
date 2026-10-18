// The agent the MCP server runs: its keys in OSTRA_HOME and the core services
// on them, wired as the design has them (core relay.ts, vault.ts,
// channels.ts, pay.ts, shield.ts, unshield.ts, launchpad.ts):
//   * with OSTRA_RELAYER_URL the relayer sends every transaction, paid from
//     the buyer vault's channel to it; the creator vault and each private
//     vault pay their own (their own relayer clients and records); the
//     signature escrow guards every one-time key;
//   * without it the fee payer in OSTRA_HOME sends and pays gas in ETH.
// The sweep (every SWEEP_SECONDS) carries on with what takes time: channel
// closes asked for, channels `pay` opened past their life, relayer channels
// past theirs, shield deposits and scheduled unshields.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicClient, getAddress, isAddress, type Address, type PublicClient, type Transport } from "viem";
import { assertRobinhoodChain, retryingHttp, robinhoodChain, type FileWotsStore } from "@ostraagent/sdk";
import {
  ChannelService,
  LaunchpadService,
  LocalSender,
  PayService,
  RelayerClient,
  ShieldService,
  SignatureEscrowClient,
  UnshieldService,
  VaultService,
  type Keys,
  type PrivateVaultContext,
  type Sender,
} from "@ostraagent/core";
import { privateKeyToAccount } from "viem/accounts";
import type { McpConfig } from "./config.ts";
import { checkPrivate, ensurePrivateDir } from "./disk.ts";
import { openKeys } from "./keys.ts";

export const SWEEP_SECONDS = 60;
/** The seller vault's keeper crank (part of its address), kept once accept_payments read it. */
const SELLER_RECORD = "seller.json";
/** Where the seller server (merchant/) reads the merchant key: OSTRA_MERCHANT_SECRETS. */
export const MERCHANT_DIR = "merchant";

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export class Agent {
  readonly config: McpConfig;
  readonly client: PublicClient;
  readonly transport: Transport;
  readonly keys: Keys<FileWotsStore>;
  readonly escrow: SignatureEscrowClient | null;
  readonly local: LocalSender;
  readonly relayer: RelayerClient | null;
  readonly sender: Sender;
  readonly buyer: VaultService;
  readonly channels: ChannelService;
  readonly payments: PayService;
  readonly seller: VaultService;
  readonly creator: VaultService;
  readonly creatorRelayer: RelayerClient | null;
  /** The creator vault's channels: its relayer channels, closed by the sweep once retired. */
  readonly creatorChannels: ChannelService;
  readonly launchpad: LaunchpadService | null;
  readonly shield: ShieldService;
  readonly creatorShield: ShieldService;
  readonly unshield: UnshieldService;
  readonly #privates = new Map<bigint, PrivateVaultContext>();
  readonly #log: Log;
  #sweeping = false;

  private constructor(p: {
    config: McpConfig;
    client: PublicClient;
    transport: Transport;
    keys: Keys<FileWotsStore>;
    creatorKeys: Keys<FileWotsStore>;
    escrow: SignatureEscrowClient | null;
    log: Log;
  }) {
    const { config, client, transport, keys } = p;
    this.config = config;
    this.client = client;
    this.transport = transport;
    this.keys = keys;
    this.escrow = p.escrow;
    this.#log = p.log;
    this.local = new LocalSender(client, transport, keys.feePayer, p.escrow);
    this.relayer = config.relayerUrl === null ? null : new RelayerClient(client, config, keys, config.relayerUrl);
    this.sender = this.relayer ?? this.local;
    this.buyer = new VaultService(client, transport, config, keys, this.sender, "buyer");
    this.relayer?.attachBuyerVault(this.buyer);
    this.channels = new ChannelService(client, config, keys, this.buyer, this.sender);
    this.payments = new PayService(client, config, this.buyer, this.channels);
    this.seller = new VaultService(client, transport, config, keys, this.sender, "seller");
    this.creatorRelayer = config.relayerUrl === null ? null : new RelayerClient(client, config, p.creatorKeys, config.relayerUrl);
    const creatorSender = this.creatorRelayer ?? this.local;
    this.creator = new VaultService(client, transport, config, p.creatorKeys, creatorSender, "creator");
    this.creatorRelayer?.attachBuyerVault(this.creator);
    this.creatorChannels = new ChannelService(client, config, p.creatorKeys, this.creator, creatorSender);
    this.launchpad =
      config.deployment.launchpad === undefined ? null : new LaunchpadService({ client, transport, config, keys, buyer: this.buyer, buyerSender: this.sender, creator: this.creator, creatorSender });
    this.shield = new ShieldService(client, config, keys, this.buyer, this.sender);
    this.creatorShield = new ShieldService(client, config, keys, this.creator, creatorSender);
    this.unshield = new UnshieldService(client, config, keys, this.shield, (index) => this.privateVault(index));
  }

  static async open(config: McpConfig, log: Log): Promise<Agent> {
    const transport = retryingHttp(config.rpcUrl);
    const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
    await assertRobinhoodChain(client);
    const escrow = config.relayerUrl === null ? null : new SignatureEscrowClient(config.relayerUrl);
    const keys = await openKeys(config.home, escrow);
    const creatorKeys = await keys.forCreatorVault(config.chainId, config.deployment.token);
    const agent = new Agent({ config, client, transport, keys, creatorKeys, escrow, log });
    await agent.#loadSeller();
    return agent;
  }

  /** Private vault `index` (unshield made it), with its own records and relayer client. */
  async privateVault(index: bigint): Promise<PrivateVaultContext> {
    const known = this.#privates.get(index);
    if (known !== undefined) return known;
    const keys = await this.keys.forPrivateVault(this.config.chainId, this.config.deployment.token, index);
    const relayer = this.config.relayerUrl === null ? null : new RelayerClient(this.client, this.config, keys, this.config.relayerUrl);
    const sender = relayer ?? this.local;
    const vault = new VaultService(this.client, this.transport, this.config, keys, sender, "private", index);
    relayer?.attachBuyerVault(vault);
    const ctx = { vault, sender };
    this.#privates.set(index, ctx);
    return ctx;
  }

  async #loadSeller(): Promise<void> {
    const text = await this.keys.folder.read(SELLER_RECORD);
    if (text === undefined) return;
    const r = JSON.parse(text) as { chainId?: unknown; crank?: unknown };
    if (r.chainId !== this.config.chainId || typeof r.crank !== "string" || !isAddress(r.crank, { strict: false })) throw new Error(`${SELLER_RECORD} is not a seller record of chain ${this.config.chainId}`);
    this.seller.setInitCrank(getAddress(r.crank));
  }

  /** True once accept_payments set the seller vault up. */
  async sellerReady(): Promise<boolean> {
    return (await this.keys.folder.read(SELLER_RECORD)) !== undefined;
  }

  /**
   * accept_payments: the seller vault, created with the keeper crank of this
   * agent's merchant key (paid up front by the buyer vault), and the merchant
   * key written where the seller server reads it.
   */
  async acceptPayments(): Promise<{ sellerVault: Address; crank: Address; merchant: Address; created: boolean; merchantSecrets: string; serverEnv: Record<string, string> }> {
    const keeper = this.config.keeperUrl;
    if (keeper === null) throw new Error("accept_payments needs the Ostra keeper: set OSTRA_KEEPER_URL");
    const token = this.config.deployment.token;
    const merchantKey = this.keys.merchantKey(this.config.chainId, token);
    const merchant = privateKeyToAccount(merchantKey).address;
    let crank: Address;
    const known = await this.keys.folder.read(SELLER_RECORD);
    if (known !== undefined) {
      crank = getAddress((JSON.parse(known) as { crank: string }).crank);
    } else {
      let res: Response;
      try {
        res = await fetch(`${keeper}/v1/crank?merchant=${merchant}`, { signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        throw new Error(`the keeper at ${keeper} cannot be reached: ${(err as Error).message}`);
      }
      const body = (await res.json().catch(() => null)) as { crank?: unknown } | null;
      if (res.status !== 200 || typeof body?.crank !== "string" || !isAddress(body.crank, { strict: false })) throw new Error(`the keeper answered ${res.status} without a crank`);
      crank = getAddress(body.crank);
      this.seller.setInitCrank(crank);
      await this.keys.folder.write(SELLER_RECORD, `${JSON.stringify({ chainId: this.config.chainId, token, crank, merchant })}\n`);
    }
    const opened = await this.seller.open();
    const dir = join(this.config.home, MERCHANT_DIR);
    await ensurePrivateDir(dir);
    const keyFile = join(dir, "merchant.key");
    try {
      await checkPrivate(keyFile);
      const held = (await readFile(keyFile, "utf8")).trim();
      if (`0x${held}` !== merchantKey) throw new Error(`${keyFile} holds another merchant key`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await writeFile(keyFile, `${merchantKey.slice(2)}\n`, { mode: 0o600, flag: "wx" });
    }
    return {
      sellerVault: opened.vault,
      crank,
      merchant,
      created: opened.created,
      merchantSecrets: dir,
      serverEnv: { OSTRA_MERCHANT_SECRETS: dir, OSTRA_MERCHANT_VAULT: opened.vault, OSTRA_KEEPER_URL: keeper },
    };
  }

  /** One pass of the sweep; failures are logged, never thrown. */
  async sweep(): Promise<void> {
    if (this.#sweeping) return;
    this.#sweeping = true;
    const step = async (what: string, fn: () => Promise<unknown>) => {
      try {
        const failures = await fn();
        if (Array.isArray(failures) && failures.length > 0) this.#log("sweep_failures", { what, failures });
      } catch (err) {
        this.#log("sweep_failed", { what, error: err instanceof Error ? err.message : String(err) });
      }
    };
    try {
      // Channels `pay` opened, past their life: closed on the payer path.
      await step("pay channels", async () => {
        const now = Math.floor(Date.now() / 1000);
        for (const r of await this.channels.payRecords()) {
          if (r.pay !== undefined && !r.closeRequested && r.pay.expiresAt <= now) await this.channels.close(r.channel);
        }
      });
      await step("channel closes", () => this.channels.continueClosing());
      if (this.relayer !== null) {
        for (const [name, client, channels] of [["buyer", this.relayer, this.channels], ["creator", this.creatorRelayer, this.creatorChannels]] as const) {
          if (client === null) continue;
          await step(`${name} relayer channels`, async () => {
            for (const c of await client.sweep()) await channels.close(c.channel, c.config);
          });
        }
        await step("creator channel closes", () => this.creatorChannels.continueClosing());
      }
      if (this.config.aggregatorUrl !== null) {
        await step("shield", () => this.shield.sweep());
        await step("creator shield", () => this.creatorShield.sweep());
      }
      await step("unshield", () => this.unshield.sweep());
    } finally {
      this.#sweeping = false;
    }
  }
}
