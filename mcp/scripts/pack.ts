// Builds the npm package @ostraagent/mcp in release/ (published from there:
// `npm publish ./release --access public`). Node does not strip types under
// node_modules, so the package ships JavaScript: src/bin.ts with the MCP
// server, the core and the SDK bundled by esbuild into dist/ostra-mcp.js, and
// the third-party packages left as dependencies at the versions the
// workspace pins. Baked in (packaged.ts): the deployment record of Ostra on
// Robinhood Chain mainnet (../deployments/robinhood-mainnet.json), Ostra
// Swap's (../../ostra-swap/deployments/robinhood-mainnet.json, null while it
// is not deployed) and the URLs of Ostra's relayer, keeper and aggregator.
// The bundle is checked to import nothing of the workspace, and the records
// to parse.
//
//   node scripts/pack.ts

import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseDeployment } from "@ostraagent/sdk";
import { parseSwapDeployment } from "@ostraagent/swap";
import type { Packaged } from "../src/packaged.ts";

const here = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const OUT = here("release");
const BUNDLE = "dist/ostra-mcp.js";
const MAINNET_CHAIN_ID = 4663;
const SERVICES = { relayerUrl: "https://relayer.ostraagent.xyz", keeperUrl: "https://keeper.ostraagent.xyz", aggregatorUrl: "https://aggregator.ostraagent.xyz" };
const WORKSPACE = ["@ostraagent/core", "@ostraagent/sdk", "@ostraagent/swap"];

type Manifest = { name: string; version: string; dependencies?: Record<string, string> };
const manifest = async (p: string) => JSON.parse(await readFile(here(p), "utf8")) as Manifest;

const mcp = await manifest("package.json");
// The third-party dependencies of the MCP server, the core, the SDK and Ostra Swap's SDK, one version each.
const dependencies: Record<string, string> = {};
for (const m of [mcp, await manifest("../core/package.json"), await manifest("../sdk/package.json"), await manifest("../../ostra-swap/sdk/package.json")]) {
  for (const [name, version] of Object.entries(m.dependencies ?? {})) {
    if (WORKSPACE.includes(name)) continue;
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error(`${m.name}: ${name} is not pinned (${version})`);
    if (dependencies[name] !== undefined && dependencies[name] !== version) throw new Error(`${name}: ${dependencies[name]} and ${version}`);
    dependencies[name] = version;
  }
}
const sorted = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));

const record: unknown = JSON.parse(await readFile(here("../deployments/robinhood-mainnet.json"), "utf8"));
const deployment = parseDeployment(record);
if (deployment.chainId !== MAINNET_CHAIN_ID) throw new Error(`the mainnet record is of chain ${deployment.chainId}`);
if (deployment.launchpad === undefined) throw new Error("the mainnet record has no launchpad");
const SWAP_RECORD = here("../../ostra-swap/deployments/robinhood-mainnet.json");
const swapRecord: unknown = await access(SWAP_RECORD).then(
  async () => JSON.parse(await readFile(SWAP_RECORD, "utf8")) as unknown,
  () => null,
);
if (swapRecord !== null) {
  const swap = parseSwapDeployment(swapRecord);
  if (swap.chainId !== MAINNET_CHAIN_ID) throw new Error(`Ostra Swap's mainnet record is of chain ${swap.chainId}`);
}
const packaged: Packaged = { version: mcp.version, deployment: record, swapDeployment: swapRecord, ...SERVICES };

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const result = await build({
  entryPoints: [here("src/bin.ts")],
  outfile: `${OUT}/${BUNDLE}`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: Object.keys(sorted),
  define: { OSTRA_PACKAGED: JSON.stringify(packaged) },
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
});

const code = await readFile(`${OUT}/${BUNDLE}`, "utf8");
if (!code.startsWith("#!/usr/bin/env node\n")) throw new Error("the bundle does not start with its shebang");
// What the bundle still imports, from esbuild's metafile: Node's own modules and the dependencies only.
const outputs = Object.values(result.metafile.outputs);
const output = outputs[0];
if (outputs.length !== 1 || output === undefined) throw new Error(`esbuild wrote ${outputs.length} files`);
for (const { path: spec, external } of output.imports) {
  if (spec.startsWith("node:")) continue;
  if (external !== true) throw new Error(`the bundle imports ${spec}, which is not external`);
  const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] as string);
  if (sorted[pkg] === undefined) throw new Error(`the bundle imports ${spec}, which is not a dependency`);
}
// esbuild puts the define in a module of its own (define_OSTRA_PACKAGED_default); the bare name must be gone.
if (/(^|[^\w:])OSTRA_PACKAGED([^\w>]|$)/m.test(code)) throw new Error("OSTRA_PACKAGED was not replaced in the bundle");
if (!code.includes("packaged = typeof define_OSTRA_PACKAGED_default")) throw new Error("the bundle does not carry the packaged settings");

await writeFile(
  `${OUT}/package.json`,
  `${JSON.stringify(
    {
      name: mcp.name,
      version: mcp.version,
      description: "Ostra Agent's MCP server: an AI agent's own post-quantum USDG vault on Robinhood Chain, with payments, a shielded pool and the Ostra launchpad. The agent needs no ETH.",
      keywords: ["mcp", "model-context-protocol", "ai-agent", "robinhood-chain", "post-quantum", "wots", "usdg", "launchpad"],
      homepage: "https://ostraagent.xyz",
      repository: { type: "git", url: "git+https://github.com/ostraagent/ostra-robinhood.git", directory: "mcp" },
      bugs: { url: "https://github.com/ostraagent/ostra-robinhood/issues" },
      license: "MIT",
      author: "Ostra",
      type: "module",
      engines: { node: ">=22" },
      bin: { "ostra-mcp": BUNDLE },
      files: ["dist"],
      dependencies: sorted,
    },
    null,
    2,
  )}\n`,
);
await copyFile(here("README.md"), `${OUT}/README.md`);
await copyFile(here("../LICENSE"), `${OUT}/LICENSE`);
process.stdout.write(`${OUT}: ${mcp.name}@${mcp.version}, ${Math.round(code.length / 1024)} KB, chain ${deployment.chainId}, Ostra Swap ${swapRecord === null ? "not deployed" : "deployed"}, dependencies ${Object.entries(sorted).map(([n, v]) => `${n}@${v}`).join(" ")}\n`);
