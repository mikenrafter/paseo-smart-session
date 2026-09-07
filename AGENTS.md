# Repository instructions

## Project

- This is the trusted, unsandboxed Paseo plugin `smart-session` — note the id is `smart-session`
  while the repository and package are `paseo-smart-session`. Minimum supported Paseo is 0.7.2.
- It is two halves in one daemon process: a **meter** that records plan-usage history, and a
  **governor** that reads each agent's context occupancy and compacts a session on request.
- Check the current plugin docs at `https://paseo.sh/docs/plugins.md` and
  `https://paseo.sh/docs/plugins/reference.md` before changing runtime code.
- `RESEARCH.md` is the evidence base — every capability claim in `PLAN.md` and in the code comments
  points at a section of it. If you discover something that contradicts it, correct it there rather
  than working around it in code.
- Never commit credentials, plan-usage samples, transcripts, task state, daemon configuration, logs,
  or local paths.

## The data is the point

- `$PASEO_HOME/plugin-data/smart-session/` holds the only copy of plan-utilization history that
  exists anywhere. `/usage` is a snapshot, Paseo's quota fetcher keeps no store, and Claude Code
  overwrites its cache in place — a percentage of a plan limit cannot be reconstructed after the
  fact. Append, never rewrite; one JSON line per observation; read back defensively so one corrupt
  line cannot cost a month of history.
- The data path is fixed and deliberately decoupled from the install id, so a second install under
  `--id something-else` cannot start a second history. It also means a second install runs a second
  recorder and a second governor over the same files.
- Preserve the on-disk shapes: `usage-YYYY-MM.jsonl`, `context-YYYY-MM.jsonl`, `settings.json`,
  `enrolment.json`, `compactions.json`, `state/<agentId>.md`. Migrate rather than break them.
- `store.server.ts` owns the one-time v0.1 `super-session` to `smart-session` directory migration.
  The old name is allowed only in that migration, its regression tests, and upgrade documentation.

## Code boundaries

- Keep `index.ts` focused on contribution wiring.
- `*.client.tsx`: React Native UI and client hooks. Use `theme.colors` for text and backgrounds and
  `layout.compact` for responsive spacing.
- `*.server.ts`: Node APIs, filesystem access, daemon connections, backend behaviour.
- `*.shared.ts`: Zod RPC contracts and plain values safe in both runtimes.
- Paseo compiles `index.ts` twice and deletes the other runtime's imports and registrations, keeping
  every other statement. A server identifier left in `contribute()`'s shared body therefore survives
  with its import gone and throws at load, which silently drops **every** contribution.
  `check-bundles.mjs` is what catches that; keep `check-lib.mjs` aligned with the Paseo version in
  the README badge, since it models Paseo's compiler.
- Add nothing to `dependencies`. The server bundle must compile with no installed packages or
  `paseo plugin add` breaks; `daemon.server.ts` assembles its specifier at runtime and borrows
  Paseo's own daemon client from the host for exactly that reason — which also keeps the protocol
  version identical to the daemon's. `check-gitinstall.mjs` enforces it.
- Keep daemon connections short-lived. A long-lived socket in the plugin subprocess keeps the event
  loop alive and hangs Paseo's "Stopping plugin" step, which wedges reload for the life of the
  daemon. Every timer and resource must be released through `lifecycle.shared.ts`;
  `check-teardown.mjs` enforces it.
- `install.server.ts` writes to `~/.claude/settings.json`, which the plugin does not own. It may only
  add, update or remove entries whose command points at this checkout's `hooks/*.mjs`; it must never
  write a path it has not confirmed exists, must not write at all when reconciling changes nothing,
  and must leave a malformed file alone rather than rewriting it from a partial parse. MCP
  registration goes through `claude mcp add-json` — never edit `~/.claude.json`, which holds
  credentials.
- The load-time call lives in `install-on-load.server.ts`, not in `install.server.ts`. Importing the
  reconciler must stay free of side effects, or a test that imports it writes to the machine's real
  Claude Code settings — which is not hypothetical; it happened, and `install.test.ts` has the
  regression test for it.
- `hooks/*.mjs` and `mcp.mjs` are dependency-free Node scripts run by Claude Code, not by Paseo.
  They must stay runnable with no `node_modules` and must never fail the turn they are describing:
  wrap bookkeeping in `try`/`catch` and stay silent rather than erroring.
- `hooks/pointer.mjs` owns the exactly-once handoff between `PostCompact` and `SessionStart`.
  `PostCompact` is **not** in Claude Code's `hookSpecificOutput` union, so anything it returns there
  is rejected wholesale and injects nothing (`RESEARCH.md` §3.3); it records and queues, and
  `SessionStart` with `source: "compact"` speaks. The two fire milliseconds apart for the same
  compaction, so the delivered-marker check is load-bearing, not defensive.
- Enrolment is resolved in `settings.server.ts`: an explicit answer in `enrolment.json` outranks the
  state-file inference in both directions. Toggling is read-modify-write over one file, so it goes
  through the serializer — concurrent toggles otherwise lose one another.
- `pill.client.tsx` owns the composer pill and the `addClientSide` entrypoint. Pill state lives in a
  module-level store because the pill, its press, the Command Center item and the surface toggle are
  all in the one client bundle; that is what makes a toggle redraw immediately instead of waiting out
  a poll. A registration bakes in the workspace and cannot be patched, so an agent that moves
  workspace needs a new one, and one that closes must be dropped. The pill itself is one icon: state
  in colour, words in a hover tooltip drawn above the track, since the track is one line high and a
  pill that grew on hover would shove Paseo's own pills along.
- Command Center and sidebar icons go through Paseo's `resolvePluginIcon`, which **throws** on an
  unknown Lucide name and takes the whole contribution with it. Verify a name exists before using it.
- User-facing copy calls this **Smart compact**, never "auto-compact". Claude Code ships a feature by
  that name with its own thresholds, and borrowing it makes the pill read as a switch for that one.
  `RESEARCH.md` §4.1 and `PLAN.md` do mean Claude Code's feature when they say auto-compact; leave
  those alone.
- **Compaction is always agent-mandated.** Nothing in this plugin may decide that a session should be
  compacted; `queue.add` is reached only from an agent's `request_compaction` or a person. The ask
  lives in `hooks/ask-compact.mjs` on `Stop`, where it rides the agent's own turn.
- The plugin sends an agent exactly two things, and `sendToAgent` has exactly two call sites: the
  `/compact` the agent asked for, and the one line that hands the emptied session back its state
  file. Anything else it needs to hear comes from a hook. Adding a third is a design change, not a
  patch — if you think you need one, check `RESEARCH.md` §3.4 first, because it probably records why
  the hook route you are about to reimplement does not work.
- The resume exists because no hook can restart a task after a compaction, and it is sent only for
  queue-originated compactions, so a `/compact` a person typed is never overridden.
- Deliver only at a turn boundary, only when task state on disk is current, and never retry an
  interrupted `/compact` — it is destructive and not idempotent.
- `settings.enabled` is the master switch; `showPill` and `autoEnrol` qualify it and mean nothing
  while it is off. There is no third pill state — a session is enrolled or it is not, and with the
  feature off the pill is not drawn at all.
- Do not log secrets, tokens, task-state contents, or message bodies. Credentials are read-only.

## Verify changes

Never restart the Paseo daemon; it kills every running agent, including the one doing the work.
Reloading the plugin is safe.

### 1. Local checks

```sh
npm ci
npm run verify
```

`verify` is typecheck, the unit tests, and three structural checks, each guarding something typecheck
cannot see.

| Check | Guards |
| --- | --- |
| `check-bundles.mjs` | The dual-bundle boundary, plus the app's own registration validation, so a contribution Paseo would reject at install time fails here instead. |
| `check-gitinstall.mjs` | That both bundles still compile with no installed dependencies, which is what `paseo plugin add` does. |
| `check-teardown.mjs` | That the subprocess actually exits after cleanup. A leaked timer wedges plugin reload. |

Hook behaviour is verified against the Claude Code binary *and* a live session, never against the
public docs — `RESEARCH.md` §3.4 records four answers the schemas alone got wrong. Extract with
`strings` on `~/.local/share/claude/versions/<v>`, then confirm with a throwaway `claude -p` session
under `--settings` pointing at logging hooks.

Tests run on Node's own runner with type stripping (`node --test --experimental-strip-types`). A new
test must fail on the unfixed code for the reason it claims — delete the line it covers and watch it
fail before believing it.

### 2. Load it

```sh
paseo plugin reload smart-session
paseo plugin ls
paseo plugin logs smart-session | tail -20
```

Clean logs means no `[paseo]` error lines and no stack traces around the reload.

### 3. Backend, over the protocol

`probe.mjs` calls any plugin RPC without a UI, against the running daemon:

```sh
node probe.mjs rpc smart-session.budget '{}'
node probe.mjs rpc smart-session.context '{}'
node probe.mjs rpc smart-session.settings.get '{}'
node probe.mjs rpc smart-session.enrolment.state '{}'
node probe.mjs agents            # id, status and lastUsage for every agent
```

Round-trip anything that writes, and put the setting back afterwards. Nothing here should be run
against a daemon whose agents you do not own.

### 4. The agent-facing side

Hooks are plain stdin/stdout programs, so exercise them directly rather than by waiting for a
session to hit a threshold:

```sh
echo '{"session_id":"s1","transcript_path":"/tmp/t.jsonl","cwd":"/tmp"}' \
  | PASEO_HOME=$(mktemp -d) node hooks/context-threshold.mjs
```

`hooks.test.ts` drives every hook this way. Remember that Claude Code validates
`hookSpecificOutput.hookEventName` against a *smaller* union than its list of events, and rejects the
whole output on a name outside it.

### 5. The UI

The surface, the pill and the Command Center items can only be checked by looking. Say so plainly
when you have not looked, and never describe a screenshot you did not take.

## Create a release

- Release user-facing features, bug fixes, compatibility changes, data migrations, or installer
  changes. Documentation-only edits normally do not need a release.
- Use SemVer: patch for compatible fixes, minor for backward-compatible features, major for breaking
  behaviour, storage, or compatibility changes. Anything that changes an on-disk shape is major
  unless it migrates.
- Update the version in `package.json` and its lockfile, and the `--ref` tag in the README install
  section. Keep badge styles consistent; update the Paseo minimum only when compatibility changes.
- Release notes must include a short summary, user-visible changes, the `paseo plugin add` install
  command, the minimum Paseo version, and any breaking, migration, security, or upgrade
  considerations. Omit empty sections.
- Before publishing, require a clean current `main`, verified GitHub ownership, passing checks, a
  successful plugin reload, clean logs, and a secret audit of the exact release snapshot.
- Tag the exact release commit as `vX.Y.Z`; title the release `paseo-smart-session vX.Y.Z`. After
  publishing, test the public tag-pinned installer and the badge URLs.

Never move or rewrite a published tag. Ship corrections as a new patch release.
