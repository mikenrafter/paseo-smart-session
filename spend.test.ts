import assert from "node:assert/strict";
import { test } from "node:test";

import { rampStep } from "./shared/format.ts";
import { rollup } from "./server/spend.ts";
import type { SpendBucket } from "./server/backfill.ts";

function bucket(partial: Partial<SpendBucket> & { hour: string }): SpendBucket {
  return {
    model: "claude-opus-5",
    project: "alpha",
    sidechain: false,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    thinking: 0,
    messages: 1,
    ...partial,
  };
}

test("cache reads are not counted as spend", () => {
  // The whole point of a cache read is that it is the cheap path; counting it as
  // spend would make a well-cached session look like the expensive one.
  const summary = rollup([bucket({ hour: "2026-09-05T10", input: 100, cacheWrite: 50, output: 25, cacheRead: 900_000 })]);
  assert.equal(summary.totalTokens, 175);
  assert.ok(summary.cacheHitPct > 99, "but it is still the headline efficiency number");
});

test("subagent spend is separated, not hidden", () => {
  const summary = rollup([
    bucket({ hour: "2026-09-05T10", output: 100 }),
    bucket({ hour: "2026-09-05T10", output: 400, sidechain: true }),
  ]);
  assert.equal(summary.totalTokens, 500);
  assert.equal(summary.subagentTokens, 400, "four fifths of this went to subagents");
});

test("hours roll into local days and local weekday/hour cells", () => {
  const summary = rollup([bucket({ hour: "2026-09-05T10", output: 10 }), bucket({ hour: "2026-09-05T11", output: 5 })]);
  assert.equal(summary.byDay.length, 1);
  assert.equal(summary.byDay[0]!.tokens, 15);
  assert.equal(summary.heatmap.length, 2, "two distinct hours");
  for (const cell of summary.heatmap) {
    assert.ok(cell.hour >= 0 && cell.hour <= 23);
    assert.ok(cell.weekday >= 0 && cell.weekday <= 6);
  }
});

test("days come back in order, whatever order the buckets arrived in", () => {
  const summary = rollup([
    bucket({ hour: "2026-09-07T10", output: 3 }),
    bucket({ hour: "2026-09-05T10", output: 1 }),
    bucket({ hour: "2026-09-06T10", output: 2 }),
  ]);
  assert.deepEqual(summary.byDay.map((point) => point.tokens), [1, 2, 3]);
});

test("ranked totals are ranked and capped", () => {
  const buckets = Array.from({ length: 12 }, (unused, index) =>
    bucket({ hour: "2026-09-05T10", project: `p${index}`, output: index }),
  );
  const summary = rollup(buckets);
  assert.equal(summary.byProject.length, 8, "a top-eight list, not everything");
  assert.equal(summary.byProject[0]!.name, "p11");
});

test("the sequential ramp keeps 'nothing' distinct from 'a little'", () => {
  assert.equal(rampStep(0, 100, 5), -1, "no data is not the faintest step");
  assert.equal(rampStep(1, 100, 5), 0);
  assert.equal(rampStep(100, 100, 5), 4);
  assert.equal(rampStep(60, 100, 5), 2);
  assert.equal(rampStep(5, 0, 5), -1, "no maximum means nothing to scale against");
});
