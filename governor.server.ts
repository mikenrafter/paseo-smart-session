/**
 * Delivery for compaction requests.
 *
 * The queue lives on the daemon so a request survives a plugin reload, a Paseo
 * restart, and the client that made it going away. Delivery waits for the target
 * agent to be idle, then sends `/compact <instructions>` — which Paseo routes as a
 * real command rather than as text the model reads.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readAgents, sendToAgent, withDaemon, type AgentRow } from "./daemon.server.ts";
import { compactionInstructions, type CompactionRequest } from "./governor.shared.ts";
import { lifecycle } from "./lifecycle.shared.ts";
import { listEnrolment, readSettings, statePathFor } from "./settings.server.ts";
import { profileFor } from "./thresholds.shared.ts";
import { dataDir } from "./store.server.ts";

const TICK_MS = 15_000;

/**
 * How long to keep watching an agent after a compaction, to record what it
 * achieved. Compaction is a summarization turn; a minute of ticks is plenty.
 */
const GRADE_WINDOW_MS = 5 * 60_000;

const queuePath = () => join(dataDir(), "compactions.json");

let tail: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readAll(): Promise<CompactionRequest[]> {
  try {
    const raw = await readFile(queuePath(), "utf8");
    const parsed = JSON.parse(raw) as { version?: number; items?: CompactionRequest[] };
    return parsed.items ?? [];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.error("[smart-session] could not read the compaction queue", String(error));
    return [];
  }
}

async function writeAll(items: CompactionRequest[]): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const target = queuePath();
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, items }, null, 2), "utf8");
  await rename(temp, target);
}

export const queue = {
  list: (): Promise<CompactionRequest[]> => serialize(readAll),

  add: (input: { agentId: string; reason: string; statePath: string | null }): Promise<CompactionRequest> =>
    serialize(async () => {
      const items = await readAll();
      const request: CompactionRequest = {
        id: randomUUID(),
        agentId: input.agentId,
        reason: input.reason,
        statePath: input.statePath,
        createdAt: new Date().toISOString(),
        state: "pending",
        settledAt: null,
        error: null,
        preTokens: null,
        postTokens: null,
      };
      items.push(request);
      await writeAll(items);
      return request;
    }),

  update: (id: string, patch: Partial<CompactionRequest>): Promise<CompactionRequest | null> =>
    serialize(async () => {
      const items = await readAll();
      const found = items.find((item) => item.id === id);
      if (found === undefined) return null;
      Object.assign(found, patch);
      await writeAll(items);
      return found;
    }),

  /**
   * A request interrupted mid-send is failed, never retried.
   *
   * `/compact` is destructive and not idempotent: sending a second one after a
   * restart could discard a context the first one already summarized. Failing
   * closed costs one compaction; retrying could cost the task.
   */
  recoverInterrupted: (): Promise<number> =>
    serialize(async () => {
      const items = await readAll();
      let count = 0;
      for (const item of items) {
        if (item.state !== "sending") continue;
        item.state = "failed";
        item.error = "The plugin stopped while sending; not retried, because a second /compact is destructive.";
        item.settledAt = new Date().toISOString();
        count += 1;
      }
      if (count > 0) await writeAll(items);
      return count;
    }),
};

/**
 * Autopilot.
 *
 * Deliberately narrow. It acts on one signal (the window is nearly full), at one
 * moment (the agent just went idle, so a turn boundary), and only for agents that
 * are enrolled — implicitly by having written a state file at least once, since
 * using `checkpoint` is the enrolment, or explicitly from the composer pill. An
 * agent that has never heard of this system is never steered by it.
 *
 * And it never compacts a session whose state file is missing or stale. It asks for
 * a checkpoint first and compacts on a later tick. Persist, then compact: the other
 * order is how you lose the work.
 */
const NUDGE_COOLDOWN_MS = 10 * 60_000;

/** When a session was last asked to checkpoint, so it is not asked every 15s. */
const nudged = new Map<string, number>();

/**
 * A compaction that had to be repeated within minutes is not solving the problem —
 * something in the loop is refilling the window as fast as it is emptied, and
 * another compaction just burns tokens on summarizing. Claude Code detects the same
 * pathology and calls it thrashing.
 */
const THRASH_WINDOW_MS = 15 * 60_000;

async function stateFreshness(agentId: string, freshMinutes: number): Promise<"missing" | "stale" | "fresh"> {
  try {
    const info = await stat(statePathFor(agentId));
    return Date.now() - info.mtimeMs > freshMinutes * 60_000 ? "stale" : "fresh";
  } catch {
    return "missing";
  }
}

async function autopilot(agents: Iterable<AgentRow>, client: Parameters<typeof sendToAgent>[0]): Promise<void> {
  const settings = await readSettings();
  if (!settings.autopilot) return;

  const history = await queue.list();
  const enrolled = new Set(
    (await listEnrolment()).filter((agent) => agent.enrolled).map((agent) => agent.agentId),
  );

  for (const agent of agents) {
    if (agent.status !== "idle") continue;
    if (agent.usedTokens === null || agent.maxTokens === null || agent.maxTokens === 0) continue;

    const pct = (agent.usedTokens / agent.maxTokens) * 100;
    // The bar depends on the window: a million-token session is compacted at 30%,
    // a 200k one not until 85%, because 300k of prefix is heavier than 170k.
    const profile = profileFor(agent.maxTokens, settings.thresholds);
    if (pct < profile.compact) continue;

    const mine = history.filter((item) => item.agentId === agent.id);
    // Already queued for this agent: nothing to add.
    if (mine.some((item) => item.state === "pending" || item.state === "sending")) continue;

    const recent = mine.find(
      (item) =>
        item.state === "sent" &&
        item.settledAt !== null &&
        Date.now() - Date.parse(item.settledAt) < THRASH_WINDOW_MS,
    );
    if (recent !== undefined) {
      console.error(
        `[smart-session] ${agent.id.slice(0, 8)} refilled to ${Math.round(pct)}% within minutes of compacting; not compacting again. Something in this loop is reading more than it keeps — a fresh session would serve it better.`,
      );
      continue;
    }

    // An agent with no state file has never used checkpoint, so it has not asked to
    // be governed. Unless someone enrolled it by hand, leave it alone.
    if (!enrolled.has(agent.id)) continue;

    const freshness = await stateFreshness(agent.id, settings.freshStateMinutes);
    if (freshness !== "fresh") {
      const last = nudged.get(agent.id) ?? 0;
      if (Date.now() - last < NUDGE_COOLDOWN_MS) continue;
      nudged.set(agent.id, Date.now());
      await sendToAgent(
        client,
        agent.id,
        `Your context is ${Math.round(pct)}% full and ${
          freshness === "missing"
            ? "you have no task state on disk"
            : "your task state on disk is older than the work it describes"
        }. Bring it up to date with the checkpoint tool now — goal, the step in progress and its exact next action, decisions and why, and every approach already tried and rejected. Do that and stop; you will be compacted straight after, and anything not written down will be gone.`,
      );
      console.log(`[smart-session] asked ${agent.id.slice(0, 8)} to checkpoint before compacting`);
      continue;
    }

    await queue.add({
      agentId: agent.id,
      reason: `context reached ${Math.round(pct)}% of the window and task state on disk is current`,
      statePath: statePathFor(agent.id),
    });
    console.log(`[smart-session] autopilot queued a compaction for ${agent.id.slice(0, 8)} at ${Math.round(pct)}%`);
  }
}

/** Agents whose post-compaction size we still want to record. */
const grading = new Map<string, { requestId: string; preTokens: number | null; until: number }>();

async function flush(): Promise<void> {
  const pending = (await queue.list()).filter((item) => item.state === "pending");
  const settings = await readSettings();
  // No queued work, nothing to grade and autopilot off means no reason to open a
  // connection at all.
  if (pending.length === 0 && grading.size === 0 && !settings.autopilot) return;

  await withDaemon(async (client) => {
    const agents = new Map<string, AgentRow>();
    for (const agent of await readAgents(client)) agents.set(agent.id, agent);

    await autopilot(agents.values(), client);

    // Grade compactions that have already landed.
    for (const [agentId, watch] of [...grading]) {
      const agent = agents.get(agentId);
      if (Date.now() > watch.until || agent === undefined) {
        grading.delete(agentId);
        continue;
      }
      if (agent.status !== "idle" || agent.usedTokens === null) continue;
      if (watch.preTokens !== null && agent.usedTokens >= watch.preTokens) continue; // Not shrunk yet.
      await queue.update(watch.requestId, { postTokens: agent.usedTokens });
      grading.delete(agentId);
    }

    for (const item of pending) {
      const agent = agents.get(item.agentId);
      if (agent === undefined || agent.status === "closed") {
        await queue.update(item.id, {
          state: "failed",
          error: "The target session is gone.",
          settledAt: new Date().toISOString(),
        });
        continue;
      }
      // Sending into a live turn steers it instead of arriving as its own
      // instruction, and compacting mid-turn discards exactly the working state the
      // agent has not written down yet. Wait for the next tick instead.
      if (agent.status !== "idle") continue;

      // Claim before sending, so a crash cannot produce a second /compact.
      const claimed = await queue.update(item.id, { state: "sending", preTokens: agent.usedTokens });
      try {
        await sendToAgent(client, item.agentId, compactionInstructions(claimed ?? item));
        await queue.update(item.id, { state: "sent", settledAt: new Date().toISOString() });
        grading.set(item.agentId, {
          requestId: item.id,
          preTokens: agent.usedTokens,
          until: Date.now() + GRADE_WINDOW_MS,
        });
        console.log(`[smart-session] compacted ${item.agentId.slice(0, 8)} (${item.reason})`);
      } catch (error) {
        await queue.update(item.id, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          settledAt: new Date().toISOString(),
        });
      }
    }
  });
}

function startGovernor(): void {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await flush();
    } catch (error) {
      console.error("[smart-session] governor tick failed", String(error));
    } finally {
      running = false;
    }
  };

  void queue
    .recoverInterrupted()
    .then((count) => {
      if (count > 0) console.error(`[smart-session] failed ${count} compaction(s) interrupted by a restart`);
    })
    .catch((error: unknown) => console.error("[smart-session] recovery failed", String(error)))
    .then(tick);

  const timer = setInterval(() => void tick(), TICK_MS);

  lifecycle.teardowns.push(() => {
    stopped = true;
    clearInterval(timer);
    grading.clear();
    nudged.clear();
  });
}

startGovernor();
