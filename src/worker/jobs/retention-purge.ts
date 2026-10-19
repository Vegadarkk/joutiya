import { alert } from "@/lib/alert";
import { audit } from "@/lib/audit";
import { PHOTO_VARIANTS } from "@/lib/contracts/media";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import {
  deleteConversationIfEmpty,
  deleteConversationMessages,
  deleteIfPurgeable,
  deleteJournalPastPurge,
  deleteOrphanEvidence,
  listListingsPastPurge,
  listPastPurge,
  oldestPastPurge,
  purgeListing,
  purgeOrphanUserBlocks,
  readDecisionPurgeAts,
  readUserBlocksCursor,
  setAiDecisionPurgeAt,
  writeUserBlocksCursor,
  type HeldCollection,
  type JournalCollection,
  type ListingCursor,
  type PastPurgeDoc,
} from "@/lib/db/repositories/retention";
import { deleteUploadDocument, listUploadsByTarget, updateUpload, UPLOADS_BY_TARGET_LIMIT, type UploadRecord } from "@/lib/db/repositories/uploads";
import { COLLECTIONS, type ListingStatus } from "@/lib/db/schemas";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { photoObjectKey, quarantineObjectKey, type PhotoBucket } from "@/lib/media/urls";
import { isDegraded } from "@/lib/quota";
import { notifySearchIndex } from "@/lib/search/queue";
import { isStorageNotConfigured, objectStore, type ObjectStore } from "@/lib/storage";
import { RETAINED_STATUSES, storedBytes } from "@/lib/uploads/policy";
import { recordMediaBytes } from "@/lib/uploads/storage-gauge";

// Nightly at 03:00 UTC (architecture §5 "Purges sans TTL", table of §7 retention, design D16):
// 1. listings past purgeAt (expired, sold, removed or rejected + listingPurgeMonths, or a draft
//    30 days after its last edit, A4-04) without a legal hold: replaced by a tombstone (transaction re-checking status, hold and date, with the
//    searchOutbox delete), then their photo variants, quarantine objects and upload documents go.
//    A removed listing keeps its text and its photos until then (architecture §5: removal + 12
//    months): purge-quarantine (hourly) moves its photos to the private bucket
//    (`removed/listings/...`) and the purgeAt of its uploads to the listing's, and never deletes
//    them; a removed listing's variants are deleted from both buckets (a move cut short can leave
//    them in either). Unattached and orphan uploads of other listings are purge-quarantine's;
// 2. contentOps (1 year) and revealLogs (90 days) past purgeAt;
// 3. phase 5 (design D22, AF §7 retention table): conversations 12 months after the last activity
//    (no legal hold, not frozen), messages first, then the evidence of deleted messages, the
//    conversation last (re-checked, only once empty); reports (closed), moderationDecisions (no
//    open appeal) and authorityRequests (closed) after 5 years; aiDecisions after 12 months (no
//    legal hold; one grounding a decision lives as long as the decision, its purgeAt is moved);
//    auditLogs after 5 years (purgeAt, D22; exported daily first, audit-export); userBlocks of
//    accounts that no longer exist (rotating scan, USER_BLOCKS_SCAN a night).
// At most PURGE_DELETE_BUDGET document deletions a night (Spark: 20 000 a day); the rest waits a
// night, and a backlog older than 3 days raises an alert. Idempotent: every step re-reads.

export const PURGE_DELETE_BUDGET = 15_000;
export const LISTING_PURGE_BATCH = 100;
export const LISTING_PURGE_PAGES = 20;
/** Pages of upload documents read for one purged listing (each page is deleted before the next query). */
export const LISTING_MEDIA_PAGES = 5;
export const JOURNAL_BATCH = 400;
export const BACKLOG_ALERT_MS = 3 * 24 * 3_600_000;
/** Phase 5: documents read per page of a held collection (each page's deletions in one transaction). */
export const HELD_PURGE_BATCH = 200;
export const HELD_PURGE_PAGES = 20;
/** Conversations read per page (each purged one by one: messages, evidence, then the document). */
export const CONVERSATION_PURGE_BATCH = 100;
export const CONVERSATION_PURGE_PAGES = 20;
export const MESSAGE_PURGE_BATCH = 400;
export const EVIDENCE_PURGE_BATCH = 200;
/** userBlocks documents checked a night against users/{uid}. */
export const USER_BLOCKS_SCAN = 200;
/** Evidence pages read for one conversation (its evidence documents are rare: masked or hidden messages). */
const EVIDENCE_PURGE_PAGES = 10;

/** Statuses whose purgeAt ends the listing; published, paused and pending listings are never purged. */
export const PURGEABLE_STATUSES: readonly ListingStatus[] = ["expired", "sold", "removed", "rejected", "draft"];

export interface RetentionResult {
  /** Listings replaced by a tombstone. */
  listings: number;
  /** Past purgeAt but under a legal hold. */
  held: number;
  /** Past purgeAt but not purgeable (status, or changed since the query), or unreadable. */
  skipped: number;
  /** Upload documents deleted (with their objects). */
  uploads: number;
  /** Storage objects deleted (idempotent: a missing object counts too). */
  objects: number;
  contentOps: number;
  revealLogs: number;
  /** Phase 5 (D22). Conversations deleted, with their messages and evidence documents. */
  conversations: number;
  messages: number;
  evidence: number;
  reports: number;
  decisions: number;
  authorityRequests: number;
  aiDecisions: number;
  auditLogs: number;
  userBlocks: number;
  failed: number;
  /** The delete budget or the Firestore quota stopped the run before the end. */
  deferred: boolean;
}

interface RunState {
  now: Date;
  store: ObjectStore | null;
  budget: number;
  freedBytes: number;
  /** Steps that failed, with their error: one alert per run. */
  failedSteps: string[];
  result: RetentionResult;
}

export function isPurgeable(listing: Pick<ListingRecord, "status" | "legalHold" | "purgeAt">, now: Date): boolean {
  return PURGEABLE_STATUSES.includes(listing.status) && listing.legalHold.length === 0 && listing.purgeAt !== undefined && listing.purgeAt.getTime() <= now.getTime();
}

/** Buckets that may hold a photo of `listing`: the private one too for a removed listing's, or an upload recorded there. */
function photoBuckets(listing: Pick<ListingRecord, "status">, upload?: Pick<UploadRecord, "bucket">): PhotoBucket[] {
  return RETAINED_STATUSES.includes(listing.status) || upload?.bucket === "private" ? ["media", "private"] : ["media"];
}

async function deleteVariants(store: ObjectStore, listingId: string, photoId: string, buckets: readonly PhotoBucket[], state: RunState): Promise<void> {
  for (const bucket of buckets) {
    for (const variant of PHOTO_VARIANTS) {
      await store.delete(bucket, photoObjectKey(bucket, listingId, photoId, variant));
      state.result.objects += 1;
    }
  }
}

/** Objects first, then the document: a storage failure leaves the document to retry from. */
async function deleteUpload(store: ObjectStore, listing: ListingRecord, upload: UploadRecord, state: RunState): Promise<void> {
  await deleteVariants(store, upload.targetId, upload.id, photoBuckets(listing, upload), state);
  await store.delete("quarantine", upload.quarantineKey);
  state.result.objects += 1;
  // By the document as this run removed it: an owner DELETE or purge-quarantine may have ended or
  // removed it since the listing, and then its bytes were theirs (no delete either: none counted).
  const removed = await deleteUploadDocument(upload.id);
  state.freedBytes += storedBytes(removed);
  if (!removed) return;
  state.result.uploads += 1;
  state.budget -= 1;
}

/**
 * Media of a purged listing: every upload document of it (page after page, each deleted before the
 * next query), and any attached photo without one.
 */
async function purgeListingMedia(store: ObjectStore, listing: ListingRecord, state: RunState): Promise<void> {
  const known = new Set<string>();
  for (let pages = 0; pages < LISTING_MEDIA_PAGES; pages += 1) {
    const uploads = await listUploadsByTarget(listing.id);
    try {
      for (const upload of uploads) {
        known.add(upload.id);
        await deleteUpload(store, listing, upload, state);
      }
    } catch (error) {
      // The listing is a tombstone now: hand what is left to purge-quarantine (orphan uploads past purgeAt).
      await Promise.allSettled(uploads.map((upload) => updateUpload(upload.id, { purgeAt: state.now }, state.now)));
      throw error;
    }
    if (uploads.length < UPLOADS_BY_TARGET_LIMIT) break;
  }
  // A photo id is its upload id: without the document, its keys are still derivable.
  for (const photo of listing.photos) {
    if (known.has(photo.id)) continue;
    await deleteVariants(store, listing.id, photo.id, photoBuckets(listing), state);
    await store.delete("quarantine", quarantineObjectKey(photo.id));
    state.result.objects += 1;
  }
}

async function purgeListings(state: RunState): Promise<void> {
  const { now, result } = state;
  let cursor: ListingCursor | undefined;
  for (let pages = 0; pages < LISTING_PURGE_PAGES; pages += 1) {
    const page = await listListingsPastPurge(now, LISTING_PURGE_BATCH, cursor);
    result.skipped += page.read - page.listings.length;
    for (const listing of page.listings) {
      if (listing.legalHold.length > 0) {
        result.held += 1;
        continue;
      }
      if (!isPurgeable(listing, now)) {
        result.skipped += 1;
        continue;
      }
      if (state.budget <= 0) {
        result.deferred = true;
        return;
      }
      try {
        const tombstone = await purgeListing(listing.id, (current) => isPurgeable(current, now), now);
        if (!tombstone) {
          result.skipped += 1;
          continue;
        }
        result.listings += 1;
        await notifySearchIndex([listing.id]);
        await audit({ actorUid: "system", actorRole: "system", action: "listing.purge", target: { type: "listing", id: listing.id }, automated: true, at: now });
        if (state.store) await purgeListingMedia(state.store, listing, state);
      } catch (error) {
        result.failed += 1;
        logger.warn({ listingId: listing.id, err: (error as Error).message }, "listing not purged");
      }
    }
    if (!page.next || page.read < LISTING_PURGE_BATCH) return;
    cursor = page.next;
  }
}

async function purgeJournal(collection: JournalCollection, key: "contentOps" | "revealLogs" | "auditLogs", state: RunState): Promise<void> {
  while (state.budget > 0) {
    const wanted = Math.min(JOURNAL_BATCH, state.budget);
    const deleted = await deleteJournalPastPurge(collection, state.now, wanted);
    state.result[key] += deleted;
    state.budget -= deleted;
    if (deleted < wanted) return;
  }
  state.result.deferred = true;
  const oldest = await oldestPastPurge(collection, state.now);
  if (oldest && state.now.getTime() - oldest.getTime() > BACKLOG_ALERT_MS) {
    await alert({
      severity: "P2",
      title: `Purge en retard : ${collection}`,
      body: `Des documents ${collection} attendent leur suppression depuis le ${oldest.toISOString().slice(0, 10)} (budget de ${PURGE_DELETE_BUDGET} suppressions par nuit atteint).`,
    });
  }
}

// ---- Phase 5 (design D22) -------------------------------------------------------------------

const dateOf = (value: unknown): Date | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value : null);

function isPast(data: Record<string, unknown>, now: Date): boolean {
  const purgeAt = dateOf(data.purgeAt);
  return purgeAt !== null && purgeAt.getTime() <= now.getTime();
}

/** An empty legalHold array; anything else (a hold, or a malformed field) keeps the document. */
function noHold(data: Record<string, unknown>): boolean {
  return Array.isArray(data.legalHold) && data.legalHold.length === 0;
}

/** Past purgeAt (12 months after the last message), no legal hold, open (a frozen one waits for its authority request). */
export function conversationPurgeable(data: Record<string, unknown>, now: Date): boolean {
  return isPast(data, now) && noHold(data) && data.status === "open";
}

/** Past purgeAt (5 years) and closed: an open report keeps its notice (and its hold on the target). */
export function reportPurgeable(data: Record<string, unknown>, now: Date): boolean {
  return isPast(data, now) && (data.status === "actioned" || data.status === "dismissed");
}

/** Past purgeAt (5 years), no appeal under review. */
export function decisionPurgeable(data: Record<string, unknown>, now: Date): boolean {
  const appeal = data.appeal as { status?: unknown } | undefined;
  return isPast(data, now) && appeal?.status !== "open";
}

/** Past purgeAt (closedAt + 5 years) and closed. */
export function authorityRequestPurgeable(data: Record<string, unknown>, now: Date): boolean {
  return isPast(data, now) && data.status === "closed";
}

/**
 * Past purgeAt (12 months), no legal hold, and the decision it grounds (if any) gone or past its
 * own purgeAt: `decisions` maps decision ids to their purgeAt (readDecisionPurgeAts).
 */
export function aiDecisionPurgeable(data: Record<string, unknown>, now: Date, decisions: ReadonlyMap<string, Date> = new Map()): boolean {
  if (!isPast(data, now) || !noHold(data)) return false;
  const decisionPurgeAt = typeof data.decisionId === "string" ? decisions.get(data.decisionId) : undefined;
  return decisionPurgeAt === undefined || decisionPurgeAt.getTime() <= now.getTime();
}

type HeldKey = "reports" | "decisions" | "authorityRequests";

/** One collection purged by pages: the documents `purgeable` accepts go in one transaction per page. */
async function purgeHeld(collection: HeldCollection, key: HeldKey, state: RunState, purgeable: (data: Record<string, unknown>, now: Date) => boolean): Promise<void> {
  const { now, result } = state;
  let cursor: ListingCursor | undefined;
  for (let pages = 0; pages < HELD_PURGE_PAGES; pages += 1) {
    const page = await listPastPurge(collection, now, HELD_PURGE_BATCH, cursor);
    const candidates = page.docs.filter((doc) => purgeable(doc.data, now));
    result.held += page.docs.length - candidates.length;
    if (candidates.length > 0) {
      if (state.budget <= 0) {
        result.deferred = true;
        return;
      }
      const ids = candidates.slice(0, state.budget).map((doc) => doc.id);
      const deleted = await deleteIfPurgeable(collection, ids, (data) => purgeable(data, now));
      result[key] += deleted.length;
      result.skipped += ids.length - deleted.length;
      state.budget -= deleted.length;
      if (ids.length < candidates.length) {
        result.deferred = true;
        return;
      }
    }
    if (!page.next || page.read < HELD_PURGE_BATCH) return;
    cursor = page.next;
  }
}

/** aiDecisions: like purgeHeld, after reading the decisions they ground (one getAll per page). */
async function purgeAiDecisions(state: RunState): Promise<void> {
  const { now, result } = state;
  let cursor: ListingCursor | undefined;
  for (let pages = 0; pages < HELD_PURGE_PAGES; pages += 1) {
    const page = await listPastPurge(COLLECTIONS.aiDecisions, now, HELD_PURGE_BATCH, cursor);
    const decisionIds = page.docs.map((doc) => doc.data.decisionId).filter((id): id is string => typeof id === "string" && id.length > 0);
    const decisions = await readDecisionPurgeAts(decisionIds);
    const candidates: PastPurgeDoc[] = [];
    for (const doc of page.docs) {
      if (aiDecisionPurgeable(doc.data, now, decisions)) {
        candidates.push(doc);
        continue;
      }
      result.held += 1;
      // Grounds a decision kept longer: it lives as long (AF §7), the next nights skip it.
      const decisionPurgeAt = typeof doc.data.decisionId === "string" ? decisions.get(doc.data.decisionId) : undefined;
      if (decisionPurgeAt && decisionPurgeAt.getTime() > now.getTime()) {
        try {
          await setAiDecisionPurgeAt(doc.id, decisionPurgeAt);
        } catch (error) {
          logger.warn({ aiDecisionId: doc.id, err: (error as Error).message }, "aiDecision purgeAt not moved");
        }
      }
    }
    if (candidates.length > 0) {
      if (state.budget <= 0) {
        result.deferred = true;
        return;
      }
      const ids = candidates.slice(0, state.budget).map((doc) => doc.id);
      const deleted = await deleteIfPurgeable(COLLECTIONS.aiDecisions, ids, (data) => aiDecisionPurgeable(data, now, decisions));
      result.aiDecisions += deleted.length;
      result.skipped += ids.length - deleted.length;
      state.budget -= deleted.length;
      if (ids.length < candidates.length) {
        result.deferred = true;
        return;
      }
    }
    if (!page.next || page.read < HELD_PURGE_BATCH) return;
    cursor = page.next;
  }
}

/**
 * One conversation: its messages up to the purgeAt read (a message written since then is newer and
 * moved purgeAt), the evidence of deleted messages, then the document once empty and still
 * purgeable. False when the budget ran out (the rest waits a night).
 */
async function purgeConversation(doc: PastPurgeDoc, state: RunState): Promise<boolean> {
  const { result } = state;
  const cutoff = dateOf(doc.data.purgeAt);
  if (!cutoff) return true;
  for (;;) {
    const wanted = Math.min(MESSAGE_PURGE_BATCH, state.budget);
    if (wanted <= 0) {
      result.deferred = true;
      return false;
    }
    const deleted = await deleteConversationMessages(doc.id, cutoff, wanted);
    result.messages += deleted;
    state.budget -= deleted;
    if (deleted < wanted) break;
  }
  for (let pages = 0; pages < EVIDENCE_PURGE_PAGES; pages += 1) {
    const wanted = Math.min(EVIDENCE_PURGE_BATCH, state.budget);
    if (wanted <= 0) {
      result.deferred = true;
      return false;
    }
    const { deleted, read } = await deleteOrphanEvidence(doc.id, wanted);
    result.evidence += deleted;
    state.budget -= deleted;
    // A full page with nothing deleted: what is left belongs to messages still there.
    if (read < wanted || deleted === 0) break;
  }
  if (state.budget <= 0) {
    result.deferred = true;
    return false;
  }
  if (await deleteConversationIfEmpty(doc.id, (data) => conversationPurgeable(data, state.now))) {
    result.conversations += 1;
    state.budget -= 1;
  } else {
    result.skipped += 1;
  }
  return true;
}

async function purgeConversations(state: RunState): Promise<void> {
  const { now, result } = state;
  let cursor: ListingCursor | undefined;
  for (let pages = 0; pages < CONVERSATION_PURGE_PAGES; pages += 1) {
    const page = await listPastPurge(COLLECTIONS.conversations, now, CONVERSATION_PURGE_BATCH, cursor);
    for (const doc of page.docs) {
      if (!conversationPurgeable(doc.data, now)) {
        result.held += 1;
        continue;
      }
      if (state.budget <= 0) {
        result.deferred = true;
        return;
      }
      try {
        if (!(await purgeConversation(doc, state))) return;
      } catch (error) {
        result.failed += 1;
        logger.warn({ cid: doc.id, err: (error as Error).message }, "conversation not purged");
      }
    }
    if (!page.next || page.read < CONVERSATION_PURGE_BATCH) return;
    cursor = page.next;
  }
}

/** userBlocks of accounts that no longer exist: USER_BLOCKS_SCAN documents a night, from a rotating cursor. */
async function purgeUserBlocks(state: RunState): Promise<void> {
  const limit = Math.min(USER_BLOCKS_SCAN, state.budget);
  if (limit <= 0) {
    state.result.deferred = true;
    return;
  }
  const after = await readUserBlocksCursor();
  const page = await purgeOrphanUserBlocks(after, limit);
  state.result.userBlocks += page.deleted;
  state.budget -= page.deleted;
  await writeUserBlocksCursor(page.read < limit ? null : page.last, state.now);
}

/** Phase 5 counts audited once per collection and run (one entry a night, not one per document). */
const PHASE5_AUDITED: readonly (keyof RetentionResult & string)[] = ["conversations", "messages", "evidence", "reports", "decisions", "authorityRequests", "aiDecisions", "auditLogs", "userBlocks"];

async function auditPhase5(state: RunState): Promise<void> {
  for (const key of PHASE5_AUDITED) {
    const count = state.result[key];
    if (typeof count !== "number" || count === 0) continue;
    await audit({ actorUid: "system", actorRole: "system", action: "retention.purge", target: { type: "collection", id: key }, automated: true, reason: `${count} documents`, at: state.now });
  }
}

export async function retentionPurge(now = new Date(), deps: { store?: ObjectStore } = {}): Promise<RetentionResult> {
  const result: RetentionResult = {
    listings: 0,
    held: 0,
    skipped: 0,
    uploads: 0,
    objects: 0,
    contentOps: 0,
    revealLogs: 0,
    conversations: 0,
    messages: 0,
    evidence: 0,
    reports: 0,
    decisions: 0,
    authorityRequests: 0,
    aiDecisions: 0,
    auditLogs: 0,
    userBlocks: 0,
    failed: 0,
    deferred: false,
  };
  if (!isFirestoreConfigured()) {
    logger.warn("retention-purge skipped: Firebase not configured");
    return result;
  }
  let store: ObjectStore | null;
  try {
    store = deps.store ?? objectStore();
  } catch (error) {
    if (!isStorageNotConfigured(error)) throw error;
    store = null;
  }
  const state: RunState = { now, store, budget: PURGE_DELETE_BUDGET, freedBytes: 0, failedSteps: [], result };

  // Without object storage the photos could not be deleted: listings and uploads wait (no orphan objects).
  if (store) {
    await step("listings", state, () => purgeListings(state));
  } else {
    logger.warn("retention-purge: object storage not configured, listings and their uploads left for a later run");
  }
  await step("contentOps", state, () => purgeJournal(COLLECTIONS.contentOps, "contentOps", state));
  await step("revealLogs", state, () => purgeJournal(COLLECTIONS.revealLogs, "revealLogs", state));
  await step("conversations", state, () => purgeConversations(state));
  await step("reports", state, () => purgeHeld(COLLECTIONS.reports, "reports", state, reportPurgeable));
  await step("decisions", state, () => purgeHeld(COLLECTIONS.moderationDecisions, "decisions", state, decisionPurgeable));
  await step("authorityRequests", state, () => purgeHeld(COLLECTIONS.authorityRequests, "authorityRequests", state, authorityRequestPurgeable));
  await step("aiDecisions", state, () => purgeAiDecisions(state));
  await step("auditLogs", state, () => purgeJournal(COLLECTIONS.auditLogs, "auditLogs", state));
  await step("userBlocks", state, () => purgeUserBlocks(state));
  // The job completes anyway, so the worker's failed handler never hears of a failed step.
  if (state.failedSteps.length > 0) {
    await alert({
      severity: "P2",
      title: "Tâche système en échec : retention-purge",
      body: `Étape(s) en échec : ${state.failedSteps.join(" ; ")}. La nuit suivante réessaie.`,
    });
  }

  await auditPhase5(state);
  if (state.freedBytes > 0) await recordMediaBytes(-state.freedBytes, now);
  logger.info({ ...result }, "retention-purge");
  return result;
}

/** One step; a failing query stops that step only, never the others. The delete quota is re-checked before each. */
async function step(name: string, state: RunState, run: () => Promise<void>): Promise<void> {
  try {
    if (await isDegraded("firestore.deletes")) {
      state.result.deferred = true;
      logger.warn({ step: name }, "retention-purge: step deferred, Firestore delete quota degraded");
      return;
    }
    await run();
  } catch (error) {
    state.result.failed += 1;
    state.failedSteps.push(`${name} (${(error as Error).message.slice(0, 200)})`);
    logger.error({ step: name, err: (error as Error).message }, "retention-purge step failed");
  }
}
