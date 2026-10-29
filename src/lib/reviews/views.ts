import type { RatingSummary, ReviewView } from "@/lib/contracts/reviews";
import { reviewIdSchema } from "@/lib/contracts/review-schemas";
import type { UserRecord } from "@/lib/db/repositories/profiles";
import type { ReviewPosition, ReviewRecord } from "./repository";

// What leaves the server of a review and of a seller's rating (vitrine-avis §2-3): no uid, no
// conversation, no author link. Shared by the route handlers and the storefront page.

export function reviewView(review: ReviewRecord): ReviewView {
  return {
    id: review.id,
    rating: review.rating,
    text: review.text,
    authorName: review.authorName,
    listingTitle: review.listingTitle,
    createdAt: review.createdAt.getTime(),
    experienceAt: review.experienceAt.getTime(),
    reply: review.reply ? { text: review.reply.text, at: review.reply.at.getTime() } : null,
  };
}

/** The seller's published ratings from `users.stats` (kept exact by the review transactions). */
export function ratingSummary(stats: UserRecord["stats"]): RatingSummary {
  const count = stats.ratingCount;
  const histogram = stats.ratingHistogram ? ([...stats.ratingHistogram] as RatingSummary["histogram"]) : ([0, 0, 0, 0, 0] as RatingSummary["histogram"]);
  if (count <= 0) return { count: 0, average: null, histogram };
  const sum = stats.ratingSum ?? (stats.ratingAvg ?? 0) * count;
  return { count, average: Math.round((sum / count) * 10) / 10, histogram };
}

/** base64url("{epoch ms}.{review id}"). */
export function encodeReviewCursor(position: ReviewPosition): string {
  return Buffer.from(`${position.at.getTime()}.${position.id}`, "utf8").toString("base64url");
}

export function decodeReviewCursor(value: string): ReviewPosition | null {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(value)) return null;
  const text = Buffer.from(value, "base64url").toString("utf8");
  const dot = text.indexOf(".");
  const ms = text.slice(0, dot);
  const id = text.slice(dot + 1);
  if (dot < 1 || !/^\d{1,15}$/.test(ms) || !reviewIdSchema.safeParse(id).success) return null;
  return { at: new Date(Number(ms)), id };
}
