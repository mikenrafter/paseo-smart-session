/**
 * Estimating what a cold resume's cache write costs, in plan-window percentage
 * points — the number `shared/resume-timing.ts` subtracts from the headroom left
 * before a reset.
 *
 * Two steps. First, price the cache write itself in dollars, from a small seeded
 * per-model table. Second, convert dollars into plan-% using a ratio learned from
 * this plugin's own history: `context-YYYY-MM.jsonl` already carries `costUsd` per
 * agent per observation, and `usage-YYYY-MM.jsonl` (via `shared/blocks.ts`) carries
 * plan-% over the same clock. Regressing one against the other needs no upstream
 * pricing API and stays correct as prices or plan tiers change.
 */

import type { Block } from "./blocks.ts";

/**
 * Anthropic entries: published 5-minute cache-write rate, which is 1.25× the base
 * input price (see the `claude-api` skill / `shared/prompt-caching.md`, "Economics"
 * — confirmed 2026-06-24 pricing snapshot). OpenAI does not bill a distinct
 * cache-write line item — it auto-caches and only discounts a cached *read* — so
 * these entries stand in the base input price as the cost of the discount a cold
 * resume forgoes on its first read. That is a deliberately shallow model, not an
 * accounting of OpenAI's real cache mechanics; treat these numbers as a rough prior
 * to override via `settings.cachePricingUsdPerMTok`, not a source of truth.
 */
export const CACHE_WRITE_USD_PER_MTOK: Readonly<Record<string, number>> = {
  // Anthropic — input price × 1.25 (5-minute TTL).
  "claude-fable-5-1": 12.5,
  "claude-mythos-5-1": 12.5,
  "claude-fable-5": 12.5,
  "claude-opus-5": 6.25,
  "claude-opus-4-8": 6.25,
  "claude-opus-4-7": 6.25,
  "claude-opus-4-6": 6.25,
  "claude-sonnet-5": 2.5,
  "claude-sonnet-4-6": 3.75,
  "claude-haiku-4-5": 1.25,
  // OpenAI — base input price, shallow stand-in (see comment above).
  "gpt-5": 1.25,
  "gpt-5-mini": 0.25,
  "gpt-5-nano": 0.05,
  "gpt-4.1": 2.0,
  "gpt-4.1-mini": 0.4,
  "gpt-4o": 2.5,
  "o3": 2.0,
  "o4-mini": 1.1,
};

const MIN_CACHE_WRITE_PCT = 0.1;
const MAX_CACHE_WRITE_PCT = 20;

/** Longest matching table key for a model id, so a dated/suffixed id still resolves. */
function lookupPricePerMTok(
  model: string | null,
  overrides: Readonly<Record<string, number>>,
): number | null {
  if (model === null || model === "") return null;
  const table = { ...CACHE_WRITE_USD_PER_MTOK, ...overrides };
  if (model in table) return table[model]!;
  let best: { key: string; price: number } | null = null;
  for (const [key, price] of Object.entries(table)) {
    if (!model.startsWith(key) && !key.startsWith(model)) continue;
    if (best === null || key.length > best.key.length) best = { key, price };
  }
  return best?.price ?? null;
}

/** One hour's worth of $ spent and plan-% consumed, the unit the ratio is fit over. */
interface HourBucket {
  costUsd: number;
  pct: number;
}

/** The lean shape this needs from a context observation. */
export interface CostSample {
  readonly agentId: string;
  readonly at: string;
  readonly costUsd: number | null;
}

const MIN_BUCKETS_FOR_RATIO = 3;

/**
 * Dollars spent per one point of plan-% consumed, learned from recorded history.
 *
 * `costUsd` on a context sample is a running total for that agent's session, not a
 * delta, so it can drop when an agent compacts or a new session starts — a drop is
 * read as "start counting again from here," never as negative spend. Plan-% is
 * read off each block's own points, so an hour spanning a window rollover splits
 * cleanly into the two blocks that actually happened.
 *
 * Returns `null` when there is not enough overlapping history yet, so the caller
 * falls back to a configured default rather than trusting a ratio fit on noise.
 */
export function estimateDollarsPerPlanPercent(
  blocks: readonly Block[],
  costSamples: readonly CostSample[],
): number | null {
  if (blocks.length === 0 || costSamples.length === 0) return null;

  const buckets = new Map<string, HourBucket>();
  const hourOf = (iso: string): string => iso.slice(0, 13); // YYYY-MM-DDTHH

  for (const block of blocks) {
    for (let i = 1; i < block.points.length; i += 1) {
      const prev = block.points[i - 1]!;
      const next = block.points[i]!;
      const deltaPct = next.pct - prev.pct;
      if (deltaPct <= 0) continue;
      const bucket = buckets.get(hourOf(next.t)) ?? { costUsd: 0, pct: 0 };
      bucket.pct += deltaPct;
      buckets.set(hourOf(next.t), bucket);
    }
  }

  const lastCost = new Map<string, number>();
  const sorted = [...costSamples].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const sample of sorted) {
    if (sample.costUsd === null) continue;
    const previous = lastCost.get(sample.agentId);
    lastCost.set(sample.agentId, sample.costUsd);
    if (previous === undefined) continue;
    const delta = sample.costUsd - previous;
    if (delta <= 0) continue; // A drop is a new baseline, not spend to attribute.
    const key = hourOf(sample.at);
    const bucket = buckets.get(key);
    if (bucket === undefined) continue; // No plan-% movement recorded that hour.
    bucket.costUsd += delta;
  }

  let totalCost = 0;
  let totalPct = 0;
  let usableBuckets = 0;
  for (const bucket of buckets.values()) {
    if (bucket.costUsd <= 0 || bucket.pct <= 0) continue;
    totalCost += bucket.costUsd;
    totalPct += bucket.pct;
    usableBuckets += 1;
  }

  if (usableBuckets < MIN_BUCKETS_FOR_RATIO || totalPct <= 0) return null;
  return totalCost / totalPct;
}

export interface CacheWriteEstimateInput {
  readonly tokens: number;
  readonly model: string | null;
  /** From `estimateDollarsPerPlanPercent`, or `null` when there isn't enough history. */
  readonly dollarsPerPercent: number | null;
  /** `settings.cacheWriteFallbackPct`, used whenever the ratio or the price is unavailable. */
  readonly fallbackPct: number;
  readonly pricingOverrides?: Readonly<Record<string, number>>;
}

/** The cache-write cost of resuming, in plan-window percentage points. */
export function estimateCacheWritePct(input: CacheWriteEstimateInput): number {
  const pricePerMTok = lookupPricePerMTok(input.model, input.pricingOverrides ?? {});
  if (pricePerMTok === null || input.dollarsPerPercent === null || input.dollarsPerPercent <= 0) {
    return clampPct(input.fallbackPct);
  }
  const dollars = (input.tokens / 1_000_000) * pricePerMTok;
  return clampPct(dollars / input.dollarsPerPercent);
}

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return MIN_CACHE_WRITE_PCT;
  return Math.min(MAX_CACHE_WRITE_PCT, Math.max(MIN_CACHE_WRITE_PCT, pct));
}
