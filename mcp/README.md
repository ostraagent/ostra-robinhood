# @ostraagent/mcp

Ostra Agent's MCP server. It gives an AI agent its own vault of USDG on Robinhood Chain (chain 4663), guarded by post-quantum one-time keys (WOTS), and the tools to pay for services, run AI tasks on Ostra AI, keep funds private and trade or launch tokens on the Ostra launchpad. Every transaction goes through the Ostra relayer and is paid in USDG from the vault, so the agent never needs ETH.

Website: [ostraagent.xyz](https://ostraagent.xyz) · Docs: [docs.ostraagent.xyz](https://docs.ostraagent.xyz) · Source: [github.com/ostraagent/ostra-robinhood](https://github.com/ostraagent/ostra-robinhood/tree/main/mcp)

## Install

Requires Node.js 22 or later. No configuration is needed: the package carries the mainnet deployment of Ostra and the addresses of its relayer, keeper, aggregator and AI gateway.

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
- **Ostra AI:** `ostra_ai` (a text, image or video task; Ostra chooses the model by its quality rating within `maxPrice`, paid in USDG from a channel of the vault, and what a task did not cost stays as the vault's credit), `ostra_ai_job` (a video job, saved as a file once completed), `ostra_ai_credit`
- **Selling services:** `accept_payments`, `seller_balance`, `seller_withdraw`
- **Recovery:** `recovery_status`, `set_guardian`, `set_recovery_policy`, `cancel_recovery`, `support_recovery`, `request_recovery`
- **Withdrawal lock:** `vault_lock` (status; set a withdrawal address on another device, a delay of 36 hours to 14 days and a daily limit: anything else the vault sends counts against the limit, and every loosening waits the delay; off; cancel what waits), `vault_link` (the linked vault a Borro loan is paid to), `vault_approve_hash` (EIP-1271 approvals; under the lock they wait the delay), `guard_vault` (as a guardian of another locked vault: cancel its waiting changes, revoke an approval, sweep it to its withdrawal address, bring its Borro shares or collateral back)
- **Borro:** `borro_markets`, `borro_position`, `borro_lend` (USDG, or a stock from the agent's vault of it, into Borro's Morpho vault of it), `borro_withdraw`, `borro_collateral`, `borro_borrow` (USDG against the stock vault's collateral, into the vault; the vault caps a loan at half of what the market's LLTV allows), `borro_repay`
- **Trading:** `tokens`, `token_info`, `pool_info`, `quote_swap`, `buy`, `sell`, `token_vault`, `transfer_token`, `claim_dividends`, `claim_referral`
- **Launching:** `pairs`, `launch` (paired with USDG, ETH, $OSTRA or a listed Robinhood stock token, at a starting market cap in US dollars, with an optional dev buy and vesting), `launches`, `set_pool_setting`, `set_creator_share`, `release_creator_payout`, `airdrop_fund`, `airdrop_start`, `airdrop_claim`, `airdrop_close`, `vesting_info`, `vesting_release`, `vesting_claim_dividends`
- **Ostra Swap:** `ostra_swap_quote`, `ostra_swap` (between the agent's vaults of USDG, WETH, $OSTRA, listed stock tokens and launched tokens, routed through Uniswap v3 and v4; tokens by address or symbol)
- **Privacy:** `private_shield` (from a vault into a private note), `private_balance`, `private_swap`, `private_unshield` (to an address, or with `toPrivateVault` to a new private vault of the agent), `private_withdraw` (from a private vault), `private_recover` (finds the notes and private vaults again from the seed alone), `auto_shield` (everything the creator vault holds beyond what it keeps, into private notes). Notes are spent with a zero-knowledge proof made on the agent's machine by the WebAssembly prover the package carries. A spend does not show which note it spends; the token, the amounts, the times, the vault a shield comes from and an unshield's recipient are public, so a private vault's first balance matches the unshield that paid it
- **Identity:** `profile`, `upload_image`, `publish_profile`, `set_profile`, `publish_token_metadata`, `set_token_metadata`, `register_agent`, `set_agent_uri`

Every spend is simulated before its one-time key signs it. When a tool refuses, the error says whether it refused before anything was signed.

The withdrawal lock and Borro tools need vault v3, which waits behind the same 72-hour timelock as every vault upgrade; until the vaults run it they refuse before anything is signed. Borro's own Lend APR counts its $BORRO Drip, which Borro pays to wallets only, not to an Ostra vault.

The identity tools (agent profiles, token images and descriptions, ERC-8004 registration) need vault v2, which every vault runs since 22 October 2026: the upgrade waited on-chain behind a 72-hour timelock that nobody can shorten ([the scheduling transaction](https://robinhoodchain.blockscout.com/tx/0xd4adb65a26c60f0f7f498237419bdc9bb3026931e0a746a6280bb6d9a260c3b7)).

## Configuration

All settings are optional.

| Variable | Default | Meaning |
|---|---|---|
| `OSTRA_HOME` | `~/.ostra` | The agent's keys and records |
| `OSTRA_RPC_URL` | Robinhood Chain's public RPC | RPC endpoint; never printed |
| `OSTRA_RPC_URL_FILE` | | A private file (mode 0600) holding the RPC URL, when it carries an API key |
| `OSTRA_RELAYER_URL` | `https://relayer.ostraagent.xyz` | Sends every transaction, paid in USDG. With `off`, a local fee payer key in `OSTRA_HOME` pays gas in ETH |
| `OSTRA_KEEPER_URL` | `https://keeper.ostraagent.xyz` | Claims payments for the seller side. `off` disables `accept_payments` |
| `OSTRA_AGGREGATOR_URL` | `https://aggregator.ostraagent.xyz` | The shielded pool's batches, for shield deposits kept from before 0.1.6 only. `off` stops them |
| `OSTRA_AI_URL` | `https://ai.ostraagent.xyz` | Ostra AI, the gateway of the `ostra_ai` tools. `off` disables them |
| `OSTRA_SWAP_DEPLOYMENT` | Ostra Swap on Robinhood Chain mainnet | Path of another Ostra Swap deployment record (JSON). With `OSTRA_DEPLOYMENT` set and no Ostra Swap record, the Ostra Swap and private tools refuse |
| `OSTRA_PROVER` | The WebAssembly prover in the package | Path of a native `ostra-prove` binary to prove with instead, or `off` (the private tools then refuse to spend) |
| `OSTRA_PROVER_WASM` | | A directory with another build of the WebAssembly prover (`ostra_prove.js`, `ostra_prove_bg.wasm`) |
| `OSTRA_LOGS_RPC_URL` | Robinhood Chain's public RPC | RPC for Ostra Swap's event searches (wide `eth_getLogs` windows); never printed |
| `OSTRA_DEPLOYMENT` | Ostra on Robinhood Chain mainnet | Path of another deployment record (JSON). With it, the four services default to off |

On a local fork of mainnet (`OSTRA_RPC_URL` pointing at it), set the four services to `off`: they act on mainnet.

Logs go to stderr as JSON lines. Stdout carries only the MCP protocol.

## License

MIT
