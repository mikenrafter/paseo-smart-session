/**
 * How much longer a provider's prompt cache is likely still warm.
 *
 * Deliberately shallow: one generic TTL for every provider, not a model of each
 * one's actual cache duration (Anthropic's is a plain 5-minute-from-last-request
 * clock; OpenAI's is not modeled at all here). Good enough to say "still cheap to
 * resume" versus "gone cold," not a guarantee.
 */

/** Milliseconds of cache life left, floored at 0 once it has expired. */
export function cacheRemainingMs(lastActivityAt: string, ttlMs: number, now = Date.now()): number {
  const lastMs = Date.parse(lastActivityAt);
  if (Number.isNaN(lastMs)) return 0;
  return Math.max(0, lastMs + ttlMs - now);
}

/** "4m 12s" / "58s" / "" once cold — the composer pill's label. */
export function formatCacheRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return "";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
