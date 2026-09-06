/**
 * The Governor: letting an agent compact itself.
 *
 * An agent cannot run `/compact` — it is a client command, not something the model
 * can invoke. But Paseo parses slash commands out of any message sent to an agent
 * and honours the root-only set, `compact` included, so a request routed through
 * the daemon becomes a real compaction with real custom instructions. Verified end
 * to end: 39,325 -> 6,160 tokens with instructions honoured (RESEARCH.md §7.1).
 */

import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const CompactionStateSchema = z.enum(["pending", "sending", "sent", "failed", "cancelled"]);

export const CompactionRequestSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  /** Why the agent asked, in its own words. Goes into the compaction instructions. */
  reason: z.string(),
  /** A file the agent considers authoritative, re-read after compaction. */
  statePath: z.string().nullable(),
  createdAt: z.string(),
  state: CompactionStateSchema,
  settledAt: z.string().nullable(),
  error: z.string().nullable(),
  /** Context occupancy either side of the compaction, for grading the policy. */
  preTokens: z.number().nullable(),
  postTokens: z.number().nullable(),
});
export type CompactionRequest = z.infer<typeof CompactionRequestSchema>;

/**
 * Queues a compaction for an agent, delivered once that agent is idle.
 *
 * Never delivered mid-turn: a message arriving during a turn steers it instead of
 * arriving as its own instruction, and a compaction that interrupts a half-finished
 * tool sequence loses exactly the state the agent had not written down yet.
 */
export const requestCompaction = defineRpc({
  name: "super-session.compact.request",
  input: z.object({
    agentId: z.string(),
    reason: z.string(),
    statePath: z.string().nullable().optional(),
  }),
  output: z.object({ request: CompactionRequestSchema }),
});

export const listCompactions = defineRpc({
  name: "super-session.compact.list",
  input: z.object({ agentId: z.string().optional() }),
  output: z.object({ items: z.array(CompactionRequestSchema) }),
});

export const cancelCompaction = defineRpc({
  name: "super-session.compact.cancel",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

export const AgentEnrolmentSchema = z.object({
  agentId: z.string(),
  enrolled: z.boolean(),
  /** True when a person said so, false when it was inferred from a state file. */
  explicit: z.boolean(),
});

/**
 * Everything the composer pill draws itself from, in one round trip.
 *
 * The two global switches ride along because the pill has to tell three states
 * apart: enrolled and armed, enrolled while autopilot is off, and not enrolled.
 */
export const EnrolmentStateSchema = z.object({
  showPill: z.boolean(),
  autopilot: z.boolean(),
  /** Only agents with a state file or an explicit answer. Anyone absent is off. */
  agents: z.array(AgentEnrolmentSchema),
});
export type EnrolmentState = z.infer<typeof EnrolmentStateSchema>;

export const enrolmentState = defineRpc({
  name: "super-session.enrolment.state",
  input: z.object({}),
  output: EnrolmentStateSchema,
});

export const setEnrolment = defineRpc({
  name: "super-session.enrolment.set",
  input: z.object({ agentId: z.string(), enrolled: z.boolean() }),
  output: z.object({ agent: AgentEnrolmentSchema }),
});

/**
 * The instructions sent with `/compact`.
 *
 * Two jobs. It tells the summarizer what this particular task cannot afford to
 * lose, and — when the agent named a state file — it points the continuation at the
 * one thing on disk that is authoritative, so the quality of the summary stops
 * being load-bearing.
 */
export function compactionInstructions(request: {
  reason: string;
  statePath: string | null;
}): string {
  const parts = [
    "/compact",
    `Preserve: the current goal, the step in progress and its exact next action, decisions already made and why, and every approach already tried and rejected.`,
    `Discard: file contents already read, superseded plans, and tool output that has been acted on.`,
    `Reason for compacting now: ${request.reason}`,
  ];
  if (request.statePath !== null && request.statePath !== "") {
    parts.push(
      `Authoritative state lives at ${request.statePath}. Re-read that file before acting; where it disagrees with this summary, the file wins.`,
    );
  }
  return parts.join(" ");
}
