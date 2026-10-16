import "server-only";
import { REPORT_PRIORITIES, REPORT_REASON_IDS, reportReason } from "@/config/report-reasons";
import { z } from "@/lib/zod";
import { AI_ACTIONS, TASK_TARGET, type AiOutput, type AiTask } from "./types";

// Structured output of the Claude provider (design D19). The JSON schema sent with
// `output_config.format` may not carry numeric or length bounds, so the model schema has none and
// `clampOutput` bounds every field after the parse (confidence 0-1, text lengths, policy valid for
// the target). Every provider's output goes through `clampOutput` before it is stored.

export const POLICIES = [...REPORT_REASON_IDS, "none"] as const;
export type Policy = (typeof POLICIES)[number];

/** A stored reason id as a policy ("none" when unknown). */
export const asPolicy = (id: string): Policy => ((POLICIES as readonly string[]).includes(id) ? (id as Policy) : "none");

/** What Claude answers (all fields required; empty strings when not applicable). */
export const modelOutputSchema = z
  .object({
    action: z.enum(AI_ACTIONS),
    policy: z.enum(POLICIES).describe("Report reason id that applies, or none"),
    severity: z.enum([...REPORT_PRIORITIES, "none"]),
    confidence: z.number().describe("Probability between 0 and 1 that the action is right"),
    rationale: z.string().describe("Short French explanation for the moderator, no personal data"),
    userMessage: z.string().describe("Draft French statement for the affected user, empty when not applicable"),
    templateId: z.string().describe("Suggested decision template id, empty when unknown"),
  })
  .strict();
export type ModelOutput = z.infer<typeof modelOutputSchema>;

export const RATIONALE_MAX = 1000;
export const USER_MESSAGE_MAX = 1500;
const TEMPLATE_ID = /^[a-z][a-z0-9_]{0,63}$/;

const clip = (text: string, max: number) => {
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** A policy that does not apply to the task's target becomes "none" (a listing cannot be "harassment"). */
function policyFor(task: AiTask, policy: string): Policy {
  if (policy === "none") return "none";
  const reason = reportReason(policy);
  if (!reason) return "none";
  const target = TASK_TARGET[task];
  // Report triage and appeal review may name any reason; screening only those of a listing.
  if (target === "listing" && !(reason.targets as readonly string[]).includes("listing")) return "none";
  return reason.id as Policy;
}

/** Bounds a provider's answer to what aiDecisions accepts (design D19: clamp after parse). */
export function clampOutput(task: AiTask, raw: ModelOutput): AiOutput {
  const confidence = Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0;
  const userMessage = clip(raw.userMessage ?? "", USER_MESSAGE_MAX);
  const templateId = (raw.templateId ?? "").trim().toLowerCase();
  return {
    action: raw.action,
    policy: policyFor(task, raw.policy),
    severity: raw.severity,
    confidence: Math.round(confidence * 1000) / 1000,
    rationale: clip(raw.rationale ?? "", RATIONALE_MAX) || "Sans motif fourni.",
    ...(userMessage ? { userMessage } : {}),
    ...(TEMPLATE_ID.test(templateId) ? { templateId } : {}),
  };
}

/** The neutral "a human decides" proposal of a fallback that found nothing (or of the rules provider). */
export function escalation(rationale: string, severity: AiOutput["severity"] = "none", policy: Policy = "none"): AiOutput {
  return { action: "escalate", policy, severity, confidence: 0, rationale: clip(rationale, RATIONALE_MAX) };
}
