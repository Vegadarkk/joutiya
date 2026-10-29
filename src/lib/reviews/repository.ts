import "server-only";
import { createHash } from "node:crypto";
import { FieldValue, Timestamp, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { REVIEW_PURGE_MONTHS } from "@/config/reviews";
import { reviewWindow, type ReviewWindow } from "@/lib/contracts/reviews";
import { COLLECTIONS, reviewSchema, type ReviewDoc } from "@/lib/db/schemas";
import { datesToTimestamps, timestampsToDates } from "@/lib/db/repositories/timestamps";
import { db } from "@/lib/firebase/admin";
import { addMonths, blocksOf, conversationFromSnapshot, conversationRef, isPairBlocked, userBlocksRef, type ConversationRecord } from "@/lib/messaging/repository";
import { consume } from "@/lib/quota";

// reviews/{reviewId} (vitrine-avis §2-3) and the seller's rating aggregates on users/{uid}.stats.
// The server is the only writer. A review is created, deleted, answered or hidden in one
// transaction that also keeps `ratingCount`, `ratingSum`, `ratingAvg` and `ratingHistogram` of the
// seller exact (only published reviews count).

export interface ReviewRecord extends ReviewDoc {
  id: string;
}

const VERSION = "review:v1";

/** base64url(sha256("review:v1:" + cid)), 22 characters: one review per conversation, the cid never public. */
export function reviewId(cid: string): string {
  return createHash("sha256").update(`${VERSION}:${cid}`).digest("base64url").slice(0, 22);
}

const reviews = () => db().collection(COLLECTIONS.reviews);
const reviewRef = (id: string) => reviews().doc(id);
const userRef = (uid: string) => db().collection(COLLECTIONS.users).doc(uid);

export function reviewFromSnapshot(snapshot: DocumentSnapshot): ReviewRecord | null {
  const data = snapshot.data();
  if (!data) return null;
  const parsed = reviewSchema.safeParse(timestampsToDates(data));
  return parsed.success ? { id: snapshot.id, ...parsed.data } : null;
}

export class ReviewError extends Error {
  constructor(
    readonly reason: "missing" | "not_allowed" | "window" | "exists" | "state",
    readonly window?: ReviewWindow,
  ) {
    super(`review ${reason}`);
    this.name = "ReviewError";
  }
}

/** The buyer's review window of a conversation (the conversation's own fields: no extra read). */
export function conversationWindow(conversation: ConversationRecord, now: Date): ReviewWindow {
  return reviewWindow(
    { sellerRepliedAt: conversation.sellerRepliedAt?.getTime() ?? null, lastActivityAt: conversation.lastMessage.at.getTime(), reviewedAt: conversation.reviewedAt?.getTime() ?? null },
    now.getTime(),
  );
}

type Histogram = [number, number, number, number, number];

interface RatingStats {
  ratingCount: number;
  ratingSum: number;
  ratingHistogram: Histogram;
}

/** A stored counter, or 0 when absent, negative or not a whole number. */
const counter = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0);

/**
 * The seller's aggregates as stored; an account from before the reviews starts at zero. Only the rating
 * fields are read: another `stats` counter out of range (a stray negative `activeListings`, staging
 * 28 Oct) must not reset the ratings, which the next write would then persist.
 */
export function ratingStatsOf(snapshot: DocumentSnapshot): RatingStats {
  const stats = snapshot.get("stats") as Record<string, unknown> | undefined;
  const count = counter(stats?.["ratingCount"]);
  const stored = stats?.["ratingHistogram"];
  const histogram = (Array.isArray(stored) && stored.length === 5 ? stored.map(counter) : [0, 0, 0, 0, 0]) as Histogram;
  const average = typeof stats?.["ratingAvg"] === "number" ? Math.min(5, Math.max(0, stats["ratingAvg"] as number)) : 0;
  const sum = stats?.["ratingSum"] === undefined ? Math.round(average * count) : counter(stats["ratingSum"]);
  return { ratingCount: count, ratingSum: sum, ratingHistogram: histogram };
}

/** Adds (delta 1) or removes (delta -1) one published rating; the dotted fields of `stats` only. */
function applyRating(tx: Transaction, sellerUid: string, current: RatingStats, rating: number, delta: 1 | -1): void {
  const count = Math.max(0, current.ratingCount + delta);
  const sum = Math.max(0, current.ratingSum + delta * rating);
  const histogram = [...current.ratingHistogram] as Histogram;
  histogram[rating - 1] = Math.max(0, histogram[rating - 1]! + delta);
  tx.update(userRef(sellerUid), {
    "stats.ratingCount": count,
    "stats.ratingSum": sum,
    "stats.ratingHistogram": histogram,
    "stats.ratingAvg": count > 0 ? Math.round((sum / count) * 100) / 100 : 0,
  });
}

export interface NewReview {
  cid: string;
  authorUid: string;
  rating: number;
  text: string;
  /** "pending": held for a moderator (sensitive data). */
  status: "published" | "pending";
  now: Date;
}

/**
 * Creates the review of a conversation by its buyer, in one transaction: the conversation (buyer,
 * window, not frozen, nobody blocked or closed), no review yet, the seller's aggregates. Marks the
 * conversation `reviewedAt` (its `updatedAt` stays: the inbox order does not move).
 */
export async function createReview(input: NewReview): Promise<ReviewRecord> {
  const id = reviewId(input.cid);
  const record = await db().runTransaction(async (tx) => {
    const conversation = conversationFromSnapshot(await tx.get(conversationRef(input.cid)));
    if (!conversation || conversation.buyerUid !== input.authorUid) throw new ReviewError("missing");
    if (conversation.status === "frozen" || conversation.blockedBy.length > 0 || (conversation.accountClosed ?? []).length > 0) throw new ReviewError("not_allowed");
    const window = conversationWindow(conversation, input.now);
    if (window.state === "done") throw new ReviewError("exists", window);
    if (window.state !== "open") throw new ReviewError("window", window);
    const [existing, seller, author, authorBlocks, sellerBlocks] = await tx.getAll(
      reviewRef(id),
      userRef(conversation.sellerUid),
      userRef(input.authorUid),
      userBlocksRef(input.authorUid),
      userBlocksRef(conversation.sellerUid),
    );
    if (existing!.exists) throw new ReviewError("exists");
    // Both accounts active (Avis utilisateurs §1.2): a restricted, suspended, banned or closed account neither reviews nor is reviewed.
    if (!seller!.exists || !author!.exists || seller!.get("status") !== "active" || author!.get("status") !== "active") throw new ReviewError("not_allowed");
    if (isPairBlocked(blocksOf([authorBlocks!, sellerBlocks!]), input.authorUid, conversation.sellerUid)) throw new ReviewError("not_allowed");
    const authorPublicId = author!.get("publicId") as string;
    const authorName = author!.get("displayName") as string;
    const doc = reviewSchema.parse({
      conversationId: input.cid,
      listingId: conversation.listingId,
      listingTitle: conversation.listingSnapshot.title,
      authorUid: input.authorUid,
      authorPublicId,
      authorName,
      targetUid: conversation.sellerUid,
      targetPublicId: conversation.sellerPublicId,
      targetName: conversation.sellerName,
      rating: input.rating,
      text: input.text,
      exchangeConfirmed: true,
      verified: true,
      experienceAt: conversation.sellerRepliedAt,
      status: input.status,
      createdAt: input.now,
      updatedAt: input.now,
      legalHold: [],
    });
    tx.create(reviewRef(id), datesToTimestamps(doc) as Record<string, unknown>);
    tx.update(conversationRef(input.cid), { reviewedAt: Timestamp.fromDate(input.now) });
    if (input.status === "published") applyRating(tx, conversation.sellerUid, ratingStatsOf(seller!), input.rating, 1);
    return { id, ...doc };
  });
  void consume("firestore.reads", 6);
  void consume("firestore.writes", record.status === "published" ? 3 : 2);
  return record;
}

/** The author deletes the review: status `deleted`, purge in 12 months, the rating leaves the average. */
export async function deleteReview(id: string, authorUid: string, now: Date): Promise<void> {
  const writes = await db().runTransaction(async (tx) => {
    const review = reviewFromSnapshot(await tx.get(reviewRef(id)));
    if (!review || review.authorUid !== authorUid || review.status === "deleted") throw new ReviewError("missing");
    if (review.status === "hidden") throw new ReviewError("state");
    const seller = review.status === "published" ? await tx.get(userRef(review.targetUid)) : null;
    tx.update(reviewRef(id), { status: "deleted", updatedAt: Timestamp.fromDate(now), purgeAt: Timestamp.fromDate(addMonths(now, REVIEW_PURGE_MONTHS)) });
    if (seller?.exists) applyRating(tx, review.targetUid, ratingStatsOf(seller), review.rating, -1);
    return seller?.exists ? 2 : 1;
  });
  void consume("firestore.reads", writes === 2 ? 2 : 1);
  void consume("firestore.writes", writes);
}

/** The seller's one public reply to a published review. */
export async function replyToReview(id: string, targetUid: string, text: string, now: Date): Promise<ReviewRecord> {
  const record = await db().runTransaction(async (tx) => {
    const review = reviewFromSnapshot(await tx.get(reviewRef(id)));
    if (!review || review.targetUid !== targetUid || review.status !== "published") throw new ReviewError("missing");
    if (review.reply) throw new ReviewError("exists");
    const reply = { text, at: now };
    tx.update(reviewRef(id), { reply: { text, at: Timestamp.fromDate(now) }, updatedAt: Timestamp.fromDate(now) });
    return { ...review, reply, updatedAt: now };
  });
  void consume("firestore.reads", 1);
  void consume("firestore.writes", 1);
  return record;
}

/**
 * Moves a review between `published` and `pending`/`hidden` (moderation), keeping the seller's
 * aggregates exact. `hiddenBy`: `decision:{id}` or `report:{id}`. Returns the review before the change, or null when it does not exist.
 */
export async function setReviewStatus(id: string, status: "published" | "hidden", now: Date, hiddenBy?: string): Promise<ReviewRecord | null> {
  const before = await db().runTransaction(async (tx) => {
    const review = reviewFromSnapshot(await tx.get(reviewRef(id)));
    if (!review || review.status === "deleted" || review.status === status) return review;
    const seller = await tx.get(userRef(review.targetUid));
    const update: Record<string, unknown> = { status, updatedAt: Timestamp.fromDate(now) };
    if (status === "hidden") {
      update.purgeAt = Timestamp.fromDate(addMonths(now, REVIEW_PURGE_MONTHS));
      if (hiddenBy) update.hiddenBy = hiddenBy;
    } else {
      // Shown again: no purge, no trace of the hide on the public document.
      update.purgeAt = FieldValue.delete();
      update.hiddenBy = FieldValue.delete();
    }
    tx.update(reviewRef(id), update);
    if (seller.exists && (review.status === "published" || status === "published")) applyRating(tx, review.targetUid, ratingStatsOf(seller), review.rating, status === "published" ? 1 : -1);
    return review;
  });
  void consume("firestore.reads", 2);
  void consume("firestore.writes", 2);
  return before;
}

export async function getReview(id: string): Promise<ReviewRecord | null> {
  const snapshot = await reviewRef(id).get();
  void consume("firestore.reads", 1);
  return reviewFromSnapshot(snapshot);
}

export interface ReviewPosition {
  at: Date;
  id: string;
}

/** Published reviews of a seller, newest first, after `after` (index targetUid, status, createdAt desc). */
export async function listPublishedReviews(targetUid: string, limit: number, after?: ReviewPosition): Promise<ReviewRecord[]> {
  let query = reviews().where("targetUid", "==", targetUid).where("status", "==", "published").orderBy("createdAt", "desc").orderBy("__name__", "desc").limit(limit);
  if (after) query = query.startAfter(Timestamp.fromDate(after.at), after.id);
  const snapshot = await query.get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(reviewFromSnapshot).filter((review): review is ReviewRecord => review !== null);
}

/** Reviews a member wrote, newest first, deleted ones aside (index authorUid, createdAt desc). */
export async function listAuthoredReviews(authorUid: string, limit: number): Promise<ReviewRecord[]> {
  const snapshot = await reviews().where("authorUid", "==", authorUid).orderBy("createdAt", "desc").limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map(reviewFromSnapshot).filter((review): review is ReviewRecord => review !== null && review.status !== "deleted");
}

/** Reviews anonymized per closure: more is unlikely (one per conversation as a buyer). */
const CLOSURE_REVIEWS = 500;

/**
 * Account closure (D26): the author's name leaves the reviews they wrote (shown as a former
 * member), the reviews stay. Returns the sellers whose storefront shows one of them.
 */
export async function anonymizeAuthoredReviews(authorUid: string, now: Date): Promise<string[]> {
  const snapshot = await reviews().where("authorUid", "==", authorUid).limit(CLOSURE_REVIEWS).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const named = snapshot.docs.filter((doc) => doc.get("authorName") !== "");
  for (let start = 0; start < named.length; start += 400) {
    const batch = db().batch();
    for (const doc of named.slice(start, start + 400)) batch.update(doc.ref, { authorName: "", updatedAt: Timestamp.fromDate(now) });
    await batch.commit();
  }
  void consume("firestore.writes", named.length);
  return [...new Set(named.filter((doc) => doc.get("status") === "published").map((doc) => doc.get("targetPublicId") as string))];
}

/**
 * Account closure of a seller: the reviews they received leave public view (their storefront is
 * gone) and are purged 12 months later like any hidden review, unless legally held. Returns how
 * many were hidden.
 */
export async function hideReceivedReviews(targetUid: string, now: Date): Promise<number> {
  const snapshot = await reviews().where("targetUid", "==", targetUid).limit(CLOSURE_REVIEWS).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const shown = snapshot.docs.filter((doc) => doc.get("status") === "published" || doc.get("status") === "pending");
  const purgeAt = Timestamp.fromDate(addMonths(now, REVIEW_PURGE_MONTHS));
  for (let start = 0; start < shown.length; start += 400) {
    const batch = db().batch();
    for (const doc of shown.slice(start, start + 400)) batch.update(doc.ref, { status: "hidden", hiddenBy: "account:closed", purgeAt, updatedAt: Timestamp.fromDate(now) });
    await batch.commit();
  }
  void consume("firestore.writes", shown.length);
  return shown.length;
}
