import assert from "node:assert/strict";
import { test } from "node:test";

import {
  estimateCacheWritePct,
  estimateDollarsPerPlanPercent,
  type CostSample,
} from "./shared/cache-cost.ts";
import { segmentBlocks } from "./shared/blocks.ts";
import type { UsageSample } from "./shared/usage.ts";

function usage(at: string, pct: number, resetsAt: string | null): UsageSample {
  return { at, fetchedAt: null, src: "paseo", account: null, windows: { five_hour: { pct, resetsAt } }, credits: null };
}

test("estimateDollarsPerPlanPercent learns a ratio from overlapping history", () => {
  // Plan % climbs 10 points an hour for three hours; one agent spends $1 each hour.
  const blocks = segmentBlocks([
    usage("2026-09-05T09:00:00Z", 10, "2026-09-05T20:00:00Z"),
    usage("2026-09-05T10:00:00Z", 20, "2026-09-05T20:00:00Z"),
    usage("2026-09-05T11:00:00Z", 30, "2026-09-05T20:00:00Z"),
    usage("2026-09-05T12:00:00Z", 40, "2026-09-05T20:00:00Z"),
  ]);
  const costs: CostSample[] = [
    { agentId: "a1", at: "2026-09-05T09:30:00Z", costUsd: 0 },
    { agentId: "a1", at: "2026-09-05T10:30:00Z", costUsd: 1 },
    { agentId: "a1", at: "2026-09-05T11:30:00Z", costUsd: 2 },
    { agentId: "a1", at: "2026-09-05T12:30:00Z", costUsd: 3 },
  ];
  const ratio = estimateDollarsPerPlanPercent(blocks, costs);
  assert.ok(ratio !== null);
  // $1 per 10 points => $0.10 per point.
  assert.ok(Math.abs(ratio! - 0.1) < 1e-9, `expected 0.1, got ${ratio}`);
});

test("a cost drop is read as a new baseline, never negative spend", () => {
  const blocks = segmentBlocks([
    usage("2026-09-05T09:00:00Z", 10, "2026-09-05T20:00:00Z"),
    usage("2026-09-05T10:00:00Z", 20, "2026-09-05T20:00:00Z"),
    usage("2026-09-05T11:00:00Z", 30, "2026-09-05T20:00:00Z"),
  ]);
  const costs: CostSample[] = [
    { agentId: "a1", at: "2026-09-05T09:30:00Z", costUsd: 5 },
    // Compaction reset the running total.
    { agentId: "a1", at: "2026-09-05T10:30:00Z", costUsd: 0.5 },
    { agentId: "a1", at: "2026-09-05T11:30:00Z", costUsd: 1.5 },
  ];
  const ratio = estimateDollarsPerPlanPercent(blocks, costs);
  // Only the 0.5 -> 1.5 delta (one usable bucket) counts; below the 3-bucket floor.
  assert.equal(ratio, null);
});

test("estimateDollarsPerPlanPercent returns null without enough overlapping history", () => {
  assert.equal(estimateDollarsPerPlanPercent([], []), null);
});

test("estimateCacheWritePct prices tokens against the learned ratio", () => {
  const pct = estimateCacheWritePct({
    tokens: 200_000,
    model: "claude-sonnet-5",
    dollarsPerPercent: 0.1,
    fallbackPct: 1,
  });
  // 200k tokens * $2.50/MTok = $0.50; $0.50 / ($0.10/point) = 5 points.
  assert.ok(Math.abs(pct - 5) < 1e-9, `expected 5, got ${pct}`);
});

test("estimateCacheWritePct falls back when the ratio is unavailable", () => {
  const pct = estimateCacheWritePct({
    tokens: 200_000,
    model: "claude-sonnet-5",
    dollarsPerPercent: null,
    fallbackPct: 1.5,
  });
  assert.equal(pct, 1.5);
});

test("estimateCacheWritePct falls back for an unpriced model", () => {
  const pct = estimateCacheWritePct({
    tokens: 200_000,
    model: "some-unknown-model",
    dollarsPerPercent: 0.1,
    fallbackPct: 1.5,
  });
  assert.equal(pct, 1.5);
});

test("estimateCacheWritePct clamps to the sane range", () => {
  const tiny = estimateCacheWritePct({
    tokens: 1,
    model: "claude-haiku-4-5",
    dollarsPerPercent: 1_000_000,
    fallbackPct: 1,
  });
  assert.equal(tiny, 0.1);

  const huge = estimateCacheWritePct({
    tokens: 50_000_000,
    model: "claude-opus-5",
    dollarsPerPercent: 0.0001,
    fallbackPct: 1,
  });
  assert.equal(huge, 20);
});

test("pricing overrides win over the seeded table", () => {
  const pct = estimateCacheWritePct({
    tokens: 1_000_000,
    model: "claude-sonnet-5",
    dollarsPerPercent: 1,
    fallbackPct: 1,
    pricingOverrides: { "claude-sonnet-5": 10 },
  });
  assert.equal(pct, 10);
});
