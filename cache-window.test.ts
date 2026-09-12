import assert from "node:assert/strict";
import { test } from "node:test";

import { cacheRemainingMs, formatCacheRemaining } from "./shared/cache-window.ts";

const TTL = 5 * 60_000;

test("cacheRemainingMs counts down from last activity", () => {
  const now = Date.parse("2026-09-05T12:03:00Z");
  const remaining = cacheRemainingMs("2026-09-05T12:00:00Z", TTL, now);
  assert.equal(remaining, 2 * 60_000);
});

test("cacheRemainingMs floors at zero once expired", () => {
  const now = Date.parse("2026-09-05T12:10:00Z");
  assert.equal(cacheRemainingMs("2026-09-05T12:00:00Z", TTL, now), 0);
});

test("cacheRemainingMs treats an unparseable timestamp as already cold", () => {
  assert.equal(cacheRemainingMs("not-a-date", TTL), 0);
});

test("formatCacheRemaining renders minutes and seconds, and nothing once cold", () => {
  assert.equal(formatCacheRemaining(0), "");
  assert.equal(formatCacheRemaining(45_000), "45s");
  assert.equal(formatCacheRemaining(125_000), "2m 5s");
});
