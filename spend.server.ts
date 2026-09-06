/**
 * Rolling the raw hourly buckets into the few shapes a person actually reads.
 *
 * Aggregation happens here rather than in the client because the raw index is over
 * a thousand buckets and a panel needs about forty numbers.
 */

import { readSpend, scanSpend, type SpendBucket } from "./backfill.server.ts";

/** Tokens that cost something. Cache reads are excluded — they are the cheap part. */
function billable(bucket: SpendBucket): number {
  return bucket.input + bucket.cacheWrite + bucket.output;
}

export interface DayPoint {
  readonly day: string;
  readonly tokens: number;
  readonly messages: number;
}

export interface HeatCell {
  /** 0 = Sunday, matching Date#getDay. */
  readonly weekday: number;
  readonly hour: number;
  readonly tokens: number;
}

export interface NamedTotal {
  readonly name: string;
  readonly tokens: number;
}

export interface SpendSummary {
  readonly byDay: DayPoint[];
  readonly heatmap: HeatCell[];
  readonly byProject: NamedTotal[];
  readonly byModel: NamedTotal[];
  readonly totalTokens: number;
  readonly subagentTokens: number;
  /** Share of input tokens served from cache — the biggest single cost lever. */
  readonly cacheHitPct: number;
  readonly firstHour: string | null;
  readonly lastHour: string | null;
  readonly bucketCount: number;
}

const EMPTY: SpendSummary = {
  byDay: [],
  heatmap: [],
  byProject: [],
  byModel: [],
  totalTokens: 0,
  subagentTokens: 0,
  cacheHitPct: 0,
  firstHour: null,
  lastHour: null,
  bucketCount: 0,
};

/**
 * `rescan` walks the transcripts for anything new first. It is incremental — each
 * file is read only from where the last scan stopped — so a re-scan of 600MB of
 * history costs about a tenth of a second.
 */
export async function summarizeSpend(options: { days?: number; rescan?: boolean } = {}): Promise<SpendSummary> {
  const days = options.days ?? 30;
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  if (options.rescan === true) await scanSpend();
  return rollup(await readSpend(sinceMs));
}

/** The pure half: buckets in, the shapes a panel reads out. */
export function rollup(buckets: readonly SpendBucket[]): SpendSummary {
  if (buckets.length === 0) return EMPTY;

  const byDay = new Map<string, { tokens: number; messages: number }>();
  const heat = new Map<string, number>();
  const byProject = new Map<string, number>();
  const byModel = new Map<string, number>();

  let totalTokens = 0;
  let subagentTokens = 0;
  let cacheRead = 0;
  let freshInput = 0;
  let firstHour: string | null = null;
  let lastHour: string | null = null;

  for (const bucket of buckets) {
    const tokens = billable(bucket);
    totalTokens += tokens;
    if (bucket.sidechain) subagentTokens += tokens;
    cacheRead += bucket.cacheRead;
    freshInput += bucket.input + bucket.cacheWrite;

    if (firstHour === null || bucket.hour < firstHour) firstHour = bucket.hour;
    if (lastHour === null || bucket.hour > lastHour) lastHour = bucket.hour;

    const day = bucket.hour.slice(0, 10);
    const dayTotal = byDay.get(day) ?? { tokens: 0, messages: 0 };
    dayTotal.tokens += tokens;
    dayTotal.messages += bucket.messages;
    byDay.set(day, dayTotal);

    // The hour string is UTC; the question "when do I work hardest" is about local
    // time, so it is converted before bucketing.
    const local = new Date(`${bucket.hour}:00:00Z`);
    const key = `${local.getDay()}|${local.getHours()}`;
    heat.set(key, (heat.get(key) ?? 0) + tokens);

    byProject.set(bucket.project, (byProject.get(bucket.project) ?? 0) + tokens);
    byModel.set(bucket.model, (byModel.get(bucket.model) ?? 0) + tokens);
  }

  const named = (map: Map<string, number>): NamedTotal[] =>
    [...map.entries()]
      .map(([name, tokens]) => ({ name, tokens }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8);

  return {
    byDay: [...byDay.entries()]
      .map(([day, totals]) => ({ day, ...totals }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    heatmap: [...heat.entries()].map(([key, tokens]) => {
      const [weekday, hour] = key.split("|");
      return { weekday: Number(weekday), hour: Number(hour), tokens };
    }),
    byProject: named(byProject),
    byModel: named(byModel),
    totalTokens,
    subagentTokens,
    cacheHitPct: cacheRead + freshInput === 0 ? 0 : (cacheRead / (cacheRead + freshInput)) * 100,
    firstHour,
    lastHour,
    bucketCount: buckets.length,
  };
}
