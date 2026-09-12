/**
 * When Claude plan usage is high, ensure enrolled agents with large contexts
 * get a plan-resume heartbeat scheduled for window reset.
 *
 * Runs on a slow timer; never asks agents to compact (that is ask-compact's job).
 */

import { readAgents, withDaemon, type AgentRow } from "./daemon.ts";
import { listEnrolment, listResumeMarks, readSettings } from "./settings.ts";
import { readContext, readPlanSnapshot, readUsage } from "./store.ts";
import { isPlanPressure, windowBaseId } from "../shared/plan-pressure.ts";
import { lifecycle } from "../shared/lifecycle.ts";
import { schedulePlanResume } from "./schedule-plan-resume.ts";
import { segmentBlocks, burnRatePctPerHour, type Block } from "../shared/blocks.ts";
import { computeResumeLeadMinutes, resumeAtFromLead } from "../shared/resume-timing.ts";
import { estimateCacheWritePct, estimateDollarsPerPlanPercent, type CostSample } from "../shared/cache-cost.ts";

const TICK_MS = 60_000;

/**
 * History window read to learn the $-per-plan-% ratio and to find the pressured
 * window's own recent points for the burn rate. Wide enough to hold several days
 * of context/usage samples without re-reading the world on every tick — this only
 * runs at all while a window is actually under pressure.
 */
const RATIO_HISTORY_MS = 14 * 24 * 60 * 60 * 1000;

interface Candidate {
  readonly agent: AgentRow;
  readonly cacheWritePct: number;
}

/** The block matching `windowId` (namespaced or not) with the most recent points. */
function findBlock(blocks: readonly Block[], windowId: string): Block | undefined {
  const matches = blocks.filter(
    (block) => block.windowId === windowId || windowBaseId(block.windowId) === windowBaseId(windowId),
  );
  return matches.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0];
}

async function tick(): Promise<void> {
  const settings = await readSettings();
  if (!settings.enabled) return;

  const newest = await readPlanSnapshot();
  const pressure = isPlanPressure(newest, settings.planUsageCompactPct);
  if (pressure === null) return;

  const enrolled = new Set(
    (await listEnrolment()).filter((row) => row.enrolled).map((row) => row.agentId),
  );
  if (enrolled.size === 0) return;

  const marks = await listResumeMarks();

  let agents: AgentRow[];
  try {
    agents = await withDaemon((client) => readAgents(client));
  } catch {
    return;
  }

  const eligible = agents.filter((agent) => {
    if (!enrolled.has(agent.id)) return false;
    if (agent.archived || agent.status === "closed") return false;
    const mark = marks[agent.id] ?? "auto";
    if (mark === "never") return false;
    if (mark === "always") return true;
    return agent.usedTokens !== null && agent.usedTokens >= settings.planUsageMinTokens;
  });
  if (eligible.length === 0) return;

  // Every candidate for this window shares one plan quota, so only the cheapest
  // one can plausibly be given a pre-reset slot; everyone else keeps the ordinary
  // post-reset heartbeat, unchanged from before this feature existed.
  let preResetTarget: (Candidate & { leadMinutesForWindow: number | null }) | null = null;
  if (settings.resumeSchedulingEnabled) {
    preResetTarget = await pickPreResetCandidate(eligible, pressure.windowId, settings);
  }

  for (const agent of eligible) {
    if (preResetTarget !== null && agent.id === preResetTarget.agent.id) {
      const leadMinutes = preResetTarget.leadMinutesForWindow;
      const scheduledAt = leadMinutes === null ? null : resumeAtFromLead(pressure.resetsAt ?? "", leadMinutes);
      if (scheduledAt !== null && leadMinutes !== null) {
        await schedulePlanResume({
          agentId: agent.id,
          windowId: pressure.windowId,
          planPct: pressure.pct,
          resetsAt: pressure.resetsAt,
          mode: "pre-reset",
          scheduledAt,
          leadMinutes,
          cacheWritePctEstimate: preResetTarget.cacheWritePct,
        });
        continue;
      }
    }
    await schedulePlanResume({
      agentId: agent.id,
      windowId: pressure.windowId,
      planPct: pressure.pct,
      resetsAt: pressure.resetsAt,
    });
  }
}

/**
 * The cheapest eligible candidate for a pre-reset slot, plus the lead time computed
 * for the pressured window's own burn rate. `null` when there is no usable burn
 * rate or the runway doesn't clear the cache-write cost for anyone.
 */
async function pickPreResetCandidate(
  eligible: readonly AgentRow[],
  windowId: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
): Promise<(Candidate & { leadMinutesForWindow: number | null }) | null> {
  const since = Date.now() - RATIO_HISTORY_MS;
  const [usageSamples, contextSamples] = await Promise.all([
    readUsage({ sinceMs: since }),
    readContext({ sinceMs: since }),
  ]);
  const blocks = segmentBlocks(usageSamples);
  const block = findBlock(blocks, windowId);
  if (block === undefined) return null;

  const burnPctPerMinute =
    (burnRatePctPerHour(block, settings.burnRateLookbackMinutes * 60_000) ?? 0) / 60;
  if (burnPctPerMinute <= 0) return null;

  const remainingPct = 100 - block.finalPct;
  const costSamples: CostSample[] = contextSamples.map((sample) => ({
    agentId: sample.agentId,
    at: sample.at,
    costUsd: sample.costUsd,
  }));
  const dollarsPerPercent = estimateDollarsPerPlanPercent(blocks, costSamples);

  const candidates: Candidate[] = eligible
    .filter((agent) => agent.usedTokens !== null)
    .map((agent) => ({
      agent,
      cacheWritePct: estimateCacheWritePct({
        tokens: agent.usedTokens!,
        model: agent.model,
        dollarsPerPercent,
        fallbackPct: settings.cacheWriteFallbackPct,
        pricingOverrides: settings.cachePricingUsdPerMTok,
      }),
    }))
    .sort((a, b) => a.cacheWritePct - b.cacheWritePct);

  const cheapest = candidates[0];
  if (cheapest === undefined) return null;

  const leadMinutesForWindow = computeResumeLeadMinutes({
    remainingPct,
    burnPctPerMinute,
    cacheWritePct: cheapest.cacheWritePct,
    overheadPct: settings.resumeOverheadPct,
    minLeadMinutes: settings.resumeMinLeadMinutes,
    maxLeadMinutes: settings.resumeMaxLeadMinutes,
  });

  return { ...cheapest, leadMinutesForWindow };
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
