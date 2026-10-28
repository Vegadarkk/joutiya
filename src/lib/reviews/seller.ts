import "server-only";
import type { ReviewPage } from "@/lib/contracts/reviews";
import { listPublishedReviews, type ReviewPosition } from "./repository";
import { encodeReviewCursor, reviewView } from "./views";

/** Published reviews of a seller page by page, newest first (the storefront and GET /api/reviews). */
export async function sellerReviews(targetUid: string, limit: number, after?: ReviewPosition): Promise<ReviewPage> {
  const records = await listPublishedReviews(targetUid, limit + 1, after);
  const page = records.slice(0, limit);
  const last = page[page.length - 1];
  return { reviews: page.map(reviewView), next: records.length > limit && last ? encodeReviewCursor({ at: last.createdAt, id: last.id }) : null };
}
