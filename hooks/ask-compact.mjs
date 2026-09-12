#!/usr/bin/env node
/**
 * A `Stop` hook that asks the session to compact itself — and nothing else.
 *
 * This is the piece that keeps compaction agent-mandated. The plugin never decides
 * to compact a session and never sends it a message to say so; it puts the question
 * at the one moment where acting on it is safe, and the agent answers with its own
 * tool call. What Paseo sends is the `/compact` the agent asked for.
 *
 * Asks fire for either context-window pressure (thresholds.compact) or Claude plan
 * pressure (planUsageCompactPct + planUsageMinTokens). Plan pressure emphasizes
 * resume-after-renewal checkpoints.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isEnrolled, occupancy, readSettings } from "./context.mjs";
import { pluginDir, stateAgeSeconds, statePath } from "./pointer.mjs";
import { readLedger, recordAsk, shouldAsk } from "./asks.mjs";
import { readNewestPlanPressure } from "./plan-usage.mjs";

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
 * The question for context-window pressure.
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
      `1. Your task state at ${path} is current, so this is cheap: call request_compaction with a one-line reason. If work remains, ask it to continue (and optionally choose the follow-up message); if the task is finished, ask it not to continue.`,
    );
  }

  lines.push(
    "2. Or, if this is the wrong moment — mid-refactor, a tool sequence half finished, an answer the user is waiting on — call defer_compaction with a reason and you will not be asked again for a while.",
    "Either way, do it now and then stop. A queued compaction is delivered as a real /compact once this session goes idle; a follow-up turn is sent only if you requested one.",
  );
  return lines.join("\n");
}

/**
 * Ask when the Claude *plan* window is nearly spent and this chat already holds
 * enough tokens that re-reading it through the reset would be expensive.
 */
function askForPlanPressure({ used, max, pct }, plan, path, age, freshMinutes) {
  const stale = age === null || age > freshMinutes * 60;
  const label = plan.windowId.includes(":")
    ? plan.windowId
    : plan.windowId;
  const reset =
    plan.resetsAt !== null
      ? ` Window ${label} resets at ${plan.resetsAt}.`
      : ` Window ${label} has no published reset time.`;
  const lines = [
    `Smart Compact (plan pressure): provider plan usage is at ${Math.round(plan.pct)}% (${label}).${reset}`,
    `This session already holds ${used.toLocaleString()} tokens (${pct}% of a ${max.toLocaleString()}-token context). Compacting now keeps a fat prefix from burning the remainder of the plan and makes resume after renewal cheap.`,
    "Compacting is your call. Do one of these before you stop:",
  ];

  if (stale) {
    lines.push(
      age === null
        ? `1. Call checkpoint with everything a resumed agent needs: goal, current step and its exact next action, decisions and why, dead ends. Then call request_compaction with reason "plan window near limit — preserve resume state".`
        : `1. Refresh the task state at ${path} with checkpoint (it is ${Math.round(age / 60)} minutes old), then call request_compaction with reason "plan window near limit — preserve resume state".`,
    );
  } else {
    lines.push(
      `1. Task state at ${path} is current. Call request_compaction with reason "plan window near limit — preserve resume state". Prefer continue_after_compaction so work can pick up after /compact; the follow-up should re-read the checkpoint Current step.`,
    );
  }

  lines.push(
    "2. Or call defer_compaction with a short reason if this is the wrong moment.",
    "After compaction, a one-shot resume heartbeat may fire when the plan window renews (smart-session mirrors chat-resume when that plugin cannot schedule yet).",
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
  if (now === null) return;

  const plan = readNewestPlanPressure();
  const planHit =
    plan !== null &&
    plan.pct >= settings.planUsageCompactPct &&
    now.used >= settings.planUsageMinTokens;
  const contextHit = now.pct >= now.profile.compact;
  if (!contextHit && !planHit) return;

  const ledger = readLedger(sessionId);
  if (!shouldAsk(ledger, now.pct)) return;

  const queue = compactions();
  if (alreadyQueued(queue, agentId)) return;

  const path = statePath();
  const age = stateAgeSeconds(path);
  let text;
  if (thrashing(queue, agentId)) {
    text = thrashAdvice(now);
  } else if (planHit) {
    text = askForPlanPressure(now, plan, path, age, settings.freshStateMinutes);
  } else {
    text = ask(now, path, age, settings.freshStateMinutes);
  }

  // Recorded only after it has reached stdout: a latch set on an ask that was never
  // delivered would silence the next one for nothing.
  emit(text);
  recordAsk(sessionId, ledger, now.pct);
}

void main();
