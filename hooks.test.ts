import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { DEFAULT_THRESHOLDS, profileFor } from "./thresholds.shared.ts";

const execFileAsync = promisify(execFile);

/** A transcript whose last assistant message occupies `used` tokens. */
function transcript(dir: string, used: number, model: string): string {
  const path = join(dir, "transcript.jsonl");
  const line = JSON.stringify({
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-09-05T12:00:00.000Z",
    message: {
      model,
      usage: { input_tokens: 2, cache_read_input_tokens: used - 2, cache_creation_input_tokens: 0, output_tokens: 0 },
    },
  });
  writeFileSync(path, `${line}\n`, "utf8");
  return path;
}

async function runHook(
  script: string,
  event: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<string> {
  const child = execFileAsync(process.execPath, [script], {
    env: { ...process.env, PASEO_HOME: env.PASEO_HOME ?? mkdtempSync(join(tmpdir(), "ss-hook-")), ...env },
  });
  child.child.stdin?.end(JSON.stringify(event));
  const { stdout } = await child;
  return stdout.trim();
}

async function adviceFrom(output: string): Promise<string> {
  const parsed = JSON.parse(output) as { hookSpecificOutput: { additionalContext: string } };
  return parsed.hookSpecificOutput.additionalContext;
}

test("a 1M session is measured against its real window, not a guessed 200k one", async () => {
  // The bug this exists for: assuming 200k on a 1M session reported 195% full and
  // negative headroom.
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const path = transcript(dir, 390_000, "claude-opus-5");
  const advice = await adviceFrom(
    await runHook("hooks/context-threshold.mjs", { session_id: "s1", transcript_path: path, cwd: dir }),
  );
  assert.match(advice, /1,000,000-token window/);
  assert.match(advice, /39%/);
  // Specifically a negative token count — the old bug printed "-193,009".
  // A bare /-\d/ would also match the hyphens in a UUID in the state-file path.
  assert.doesNotMatch(advice, /-\d{1,3},\d{3}/, "never negative headroom");
});

test("a big window asks for compaction far earlier, in percentage terms", async () => {
  // 300k is the point on a 1M window; 300k is not even reachable on a 200k one,
  // which is why the bands cannot be one set of percentages.
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const large = await adviceFrom(
    await runHook("hooks/context-threshold.mjs", {
      session_id: "big",
      transcript_path: transcript(dir, 310_000, "claude-opus-5"),
      cwd: dir,
    }),
  );
  assert.match(large, /worth compacting now/, "31% of a million is already the moment");

  const smallDir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const small = await adviceFrom(
    await runHook("hooks/context-threshold.mjs", {
      session_id: "small",
      transcript_path: transcript(smallDir, 130_000, "claude-haiku-4-5-20251001"),
      cwd: smallDir,
    }),
  );
  // 65% of 200k is 130k — more than a third of the window used, and still fine.
  assert.match(small, /Nothing is wrong yet/);
});

test("a small window is left alone until it is genuinely full", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const advice = await adviceFrom(
    await runHook("hooks/context-threshold.mjs", {
      session_id: "s2",
      transcript_path: transcript(dir, 175_000, "claude-haiku-4-5-20251001"),
      cwd: dir,
    }),
  );
  assert.match(advice, /87% of a 200,000-token window/);
  assert.match(advice, /recall degrades/);
});

test("each band fires once, then stays quiet", async () => {
  const home = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const path = transcript(dir, 700_000, "claude-opus-5");
  const event = { session_id: "s3", transcript_path: path, cwd: dir };

  const first = await runHook("hooks/context-threshold.mjs", event, { PASEO_HOME: home });
  assert.match(first, /70% of a 1,000,000-token window/);
  const second = await runHook("hooks/context-threshold.mjs", event, { PASEO_HOME: home });
  assert.equal(second, "", "the same band does not fire twice");
});

test("the hook and the plugin agree on where the bands are", async () => {
  // The hook is a standalone script and cannot import the shared module, so it
  // carries its own copy of the defaults. This is what stops the two drifting.
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  for (const [max, model] of [
    [1_000_000, "claude-opus-5"],
    [200_000, "claude-haiku-4-5-20251001"],
  ] as const) {
    const profile = profileFor(max, DEFAULT_THRESHOLDS);
    // Just below the first band: silent. Just above: speaks.
    const below = await runHook("hooks/context-threshold.mjs", {
      session_id: `below-${max}`,
      transcript_path: transcript(dir, Math.floor(max * (profile.notice / 100)) - 5_000, model),
      cwd: dir,
    });
    assert.equal(below, "", `silent below ${profile.notice}% of ${max}`);

    const above = await runHook("hooks/context-threshold.mjs", {
      session_id: `above-${max}`,
      transcript_path: transcript(dir, Math.ceil(max * (profile.notice / 100)) + 5_000, model),
      cwd: dir,
    });
    assert.notEqual(above, "", `speaks above ${profile.notice}% of ${max}`);
  }
});

test("settings on disk override the hook's built-in bands", async () => {
  const home = mkdtempSync(join(tmpdir(), "ss-hook-"));
  mkdirSync(join(home, "plugin-data", "super-session"), { recursive: true });
  writeFileSync(
    join(home, "plugin-data", "super-session", "settings.json"),
    JSON.stringify({ thresholds: { large: { notice: 5, closing: 6, compact: 7 } } }),
    "utf8",
  );
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const advice = await adviceFrom(
    await runHook(
      "hooks/context-threshold.mjs",
      { session_id: "cfg", transcript_path: transcript(dir, 100_000, "claude-opus-5"), cwd: dir },
      { PASEO_HOME: home },
    ),
  );
  assert.match(advice, /worth compacting now/, "10% of a million, under a 7% compact band");
});

test("a subagent's usage is not mistaken for the main thread's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const path = join(dir, "transcript.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        message: { model: "claude-opus-5", usage: { input_tokens: 1000 } },
      }),
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        message: { model: "claude-opus-5", usage: { input_tokens: 950_000 } },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  const output = await runHook("hooks/context-threshold.mjs", { session_id: "s4", transcript_path: path, cwd: dir });
  assert.equal(output, "", "the subagent's near-full window is its own, not ours");
});

test("the hook says nothing about a session it cannot read", async () => {
  const output = await runHook("hooks/context-threshold.mjs", {
    session_id: "s5",
    transcript_path: "/nonexistent/transcript.jsonl",
    cwd: "/tmp",
  });
  assert.equal(output, "");
});

test("PostCompact records and leaves a pointer, but never speaks itself", async () => {
  // Claude Code's hook-output schema has no PostCompact variant: anything this
  // returns in hookSpecificOutput is rejected wholesale, taking the pointer with
  // it. Verified in production — the compaction that fired this hook printed
  // "Hook JSON output validation failed" and injected nothing.
  const home = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const output = await runHook(
    "hooks/post-compact.mjs",
    { hook_event_name: "PostCompact", session_id: "s6", transcript_path: "/tmp/x", cwd: "/tmp", trigger: "manual", compact_summary: "..." },
    { PASEO_HOME: home, PASEO_AGENT_ID: "agent-1" },
  );
  assert.equal(output, "", "PostCompact must stay silent rather than emit output the host rejects");

  const pending = JSON.parse(readFileSync(join(home, "plugin-data", "super-session", "pointers", "agent-1.json"), "utf8")) as {
    text: string;
  };
  assert.match(pending.text, /No durable state file exists yet/);
  assert.match(pending.text, /agent-1\.md/);

  const events = readFileSync(join(home, "plugin-data", "super-session", "compaction-events.jsonl"), "utf8").trim();
  assert.match(events, /"event":"PostCompact"/);
});

test("SessionStart on compact delivers the pointer and consumes it", async () => {
  const home = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const statePath = join(home, "state.md");
  writeFileSync(statePath, "# Task state\n", "utf8");

  const advice = await adviceFrom(
    await runHook(
      "hooks/post-compact.mjs",
      { hook_event_name: "SessionStart", session_id: "s7", transcript_path: "/tmp/x", cwd: "/tmp", source: "compact" },
      { PASEO_HOME: home, PASEO_AGENT_ID: "agent-2", SUPER_SESSION_STATE_FILE: statePath },
    ),
  );
  assert.match(advice, /Durable task state for this session is at/);
  assert.match(advice, /the file is correct/);
  // Not deleted but marked: PostCompact fires just after and must know this was
  // already said.
  const note = JSON.parse(readFileSync(join(home, "plugin-data", "super-session", "pointers", "agent-2.json"), "utf8")) as {
    delivered?: boolean;
  };
  assert.equal(note.delivered, true);
});

test("SessionStart for any other reason says nothing", async () => {
  for (const source of ["startup", "resume", "clear", "fork"]) {
    const output = await runHook(
      "hooks/post-compact.mjs",
      { hook_event_name: "SessionStart", session_id: "s8", transcript_path: "/tmp/x", cwd: "/tmp", source },
      { PASEO_AGENT_ID: "agent-3" },
    );
    assert.equal(output, "", `SessionStart:${source} is not a compaction`);
  }
});

test("a pointer PostCompact could not deliver is delivered by the next tool call", async () => {
  const home = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const env = { PASEO_HOME: home, PASEO_AGENT_ID: "agent-4" };
  await runHook(
    "hooks/post-compact.mjs",
    { hook_event_name: "PostCompact", session_id: "s9", transcript_path: "/tmp/x", cwd: "/tmp", trigger: "auto" },
    env,
  );

  // An empty window: the threshold hook has nothing of its own to say, so this
  // proves the pointer rides the PostToolUse channel on its own.
  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const path = transcript(dir, 1_000, "claude-opus-5");
  const event = { session_id: "s9", transcript_path: path, cwd: dir };
  const advice = await adviceFrom(await runHook("hooks/context-threshold.mjs", event, env));
  assert.match(advice, /No durable state file exists yet/);

  // And exactly once: a pointer repeated every tool call would be noise.
  assert.equal(await runHook("hooks/context-threshold.mjs", event, env), "");
});

test("the two compaction events deliver the pointer once between them", async () => {
  // Measured ordering on a real compaction: SessionStart:compact fires ~55ms
  // before PostCompact. Without the delivered marker the later event queues a
  // note the next tool call repeats, so the agent hears it twice.
  const home = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const statePath = join(home, "state.md");
  writeFileSync(statePath, "# Task state\n", "utf8");
  const env = { PASEO_HOME: home, PASEO_AGENT_ID: "agent-5", SUPER_SESSION_STATE_FILE: statePath };
  const base = { session_id: "s10", transcript_path: "/tmp/x", cwd: "/tmp" };

  const spoken = await runHook("hooks/post-compact.mjs", { ...base, hook_event_name: "SessionStart", source: "compact" }, env);
  assert.match(await adviceFrom(spoken), /Durable task state/);

  await runHook("hooks/post-compact.mjs", { ...base, hook_event_name: "PostCompact", trigger: "manual" }, env);

  const dir = mkdtempSync(join(tmpdir(), "ss-hook-"));
  const transcriptPath = transcript(dir, 1_000, "claude-opus-5");
  const repeat = await runHook("hooks/context-threshold.mjs", { ...base, transcript_path: transcriptPath, cwd: dir }, env);
  assert.equal(repeat, "", "the pointer must not be said a second time");
});
