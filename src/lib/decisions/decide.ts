import "server-only";
import { FieldValue, Timestamp, type DocumentReference, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import {
  RESTRICTIVE_ACTIONS,
  SANCTION_ACTIONS,
  decisionTemplate,
  fillTemplateText,
  sanctionTemplateId,
  type DecisionAction,
  type DecisionTargetType,
  type DecisionTemplate,
  type SanctionAction,
} from "@/config/decision-templates";
import type { ReportPriority } from "@/config/report-reasons";
import { audit } from "@/lib/audit";
import { getListing, getListingTx, updateListingTx, type ListingFieldPatch, type ListingRecord } from "@/lib/db/repositories/listings";
import type { ModerationDecisionInput } from "@/lib/db/repositories/moderation-decisions";
import { getUserRecord, type UserRecord } from "@/lib/db/repositories/profiles";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { datesToTimestamps } from "@/lib/db/repositories/timestamps";
import { userStatusSchema, type ModerationDecisionDoc, type SuspensionDoc, type UserPrivateDoc } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound } from "@/lib/http/errors";
import { IllegalTransitionError, transition, type Lifetime } from "@/lib/listings/lifecycle";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { logger } from "@/lib/logging/logger";
import { hideMessage, publishRevoked, unhideMessage } from "@/lib/messaging";
import { consume } from "@/lib/quota";
import { adsEligibleOf, closeReportsTx, openReportsForTarget, recordReporterOutcomes, targetKey, unhideTarget, type TargetRef } from "@/lib/reports";
import { splitMessageId } from "@/lib/reports/target-key";
import { reviewDocRef } from "@/lib/reports/targets";
import { getReview } from "@/lib/reviews/repository";
import { setReviewVisibility } from "@/lib/reviews/moderation";
import { notifySearchIndex } from "@/lib/search/queue";
import type { DecideResponse } from "./contracts";
import { markAiDecision, type AiReviewOutcome } from "./hooks";
import { canBan, levelAfter, levelAfterReversal, sanctionOf, suspensionUntil, type Sanction } from "./ladder";
import { sendContentRestored, sendDecisionNotice, sendReportOutcomes, sendReporterWarnings, type NoticeInput } from "./notify";
import {
  conversationRef,
  createDecisionTx,
  decisionRef,
  decisionsCol,
  getDecision,
  getDecisionTx,
  getSuspension,
  messageRef,
  openReportsTx,
  privateFromSnapshot,
  privateRef,
  reportFromSnapshot,
  reportsCol,
  suspensionFromSnapshot,
  suspensionRef,
  userRef,
  withoutReportHolds,
  type DecisionRecord,
  type OpenReport,
} from "./repository";
import {
  applyAuthSanction,
  lifetime,
  pauseListingsForSuspension,
  removeListingsForBan,
  restoreBannedListings,
  resumeModerationPaused,
  reverseAuthSanction,
  undoQuietly,
  unremovePatch,
  type Undo,
} from "./sanctions";

// One decision on one target (design D13): it closes every open report of that target (read in
// the transaction: a report that lands meanwhile retries it), applies the measure (listing removed
// or hidden or shown again, message or review hidden or restored, account sanction of the ladder D14) and
// writes the statement of reasons (moderationDecisions, art. 17), in one transaction. An account
// sanction decided with a content decision is a decision of its own (its own statement and appeal).
// The Auth side of a sanction runs before the transaction and is undone if it fails; listings of a
// sanctioned account, hidden messages, mails, reporter accuracy (D15), audit and the AI proposal
// mark follow the commit and never undo it. An appeal reversal (D16) is a decision of the same
// kind that supersedes the appealed one in the same transaction.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Art. 23(2): how long a reporter's notices are refused (recordReporterOutcomes sets it). */
const REPORTER_SUSPENSION_DAYS = 30;
const OPEN_STATUSES: readonly string[] = ["open", "in_review"];
const RESTRICTABLE: readonly ListingRecord["status"][] = ["published", "paused", "pending_review", "sold", "expired"];

export type DecisionActorRole = "moderator" | "admin" | "system";

export interface DecisionActor {
  /** Staff uid, or "system". */
  uid: string;
  role: DecisionActorRole;
}

export type DecisionTarget = TargetRef & { type: DecisionTargetType };
export type DecisionOrigin = ModerationDecisionDoc["origin"];

export interface DecisionInput {
  target: DecisionTarget;
  templateId: string;
  details?: string | undefined;
  /** Account measure with a content decision (a P0 template bans anyway). */
  sanction?: Sanction | undefined;
  /** Dismissals: every report (true) or these ids flagged manifestly unfounded (art. 23). */
  manifestlyUnfounded?: true | readonly string[] | undefined;
  /** The agent's proposal the moderator followed, edited or refused. */
  ai?: { decisionId: string; outcome: AiReviewOutcome } | undefined;
}

export interface ReversalInput {
  /** The appealed decision (appeal open), superseded by this one. */
  decisionId: string;
  /** The reviewer's reasons (appeal.note). */
  note: string;
  /** The admin who decided reviews his own decision (D16, audit D1a-05): recorded on the appeal. */
  selfReview?: boolean;
}

export interface DecideOptions {
  now?: Date;
  /** Clear IP of the staff member (audit). */
  ip?: string;
  /** Default: "notice" when a user's report is closed, "authority_order" for an authority's, else "own_initiative". */
  origin?: DecisionOrigin;
  automation?: { detection: boolean; decision: boolean };
  /** false: the order forbids informing the user (no statement mail). */
  notifyAffected?: boolean;
  reversal?: ReversalInput;
  /** Reports to close besides the open ones (a reversed dismissal's own, closed already). */
  referenceReportIds?: readonly string[];
}

export interface DecideResult extends DecideResponse {
  affectedUid: string;
  appealDeadline: Date;
}

type AccountPlan =
  | { kind: "sanction"; sanction: Sanction; separate: boolean; templateId: string; p0: boolean }
  | { kind: "reverse"; action: SanctionAction; decisionId: string; suspensionLifted: boolean };

interface Subject {
  ownerUid: string;
  /** Listing title (listing), the reviewed seller's name (review), else null. */
  title: string | null;
  message: { cid: string; mid: string } | null;
  /** Review id of a review target. */
  review: string | null;
}

type ListingEffect = "removed" | "restricted" | "shown" | "unremoved" | null;

interface Committed {
  /** Open reports closed by the decision (outcomes, mails, accuracy). */
  open: OpenReport[];
  closedIds: string[];
  main: ModerationDecisionDoc;
  sanction: { id: string; doc: ModerationDecisionDoc } | null;
  listing: { record: ListingRecord; search: boolean; effect: ListingEffect } | null;
  /** The message's `hidden` flag when decided. */
  messageHidden: boolean | null;
  /** The review's status when decided. */
  reviewStatus: string | null;
  until: Date | null;
}

const conflict = (message: string) => new HttpError(409, "conflict", message);
const notAllowed = (message: string) => new HttpError(403, "sanction_not_allowed", message);
const noop: Undo = async () => undefined;
const isSanctionAction = (action: string): action is SanctionAction => (SANCTION_ACTIONS as readonly string[]).includes(action);
const isRestrictive = (action: string) => (RESTRICTIVE_ACTIONS as readonly string[]).includes(action);
const isRestoring = (action: DecisionAction) => action === "restore" || action === "no_action";

/** French statement stored on the decision (facts + the moderator's own words); mails render the template in the recipient's language. */
function statementFacts(template: DecisionTemplate, details: string | undefined, days: number | undefined): string {
  const facts = fillTemplateText(template.facts.fr, { days });
  return (details ? `${facts}\n\n${details}` : facts).slice(0, 2000);
}

async function readSubject(target: DecisionTarget): Promise<Subject> {
  switch (target.type) {
    case "listing": {
      const listing = await getListing(target.id);
      if (!listing || listing.status === "draft" || listing.status === "purged") throw notFound();
      return { ownerUid: listing.ownerUid, title: listing.title, message: null, review: null };
    }
    case "message": {
      const ids = splitMessageId(target.id);
      if (!ids) throw notFound();
      const snapshot = await messageRef(ids.cid, ids.mid).get();
      void consume("firestore.reads", 1);
      const sender: unknown = snapshot.get("senderUid");
      if (!snapshot.exists || typeof sender !== "string" || snapshot.get("type") === "system") throw notFound();
      return { ownerUid: sender, title: null, message: ids, review: null };
    }
    case "user":
      return { ownerUid: target.id, title: null, message: null, review: null };
    case "review": {
      // A review its author deleted meanwhile stays decidable: its open reports are closed.
      const review = await getReview(target.id);
      if (!review) throw notFound();
      return { ownerUid: review.authorUid, title: review.targetName, message: null, review: review.id };
    }
  }
}

interface PlanInput {
  actor: DecisionActor;
  template: DecisionTemplate;
  target: DecisionTarget;
  chosen: Sanction | undefined;
  owner: UserRecord | null;
  superseded: DecisionRecord | null;
  suspension: SuspensionDoc | null;
  priorities: readonly ReportPriority[];
}

/** The account side of a decision: a sanction (D14), the reversal of one (D16), or nothing. */
export function planAccount({ actor, template, target, chosen, owner, superseded, suspension, priorities }: PlanInput): AccountPlan | null {
  if (superseded && template.id === "appeal.reversed") {
    if (!isSanctionAction(superseded.action)) return null;
    return { kind: "reverse", action: superseded.action, decisionId: superseded.id, suspensionLifted: superseded.action === "suspend_account" && suspension?.decisionId === superseded.id };
  }
  if (template.outcome !== "founded") return null;
  const sanction = sanctionOf(template, target.type === "user" ? undefined : chosen);
  if (!sanction) return null;
  const separate = target.type !== "user";
  if (actor.role === "system") throw notAllowed("automated decisions carry no account sanction");
  if (sanction.action === "ban" && !canBan({ role: actor.role, template, priorities })) throw notAllowed("a moderator bans only to confirm a P0 report");
  if (!owner || owner.status === "closed") {
    if (separate) return null;
    throw notFound();
  }
  if (owner.status === "banned") {
    if (separate) return null;
    throw conflict("account already banned");
  }
  const templateId = separate ? sanctionTemplateId(sanction.action, { ...(sanction.durationDays ? { durationDays: sanction.durationDays } : {}), ...(template.p0 ? { p0: true } : {}) }) : template.id;
  return { kind: "sanction", sanction, separate, templateId, p0: template.p0 === true };
}

/** Auth side before the transaction (suspension claim, disabled account, or their reversal). */
async function prepareAuth(uid: string, plan: AccountPlan | null): Promise<Undo> {
  if (!plan) return noop;
  if (plan.kind === "sanction") return plan.sanction.action === "warn" ? noop : applyAuthSanction(uid, plan.sanction);
  if (plan.action === "ban") return reverseAuthSanction(uid, "ban");
  if (plan.action === "suspend_account" && plan.suspensionLifted) return reverseAuthSanction(uid, "suspend_account");
  return noop;
}

/** Restoring may clear `hiddenBy` unless an open report on another target (the owner's account) hid the listing. */
function hiddenByOtherOpenReport(listing: ListingRecord, hider: OpenReport | null): boolean {
  return hider !== null && OPEN_STATUSES.includes(hider.status) && !(hider.target.type === "listing" && hider.target.id === listing.id);
}

interface ListingDecision {
  patch: ListingFieldPatch & { version: number };
  search: "upsert" | "delete" | null;
  effect: ListingEffect;
}

/** The listing patch of a decision (computed from the record read in the transaction). */
function listingDecision(
  listing: ListingRecord,
  input: { template: DecisionTemplate; decisionId: string; actorUid: string; closedIds: readonly string[]; hider: OpenReport | null; superseded: DecisionRecord | null; now: Date; life: Lifetime },
): ListingDecision {
  const { template, now } = input;
  let status = listing.status;
  let moderation: ListingRecord["moderation"] = { ...listing.moderation };
  let statusPatch: ListingFieldPatch = {};
  let search: ListingDecision["search"] = null;
  let effect: ListingEffect = null;

  if (template.action === "remove") {
    if (listing.status !== "removed") {
      try {
        const { patch, effects } = transition(listing, "removed", { now, lifetime: input.life });
        statusPatch = patch;
        search = effects.search;
      } catch (error) {
        if (error instanceof IllegalTransitionError) throw conflict(`listing cannot be removed from ${listing.status}`);
        throw error;
      }
      status = "removed";
      effect = "removed";
    }
  } else if (template.action === "restrict_visibility") {
    if (!RESTRICTABLE.includes(listing.status)) throw conflict(`listing cannot be restricted in ${listing.status}`);
    if (!moderation.hiddenBy) {
      // A staff restriction, not a reporter's strong signal (audit D1a-09): the restore logic clears it like any other.
      moderation = { ...moderation, hiddenBy: { reportId: input.closedIds[0] ?? input.decisionId, signal: "decision", at: now } };
      if (listing.status === "published") search = "delete";
      effect = "restricted";
    }
  } else if (isRestoring(template.action)) {
    const reversed = input.superseded;
    if (reversed && (listing.status === "removed" || listing.status === "rejected") && listing.moderation.lastDecisionId === reversed.id) {
      const change = unremovePatch(listing, now, input.life);
      statusPatch = change.patch;
      status = change.patch.status ?? listing.status;
      search = change.search;
      effect = "unremoved";
    }
    if (moderation.hiddenBy && !hiddenByOtherOpenReport(listing, input.hider)) {
      const { hiddenBy: _hidden, ...shown } = moderation;
      moderation = shown;
      if (status === "published") search = "upsert";
      effect ??= "shown";
    }
  }

  moderation = { ...moderation, openReports: 0, lastDecisionId: input.decisionId, reviewedBy: input.actorUid, reviewedAt: now };
  const legalHold = withoutReportHolds(listing.legalHold, input.closedIds);
  const version = listing.version + 1;
  return {
    patch: { ...statusPatch, moderation, adsEligible: adsEligibleOf({ status, moderation, subcategoryId: listing.subcategoryId }), ...(legalHold ? { legalHold } : {}), version, updatedAt: now },
    search,
    effect,
  };
}

interface AccountDocs {
  user: { status: UserRecord["status"] | null; exists: boolean };
  account: UserPrivateDoc | null;
  suspension: SuspensionDoc | null;
}

/** Account writes of the transaction: status, suspension document, strikes, report holds. Returns the end of a new suspension. */
function writeAccountTx(
  tx: Transaction,
  uid: string,
  docs: AccountDocs,
  input: { plan: AccountPlan | null; accountDecisionId: string; closedIds: readonly string[]; holdsOnAccount: boolean; now: Date },
): Date | null {
  const { plan, now } = input;
  const at = Timestamp.fromDate(now);
  let writes = 0;
  let until: Date | null = null;
  let status: UserRecord["status"] | null = null;
  const privateUpdate: Record<string, unknown> = {};

  if (plan?.kind === "sanction") {
    const { sanction } = plan;
    if (sanction.action === "suspend_account") {
      until = suspensionUntil(now, sanction.durationDays ?? 7, docs.suspension?.until ?? null);
      tx.set(suspensionRef(uid), datesToTimestamps({ until, decisionId: input.accountDecisionId, createdAt: now }));
      writes += 1;
      if (docs.user.status !== "suspended" && docs.user.status !== "banned") status = "suspended";
      privateUpdate["strikes.suspendedUntil"] = Timestamp.fromDate(until);
    } else if (sanction.action === "ban") {
      if (docs.suspension) {
        tx.delete(suspensionRef(uid));
        writes += 1;
      }
      status = "banned";
      privateUpdate["strikes.suspendedUntil"] = FieldValue.delete();
    }
    if (docs.account) {
      privateUpdate["strikes.level"] = levelAfter(docs.account.strikes.level, sanction);
      privateUpdate["strikes.lastAt"] = at;
    }
  } else if (plan?.kind === "reverse") {
    if (plan.action === "suspend_account" && plan.suspensionLifted && docs.suspension?.decisionId === plan.decisionId) {
      tx.delete(suspensionRef(uid));
      writes += 1;
      if (docs.user.status === "suspended") status = "active";
      privateUpdate["strikes.suspendedUntil"] = FieldValue.delete();
    }
    if (plan.action === "ban" && docs.user.status === "banned") status = docs.suspension && docs.suspension.until.getTime() > now.getTime() ? "suspended" : "active";
    if (docs.account) privateUpdate["strikes.level"] = levelAfterReversal(docs.account.strikes.level);
  }

  if (docs.account && input.holdsOnAccount) {
    const legalHold = withoutReportHolds(docs.account.legalHold, input.closedIds);
    if (legalHold) privateUpdate["legalHold"] = legalHold;
  }
  if (docs.account && Object.keys(privateUpdate).length > 0) {
    tx.update(privateRef(uid), privateUpdate);
    writes += 1;
  }
  if (status && docs.user.exists && status !== docs.user.status) {
    tx.update(userRef(uid), { status, updatedAt: at });
    writes += 1;
  }
  if (writes > 0) void consume("firestore.writes", writes);
  return until;
}

function accountDocsFrom(userSnap: DocumentSnapshot, privateSnap: DocumentSnapshot, suspensionSnap: DocumentSnapshot): AccountDocs {
  const status = userStatusSchema.safeParse(userSnap.get("status"));
  return {
    user: { status: status.success ? status.data : null, exists: userSnap.exists },
    account: privateFromSnapshot(privateSnap),
    suspension: suspensionFromSnapshot(suspensionSnap),
  };
}

function originOf(reports: readonly OpenReport[], override: DecisionOrigin | undefined): DecisionOrigin {
  if (override) return override;
  if (reports.some((report) => report.source === "authority")) return "authority_order";
  if (reports.some((report) => report.source === "user")) return "notice";
  return "own_initiative";
}

interface TxInput {
  actor: DecisionActor;
  template: DecisionTemplate;
  input: DecisionInput;
  target: DecisionTarget;
  subject: Subject;
  owner: UserRecord | null;
  plan: AccountPlan | null;
  superseded: DecisionRecord | null;
  options: DecideOptions;
  now: Date;
  mainRef: DocumentReference;
  sanctionRef: DocumentReference | null;
  /** Listing lifetime (legal config), read before the transaction. */
  life: Lifetime | null;
}

async function readReportsTx(tx: Transaction, ids: readonly string[]): Promise<OpenReport[]> {
  if (ids.length === 0) return [];
  const snapshots = await tx.getAll(...ids.map((id) => reportsCol().doc(id)));
  void consume("firestore.reads", snapshots.length);
  return snapshots.map(reportFromSnapshot).filter((report): report is OpenReport => report !== null);
}

async function applyTx(tx: Transaction, run: TxInput): Promise<Committed> {
  const { actor, template, target, subject, plan, now, input, life } = run;
  const ownerUid = subject.ownerUid;

  // ---- Reads (all of them before any write).
  const open = await openReportsTx(tx, target);
  const openIds = new Set(open.map((report) => report.id));
  const referenced = await readReportsTx(tx, [...new Set(run.options.referenceReportIds ?? [])].filter((id) => !openIds.has(id)));
  const superseded = run.superseded ? await getDecisionTx(tx, run.superseded.id) : null;
  const listing = target.type === "listing" ? await getListingTx(tx, target.id) : null;
  const hiderId = listing?.moderation.hiddenBy?.reportId;
  const hider = hiderId && isRestoring(template.action) ? ((await readReportsTx(tx, [hiderId]))[0] ?? null) : null;
  const messageSnap = subject.message ? await tx.get(messageRef(subject.message.cid, subject.message.mid)) : null;
  const conversationSnap = subject.message ? await tx.get(conversationRef(subject.message.cid)) : null;
  const reviewSnap = subject.review ? await tx.get(reviewDocRef(subject.review)) : null;
  const needsAccount = target.type === "user" || plan !== null;
  const accountDocs = needsAccount ? accountDocsFrom(...(await Promise.all([tx.get(userRef(ownerUid)), tx.get(privateRef(ownerUid)), tx.get(suspensionRef(ownerUid))]))) : null;
  void consume("firestore.reads", (subject.message ? 2 : 0) + (subject.review ? 1 : 0) + (needsAccount ? 3 : 0));

  // ---- Checks.
  if (run.superseded && (!superseded || superseded.appeal?.status !== "open" || superseded.supersededBy)) throw conflict("the appeal is not open any more");
  if (plan?.kind === "sanction" && plan.sanction.action === "ban" && actor.role !== "admin" && !open.some((report) => report.priority === "P0")) {
    throw notAllowed("the P0 report was closed meanwhile");
  }
  if (target.type === "listing" && !listing) throw notFound();
  if (subject.message && !messageSnap?.exists) throw notFound();
  if (subject.review && !reviewSnap?.exists) throw notFound();

  const closedIds = [...open.map((report) => report.id), ...referenced.map((report) => report.id)];
  const mainId = run.mainRef.id;
  const accountDecisionId = plan?.kind === "sanction" && plan.separate && run.sanctionRef ? run.sanctionRef.id : mainId;

  // ---- Listing.
  let listingResult: Committed["listing"] = null;
  if (listing && life) {
    const change = listingDecision(listing, { template, decisionId: mainId, actorUid: actor.uid, closedIds, hider, superseded, now, life });
    if (closedIds.length === 0 && change.effect === null && !superseded) throw conflict("nothing to decide on this listing");
    updateListingTx(tx, listing.id, change.patch);
    if (change.search) enqueueSearchOutboxTx(tx, listing.id, change.search, change.patch.version, now);
    listingResult = { record: listing, search: change.search !== null, effect: change.effect };
  }

  // ---- Message: the conversation's report holds (the hide itself follows the commit, messaging lot).
  const messageHidden = messageSnap ? messageSnap.get("hidden") === true : null;
  if (subject.message && conversationSnap?.exists) {
    if (closedIds.length === 0 && !superseded && (template.action === "remove" ? messageHidden : !messageHidden)) throw conflict("nothing to decide on this message");
    const current: unknown = conversationSnap.get("legalHold");
    const legalHold = withoutReportHolds(Array.isArray(current) ? (current as string[]) : [], closedIds);
    if (legalHold) {
      tx.update(conversationRef(subject.message.cid), { legalHold });
      void consume("firestore.writes", 1);
    }
  }

  // ---- Review: its report holds (the status change follows the commit, with the seller's aggregates).
  const reviewStatus = reviewSnap ? String(reviewSnap.get("status")) : null;
  if (subject.review && reviewSnap) {
    const unchanged = template.action === "remove" ? reviewStatus === "hidden" || reviewStatus === "deleted" : reviewStatus === "published" || reviewStatus === "deleted";
    if (closedIds.length === 0 && !superseded && unchanged) throw conflict("nothing to decide on this review");
    const current: unknown = reviewSnap.get("legalHold");
    const legalHold = withoutReportHolds(Array.isArray(current) ? (current as string[]) : [], closedIds);
    if (legalHold) {
      tx.update(reviewDocRef(subject.review), { legalHold });
      void consume("firestore.writes", 1);
    }
  }

  // ---- Account.
  let until: Date | null = null;
  if (accountDocs) {
    if (target.type === "user" && closedIds.length === 0 && !superseded && !plan && accountDocs.user.status !== "restricted") throw conflict("nothing to decide on this account");
    until = writeAccountTx(tx, ownerUid, accountDocs, { plan, accountDecisionId, closedIds, holdsOnAccount: target.type === "user", now });
  }

  // ---- Statements.
  const reports = [...open, ...referenced];
  const origin = originOf(reports, run.options.origin);
  const automation = run.options.automation ?? { detection: reports.some((report) => report.source === "system"), decision: actor.role === "system" };
  const notify = run.options.notifyAffected !== false && run.owner !== null && run.owner.status !== "closed";
  const mainDays = target.type === "user" && plan?.kind === "sanction" ? plan.sanction.durationDays : undefined;
  const mainInput: ModerationDecisionInput = {
    target: { type: target.type, id: target.id },
    affectedUid: ownerUid,
    action: template.action,
    ...(mainDays ? { durationDays: mainDays } : {}),
    facts: statementFacts(template, input.details, mainDays),
    origin,
    automation,
    ground: { type: template.ground.type, ref: template.ground.ref, explanation: fillTemplateText(template.explanation.fr, { days: mainDays }) },
    reportIds: closedIds,
    templateId: template.id,
    decidedBy: actor.uid,
    ...(input.ai ? { aiDecisionId: input.ai.decisionId } : {}),
    ...(superseded ? { supersedes: superseded.id } : {}),
    now,
    // notifiedAt is written here, before the mail leaves: sendMail only enqueues the statement on the
    // BullMQ mail queue (5 attempts, exponential backoff, deferred while the provider is down), so a
    // transient failure never loses it, and its security priority keeps it out of the mail quota's
    // skips. A failed enqueue is logged with the decision id: POST /api/admin/decisions/{id}/notify
    // re-sends the statement (renotify.ts, audit D1a-08).
    notified: notify && isRestrictive(template.action),
  };
  const main = createDecisionTx(tx, run.mainRef, mainInput);

  let sanction: Committed["sanction"] = null;
  if (plan?.kind === "sanction" && plan.separate && run.sanctionRef) {
    const sanctionTemplate = decisionTemplate(plan.templateId);
    if (!sanctionTemplate) throw new Error(`unknown sanction template ${plan.templateId}`);
    const days = plan.sanction.durationDays;
    const doc = createDecisionTx(tx, run.sanctionRef, {
      target: { type: "user", id: ownerUid },
      affectedUid: ownerUid,
      action: plan.sanction.action,
      ...(days ? { durationDays: days } : {}),
      facts: statementFacts(sanctionTemplate, input.details, days),
      origin,
      automation,
      ground: { type: sanctionTemplate.ground.type, ref: sanctionTemplate.ground.ref, explanation: fillTemplateText(sanctionTemplate.explanation.fr, { days }) },
      reportIds: [],
      templateId: sanctionTemplate.id,
      decidedBy: actor.uid,
      now,
      notified: notify,
    });
    sanction = { id: run.sanctionRef.id, doc };
  }

  // ---- Reports and the appealed decision.
  const founded = template.outcome === "founded";
  closeReportsTx(tx, closedIds, {
    status: founded ? "actioned" : "dismissed",
    outcome: template.outcome,
    decisionId: mainId,
    ...(input.manifestlyUnfounded && !founded ? { manifestlyUnfounded: input.manifestlyUnfounded === true ? true : [...input.manifestlyUnfounded] } : {}),
    now,
  });
  if (superseded && run.options.reversal) {
    tx.update(decisionRef(superseded.id), {
      "appeal.status": "reversed",
      "appeal.closedAt": Timestamp.fromDate(now),
      "appeal.reviewer": actor.uid,
      ...(run.options.reversal.selfReview ? { "appeal.selfReview": true } : {}),
      "appeal.note": run.options.reversal.note.slice(0, 2000),
      "appeal.outcomeDecisionId": mainId,
      supersededBy: mainId,
    });
    void consume("firestore.writes", 1);
  }

  return { open, closedIds, main, sanction, listing: listingResult, messageHidden, reviewStatus, until };
}

/** Runs one after-commit step; a failure is logged (the decision stands) and reported as false. */
async function step<T>(label: string, context: Record<string, unknown>, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    logger.error({ ...context, err: (error as Error).message }, `decisions: ${label} failed after the commit`);
    return null;
  }
}

function flaggedManifest(input: DecisionInput, reportId: string): boolean {
  const flag = input.manifestlyUnfounded;
  return flag === true || (Array.isArray(flag) && flag.includes(reportId));
}

interface AfterInput extends TxInput {
  committed: Committed;
}

async function afterCommit(run: AfterInput): Promise<void> {
  const { actor, template, target, subject, plan, now, input, committed } = run;
  const mainId = run.mainRef.id;
  const context = { decisionId: mainId };
  const ownerUid = subject.ownerUid;
  const reversal = run.superseded;
  let restored = false;

  // Content.
  if (committed.listing) {
    const { record, search, effect } = committed.listing;
    if (search) await step("search fast lane", context, () => notifySearchIndex([record.id]));
    revalidateListingPaths({ ...(record.slugId ? { slugId: record.slugId } : {}), publicId: record.sellerPublicId });
    restored = effect === "shown" || effect === "unremoved";
  }
  if (subject.message) {
    const { cid, mid } = subject.message;
    if (template.action === "remove") await step("message hide", context, () => hideMessage(cid, mid, `decision:${mainId}`));
    else if (isRestoring(template.action) && committed.messageHidden) restored = (await step("message restore", context, () => unhideMessage(cid, mid))) === true;
  }
  if (subject.review) {
    const id = subject.review;
    if (template.action === "remove") await step("review hide", context, () => setReviewVisibility(id, false, now, `decision:${mainId}`));
    // Restore and no_action publish a hidden review or one held for a moderator; only the hidden one was "restored".
    else if (isRestoring(template.action) && (committed.reviewStatus === "hidden" || committed.reviewStatus === "pending")) {
      const shown = await step("review publish", context, () => setReviewVisibility(id, true, now));
      restored = shown === true && committed.reviewStatus === "hidden";
    }
  }
  if (target.type === "user" && !reversal && (isRestoring(template.action) || template.action === "warn")) {
    const shown = await step("account restore", context, () => unhideTarget({ type: "user", id: target.id }, now));
    restored = isRestoring(template.action) && shown === true;
  }

  // Account measure.
  const clearHiddenFor = target.type === "user" ? new Set(committed.closedIds) : undefined;
  const accountDecisionId = committed.sanction?.id ?? mainId;
  // Live messaging streams of a suspended or banned account end at once (phase-5 D2 security).
  if (plan?.kind === "sanction" && (plan.sanction.action === "suspend_account" || plan.sanction.action === "ban")) await step("messaging revoke", context, () => publishRevoked(ownerUid));
  if (plan?.kind === "sanction" && plan.sanction.action === "suspend_account") await step("listings pause", context, () => pauseListingsForSuspension(ownerUid, now, clearHiddenFor));
  if (plan?.kind === "sanction" && plan.sanction.action === "ban") await step("listings removal", context, () => removeListingsForBan(ownerUid, accountDecisionId, actor.uid, now, clearHiddenFor));
  if (plan?.kind === "reverse" && plan.action === "suspend_account" && plan.suspensionLifted) await step("listings resume", context, () => resumeModerationPaused(ownerUid, now));
  if (plan?.kind === "reverse" && plan.action === "ban") await step("listings restore", context, () => restoreBannedListings(ownerUid, plan.decisionId, actor.uid, now));

  // Reporters' accuracy (D15): their own reports only, not the ones a reversal re-marks.
  const founded = template.outcome === "founded";
  const outcomes = committed.open
    .filter((report) => report.source === "user" && report.reporter.uid)
    .map((report) => ({ uid: report.reporter.uid as string, founded, manifestlyUnfounded: !founded && flaggedManifest(input, report.id) }));
  if (outcomes.length > 0) {
    const result = await step("reporter accuracy", context, () => recordReporterOutcomes(outcomes, now));
    if (result && (result.warned.length > 0 || result.suspended.length > 0)) {
      await step("reporter warnings", context, () => sendReporterWarnings(result, new Date(now.getTime() + REPORTER_SUSPENSION_DAYS * DAY_MS)));
    }
  }

  // Mails (queued with retries: see the `notified` note in applyTx; a skipped statement is re-sent by renotify.ts).
  const source = committed.main.origin;
  if (committed.main.notifiedAt && isRestrictive(template.action)) {
    const notice: NoticeInput = {
      decisionId: mainId,
      templateId: template.id,
      action: template.action,
      targetType: target.type,
      affectedUid: ownerUid,
      title: subject.title,
      details: input.details ?? null,
      durationDays: committed.main.durationDays ?? null,
      until: target.type === "user" ? committed.until : null,
      source,
      automation: committed.main.automation,
      appealDeadline: committed.main.appealDeadline,
    };
    await sendDecisionNotice(notice);
  }
  if (committed.sanction?.doc.notifiedAt) {
    const { doc } = committed.sanction;
    await sendDecisionNotice({
      decisionId: committed.sanction.id,
      templateId: doc.templateId,
      action: doc.action as DecisionAction,
      targetType: "user",
      affectedUid: ownerUid,
      title: null,
      details: input.details ?? null,
      durationDays: doc.durationDays ?? null,
      until: committed.until,
      source,
      automation: doc.automation,
      appealDeadline: doc.appealDeadline,
    });
  }
  if (!reversal && committed.open.length > 0) {
    await sendReportOutcomes(committed.open, {
      decisionId: mainId,
      action: template.action,
      outcome: founded ? "actioned" : "dismissed",
      automation: committed.main.automation,
      appealDeadline: committed.main.appealDeadline,
      appealable: source !== "authority_order",
    });
  }
  if (restored && !reversal && run.options.notifyAffected !== false) {
    await sendContentRestored(ownerUid, { targetType: target.type, title: subject.title, via: "report", decisionId: mainId });
  }

  // Audit and the AI proposal.
  const reasonParts = [`template ${template.id}`, `${committed.closedIds.length} report(s)`];
  if (reversal) reasonParts.push(`reverses ${reversal.id}`);
  if (committed.sanction) reasonParts.push(`sanction ${committed.sanction.id}`);
  await audit({
    actorUid: actor.uid,
    actorRole: actor.role,
    action: `decision.${template.action}`,
    target: { type: target.type, id: target.id },
    automated: actor.role === "system",
    reason: `${reasonParts.join("; ")}; decision ${mainId}`.slice(0, 500),
    ...(run.options.ip ? { ip: run.options.ip } : {}),
    at: now,
  });
  if (committed.sanction) {
    await audit({
      actorUid: actor.uid,
      actorRole: actor.role,
      action: `decision.${committed.sanction.doc.action}`,
      target: { type: "user", id: ownerUid },
      automated: false,
      reason: `template ${committed.sanction.doc.templateId}; with decision ${mainId}; decision ${committed.sanction.id}`,
      ...(run.options.ip ? { ip: run.options.ip } : {}),
      at: now,
    });
  }
  if (input.ai) await markAiDecision(input.ai.decisionId, input.ai.outcome, actor.uid, mainId);
}

/**
 * Takes one decision on one target (D13-D16). Throws 404 (target gone), 409 (`conflict`: nothing
 * to decide, a state that does not allow the measure, an appeal closed meanwhile) or 403
 * (`sanction_not_allowed`: a moderator's ban outside a P0 report, an automated sanction).
 */
export async function decide(actor: DecisionActor, input: DecisionInput, options: DecideOptions = {}): Promise<DecideResult> {
  const now = options.now ?? new Date();
  const template = decisionTemplate(input.templateId);
  if (!template || !template.targets.includes(input.target.type)) throw new HttpError(400, "invalid_body", "template not valid for this target");
  const target = input.target;

  const superseded = options.reversal ? await getDecision(options.reversal.decisionId) : null;
  if (options.reversal) {
    if (!superseded) throw notFound();
    if (superseded.target.type !== target.type || superseded.target.id !== target.id) throw new HttpError(400, "invalid_body", "a reversal decides on the appealed target");
  }
  const subject = await readSubject(target);
  const [owner, openBefore, suspension] = await Promise.all([
    getUserRecord(subject.ownerUid),
    openReportsForTarget(targetKey(target)),
    superseded?.action === "suspend_account" ? getSuspension(subject.ownerUid) : Promise.resolve(null),
  ]);
  if (target.type === "user" && !owner) throw notFound();
  const plan = planAccount({ actor, template, target, chosen: input.sanction, owner, superseded, suspension, priorities: openBefore.map((report) => report.priority) });

  const mainRef = decisionsCol().doc();
  const sanctionRef = plan?.kind === "sanction" && plan.separate ? decisionsCol().doc() : null;
  const life = target.type === "listing" ? await lifetime() : null;
  const run: TxInput = { actor, template, input, target, subject, owner, plan, superseded, options, now, mainRef, sanctionRef, life };

  const undo = await prepareAuth(subject.ownerUid, plan);
  let committed: Committed;
  try {
    committed = await db().runTransaction((tx) => applyTx(tx, run));
  } catch (error) {
    await undoQuietly(undo, { decisionId: mainRef.id });
    throw error;
  }
  await afterCommit({ ...run, committed });
  return {
    decisionId: mainRef.id,
    action: template.action,
    reportIds: committed.closedIds,
    sanctionDecisionId: committed.sanction?.id ?? null,
    affectedUid: subject.ownerUid,
    appealDeadline: committed.main.appealDeadline,
  };
}

export interface BulkDismissResult {
  target: string;
  status: "dismissed" | "skipped";
  decisionId: string | null;
  reason?: "not_p3" | "no_open_report" | "failed";
}

const NO_ACTION_TEMPLATE: Record<DecisionTargetType, string> = { listing: "listing.no_action", message: "message.no_action", user: "user.no_action", review: "review.no_action" };

/** Bulk dismissal of low-priority reports (D24): targets whose open reports are all P3, one decision each. */
export async function bulkDismiss(actor: DecisionActor, targets: readonly DecisionTarget[], options: { manifestlyUnfounded?: boolean; ip?: string; now?: Date } = {}): Promise<BulkDismissResult[]> {
  const results: BulkDismissResult[] = [];
  for (const target of targets) {
    const key = targetKey(target);
    const open = await openReportsForTarget(key);
    if (open.length === 0) {
      results.push({ target: key, status: "skipped", decisionId: null, reason: "no_open_report" });
      continue;
    }
    if (open.some((report) => report.priority !== "P3")) {
      results.push({ target: key, status: "skipped", decisionId: null, reason: "not_p3" });
      continue;
    }
    try {
      const result = await decide(
        actor,
        { target, templateId: NO_ACTION_TEMPLATE[target.type], ...(options.manifestlyUnfounded ? { manifestlyUnfounded: true as const } : {}) },
        { ...(options.ip ? { ip: options.ip } : {}), ...(options.now ? { now: options.now } : {}) },
      );
      results.push({ target: key, status: "dismissed", decisionId: result.decisionId });
    } catch (error) {
      logger.warn({ target: target.type, err: (error as Error).message }, "decisions: bulk dismissal skipped a target");
      results.push({ target: key, status: "skipped", decisionId: null, reason: "failed" });
    }
  }
  return results;
}
