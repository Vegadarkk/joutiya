import "server-only";
import { logger } from "@/lib/logging/logger";

// The AI lot (L4) owns the agent queue and the aiDecisions documents (design D16, D19): an open
// appeal asks for a Sonnet review (a proposal shown to the reviewer, never applied), and a human
// decision marks the proposal it followed as confirmed, edited or rejected. Imported lazily (the
// agent's providers load only when used); tests replace the hooks with setDecisionAiHooks.

export type AiReviewOutcome = "confirmed" | "edited" | "rejected";

export interface DecisionAiHooks {
  requestAppealReview: (decisionId: string) => Promise<void>;
  markAiDecision: (aiDecisionId: string, applied: AiReviewOutcome, reviewedBy: string, decisionId: string) => Promise<void>;
  /** The agent's appeal_review proposal on a decision, shown to the reviewer (never applied). */
  appealProposalId: (decisionId: string) => Promise<string | null>;
}

const ai = () => import("@/lib/ai");

let hooks: DecisionAiHooks = {
  requestAppealReview: async (decisionId) => {
    await (await ai()).enqueueAiTask("appeal_review", { type: "decision", id: decisionId });
  },
  markAiDecision: async (aiDecisionId, applied, reviewedBy, decisionId) => {
    await (await ai()).markAiDecision(aiDecisionId, applied, reviewedBy, decisionId);
  },
  appealProposalId: async (decisionId) => {
    const proposal = await (await ai()).latestAiDecision(`decision:${decisionId}`);
    return proposal?.task === "appeal_review" ? proposal.id : null;
  },
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

/** Never throws: the queue shows the appeal without a proposal. */
export async function appealProposalId(decisionId: string): Promise<string | null> {
  try {
    return await hooks.appealProposalId(decisionId);
  } catch (error) {
    logger.warn({ decisionId, err: (error as Error).message }, "decisions: appeal proposal lookup failed");
    return null;
  }
}

/** Wiring point (integration, tests). */
export function setDecisionAiHooks(next: Partial<DecisionAiHooks>): void {
  hooks = { ...hooks, ...next };
}
