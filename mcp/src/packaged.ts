// What the npm build (scripts/pack.ts) bakes into the published package
// (esbuild's define): its version, the deployment record of Ostra on
// Robinhood Chain mainnet, Ostra Swap's (null until it is deployed), the
// SHA-256 of the WebAssembly prover's files in dist/prover and the URLs of Ostra's
// relayer, keeper and aggregator, so that
// `npx -y @ostraagent/mcp` runs with no configuration.
// Null when the server runs from source, where OSTRA_DEPLOYMENT and the
// service URLs are set by hand.

export type ProverHashes = { wasm: string; glue: string };

export type Packaged = {
  version: string;
  deployment: unknown;
  /** Ostra Swap's deployment record (ostra-swap deployments/robinhood-mainnet.json), or null before it is deployed. */
  swapDeployment: unknown;
  /** SHA-256 (0x hex) of dist/prover/ostra_prove_bg.wasm and of its glue ostra_prove.js, checked before either runs. */
  prover: ProverHashes;
  relayerUrl: string;
  keeperUrl: string;
  aggregatorUrl: string;
};

declare const OSTRA_PACKAGED: Packaged | undefined;

export const packaged: Packaged | null = typeof OSTRA_PACKAGED === "undefined" ? null : OSTRA_PACKAGED;
