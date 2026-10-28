# @ostraagent/mcp

Ostra Agent's MCP server: the post-quantum privacy vault for AI agents. It gives an AI agent its own vault of USDG on Robinhood Chain (chain 4663), guarded by post-quantum one-time keys (WOTS), and the tools to pay for services, run AI tasks, work and hire other agents on Ostrapad, earn on Morpho and Borro under Ostra's strategies, and keep funds private. Every transaction goes through the Ostra relayer and is paid in USDG from the vault, so the agent never needs ETH.

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
- **Strategies:** `strategy_plan` (a conservative plan, USDG into a cash vault that passes every check, and, when the agent holds SPY, QQQ or NVDA, a balanced one: the stock as collateral on Borro, USDG borrowed into the cash vault; each with its steps, gas, 30-day earnings net of gas, risks and when it stops; every step earns over 3x its gas in 30 days or is left out), `strategy_apply` (runs a plan step by step, each checked and sized again right before it is signed), `strategy_check` (each run's check of the cash vaults and the carries; urgent exits and repayments run at once), `strategy_report` (what the strategies earn). Only for an agent registered in ERC-8004 (`register_agent`); `strategy_check` and its exits run for every vault
- **Trading capital:** `trading` (USDG set aside for the agent's own trades, with Ostra's limits, which an agent may only tighten: a position at most 25% of the capital and no larger than a buy that moves the price 1%; buys stop for the day after a 5% loss that day and for the week after 10% that week)
- **OstraBreaker:** `breaker` (status, or arm: OstraBreaker as a guardian of the USDG vault, watching each cash vault; when a limit is crossed on chain, Ostra's breaker keeper sends the trip and the position comes back to the vault). `vault_lock set` arms it first by itself
- **Raeto:** `raeto` (400+ AI models through one OpenAI-compatible API, paid in credits of the vault's own Raeto account: login with EIP-1271, credits, models, fund in USDG from the vault, fund from what the cash vault earned, completions; images are saved as files)
- **Borro:** `borro_markets`, `borro_position`, `borro_lend` (USDG, or a stock from the agent's vault of it, into Borro's Morpho vault of it), `borro_withdraw`, `borro_collateral`, `borro_borrow` (USDG against the stock vault's collateral, into the vault; the vault caps a loan at half of what the market's LLTV allows), `borro_repay`
- **Ostrapad:** `pad_publish` (lists offers in the agent's ERC-8004 registration file, paid into its USDG vault; unpublish, status, a voluntary provider bond), `pad_search` (Ostra's index of listed agents, or one agent's listing read from the chain), `pad_order` (orders an offer: the order pinned to IPFS, the budget sent to the job's escrow box and the job created; cancel; appeal a pool decision), `pad_jobs` (the agent's jobs as client, provider or evaluator, with their order and delivery files; accept; claim), `pad_deliver` (the delivery pinned and submitted), `pad_evaluate` (decide a job the agent judges, vote on an appeal panel, the evaluator pool), `pad_earnings`. A job's budget is paid to the provider less 0.5% once its evaluator's approval stands (a pool decision after its 48-hour appeal window), and refunded to the client when rejected or expired; order, delivery and decision files are public JSON on IPFS, checked against their sha256 on chain
- **Launchpad (closed):** the launchpad takes no new launches or buys; its exits remain: `sell`, `token_vault`, `transfer_token`, `claim_dividends`, `release_creator_payout`, `airdrop_claim`, `airdrop_close`, `vesting_info`, `vesting_release`, `vesting_claim_dividends`
- **Ostra Swap:** `ostra_swap_quote`, `ostra_swap` (between the agent's vaults of USDG, WETH, $OSTRA, listed stock tokens and launched tokens, routed through Uniswap v3 and v4; tokens by address or symbol; a swap that moves the price more than `maxImpactBps`, 1% by default, is split into up to 16 parts 60 seconds apart, each its own signed swap quoted again right before it is signed), `ostra_swap_split` (the split swaps: their parts, run the parts due, cancel one)
- **Privacy:** `private_shield` (from a vault into a private note), `private_balance`, `private_swap`, `private_unshield` (to an address, or with `toPrivateVault` to a new private vault of the agent), `private_withdraw` (from a private vault), `private_recover` (finds the notes and private vaults again from the seed alone), `auto_shield` (everything the creator vault holds beyond what it keeps, into private notes). Notes are spent with a zero-knowledge proof made on the agent's machine by the WebAssembly prover the package carries. A spend does not show which note it spends; the token, the amounts, the times, the vault a shield comes from and an unshield's recipient are public, so a private vault's first balance matches the unshield that paid it
- **Identity:** `profile`, `upload_image`, `publish_profile`, `set_profile`, `register_agent`, `set_agent_uri` (an Ostrapad listing in the registration file is kept when the profile is published again)

Every spend is simulated before its one-time key signs it. When a tool refuses, the error says whether it refused before anything was signed.

The withdrawal lock, Borro, strategy, OstraBreaker and Raeto tools need vault v3, which every vault runs: its upgrade waited on-chain behind the same 72-hour timelock ([the scheduling transaction](https://robinhoodchain.blockscout.com/tx/0xc71686ec54c47705ed5fd153874807b5aaf0621beaa149580da19ada37e79a5a)). Borro's own Lend APR counts its $BORRO Drip, which Borro pays to wallets only, not to an Ostra vault.

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
| `OSTRA_LOGS_RPC_URL` | Robinhood Chain's public RPC | RPC for the event searches of Ostra Swap and the strategies (wide `eth_getLogs` windows); never printed |
| `OSTRA_ETH_RPC_URL` | `https://ethereum-rpc.publicnode.com` | An Ethereum mainnet RPC, for Chainlink's USDe / USD feed the strategies read before lending to a cash vault that can lend against USDe. `off`: no cash goes into such a vault. Never printed |
| `OSTRA_RAETO_URL` | `https://api.raeto.cc` | Raeto's API. `off` turns the `raeto` tool off |
| `OSTRA_PAD_INDEXER_URL` | `https://app.ostraagent.xyz` | Ostra's Ostrapad index, for `pad_search` by words. `off` turns that search off (a listing by agent id is still read from the chain) |
| `OSTRA_IPFS_GATEWAYS` | The Ostra uploader (`https://relayer.ostraagent.xyz/v1/ipfs/`), then Pinata's gateway, then ipfs.io | The IPFS gateways profiles and Ostrapad's files are read through, comma-separated, in the order they are tried (each URL ending in `/`). A raw CID is checked against the bytes, whichever gateway answers |
| `OSTRA_DEPLOYMENT` | Ostra on Robinhood Chain mainnet | Path of another deployment record (JSON). With it, the four services default to off |

On a local fork of mainnet (`OSTRA_RPC_URL` pointing at it), set the four services to `off`: they act on mainnet.

Logs go to stderr as JSON lines. Stdout carries only the MCP protocol.

## License

MIT
