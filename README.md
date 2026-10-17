# Ostra on Robinhood Chain

Ostra Agent's contracts for Robinhood Chain (chain ID 4663), ported from the Solana program in
`ostraagent/ostra` with the same behavior. The design is "Agent Ostra — Rancangan v0.4".

Contents:

- `src/Wots.sol`, `src/LtHash.sol`: the WOTS verifier and the LtHash accumulator, byte-compatible
  with the Solana program and the Ostra TypeScript SDK, tested against vectors made by that SDK.
- `src/OstraVault.sol`, `src/OstraVaultFactory.sol`: vaults spent only with rotating WOTS keys
  (Transfer, OpenChannel, SetCrankKey), as beacon proxies at addresses fixed by token, initial key
  root and initial crank. Channels are x402 batch-settlement channels on the deployed
  x402BatchSettlement; a seller vault is the channels' receiverAuthorizer, so only its crank claims
  vouchers and refunds unclaimed escrow.
- `src/OstraSplit.sol`: the receiver of a seller's channels, paying fixed bps shares (the keeper fee)
  and the rest to the seller vault.
- `src/OstraPool.sol`: the shielded pool for one token. Deposits (also relayed with EIP-3009), batches
  of one-leaf-each leaves checked with LtHash, WOTS approvals, sealing, WOTS leaf spends, refunds after
  48 hours. `test/Pool.fork.t.sol` runs it on the mainnet fork with the real USDG.
- `sdk/`: the TypeScript SDK (`@ostraagent/sdk`, viem). WOTS, LtHash and leaves as on Solana; the
  messages, ids and addresses the contracts compute (spend, approval, leaf, deposit nonce, close
  request, channel id, voucher, vault address); reads of vaults, the pool, batches and channels; the
  aggregator wire format and EIP-191 polls; and `deployOstra`, which deploys the contracts from the
  Foundry build. Its fork tests run every message against the contracts on a fork of mainnet.
- `keeper/`: the keeper service (`@ostraagent/keeper`). It guards channels paid to Ostra seller
  vaults whose crank is its per-merchant crank: it claims a forwarded voucher once 1 token is
  unclaimed or the oldest unclaimed voucher is an hour old, and on a buyer's close request (seen
  within its 30-second watch) or a seller's signed close request it claims the last voucher, refunds
  the rest and pays the seller's split out (settle, distribute, release). `scripts/chain-check.ts`
  runs the keeper process end to end against a chain; its fork test runs it on a mainnet fork.
- `merchant/`: the seller server (`@ostraagent/merchant`) and the library the relayer and the AI
  gateway sell through. Paid routes are x402 batch-settlement channels (`@x402/evm` 2.28.0) paid to
  the seller's OstraSplit with the seller's Ostra vault as receiverAuthorizer; vouchers are checked
  by this server's own in-process facilitator, which also sends buyers' EIP-3009 deposits. Every
  paid voucher is forwarded to the keeper; a buyer's refund and a channel idle for 300 seconds are
  closed through the keeper; channels a buyer's Ostra vault opened on-chain are adopted from the
  chain. `scripts/chain-check.ts` runs the keeper and the seller server end to end against a chain
  with the stock x402 client as buyer; its fork test runs it on a mainnet fork (it waits out the
  300-second idle close).

```
node vectors/generate.ts   # vectors from the SDK (OSTRA_SDK_SRC, default /srv/apps/ostra/sdk/src)
forge test -vv             # Vault.fork.t.sol forks Robinhood Chain mainnet (rpc_endpoints.robinhood)
cd sdk && npm ci && npm run typecheck && npm test   # needs forge build (../out) and anvil
node scripts/abi.ts        # in sdk/: rewrite src/abi.ts after a contract change
cd keeper && npm ci && npm run typecheck && npm test   # after the sdk's npm ci; needs ../out and anvil
cd merchant && npm ci && npm run typecheck && npm test   # after the sdk's and the keeper's npm ci
```
