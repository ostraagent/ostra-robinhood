// The Ostra relayer (design v0.3; on Robinhood Chain, design v0.4): sends
// agents' calls to Ostra's contracts from its own account, so agents need no
// ETH, and charges them as an Ostra seller.
//
//   POST /v1/relay     body {"calls": [{"to", "data"}], "prepay"?: boolean,
//                      "payer"?: "<vault>"}; answered by gate.ts: 402 with the
//                      price as an x402 batch-settlement challenge, 200
//                      {txHash, ...} once relayed, 400/403/409/422/503 with
//                      {error, message}
//   GET  /v1/relayer   the relayer's terms: its sending account (feePayer),
//                      vault, token, grace, splits and split, price feed, the
//                      most calls per request, merchant key, crank
//   GET  /v1/vaults/<vault>  what the relayer holds for that vault: debt,
//                      credit, and an open relayed before payment with the
//                      calls that pay it when sent again
//   GET  /v1/signatures/<key root>  the WOTS signature escrowed for that key
//                      root (32 bytes in hex, with or without 0x;
//                      signatures.ts): 200 with the record, 404 no_signature,
//                      400 bad_key_root
//   POST /v1/escrow    body {"calls": [...]}: escrows the WOTS signatures in
//                      them without relaying (gate.ts), for an agent that
//                      sends with its own fee payer: 200, 409 key_reused,
//                      503 escrow_unavailable, 400 no_signatures
//   GET  /v1/backups/<name>  the passkey backup kept under that name (32 bytes
//                      in 0x hex; backups.ts): 200 {name, owner, blob,
//                      updatedAt}, 404 no_backup (with updatedAt when deleted)
//   POST /v1/backups/<name>  body {"op": "put" | "delete", "owner", "blob"
//                      (put), "at", "signature"}: writes it, signed by the
//                      seed's backup key: 200, 400, 403 bad_signature, 404,
//                      409 owner_mismatch or replayed, 429 backup_limit
//   GET  /v1/private/price?token=<address>&kind=swap|unshield  with
//                      OSTRA_SWAP_DEPLOYMENT's privatePool: the fee in that
//                      token a private spend is relayed for now (private.ts):
//                      200 {fee, relayer, ...}, 422 fee_unpriced, 400
// The web app's origin gets CORS on every route, and its preflights (OPTIONS)
// are answered with 204 (merchant/src/cors.ts).
//
// The relayer is an Ostra seller: its x402 batch-settlement method is the
// seller server's (merchant/src/merchant.ts), paid to OSTRA_RELAYER_VAULT's
// split and guarded by the keeper. It sends from its own account (send.ts;
// Kora signed on Solana) and drops escrowed WOTS signatures once their keys
// are used (signatures.ts). With Ostra Swap configured it also relays its
// router's escrow orders and private spends, and sells the fees private spends
// pay it for ETH every hour (sweep.ts). Configuration: config.ts. Stops cleanly on SIGINT
// and SIGTERM.

import { createPublicClient, http, type PublicClient } from "viem";
import { PoolIndex, ROBINHOOD_PUBLIC_RPC } from "@ostraagent/swap";
import { CHAINLINK_ETH_USD, assertRobinhoodChain, chainlinkEthUsd, redact, retryingHttp, robinhoodChain } from "@ostraagent/sdk";
import { MerchantKeys, ensurePrivateDir } from "../../merchant/src/keys.ts";
import { createOstraMerchant } from "../../merchant/src/merchant.ts";
import { FileChannelStorage } from "../../merchant/src/store.ts";
import { loadRelayerConfig } from "./config.ts";
import { RelayerGate } from "./gate.ts";
import { BackupStore } from "./backups.ts";
import { createRelayerServer } from "./http.ts";
import { openRelayerAccount } from "./keys.ts";
import { Ledger } from "./ledger.ts";
import { PrivateRelay } from "./private.ts";
import { FeeSweeper } from "./sweep.ts";
import { RelaySender } from "./send.ts";
import { SignatureEscrow, SignaturePruner } from "./signatures.ts";

async function main(): Promise<void> {
  const config = loadRelayerConfig();
  const scrub = (text: string) => redact(text, config.rpcUrl);
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    console.log(scrub(line));
  };

  const transport = retryingHttp(config.rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport }) as PublicClient;
  await assertRobinhoodChain(client);
  const d = config.deployment;

  const keys = await MerchantKeys.open(config.secretsDir);
  const account = await openRelayerAccount(config.secretsDir);
  await ensurePrivateDir(config.dataDir);
  const storage = await FileChannelStorage.open(config.dataDir);
  const ledger = await Ledger.open(config.dataDir);
  const escrow = await SignatureEscrow.open(config.dataDir);
  const backups = await BackupStore.open(config.dataDir, d.chainId);
  const merchant = await createOstraMerchant({
    rpcUrl: config.rpcUrl,
    deployment: d,
    vault: config.vault,
    keeperUrl: config.keeperUrl,
    keys,
    storage,
    // Every challenge carries its own request's price (gate.ts); this is only the method default.
    price: 1n,
    log,
  });
  const sender = new RelaySender(client, transport, account);
  const ethUsd = chainlinkEthUsd(client, CHAINLINK_ETH_USD);
  const sc = config.swap;
  let privateRelay: PrivateRelay | undefined;
  let sweeper: FeeSweeper | undefined;
  if (sc !== null && sc.privatePool !== null) {
    // Robinhood Chain's public RPC serves eth_getLogs over the windows the pool index searches.
    const logsClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_PUBLIC_RPC) }) as PublicClient;
    const index = new PoolIndex();
    privateRelay = new PrivateRelay({ client, logsClient, index, pool: sc.privatePool, ledger, sender, ethUsd, log });
    sweeper = new FeeSweeper({ client, logsClient, index, router: sc.router, stake: sc.stake, ledger, sender, log });
  }
  const gate = new RelayerGate({
    client,
    deployment: d,
    ledger,
    escrow,
    merchant,
    sender,
    vault: config.vault,
    priceFeed: CHAINLINK_ETH_USD,
    ethUsd,
    ...(sc === null ? {} : { swap: { router: sc.router, ...(privateRelay === undefined ? {} : { private: privateRelay }) } }),
    log,
  });
  const facts = { ...gate.facts(), merchant: keys.merchant, crank: merchant.crank, facilitator: keys.facilitator.address };

  const server = createRelayerServer({ gate, escrow, backups, ...(privateRelay === undefined ? {} : { privateRelay }), facts, clientIp: config.clientIp, log, scrub });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => resolve());
  });
  const pruner = new SignaturePruner({ client, deployment: d, escrow, log });
  pruner.start();
  sweeper?.start();
  log("started", { ...facts, listen: `${config.listen.host}:${config.listen.port}` });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("stopping", { signal, unforwarded: merchant.forwarder.pending });
    pruner.stop();
    sweeper?.stop();
    merchant.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  const url = process.env.OSTRA_RPC_URL;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`relayer failed to start: ${url === undefined || url === "" ? message : redact(message, url)}`);
  process.exit(1);
});
