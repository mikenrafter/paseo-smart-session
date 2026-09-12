/**
 * Schedule a one-shot heartbeat that continues an agent after a plan window
 * resets — the same shape chat-resume uses for post-exhaustion resume.
 *
 * chat-resume.schedule only accepts agents that have already failed a quota
 * check, so we cannot call it while still under the limit. We try the RPC
 * first (soft-fail), then mirror its heartbeat CLI ourselves. Missing
 * chat-resume, missing CLI, or a failed schedule never throws into the
 * compaction path.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { dataDir } from "./store.ts";

const GRACE_MS = 2 * 60_000;
const MIN_DELAY_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 12_000;

const CONTINUE_PROMPT =
  "The provider token allowance should now be renewed. Continue the unfinished work from the previous turn. Review the durable task state (smart-session checkpoint) and the latest conversation before acting. Prefer the checkpoint's Current step over any stale summary.";

export interface PlanResumeResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly scheduleId?: string;
  readonly scheduledFor?: string;
  readonly via?: "chat-resume" | "heartbeat";
}

interface Marker {
  readonly agentId: string;
  readonly windowId: string;
  readonly resetAt: string;
  readonly planPct: number;
  readonly createdAt: string;
  readonly scheduleId?: string;
  readonly scheduledFor?: string;
  /** "pre-reset" when this heartbeat was placed before `resetAt` to burn leftover quota. */
  readonly mode?: "pre-reset" | "post-reset";
  readonly leadMinutes?: number;
  readonly cacheWritePctEstimate?: number;
}

function markerPath(agentId: string): string {
  return join(dataDir(), "resume-needed", `${agentId}.json`);
}

function cronAt(date: Date): string {
  return `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`;
}

function ceilToMinute(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / 60_000) * 60_000);
}

async function writeMarker(marker: Marker): Promise<void> {
  const dir = join(dataDir(), "resume-needed");
  await mkdir(dir, { recursive: true });
  const target = markerPath(marker.agentId);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(marker, null, 2), "utf8");
  await rename(temp, target);
}

/** The resume marker on file for an agent, for display — `null` when there is none. */
export async function readResumeMarker(agentId: string): Promise<{
  readonly windowId: string;
  readonly mode: "pre-reset" | "post-reset";
  readonly scheduledFor: string | null;
} | null> {
  try {
    const raw = JSON.parse(await readFile(markerPath(agentId), "utf8")) as Partial<Marker>;
    if (typeof raw.windowId !== "string" || typeof raw.scheduleId !== "string") return null;
    return {
      windowId: raw.windowId,
      mode: raw.mode ?? "post-reset",
      scheduledFor: raw.scheduledFor ?? null,
    };
  } catch {
    return null;
  }
}

async function alreadyScheduled(agentId: string, windowId: string, resetAt: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(markerPath(agentId), "utf8")) as Partial<Marker>;
    return raw.windowId === windowId && raw.resetAt === resetAt && typeof raw.scheduleId === "string";
  } catch {
    return false;
  }
}

function runPaseoJson<T>(args: readonly string[], agentId: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const executable = process.env.PASEO_CLI_PATH?.trim() || "paseo";
    const child = spawn(executable, [...args], {
      env: { ...process.env, PASEO_AGENT_ID: agentId },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result as T);
    };

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("Paseo CLI output exceeded 64 KiB."));
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        const rendered = stderr.trim() || stdout.trim() || `exit code ${code ?? "unknown"}`;
        finish(new Error(rendered));
      } else {
        try {
          finish(undefined, JSON.parse(stdout) as T);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Paseo CLI timed out while creating the plan-resume heartbeat."));
    }, COMMAND_TIMEOUT_MS);
  });
}

async function tryChatResumeSchedule(
  agentId: string,
  invokePluginRpc: ((pluginId: string, rpc: string, input: unknown) => Promise<unknown>) | undefined,
): Promise<PlanResumeResult | null> {
  if (!invokePluginRpc) return null;
  try {
    const result = (await invokePluginRpc("chat-resume", "chat-resume.schedule", { agentId })) as {
      scheduleId?: string;
      scheduledFor?: string;
    };
    if (result?.scheduleId) {
      return {
        ok: true,
        via: "chat-resume",
        scheduleId: result.scheduleId,
        scheduledFor: result.scheduledFor,
      };
    }
  } catch (error) {
    // Expected until the agent has actually exhausted quota — fall through.
    console.log(
      `[smart-session] chat-resume.schedule unavailable (${error instanceof Error ? error.message : String(error)}); using local heartbeat`,
    );
  }
  return null;
}

/**
 * Mark an agent as needing resume after `resetsAt`, and schedule a one-shot
 * heartbeat two minutes after that instant.
 */
export async function schedulePlanResume(input: {
  agentId: string;
  windowId: string;
  planPct: number;
  resetsAt: string | null;
  invokePluginRpc?: (pluginId: string, rpc: string, input: unknown) => Promise<unknown>;
  /**
   * When set to `"pre-reset"` with an explicit `scheduledAt` before `resetsAt`,
   * the heartbeat burns the window's last sliver of quota instead of waiting for
   * renewal. `chat-resume` only resumes agents that have already exhausted quota,
   * so this mode always uses the local heartbeat fallback, never the RPC handoff.
   */
  mode?: "pre-reset" | "post-reset";
  scheduledAt?: Date;
  leadMinutes?: number;
  cacheWritePctEstimate?: number;
}): Promise<PlanResumeResult> {
  const {
    agentId,
    windowId,
    planPct,
    resetsAt,
    invokePluginRpc,
    mode = "post-reset",
    scheduledAt: preferredScheduledAt,
    leadMinutes,
    cacheWritePctEstimate,
  } = input;

  if (!resetsAt) {
    const marker: Marker = {
      agentId,
      windowId,
      resetAt: "",
      planPct,
      createdAt: new Date().toISOString(),
    };
    try {
      await writeMarker(marker);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, reason: "marked without schedule (no resetsAt)" };
  }

  if (await alreadyScheduled(agentId, windowId, resetsAt)) {
    return { ok: true, reason: "already scheduled for this window" };
  }

  // chat-resume only accepts an agent that has already exhausted quota — never
  // applicable to a pre-reset resume, which fires while quota still remains.
  const viaChatResume = mode === "pre-reset" ? null : await tryChatResumeSchedule(agentId, invokePluginRpc);
  if (viaChatResume?.ok) {
    await writeMarker({
      agentId,
      windowId,
      resetAt: resetsAt,
      planPct,
      createdAt: new Date().toISOString(),
      scheduleId: viaChatResume.scheduleId,
      scheduledFor: viaChatResume.scheduledFor,
      mode: "post-reset",
    });
    return viaChatResume;
  }

  try {
    const resetAt = new Date(resetsAt);
    if (Number.isNaN(resetAt.getTime())) {
      return { ok: false, reason: `invalid resetsAt: ${resetsAt}` };
    }
    const now = Date.now();
    const scheduledAt = ceilToMinute(
      new Date(
        Math.max(
          (preferredScheduledAt ?? new Date(resetAt.getTime() + GRACE_MS)).getTime(),
          now + MIN_DELAY_MS,
        ),
      ),
    );
    const expiresInSeconds = Math.ceil((scheduledAt.getTime() - now) / 1_000) + 86_400;
    const row = await runPaseoJson<{ id?: string; nextRunAt?: string | null }>(
      [
        "heartbeat",
        "create",
        CONTINUE_PROMPT,
        "--cron",
        cronAt(scheduledAt),
        "--timezone",
        "UTC",
        "--name",
        `smart-session-plan-resume-${agentId}`,
        "--max-runs",
        "1",
        "--expires-in",
        `${expiresInSeconds}s`,
        "--json",
      ],
      agentId,
    );
    if (!row.id) return { ok: false, reason: "Paseo CLI did not return a schedule ID" };

    const scheduledFor = row.nextRunAt ?? scheduledAt.toISOString();
    await writeMarker({
      agentId,
      windowId,
      resetAt: resetsAt,
      planPct,
      createdAt: new Date().toISOString(),
      scheduleId: row.id,
      scheduledFor,
      mode,
      ...(leadMinutes !== undefined ? { leadMinutes } : {}),
      ...(cacheWritePctEstimate !== undefined ? { cacheWritePctEstimate } : {}),
    });
    return { ok: true, via: "heartbeat", scheduleId: row.id, scheduledFor };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await writeMarker({
        agentId,
        windowId,
        resetAt: resetsAt,
        planPct,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Marker write is best-effort after a schedule failure.
    }
    console.warn(`[smart-session] plan-resume schedule failed (graceful): ${reason}`);
    return { ok: false, reason };
  }
}
