import "server-only";
import type { AiConfig } from "@/config/ai";
import { listingLifetime } from "@/config/pricing";
import { cityBySlug, cityName } from "@/config/regions";
import { reportReason, type ReportReasonId } from "@/config/report-reasons";
import { audit } from "@/lib/audit";
import { ListingVersionError, applyPatch, getListing, getListingTx, updateListingTx, type ListingRecord } from "@/lib/db/repositories/listings";
import { recordModerationDecisionTx, type ModerationDecisionInput } from "@/lib/db/repositories/moderation-decisions";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { getLegalConfig } from "@/lib/legal/config";
import { buildSlugId } from "@/lib/listings/ids";
import { IllegalTransitionError, approveHold, transition, type TransitionResult } from "@/lib/listings/lifecycle";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { listingRecipient, siteUrl } from "@/lib/mail/recipients";
import { APPROVAL_GROUND, REJECT_REASONS, rejectStatementFacts } from "@/lib/moderation/decisions";
import { HUMAN_REVIEW_FLAGS } from "@/lib/moderation/risk";
import { consume } from "@/lib/quota";
import { notifySearchIndex } from "@/lib/search/queue";
import { markAutoAppliedTx } from "./repository";
import type { AiOutput, AiProviderId, AiTask, TaskFacts } from "./types";

// What the agent may do alone (design D20). Everything else is a proposal shown to a moderator.
// - A held listing (pending_review) is approved when Claude (never a fallback) proposes "approve"
//   with confidence >= agent.autoApproveAt (0.9), no moderation flag outside
//   agent.autoApproveSoftFlags (default none; never a HUMAN_REVIEW_FLAGS one), no open report, nothing prohibited, not hidden, and
//   no removal decision in its history: a listing a moderator rejected before is held so that a
//   person reviews it again, whatever the agent thinks of the edited text (audit D1b-02).
// - A held listing is rejected when Claude proposes "reject" with policy "spam" and confidence >=
//   agent.autoRejectSpamAt (0.97): automated decision (detection and decision automated, said in
//   the statement mailed to the seller; the appeal goes to a human).
// - A published listing (screened after publication) is never touched: a hold, a rejection or a
//   rated escalation becomes a system report for the moderators (priority from the reason; never a
//   strong signal, so nothing is hidden). An approval is recorded only.
// Report triage and appeal review are always proposals.

export type Application = { kind: "auto_approve" } | { kind: "auto_reject_spam" } | { kind: "system_report"; reasonId: ReportReasonId } | { kind: "record" };

const SPAM_DETAILS = "contenu indésirable (spam) détecté automatiquement";

/** Report reason of a system report raised on a listing: the proposal's policy when it applies to a listing. */
function listingReason(output: AiOutput): ReportReasonId {
  const reason = output.policy === "none" ? undefined : reportReason(output.policy);
  return reason && (reason.targets as readonly string[]).includes("listing") ? (reason.id as ReportReasonId) : "other";
}

/** Pure: what the agent does with a proposal (D20). */
export function planApplication(task: AiTask, provider: AiProviderId, output: AiOutput, facts: TaskFacts, config: Pick<AiConfig, "agent">): Application {
  if (task !== "listing_screen" || facts.kind !== "listing" || facts.hidden) return { kind: "record" };
  const claude = provider === "anthropic";
  if (facts.status === "pending_review") {
    const softFlags = new Set(config.agent.autoApproveSoftFlags);
    const clean = facts.flags.every((flag) => softFlags.has(flag) && !HUMAN_REVIEW_FLAGS.has(flag)) && facts.openReports === 0 && facts.prohibitedHard.length === 0 && !facts.previouslyRejected;
    if (claude && output.action === "approve" && output.confidence >= config.agent.autoApproveAt && clean) return { kind: "auto_approve" };
    if (claude && output.action === "reject" && output.policy === "spam" && output.confidence >= config.agent.autoRejectSpamAt) return { kind: "auto_reject_spam" };
    return { kind: "record" };
  }
  if (facts.status === "published" && config.agent.screenPublished) {
    const rated = output.action === "escalate" && (claude || output.severity !== "none");
    if (output.action === "hold" || output.action === "reject" || rated) return { kind: "system_report", reasonId: listingReason(output) };
  }
  return { kind: "record" };
}

export interface AutoDecisionInput {
  listingId: string;
  /** The version the agent screened: a later edit or decision cancels the auto-application. */
  version: number;
  aiDecisionId: string;
  confidence: number;
  now?: Date;
}

export type AutoDecisionOutcome = { applied: true; decisionId: string; status: string } | { applied: false; reason: "stale" | "illegal" };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function decisionRecord(listing: ListingRecord, kind: "approve" | "reject", input: AutoDecisionInput, approvedAs: string, now: Date): ModerationDecisionInput {
  const common = {
    target: { type: "listing", id: listing.id },
    affectedUid: listing.ownerUid,
    origin: "own_initiative" as const,
    automation: { detection: true, decision: true },
    reportIds: [],
    decidedBy: "system",
    aiDecisionId: input.aiDecisionId,
    notified: true,
    now,
  };
  if (kind === "approve") {
    return {
      ...common,
      action: "restore",
      facts: clip(`Automated review: listing compliant (agent confidence ${input.confidence.toFixed(2)}, no moderation flag)`, 2000),
      ground: { ...APPROVAL_GROUND, explanation: approvedAs === "published" ? "The moderation agent lifted the automated hold." : `The moderation agent approved the held edit; the listing is ${approvedAs} again.` },
      templateId: approvedAs === "published" ? "listingApproved" : "listingChangesApproved",
    };
  }
  // The spam reason of the catalogue (audit D1b-09): the statement and the ground name spam, not "other".
  const reason = REJECT_REASONS.spam;
  return {
    ...common,
    action: "remove",
    facts: clip(`${reason.facts.fr}. ${SPAM_DETAILS} (agent confidence ${input.confidence.toFixed(2)})`, 2000),
    ground: { type: reason.ground.type, ref: reason.ground.ref, explanation: "Rejected by the moderation agent: obvious spam." },
    templateId: "listingRejected",
  };
}

/**
 * Applies an automated approval or spam rejection to a held listing (D20) in one transaction that
 * re-checks status and version: listing patch, searchOutbox entry, moderationDecisions statement
 * (automation detection + decision, decidedBy "system"), aiDecision marked "auto". Then the index,
 * the audit entry, the ISR revalidation and the seller's mail. A moved listing: not applied.
 */
export async function applyAutoDecision(kind: "approve" | "reject", input: AutoDecisionInput): Promise<AutoDecisionOutcome> {
  const now = input.now ?? new Date();
  const listing = await getListing(input.listingId);
  if (!listing || listing.status !== "pending_review" || listing.version !== input.version) return { applied: false, reason: "stale" };
  const legal = await getLegalConfig();
  const ctx = { now, lifetime: listingLifetime(legal) };
  let result: TransitionResult;
  try {
    result = kind === "approve" ? approveHold(listing, ctx) : transition(listing, "rejected", ctx);
  } catch (error) {
    if (error instanceof IllegalTransitionError) return { applied: false, reason: "illegal" };
    throw error;
  }
  const { patch, effects } = result;
  if (kind === "approve" && !listing.slugId) {
    const city = listing.location ? cityBySlug(listing.location.citySlug) : undefined;
    patch.slugId = buildSlugId({ id: listing.id, title: listing.title, city: city ? cityName(city, "fr") : undefined, categoryId: listing.categoryId });
  }
  const record = decisionRecord(listing, kind, input, patch.status ?? listing.status, now);

  let decisionId = "";
  try {
    await db().runTransaction(async (tx) => {
      const current = await getListingTx(tx, listing.id);
      if (!current || current.status !== "pending_review" || current.version !== input.version) throw new ListingVersionError();
      decisionId = recordModerationDecisionTx(tx, record);
      patch.moderation = {
        ...current.moderation,
        state: kind === "approve" ? "auto_ok" : "auto_rejected",
        reviewedBy: "system",
        reviewedAt: now,
        lastDecisionId: decisionId,
        ai: { decisionId: input.aiDecisionId, action: kind, confidence: input.confidence, applied: true },
      };
      patch.adsEligible = kind === "approve" && current.moderation.openReports === 0 && !current.moderation.hiddenBy;
      updateListingTx(tx, listing.id, patch);
      if (effects.search) enqueueSearchOutboxTx(tx, listing.id, effects.search, patch.version ?? current.version, now);
      markAutoAppliedTx(tx, input.aiDecisionId, decisionId, now);
    });
  } catch (error) {
    if (error instanceof ListingVersionError) return { applied: false, reason: "stale" };
    throw error;
  }
  if (effects.search) await notifySearchIndex([listing.id]);
  const updated = applyPatch(listing, patch);
  await audit({
    actorUid: "system",
    actorRole: "system",
    action: effects.audit ?? (kind === "approve" ? "listing.approve" : "listing.reject"),
    target: { type: "listing", id: listing.id },
    automated: true,
    reason: `agent ${input.aiDecisionId}; decision ${decisionId}`,
    at: now,
  });
  if (effects.revalidate) revalidateListingPaths({ slugId: updated.slugId, publicId: listing.sellerPublicId });
  await notifySeller(updated, kind, legal.dsaContactEmail);
  return { applied: true, decisionId, status: updated.status };
}

/** listingApproved / listingChangesApproved / listingRejected (automated statement); never throws. */
async function notifySeller(listing: ListingRecord, kind: "approve" | "reject", redress: string): Promise<void> {
  try {
    const to = await listingRecipient(listing.ownerUid);
    if (!to) return;
    const restored = listing.status === "paused" || listing.status === "expired" ? listing.status : null;
    const template = kind === "reject" ? "listingRejected" : restored ? "listingChangesApproved" : "listingApproved";
    const base = { locale: to.locale, to: to.email, priority: template === "listingRejected" ? ("security" as const) : ("transactional" as const), idempotencyKey: `${template}-${listing.id}-${listing.version}` };
    if (kind === "approve" && restored) {
      const until = (restored === "paused" ? listing.expiresAt : listing.purgeAt) ?? listing.updatedAt;
      const url = siteUrl(to.locale, `mes-annonces?onglet=${restored === "paused" ? "active" : "ended"}`);
      await sendMail({ ...base, template: "listingChangesApproved", data: { displayName: to.displayName, title: listing.title, status: restored, url, until: until.toISOString() } });
    } else if (kind === "approve") {
      const url = siteUrl(to.locale, listing.slugId ? `annonce/${listing.slugId}` : "mes-annonces");
      await sendMail({ ...base, template: "listingApproved", data: { displayName: to.displayName, title: listing.title, url, expiresAt: (listing.expiresAt ?? listing.updatedAt).toISOString() } });
    } else {
      const statement = { measure: "reject" as const, facts: rejectStatementFacts("spam", SPAM_DETAILS), ground: REJECT_REASONS.spam.ground.ref, automated: true, redress };
      await sendMail({ ...base, template: "listingRejected", data: { displayName: to.displayName, title: listing.title, listingId: listing.id, statement } });
    }
  } catch (error) {
    logger.error({ listingId: listing.id, err: (error as Error).message }, "ai: seller mail failed");
  }
}

/** Records the proposal on the listing (`moderation.ai`), without touching its version. Never throws. */
export async function noteOnListing(listingId: string, ai: { decisionId: string; action: AiOutput["action"]; confidence: number; applied: boolean }): Promise<void> {
  try {
    await db().collection(COLLECTIONS.listings).doc(listingId).update({ "moderation.ai": ai });
    void consume("firestore.writes", 1);
  } catch (error) {
    logger.warn({ listingId, err: (error as Error).message }, "ai: proposal not noted on the listing");
  }
}

/** Links the triage proposal from its report (`reports.aiDecisionId`). Never throws. */
export async function noteOnReport(reportId: string, aiDecisionId: string): Promise<void> {
  try {
    await db().collection(COLLECTIONS.reports).doc(reportId).update({ aiDecisionId, updatedAt: new Date() });
    void consume("firestore.writes", 1);
  } catch (error) {
    logger.warn({ reportId, err: (error as Error).message }, "ai: proposal not linked from the report");
  }
}

/** A published listing the agent flags: a system report for the moderators (L2), never a hide. */
export async function raiseSystemReport(listingId: string, reasonId: ReportReasonId, output: AiOutput, aiDecisionId: string): Promise<{ reportId: string; duplicate: boolean } | null> {
  try {
    // Lazy: the reports module reaches back to this one for the triage queue.
    const { createSystemReport } = await import("@/lib/reports");
    const explanation = `Agent de modération (proposition ${aiDecisionId}) : ${output.action}, confiance ${output.confidence.toFixed(2)}. ${output.rationale}`;
    // triage: false: the report carries this proposal already; a second Claude call would only repeat it (audit D1b-07).
    const result = await createSystemReport({ target: { type: "listing", id: listingId }, reasonId, explanation, source: "system", triage: false });
    return { reportId: result.reportId, duplicate: result.duplicate };
  } catch (error) {
    logger.error({ listingId, err: (error as Error).message }, "ai: system report failed");
    return null;
  }
}
