import { z } from "@/lib/zod";
import {
  DECISION_TEMPLATE_IDS,
  DETAILS_MAX,
  DETAILS_MIN,
  SANCTION_ACTIONS,
  decisionTemplate,
  type DecisionAction,
  type DecisionTargetType,
  type SanctionAction,
} from "@/config/decision-templates";
import { REPORT_REASON_IDS } from "@/config/report-reasons";
import { parseTargetKey } from "@/lib/reports/target-key";

// Back-office contracts of the decisions, sanctions, appeals and authority requests (design
// phase-5 D13-D18, D24). Client-safe: the back-office forms (U3) import the schemas and the
// response types; the server validates every body with them (strict objects only).

/** Firestore auto ids (decisions, reports, AI proposals, authority requests). */
export const docIdSchema = z.string().regex(/^[A-Za-z0-9]{20}$/);
const targetKeySchema = z.string().min(3).max(160);
const suspensionDaysSchema = z.union([z.literal(7), z.literal(30)]);

/** Where the signed appeal link of the decision mails leads (U2 page `/{locale}/recours?jeton=`). */
export const APPEAL_PAGE = "recours";
export const APPEAL_TOKEN_PARAM = "jeton";

export const sanctionSchema = z.object({ action: z.enum(SANCTION_ACTIONS), durationDays: suspensionDaysSchema.optional() }).strict();
export type SanctionInput = z.infer<typeof sanctionSchema>;

/**
 * POST /api/admin/decisions: one decision on one target (`{type}:{id}` key), closing every open
 * report of that target. `details`: the moderator's own words, quoted in the statement.
 * `sanction`: an account measure applied with a content decision (a P0 template bans anyway).
 * `manifestlyUnfounded`: dismissals only, every report (true) or these ids (art. 23).
 */
export const decideSchema = z
  .object({
    target: targetKeySchema,
    templateId: z.enum(DECISION_TEMPLATE_IDS),
    details: z.string().trim().max(DETAILS_MAX).optional(),
    sanction: sanctionSchema.optional(),
    manifestlyUnfounded: z.union([z.literal(true), z.array(docIdSchema).min(1).max(100)]).optional(),
    ai: z.object({ decisionId: docIdSchema, outcome: z.enum(["confirmed", "edited", "rejected"]) }).strict().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const target = parseTargetKey(input.target);
    if (!target || target.type === "pro") {
      ctx.addIssue({ code: "custom", path: ["target"], message: "invalid" });
      return;
    }
    const template = decisionTemplate(input.templateId);
    if (!template || template.internal || !template.targets.includes(target.type)) ctx.addIssue({ code: "custom", path: ["templateId"], message: "invalid_for_target" });
    if (template?.detailsRequired && (input.details ?? "").length < DETAILS_MIN) ctx.addIssue({ code: "custom", path: ["details"], message: "required" });
    if (input.sanction && target.type === "user") ctx.addIssue({ code: "custom", path: ["sanction"], message: "use_a_user_template" });
    if (input.sanction?.action === "suspend_account" && !input.sanction.durationDays) ctx.addIssue({ code: "custom", path: ["sanction", "durationDays"], message: "required" });
    if (input.manifestlyUnfounded && template?.outcome !== "unfounded") ctx.addIssue({ code: "custom", path: ["manifestlyUnfounded"], message: "dismissals_only" });
  });
export type DecideRequest = z.infer<typeof decideSchema>;

export interface DecideResponse {
  decisionId: string;
  action: DecisionAction;
  /** Reports closed by the decision. */
  reportIds: string[];
  /** The account sanction decided with it (its own statement of reasons), or null. */
  sanctionDecisionId: string | null;
}

/** POST /api/admin/decisions/bulk: dismiss low-priority reports (P3 spam, duplicates) of up to 20 targets. */
export const bulkDismissSchema = z
  .object({
    targets: z.array(targetKeySchema).min(1).max(20),
    manifestlyUnfounded: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (new Set(input.targets).size !== input.targets.length) ctx.addIssue({ code: "custom", path: ["targets"], message: "duplicate" });
    input.targets.forEach((key, index) => {
      const target = parseTargetKey(key);
      if (!target || target.type === "pro") ctx.addIssue({ code: "custom", path: ["targets", index], message: "invalid" });
    });
  });
export type BulkDismissRequest = z.infer<typeof bulkDismissSchema>;

export interface BulkDismissResponse {
  results: { target: string; status: "dismissed" | "skipped"; decisionId: string | null; reason?: "not_p3" | "no_open_report" | "failed" }[];
}

/** A decision as the back office shows it (dates ISO). */
export interface DecisionView {
  id: string;
  target: { type: string; id: string };
  affectedUid: string;
  action: DecisionAction | "demote";
  durationDays: number | null;
  templateId: string;
  facts: string;
  ground: { type: "illegal" | "terms"; ref: string; explanation: string };
  origin: "notice" | "own_initiative" | "authority_order";
  automated: { detection: boolean; decision: boolean };
  reportIds: string[];
  decidedBy: string;
  createdAt: string;
  notifiedAt: string | null;
  appealDeadline: string;
  appeal: {
    status: "open" | "upheld" | "reversed";
    by: "affected" | "reporter" | null;
    text: string | null;
    openedAt: string;
    slaDueAt: string | null;
    closedAt: string | null;
    reviewer: string | null;
    note: string | null;
    outcomeDecisionId: string | null;
  } | null;
  aiDecisionId: string | null;
  supersedes: string | null;
  supersededBy: string | null;
}

// ---- Appeals (D16) ---------------------------------------------------------------------------

export const APPEAL_NOTE_MIN = 10;
export const APPEAL_NOTE_MAX = 2000;

/**
 * POST /api/admin/appeals/{decisionId}: the review by another moderator. `reversed` undoes a
 * restrictive decision; reversing a dismissal (a reporter's appeal) needs the template of the
 * measure to take now (`templateId`, `details`).
 */
export const reviewAppealSchema = z
  .object({
    outcome: z.enum(["upheld", "reversed"]),
    note: z.string().trim().min(APPEAL_NOTE_MIN).max(APPEAL_NOTE_MAX),
    templateId: z.enum(DECISION_TEMPLATE_IDS).optional(),
    details: z.string().trim().max(DETAILS_MAX).optional(),
    sanction: sanctionSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.outcome === "upheld" && (input.templateId || input.sanction)) ctx.addIssue({ code: "custom", path: ["templateId"], message: "reversal_only" });
    const template = input.templateId ? decisionTemplate(input.templateId) : undefined;
    if (template && (template.internal || template.outcome !== "founded")) ctx.addIssue({ code: "custom", path: ["templateId"], message: "restrictive_template_only" });
    if (template?.detailsRequired && (input.details ?? "").length < DETAILS_MIN) ctx.addIssue({ code: "custom", path: ["details"], message: "required" });
    if (input.sanction?.action === "suspend_account" && !input.sanction.durationDays) ctx.addIssue({ code: "custom", path: ["sanction", "durationDays"], message: "required" });
  });
export type ReviewAppealRequest = z.infer<typeof reviewAppealSchema>;

export interface ReviewAppealResponse {
  decisionId: string;
  outcome: "upheld" | "reversed";
  /** The decision taken on reversal (linked both ways), or null when upheld. */
  outcomeDecisionId: string | null;
}

export interface AppealQueueItem {
  decisionId: string;
  target: { type: string; id: string };
  action: DecisionView["action"];
  templateId: string;
  by: "affected" | "reporter" | null;
  text: string;
  openedAt: string;
  slaDueAt: string | null;
  overdue: boolean;
  decidedBy: string;
  /** False when the reader decided it: another moderator reviews (403 same_reviewer). */
  reviewable: boolean;
  aiDecisionId: string | null;
}

export interface AppealQueueResponse {
  items: AppealQueueItem[];
  next: string | null;
}

// ---- Authority requests (D17, admin only) ---------------------------------------------------

export const AUTHORITY_COUNTRIES = ["FR", "MA", "EU", "other"] as const;
export const AUTHORITY_KINDS = ["removal_order", "data_request", "preservation", "other"] as const;
export const AUTHORITY_STATUSES = ["open", "answered", "closed"] as const;

/** "listing:{id}", "user:{uid}", "conversation:{cid}" (the scope of an authority request). */
export const AUTHORITY_SCOPE_PATTERN = /^(listing:[a-hj-km-np-z2-9]{8}|user:[A-Za-z0-9_-]{1,128}|conversation:[A-Za-z0-9_-]{22})$/;

export const createAuthorityRequestSchema = z
  .object({
    authority: z.string().trim().min(2).max(200),
    country: z.enum(AUTHORITY_COUNTRIES),
    legalBasis: z.string().trim().min(2).max(500),
    kind: z.enum(AUTHORITY_KINDS),
    scope: z.array(z.string().regex(AUTHORITY_SCOPE_PATTERN)).min(1).max(50),
    /** How the requester's identity was checked (call-back number, signed e-mail, official portal...). */
    identityCheck: z.object({ method: z.string().trim().min(2).max(300) }).strict(),
    receivedAt: z.iso.datetime(),
    dueAt: z.iso.datetime().optional(),
    /** Removal orders: the report reason (priority, P0 for a TCO terrorist content order). */
    reasonId: z.enum(REPORT_REASON_IDS).optional(),
    /** false: the order forbids informing the user (non-disclosure): no statement mail. */
    notifyAffected: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (new Set(input.scope).size !== input.scope.length) ctx.addIssue({ code: "custom", path: ["scope"], message: "duplicate" });
    if (input.kind === "removal_order" && !input.reasonId) ctx.addIssue({ code: "custom", path: ["reasonId"], message: "required" });
    if (input.kind !== "removal_order" && input.reasonId) ctx.addIssue({ code: "custom", path: ["reasonId"], message: "removal_order_only" });
  });
export type CreateAuthorityRequest = z.infer<typeof createAuthorityRequestSchema>;

export const updateAuthorityRequestSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("answered"), response: z.string().trim().min(2).max(4000) }).strict(),
  z.object({ status: z.literal("closed"), response: z.string().trim().min(2).max(4000).optional() }).strict(),
]);
export type UpdateAuthorityRequest = z.infer<typeof updateAuthorityRequestSchema>;

export interface AuthorityRequestView {
  id: string;
  authority: string;
  country: (typeof AUTHORITY_COUNTRIES)[number];
  legalBasis: string;
  kind: (typeof AUTHORITY_KINDS)[number];
  scope: string[];
  identityCheck: { method: string; at: string; by: string };
  receivedAt: string;
  dueAt: string | null;
  status: (typeof AUTHORITY_STATUSES)[number];
  response: string | null;
  respondedAt: string | null;
  holds: string[];
  reportIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CreateAuthorityResponse {
  request: AuthorityRequestView;
  /** Removal orders: the decisions executing them (one per removed target). */
  decisionIds: string[];
  /** Scope entries that do not exist (nothing held there). */
  missing: string[];
}

// ---- Staff views ----------------------------------------------------------------------------

/** GET /api/admin/conversations/{cid}?reason=: why the staff member opens it (audited, D18). */
export const staffConversationQuerySchema = z.object({ reason: z.string().trim().min(10).max(300) }).strict();

export interface StaffConversationView {
  cid: string;
  listingId: string;
  listingTitle: string;
  status: "open" | "frozen";
  buyer: { uid: string; name: string; publicId: string };
  seller: { uid: string; name: string; publicId: string };
  /** Newest first, at most 200. */
  messages: { id: string; from: "buyer" | "seller" | "system"; text: string; hidden: boolean; flags: string[]; createdAt: string; reported: boolean }[];
  /** Original texts of masked or hidden messages, by message id (the reported ones when access comes from reports). */
  evidence: Record<string, { text: string; reason: "masked" | "hidden" }>;
  /** Why access is granted. */
  access: { reportIds: string[]; authorityHolds: string[] };
}

export interface LadderStep {
  action: SanctionAction;
  durationDays: 7 | 30 | null;
}

export interface UserModerationView {
  uid: string;
  publicId: string;
  displayName: string;
  status: "active" | "restricted" | "suspended" | "banned" | "closed";
  createdAt: string;
  strikes: { level: number; lastAt: string | null; suspendedUntil: string | null };
  /** What the back office proposes next (D14); the moderator may choose another step. */
  nextStep: LadderStep;
  suspension: { until: string; decisionId: string } | null;
  reporter: { total: number; recent: boolean[]; foundedShare: number | null; manifestRecent: number; warnedAt: string | null; abusiveUntil: string | null };
  decisions: { id: string; action: string; templateId: string; target: { type: string; id: string }; createdAt: string; appeal: string | null }[];
}

// ---- Stats (D24) ----------------------------------------------------------------------------

export interface ModerationStats {
  generatedAt: string;
  /** Open (open + in_review) reports per priority, and how many are past their due date. */
  open: Record<"P0" | "P1" | "P2" | "P3", { count: number; overdue: number }>;
  /** Reports closed in the last 30 days: count and median hours to decision per priority (null: none). */
  decided30d: Record<"P0" | "P1" | "P2" | "P3", { count: number; medianHours: number | null }>;
  /** True when more closed reports exist than were read for the medians. */
  sampled: boolean;
  appeals: { open: number; overdue: number; decided90d: number; reversed90d: number; reversalRate: number | null };
  authorities: { open: number };
}

export type { DecisionTargetType };
