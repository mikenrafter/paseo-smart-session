/**
 * How long before a plan window resets to resume a compacted agent, so it burns
 * the window's last sliver of quota instead of losing it to the reset.
 *
 * Distinct from `server/schedule-plan-resume.ts`'s existing post-reset heartbeat,
 * which fires a couple of minutes *after* `resetsAt` for the ordinary case. This is
 * the earlier one: given the recent burn rate and the headroom left when the agent
 * stopped, work out how much of that headroom can still be spent before the window
 * rolls over, after paying for the cache write a cold resume itself costs.
 */

export interface ResumeLeadInput {
  /** Plan-window headroom (0-100) remaining at the moment the agent stopped. */
  readonly remainingPct: number;
  /** Recent burn rate for this window, in percentage points per minute. */
  readonly burnPctPerMinute: number;
  /** Estimated one-time cost of the resume's cache write, in the same units. */
  readonly cacheWritePct: number;
  /** Safety margin taken off the raw runway, 0-100 (the user's "30% overhead"). */
  readonly overheadPct: number;
  readonly minLeadMinutes: number;
  readonly maxLeadMinutes: number;
}

/**
 * Minutes before `resetsAt` to schedule the resume, or `null` when there is no
 * usable runway — the caller falls back to the existing post-reset path.
 */
export function computeResumeLeadMinutes(input: ResumeLeadInput): number | null {
  const { remainingPct, burnPctPerMinute, cacheWritePct, overheadPct, minLeadMinutes, maxLeadMinutes } = input;
  if (!Number.isFinite(burnPctPerMinute) || burnPctPerMinute <= 0) return null;

  const usablePct = remainingPct - cacheWritePct;
  if (!Number.isFinite(usablePct) || usablePct <= 0) return null;

  const rawMinutes = usablePct / burnPctPerMinute;
  const margin = Math.min(100, Math.max(0, overheadPct)) / 100;
  const lead = rawMinutes * (1 - margin);
  if (!Number.isFinite(lead) || lead <= 0) return null;

  return Math.min(maxLeadMinutes, Math.max(minLeadMinutes, lead));
}

/** `resetsAt` minus the lead time, or `null` when either input is unusable. */
export function resumeAtFromLead(resetsAt: string, leadMinutes: number | null): Date | null {
  if (leadMinutes === null) return null;
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return null;
  return new Date(resetMs - leadMinutes * 60_000);
}
