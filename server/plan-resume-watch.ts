/**
 * When Claude plan usage is high, ensure enrolled agents with large contexts
 * get a plan-resume heartbeat scheduled for window reset.
 *
 * Runs on a slow timer; never asks agents to compact (that is ask-compact's job).
 */

import { readAgents, withDaemon } from "./daemon.ts";
import { listEnrolment, readSettings } from "./settings.ts";
import { newestUsage } from "./store.ts";
import { isPlanPressure } from "../shared/plan-pressure.ts";
import { lifecycle } from "../shared/lifecycle.ts";
import { schedulePlanResume } from "./schedule-plan-resume.ts";

const TICK_MS = 60_000;

async function tick(): Promise<void> {
  const settings = await readSettings();
  if (!settings.enabled) return;

  const newest = await newestUsage();
  const pressure = isPlanPressure(newest, settings.planUsageCompactPct);
  if (pressure === null) return;

  const enrolled = new Set(
    (await listEnrolment()).filter((row) => row.enrolled).map((row) => row.agentId),
  );
  if (enrolled.size === 0) return;

  let agents;
  try {
    agents = await withDaemon((client) => readAgents(client));
  } catch {
    return;
  }

  for (const agent of agents) {
    if (!enrolled.has(agent.id)) continue;
    if (agent.usedTokens === null || agent.usedTokens < settings.planUsageMinTokens) continue;
    await schedulePlanResume({
      agentId: agent.id,
      windowId: pressure.windowId,
      planPct: pressure.pct,
      resetsAt: pressure.resetsAt,
    });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startPlanResumeWatch(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void tick().catch((error) => {
      console.warn(
        `[smart-session] plan-resume watch: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, TICK_MS);
  // Unref so the timer alone cannot keep the subprocess alive after teardown.
  timer.unref?.();
  lifecycle.teardowns.push(async () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  });
  void tick().catch(() => undefined);
}

// Start on import (same pattern as recorder / governor).
startPlanResumeWatch();
