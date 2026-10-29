import "server-only";
import { getUserRecord } from "@/lib/db/repositories/profiles";
import { getUserPrivate } from "@/lib/db/repositories/users";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import type { ReviewRecord } from "./repository";

// Mails of a review going public (vitrine-avis §2-3), best effort: a mail that fails is logged,
// never undoes the review. The seller hears of each published review (bulk, off with the messaging
// preference, like the appointment reminders); the author of a held review hears when a moderator
// publishes it. A closed, banned or address-less account gets nothing.

async function recipient(uid: string) {
  const [user, account] = await Promise.all([getUserRecord(uid), getUserPrivate(uid)]);
  if (!user || !account?.email || user.status === "closed" || user.status === "banned") return null;
  return { user, account };
}

/** A review is public for the first time: to the seller, and to its author when a moderator published it. */
export async function notifyReviewPublished(review: ReviewRecord, { held }: { held: boolean }): Promise<void> {
  try {
    const seller = await recipient(review.targetUid);
    if (seller && seller.account.notifications?.messagesEmail !== false) {
      await sendMail({
        template: "reviewReceived",
        locale: seller.user.locale,
        to: seller.account.email!,
        priority: "bulk",
        idempotencyKey: `review-received-${review.id}`,
        data: { displayName: seller.user.displayName, authorName: review.authorName, rating: review.rating, listingTitle: review.listingTitle },
      });
    }
    if (!held) return;
    const author = await recipient(review.authorUid);
    if (author) {
      await sendMail({
        template: "reviewPublished",
        locale: author.user.locale,
        to: author.account.email!,
        idempotencyKey: `review-published-${review.id}`,
        data: { displayName: author.user.displayName, sellerName: review.targetName, sellerPublicId: review.targetPublicId },
      });
    }
  } catch (error) {
    logger.error({ reviewId: review.id, err: (error as Error).message }, "reviews: publication mail not sent");
  }
}
