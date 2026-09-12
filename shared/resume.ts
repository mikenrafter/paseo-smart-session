/**
 * Resume marking and ETA — what the composer pill's tooltip and the overview
 * surface's "Resume" column both draw from.
 *
 * Kept separate from `shared/governor.ts`'s enrolment RPCs because the two axes
 * are independent: a session can be enrolled in Smart Compact but marked "never"
 * for resume, or vice versa.
 */

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ResumeMarkSchema = z.enum(["auto", "always", "never"]);
export type ResumeMark = z.infer<typeof ResumeMarkSchema>;

export const PendingResumeSchema = z.object({
  windowId: z.string(),
  /** "pre-reset" burns the window's last sliver of quota; "post-reset" is the ordinary path. */
  mode: z.enum(["pre-reset", "post-reset"]),
  scheduledFor: z.string().nullable(),
});

export const AgentResumeStateSchema = z.object({
  agentId: z.string(),
  mark: ResumeMarkSchema,
  pending: PendingResumeSchema.nullable(),
});
export type AgentResumeState = z.infer<typeof AgentResumeStateSchema>;

export const resumeMarkState = defineRpc({
  name: "smart-session.resume.state",
  input: z.object({}),
  output: z.object({ agents: z.array(AgentResumeStateSchema) }),
});

export const setResumeMarkRpc = defineRpc({
  name: "smart-session.resume.setMark",
  input: z.object({ agentId: z.string(), mark: ResumeMarkSchema }),
  output: z.object({ agentId: z.string(), mark: ResumeMarkSchema }),
});

/** `auto -> always -> never -> auto`, for the pill's cycle control. */
export function nextResumeMark(current: ResumeMark): ResumeMark {
  if (current === "auto") return "always";
  if (current === "always") return "never";
  return "auto";
}

export function resumeMarkLabel(mark: ResumeMark): string {
  if (mark === "always") return "Always resume";
  if (mark === "never") return "Never resume";
  return "Auto";
}
