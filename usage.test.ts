import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptReading,
  effectiveAt,
  fromClaudeJson,
  fromPaseoProviderUsage,
  fromStatusline,
  isStale,
  isWorthRecording,
  toPercent,
  type UsageSample,
} from "./shared/usage.ts";

const CLAUDE_JSON = {
  fetchedAtMs: 1788558890772,
  accountUuid: "acct-1",
  utilization: {
    five_hour: { utilization: 26, resets_at: "2026-09-05T01:09:59.873850+00:00" },
    seven_day: { utilization: 3, resets_at: "2026-09-06T03:59:59.873867+00:00" },
    seven_day_opus: null,
    limits: [
      { kind: "session", percent: 26, severity: "normal", resets_at: "2026-09-05T01:09:59.873850+00:00", scope: null, is_active: true },
      { kind: "weekly_scoped", percent: 4, severity: "warn", resets_at: null, scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    ],
    spend: {
      used: { amount_minor: 32310, currency: "USD", exponent: 2 },
      limit: { amount_minor: 150000, currency: "USD", exponent: 2 },
      percent: 22,
      enabled: true,
    },
  },
};

test("percentages take the scale the source declares, never a guess", () => {
  assert.equal(toPercent(26, "percent"), 26);
  assert.equal(toPercent(0.26, "fraction"), 26);
  // A bare 1 is 1%, not a full window — the ambiguous case that must not be guessed.
  assert.equal(toPercent(1, "percent"), 1);
  assert.equal(toPercent(150, "percent"), 100, "clamped");
  assert.equal(toPercent(Number.NaN, "percent"), 0);
});

test("claude.json: limits[] and the named windows fold onto one id space", () => {
  const sample = fromClaudeJson(CLAUDE_JSON)!;
  assert.ok(sample);
  // "session" is the same window as "five_hour" and must not become a second series.
  assert.equal(sample.windows.five_hour!.pct, 26);
  assert.equal(sample.windows.five_hour!.active, true, "limits[] wins, it carries the flag");
  assert.equal(sample.windows.seven_day!.pct, 3);
  assert.equal(sample.windows["weekly_model:fable"]!.scope, "Fable", "id is normalized, display label is kept");
  assert.equal(sample.windows.seven_day_opus, undefined, "a null window is absent, not zero");
  assert.equal(sample.credits!.usedMinor, 32310);
});

test("a cached reading is timestamped when it was true, not when we saw it", () => {
  const observed = new Date("2026-09-05T11:39:00.000Z");
  const sample = fromClaudeJson(CLAUDE_JSON, observed)!;
  assert.equal(sample.at, observed.toISOString());
  assert.equal(sample.fetchedAt, new Date(1788558890772).toISOString());
  assert.equal(effectiveAt(sample), sample.fetchedAt);
  assert.equal(isStale(sample), true, "14h behind counts as stale");
});

test("paseo usage: the fractional spelling is the only one scaled up", () => {
  const fraction = fromPaseoProviderUsage({
    providers: [{ providerId: "claude", windows: [{ id: "five_hour", utilization: 0.42, resetsAt: "2026-09-05T01:00:00Z" }] }],
  })!;
  assert.equal(fraction.windows.five_hour!.pct, 42);

  const percent = fromPaseoProviderUsage({
    providers: [{ providerId: "claude", windows: [{ id: "session", usedPct: 42, resetsAt: "2026-09-05T01:00:00Z" }] }],
  })!;
  assert.equal(percent.windows.five_hour!.pct, 42, "and 'session' still canonicalizes");

  assert.equal(fromPaseoProviderUsage({ providers: [{ providerId: "codex", windows: [] }] }), null);
});

test("statusline resets_at arrives as epoch seconds", () => {
  const sample = fromStatusline({ rate_limits: { five_hour: { used_percentage: 61, resets_at: 1788600000 } } })!;
  assert.equal(sample.windows.five_hour!.pct, 61);
  assert.equal(sample.windows.five_hour!.resetsAt, new Date(1788600000 * 1000).toISOString());
});

function sampleAt(at: string, pct: number, fetchedAt: string | null = null): UsageSample {
  return {
    at,
    fetchedAt,
    src: "claudejson",
    account: null,
    windows: { five_hour: { pct, resetsAt: "2026-09-05T01:00:00.000Z" } },
    credits: null,
  };
}

test("only real movement earns a line in the store", () => {
  const base = sampleAt("2026-09-05T10:00:00.000Z", 26, "2026-09-05T09:59:00.000Z");
  assert.equal(isWorthRecording(null, base), true, "the first reading always");
  assert.equal(
    isWorthRecording(base, sampleAt("2026-09-05T10:01:00.000Z", 26, "2026-09-05T09:59:00.000Z")),
    false,
    "a re-read of the same cached reading is not a new observation",
  );
  assert.equal(isWorthRecording(base, sampleAt("2026-09-05T10:01:00.000Z", 27, "2026-09-05T10:01:00.000Z")), true);
  assert.equal(
    isWorthRecording(base, sampleAt("2026-09-05T10:11:00.000Z", 26, "2026-09-05T09:59:00.000Z")),
    true,
    "the heartbeat proves the recorder was alive through a flat stretch",
  );
});

test("paseo's payload carries the instant the daemon actually fetched", () => {
  const sample = fromPaseoProviderUsage({
    fetchedAt: "2026-09-05T11:30:00.000Z",
    providers: [{ providerId: "claude", windows: [{ id: "five_hour", usedPct: 26, resetsAt: "2026-09-05T14:00:00Z" }] }],
  }, "claude", new Date("2026-09-05T11:31:00.000Z"))!;
  assert.equal(sample.fetchedAt, "2026-09-05T11:30:00.000Z");
  assert.equal(isStale(sample), false, "a minute behind is not stale");
});

test("a stale reading never enters the series", () => {
  const fresh = sampleAt("2026-09-05T10:05:00.000Z", 40, "2026-09-05T10:05:00.000Z");
  const late = sampleAt("2026-09-05T10:06:00.000Z", 26, "2026-09-05T09:00:00.000Z");
  assert.equal(acceptReading(null, fresh).ok, true);
  // The cache handing back an hour-old reading a minute later must not overwrite it.
  assert.equal(acceptReading(fresh, late).ok, false);
});

test("a window that fills cannot un-fill without rolling over", () => {
  const at40 = sampleAt("2026-09-05T10:00:00.000Z", 40, "2026-09-05T10:00:00.000Z");
  const backwards = sampleAt("2026-09-05T10:05:00.000Z", 31, "2026-09-05T10:05:00.000Z");
  const result = acceptReading(at40, backwards);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /backwards/);

  // Unless the window actually rolled, which is exactly when it should reset to near zero.
  const rolled: UsageSample = {
    ...backwards,
    windows: { five_hour: { pct: 2, resetsAt: "2026-09-05T15:00:00.000Z" } },
  };
  assert.equal(acceptReading(at40, rolled).ok, true);
});

test("the plan week has three names across three sources", () => {
  // claude.json top-level: seven_day. Its limits[]: weekly_all. Paseo: weekly.
  // All three must land on one series or a week of history splits in three.
  const paseo = fromPaseoProviderUsage({
    fetchedAt: "2026-09-05T11:30:00.000Z",
    providers: [{ providerId: "claude", windows: [{ id: "weekly", label: "Weekly", usedPct: 3, resetsAt: "2026-09-06T03:59:59Z" }] }],
  })!;
  assert.equal(paseo.windows.seven_day!.pct, 3);
  assert.equal(paseo.windows.weekly, undefined);
});

test("a scoped weekly cap is one series however the source spells it", () => {
  // Claude Code: kind "weekly_scoped" + a scope object, display name "Fable".
  const fromCache = fromClaudeJson({
    fetchedAtMs: 1788600000000,
    utilization: {
      limits: [
        { kind: "weekly_scoped", percent: 12, resets_at: null, scope: { model: { id: null, display_name: "Fable" }, surface: null } },
      ],
    },
  })!;
  // Paseo: the same cap flattened into the window id.
  const fromDaemon = fromPaseoProviderUsage({
    fetchedAt: "2026-09-05T11:30:00.000Z",
    providers: [{ providerId: "claude", windows: [{ id: "weekly_model_fable", label: "Weekly · Fable", usedPct: 12 }] }],
  })!;

  assert.deepEqual(Object.keys(fromCache.windows), ["weekly_model:fable"]);
  assert.deepEqual(Object.keys(fromDaemon.windows), ["weekly_model:fable"]);
});

test("a model and a surface of the same name are different caps", () => {
  const model = fromPaseoProviderUsage({
    providers: [{ providerId: "claude", windows: [{ id: "weekly_model_x", usedPct: 1 }, { id: "weekly_surface_x", usedPct: 2 }] }],
  })!;
  assert.equal(model.windows["weekly_model:x"]!.pct, 1);
  assert.equal(model.windows["weekly_surface:x"]!.pct, 2);
});
