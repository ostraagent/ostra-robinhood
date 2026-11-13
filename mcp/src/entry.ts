// Which service a process runs. From source each service is a file of its own, run by node by its path, so a module
// is the program when its URL is the script's (also through a symlinked bin). In Ostra Cloud's image the services are
// bundled (scripts/cloud-bundle.ts), one file each, and every module in a bundle shares that file's URL: the bundle
// names its service (esbuild's define of OSTRA_BUNDLE), and only that service's module starts.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

declare const OSTRA_BUNDLE: string | undefined;

/** The service this bundle runs (signer, gateway, egress, front or server), or null when running from source. */
export const bundled: string | null = typeof OSTRA_BUNDLE === "undefined" ? null : OSTRA_BUNDLE;

/** True when the module at `moduleUrl`, the service `service`, is the program node runs. */
export function isEntry(service: string, moduleUrl: string): boolean {
  if (bundled !== null) return bundled === service;
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
}
