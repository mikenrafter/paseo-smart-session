/**
 * Proves `mcp.mjs` can reach a daemon client on a managed Git install: a checkout
 * with no `node_modules` of its own, where `@getpaseo/client` exists only inside
 * the globally installed `paseo` CLI's own dependency tree.
 *
 * This is the exact layout that broke on a real VM install: the direct bare
 * specifier resolves in a dev checkout (which has `@getpaseo/client` as a
 * devDependency) but not in a Git install, so this check must run with none of
 * this repo's own `node_modules` visible — hence the copy into an isolated
 * staging directory rather than a run from `DIR` itself.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
console.log("Checking mcp.mjs daemon-client resolution on a Git install...");

const staging = mkdtempSync(join(tmpdir(), "smart-session-mcp-resolve-"));
const failures = [];
try {
  // The checkout: only what a Git install actually ships, no node_modules.
  const checkout = join(staging, "checkout");
  mkdirSync(checkout, { recursive: true });
  for (const name of ["mcp.mjs", "hooks", "server/daemon-password.mjs"]) {
    cpSync(join(DIR, name), join(checkout, name), { recursive: true });
  }

  // A stand-in for the machine's global @getpaseo/cli install: a `paseo`
  // executable whose real package tree has its own @getpaseo/client.
  const cli = join(staging, "cli");
  const clientDist = join(cli, "node_modules", "@getpaseo", "client", "dist");
  mkdirSync(join(cli, "bin"), { recursive: true });
  mkdirSync(clientDist, { recursive: true });
  writeFileSync(join(cli, "bin", "paseo"), "#!/usr/bin/env node\n");
  writeFileSync(
    join(cli, "node_modules", "@getpaseo", "client", "package.json"),
    JSON.stringify({
      name: "@getpaseo/client",
      version: "0.0.0-stub",
      type: "module",
      exports: { "./internal/daemon-client": { default: "./dist/daemon-client.js" } },
    }),
  );
  writeFileSync(
    join(clientDist, "daemon-client.js"),
    // A sentinel rejection, not a real connection: this only needs to prove the
    // module resolved and its class was reached, not that a daemon is running.
    [
      "export class DaemonClient {",
      "  constructor() {}",
      '  async connect() { throw new Error("CHECK_SENTINEL_CONNECT_REACHED"); }',
      "  async close() {}",
      "}",
    ].join("\n"),
  );

  const result = execFileSync(
    process.execPath,
    [join(checkout, "mcp.mjs")],
    {
      cwd: checkout,
      encoding: "utf8",
      // No ancestor of `staging` has a node_modules with @getpaseo/client, so the
      // bare specifier import can only succeed through the PATH fallback.
      env: { ...process.env, PATH: [join(cli, "bin"), ...(process.env.PATH ?? "").split(delimiter)].join(delimiter) },
      input:
        [
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } },
          }),
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "budget_status", arguments: {} } }),
        ].join("\n") + "\n",
      timeout: 15_000,
    },
  );

  const lines = result.trim().split("\n");
  const response = JSON.parse(lines[lines.length - 1]);
  const text = response?.result?.content?.[0]?.text ?? "";
  if (text.includes("Cannot find package")) {
    failures.push(`resolution fell through to the direct specifier and failed: ${text}`);
  } else if (!text.includes("CHECK_SENTINEL_CONNECT_REACHED")) {
    failures.push(`unexpected response, resolution may not have reached the stub client: ${text}`);
  } else {
    console.log("  ✓ mcp.mjs resolves @getpaseo/client via the paseo CLI on PATH with no local node_modules");
  }
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  rmSync(staging, { recursive: true, force: true });
}

for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) {
  console.error("mcp.mjs Git-install resolution check failed.");
  process.exitCode = 1;
} else {
  console.log("mcp.mjs resolution OK.");
}
