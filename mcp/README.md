# @ostraagent/mcp

Ostra Agent's MCP server. It gives an AI agent its own vault of USDG on Robinhood Chain (chain 4663), guarded by post-quantum one-time keys (WOTS), and the tools to pay for services, keep funds private and trade or launch tokens on the Ostra launchpad. Every transaction goes through the Ostra relayer and is paid in USDG from the vault, so the agent never needs ETH.

Website: [ostraagent.xyz](https://ostraagent.xyz) · Docs: [docs.ostraagent.xyz](https://docs.ostraagent.xyz) · Source: [github.com/ostraagent/ostra-robinhood](https://github.com/ostraagent/ostra-robinhood/tree/main/mcp)

## Install

Requires Node.js 22 or later. No configuration is needed: the package carries the mainnet deployment of Ostra and the addresses of its relayer, keeper and aggregator.

Claude Code:

```sh
claude mcp add ostra -- npx -y @ostraagent/mcp
```

Claude Desktop, Cursor and other MCP clients (`mcpServers` in the client's config):

```json
{
  "mcpServers": {
    "ostra": {
      "command": "npx",
      "args": ["-y", "@ostraagent/mcp"]
    }
  }
}
```

Then ask the agent to call `open_vault`: it returns the vault's address. Send USDG on Robinhood Chain to that address, and `balance` shows it.

## Keys and backup

The agent's keys live in `~/.ostra` (or `OSTRA_HOME`), a directory only its owner can read. The master seed there derives every key the agent uses, and nothing in that directory is ever printed or sent anywhere. `open_vault` reminds the owner until the seed has been backed up. Run this in a terminal, not through the agent, because the passphrase is typed there:

```sh
npx -y @ostraagent/mcp backup export ~/ostra-seed-backup.json
```

Keep the file and the passphrase off the machine. On a new machine, run `npx -y @ostraagent/mcp backup import <file>` before the server first starts there (or with a new `OSTRA_HOME`): the import refuses a directory that already holds a seed. The server then finds the same vaults again.

## Tools

- **Vault:** `open_vault`, `balance`, `withdraw`, `fund_creator_vault`, `creator_withdraw`
- **Payments:** `pay` (calls a paid HTTP service and pays it from a channel of the vault, refused before signing above `maxPrice`), `open_channel`, `list_channels`, `close_channel`
- **Selling services:** `accept_payments`, `seller_balance`, `seller_withdraw`
- **Privacy:** `shield`, `shield_status`, `auto_shield`, `unshield`, `private_withdraw`
- **Recovery:** `recovery_status`, `set_guardian`, `set_recovery_policy`, `cancel_recovery`, `support_recovery`, `request_recovery`
- **Trading:** `tokens`, `token_info`, `pool_info`, `quote_swap`, `buy`, `sell`, `token_vault`, `transfer_token`, `claim_dividends`, `claim_referral`
- **Launching:** `pairs`, `launch` (paired with USDG, ETH, $OSTRA or a listed Robinhood stock token, at a starting market cap in US dollars, with an optional dev buy and vesting), `launches`, `set_pool_setting`, `set_creator_share`, `release_creator_payout`, `airdrop_fund`, `airdrop_start`, `airdrop_claim`, `airdrop_close`, `vesting_info`, `vesting_release`, `vesting_claim_dividends`
- **Ostra Swap:** `ostra_swap_quote`, `ostra_swap` (between the agent's vaults of USDG, WETH, $OSTRA, listed stock tokens and launched tokens, routed through Uniswap v3 and v4; tokens by address or symbol)
- **Private balances:** `private_shield` (from a vault into a private note), `private_balance`, `private_swap`, `private_unshield` (spent with a zero-knowledge proof made on the agent's machine by the WebAssembly prover the package carries)
- **Identity:** `profile`, `upload_image`, `publish_profile`, `set_profile`, `publish_token_metadata`, `set_token_metadata`, `register_agent`, `set_agent_uri`

Every spend is simulated before its one-time key signs it. When a tool refuses, the error says whether it refused before anything was signed.

The identity tools (agent profiles, token images and descriptions, ERC-8004 registration) need vault v2. Its upgrade is scheduled on-chain behind a 72-hour timelock that nobody can shorten, and it can execute from 22 October 2026, 09:07 UTC ([the scheduling transaction](https://robinhoodchain.blockscout.com/tx/0xd4adb65a26c60f0f7f498237419bdc9bb3026931e0a746a6280bb6d9a260c3b7)).

## Configuration

All settings are optional.

| Variable | Default | Meaning |
|---|---|---|
| `OSTRA_HOME` | `~/.ostra` | The agent's keys and records |
| `OSTRA_RPC_URL` | Robinhood Chain's public RPC | RPC endpoint; never printed |
| `OSTRA_RPC_URL_FILE` | | A private file (mode 0600) holding the RPC URL, when it carries an API key |
| `OSTRA_RELAYER_URL` | `https://relayer.ostraagent.xyz` | Sends every transaction, paid in USDG. With `off`, a local fee payer key in `OSTRA_HOME` pays gas in ETH |
| `OSTRA_KEEPER_URL` | `https://keeper.ostraagent.xyz` | Claims payments for the seller side. `off` disables `accept_payments` |
| `OSTRA_AGGREGATOR_URL` | `https://aggregator.ostraagent.xyz` | Batches shield deposits. `off` disables `shield` |
| `OSTRA_SWAP_DEPLOYMENT` | Ostra Swap on mainnet, once deployed | Path of Ostra Swap's deployment record (JSON). Without one the Ostra Swap and private tools refuse |
| `OSTRA_PROVER` | The WebAssembly prover in the package | Path of a native `ostra-prove` binary to prove with instead, or `off` (the private tools then refuse to spend) |
| `OSTRA_PROVER_WASM` | | A directory with another build of the WebAssembly prover (`ostra_prove.js`, `ostra_prove_bg.wasm`) |
| `OSTRA_LOGS_RPC_URL` | Robinhood Chain's public RPC | RPC for Ostra Swap's event searches (wide `eth_getLogs` windows); never printed |
| `OSTRA_DEPLOYMENT` | Ostra on Robinhood Chain mainnet | Path of another deployment record (JSON). With it, the three services default to off |

On a local fork of mainnet (`OSTRA_RPC_URL` pointing at it), set the three services to `off`: they act on mainnet.

Logs go to stderr as JSON lines. Stdout carries only the MCP protocol.

## License

MIT
