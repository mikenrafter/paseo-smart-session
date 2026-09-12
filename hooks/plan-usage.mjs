/**
 * Newest plan-usage reading for Stop / PostToolUse hooks.
 *
 * The recorder writes a merged `newest-usage.json` (Claude + Codex windows,
 * namespaced as `provider:window`) so hooks never open a daemon connection.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pluginDir } from "./pointer.mjs";

function windowBaseId(windowId) {
  const colon = windowId.indexOf(":");
  return colon === -1 ? windowId : windowId.slice(colon + 1);
}

function isInteresting(windowId) {
  const base = windowBaseId(windowId);
  if (base === "code_review") return false;
  return /^(five_hour|seven_day|weekly_)/.test(base);
}

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
    if (!isInteresting(windowId)) continue;
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
