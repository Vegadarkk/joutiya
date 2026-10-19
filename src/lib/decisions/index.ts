import "server-only";

// Decisions, sanctions, appeals and authority requests (design phase-5 D13-D18, D24). Server only.
// Client code imports the contracts from "@/lib/decisions/contracts" and the templates from
// "@/config/decision-templates".

export { decide, bulkDismiss, planAccount } from "./decide";
export type { BulkDismissResult, DecideOptions, DecideResult, DecisionActor, DecisionActorRole, DecisionInput, DecisionOrigin, DecisionTarget, ReversalInput } from "./decide";
export { appealLinkView, appealQueue, myDecisions, openAppealAsMember, openAppealByLink, reviewAppeal } from "./appeals";
export { resendDecisionNotice } from "./renotify";
export { authorityHold, authorityView, createAuthorityRequest, getAuthorityRequest, listAuthorityRequests, openAuthorityIds, updateAuthorityRequest } from "./authorities";
export type { AuthorityRequestRecord } from "./authorities";
export { appealToken, verifyAppealToken } from "./appeal-token";
export type { AppealBy, AppealTokenClaims, AppealTokenResult } from "./appeal-token";
export { setDecisionAiHooks } from "./hooks";
export type { AiReviewOutcome, AppealProposal, DecisionAiHooks } from "./hooks";
export { canBan, levelAfter, levelAfterReversal, nextStep, sanctionOf, suspensionUntil } from "./ladder";
export type { Sanction, StrikeLevel } from "./ladder";
export { getDecision, listDueSuspensions } from "./repository";
export type { DecisionRecord } from "./repository";
export { liftSuspension } from "./sanctions";
export { staffConversation } from "./staff-conversations";
export { computeModerationStats, moderationStats } from "./stats";
export { uidByPublicId, userModerationView } from "./users";
export { appealRefusal, appealableView, decisionView } from "./views";
