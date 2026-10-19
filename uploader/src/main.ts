// Starts the uploader: the Pinata JWT from OSTRA_UPLOADER_SECRETS/pinata.jwt (mode 0600), the HTTP endpoint on
// OSTRA_UPLOADER_LISTEN (default 127.0.0.1:4800) and the daily byte budget OSTRA_UPLOADER_DAILY_BYTES (default
// 200 MB). Logs are JSON lines on stdout; the JWT is never printed.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Uploader, createUploaderServer } from "./server.ts";

function main(): void {
  const secrets = process.env.OSTRA_UPLOADER_SECRETS || "/etc/ostra/robinhood/uploader/secrets";
  const file = join(secrets, "pinata.jwt");
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${file} must have mode 0600 (it has ${mode.toString(8)})`);
  const jwt = readFileSync(file, "utf8").trim();
  const [host, portText] = (process.env.OSTRA_UPLOADER_LISTEN || "127.0.0.1:4800").split(":");
  const port = Number(portText);
  if (host === undefined || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("OSTRA_UPLOADER_LISTEN must be host:port");
  const dailyBytes = Number(process.env.OSTRA_UPLOADER_DAILY_BYTES || 200_000_000);
  if (!Number.isInteger(dailyBytes) || dailyBytes <= 0) throw new Error("OSTRA_UPLOADER_DAILY_BYTES must be a positive whole number");
  const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }).split(jwt).join("<jwt>"));
  const uploader = new Uploader({ jwt, dailyBytes, log });
  const server = createUploaderServer(uploader, log);
  server.listen(port, host, () => log("started", { listen: `${host}:${port}`, dailyBytes }));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

try {
  main();
} catch (err) {
  console.error(`uploader failed: ${(err as Error).message}`);
  process.exit(1);
}
