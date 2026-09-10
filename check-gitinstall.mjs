/** Proves both v0.8 runtime entries compile from a Git checkout with no node_modules. */
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOptions } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
console.log("Checking Git-install compatibility...");

function trackedFiles() {
  try {
    return new Set(
      execFileSync("git", ["ls-files"], { cwd: DIR, encoding: "utf8" })
        .split("\n")
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

const staging = mkdtempSync(join(tmpdir(), "smart-session-gitinstall-"));
const failures = [];
for (const name of execFileSync("find", ["server", "-type", "f"], { cwd: DIR, encoding: "utf8" })
  .split("\n")
  .filter((file) => /\.tsx?$/.test(file))) {
  if (/["']@getpaseo\/client/.test(readFileSync(join(DIR, name), "utf8"))) {
    failures.push(`${name}: literal @getpaseo/client type dependencies fail Paseo's Git installer`);
  }
}
try {
  for (const directory of ["client", "server", "shared"]) {
    mkdirSync(join(staging, directory), { recursive: true });
    cpSync(join(DIR, directory), join(staging, directory), { recursive: true });
  }
  for (const name of ["index.client.tsx", "index.server.ts", "paseo-plugin.json"]) {
    copyFileSync(join(DIR, name), join(staging, name));
  }

  for (const target of ["client", "server"]) {
    const entry = resolve(staging, `index.${target}.${target === "client" ? "tsx" : "ts"}`);
    try {
      await esbuild.build(buildOptions(entry, staging, target));
      console.log(`  ✓ ${target}: compiles with no installed dependencies`);
    } catch (error) {
      const messages = (error?.errors ?? []).map((item) => item.text);
      failures.push(`${target}: ${messages.length > 0 ? messages.join("; ") : String(error)}`);
    }
  }

  const tracked = trackedFiles();
  if (tracked !== null) {
    const required = [
      "index.client.tsx",
      "index.server.ts",
      ...["client", "server", "shared"].flatMap((directory) =>
        execFileSync("find", [directory, "-type", "f"], { cwd: DIR, encoding: "utf8" })
          .split("\n")
          .filter((name) => /\.[cm]?[jt]sx?$/.test(name)),
      ),
    ];
    const untracked = required.filter((name) => !tracked.has(relative(DIR, resolve(DIR, name))));
    if (untracked.length > 0) {
      console.log(`  ! not committed yet, so a Git install would miss: ${untracked.join(", ")}`);
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  rmSync(staging, { recursive: true, force: true });
}

for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) {
  console.error("Git-install check failed: `paseo plugin add` would not compile this plugin.");
  process.exitCode = 1;
} else {
  console.log("Git-install OK.");
}
