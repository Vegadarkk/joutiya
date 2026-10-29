import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { offerMarker, offerFinalAmount } from "@/lib/contracts/offers";
import { COLLECTIONS, messageSchema, type MessageDoc, type OfferDoc } from "@/lib/db/schemas";
import { datesToTimestamps } from "@/lib/db/repositories/timestamps";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { conversationFromSnapshot, conversationRef, messagesRef, type ConversationRecord } from "@/lib/messaging/repository";

// Expiry of unanswered offers (job offer-expiry, Carte vivante lot 5): conversations whose
// `offerExpiresAt` is due, read by a single-field range query (automatic index). Each one is
// re-read in a transaction: an offer still open or countered past its 48 h becomes "expired" with
// a system message of the thread (no unread count, the inbox order kept, like an appointment
// reminder), and `offerExpiresAt` goes. Readers already show "expired" from the due time on.

export const EXPIRY_BATCH = 50;

/** Conversations with an offer due to expire at `now`, oldest due first. */
export async function listDueOffers(now: Date, limit = EXPIRY_BATCH): Promise<string[]> {
  const snapshot = await db().collection(COLLECTIONS.conversations).where("offerExpiresAt", "<=", now).orderBy("offerExpiresAt").limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map((doc) => doc.id);
}

export interface RecordedExpiry {
  conversation: ConversationRecord;
  offer: OfferDoc;
  messageId: string;
}

/**
 * The expiry of `cid`'s offer as a system message; null when there is nothing to expire any more
 * (answered meanwhile, or another run took it; `offerExpiresAt` is then cleared if left).
 */
export async function recordExpiry(cid: string, now: Date): Promise<RecordedExpiry | null> {
  const messageRef = messagesRef(cid).doc();
  const outcome = await db().runTransaction(async (tx) => {
    const conversation = conversationFromSnapshot(await tx.get(conversationRef(cid)));
    if (!conversation?.offerExpiresAt || conversation.offerExpiresAt.getTime() > now.getTime()) return null;
    const current = conversation.offer;
    const waiting = current !== undefined && (current.status === "open" || current.status === "countered") && current.expiresAt.getTime() <= now.getTime();
    if (!waiting) {
      tx.update(conversationRef(cid), { offerExpiresAt: FieldValue.delete() });
      return { cleared: true as const };
    }
    const offer: OfferDoc = { ...current, status: "expired", updatedAt: now };
    const message: MessageDoc = messageSchema.parse({
      senderUid: conversation.buyerUid,
      participants: conversation.participants,
      ...(conversation.sellerProId ? { sellerProId: conversation.sellerProId } : {}),
      type: "system",
      text: offerMarker("expired"),
      offer: { id: offer.id, event: "expired", amount: offerFinalAmount(offer) },
      createdAt: now,
    });
    tx.set(messageRef, datesToTimestamps(message) as Record<string, unknown>);
    tx.update(conversationRef(cid), {
      offer: datesToTimestamps(offer) as Record<string, unknown>,
      offerExpiresAt: FieldValue.delete(),
      messageCount: FieldValue.increment(1),
    });
    return { conversation, offer };
  });
  void consume("firestore.reads", 1);
  if (!outcome) return null;
  if ("cleared" in outcome) {
    void consume("firestore.writes", 1);
    return null;
  }
  void consume("firestore.writes", 2);
  return { ...outcome, messageId: messageRef.id };
}
