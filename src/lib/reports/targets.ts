import "server-only";
import type { ReportTargetInput } from "@/lib/contracts/reports";
import { getListing, type ListingRecord } from "@/lib/db/repositories/listings";
import { findUserByPublicId, getUserRecord, type UserRecord } from "@/lib/db/repositories/profiles";
import { COLLECTIONS, type ReportDoc } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/http/errors";
import { isListingId } from "@/lib/listings/ids";
import { PUBLIC_STATES } from "@/lib/listings/public";
import { consume } from "@/lib/quota";
import { getReview } from "@/lib/reviews/repository";
import { splitMessageId } from "./target-key";

// What a report points at (design D10): the browser names a listing id, a profile publicId or a
// `{cid}/{mid}` message or a review id; the server resolves the owner (the person a decision would affect) and
// refuses what the reporter cannot see: 422 `report_target_invalid` (missing, never public, not a
// participant of the conversation), 403 `report_not_allowed` (one's own listing, profile, message).

export type StoredTarget = ReportDoc["target"];

export interface ResolvedTarget {
  target: StoredTarget;
  /** The listing of a listing target (counters, legal hold, the "auto" signal). */
  listing?: ListingRecord;
}

const invalidTarget = () => new HttpError(422, "report_target_invalid");
const notAllowed = () => new HttpError(403, "report_not_allowed", "own content");

export const conversationRef = (cid: string) => db().collection(COLLECTIONS.conversations).doc(cid);
export const messageRef = (cid: string, mid: string) => conversationRef(cid).collection(COLLECTIONS.messages).doc(mid);
export const evidenceRef = (cid: string, mid: string) => conversationRef(cid).collection(COLLECTIONS.evidence).doc(mid);
export const reviewDocRef = (id: string) => db().collection(COLLECTIONS.reviews).doc(id);

export interface ConversationFacts {
  participants: string[];
  listingId: string;
  sellerUid: string;
  buyerUid: string;
}

export interface MessageFacts {
  senderUid: string;
  type: string;
}

/** The fields of a conversation the reports need, or null (missing, malformed). Read without the full schema: messaging owns it. */
export async function readConversationFacts(cid: string): Promise<ConversationFacts | null> {
  const snapshot = await conversationRef(cid).get();
  void consume("firestore.reads", 1);
  const participants: unknown = snapshot.get("participants");
  const listingId: unknown = snapshot.get("listingId");
  const sellerUid: unknown = snapshot.get("sellerUid");
  const buyerUid: unknown = snapshot.get("buyerUid");
  if (!snapshot.exists || !Array.isArray(participants) || typeof listingId !== "string" || typeof sellerUid !== "string" || typeof buyerUid !== "string") return null;
  return { participants: participants.filter((uid): uid is string => typeof uid === "string"), listingId, sellerUid, buyerUid };
}

export async function readMessageFacts(cid: string, mid: string): Promise<MessageFacts | null> {
  const snapshot = await messageRef(cid, mid).get();
  void consume("firestore.reads", 1);
  const senderUid: unknown = snapshot.get("senderUid");
  const type: unknown = snapshot.get("type");
  if (!snapshot.exists || typeof senderUid !== "string" || typeof type !== "string") return null;
  return { senderUid, type };
}

/** A profile that can be reported: activated, neither closed nor banned. */
function reportableAccount(user: UserRecord | null): user is UserRecord {
  return user !== null && user.activation === "done" && user.status !== "closed" && user.status !== "banned";
}

async function resolveListing(id: string, reporterUid: string | null): Promise<ResolvedTarget> {
  const listingId = id.toLowerCase();
  if (!isListingId(listingId)) throw invalidTarget();
  const listing = await getListing(listingId);
  // Only what has (or had) a public page: drafts, held, rejected and removed listings are not reportable.
  if (!listing || !(PUBLIC_STATES as readonly string[]).includes(listing.status)) throw invalidTarget();
  if (reporterUid && listing.ownerUid === reporterUid) throw notAllowed();
  return { target: { type: "listing", id: listing.id, ownerUid: listing.ownerUid }, listing };
}

async function resolveUser(publicId: string, reporterUid: string | null): Promise<ResolvedTarget> {
  const user = await findUserByPublicId(publicId);
  if (!reportableAccount(user)) throw invalidTarget();
  if (reporterUid && user.uid === reporterUid) throw notAllowed();
  return { target: { type: "user", id: user.uid, ownerUid: user.uid, publicId: user.publicId } };
}

async function resolveMessage(id: string, reporterUid: string | null): Promise<ResolvedTarget> {
  const ids = splitMessageId(id);
  if (!ids || !reporterUid) throw invalidTarget();
  const conversation = await readConversationFacts(ids.cid);
  // Not a participant: the same answer as a missing conversation (IDOR).
  if (!conversation || !conversation.participants.includes(reporterUid)) throw invalidTarget();
  const message = await readMessageFacts(ids.cid, ids.mid);
  if (!message || message.type !== "text") throw invalidTarget();
  if (message.senderUid === reporterUid) throw notAllowed();
  return { target: { type: "message", id: `${ids.cid}/${ids.mid}`, ownerUid: message.senderUid, listingId: conversation.listingId } };
}

/** A published review, reported by anyone but its author (the seller it is about included). */
async function resolveReview(id: string, reporterUid: string | null): Promise<ResolvedTarget> {
  const review = await getReview(id);
  if (!review || review.status !== "published") throw invalidTarget();
  if (reporterUid && review.authorUid === reporterUid) throw notAllowed();
  return { target: { type: "review", id: review.id, ownerUid: review.authorUid, listingId: review.listingId } };
}

/** The reported target of a notice, as stored; throws the refusals above. */
export async function resolveReportTarget(input: ReportTargetInput, reporterUid: string | null): Promise<ResolvedTarget> {
  switch (input.type) {
    case "listing":
      return resolveListing(input.id, reporterUid);
    case "user":
      return resolveUser(input.id, reporterUid);
    case "message":
      return resolveMessage(input.id, reporterUid);
    case "pro":
      // Shops arrive with phase 7.
      throw invalidTarget();
    case "review":
      return resolveReview(input.id, reporterUid);
  }
}

export interface SystemTargetInput {
  type: StoredTarget["type"];
  /** Stored id: listing id, uid, `{cid}/{mid}`, review id. */
  id: string;
  ownerUid?: string;
  publicId?: string;
  listingId?: string;
}

/** A target named by the server itself (messaging repeat rule, agent, authority request): the owner is looked up when missing. */
export async function resolveSystemTarget(input: SystemTargetInput): Promise<ResolvedTarget> {
  switch (input.type) {
    case "listing": {
      const listing = await getListing(input.id);
      if (!listing) throw invalidTarget();
      return { target: { type: "listing", id: listing.id, ownerUid: listing.ownerUid }, listing };
    }
    case "user": {
      const publicId = input.publicId ?? (await getUserRecord(input.id))?.publicId;
      return { target: { type: "user", id: input.id, ownerUid: input.id, ...(publicId ? { publicId } : {}) } };
    }
    case "message": {
      const ids = splitMessageId(input.id);
      if (!ids) throw invalidTarget();
      let ownerUid = input.ownerUid;
      let listingId = input.listingId;
      if (!ownerUid) ownerUid = (await readMessageFacts(ids.cid, ids.mid))?.senderUid;
      if (!listingId) listingId = (await readConversationFacts(ids.cid))?.listingId;
      if (!ownerUid) throw invalidTarget();
      return { target: { type: "message", id: input.id, ownerUid, ...(listingId ? { listingId } : {}) } };
    }
    case "pro":
      throw invalidTarget();
    case "review": {
      // Any state but deleted: a review held for a moderator is reported by the system itself.
      const review = await getReview(input.id);
      if (!review || review.status === "deleted") throw invalidTarget();
      return { target: { type: "review", id: review.id, ownerUid: review.authorUid, listingId: review.listingId } };
    }
  }
}
