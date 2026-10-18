// Channel recovery against Robinhood Chain mainnet itself (no fork): an
// agent whose RPC limits eth_getLogs (Alchemy Free allows 10 blocks a
// request, measured 18 Oct 2026) still recovers, because the logs are read in
// windows of LOG_WINDOW_BLOCKS and, when the agent's RPC refuses a window,
// from the public RPC. Nothing is sent; the channel is one no vault opened, so
// recovery reads every window and finds nothing.
//
//   OSTRA_LIMITED_RPC   an RPC URL that refuses eth_getLogs over
//                       LOG_WINDOW_BLOCKS blocks (never printed)

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { bytesToHex, parseAbiItem, type Address } from "viem";
import { ROBINHOOD_CHAIN_ID, USDG, parseDeployment, redact, robinhoodClient } from "@ostraagent/sdk";
import { LOG_WINDOW_BLOCKS, X402_NETWORK, recoverChannelConfig, type Config } from "../src/index.ts";

const limited = process.env.OSTRA_LIMITED_RPC;
const channelOpenedEvent = parseAbiItem("event ChannelOpened(bytes32 indexed channelId, uint128 amount)");

test(
  "a channel is looked up over two log windows when the agent's RPC limits eth_getLogs",
  { skip: limited === undefined || limited === "" ? "OSTRA_LIMITED_RPC is not set" : false },
  async () => {
    const url = limited as string;
    try {
      const client = robinhoodClient(url);
      assert.equal(await client.getChainId(), ROBINHOOD_CHAIN_ID);
      const latest = await client.getBlockNumber();
      const vault = bytesToHex(randomBytes(20)) as Address;
      // The agent's RPC refuses one window: without the public RPC the lookup could not be made.
      await assert.rejects(client.getLogs({ address: vault, event: channelOpenedEvent, fromBlock: latest - LOG_WINDOW_BLOCKS + 1n, toBlock: latest }));
      const deployment = parseDeployment({
        version: 1,
        chainId: ROBINHOOD_CHAIN_ID,
        token: USDG,
        batchSettlement: "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003",
        vaultImplementation: "0x0000000000000000000000000000000000000001",
        vaultBeacon: "0x0000000000000000000000000000000000000002",
        vaultFactory: "0x0000000000000000000000000000000000000003",
        poolImplementation: "0x0000000000000000000000000000000000000004",
        poolBeacon: "0x0000000000000000000000000000000000000005",
        pool: "0x0000000000000000000000000000000000000006",
        splitFactory: "0x0000000000000000000000000000000000000007",
        beaconOwner: "0x0000000000000000000000000000000000000008",
        // Two windows: the first full, the second up to the latest block.
        fromBlock: (latest - 2n * LOG_WINDOW_BLOCKS + 1_000n).toString(),
      });
      const config: Config = { chainId: ROBINHOOD_CHAIN_ID, rpcUrl: url, deployment, x402Network: X402_NETWORK, keeperUrl: null, relayerUrl: null, aggregatorUrl: null, aiUrl: null };
      assert.equal(await recoverChannelConfig(client, config, vault, bytesToHex(randomBytes(32))), null);
    } catch (err) {
      // The URL may carry an API key: no error leaves this test with it.
      throw new Error(redact(err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err), url));
    }
  },
);
