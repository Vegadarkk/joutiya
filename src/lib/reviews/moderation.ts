import "server-only";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { logger } from "@/lib/logging/logger";
import { notifyReviewPublished } from "./notify";
import { setReviewStatus, type ReviewRecord } from "./repository";

// Moderation of a review (vitrine-avis §3): the reports and decisions lots hide a review (strong
// signal, "remove" decision) or publish it (restore, no_action on a held review). The seller's
// aggregates follow in the same transaction; the storefront is revalidated after it. A held review
// published for the first time mails the seller and its author.

/** Publishes (visible) or hides a review. True when its status changed; a deleted review stays deleted. */
export async function setReviewVisibility(id: string, visible: boolean, now: Date, hiddenBy?: string): Promise<boolean> {
  const before = await setReviewStatus(id, visible ? "published" : "hidden", now, hiddenBy);
  const changed = changedBy(before, visible);
  if (changed && before) revalidateListingPaths({ publicId: before.targetPublicId });
  if (changed) logger.info({ reviewId: id, status: visible ? "published" : "hidden" }, "reviews: moderation status changed");
  if (changed && visible && before?.status === "pending") await notifyReviewPublished(before, { held: true });
  return changed;
}

function changedBy(before: ReviewRecord | null, visible: boolean): boolean {
  if (!before || before.status === "deleted") return false;
  return visible ? before.status !== "published" : before.status !== "hidden";
}
