#!/usr/bin/env node
// The npm package's one command, ostra-mcp (so that `npx -y @ostraagent/mcp`
// finds it): the MCP server over stdio (server.ts), or with `backup` the
// encrypted backup of the master seed (backup-cli.ts), run by the owner in a
// terminal:
//
//   npx -y @ostraagent/mcp                         the MCP server
//   npx -y @ostraagent/mcp backup export <file>    the seed of OSTRA_HOME, encrypted
//   npx -y @ostraagent/mcp backup import <file>    the seed into a new OSTRA_HOME

if (process.argv[2] === "backup") {
  const { runBackup } = await import("./backup-cli.ts");
  await runBackup(process.argv.slice(3)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
} else {
  await import("./server.ts");
}
