// Starts the standing-order and Priors-repay fallback (order-runner.ts), apart from the other keepers: its own fee
// payer, data and service.
//
//   OSTRA_RPC_URL                  RPC endpoint of Robinhood Chain (chain 4663); never printed
//   OSTRA_LOGS_RPC_URL             RPC for the OrderSet and PriorsBorrowed events over long windows (default the public RPC)
//   OSTRA_DEPLOYMENT               the deployment record: one whose vaults run version 5 (its vaultModuleV5)
//   OSTRA_ORDER_RUNNER_FROM_BLOCK  the first block to read events from (the version 5 upgrade's block)
//   OSTRA_ORDER_RUNNER_SECRETS     directory (0700) of the fee payer key (fee-payer.key, 0600, created on first start,
//                                  never printed); its address is logged at start, to be funded with ETH
//   OSTRA_ORDER_RUNNER_DATA        directory (0700) of the event cursor, the orders and loans found, and the day's budget
//
//   node src/order-runner-main.ts        the service, until SIGINT or SIGTERM
//   node src/order-runner-main.ts once   one read of the events and one tick, then exits; the last line is
//                                        ORDER_RUNNER_ONCE <runs sent> <runs failed>

import { readFileSync } from "node:fs";
import { createPublicClient, http, type Abi, type PublicClient } from "viem";
import { ROBINHOOD_PUBLIC_RPC, assertRobinhoodChain, checkDeployment, ostraVaultAbi, ostraVaultModuleV5Abi, parseDeployment, redact, retryingHttp, robinhoodChain } from "@ostraagent/sdk";
import { Sender } from "./chain.ts";
import { openFeePayer } from "./keys.ts";
import { OrderRunner } from "./order-runner.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`missing environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  const once = process.argv[2] === "once";
  if (process.argv[2] !== undefined && !once) throw new Error("usage: node src/order-runner-main.ts [once]");
  const rpcUrl = required("OSTRA_RPC_URL");
  const logsUrl = process.env.OSTRA_LOGS_RPC_URL !== undefined && process.env.OSTRA_LOGS_RPC_URL !== "" ? process.env.OSTRA_LOGS_RPC_URL : ROBINHOOD_PUBLIC_RPC;
  const deployment = parseDeployment(JSON.parse(readFileSync(required("OSTRA_DEPLOYMENT"), "utf8")));
  if (deployment.vaultModuleV5 === undefined) throw new Error("the deployment record names no vaultModuleV5: the order runner runs once the vaults run version 5 (sdk scripts/upgrade-vault.ts finalize)");
  const fromText = required("OSTRA_ORDER_RUNNER_FROM_BLOCK");
  if (!/^[0-9]+$/.test(fromText)) throw new Error("OSTRA_ORDER_RUNNER_FROM_BLOCK is a block number");
  const scrub = (text: string) => redact(redact(text, rpcUrl), logsUrl);
  const log = (event: string, fields: Record<string, unknown>) => console.log(scrub(JSON.stringify({ at: new Date().toISOString(), event, ...fields })));
  const transport = retryingHttp(rpcUrl);
  const client = createPublicClient({ chain: robinhoodChain, transport, pollingInterval: 250 }) as PublicClient;
  await assertRobinhoodChain(client);
  await checkDeployment(client, deployment);
  const logsClient = createPublicClient({ chain: robinhoodChain, transport: http(logsUrl, { retryCount: 6, retryDelay: 2_000 }) }) as PublicClient;
  const feePayer = await openFeePayer(required("OSTRA_ORDER_RUNNER_SECRETS"));
  const sender = new Sender(client, transport, feePayer, log);
  // The module's errors (TooEarly, NothingToDo, NoOrder, NotOwnLoan) name a run the vault refuses.
  const abi = [...ostraVaultAbi, ...ostraVaultModuleV5Abi.filter((x) => x.type === "error")] as Abi;
  const runner = await OrderRunner.open({
    client,
    logsClient,
    deployment,
    fromBlock: BigInt(fromText),
    feePayer: feePayer.address,
    send: async (vault, fn, id, maxGas) => {
      try {
        const sent = await sender.fromFeePayer({ address: vault, abi, functionName: fn, args: [id] }, maxGas);
        return { ...sent, reverted: false };
      } catch (err) {
        // Landed and reverted (Sender: "<fn> transaction <hash> reverted"): the gas it used, read from its receipt.
        const m = /transaction (0x[0-9a-fA-F]{64}) reverted/.exec((err as Error).message);
        if (m === null) throw err;
        const receipt = await client.getTransactionReceipt({ hash: m[1] as `0x${string}` });
        return { hash: receipt.transactionHash, gasUsed: receipt.gasUsed, reverted: true };
      }
    },
    dataDir: required("OSTRA_ORDER_RUNNER_DATA"),
    log,
  });
  log("started", { chainId: deployment.chainId, feePayer: feePayer.address, eth: (await client.getBalance({ address: feePayer.address })).toString(), orders: runner.orders.length, loans: runner.loans.length, once });
  if (once) {
    await runner.refresh();
    const r = await runner.tick();
    console.log(`ORDER_RUNNER_ONCE ${r.filter((x) => x.tx !== undefined).length} ${r.filter((x) => x.error !== undefined).length}`);
    return;
  }
  runner.run();
  const stop = (signal: string) => {
    log("stopping", { signal });
    runner.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((err: unknown) => {
  const url = process.env.OSTRA_RPC_URL;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`order runner failed: ${url === undefined || url === "" ? message : redact(message, url)}`);
  process.exit(1);
});
