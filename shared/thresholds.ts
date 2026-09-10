/**
 * When a context is too full — which depends on how big the window is.
 *
 * A percentage of the window is the wrong unit on its own. What degrades recall and
 * what costs money is the *absolute* size of the prefix re-read every turn, so 30%
 * of a million-token window (300k) is a heavier context than 85% of a 200k one
 * (170k). A single percentage band would either nag a small session or let a large
 * one drift for hours.
 *
 * So there are two profiles. A small window is allowed to fill up, because its
 * ceiling arrives before its context gets unwieldy. A large window is asked to
 * compact long before the ceiling, because the ceiling was never the constraint.
 */

export type Band = "notice" | "closing" | "compact";

export interface ThresholdProfile {
  /** Percentage of the window at which to first mention it. */
  readonly notice: number;
  /** Percentage at which to stop opening new work. */
  readonly closing: number;
  /** Percentage at which to recommend compacting. */
  readonly compact: number;
}

export interface Thresholds {
  /** Windows at least this large use the `large` profile. */
  readonly largeWindowFrom: number;
  readonly large: ThresholdProfile;
  readonly small: ThresholdProfile;
}

/**
 * Defaults.
 *
 * The `large` numbers are deliberately early: 30% of a million tokens is 300k, and
 * a 300k prefix is already past the point where a session is sharp or cheap.
 * The `small` numbers let a 200k session use most of its window, because 85% of it
 * is only 170k.
 *
 * Windows are 200k or 1M in practice, so 400k separates them with room to spare.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  largeWindowFrom: 400_000,
  large: { notice: 15, closing: 22, compact: 30 },
  small: { notice: 60, closing: 75, compact: 85 },
};

export function profileFor(maxTokens: number, thresholds: Thresholds = DEFAULT_THRESHOLDS): ThresholdProfile {
  return maxTokens >= thresholds.largeWindowFrom ? thresholds.large : thresholds.small;
}

/** The highest band a given occupancy has reached, or null for "nothing to say". */
export function bandFor(pct: number, profile: ThresholdProfile): Band | null {
  if (pct >= profile.compact) return "compact";
  if (pct >= profile.closing) return "closing";
  if (pct >= profile.notice) return "notice";
  return null;
}

/** Every band at or below the current occupancy, so each fires exactly once. */
export function bandsReached(pct: number, profile: ThresholdProfile): Band[] {
  const reached: Band[] = [];
  if (pct >= profile.notice) reached.push("notice");
  if (pct >= profile.closing) reached.push("closing");
  if (pct >= profile.compact) reached.push("compact");
  return reached;
}

/** Clamps a user-supplied profile into something monotonic and in range. */
export function normalizeProfile(raw: Partial<ThresholdProfile> | undefined, fallback: ThresholdProfile): ThresholdProfile {
  const clamp = (value: unknown, dflt: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(99, Math.max(1, value)) : dflt;
  const notice = clamp(raw?.notice, fallback.notice);
  const closing = Math.max(notice, clamp(raw?.closing, fallback.closing));
  const compact = Math.max(closing, clamp(raw?.compact, fallback.compact));
  return { notice, closing, compact };
}

export function normalizeThresholds(raw: Partial<Thresholds> | undefined): Thresholds {
  const largeWindowFrom =
    typeof raw?.largeWindowFrom === "number" && raw.largeWindowFrom > 0
      ? raw.largeWindowFrom
      : DEFAULT_THRESHOLDS.largeWindowFrom;
  return {
    largeWindowFrom,
    large: normalizeProfile(raw?.large, DEFAULT_THRESHOLDS.large),
    small: normalizeProfile(raw?.small, DEFAULT_THRESHOLDS.small),
  };
}
