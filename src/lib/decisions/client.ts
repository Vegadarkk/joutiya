import { apiGet, apiPost } from "@/lib/auth/client";
import { APPEAL_API } from "@/lib/contracts/endpoints";
import type { MyDecisionsResponse, OpenAppealResponse } from "./contracts";

// Browser side of the appeals (art. 20 DSA, design D16): the account's decisions and its appeals
// (session + CSRF), and the appeal through the signed link of a decision or outcome mail (no
// session). Type-only contract imports.

/** GET /api/appeals: the decisions about my account, newest first (suspended accounts too). */
export function fetchMyDecisions(): Promise<MyDecisionsResponse> {
  return apiGet<MyDecisionsResponse>(APPEAL_API.appeals);
}

/** POST /api/appeals: my appeal of one decision. */
export function openAppeal(decisionId: string, text: string): Promise<OpenAppealResponse> {
  return apiPost<OpenAppealResponse>(APPEAL_API.appeals, { decisionId, text });
}

/** POST /api/appeals/link: the appeal of the decision the mail's signed link names. */
export function openLinkAppeal(token: string, text: string): Promise<OpenAppealResponse> {
  return apiPost<OpenAppealResponse>(APPEAL_API.link, { token, text });
}
