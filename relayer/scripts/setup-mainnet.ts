// Sets up Ostra's services on Robinhood Chain after the contracts are
// deployed (sdk/scripts/deploy.ts), from the deployer's account. Run again,
// it does only what is missing:
//
//   1. The keys of the keeper (crank master, fee payer), the relayer (merchant,
//      facilitator, relayer account) and the aggregator, each created on first
//      use in its own 0700 directory under OSTRA_BASE, as the services would.
//   2. The operator vault (the keeper fee recipient) and the relayer's seller
//      vault, each an Ostra vault on USDG with its own WOTS keychain under
//      OSTRA_BASE; the relayer vault installs the keeper crank of the relayer's
//      merchant key (SetCrankKey). A spend a crashed run signed and did not
//      land is landed first, so no WOTS key ever signs two messages.
//   3. ETH from the deployer to the keeper fee payer, the relayer account and
//      the aggregator account, topped up to their targets (never taken back).
//   4. The services' environment files (0600) under OSTRA_BASE.
//
// Environment:
//   OSTRA_BASE               directory (0700) of the services' keys and state
//                            (default /etc/ostra/robinhood)
//   OSTRA_DEPLOYMENT         the deployment record (default /etc/ostra/robinhood-deployment.json)
//   OSTRA_DEPLOYER_KEY_FILE  the deployer's key (0600; default /etc/ostra/deployer.key)
//   OSTRA_RPC_URL_FILE       the RPC URL (0600; default /etc/ostra/robinhood-rpc.url)
//
// Nothing secret is printed: the keys stay in their files, and the RPC URL
// is written only to the 0600 environment files.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  hexToBytes,
  http,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FileWotsStore,
  WotsKeychain,
  decodeVaultSpendMessage,
  ostraVaultAbi,
  ostraVaultFactoryAbi,
  parseDeployment,
  readVault,
  redact,
  robinhoodChain,
  signVaultSetCrankKey,
  vaultAddress,
  type Deployment,
  type SignedSpend,
} from "@ostraagent/sdk";
import { openAggregatorKey } from "../../aggregator/src/keys.ts";
import { KeeperKeys } from "../../keeper/src/keys.ts";
import { MerchantKeys } from "../../merchant/src/keys.ts";
import { openRelayerAccount } from "../src/keys.ts";

/** Where each service listens (behind nginx on the same host). */
export const LISTEN = { keeper: "127.0.0.1:4100", relayer: "127.0.0.1:4300", aggregator: "127.0.0.1:4500", rpcProxy: "127.0.0.1:4700" } as const;

/** ETH each operational account is topped up to (decided 19 Oct 2026 with 0.015 ETH in all). */
export const ETH_TARGETS = { keeperFeePayer: parseEther("0.002"), relayer: parseEther("0.007"), aggregator: parseEther("0.002") } as const;

/**
 * The RPC proxy's rates (OSTRA_RPC_PROXY_PER_IP, OSTRA_RPC_PROXY_TOTAL): first values under Alchemy Free's 15
 * requests a second, which the keeper, the relayer and the aggregator share; set again from measured use.
 */
export const RPC_PROXY_RATES = { perIp: 5, total: 10 } as const;

function privateFile(path: string, what: string): string {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${what} ${path} must have mode 0600 (it has ${mode.toString(8)})`);
  return readFileSync(path, "utf8").trim();
}

async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const mode = (await stat(dir)).mode & 0o777;
  if (mode !== 0o700) throw new Error(`${dir} must have mode 0700 (it has ${mode.toString(8)})`);
}

/** A 32-byte secret in `path` (hex, 0600), created on first use and written before it is used. */
async function secret(path: string): Promise<Uint8Array> {
  if (!existsSync(path)) await writeFile(path, `${bytesToHex(new Uint8Array(randomBytes(32))).slice(2)}\n`, { mode: 0o600, flag: "wx" });
  const text = privateFile(path, "the secret");
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${path}: expected 32 bytes of hex`);
  return hexToBytes(`0x${text}`);
}

/** Writes `text` to `path` (0600) through a temporary file, so a reader never sees half of it. */
async function writePrivate(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
}

const envFile = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => {
      if (/[\s"'\\$`]/.test(v)) throw new Error(`${k} holds a character an environment file cannot carry unquoted`);
      return `${k}=${v}\n`;
    })
    .join("");

export type SetupResult = {
  operatorVault: Address;
  relayerVault: Address;
  crank: Address;
  merchant: Address;
  relayerAccount: Address;
  keeperFeePayer: Address;
  aggregator: Address;
  sent: number;
};

export async function setupMainnet(o: {
  base: string;
  deploymentPath: string;
  deployer: PrivateKeyAccount;
  rpcUrl: string;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Where the services listen (default LISTEN; the tests pick free ports). */
  listen?: Record<keyof typeof LISTEN, string>;
}): Promise<SetupResult> {
  const listen = o.listen ?? LISTEN;
  const d: Deployment = parseDeployment(JSON.parse(await readFile(o.deploymentPath, "utf8")));
  const client = createPublicClient({ chain: robinhoodChain, transport: http(o.rpcUrl) }) as PublicClient;
  const wallet = createWalletClient({ account: o.deployer, chain: robinhoodChain, transport: http(o.rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== d.chainId) throw new Error(`the RPC is chain ${chainId}; the deployment is on chain ${d.chainId}`);
  let sent = 0;
  const send = async (what: string, tx: { to: Address; data?: Hex; value?: bigint }) => {
    const hash = await wallet.sendTransaction({ account: o.deployer, chain: robinhoodChain, ...tx });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${what}: transaction ${hash} failed`);
    sent += 1;
    o.log("sent", { what, tx: hash, gasUsed: receipt.gasUsed });
  };
  const spendData = (s: SignedSpend) => encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [s.action, s.nextKeyRoot, s.params, s.signature] });

  await privateDir(o.base);
  const dirs = {
    keeperSecrets: join(o.base, "keeper", "secrets"),
    keeperData: join(o.base, "keeper", "data"),
    relayerSecrets: join(o.base, "relayer", "secrets"),
    relayerData: join(o.base, "relayer", "data"),
    aggregatorSecrets: join(o.base, "aggregator", "secrets"),
    aggregatorData: join(o.base, "aggregator", "data"),
    operatorVault: join(o.base, "operator-vault"),
    relayerVault: join(o.base, "relayer-vault"),
  };
  for (const service of ["keeper", "relayer", "aggregator"]) await privateDir(join(o.base, service));
  for (const dir of Object.values(dirs)) await privateDir(dir);

  // --- 1. the services' keys ---------------------------------------------------------------
  const keeperKeys = await KeeperKeys.open(dirs.keeperSecrets, d.chainId);
  const merchantKeys = await MerchantKeys.open(dirs.relayerSecrets);
  const relayerAccount = await openRelayerAccount(dirs.relayerSecrets);
  const aggregator = await openAggregatorKey(dirs.aggregatorSecrets);
  const crank = keeperKeys.crankFor(merchantKeys.merchant).address;
  o.log("keys", { keeperFeePayer: keeperKeys.feePayer.address, merchant: merchantKeys.merchant, crank, relayerAccount: relayerAccount.address, aggregator: aggregator.address });

  // --- 2. the operator vault and the relayer vault --------------------------------------------
  const vault = async (name: string, dir: string): Promise<{ keys: WotsKeychain; store: FileWotsStore; address: Address }> => {
    const store = new FileWotsStore(join(dir, "wots"));
    const keys = new WotsKeychain(await secret(join(dir, "master.key")), await secret(join(dir, "keychain.id")), store);
    const address = vaultAddress({ factory: d.vaultFactory, beacon: d.vaultBeacon, token: d.token, initialKeyRoot: bytesToHex(keys.keyRoot(0n)), initialCrank: zeroAddress });
    if ((await readVault(client, d, address)) === null) {
      await send(`create the ${name}`, { to: d.vaultFactory, data: encodeFunctionData({ abi: ostraVaultFactoryAbi, functionName: "createVault", args: [d.token, bytesToHex(keys.keyRoot(0n)), zeroAddress] }) });
    }
    if ((await readVault(client, d, address)) === null) throw new Error(`the ${name} ${address} is not on chain`);
    return { keys, store, address };
  };
  const operator = await vault("operator vault", dirs.operatorVault);
  const relayerVault = await vault("relayer vault", dirs.relayerVault);
  let rv = await readVault(client, d, relayerVault.address);
  if (rv === null) throw new Error("the relayer vault is not on chain");
  if (rv.crank !== crank) {
    // A spend this key signed in an earlier run and did not land is landed as it is: one key, one message.
    const pending = await relayerVault.store.load(relayerVault.keys.keychainId, rv.nonce);
    if (pending !== undefined) {
      const signed = decodeVaultSpendMessage(hexToBytes(`0x${pending.message}`));
      await send("land the relayer vault's signed spend", { to: relayerVault.address, data: encodeFunctionData({ abi: ostraVaultAbi, functionName: "spend", args: [signed.action, signed.nextKeyRoot, signed.params, `0x${pending.signature}`] }) });
      rv = await readVault(client, d, relayerVault.address);
      if (rv === null) throw new Error("the relayer vault is not on chain");
    }
    if (rv.crank !== crank) {
      await send("install the keeper crank on the relayer vault", { to: relayerVault.address, data: spendData(await signVaultSetCrankKey(relayerVault.keys, rv, { chainId: d.chainId, crank })) });
    }
    if ((await readVault(client, d, relayerVault.address))?.crank !== crank) throw new Error(`the relayer vault did not install the crank ${crank}`);
  }
  o.log("vaults", { operatorVault: operator.address, relayerVault: relayerVault.address, crank });

  // --- 3. ETH for the operational accounts -------------------------------------------------------
  for (const [name, address, target] of [
    ["keeper fee payer", keeperKeys.feePayer.address, ETH_TARGETS.keeperFeePayer],
    ["relayer account", relayerAccount.address, ETH_TARGETS.relayer],
    ["aggregator account", aggregator.address, ETH_TARGETS.aggregator],
  ] as const) {
    const held = await client.getBalance({ address });
    if (held < target) await send(`top up the ${name} to ${formatEther(target)} ETH`, { to: address, value: target - held });
  }

  // --- 4. the services' environment files ------------------------------------------------------
  const common = { OSTRA_RPC_URL: o.rpcUrl, OSTRA_DEPLOYMENT: o.deploymentPath };
  await writePrivate(join(o.base, "keeper.env"), envFile({ ...common, OSTRA_KEEPER_SECRETS: dirs.keeperSecrets, OSTRA_KEEPER_DATA: dirs.keeperData, OSTRA_KEEPER_LISTEN: listen.keeper, OSTRA_KEEPER_FEE_RECIPIENT: operator.address }));
  await writePrivate(
    join(o.base, "relayer.env"),
    envFile({
      ...common,
      OSTRA_KEEPER_URL: `http://${listen.keeper}`,
      OSTRA_RELAYER_VAULT: relayerVault.address,
      OSTRA_RELAYER_SECRETS: dirs.relayerSecrets,
      OSTRA_RELAYER_DATA: dirs.relayerData,
      OSTRA_RELAYER_LISTEN: listen.relayer,
      OSTRA_RELAYER_CLIENT_IP: "cf-connecting-ip",
    }),
  );
  await writePrivate(join(o.base, "aggregator.env"), envFile({ ...common, OSTRA_AGGREGATOR_SECRETS: dirs.aggregatorSecrets, OSTRA_AGGREGATOR_DATA: dirs.aggregatorData, OSTRA_AGGREGATOR_LISTEN: listen.aggregator }));
  await writePrivate(
    join(o.base, "rpc-proxy.env"),
    envFile({ OSTRA_RPC_URL: o.rpcUrl, OSTRA_RPC_PROXY_LISTEN: listen.rpcProxy, OSTRA_RPC_PROXY_PER_IP: String(RPC_PROXY_RATES.perIp), OSTRA_RPC_PROXY_TOTAL: String(RPC_PROXY_RATES.total), OSTRA_RPC_PROXY_CLIENT_IP: "cf-connecting-ip" }),
  );
  const balances: Record<string, string> = {};
  for (const [name, address] of [
    ["deployer", o.deployer.address],
    ["keeperFeePayer", keeperKeys.feePayer.address],
    ["relayerAccount", relayerAccount.address],
    ["aggregator", aggregator.address],
  ] as const)
    balances[name] = formatEther(await client.getBalance({ address }));
  o.log("ready", { base: o.base, sent, eth: balances });
  return { operatorVault: operator.address, relayerVault: relayerVault.address, crank, merchant: merchantKeys.merchant, relayerAccount: relayerAccount.address, keeperFeePayer: keeperKeys.feePayer.address, aggregator: aggregator.address, sent };
}

async function main(): Promise<void> {
  const base = process.env.OSTRA_BASE || "/etc/ostra/robinhood";
  const deploymentPath = process.env.OSTRA_DEPLOYMENT || "/etc/ostra/robinhood-deployment.json";
  const rpcUrl = privateFile(process.env.OSTRA_RPC_URL_FILE || "/etc/ostra/robinhood-rpc.url", "the RPC URL file");
  const keyFile = process.env.OSTRA_DEPLOYER_KEY_FILE || "/etc/ostra/deployer.key";
  const key = privateFile(keyFile, "the deployer key file");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${keyFile} does not hold a 32-byte hex private key`);
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    console.log(redact(JSON.stringify({ event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v)), rpcUrl));
  try {
    await setupMainnet({ base, deploymentPath, deployer: privateKeyToAccount(key as Hex), rpcUrl, log });
    console.log("SETUP_OK");
  } catch (err) {
    throw new Error(redact(err instanceof Error ? err.message : String(err), rpcUrl));
  }
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(`setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
