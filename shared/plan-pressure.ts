/**
 * Plan-usage pressure: when a provider plan window is nearly spent, compact
 * before the hard stop so resume after renewal stays cheap.
 *
 * Distinct from context-window thresholds in thresholds.ts — this axis is the
 * provider allowance (Claude and Codex five-hour / weekly windows), not the chat
 * token ceiling. Snapshot window ids may be namespaced as `claude:five_hour` /
 * `codex:five_hour` when both providers are recorded.
 */

import type { UsageSample } from "./usage.ts";

export interface PlanPressure {
  readonly pct: number;
  readonly windowId: string;
  readonly resetsAt: string | null;
}

/** Strip an optional `provider:` prefix before matching window kind. */
export function windowBaseId(windowId: string): string {
  const colon = windowId.indexOf(":");
  return colon === -1 ? windowId : windowId.slice(colon + 1);
}

/** Windows that matter for "am I about to hit the plan wall". */
export function isInterestingPlanWindow(windowId: string): boolean {
  const base = windowBaseId(windowId);
  if (base === "code_review") return false;
  return /^(five_hour|seven_day|weekly_)/.test(base);
}

/**
 * Highest plan % among active / interesting windows on a sample.
 * Returns null when the sample has nothing usable (e.g. Cursor-only installs).
 */
export function maxPlanPct(sample: UsageSample | null | undefined): PlanPressure | null {
  if (!sample) return null;
  let best: PlanPressure | null = null;
  for (const [windowId, window] of Object.entries(sample.windows)) {
    if (window.active === false) continue;
    if (!isInterestingPlanWindow(windowId)) continue;
    if (!Number.isFinite(window.pct)) continue;
    if (best === null || window.pct > best.pct) {
      best = { pct: window.pct, windowId, resetsAt: window.resetsAt };
    }
  }
  return best;
}

export function isPlanPressure(
  sample: UsageSample | null | undefined,
  thresholdPct: number,
): PlanPressure | null {
  const pressure = maxPlanPct(sample);
  if (pressure === null) return null;
  if (pressure.pct < thresholdPct) return null;
  return pressure;
}
