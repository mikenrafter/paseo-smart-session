#!/usr/bin/env node
/**
 * A PostToolUse hook that tells the agent how full it is — but only when that has
 * just become worth saying.
 *
 * Sensing is useless if the agent has to remember to ask. This runs after every
 * tool call, stays completely silent below the first threshold, and injects one
 * short line the moment context crosses 60%, 75% or 85%. Each level fires once per
 * compaction epoch, so a long session gets three sentences, not three hundred.
 *
 * It reads the transcript rather than asking Paseo, so it works in any Claude Code
 * session, and it reads only the tail of it, because this runs on the hot path.
 */

import { openSync, readSync, fstatSync, closeSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { clearPending, readPending } from "./pointer.mjs";

/** Enough tail to contain the last assistant message in any realistic transcript. */
const TAIL_BYTES = 256 * 1024;

/**
 * Defaults mirroring thresholds.shared.ts, used when the plugin has not written a
 * settings file yet. Kept in sync by a test that runs this hook and checks where it
 * fires against the shared module's numbers.
 *
 * Two profiles because a percentage of the window is the wrong unit on its own:
 * what tires a context is the absolute prefix re-read every turn, so 30% of a
 * million tokens is a heavier context than 85% of two hundred thousand.
 */
const DEFAULT_THRESHOLDS = {
  largeWindowFrom: 400_000,
  large: { notice: 15, closing: 22, compact: 30 },
  small: { notice: 60, closing: 75, compact: 85 },
};

const BANDS = ["notice", "closing", "compact"];

/** The plugin's settings are the single source of truth when they exist. */
function readThresholds() {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir(), "..", "settings.json"), "utf8"));
    const merged = { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) };
    return {
      largeWindowFrom: merged.largeWindowFrom ?? DEFAULT_THRESHOLDS.largeWindowFrom,
      large: { ...DEFAULT_THRESHOLDS.large, ...(merged.large ?? {}) },
      small: { ...DEFAULT_THRESHOLDS.small, ...(merged.small ?? {}) },
    };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

function profileFor(maxTokens, thresholds) {
  return maxTokens >= thresholds.largeWindowFrom ? thresholds.large : thresholds.small;
}

function stateDir() {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "smart-session", "thresholds");
}

/**
 * Context occupancy from the last assistant message's usage.
 *
 * input + cache_read + cache_creation + output is the same arithmetic Claude Code
 * itself documents for a resumed session's `context_tokens`, so it is the
 * sanctioned way to ask "how much of the window is currently occupied".
 */
function readContextTokens(transcriptPath) {
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");

    // Backwards: the newest assistant message wins, and a partial first line from
    // slicing mid-file simply fails to parse and is skipped.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line === undefined || line === "" || !line.includes('"usage"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "assistant") continue;
      // A subagent's usage is its own window, not the main thread's.
      if (entry.isSidechain === true) continue;
      const usage = entry.message?.usage;
      if (usage === undefined) continue;
      const used =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.output_tokens ?? 0);
      return { used, model: entry.message?.model ?? null };
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Models whose context window is not the current default of 1M.
 *
 * The transcript records the resolved model id (`claude-opus-5`), never the config
 * alias (`opus[1m]`), so the suffix is not a signal. Every current Opus, Sonnet and
 * Fable model has a 1M window; Haiku and the older generations do not.
 */
const SMALL_WINDOW = /haiku|-3-|sonnet-3|opus-3|sonnet-4-5|opus-4-5|sonnet-4-20|opus-4-20/;

/**
 * The window size for this session.
 *
 * Getting this wrong is worse than not warning at all: assuming 200k on a 1M
 * session warns at a fifth of the real occupancy and reports negative headroom.
 * So the first choice is what Paseo actually measured for this agent — recorded by
 * the plugin, read from the tail of its log — and the model table is the fallback.
 */
function windowFor(model) {
  const override = Number(process.env.SMART_SESSION_CONTEXT_WINDOW ?? "");
  if (Number.isFinite(override) && override > 0) return override;

  const recorded = recordedWindow();
  if (recorded !== null) return recorded;

  if (typeof model === "string" && SMALL_WINDOW.test(model)) return 200_000;
  return 1_000_000;
}

/**
 * The window size Paseo reported for this agent, from the recorder's own log.
 *
 * Read from the tail, like the transcript: this is the hot path, and the newest row
 * is the only one that matters.
 */
function recordedWindow() {
  const agentId = process.env.PASEO_AGENT_ID;
  if (agentId === undefined || agentId === "") return null;
  const month = new Date().toISOString().slice(0, 7);
  const path = join(stateDir(), "..", `context-${month}.jsonl`);

  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line === undefined || !line.includes(agentId)) continue;
      try {
        const row = JSON.parse(line);
        if (row.agentId === agentId && typeof row.maxTokens === "number" && row.maxTokens > 0) {
          return row.maxTokens;
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The state file this session's own tools write to, so the advice can name it. */
function statePathForAgent() {
  const agentId = process.env.PASEO_AGENT_ID;
  if (agentId === undefined || agentId === "") return null;
  return join(stateDir(), "..", "state", `${agentId}.md`);
}

function readLatch(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { fired: [], lastUsed: 0 };
  }
}

function writeLatch(path, latch) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(latch), "utf8");
  } catch {
    // A hook that cannot persist its latch must still not break the turn.
  }
}

/**
 * `pct` is the real occupancy and goes in the message; `level` is the threshold
 * just crossed and chooses how urgent the advice is. Reporting the threshold as
 * the occupancy — which this did at first — understates a session that jumped
 * straight past a level.
 */
/**
 * `band` chooses the urgency; `pct` and `used` describe the situation.
 *
 * On a large window the headline is the token count, not the percentage: "30% full"
 * sounds like there is plenty of room, and 300,000 tokens does not.
 */
function advice(band, pct, used, max, statePath) {
  const large = max >= DEFAULT_THRESHOLDS.largeWindowFrom;
  const lines = [
    `Context holds ${used.toLocaleString()} tokens (${pct}% of a ${max.toLocaleString()}-token window).`,
  ];

  if (band === "compact") {
    lines.push(
      large
        ? "That is a large enough context to be worth compacting now, even though the window is nowhere near full — what costs you is the prefix re-read on every turn, not the ceiling. Finish the step you are on, make sure your durable task state is on disk, and compact at the first clean boundary."
        : "This is the point where recall degrades noticeably and every turn re-reads an expensive prefix. Finish the step you are on, write your durable task state to disk, and compact at the first clean boundary — do not start a new large step first.",
    );
  } else if (band === "closing") {
    lines.push(
      "Start closing out the current step rather than opening a new one. Make sure your durable task state — goal, current step and its next action, decisions and why, and every approach already tried and rejected — is written to disk, not only held in this conversation.",
    );
  } else {
    lines.push(
      "Nothing is wrong yet. This is the moment to make sure your task state is on disk, so that compacting later is cheap rather than lossy.",
    );
  }

  if (statePath !== null) lines.push(`Your state file for this task: ${statePath}`);
  else lines.push("If you have not chosen a state file for this task yet, choose one now and write to it.");
  return lines.join(" ");
}

async function main() {
  const raw = await new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => resolve(input));
  });

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return; // Not our business to complain about a malformed event.
  }

  // Subagents have their own short-lived windows and their own stop conditions;
  // warning them about the main thread's occupancy would be noise.
  if (event.agent_id !== undefined && event.agent_id !== null) return;
  const transcriptPath = event.transcript_path;
  const sessionId = event.session_id;
  if (typeof transcriptPath !== "string" || typeof sessionId !== "string") return;

  // A compaction may have left a state-file pointer that no other hook could
  // deliver. Said first, because it changes what the agent thinks it knows.
  const parts = [];
  const pending = readPending(sessionId);
  if (pending !== null) parts.push(pending);

  const reading = readContextTokens(transcriptPath);
  if (reading === null) return emit(sessionId, parts, pending);

  const max = windowFor(reading.model);
  const pct = Math.floor((reading.used / max) * 100);
  const profile = profileFor(max, readThresholds());

  const latchPath = join(stateDir(), `${sessionId}.json`);
  const latch = readLatch(latchPath);

  // A compaction resets the epoch: the window emptied, so the warnings should be
  // available again. Detected as a large drop rather than any drop, because usage
  // wobbles by a few tokens between turns.
  if (latch.lastUsed > 0 && reading.used < latch.lastUsed * 0.6) latch.fired = [];
  latch.lastUsed = reading.used;

  const reached = BANDS.filter((band) => pct >= profile[band]);
  const crossed = reached.filter((band) => !latch.fired.includes(band));
  if (crossed.length === 0) {
    writeLatch(latchPath, latch);
    return emit(sessionId, parts, pending);
  }

  // A session that jumped two bands in one turn hears the more urgent one.
  const band = crossed[crossed.length - 1];
  latch.fired = [...new Set([...latch.fired, ...crossed])];
  writeLatch(latchPath, latch);

  const statePath = process.env.SMART_SESSION_STATE_FILE ?? statePathForAgent();
  parts.push(advice(band, pct, reading.used, max, statePath));
  return emit(sessionId, parts, pending);
}

/**
 * Writes whatever there is to say, and only then forgets the pending pointer:
 * clearing it before it reaches stdout would lose it on any later failure.
 */
function emit(sessionId, parts, pending) {
  if (parts.length === 0) return;
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: parts.join("\n\n") },
      suppressOutput: true,
    })}\n`,
  );
  if (pending !== null) clearPending(sessionId);
}

void main();
