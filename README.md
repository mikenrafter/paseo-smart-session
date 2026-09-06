# paseo-smart-session

[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.7.2-8A63D2?style=for-the-badge)](https://paseo.sh)
[![Release](https://img.shields.io/github/v/release/tomgrin10/paseo-smart-session?display_name=tag&sort=semver&style=for-the-badge&label=release&color=6366f1)](https://github.com/tomgrin10/paseo-smart-session/releases/latest)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-smart-session?style=for-the-badge&color=2563eb)](LICENSE)

A trusted local [Paseo](https://paseo.sh) plugin that records what your Claude plan usage actually
did over time, and lets an agent notice how full its own context is and ask to be compacted.

Two halves, one daemon process:

- **Meter** — samples the rolling 5-hour and weekly plan windows every minute and keeps the history.
  Nothing else does: `/usage` is a snapshot, Paseo's quota fetcher has no store, and Claude Code's
  on-disk copy is overwritten in place. Percentages of a plan limit cannot be reconstructed after the
  fact, so the recorder starts on load and runs whether or not anything is looking at it.
- **Governor** — reads each agent's context-window occupancy from Paseo, and turns an agent's request
  into a real `/compact`, delivered when that agent is idle and steered by instructions.

## Install

Requires Paseo 0.7.2 or newer with plugins enabled — enable them in **Settings → Plugins** first if
they are off.

```bash
paseo plugin add tomgrin10/paseo-smart-session
```

That is the whole install for the daemon side: the recorder, the surface, the governor and the pill.
Paseo clones the repository on the daemon machine, compiles it, and starts it — no package manager
runs, and the plugin needs no installed dependencies. Pin a tag with `--ref v0.2.0`.

The plugin's id is `smart-session`, so that is the name the rest of the commands take:

```bash
paseo plugin ls                    # confirm it is running
paseo plugin update smart-session  # later, pull the newest version
paseo plugin remove smart-session
```

### Upgrading from Super Session

The v0.2 rename changes the runtime id, so replace the old installation once:

```bash
paseo plugin remove super-session
paseo plugin add tomgrin10/paseo-smart-session --ref v0.2.0
```

On first start, Smart Session atomically moves the existing
`$PASEO_HOME/plugin-data/super-session/` directory to `plugin-data/smart-session/` before opening
any files. Usage history, settings, enrolment, task state and compaction records carry over. Then
replace the old Claude MCP registration and update the hook paths shown below.

**The agent-facing side wants a checkout of its own.** The MCP server and the hooks are separate
processes that Claude Code launches by absolute path, and a managed install lives under
`$PASEO_HOME/plugins/smart-session/<commit>-<uuid>/checkout`, which moves on every update — so any
path you register there breaks the next time you update. Clone the repository somewhere stable and
point [the MCP server](#the-agent-facing-side) and [the hooks](#knowing-without-being-asked) at that
copy. Both read the same files under `$PASEO_HOME`, so the two copies stay in agreement.

<details>
<summary>From a local checkout, for developing against it</summary>

```bash
git clone https://github.com/tomgrin10/paseo-smart-session.git
cd paseo-smart-session
npm ci
npm run verify
paseo plugin install "$PWD"
```

After editing the source, `npm run verify && paseo plugin reload smart-session`. Never restart the
daemon to pick up a change: that kills every running agent, and a reload is enough.

</details>

`npm run verify` runs the typechecker, the unit tests, and three structural checks copied from
`paseo-defer`: that both bundles build with no reference to a stripped import, that the plugin still
compiles with no `node_modules` (so a Git install works), and that the subprocess actually exits
after cleanup — a leaked timer wedges plugin reload for the life of the daemon.

## What it records

`$PASEO_HOME/plugin-data/smart-session/` (default `~/.paseo/plugin-data/smart-session/`):

| File | One line per |
|---|---|
| `usage-YYYY-MM.jsonl` | plan-usage reading that moved — every limit window, its percentage, its reset instant, and extra-usage credits |
| `context-YYYY-MM.jsonl` | change in an agent's context-window occupancy |
| `compactions.json` | compaction request, with the token counts either side of it |
| `spend-index.json` | hourly token spend reconstructed from transcripts, by model, workspace and main-vs-subagent |
| `state/<agentId>.md` | one agent's durable task state |
| `settings.json` | governor settings |

Append-only. Nothing is ever rewritten, and a truncated line is skipped rather than thrown on —
this is the only copy of that history.

### Getting the number right

Three sources report these limits, and two of them are caches that can be hours stale:

- **`GET /api/oauth/usage`, fetched directly**, every three minutes. This is the only source with no
  cache in front of it, and it is what the history is built on. Credentials are read — never written
  — from `~/.claude/.credentials.json`, falling back to the keychain.
- **Paseo's `provider.usage.list`**, every minute. Free, and honest about its age: `fetchedAt` is the
  instant of the upstream fetch. But it is served from a 5-minute cache that nothing refreshes on a
  timer, and `forceRefresh` is not reachable over the wire — measured 4m32s stale on a routine read.
- **`~/.claude.json` → `cachedUsageUtilization`**, only when nothing live has answered for 15 minutes.
  It refreshes only when a Claude Code session refreshes it — in practice when someone runs `/usage`.
  Measured **14 hours** behind, reporting a weekly window at 3% that was really at 9%.

(Separately: what Paseo *displays* can be older still. Its `useProviderUsage` hook sets a 5-minute
`staleTime` with no `refetchInterval` and no refetch on window focus, so a usage panel left open
never updates. That is a UI issue, not a data one — this plugin does not read through it.)

So every reading is timestamped by **when the provider vouched for it**, not when it was noticed, and
is refused if it is older than something already recorded or if a window appears to have un-filled
without rolling over. A stale cache can add detail; it can never overwrite a fresher truth.

## The agent-facing side

`mcp.mjs` is a dependency-free stdio MCP server exposing three tools to the agent itself:

| Tool | What it answers |
|---|---|
| `context_status` | how full this session is, how fast it is filling, when quality starts to suffer |
| `budget_status` | plan windows, burn rate, when each would run out, when each resets |
| `request_compaction` | queue a `/compact` for this session, delivered once it goes idle |

Identity comes from `PASEO_AGENT_ID`, which Paseo sets in every agent process, so "my context" takes
no argument and cannot be aimed at the wrong session.

Three of the four tools are about *this* session and need that identity. Outside Paseo they cannot
work, so they are not offered — a tool that exists and always fails is worse than one that is absent.
`budget_status` needs no session identity and stays available everywhere.

```bash
claude mcp add smart-session --scope user -- node /path/to/paseo-smart-session/mcp.mjs
```

| Where | Tools offered |
|---|---|
| Inside a Paseo agent | all four |
| Any other Claude Code session | `budget_status` only |
| Any other session, with `SMART_SESSION_MCP_SCOPE=paseo` | none |

This costs nothing outside Paseo: Claude Code defers MCP tool loading, so tools appear as bare names
until something asks for a schema, and a server that lists nothing contributes nothing to the prompt.
The residual cost is one node process per session.

<details>
<summary>Registering it <em>only</em> for Paseo sessions</summary>

Paseo replaces the whole argv when `agents.providers.claude.command` is set, so a wrapper can append
an MCP config that only Paseo agents ever see. In `~/.paseo/config.json`:

```json
{ "agents": { "providers": { "claude": { "command": ["/Users/you/.paseo/bin/claude-paseo"] } } } }
```

```sh
#!/bin/sh
# Paseo probes the binary with --version and parses the output; pass that through untouched.
for a in "$@"; do [ "$a" = "--version" ] && exec /Users/you/.local/bin/claude "$@"; done
exec /Users/you/.local/bin/claude "$@" --mcp-config /Users/you/.paseo/paseo-mcp.json
```

This needs a daemon restart, which interrupts every running agent — so it is worth doing only if the
`tools/list` gate above is not enough. Check `/mcp` afterwards lists both `smart-session` and Paseo's
own `paseo` server: Paseo already passes one `--mcp-config`, and whether a second occurrence
accumulates or replaces is untested.

</details>

## Knowing without being asked

Hooks make the agent aware of its own state without it having to remember to look:

| Hook | Event | What it does |
|---|---|---|
| `hooks/context-threshold.mjs` | `PostToolUse` | silent until the first band; injects one line on crossing each of notice / closing / compact, once per band per compaction epoch — and delivers any undelivered compaction pointer |
| `hooks/post-compact.mjs` | `PostCompact` | records the compaction, resets the threshold latch, and leaves the state-file pointer pending |
| `hooks/post-compact.mjs` | `SessionStart` (matcher `compact`) | injects the pointer into the emptied context: re-read the state file, and where it disagrees with the summary the file wins |

**Why the pointer takes two events.** `PostCompact` is the event that knows a compaction happened,
but Claude Code validates `hookSpecificOutput.hookEventName` against a union that has no `PostCompact`
variant, so anything it returns there is rejected wholesale and injects nothing — observed in
production as `Hook JSON output validation failed`. `SessionStart` with `source: "compact"` runs in
the fresh context and does accept `additionalContext`, so it does the talking. Measured ordering on a
real compaction: `SessionStart:compact` fires ~55ms **before** `PostCompact`, so the pointer carries a
delivered marker and the later event stays quiet. If `SessionStart` ever stops firing, the pointer
stays pending and the next `PostToolUse` delivers it — either way it is said exactly once.

The threshold hook reads only the tail of the transcript, so it costs about a millisecond of IO on
the hot path.

### The bands depend on the window size

A percentage of the window is the wrong unit on its own. What tires a context — and what you pay for
— is the **absolute** prefix re-read on every turn. So 30% of a million-token window (300k) is a
heavier context than 85% of a 200k one (170k), and one set of percentages would either nag a small
session or let a large one drift for hours.

| Window | Notice | Stop opening new work | Compact |
|---|---|---|---|
| 400k and above | 15% (150k on 1M) | 22% (220k) | **30% (300k)** |
| Under 400k | 60% (120k on 200k) | 75% (150k) | 85% (170k) |

A large window is asked to compact long before the ceiling, because the ceiling was never the
constraint. A small window is allowed to fill, because its ceiling arrives before its context gets
unwieldy.

Edit them in `$PASEO_HOME/plugin-data/smart-session/settings.json`; the hook, the agent-facing tools
and autopilot all read that one file. `SMART_SESSION_CONTEXT_WINDOW` overrides the assumed window
size for a session, and `SMART_SESSION_STATE_FILE` overrides where the state file lives.

Install the hooks by adding to `~/.claude/settings.json`:

```jsonc
"hooks": {
  "PostToolUse":  [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/paseo-smart-session/hooks/context-threshold.mjs", "timeout": 10 }] }],
  "PostCompact":  [{ "matcher": "", "hooks": [{ "type": "command", "command": "node /path/to/paseo-smart-session/hooks/post-compact.mjs", "timeout": 10 }] }],
  // Same script, second event — this is the one that can actually inject.
  "SessionStart": [{ "matcher": "compact", "hooks": [{ "type": "command", "command": "node /path/to/paseo-smart-session/hooks/post-compact.mjs", "timeout": 10 }] }]
}
```

## Where the tokens went

The recorder only knows what it has watched. Token spend from before it existed is still recoverable,
because every assistant message carries its own usage — so `backfill.server.ts` reconstructs it from
`~/.claude/projects/**/*.jsonl` **and** from `/tmp/claude-<uid>/**/tasks/*.output`, which is where
subagent transcripts actually live. Accounting that reads only the first directory misses subagent
spend entirely.

The scan is incremental — each file is read from where the last scan stopped — so re-folding three
months and 600MB of transcripts costs about a tenth of a second. It yields tokens per hour, split by
model, by workspace, and by main-thread versus subagent, plus the cache hit ratio, which is the
largest single cost lever there is.

## Autopilot

Off by default. When switched on, the governor compacts an agent when all of these hold:

- the window is past that window size's compact band (30% on 1M, 85% on 200k), and
- the agent is **idle**, so this is a turn boundary, and
- its state file on disk is **current** — if it is stale, the agent is asked to checkpoint first and
  compacted on a later tick, and
- it has not just been compacted. A window that refills within minutes is not a compaction problem;
  something in the loop is reading more than it keeps, and a fresh session would serve it better.

Enrolment is implicit by default: an agent that has written a state file has used the `checkpoint`
tool, and so knows this system exists. One that never has is never steered, however full it gets.

## The pill

Enrolment used to be a file on disk and nothing else, so there was no way to look at a session and
tell whether the governor was watching it. Every agent's composer now carries a pill that says, and
pressing it changes the answer.

It is called **Smart compact**, not auto-compact: Claude Code already ships a feature by that name
which fires on its own thresholds, and this is a different thing — it compacts at a turn boundary,
against the band for that window size, with instructions and a state file behind it.

It is one icon. The composer track is a single line shared with Paseo's own pills, so the state is
carried by colour and spelled out on hover:

| Icon | Tooltip | Means |
| --- | --- | --- |
| Accent | **Smart compact on** | Enrolled, autopilot armed. This session will be compacted when it fills. |
| Amber | **Smart compact paused** | Enrolled, but autopilot is off globally, so nothing will happen. |
| Muted | **Smart compact off** | Not enrolled. |

The tooltip also says what a press will do. Touch platforms have no hover and read the colour.

A pressed pill writes an explicit answer to `enrolment.json`, and an explicit answer outranks the
inferred one — so a checkpointing session can be taken out, and one that has never checkpointed can
be put in. Enrolling an agent with no state file does not compact it blind: the governor asks it to
checkpoint first and compacts on a later tick, exactly as it does for a stale one.

Hide the pill from the Command Center — *Show or hide the smart-compact pill* — or from the toggle in
the plugin's own surface. Hiding it changes nothing about who is enrolled.

## Why compaction has to be steered

An agent cannot run `/compact`; it is a client command. But Paseo parses slash commands out of any
message sent to an agent and honours the root-only set, `compact` among them — so a queued request
becomes a real compaction, with real custom instructions. Measured end to end: 39,325 → 6,160 tokens,
instructions honoured.

The instructions matter more than the trigger. They name what must survive — the goal, the step in
progress, decisions and their reasons, and **every approach already tried and rejected**, which is the
thing a summary drops and whose loss makes an agent confidently redo failed work. When the agent
passes a `state_path`, the continuation is told to re-read that file and to trust it over the summary,
which is what stops summary quality from being load-bearing.

Delivery waits for the agent to be idle. A message arriving mid-turn steers that turn instead of
arriving as its own instruction, and compacting through a half-finished tool sequence discards exactly
the working state the agent has not written down yet. A request interrupted by a restart is failed,
never retried: `/compact` is destructive and not idempotent.

## Security and data

Paseo plugins are trusted, unsandboxed code running on the daemon machine. This one reads Claude
Code's local usage cache and talks to the local Paseo daemon; everything it writes stays under
`$PASEO_HOME`. Nothing leaves the machine. It borrows Paseo's own daemon client from the host at
runtime rather than bundling one, which is the only route to provider usage and per-agent context —
neither is in the public plugin SDK. Install only after reading the source.

## License

[MIT](LICENSE) © 2026 Tom Gringauz.
