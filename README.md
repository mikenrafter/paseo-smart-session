# paseo-smart-session

[![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A5%200.8.0-8A63D2?style=for-the-badge)](https://paseo.sh)
[![Release](https://img.shields.io/github/v/release/tomgrin10/paseo-smart-session?display_name=tag&sort=semver&style=for-the-badge&label=release&color=6366f1)](https://github.com/tomgrin10/paseo-smart-session/releases/latest)
[![License](https://img.shields.io/github/license/tomgrin10/paseo-smart-session?style=for-the-badge&color=2563eb)](LICENSE)

A trusted local [Paseo](https://paseo.sh) plugin, in two halves:

- **Meter** — samples the rolling 5-hour and weekly plan windows every minute and keeps the history.
  Nothing else does: `/usage` is a snapshot, Paseo's quota fetcher has no store, and Claude Code
  overwrites its cache in place. A percentage of a plan limit cannot be reconstructed after the fact.
- **Governor** — lets an agent see how full its own context is, ask to be compacted, and pick up where
  it left off afterwards.

## Install

Requires Paseo 0.8.0+ with plugins enabled (**Settings → Plugins**).

```bash
paseo plugin add tomgrin10/paseo-smart-session --ref v1.0.3
```

Paseo clones, compiles and starts it on the daemon machine — no package manager runs, and the plugin
needs no dependencies. Omit `--ref` to track `main`. The runtime id is `smart-session`:

```bash
paseo plugin ls                    # confirm it is running
paseo plugin update smart-session
paseo plugin remove smart-session
```

The hooks and the MCP server install themselves on first load — see [below](#the-hooks-install-themselves).

<details>
<summary>Upgrading from Super Session (v0.1)</summary>

The v0.2 rename changed the runtime id, so replace the installation once:

```bash
paseo plugin remove super-session
paseo plugin add tomgrin10/paseo-smart-session --ref v1.0.3
```

On first start the plugin atomically moves `$PASEO_HOME/plugin-data/super-session/` to
`plugin-data/smart-session/` before opening any files. Usage history, settings, enrolment, task state
and compaction records carry over.

</details>

<details>
<summary>From a local checkout, for developing against it</summary>

```bash
git clone https://github.com/tomgrin10/paseo-smart-session.git
cd paseo-smart-session && npm ci && npm run verify
paseo plugin install "$PWD"
```

After editing: `npm run verify && paseo plugin reload smart-session`. Never restart the daemon to pick
up a change — that kills every running agent, and a reload is enough.

`npm run verify` is the typechecker, the unit tests, and three structural checks: that both runtime
entries respect the v0.8 directory boundaries, that they compile with no `node_modules` (so a Git
install works), and that the subprocess exits after cleanup (a leaked timer wedges plugin reload).

</details>

### Password-protected daemons

Smart Session's recorder, governor, MCP server, and development probe authenticate when the daemon
has a password. They resolve the plaintext secret in this order:

1. `PASEO_PASSWORD`, the standard Paseo environment variable.
2. The file named by `PASEO_PASSWORD_FILE`.
3. `~/paseo-hub/secrets/daemon-password`, for paseo-hub hosts.

Password files may end in a newline; it is trimmed before use. Keep them readable only by their owner
(for example, `chmod 600 /path/to/daemon-password`). The plugin passes the secret directly to Paseo's
daemon client and never writes or logs it. An explicitly configured file that is missing, unreadable,
or empty fails with a generic error instead of leaking its path or contents.

## Smart compact

**A session is only ever compacted because it asked to be.** There is no threshold at which the plugin
compacts something on its own. What it does is put the question where the agent cannot miss it, at a
moment when acting on it is safe:

1. As a session fills, a `PostToolUse` hook drops one line at each band. It describes; it asks nothing.
2. The first time a turn **ends** past the compact band, a `Stop` hook asks — naming the token count,
   the state file, and what to do. This costs no extra turn and arrives at a real boundary rather than
   mid-tool-sequence.
3. The agent answers with `request_compaction`, or `defer_compaction` and a reason.
4. Only then does Paseo send anything.

The ask is latched: once per session, re-armed when occupancy climbs another 10 points, at most three
times per compaction epoch, and silent while a deferral is in force. It also stays quiet when
background tasks are still in flight, when a compaction is already queued, and when the session was
compacted minutes ago — a window that refills that fast is not a compaction problem, and it is told so.

`request_compaction` refuses while the state file is missing or stale, answering "call `checkpoint`,
then call me again", which the agent can do in the same turn. Persist, then compact.

### The two messages

These are the only things this plugin ever sends an agent:

| | What | When |
|---|---|---|
| 1 | `/compact <instructions>` | the request the agent made, delivered once it goes idle |
| 2 | one line: re-read your state file and carry on | once the compaction has landed |

The second exists because no hook can restart a task after a compaction (`RESEARCH.md` §3.4). Without
it a session that compacts mid-task simply stops: across 190 real compactions on this machine, 163
halted waiting for a person. It is sent only for queued compactions, so a `/compact` you typed yourself
is never overridden.

The compaction instructions name what must survive: the goal, the step in progress, decisions and their
reasons, and **every approach already tried and rejected** — what a summary drops, and whose loss makes
an agent confidently redo failed work.

### The bands depend on the window size

A percentage is the wrong unit alone. What tires a context — and what you pay for — is the **absolute**
prefix re-read every turn. 30% of a 1M window (300k) is heavier than 85% of a 200k one (170k).

| Window | Notice | Stop opening new work | Compact |
|---|---|---|---|
| 400k and above | 15% (150k on 1M) | 22% (220k) | **30% (300k)** |
| Under 400k | 60% (120k on 200k) | 75% (150k) | 85% (170k) |

Edit them in `$PASEO_HOME/plugin-data/smart-session/settings.json`. `SMART_SESSION_CONTEXT_WINDOW`
overrides the assumed window size; `SMART_SESSION_STATE_FILE` overrides where the state file lives.

A session without the `Stop` hook is never asked, so it fills until **Claude Code's own auto-compact**
fires — with no instructions and no pointer to the state file, which is strictly worse. Set
`autoCompactWindow` (or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`) above the compact band so the native feature
is a deliberate backstop rather than a race.

### Settings

| Setting | Default | Means |
|---|---|---|
| **Smart compact** | on | Master switch. Off, nothing is asked or compacted, and a request already made waits rather than failing. |
| **Enrol sessions automatically** | on | On, writing task state with `checkpoint` enrols a session. Off, enrol by hand from the pill. |
| **Show the pill on every agent** | on | Whether the composer carries the pill. |
| **Register the hooks with Claude Code** | on | Keeps the four hook entries in `~/.claude/settings.json`. Off removes them, and nothing will ask a session to compact itself. |

The last three only mean anything while the first is on, and the surface dims them to say so. A session
that is never enrolled is never spoken to, however full it gets.

### The pill

Every agent's composer carries a pill showing whether the governor is watching that session; pressing
it changes the answer. It is one icon — the composer track is a single line shared with Paseo's own
pills — so state is carried by colour and spelled out on hover:

| Icon | Tooltip | Means |
|---|---|---|
| Accent | **Smart compact on** | Enrolled. Will be asked, at a turn boundary, once it fills. |
| Muted | **Smart compact off** | Not enrolled. Nothing will ask it anything. |

Two states, not three: with Smart compact off the pill is not drawn at all. A press writes an explicit
answer to `enrolment.json`, which outranks the inferred one — so a checkpointing session can be taken
out, and one that has never checkpointed can be put in. Enrolling a session with no state file is safe:
the ask tells it to write one first, and `request_compaction` refuses until it has.

It is called **Smart compact**, not auto-compact: Claude Code ships a feature by that name with its own
thresholds, and this is a different thing.

## The agent-facing tools

`mcp.mjs` is a dependency-free stdio MCP server. Identity comes from `PASEO_AGENT_ID`, which Paseo sets
in every agent process, so "my context" takes no argument and cannot be aimed at the wrong session.

| Tool | What it does |
|---|---|
| `context_status` | how full this session is, how fast it is filling, when quality starts to suffer |
| `checkpoint` | write this session's durable task state |
| `request_compaction` | queue a `/compact` for this session, delivered once it goes idle |
| `defer_compaction` | not now, and here is why |
| `budget_status` | plan windows, burn rate, when each runs out and resets |

The first four need a session identity, so outside Paseo they are not offered at all — a tool that
exists and always fails is worse than one that is absent. `budget_status` stays available everywhere;
`SMART_SESSION_MCP_SCOPE=paseo` offers nothing outside Paseo. This costs almost nothing: Claude Code
defers MCP tool loading, so a short list contributes no prompt tokens, only a node process.

## The hooks

| Hook | Event | What it does |
|---|---|---|
| `context-threshold.mjs` | `PostToolUse` | silent until the first band, then one line per band per epoch; also delivers any undelivered compaction pointer |
| `ask-compact.mjs` | `Stop` | silent until the compact band, then asks the session whether to compact itself. **The only thing that ever raises the question** |
| `post-compact.mjs` | `PostCompact` | records the compaction, resets the latch, leaves the pointer pending |
| `post-compact.mjs` | `SessionStart` (matcher `compact`) | injects the pointer: re-read the state file, and where it disagrees with the summary the file wins |

The pointer takes two events because neither can do the whole job: `PostCompact` knows a compaction
happened but cannot inject, and `SessionStart:compact` can inject but does not know. They fire ~55ms
apart, so the pointer carries a delivered marker and is said exactly once. The threshold hook reads
only the tail of the transcript, so it costs about a millisecond of IO.

### The hooks install themselves

On load the plugin reconciles its own entries in `~/.claude/settings.json` and registers the MCP server
through `claude mcp add-json`. That is a write to a file it does not own, so it is narrow on purpose:

- **Only its own entries** — an entry is ours when its command points at a `hooks/*.mjs` in this
  checkout. Everything else, Paseo's own hooks included, is left byte for byte.
- **Never a path that does not exist** — the plugin directory comes from Paseo's `config.json` and is
  then checked for the scripts themselves. If they cannot be found, nothing is written and the surface
  says so.
- **Only on a real change** — every reload after the first reads two files and writes none.
- **Adopts rather than duplicates** — hand-written entries and ones left by a checkout that has since
  moved are replaced, not appended to.
- **Reversible** — the original is copied to `settings.json.smart-session-backup` before the first
  modification, and turning the setting off removes every entry it added.
- **Never touches `~/.claude.json`** — that file holds credentials, so MCP registration goes through
  Claude Code's own CLI instead.

Why at all: without the `Stop` hook the plugin records, draws charts, says "Smart compact: on" — and
never compacts anything, a failure that looks like success.

Hook paths are re-reconciled on every load, so a managed install that moves on update repairs itself.
The MCP registration is not — it is only written when absent — so after updating a managed install,
re-run `claude mcp add-json` or point it at a stable clone.

<details>
<summary>Registering the MCP server <em>only</em> for Paseo sessions</summary>

Paseo replaces the whole argv when `agents.providers.claude.command` is set, so a wrapper can append an
MCP config only Paseo agents see. In `~/.paseo/config.json`:

```json
{ "agents": { "providers": { "claude": { "command": ["/Users/you/.paseo/bin/claude-paseo"] } } } }
```

```sh
#!/bin/sh
# Paseo probes the binary with --version and parses the output; pass that through untouched.
for a in "$@"; do [ "$a" = "--version" ] && exec /Users/you/.local/bin/claude "$@"; done
exec /Users/you/.local/bin/claude "$@" --mcp-config /Users/you/.paseo/paseo-mcp.json
```

Needs a daemon restart, which interrupts every running agent — worth it only if the `tools/list` gate
above is not enough. Check `/mcp` afterwards lists both `smart-session` and Paseo's own `paseo` server.

</details>

## What it records

`$PASEO_HOME/plugin-data/smart-session/` (default `~/.paseo/plugin-data/smart-session/`):

| File | One line per |
|---|---|
| `usage-YYYY-MM.jsonl` | plan-usage reading that moved — every window, its percentage, reset instant, extra-usage credits |
| `context-YYYY-MM.jsonl` | change in an agent's context-window occupancy |
| `compactions.json` | compaction request, with token counts either side |
| `spend-index.json` | hourly token spend by model, workspace, and main-vs-subagent |
| `state/<agentId>.md` | one agent's durable task state |
| `settings.json`, `enrolment.json` | settings and per-session enrolment |

Append-only. Nothing is rewritten, and a truncated line is skipped rather than thrown on — this is the
only copy of that history.

**Getting the number right.** Of the three sources for plan limits, two are caches that can be hours
stale — Paseo's `provider.usage.list` measured 4m32s behind, `~/.claude.json` measured **14 hours**
behind — so the history is built on `GET /api/oauth/usage`, fetched directly every three minutes. Every
reading is timestamped by when the provider vouched for it, not when it was noticed, and is refused if
it is older than something already recorded. Credentials are read — never written — from
`~/.claude/.credentials.json`, falling back to the keychain.

**Backfill.** Spend from before the recorder existed is reconstructed from `~/.claude/projects/**/*.jsonl`
**and** `/tmp/claude-<uid>/**/tasks/*.output`, where subagent transcripts live — reading only the first
misses subagent spend entirely. The scan is incremental: three months and 600MB costs about a tenth of
a second.

## Security and data

Paseo plugins are trusted, unsandboxed code running on the daemon machine. This one reads Claude Code's
local usage cache and talks to the local Paseo daemon; everything it writes stays under `$PASEO_HOME`,
except the narrow, reversible reconciliation of `~/.claude/settings.json` described above. Nothing
leaves the machine. It borrows Paseo's own daemon client from the host at runtime rather than bundling
one, which is the only route to provider usage and per-agent context — neither is in the public plugin
SDK. Install only after reading the source.

## License

[MIT](LICENSE) © 2026 Tom Gringauz.
