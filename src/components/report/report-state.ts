import { reasonsFor, reportReason, type ReportReason } from "@/config/report-reasons";
import { ApiError } from "@/lib/auth/client";
import { REPORT_EXPLANATION_MAX, REPORT_EXPLANATION_MIN } from "@/lib/contracts/endpoints";
import type { CreateReportRequest, CreateReportResponse } from "@/lib/contracts/reports";

// The notice form's pure parts (art. 16 DSA, design D10): the reasons a target offers, grouped by
// their ground (the law, or the terms of use), what a visitor must give (name and e-mail, optional
// for P0 reasons), the request body, the refusals in the form's words, and the target delay shown
// on the receipt. No React: the dialog and the tests share them.

/** What the browser reports: a listing id, a profile publicId (also a conversation's other participant), `{cid}/{mid}`. */
export interface ReportTarget {
  type: "listing" | "user" | "message";
  id: string;
}

/** Where the notice is sent from: titles and wording follow it (a conversation reports its other participant). */
export type ReportContext = "listing" | "user" | "conversation" | "message";

export interface ReasonGroup {
  ground: "illegal" | "terms";
  reasons: ReportReason[];
}

/** The reasons of a target, illegal content first then the terms of use, each group in priority order. */
export function reasonGroups(target: ReportTarget["type"]): ReasonGroup[] {
  const reasons = reasonsFor(target);
  return (["illegal", "terms"] as const).map((ground) => ({ ground, reasons: reasons.filter((reason) => reason.ground.type === ground) })).filter((group) => group.reasons.length > 0);
}

export interface ReportDraft {
  reasonId: string | null;
  explanation: string;
  name: string;
  email: string;
  goodFaith: boolean;
}

export const EMPTY_DRAFT: ReportDraft = { reasonId: null, explanation: "", name: "", email: "", goodFaith: false };

/** A visitor's name and e-mail: required, optional for a P0 reason (art. 16(2)(c)), none for a member (the account answers). */
export function contactNeed(reason: Pick<ReportReason, "priority"> | undefined, signedIn: boolean): "required" | "optional" | "none" {
  if (signedIn) return "none";
  return reason?.priority === "P0" ? "optional" : "required";
}

export const NAME_MIN = 2;
export const NAME_MAX = 80;
export const EMAIL_MAX = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type DraftField = "reasonId" | "explanation" | "name" | "email" | "goodFaith";
export type DraftProblem = "required" | "short" | "long" | "invalid";
export type DraftProblems = Partial<Record<DraftField, DraftProblem>>;

/** What keeps the notice from being sent, field by field (the server checks the same bounds). */
export function draftProblems(draft: ReportDraft, signedIn: boolean): DraftProblems {
  const problems: DraftProblems = {};
  const reason = draft.reasonId ? reportReason(draft.reasonId) : undefined;
  if (!reason) problems.reasonId = "required";
  const explanation = draft.explanation.trim().length;
  if (explanation === 0) problems.explanation = "required";
  else if (explanation < REPORT_EXPLANATION_MIN) problems.explanation = "short";
  else if (explanation > REPORT_EXPLANATION_MAX) problems.explanation = "long";
  const need = contactNeed(reason, signedIn);
  if (need !== "none") {
    const name = draft.name.trim();
    const email = draft.email.trim();
    if (!name && need === "required") problems.name = "required";
    else if (name && name.length < NAME_MIN) problems.name = "short";
    else if (name.length > NAME_MAX) problems.name = "long";
    if (!email && need === "required") problems.email = "required";
    else if (email && (email.length > EMAIL_MAX || !EMAIL.test(email))) problems.email = "invalid";
  }
  if (!draft.goodFaith) problems.goodFaith = "required";
  return problems;
}

/** The POST body; a member's notice carries no name or e-mail (the account answers for it). */
export function reportRequest(target: ReportTarget, draft: ReportDraft, signedIn: boolean, turnstileToken?: string | null): CreateReportRequest {
  const name = draft.name.trim();
  const email = draft.email.trim();
  return {
    target,
    reasonId: draft.reasonId as CreateReportRequest["reasonId"],
    explanation: draft.explanation.trim(),
    goodFaith: true,
    ...(!signedIn && name ? { name } : {}),
    ...(!signedIn && email ? { email } : {}),
    ...(turnstileToken ? { turnstileToken } : {}),
  };
}

/** Refusals with their own words in the form (Report.errors); the rest take the generic API wording. */
export const REPORT_ERROR_KEYS = ["report_not_allowed", "report_target_invalid", "rate_limited", "unavailable", "quota_exhausted", "turnstile_failed"] as const;
export type ReportErrorKey = (typeof REPORT_ERROR_KEYS)[number];

export type ReportFailure =
  /** The session ended (a member's notice, or any message notice): sign in again. */
  | { kind: "signin" }
  /** A member past the IP allowance: the Turnstile check, then the same notice again. */
  | { kind: "challenge" }
  /** Fields the server refused (400 invalid_body with their paths). */
  | { kind: "fields"; fields: DraftProblems }
  | { kind: "message"; key: ReportErrorKey | null };

const FIELD_OF: Record<string, DraftField> = { reasonId: "reasonId", explanation: "explanation", name: "name", email: "email", goodFaith: "goodFaith" };

function fieldProblems(details: unknown): DraftProblems {
  const problems: DraftProblems = {};
  if (!Array.isArray(details)) return problems;
  for (const item of details as { path?: unknown; code?: unknown }[]) {
    const field = typeof item?.path === "string" ? FIELD_OF[item.path.split(".")[0] ?? ""] : undefined;
    if (!field) continue;
    problems[field] = item.code === "required" ? "required" : item.code === "too_small" ? "short" : item.code === "too_big" ? "long" : "invalid";
  }
  return problems;
}

/** How the form answers a refused notice. */
export function reportFailure(error: unknown): ReportFailure {
  if (!(error instanceof ApiError)) return { kind: "message", key: null };
  if (error.code === "unauthenticated") return { kind: "signin" };
  if (error.code === "turnstile_required") return { kind: "challenge" };
  if (error.code === "invalid_body") {
    const fields = fieldProblems(error.details);
    if (Object.keys(fields).length > 0) return { kind: "fields", fields };
  }
  const key = (REPORT_ERROR_KEYS as readonly string[]).includes(error.code) ? (error.code as ReportErrorKey) : null;
  return { kind: "message", key };
}

/** The target delay on the receipt: within the hour (P0), in hours, or in days. */
export function slaDelay(hours: number): { unit: "hour" } | { unit: "hours"; count: number } | { unit: "days"; count: number } {
  if (hours <= 1) return { unit: "hour" };
  if (hours < 48) return { unit: "hours", count: Math.round(hours) };
  return { unit: "days", count: Math.round(hours / 24) };
}

/** The receipt: a new notice, or the reporter's open one on the same target (200, nothing new written). */
export interface ReportReceipt extends CreateReportResponse {
  /** The decision will be mailed (an account, or a visitor who gave an address). */
  mailed: boolean;
}
