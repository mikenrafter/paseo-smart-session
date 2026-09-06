import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { smartCompactLabel } from "./format.shared.ts";

/**
 * A fresh, isolated `$PASEO_HOME`, then a fresh copy of the module under test.
 *
 * `dataDir()` reads the environment on every call, but settings.server.ts caches
 * the settings it has already read, so each case takes its own module instance
 * rather than reaching for the cache-clearing hatch.
 */
async function withHome(): Promise<{
  home: string;
  settings: typeof import("./settings.server.ts");
  checkpoint(agentId: string): void;
}> {
  const home = mkdtempSync(join(tmpdir(), "ss-enrol-"));
  process.env.PASEO_HOME = home;
  const stateDir = join(home, "plugin-data", "smart-session", "state");
  mkdirSync(stateDir, { recursive: true });
  return {
    home,
    settings: (await import(`./settings.server.ts?case=${home}`)) as typeof import("./settings.server.ts"),
    checkpoint(agentId: string) {
      writeFileSync(join(stateDir, `${agentId}.md`), "# Task state\n", "utf8");
    },
  };
}

test("writing task state enrols an agent, without anyone saying so", async () => {
  const { settings, checkpoint } = await withHome();
  assert.deepEqual(await settings.listEnrolment(), []);

  checkpoint("agent-1");
  assert.deepEqual(await settings.listEnrolment(), [
    { agentId: "agent-1", enrolled: true, explicit: false },
  ]);
  assert.equal(await settings.countEnrolled(), 1);
});

test("an explicit answer outranks the state file, both ways round", async () => {
  const { settings, checkpoint } = await withHome();
  checkpoint("has-state");

  // The whole point of the pill: taking a checkpointing session out again.
  await settings.setEnrolled("has-state", false);
  const off = await settings.listEnrolment();
  assert.deepEqual(off, [{ agentId: "has-state", enrolled: false, explicit: true }]);
  assert.equal(await settings.countEnrolled(), 0);

  // And enrolling one that has never checkpointed. The governor asks it to write
  // state before it compacts anything, so this is safe to say up front.
  await settings.setEnrolled("no-state", true);
  const both = await settings.listEnrolment();
  assert.equal(both.length, 2);
  assert.deepEqual(
    both.find((agent) => agent.agentId === "no-state"),
    { agentId: "no-state", enrolled: true, explicit: true },
  );
  assert.equal(await settings.countEnrolled(), 1);
});

test("an agent is listed once, however it got there", async () => {
  const { settings, checkpoint } = await withHome();
  checkpoint("agent-1");
  await settings.setEnrolled("agent-1", true);
  assert.deepEqual(await settings.listEnrolment(), [
    { agentId: "agent-1", enrolled: true, explicit: true },
  ]);
});

test("concurrent toggles do not lose one another", async () => {
  // Read-modify-write over one file: without serialization the last writer wins
  // and the other agent's answer disappears.
  const { settings, home } = await withHome();
  await Promise.all([
    settings.setEnrolled("agent-1", true),
    settings.setEnrolled("agent-2", true),
    settings.setEnrolled("agent-3", false),
  ]);
  const written = JSON.parse(
    readFileSync(join(home, "plugin-data", "smart-session", "enrolment.json"), "utf8"),
  ) as Record<string, boolean>;
  assert.deepEqual(written, { "agent-1": true, "agent-2": true, "agent-3": false });
});

test("a corrupt overrides file costs the overrides, not the plugin", async () => {
  const { settings, home, checkpoint } = await withHome();
  checkpoint("agent-1");
  writeFileSync(join(home, "plugin-data", "smart-session", "enrolment.json"), "{ not json", "utf8");
  assert.deepEqual(await settings.listEnrolment(), [
    { agentId: "agent-1", enrolled: true, explicit: false },
  ]);
});

test("the pill tells enrolled-but-nothing-will-happen from enrolled", () => {
  assert.equal(smartCompactLabel({ enrolled: true, autopilot: true }), "Smart compact on");
  // Enrolled while autopilot is off globally: still nothing is going to compact it.
  assert.equal(smartCompactLabel({ enrolled: true, autopilot: false }), "Smart compact paused");
  assert.equal(smartCompactLabel({ enrolled: false, autopilot: true }), "Smart compact off");
});
