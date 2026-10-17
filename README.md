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

```
node vectors/generate.ts   # vectors from the SDK (OSTRA_SDK_SRC, default /srv/apps/ostra/sdk/src)
forge test -vv             # Vault.fork.t.sol forks Robinhood Chain mainnet (rpc_endpoints.robinhood)
```
