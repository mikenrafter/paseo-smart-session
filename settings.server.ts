/**
 * Plugin settings, on disk next to the data.
 *
 * Paseo has no plugin-settings API, so preferences are our own file — the same
 * approach paseo-defer takes.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { dataDir } from "./store.server.ts";
import { DEFAULT_THRESHOLDS, normalizeThresholds, type Thresholds } from "./thresholds.shared.ts";

export interface Settings {
  /**
   * Whether the governor may compact an agent on its own.
   *
   * Off by default, and deliberately so: a compaction fired at the wrong moment is
   * worse than one that never fires, and the state-file discipline that makes it
   * safe has to be in place first.
   */
  readonly autopilot: boolean;
  /**
   * When a context counts as too full, per window size.
   *
   * Autopilot acts at the `compact` band of whichever profile applies, so a 1M
   * session is compacted at 300k rather than being left to drift to 850k.
   */
  readonly thresholds: Thresholds;
  /** A state file older than this is treated as not describing the current work. */
  readonly freshStateMinutes: number;
  /**
   * Whether every agent's composer carries the auto-compact pill.
   *
   * On by default. Enrolment is otherwise invisible — it is a file on disk — and a
   * governor you cannot see the state of is one you stop trusting.
   */
  readonly showPill: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autopilot: false,
  thresholds: DEFAULT_THRESHOLDS,
  freshStateMinutes: 30,
  showPill: true,
};

const filePath = () => join(dataDir(), "settings.json");

let cached: Settings | null = null;

export async function readSettings(): Promise<Settings> {
  if (cached !== null) return cached;
  try {
    const raw = JSON.parse(await readFile(filePath(), "utf8")) as Partial<Settings>;
    cached = {
      autopilot: raw.autopilot === true,
      thresholds: normalizeThresholds(raw.thresholds),
      freshStateMinutes: clamp(raw.freshStateMinutes ?? DEFAULT_SETTINGS.freshStateMinutes, 1, 24 * 60),
      showPill: raw.showPill !== false,
    };
  } catch {
    cached = DEFAULT_SETTINGS;
  }
  return cached;
}

export async function writeSettings(patch: Partial<Settings>): Promise<Settings> {
  const next: Settings = { ...(await readSettings()), ...patch };
  const settings: Settings = {
    autopilot: next.autopilot === true,
    thresholds: normalizeThresholds(next.thresholds),
    freshStateMinutes: clamp(next.freshStateMinutes, 1, 24 * 60),
    showPill: next.showPill !== false,
  };
  await mkdir(dataDir(), { recursive: true });
  const target = filePath();
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2), "utf8");
  await rename(temp, target);
  cached = settings;
  return settings;
}

export function clearSettingsCache(): void {
  cached = null;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/** Where an agent's durable task state lives; mirrors the agent-facing tool. */
export function statePathFor(agentId: string): string {
  return join(dataDir(), "state", `${agentId}.md`);
}


/**
 * Whether the governor may act on one agent, and who decided.
 *
 * Enrolment is implicit by default: an agent that has written a state file has used
 * the checkpoint tool, and so knows this system exists. One that has not is never
 * steered, however full it gets. A person can override either way — that is what
 * the pill on the composer writes — and an explicit answer always outranks the
 * inferred one.
 */
export interface AgentEnrolment {
  readonly agentId: string;
  readonly enrolled: boolean;
  /** True when a person said so, false when it was inferred from a state file. */
  readonly explicit: boolean;
}

const overridesPath = () => join(dataDir(), "enrolment.json");

/** One writer at a time: a toggle is read-modify-write over a shared file. */
let tail: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readOverrides(): Promise<Record<string, boolean>> {
  try {
    const raw = JSON.parse(await readFile(overridesPath(), "utf8")) as Record<string, unknown>;
    const overrides: Record<string, boolean> = {};
    for (const [agentId, value] of Object.entries(raw)) {
      if (typeof value === "boolean") overrides[agentId] = value;
    }
    return overrides;
  } catch {
    // No file, or one we cannot read: nobody has overridden anything.
    return {};
  }
}

async function agentsWithState(): Promise<string[]> {
  try {
    const names = await readdir(join(dataDir(), "state"));
    return names.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -".md".length));
  } catch {
    return [];
  }
}

/** Sets, or reverses, one agent's enrolment by hand. */
export function setEnrolled(agentId: string, enrolled: boolean): Promise<AgentEnrolment> {
  return serialize(async () => {
    const overrides = await readOverrides();
    overrides[agentId] = enrolled;
    await mkdir(dataDir(), { recursive: true });
    const target = overridesPath();
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(overrides, null, 2), "utf8");
    await rename(temp, target);
    return { agentId, enrolled, explicit: true };
  });
}

/**
 * Every agent this plugin has an opinion about.
 *
 * An agent absent from this list is simply not enrolled: it has never checkpointed
 * and nobody has asked for it.
 */
export async function listEnrolment(): Promise<AgentEnrolment[]> {
  const resolved = new Map<string, AgentEnrolment>();
  for (const agentId of await agentsWithState()) {
    resolved.set(agentId, { agentId, enrolled: true, explicit: false });
  }
  for (const [agentId, enrolled] of Object.entries(await readOverrides())) {
    resolved.set(agentId, { agentId, enrolled, explicit: true });
  }
  return [...resolved.values()];
}

/** How many agents the governor would act on. */
export async function countEnrolled(): Promise<number> {
  return (await listEnrolment()).filter((agent) => agent.enrolled).length;
}
