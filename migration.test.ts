import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { migrateLegacyData } from "./store.server.ts";

test("the v0.1 data directory moves intact to Smart Session", () => {
  const home = mkdtempSync(join(tmpdir(), "smart-session-migration-"));
  const legacy = join(home, "plugin-data", "super-session");
  const current = join(home, "plugin-data", "smart-session");
  mkdirSync(join(legacy, "state"), { recursive: true });
  writeFileSync(join(legacy, "usage-2026-09.jsonl"), '{"at":"kept"}\n', "utf8");
  writeFileSync(join(legacy, "state", "agent.md"), "authoritative state\n", "utf8");

  migrateLegacyData(home);

  assert.equal(existsSync(legacy), false);
  assert.equal(readFileSync(join(current, "usage-2026-09.jsonl"), "utf8"), '{"at":"kept"}\n');
  assert.equal(readFileSync(join(current, "state", "agent.md"), "utf8"), "authoritative state\n");
});

test("migration never combines two non-empty data directories", () => {
  const home = mkdtempSync(join(tmpdir(), "smart-session-migration-conflict-"));
  const legacy = join(home, "plugin-data", "super-session");
  const current = join(home, "plugin-data", "smart-session");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(current, { recursive: true });
  writeFileSync(join(legacy, "settings.json"), "legacy", "utf8");
  writeFileSync(join(current, "settings.json"), "current", "utf8");

  migrateLegacyData(home);

  assert.equal(readFileSync(join(legacy, "settings.json"), "utf8"), "legacy");
  assert.equal(readFileSync(join(current, "settings.json"), "utf8"), "current");
});
