// Reference Ostra seller server: one paid route behind an x402
// batch-settlement channel paid to the seller's OstraSplit and Ostra vault and
// guarded by the keeper.
//
//   GET /paid          the paid resource: 402 with the x402 payment
//                      requirements; a voucher (or a deposit with its
//                      voucher) worth the price gets the resource; a refund is
//                      answered by the method itself, and a voucher that
//                      already paid is answered 409 (merchant.ts)
//   GET /v1/merchant   public facts a buyer or the seller's agent may check:
//                      merchant key, vault, crank, split, splits, withdraw
//                      delay, price, the facilitator's account
//
// Configuration: config.ts. Stops cleanly on SIGINT and SIGTERM.

import { redact } from "@ostraagent/sdk";
import { loadMerchantConfig } from "./config.ts";
import { createMerchantServer } from "./http.ts";
import { MerchantKeys, ensurePrivateDir } from "./keys.ts";
import { createOstraMerchant } from "./merchant.ts";
import { FileChannelStorage } from "./store.ts";

async function main(): Promise<void> {
  const config = loadMerchantConfig();
  const scrub = (text: string) => redact(text, config.rpcUrl);
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    console.log(scrub(line));
  };
  const keys = await MerchantKeys.open(config.secretsDir);
  await ensurePrivateDir(config.dataDir);
  const storage = await FileChannelStorage.open(config.dataDir);
  const merchant = await createOstraMerchant({
    rpcUrl: config.rpcUrl,
    deployment: config.deployment,
    vault: config.vault,
    keeperUrl: config.keeperUrl,
    keys,
    storage,
    price: config.price,
    ...(config.suggestedDeposit === undefined ? {} : { suggestedDeposit: config.suggestedDeposit }),
    extraSplits: config.extraSplits,
    ...(config.gracePeriodSeconds === undefined ? {} : { gracePeriodSeconds: config.gracePeriodSeconds }),
    log,
  });
  const facts = {
    chainId: config.deployment.chainId,
    merchant: keys.merchant,
    vault: config.vault,
    crank: merchant.crank,
    split: merchant.split,
    token: merchant.token,
    decimals: merchant.decimals,
    price: config.price.toString(),
    splits: merchant.splits,
    gracePeriodSeconds: merchant.gracePeriodSeconds,
    facilitator: keys.facilitator.address,
  };

  const server = createMerchantServer(merchant, facts, log, scrub);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => resolve());
  });
  log("started", { ...facts, listen: `${config.listen.host}:${config.listen.port}` });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("stopping", { signal, unforwarded: merchant.forwarder.pending });
    merchant.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  const url = process.env.OSTRA_RPC_URL;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`merchant failed to start: ${url === undefined || url === "" ? message : redact(message, url)}`);
  process.exit(1);
});
