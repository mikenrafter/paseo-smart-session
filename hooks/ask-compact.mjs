#!/usr/bin/env node
/**
 * A `Stop` hook that asks the session to compact itself — and nothing else.
 *
 * This is the piece that keeps compaction agent-mandated. The plugin never decides
 * to compact a session and never sends it a message to say so; it puts the question
 * at the one moment where acting on it is safe, and the agent answers with its own
 * tool call. What Paseo sends is the `/compact` the agent asked for.
 *
 * `Stop` is the right event for three reasons, all of them verified against Claude
 * Code 2.1.263 rather than assumed (`RESEARCH.md` §3.4):
 *
 *   - it fires at a turn boundary, which is exactly the moment the governor used to
 *     sit in a fifteen-second poll waiting for;
 *   - its `additionalContext` is documented as "non-error feedback delivered to the
 *     model; the conversation continues so the model can act on it", so the ask
 *     costs no extra turn and needs no `decision: "block"`; and
 *   - its payload carries `background_tasks`, which is how a hook tells "this
 *     session is done" from "this session is waiting on work still in flight".
 *
 * It stays completely silent unless there is something worth stopping for.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isEnrolled, occupancy, readSettings } from "./context.mjs";
import { pluginDir, stateAgeSeconds, statePath } from "./pointer.mjs";
import { readLedger, recordAsk, shouldAsk } from "./asks.mjs";

/**
 * A compaction that had to be repeated within minutes is not solving the problem —
 * something in the loop is refilling the window as fast as it is emptied, and
 * another compaction just burns tokens on summarizing. Claude Code detects the same
 * pathology and calls it thrashing.
 */
const THRASH_WINDOW_MS = 15 * 60_000;

/** The governor's queue, read directly: a hook must not open a daemon connection. */
function compactions() {
  try {
    const parsed = JSON.parse(readFileSync(join(pluginDir(), "compactions.json"), "utf8"));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

/** Already asked and waiting to be delivered: there is nothing to add. */
function alreadyQueued(items, agentId) {
  return items.some(
    (item) => item.agentId === agentId && (item.state === "pending" || item.state === "sending"),
  );
}

function thrashing(items, agentId, now = Date.now()) {
  return items.some(
    (item) =>
      item.agentId === agentId &&
      item.state === "sent" &&
      item.settledAt !== null &&
      now - Date.parse(item.settledAt) < THRASH_WINDOW_MS,
  );
}

/**
 * The question.
 *
 * On a large window the headline is the token count, not the percentage: "30% full"
 * sounds like there is plenty of room, and 300,000 tokens does not.
 *
 * It has to be answerable in one turn, so it names the tools and says what to do
 * with each, and it has to be refusable, or it is not a question — hence the
 * deferral, which the agent is told about in the same breath.
 */
function ask({ used, max, pct }, path, age, freshMinutes) {
  const stale = age === null || age > freshMinutes * 60;
  const lines = [
    `Smart Compact: this session holds ${used.toLocaleString()} tokens (${pct}% of a ${max.toLocaleString()}-token window).`,
    max >= 400_000
      ? "That is worth compacting now even though the window is nowhere near full — what costs you is the prefix re-read on every turn, not the ceiling."
      : "This is the point where recall degrades noticeably and every turn re-reads an expensive prefix.",
    "Compacting is your call, not this plugin's, and nothing will happen unless you ask. Do one of these before you stop:",
  ];

  if (stale) {
    lines.push(
      age === null
        ? `1. There is no task state on disk yet. Call checkpoint — goal, the step in progress and its exact next action, decisions and why, and every approach already tried and rejected — then call request_compaction. Anything you do not write down is gone after the compaction.`
        : `1. Your task state at ${path} was last written ${Math.round(age / 60)} minutes ago, so it may predate recent work. Call checkpoint to bring it up to date, then call request_compaction.`,
    );
  } else {
    lines.push(
      `1. Your task state at ${path} is current, so this is cheap: call request_compaction with a one-line reason. The continuation will be told to re-read that file and to trust it over the summary.`,
    );
  }

  lines.push(
    "2. Or, if this is the wrong moment — mid-refactor, a tool sequence half finished, an answer the user is waiting on — call defer_compaction with a reason and you will not be asked again for a while.",
    "Either way, do it now and then stop. A queued compaction is delivered as a real /compact once this session goes idle, and you will be told to pick up from your state file afterwards.",
  );
  return lines.join("\n");
}

/**
 * What to say instead, when compacting is not the answer.
 *
 * Said once, as an ask, so it counts against the same latch: repeating it every
 * turn would be the nagging this hook exists to avoid.
 */
function thrashAdvice({ used, pct }) {
  return [
    `Smart Compact: this session refilled to ${used.toLocaleString()} tokens (${pct}%) within minutes of its last compaction.`,
    "Compacting again would not help — something in this loop is reading far more than it keeps, so the window would refill just as fast and you would pay for another summary.",
    "Write what you have learned to your state file with checkpoint, then either change the approach so it stops re-reading the same material, or finish and let a fresh session take the rest.",
  ].join("\n");
}

function emit(text) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: text },
      suppressOutput: true,
    })}\n`,
  );
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

  // Claude Code overrides a hook that keeps a turn alive too many times in a row,
  // and tells you to check this flag. A second ask would also be arriving into the
  // turn the first one created, which is not a boundary at all.
  if (event.stop_hook_active === true) return;

  // Subagents have their own short-lived windows and their own stop conditions.
  if (event.agent_id !== undefined && event.agent_id !== null) return;

  // "Stopped" and "waiting for work that is still running" are different states.
  // Compacting through the second one discards the context that work reports into.
  if (Array.isArray(event.background_tasks) && event.background_tasks.length > 0) return;

  const transcriptPath = event.transcript_path;
  const sessionId = event.session_id;
  if (typeof transcriptPath !== "string" || typeof sessionId !== "string") return;

  const settings = readSettings();
  if (!settings.enabled) return;

  const agentId = process.env.PASEO_AGENT_ID ?? null;
  if (!isEnrolled(agentId, settings)) return;

  const now = occupancy(transcriptPath, settings);
  if (now === null || now.pct < now.profile.compact) return;

  const ledger = readLedger(sessionId);
  if (!shouldAsk(ledger, now.pct)) return;

  const queue = compactions();
  if (alreadyQueued(queue, agentId)) return;

  const path = statePath();
  const age = stateAgeSeconds(path);
  const text = thrashing(queue, agentId)
    ? thrashAdvice(now)
    : ask(now, path, age, settings.freshStateMinutes);

  // Recorded only after it has reached stdout: a latch set on an ask that was never
  // delivered would silence the next one for nothing.
  emit(text);
  recordAsk(sessionId, ledger, now.pct);
}

void main();
