// Ostra Cloud's services as one file each (cloud/Dockerfile's build stage): the signer, the gateway, the egress, the
// front and the agent server the gateway starts for each home, each bundled by esbuild with everything it imports
// (the core, the SDKs and the third-party packages), so the image holds a handful of files instead of the packages'
// node_modules. Sysbox clones the gateway's root file system and changes the owner of every file in it before the
// container starts (dstack OS 0.6.1); with node_modules, some 63,000 entries, that ran past sysbox's 10-minute limit
// and the gateway never started (first deploy, 12 Nov 2026).
//
// Each bundle names its service (OSTRA_BUNDLE, entry.ts): the modules of a bundle share one URL, so only the named
// service starts. A bundle may import Node's own modules only. CommonJS dependencies inside an ES module need
// require, __filename and __dirname: the banner gives them the bundle's own. The third-party packages bundled keep
// their notices: their license files go into THIRD-PARTY-NOTICES.txt beside the bundles.
//
//   node scripts/cloud-bundle.ts <out dir>

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = process.argv[2];
if (out === undefined || out === "") {
  process.stderr.write("usage: node scripts/cloud-bundle.ts <out dir>\n");
  process.exit(2);
}
const here = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

/** The services: the bundle's name (OSTRA_BUNDLE, and <name>.mjs) and its source. */
const SERVICES: Record<string, string> = {
  signer: "src/signer.ts",
  gateway: "src/remote.ts",
  egress: "src/egress.ts",
  front: "src/front.ts",
  server: "src/server.ts",
};

const BANNER = [
  'import { createRequire as __ostraCreateRequire } from "node:module";',
  'import { fileURLToPath as __ostraFileURLToPath } from "node:url";',
  'import { dirname as __ostraDirname } from "node:path";',
  "const require = __ostraCreateRequire(import.meta.url);",
  "const __filename = __ostraFileURLToPath(import.meta.url);",
  "const __dirname = __ostraDirname(__filename);",
].join("\n");

/** The package directory a bundled file lies in (the last node_modules/<name> or node_modules/@scope/<name>), or null. */
function packageDir(input: string): string | null {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  return m === null ? null : resolve(m[1] as string);
}
const packages = new Set<string>();

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const [name, entry] of Object.entries(SERVICES)) {
  const file = join(out, `${name}.mjs`);
  const result = await build({
    entryPoints: [here(entry)],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    define: { OSTRA_BUNDLE: JSON.stringify(name) },
    banner: { js: BANNER },
    legalComments: "none",
    logLevel: "warning",
    metafile: true,
  });
  const outputs = Object.values(result.metafile.outputs);
  const output = outputs[0];
  if (outputs.length !== 1 || output === undefined) throw new Error(`${name}: esbuild wrote ${outputs.length} files`);
  for (const { path: spec } of output.imports) if (!isBuiltin(spec)) throw new Error(`${name}: the bundle imports ${spec}, which is not one of Node's own modules`);
  for (const input of Object.keys(result.metafile.inputs)) {
    const dir = packageDir(input);
    if (dir !== null) packages.add(dir);
  }
  const code = await readFile(file, "utf8");
  // The define replaced every OSTRA_BUNDLE; the bare name must be gone.
  if (/(^|[^\w])OSTRA_BUNDLE([^\w]|$)/m.test(code)) throw new Error(`${name}: OSTRA_BUNDLE was not replaced`);
  process.stdout.write(`${name}.mjs ${Math.round(code.length / 1024)} KB, ${Object.keys(result.metafile.inputs).length} modules\n`);
}
// One entry per package and version, its license files as they are (or its license field when it ships none).
const notices = new Map<string, string>();
for (const dir of packages) {
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: string; version?: string; license?: unknown };
  const id = `${pkg.name ?? dir}@${pkg.version ?? "?"}`;
  if (notices.has(id)) continue;
  const texts: string[] = [];
  for (const f of (await readdir(dir)).sort()) if (/^(licen[cs]e|copying|notice)/i.test(f)) texts.push(await readFile(join(dir, f), "utf8"));
  notices.set(id, texts.length > 0 ? texts.join("\n\n") : `License: ${JSON.stringify(pkg.license ?? "not stated")} (the package ships no license file)`);
}
const sections = [...notices.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, text]) => `${"=".repeat(80)}\n${id}\n${"=".repeat(80)}\n${text.trim()}\n`);
await writeFile(join(out, "THIRD-PARTY-NOTICES.txt"), `Third-party packages bundled into the Ostra Cloud services (${notices.size}).\n\n${sections.join("\n")}`);
process.stdout.write(`THIRD-PARTY-NOTICES.txt: ${notices.size} packages\n`);

const files = (await readdir(out)).sort();
const expected = [...Object.keys(SERVICES).map((n) => `${n}.mjs`), "THIRD-PARTY-NOTICES.txt"].sort();
if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error(`${out} holds ${files.join(", ")}, not ${expected.join(", ")}`);
