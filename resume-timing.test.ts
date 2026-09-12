import assert from "node:assert/strict";
import { test } from "node:test";

import { computeResumeLeadMinutes, resumeAtFromLead } from "./shared/resume-timing.ts";

const BASE = {
  overheadPct: 30,
  minLeadMinutes: 0.1,
  maxLeadMinutes: 30,
};

test("matches the user's worked example: 4% left, 2%/min burn, no cache cost", () => {
  const lead = computeResumeLeadMinutes({
    ...BASE,
    remainingPct: 4,
    burnPctPerMinute: 2,
    cacheWritePct: 0,
  });
  assert.ok(lead !== null);
  assert.ok(Math.abs(lead! - 1.4) < 1e-9, `expected 1.4, got ${lead}`);
});

test("subtracting the cache-write cost first: 1% write drops it to 1.05m", () => {
  const lead = computeResumeLeadMinutes({
    ...BASE,
    remainingPct: 4,
    burnPctPerMinute: 2,
    cacheWritePct: 1,
  });
  assert.ok(lead !== null);
  assert.ok(Math.abs(lead! - 1.05) < 1e-9, `expected 1.05, got ${lead}`);
});

test("no usable runway once the cache write eats the whole headroom", () => {
  const lead = computeResumeLeadMinutes({
    ...BASE,
    remainingPct: 1,
    burnPctPerMinute: 2,
    cacheWritePct: 1.5,
  });
  assert.equal(lead, null);
});

test("a flat window (no burn) has nothing to schedule against", () => {
  const lead = computeResumeLeadMinutes({
    ...BASE,
    remainingPct: 10,
    burnPctPerMinute: 0,
    cacheWritePct: 1,
  });
  assert.equal(lead, null);
});

test("clamps to the configured min and max lead", () => {
  const tiny = computeResumeLeadMinutes({
    remainingPct: 4,
    burnPctPerMinute: 100,
    cacheWritePct: 0,
    overheadPct: 30,
    minLeadMinutes: 0.5,
    maxLeadMinutes: 30,
  });
  assert.equal(tiny, 0.5);

  const huge = computeResumeLeadMinutes({
    remainingPct: 90,
    burnPctPerMinute: 0.01,
    cacheWritePct: 0,
    overheadPct: 0,
    minLeadMinutes: 0.5,
    maxLeadMinutes: 10,
  });
  assert.equal(huge, 10);
});

test("resumeAtFromLead subtracts minutes from the reset instant", () => {
  const at = resumeAtFromLead("2026-09-05T12:00:00Z", 1.4);
  assert.equal(at?.toISOString(), "2026-09-05T11:58:36.000Z");
  assert.equal(resumeAtFromLead("2026-09-05T12:00:00Z", null), null);
  assert.equal(resumeAtFromLead("not-a-date", 1), null);
});
