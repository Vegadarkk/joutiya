import "server-only";
import type { AiConfig } from "@/config/ai";
import { reportReason, slaDueAt, type ReportPriority, type ReportReasonId, type ReportTargetType } from "@/config/report-reasons";
import type { Locale } from "@/config/site";
import { aiConfig } from "@/lib/ai/config";
import { alert } from "@/lib/alert";
import type { CreateReportRequest, CreateReportResponse } from "@/lib/contracts/reports";
import { getListingTx, updateListingTx, type ListingFieldPatch, type ListingRecord } from "@/lib/db/repositories/listings";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { deviceHash, ipPrefixHash } from "@/lib/db/repositories/reveal-logs";
import { enqueueSearchOutboxTx } from "@/lib/db/repositories/search-outbox";
import { getUploads } from "@/lib/db/repositories/uploads";
import type { ReportDoc, UserPrivateDoc } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { consume } from "@/lib/quota";
import { consumeLimit } from "@/lib/rate-limit/limiter";
import { normalizeEmail } from "@/lib/security/email-normalize";
import { requestTriage } from "./hooks";
import { createReportTx, listTargetReports, newReportId, OPEN_STATUSES, reportHold, reportPurgeAt, updateReport, withHold, type ReportRecord } from "./repository";
import { privateAccountRef, readPrivateAccount } from "./reporter";
import { findDuplicate, hasAutoSignal, hasMultiSignal, isAbusive, isCorroborated, p0Alert, raisePriority, slaHours, strongSignalOf, trustedFromFacts, type StrongSignal } from "./rules";
import { conversationRef, reviewDocRef, resolveReportTarget, resolveSystemTarget, type ResolvedTarget, type SystemTargetInput } from "./targets";
import { afterVisibilityChange, hideTarget, type VisibilityChange } from "./visibility";

// Notice and action (art. 16 DSA, design D10-D12). One transaction writes the report and its effects
// on the target: a listing counts one more open report, loses its ads eligibility and gets the
// `report:{id}` legal hold (hidden at once on a strong signal); a message's conversation and a
// reported account get the hold. Then: the strong-signal hide of an account or a message, the P0
// alert, the acknowledgement mail, the agent's triage request. Without a strong signal nothing is
// hidden: a lone P0 report from an unknown reporter only alerts (exit criterion).

export interface ReportRequester {
  /** Signed-in reporter (the route checked the session), or null for a visitor. */
  uid: string | null;
  /** Clear IP of the request (hashed to its /24 or /48 prefix before storage). */
  ip: string;
  /** Rate-limit device key (`d:<id>` or `anon:<ip bucket>`), hashed before storage. */
  deviceKey: string;
  /** Visitor's language (cookie or page); an account's own locale wins. */
  locale: Locale;
}

export interface CreateReportOptions {
  now?: Date;
  /** false when a P0 limiter could not count (rate-limit store down): no "multi" signal (D11, fails safe). */
  multiSignal?: boolean;
  /** Thresholds (tests); config/ai otherwise. */
  ai?: AiConfig;
}

export interface CreateReportResult {
  response: CreateReportResponse;
  /** false: an open report of the same reporter already covers it (200, nothing written). */
  created: boolean;
  /** The target was hidden by this report. */
  hidden: boolean;
  strongSignal?: StrongSignal;
}

function invalidField(path: string, code: string): HttpError {
  return new HttpError(400, "invalid_body", undefined, { details: [{ path, code }] });
}

/**
 * Checks of the notice that need no read (before the limiters): the reason fits the target type,
 * shops are not reportable yet, a message needs an account, and a visitor gives a name and an
 * e-mail address unless the reason is P0 (art. 16(2)(c)). Returns the reason's priority.
 */
export function assertReportInput(input: CreateReportRequest, signedIn: boolean): ReportPriority {
  const reason = reportReason(input.reasonId);
  if (!reason) throw invalidField("reasonId", "invalid_value");
  if (!(reason.targets as readonly ReportTargetType[]).includes(input.target.type)) throw invalidField("reasonId", "invalid_for_target");
  if (input.target.type === "pro") throw new HttpError(422, "report_target_invalid", "shops are reportable from phase 7");
  if (input.target.type === "message" && !signedIn) throw new HttpError(401, "unauthenticated", "reporting a message needs an account");
  if (!signedIn && reason.priority !== "P0") {
    if (!input.name) throw invalidField("name", "required");
    if (!input.email) throw invalidField("email", "required");
  }
  return reason.priority;
}

function responseOf(reportId: string, priority: ReportPriority, duplicate: boolean): CreateReportResponse {
  return { reportId, duplicate, priority, slaHours: slaHours(priority) };
}

/** Photo nudity scores of a listing (uploads.checks.nsfw), for the "auto" signal. */
async function nsfwScores(listing: ListingRecord): Promise<(number | undefined)[]> {
  if (listing.photos.length === 0) return [];
  const uploads = await getUploads(listing.photos.map((photo) => photo.id));
  return uploads.map((upload) => upload.checks.nsfw);
}

interface CommitInput {
  id: string;
  doc: ReportDoc;
  resolved: ResolvedTarget;
  signal?: StrongSignal;
  now: Date;
}

interface CommitResult {
  /** A listing hidden in the report's own transaction. */
  change: VisibilityChange | null;
}

/** Writes the report and its effects on the target in one transaction (reads first, as Firestore requires). */
async function commitReport({ id, doc, resolved, signal, now }: CommitInput): Promise<CommitResult> {
  const { target } = resolved;
  const hold = reportHold(id);
  return db().runTransaction(async (tx) => {
    let change: VisibilityChange | null = null;
    let hidden = false;
    if (target.type === "listing") {
      const listing = await getListingTx(tx, target.id);
      if (!listing) throw new HttpError(422, "report_target_invalid");
      const hide = signal !== undefined && !listing.moderation.hiddenBy;
      const legalHold = withHold(listing.legalHold, hold);
      const version = listing.version + 1;
      const patch: ListingFieldPatch = {
        moderation: {
          ...listing.moderation,
          openReports: listing.moderation.openReports + 1,
          ...(hide && signal ? { hiddenBy: { reportId: id, signal, at: now } } : {}),
        },
        adsEligible: false,
        ...(legalHold ? { legalHold } : {}),
        version,
        updatedAt: now,
      };
      updateListingTx(tx, listing.id, patch);
      if (hide) {
        hidden = true;
        const search = listing.status === "published";
        if (search) enqueueSearchOutboxTx(tx, listing.id, "delete", version, now);
        change = { listing, search, hidden: true, reason: `report ${id} (${signal})` };
      }
    } else if (target.type === "message") {
      const cid = target.id.split("/")[0] ?? "";
      const snapshot = await tx.get(conversationRef(cid));
      void consume("firestore.reads", 1);
      const current: unknown = snapshot.get("legalHold");
      const legalHold = snapshot.exists ? withHold(Array.isArray(current) ? (current as string[]) : [], hold) : null;
      if (legalHold) {
        tx.update(conversationRef(cid), { legalHold });
        void consume("firestore.writes", 1);
      }
    } else if (target.type === "review") {
      const snapshot = await tx.get(reviewDocRef(target.id));
      void consume("firestore.reads", 1);
      const current: unknown = snapshot.get("legalHold");
      const legalHold = snapshot.exists ? withHold(Array.isArray(current) ? (current as string[]) : [], hold) : null;
      if (legalHold) {
        tx.update(reviewDocRef(target.id), { legalHold });
        void consume("firestore.writes", 1);
      }
    } else if (target.type === "user") {
      const snapshot = await tx.get(privateAccountRef(target.id));
      void consume("firestore.reads", 1);
      const current: unknown = snapshot.get("legalHold");
      const legalHold = snapshot.exists ? withHold(Array.isArray(current) ? (current as string[]) : [], hold) : null;
      if (legalHold) {
        tx.update(privateAccountRef(target.id), { legalHold });
        void consume("firestore.writes", 1);
      }
    }
    createReportTx(tx, id, { ...doc, hidden });
    return { change };
  });
}

interface AfterCommitInput {
  id: string;
  doc: ReportDoc;
  signal?: StrongSignal;
  change: VisibilityChange | null;
  now: Date;
  /** Acknowledgement mail (art. 16(4)), when an address is known. */
  ack?: { to: string; locale: Locale; displayName: string | null };
  triage: boolean;
}

/** Hide (account, message), P0 alert, acknowledgement, triage. Never throws: the report is stored. */
async function afterCommit({ id, doc, signal, change, now, ack, triage }: AfterCommitInput): Promise<boolean> {
  let hidden = change !== null;
  try {
    if (change) await afterVisibilityChange([change], now);
    else if (signal && doc.target.type !== "listing") {
      hidden = await hideTarget({ type: doc.target.type, id: doc.target.id }, signal, id, now);
      if (hidden) await updateReport(id, { hidden: true }, now);
    }
  } catch (error) {
    logger.error({ reportId: id, err: (error as Error).message }, "reports: strong-signal hide failed");
  }
  if (doc.priority === "P0") {
    await alert(p0Alert({ reportId: id, targetType: doc.target.type, reasonId: doc.reasonId, signal, hidden, slaDueAt: doc.slaDueAt, source: doc.source }));
  }
  // A member's acknowledgement goes to the account's verified address: never capped, so a visitor
  // typing that address cannot use up the member's acknowledgements (audit D1a-04 review).
  if (ack && (doc.reporter.uid !== undefined || (await ackAllowed(ack.to, id)))) {
    try {
      // A courtesy (the response carries the report id): bulk priority, dropped first under the mail quota.
      await sendMail({
        template: "reportReceived",
        locale: ack.locale,
        to: ack.to,
        priority: "bulk",
        idempotencyKey: `reportReceived-${id}`,
        data: { displayName: ack.displayName, reportId: id, targetType: doc.target.type, reasonId: doc.reasonId, slaHours: slaHours(doc.priority), receivedAt: now.toISOString(), urgent: doc.priority === "P0" },
      });
    } catch (error) {
      logger.error({ reportId: id, err: (error as Error).message }, "reports: acknowledgement mail failed");
    }
  }
  if (triage) await requestTriage(id);
  return hidden;
}

/**
 * The per-address cap of the visitors' acknowledgements (audit D1a-04): 2 per day per normalized
 * e-mail, counted by the rate-limit store (HMAC key, nothing in clear). A visitor types any address; a
 * flood of notices must not become a flood of mails to a stranger, nor eat the mail quota. Store
 * down (closed policy): no acknowledgement, the report stands.
 */
async function ackAllowed(email: string, reportId: string): Promise<boolean> {
  const outcome = await consumeLimit("report.ack.email", normalizeEmail(email));
  if (!outcome.ok) logger.info({ reportId, reason: outcome.reason }, "reports: acknowledgement mail skipped (per-address cap)");
  return outcome.ok;
}

interface ReporterFacts {
  uid?: string;
  locale: Locale;
  email?: string;
  displayName: string | null;
  account: UserPrivateDoc | null;
  trusted: boolean;
}

async function reporterFacts(input: CreateReportRequest, requester: ReportRequester, ai: AiConfig, now: Date): Promise<ReporterFacts> {
  if (!requester.uid) {
    return { locale: requester.locale, ...(input.email ? { email: input.email } : {}), displayName: input.name ?? null, account: null, trusted: false };
  }
  const [user, account] = await Promise.all([getUserRecord(requester.uid), readPrivateAccount(requester.uid)]);
  // Art. 23: notices of an account suspended for manifestly unfounded reports are refused.
  if (isAbusive(account?.reporter, now)) throw new HttpError(403, "report_not_allowed", "reports suspended (art. 23)");
  const trusted = ai.trustedFlaggers.includes(requester.uid) || trustedFromFacts({ user, reporter: account?.reporter ?? null, now });
  return {
    uid: requester.uid,
    locale: user?.locale ?? requester.locale,
    ...(account?.email ? { email: account.email } : {}),
    displayName: user?.displayName ?? null,
    account,
    trusted,
  };
}

/**
 * A notice from the public form (POST /api/reports). The route did the session, the limiters, the
 * Turnstile check and `assertReportInput`. 201 with the new report, or 200 with the reporter's open
 * report on the same target (`duplicate: true`, nothing written).
 */
export async function createReport(input: CreateReportRequest, requester: ReportRequester, options: CreateReportOptions = {}): Promise<CreateReportResult> {
  const now = options.now ?? new Date();
  const reasonPriority = assertReportInput(input, requester.uid !== null);
  const ai = options.ai ?? (await aiConfig());
  const reporter = await reporterFacts(input, requester, ai, now);
  const resolved = await resolveReportTarget(input.target, requester.uid);
  const { target } = resolved;

  const device = deviceHash(requester.deviceKey);
  const ipPrefix = ipPrefixHash(requester.ip);
  const open = await listTargetReports(target, OPEN_STATUSES);
  const duplicate = findDuplicate(open, { ...(reporter.uid ? { uid: reporter.uid } : {}), deviceHash: device }, reasonPriority);
  if (duplicate) return { response: responseOf(duplicate.id, duplicate.priority, true), created: false, hidden: false };

  // D11: another reporter on a distinct device and network corroborates the notice: one rank more
  // urgent (never P0). The strong "multi" signal needs two accounts and a P0 reason (audit D1a-03).
  const candidate = { ...(reporter.uid ? { uid: reporter.uid } : {}), deviceHash: device, ipPrefixHash: ipPrefix, createdAt: now };
  const signalReport = (report: ReportRecord) => ({ ...report.reporter, createdAt: report.createdAt });
  const userReports = open.filter((report) => report.source === "user");
  const corroborated = isCorroborated(candidate, userReports.map(signalReport), now);
  const priority = corroborated ? raisePriority(reasonPriority) : reasonPriority;

  let signal: StrongSignal | undefined;
  if (priority === "P0") {
    const others = userReports.filter((report) => report.priority === "P0").map(signalReport);
    const multi = options.multiSignal !== false && hasMultiSignal(candidate, others, now);
    const auto = !reporter.trusted && resolved.listing ? hasAutoSignal(await nsfwScores(resolved.listing), ai.reports.autoHideNsfwAt) : false;
    signal = strongSignalOf(priority, { trusted: reporter.trusted, auto, multi });
  }

  const id = newReportId();
  const doc: ReportDoc = {
    target,
    reasonId: input.reasonId,
    priority,
    explanation: input.explanation,
    goodFaith: true,
    source: "user",
    reporter: {
      ...(reporter.uid ? { uid: reporter.uid } : { ...(input.name ? { name: input.name } : {}), ...(input.email ? { email: input.email } : {}) }),
      locale: reporter.locale,
      ipPrefixHash: ipPrefix,
      deviceHash: device,
      trusted: reporter.trusted,
    },
    ...(signal ? { strongSignal: signal } : {}),
    hidden: false,
    status: "open",
    slaDueAt: slaDueAt(priority, now),
    createdAt: now,
    updatedAt: now,
    purgeAt: reportPurgeAt(now),
  };
  const { change } = await commitReport({ id, doc, resolved, ...(signal ? { signal } : {}), now });
  logger.info({ reportId: id, target: target.type, priority, corroborated, signal: signal ?? null }, "report created");
  const hidden = await afterCommit({
    id,
    doc,
    ...(signal ? { signal } : {}),
    change,
    now,
    ...(reporter.email ? { ack: { to: reporter.email, locale: reporter.locale, displayName: reporter.displayName } } : {}),
    triage: true,
  });
  return { response: responseOf(id, priority, false), created: true, hidden, ...(signal ? { strongSignal: signal } : {}) };
}

export interface SystemReportInput {
  target: SystemTargetInput;
  reasonId: ReportReasonId;
  /** Facts for the moderator (no personal data beyond what the target holds); cut at 2 000 characters. */
  explanation: string;
  /** system: messaging repeat rule (D5) or the agent (D20), never a strong signal; authority: removal order (D17), hidden at once. */
  source: "system" | "authority";
  authorityRequestId?: string;
  /** false: no agent triage (the agent's own reports already carry a proposal, D20); authority orders are never triaged. */
  triage?: boolean;
  now?: Date;
}

export interface SystemReportResult {
  reportId: string;
  /** An open report of the same origin already covers it (same reason for system, same request for authority). */
  duplicate: boolean;
  priority: ReportPriority;
  hidden: boolean;
}

/** A report raised by the platform itself (design D5, D17, D20). No acknowledgement mail. */
export async function createSystemReport(input: SystemReportInput): Promise<SystemReportResult> {
  const now = input.now ?? new Date();
  const reason = reportReason(input.reasonId);
  if (!reason) throw new Error(`unknown report reason ${input.reasonId}`);
  const resolved = await resolveSystemTarget(input.target);
  const { target } = resolved;
  const open = await listTargetReports(target, OPEN_STATUSES);
  const same = (report: ReportRecord) =>
    report.source === input.source && (input.source === "authority" ? report.authorityRequestId === input.authorityRequestId : report.reasonId === input.reasonId);
  const existing = open.find(same);
  if (existing) return { reportId: existing.id, duplicate: true, priority: existing.priority, hidden: existing.hidden };

  const signal: StrongSignal | undefined = input.source === "authority" ? "authority" : undefined;
  const id = newReportId();
  const doc: ReportDoc = {
    target,
    reasonId: input.reasonId,
    priority: reason.priority,
    explanation: input.explanation.trim().slice(0, 2000),
    goodFaith: true,
    source: input.source,
    reporter: { locale: "fr", ipPrefixHash: input.source, deviceHash: input.source, trusted: input.source === "authority" },
    ...(signal ? { strongSignal: signal } : {}),
    hidden: false,
    status: "open",
    slaDueAt: slaDueAt(reason.priority, now),
    ...(input.authorityRequestId ? { authorityRequestId: input.authorityRequestId } : {}),
    createdAt: now,
    updatedAt: now,
    purgeAt: reportPurgeAt(now),
  };
  const { change } = await commitReport({ id, doc, resolved, ...(signal ? { signal } : {}), now });
  logger.info({ reportId: id, target: target.type, priority: reason.priority, source: input.source }, "system report created");
  // Authority orders are decided by a human only: no agent triage. The agent's own reports skip it too (triage: false).
  const hidden = await afterCommit({ id, doc, ...(signal ? { signal } : {}), change, now, triage: input.source === "system" && input.triage !== false });
  return { reportId: id, duplicate: false, priority: reason.priority, hidden };
}

