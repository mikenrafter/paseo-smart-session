/**
 * Plan-usage pressure: when the Claude plan window is nearly spent, compact
 * before the hard stop so resume after renewal stays cheap.
 *
 * Distinct from context-window thresholds in thresholds.ts — this axis is the
 * provider allowance (five_hour / seven_day / scoped weeklies), not the chat
 * token ceiling.
 */

import type { UsageSample } from "./usage.ts";

export interface PlanPressure {
  readonly pct: number;
  readonly windowId: string;
  readonly resetsAt: string | null;
}

/** Windows that matter for "am I about to hit the plan wall". */
const INTERESTING = /^(five_hour|seven_day|weekly_)/;

/**
 * Highest plan % among active / interesting windows on a sample.
 * Returns null when the sample has nothing usable (e.g. Cursor-only installs).
 */
export function maxPlanPct(sample: UsageSample | null | undefined): PlanPressure | null {
  if (!sample) return null;
  let best: PlanPressure | null = null;
  for (const [windowId, window] of Object.entries(sample.windows)) {
    if (window.active === false) continue;
    if (!INTERESTING.test(windowId) && !(window.pct > 0)) continue;
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
