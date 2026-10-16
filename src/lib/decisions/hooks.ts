import "server-only";
import { logger } from "@/lib/logging/logger";

// The AI lot (L4) owns the agent queue and the aiDecisions documents (design D16, D19): an open
// appeal asks for a Sonnet review (a proposal shown to the reviewer, never applied), and a human
// decision marks the proposal it followed as confirmed, edited or rejected.
// TODO(integration L4): wire with setDecisionAiHooks({
//   requestAppealReview: (decisionId) => enqueueAiTask("appeal_review", { type: "decision", id: decisionId }).then(() => undefined),
//   markAiDecision: (id, applied, reviewedBy, decisionId) => markAiDecision(id, applied, reviewedBy, decisionId),
// }) or replace the defaults once src/lib/ai exports them.

export type AiReviewOutcome = "confirmed" | "edited" | "rejected";

export interface DecisionAiHooks {
  requestAppealReview: (decisionId: string) => Promise<void>;
  markAiDecision: (aiDecisionId: string, applied: AiReviewOutcome, reviewedBy: string, decisionId: string) => Promise<void>;
}

let hooks: DecisionAiHooks = {
  requestAppealReview: async () => undefined,
  markAiDecision: async () => undefined,
};

/** Never throws: an appeal is stored even when the agent queue is down. */
export async function requestAppealReview(decisionId: string): Promise<void> {
  try {
    await hooks.requestAppealReview(decisionId);
  } catch (error) {
    logger.warn({ decisionId, err: (error as Error).message }, "decisions: appeal review request failed");
  }
}

/** Never throws: the decision is stored even when the proposal cannot be marked. */
export async function markAiDecision(aiDecisionId: string, applied: AiReviewOutcome, reviewedBy: string, decisionId: string): Promise<void> {
  try {
    await hooks.markAiDecision(aiDecisionId, applied, reviewedBy, decisionId);
  } catch (error) {
    logger.warn({ decisionId, err: (error as Error).message }, "decisions: AI proposal not marked");
  }
}

/** Wiring point (integration, tests). */
export function setDecisionAiHooks(next: Partial<DecisionAiHooks>): void {
  hooks = { ...hooks, ...next };
}
