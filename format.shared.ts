/** Small formatters shared by the surface and any future CLI. */

/** "2h 14m", "4m", "now" — a duration a person reads without decoding. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** "in 2h 14m" / "14m ago", relative to now. */
export function formatRelative(iso: string | null, now = Date.now()): string {
  if (iso === null) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return ms >= now ? `in ${formatDuration(ms - now)}` : `${formatDuration(now - ms)} ago`;
}

/** "261.7k" — token counts, which are always large and never need units. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** A window id turned into something worth putting on a row. */
export function windowLabel(id: string): string {
  if (id === "five_hour") return "Session (5h)";
  if (id === "seven_day") return "Week";
  const scoped = /^weekly_(model|surface):(.+)$/.exec(id);
  if (scoped !== null) {
    const name = scoped[2]!;
    return `Week · ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  }
  return id;
}

/**
 * Which windows are worth a row.
 *
 * The provider reports a long tail of caps that are inactive, unnamed, or at zero
 * for this account — internal codenames included. Showing them all buries the two
 * that matter.
 */
export function isInteresting(window: { id: string; pct: number; resetsAt: string | null }): boolean {
  if (window.id === "five_hour" || window.id === "seven_day") return true;
  return window.pct > 0 || window.resetsAt !== null;
}


/**
 * Which step of a sequential ramp a value falls on.
 *
 * Magnitude is encoded with one hue at stepped intensities, so this returns an
 * index into that ramp — or -1 for "no data", which must render as the surface
 * rather than as the faintest step: absence and "a little" must not look alike.
 */
export function rampStep(value: number, max: number, steps: number): number {
  if (steps <= 0 || max <= 0 || value <= 0) return -1;
  const index = Math.ceil((value / max) * steps) - 1;
  return Math.min(steps - 1, Math.max(0, index));
}

/**
 * What the composer pill says about one agent.
 *
 * Three states, not two. An enrolled agent is still not going to be compacted
 * while autopilot is off globally, and a pill that said "on" there would be
 * telling the user something that is not true.
 */
export function autoCompactLabel(input: { enrolled: boolean; autopilot: boolean }): string {
  if (!input.enrolled) return "Auto-compact off";
  return input.autopilot ? "Auto-compact on" : "Auto-compact paused";
}
