import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { publishEvents } from "@/lib/messaging/events";
import { listDueOffers, recordExpiry, type RecordedExpiry } from "@/lib/offers/expiry";
import { isDegraded } from "@/lib/quota";

// Every 10 minutes (Carte vivante lot 5): offers and counter-offers left 48 h without an answer
// become "expired", with a step in the thread (live event to both participants, no unread count,
// no mail: the readers already show it expired). At most EXPIRY_BATCH a run. Stops while the
// Firestore quotas are degraded (the readers keep showing the expiry meanwhile).

export interface OfferExpiryResult {
  due: number;
  expired: number;
  /** Answered meanwhile, or taken by another run. */
  skipped: number;
  failed: number;
  stopped?: "quota";
}

const STOP_QUOTAS = ["firestore.writes", "firestore.reads"] as const;

export async function expireOffers(now = new Date()): Promise<OfferExpiryResult> {
  const result: OfferExpiryResult = { due: 0, expired: 0, skipped: 0, failed: 0 };
  if (!isFirestoreConfigured()) {
    logger.warn("offer-expiry skipped: Firebase not configured");
    return result;
  }
  for (const id of STOP_QUOTAS) {
    if (!(await isDegraded(id))) continue;
    logger.info({ quota: id }, "offer-expiry skipped: quota degraded");
    return { ...result, stopped: "quota" };
  }
  const due = await listDueOffers(now);
  result.due = due.length;
  for (const cid of due) {
    let expiry: RecordedExpiry | null;
    try {
      expiry = await recordExpiry(cid, now);
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "offer expiry failed");
      result.failed += 1;
      continue;
    }
    if (!expiry) {
      result.skipped += 1;
      continue;
    }
    result.expired += 1;
    const at = now.getTime();
    await publishEvents(expiry.conversation.participants.map((uid) => ({ uid, event: { type: "message", cid, mid: expiry.messageId, at } })));
  }
  logger.info({ ...result }, "offer-expiry");
  return result;
}
