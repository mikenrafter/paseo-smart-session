/**
 * Newest Claude plan-usage reading for Stop / PostToolUse hooks.
 *
 * The recorder writes `newest-usage.json` on every accepted sample so hooks
 * never open a daemon connection or re-parse a month of JSONL on the hot path.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pluginDir } from "./pointer.mjs";

const INTERESTING = /^(five_hour|seven_day|weekly_)/;

/**
 * @returns {{ pct: number, windowId: string, resetsAt: string | null } | null}
 */
export function readNewestPlanPressure() {
  let sample;
  try {
    sample = JSON.parse(readFileSync(join(pluginDir(), "newest-usage.json"), "utf8"));
  } catch {
    return null;
  }
  if (!sample || typeof sample !== "object" || !sample.windows) return null;

  let best = null;
  for (const [windowId, window] of Object.entries(sample.windows)) {
    if (!window || typeof window !== "object") continue;
    if (window.active === false) continue;
    const pct = typeof window.pct === "number" ? window.pct : Number.NaN;
    if (!Number.isFinite(pct)) continue;
    if (!INTERESTING.test(windowId) && !(pct > 0)) continue;
    if (best === null || pct > best.pct) {
      best = {
        pct,
        windowId,
        resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : null,
      };
    }
  }
  return best;
}
