# Smart Session — plan

Two problems, one spine. Read `RESEARCH.md` first; every capability claim below is evidenced there.

> **Status, 2026-09-05.** Every phase is built, installed and verified against a live daemon.
> `npm run verify` is green (26 unit tests, three structural checks).
>
> Verified by experiment, not assumed: `/compact` delivered through Paseo compacts a live agent with
> custom instructions honoured (39,325 → 6,160 tokens); the full governor path — queue while busy,
> deliver on idle, grade the result — ran end to end (38,429 → 6,391); and the freshness of all three
> usage sources was measured against a direct upstream fetch (`RESEARCH.md` §7a).

- **Meter** — complete history of plan usage (5-hour blocks, weekly windows), so you can see *when*
  you burn budget and *what* burns it.
- **Governor** — the agent knows how full its context is, keeps its own durable task state, and
  compacts itself at the right moment instead of you doing it by hand.

They share one daemon-side recorder, one on-disk store, and one agent-facing tool surface, so they
ship as **one Paseo plugin with two surfaces** — with the seam kept clean enough to split later.

---

## 0. The one thing to do first

**Start recording today.** Utilization history exists nowhere on this machine or in Paseo
(`RESEARCH.md` §1.2). Tokens are backfillable from transcripts; *percentages of your plan limits are
not*. Every day the recorder isn't running is a day of history you can never get back.

Phase 1 is deliberately ~150 lines with no UI. Ship it before designing a single chart.

---

## 1. Architecture

```
                    ┌──────────── daemon (Paseo plugin, index.server.ts + server/) ─────┐
  ~/.claude.json ──▶│  Recorder      fs.watch cachedUsageUtilization                     │
  daemon client ───▶│                poll listProviderUsage() every 60s                  │──▶ usage.jsonl
  agent snapshots ─▶│                per-agent contextWindowUsed/Max on change           │──▶ context.jsonl
  ~/.claude/projects│  Backfiller    transcript scan, dedupe on requestId                │──▶ spend.parquet-ish
                    │  Governor      policy engine: threshold → nudge → checkpoint →     │
                    │                compact, via defer-style deliver-when-idle          │
                    │  RPC           contracts consumed by the panels and the MCP tools   │
                    └────────────────────────────────────────────────────────────────────┘
                              ▲                                    ▲
         Paseo surfaces ──────┘                                    └────── MCP tools (agent-facing)
         (sidebar stats, agent panel, composer pill)                       + hooks (context injection)
```

Store: `$PASEO_HOME/plugin-data/smart-session/`. Append-only JSONL, one line per *change* (not per
poll) — a day of 60s polling compresses to a few hundred lines. Roll monthly.

**Isolate the brittle seam.** Borrowing the host's daemon client (the only route to
`provider.usage.list` and agent usage — `RESEARCH.md` §5) goes in exactly one module with a loud,
actionable error when a Paseo upgrade moves it, exactly as `paseo-defer/daemon.server.ts` does.

---

## 2. Meter — usage statistics

### 2.1 Sampling
Three sources, unioned, each with a `src` tag so gaps are visible rather than interpolated silently:

| src | how | why it's there |
|---|---|---|
| `claudejson` | `fs.watch` on `~/.claude.json`, read `cachedUsageUtilization` on change | free, event-driven, catches sessions Paseo never sees |
| `paseo` | `listProviderUsage()` on a 60s timer | authoritative, keeps sampling while you're idle |
| `statusline` | optional statusline shim appending a line | covers hand-run TUI sessions; bonus only |

Record the **whole window map** (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
`limits[]`, …) generically — Anthropic keeps adding windows. Normalize the 0–1 vs 0–100 disagreement
at ingest (`RESEARCH.md` §1.2) and clamp.

### 2.2 Blocks
A 5-hour block is identified by its `resets_at`; `block_start = resets_at − 5h`. A materially later
`resets_at` means rollover — reuse `paseo-defer`'s hard-won tolerance logic
(`engine.server.ts:15-19`: the provider re-derives the instant each read, so exact comparison sees a
new window on every refresh). Weekly windows roll the same way on their own cadence.

Per block, store: start/end, peak %, final %, the sample curve, and the joined spend attribution.

### 2.3 Attribution and calibration — the part that makes it actionable
Utilization alone tells you *that* you burned budget. The transcript scan tells you *what* burned it:
per block, tokens by **model**, **workspace/project**, **session**, **main-thread vs subagent**
(`isSidechain`), and **cache read vs cache write vs fresh input**.

Then fit tokens → utilization: within one block, regress Δutilization against Δ(weighted tokens) from
the live samples. That gives you three things nothing else does:

1. **Backfill** — past weeks expressed in % of plan, not just raw tokens.
2. **Projection** — "at this burn rate you hit 100% at 16:40, 2h before the window resets."
3. **Unit price of a habit** — "a 6-way Opus fan-out costs ~9% of a 5-hour block."

Treat the fit as advisory and show its residuals; the weights are not documented anywhere.

### 2.4 Views
Build with the `dataviz` skill. Four views, in value order:

1. **Blocks timeline** — a row per 5h block for the last N days: burn sparkline, peak %, cost, top
   workspaces. This is the "see all sessions this week" ask, directly.
2. **Hour-of-day heatmap** — 7×24, mean burn rate and peak utilization. This is the
   "am I working hardest 14:00–19:00" ask, and it wants *weeks* of data — another reason to start now.
3. **Weekly windows** — where you are vs. a pace-to-limit line, per window (incl. the Opus-specific
   weekly cap, which is the one that actually bites on `opus[1m]`).
4. **Waste panel** — cache hit ratio over time with `last_miss_cause` labels (`model_changed`,
   `tools_changed`, `effort_changed`, …), tokens spent *on compaction itself*, duplicate-read tokens,
   subagent output that was discarded. This is where optimization decisions actually come from.

Surfaces: a sidebar surface for the full stats view; a compact composer pill (`x% · resets 2h14m`)
reusing the pill pattern `paseo-defer` already ships. A `smart-session stats --week` CLI for the
terminal, because half this value is consumed outside the app.

---

## 3. Governor — context self-management

### 3.1 The reframe
Compaction is not the goal. **A cheap, correct restart is.** Split it into three jobs, and note that
only the third one is "compaction":

1. **Sensing** — the agent knows how full it is *and what that costs*.
2. **Persisting** — durable task state on disk, maintained continuously, not scrambled together at
   the cliff edge.
3. **Triggering** — compaction fires at a task boundary you chose, not mid-turn at 92%.

The article's complaint is really about (2) and (3): auto-compact fires at the worst moment and
summarizes with whatever attention is left. If the state file is authoritative, the quality of the
summary stops being load-bearing — which is what makes the whole thing safe to automate.

**And the 1M wrinkle:** on `opus[1m]` you rarely *run out*. You degrade. Every turn re-reads a
million-token prefix, quality decays, and cost per turn climbs long before any limit. So the
governor's thresholds are about **quality and burn rate**, not about avoiding a wall.

### 3.2 Sensing
Primary: **Paseo's own `contextWindowUsedTokens` / `contextWindowMaxTokens` per agent**
(`RESEARCH.md` §2.1) — no transcript parsing, updates every turn, provider-agnostic.
Fallback for non-Paseo sessions: last assistant `usage` from `transcript_path`, which every hook
receives for free.

Two ways the agent finds out, and it needs both:

- **Pull** — MCP tool `context_status()` → `{ used_pct, used_tokens, max_tokens, burn_per_turn,
  est_turns_left, five_hour_pct, resets_in, at_boundary }`. Cheap, precise, agent-initiated.
  Agents forget to call it.
- **Push** — a `PostToolUse` hook that is **silent below threshold** and emits
  `hookSpecificOutput.additionalContext` on crossing 60 / 75 / 85%, latched one-shot per level per
  compaction epoch. Costs nothing until it matters, and is unmissable when it does.

The injected text must be actionable, not a number:

> Context 78% (780k/1M). ~6 tool calls left at your current burn. Update
> `.paseo/state/<task>.md` now; call `request_compaction` at your next clean boundary.

### 3.3 Persisting — the half that actually decides whether this works
One file per task, the single source of truth: `.paseo/state/<task-slug>.md`

```markdown
# Goal            — written once, never rewritten
# Constraints     — decisions + why, append-only, dated
# Plan            — steps with status
# Current step    — what I am doing, and the exact next action
# Key facts       — file:line pointers, commands, gotchas. Pointers, never payloads.
# Dead ends       — what was tried, why it failed
```

Three rules make it work:

- **Pointers, not payloads.** Never paste file contents. Re-reading a file after compaction is cheap;
  re-deriving a conclusion is not.
- **Write on boundary, not at the cliff.** After each completed plan step and each returned subagent —
  driven by `TaskCompleted` / `SubagentStop` hooks, which fire exactly there.
- **Dead ends are the highest-value section.** The classic post-compaction failure is confidently
  redoing something that already failed.

Ships as a **skill** (the discipline + the template) plus a hook that injects "re-read
`.paseo/state/<task>.md` before acting". That injection has to come from `SessionStart:compact`, not
`PostCompact`: `PostCompact` knows the compaction happened and hands you the `compact_summary`, but it
is not in the `hookSpecificOutput` union and so cannot reach the model at all (`RESEARCH.md` §3.3). So
the two events split the work — `PostCompact` records and leaves the pointer pending, `SessionStart`
delivers it, and `PostToolUse` delivers it if `SessionStart` ever stops firing.

### 3.4 Triggering
Mechanism: the plugin sends **`/compact <instructions>`** to the target agent through Paseo's
deliver-when-idle path — the same path `paseo-defer` already uses, and `compact` is on Paseo's
root-command list (`RESEARCH.md` §4). Instructions are templated from the state file, so the summary
is steered rather than generic.

Three modes, shipped in this order:

1. **Agent-initiated** (`request_compaction(reason)`): the agent decides, the plugin executes when
   idle. This is the direct answer to "the agent can't run `/compact` itself".
2. **Two-phase autopilot**: at threshold, first steer *"checkpoint your state file now"*; on idle,
   verify the state file was touched; then send `/compact`. Persist-then-compact, never the reverse.
3. **Handoff instead of compaction**: for a badly poisoned context, a fresh agent seeded with the
   state file beats any summary. You already have a `paseo-handoff` skill; the governor picks the
   cheaper option and says why.

**When** — policy, not a bare percentage:

```
never            mid-turn, or while Stop.background_tasks is non-empty
compact          used_pct > soft(60%)  AND at a boundary (step done / subagent returned / plan advanced)
compact anyway   used_pct > hard(85%)  at the next idle moment
prefer handoff   ≥3 compactions this session, or post-compact refill within 3 turns (CC's own
                 "autocompact is thrashing" signal)
budget-aware     five_hour > 85% → prefer a smaller/cheaper restart over a large summarization
```

And **own the auto-compact threshold** rather than fighting it: set `autoCompactWindow` /
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` to a number *above* the governor's hard threshold, so native
auto-compact becomes the backstop and the governor is the primary. Never leave both racing at the
same number.

### 3.5 Grading itself
Every compaction emits `compact_boundary` with `preTokens` / `postTokens` (`RESEARCH.md` §4), and
Paseo already parses it. Record per compaction: pre/post tokens, trigger, whether the state file was
fresh, turns-until-refill, and whether the next 3 turns produced rework. That turns the policy
constants into something you can tune with evidence instead of vibes — and it feeds the Meter's
waste panel.

---

## 4. Agent-facing surface (shared)

One MCP server (or Paseo plugin tools, if the installed version exposes tool contribution):

| tool | returns / does |
|---|---|
| `context_status()` | fill %, tokens, burn/turn, est. turns left, boundary flag |
| `budget_status()` | 5h + weekly utilization, resets_in, burn rate, projected exhaustion, advice |
| `checkpoint(notes)` | writes/updates `.paseo/state/<task>.md`, returns what changed |
| `request_compaction(reason, continue_after_compaction?, continue_message?)` | queues `/compact <templated instructions>` for delivery on idle and lets the agent choose whether and how to continue afterwards |
| `request_handoff(reason)` | queues a fresh seeded agent instead |

`budget_status()` is what lets a long-running agent pace *itself* — downshift effort, stop fanning out
subagents, or stop and wait for the window to roll (which `paseo-defer` can already schedule).

---

## 5. Phases

| Phase | Ships | Status |
|---|---|---|
| **0. Spike** | Verify `/compact` through Paseo compacts a live agent | **done** — `RESEARCH.md` §7.1 |
| **1. Recorder** | Daemon sampler → `usage-YYYY-MM.jsonl` + `context-YYYY-MM.jsonl` | **done** — `recorder.server.ts`, running since 2026-09-05 |
| **2. Backfill** | Transcript scan, dedupe on `requestId`, attribution by model/workspace/subagent | **done** — `backfill.server.ts`; 3 months and 603MB folded in 1.5s, incremental thereafter. A CLI is still absent |
| **3. Meter UI** | Blocks timeline, hour heatmap, weekly windows, composer pill | **done** — plan limits, agent context, daily bars, hour-of-week heatmap, ranked workspaces and models, recorder health. A composer pill is still absent |
| **4. Sensing** | `context_status` / `budget_status` for the agent, plus threshold injection | **done** — `mcp.mjs` (scoped by environment) and `hooks/context-threshold.mjs` |
| **5. State discipline** | `checkpoint` tool, post-compaction re-read hook, staleness nudges | **done** — the tool's shape enforces the discipline: goal/plan/current step are replaced, decisions and dead ends accumulate. The re-read pointer is delivered by `SessionStart:compact` with a `PostToolUse` fallback, since `PostCompact` cannot inject |
| **6. Agent-initiated compaction** | `request_compaction` + deliver-when-idle + grading | **done** — `governor.server.ts`, verified end to end |
| **7. Autopilot** | Two-phase policy, thrash detection, opt-in enrolment | **removed in v0.3** — replaced by Phase 8. Shipped in v0.2 and never enabled; the design below (§3.4, mode 2) was the wrong shape, because a threshold the plugin acts on is a threshold the agent did not agree to |
| **8. The ask** | `Stop` hook puts the question at a turn boundary; `request_compaction` / `defer_compaction` answer it; the governor optionally resumes the emptied session as requested | **done, on by default** — `hooks/ask-compact.mjs`. Compaction and continuation are now agent-mandated in every case |

### Thresholds scale with the window, not with the percentage

Added 2026-09-05 after seeing a 1M session sit at 400k without complaint. What degrades recall and
what costs money is the absolute prefix re-read every turn, so the bands are per window size:
a 400k+ window compacts at **30%** (300k tokens), a smaller one at 85% (170k). One percentage for
both would either nag a 200k session or let a 1M one drift for hours. `shared/thresholds.ts` holds
the profiles; the hook, the agent tools, the projection and autopilot all read them from
`settings.json`.

Phases 1–3 and 4–7 are independent after Phase 1; 4 doesn't need 3.

## 5a. What exists on disk

| File | Job |
|---|---|
| `shared/usage.ts` | normalize all three usage sources onto one id space; the freshness/acceptance gate |
| `shared/blocks.ts` | segment samples into per-window blocks; burn rate; projected exhaustion |
| `server/store.ts` | append-only JSONL logs under `$PASEO_HOME/plugin-data/smart-session/` |
| `server/daemon.ts` | borrowed Paseo daemon client: provider usage, agent context, send-to-agent |
| `server/recorder.ts` | the sampler loop |
| `server/growth.ts` | context growth rate per agent, measured from recorded history |
| `shared/governor.ts` / `server/governor.ts` | compaction contracts, instruction template, queue, delivery, grading |
| `client/surface.tsx` | the sidebar surface |
| `mcp.mjs` | the agent-facing MCP server |
| `hooks/context-threshold.mjs` | `PostToolUse`: band warnings, and fallback delivery of the compaction pointer |
| `hooks/post-compact.mjs` | `PostCompact` records and queues; `SessionStart:compact` injects |
| `hooks/pointer.mjs` | the pointer text, and the exactly-once handoff between those two events |
| `probe.mjs` | dev tool: call any plugin RPC over the protocol without a UI |

---

## 6. Risks

- **The `/compact` delivery assumption** (Phase 0 exists to kill this risk on day one).
- **Borrowed daemon client breaks on a Paseo upgrade.** One module, loud error, documented as the
  known-fragile seam. Long term: file the same upstream ask as `paseo-defer` needed — expose
  `provider.usage.list` and agent context usage in the plugin SDK.
- **Sampling gaps** when the daemon is down or the Mac sleeps. Mark gaps explicitly; never
  interpolate across one on a chart.
- **Calibration is a guess.** Show residuals, label projections as estimates, never gate an automatic
  action on a projection alone.
- **Autopilot compacting at a bad moment is worse than not compacting.** Hence: boundaries only,
  never with background tasks in flight, state file verified fresh first, and every compaction graded.
- **This plugin is unsandboxed daemon code reading `~/.claude.json` and every transcript.** All of it
  stays local, under `$PASEO_HOME`; nothing leaves the machine. Worth stating plainly in the README
  the way `paseo-defer` does.

---

## 7. Decisions taken

1. **One plugin, two surfaces** — the recorder is shared and the Governor wants `budget_status`.
   Splittable later if the Meter becomes publishable on its own.
2. **Through Mode 1 only** — the agent asks, the plugin executes. *Settled in v0.3: permanently.*
   Mode 2 (autopilot) shipped in v0.2 behind a switch, was never turned on, and has been removed. A
   percentage the plugin acts on is a decision the agent never made; the threshold now only decides
   when to *ask*, and the answer is the agent's. Mode 3 (handoff) is still open.
3. **The store is provider-generic** — every window the provider reports is recorded, including ones
   with codenames we do not recognize. Only the UI filters.
4. **Pre-reset resume is additive, not a replacement.** The existing post-reset heartbeat
   (`server/schedule-plan-resume.ts`) stays the whole story for every candidate except the single
   cheapest one per pressured window, which instead gets a heartbeat scheduled *before* `resetsAt` —
   sized from the window's own recent burn rate, less an empirically learned cache-write cost, less a
   configurable safety margin (`shared/resume-timing.ts`, `shared/cache-cost.ts`). `chat-resume`'s RPC
   is never used for this mode, since it only resumes an agent that has already exhausted quota.

RESEARCH.md §8.4-5 records two fields this feature reads from the daemon's `fetchAgents` payload
(an "archived" flag, a last-activity timestamp) that are read defensively because their real names
are unconfirmed — verify against a live payload before trusting either exclusion.

## 8. What is left

1. **Phase 5 before Phase 7.** Automatic compaction without a durable state file is the failure this
   whole design is meant to avoid.
2. **The threshold-injection hook** — a `PostToolUse` hook that stays silent until 60/75/85% and then
   injects the number. Sensing exists, but an agent that must remember to ask will not always ask.
3. **Backfill** from `~/.claude/projects/**/*.jsonl` — tokens per model/workspace/subagent, deduped on
   `requestId`, joined to blocks. The only route to history from before the recorder existed.
4. **The charts** — blocks timeline and the hour-of-day heatmap that answers "am I hardest on it
   14:00–19:00". Worth building once there is a week of samples.
5. **Register the MCP server** (`claude mcp add …`, README) — not done unprompted, since it changes how
   every Claude Code session on this machine behaves.
