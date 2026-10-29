import "server-only";
import { REVIEWS_PAGE } from "@/config/reviews";
import { requireUser } from "@/lib/auth/guards";
import { publicIdSchema } from "@/lib/db/schemas";
import { reviewIdSchema, reviewInputSchema, reviewReplySchema } from "@/lib/contracts/review-schemas";
import type { MyReviews, MyReviewView, ReviewCreated } from "@/lib/contracts/reviews";
import { findUserByPublicId } from "@/lib/db/repositories/profiles";
import { HttpError, forbidden, notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json, noContent } from "@/lib/http/route";
import { isVisibleAccount } from "@/lib/listings/public";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { logger } from "@/lib/logging/logger";
import { screenFreeText } from "@/lib/moderation/free-text";
import { detectSensitive } from "@/lib/moderation/sensitive";
import { assertQuotas, PUBLIC_READ_QUOTAS } from "@/lib/quota/gate";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import {
  ReviewError,
  createReview,
  deleteReview,
  getReview,
  listAuthoredReviews,
  listPublishedReviews,
  replyToReview,
  type ReviewRecord,
} from "./repository";
import { notifyReviewPublished } from "./notify";
import { sellerReviews } from "./seller";
import { decodeReviewCursor, reviewView } from "./views";

// Route handlers of /api/reviews/** and /api/account/reviews (vitrine-avis §2). Writing: a member
// (not suspended), Origin + CSRF, the limiter, the text screen, then one transaction. The public
// list answers published reviews only, never a uid, a conversation or the author's profile.

type Params = Promise<Record<string, string | string[] | undefined>>;

/** "Mes avis" reads at most this many of each side. */
const MINE_LIMIT = 50;

function reviewErrorToHttp(error: unknown): never {
  if (!(error instanceof ReviewError)) throw error;
  switch (error.reason) {
    case "missing":
      throw notFound();
    case "not_allowed":
      throw forbidden("review not allowed");
    case "exists":
      throw new HttpError(409, "review_unavailable", "already reviewed", { details: { state: "done" } });
    case "window": {
      const window = error.window;
      throw new HttpError(409, "review_unavailable", "review window not open", { details: { state: window?.state ?? "closed", ...(window?.state === "too_early" ? { opensAt: window.opensAt } : {}) } });
    }
    case "state":
      throw new HttpError(409, "conflict", "review hidden by moderation");
  }
}

/**
 * A review held for sensitive data goes to the moderators' queue as a system report (P1): "no
 * action" publishes it, "remove" hides it, with the statement of reasons and the appeal of any
 * decision. The categories only, never the text, are written in the report.
 */
async function holdForModerator(review: ReviewRecord): Promise<void> {
  try {
    const { createSystemReport } = await import("@/lib/reports");
    const categories = detectSensitive(review.text);
    await createSystemReport({
      target: { type: "review", id: review.id },
      reasonId: "personal_data",
      explanation: `Avis retenu avant publication : donnée sensible possible (${categories.join(", ") || "à vérifier"}). « Aucune mesure » le publie, « Avis masqué » le refuse.`,
      source: "system",
    });
  } catch (error) {
    logger.error({ reviewId: review.id, err: (error as Error).message }, "reviews: held review not queued for a moderator");
  }
}

async function reviewIdOf(params: Params): Promise<string> {
  const { id } = await params;
  const parsed = reviewIdSchema.safeParse(id);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

/** The text screen of a review or a reply: contact details and hard prohibited words refused. */
function screened(text: string, field: "text"): { sensitive: boolean } {
  const screen = screenFreeText(text);
  const issue = screen.blockers[0];
  if (issue) throw new HttpError(422, "invalid_text", "review text refused by the screen", { details: { field, issue } });
  return { sensitive: screen.sensitive };
}

/** POST /api/reviews. */
export async function handleCreateReview(request: Request): Promise<Response> {
  const { user } = await requireUser(request, { mutation: true });
  const input = await readJson(request, reviewInputSchema);
  await enforceLimit("review.create.uid", user.uid);
  // Sensitive data (Russmedia): held for a moderator instead of refused.
  const { sensitive } = screened(input.text, "text");
  const review = await createReview({ cid: input.cid, authorUid: user.uid, rating: input.rating, text: input.text, status: sensitive ? "pending" : "published", now: new Date() }).catch(reviewErrorToHttp);
  if (review.status === "published") {
    revalidateListingPaths({ publicId: review.targetPublicId });
    await notifyReviewPublished(review, { held: false });
  } else await holdForModerator(review);
  const body: ReviewCreated = { id: review.id, status: review.status === "published" ? "published" : "pending" };
  return json(body, { status: 201 });
}

/** DELETE /api/reviews/{id}: the author only. */
export async function handleDeleteReview(request: Request, params: Params): Promise<Response> {
  const { user } = await requireUser(request, { mutation: true, allowSuspended: true });
  const id = await reviewIdOf(params);
  await enforceLimit("review.mutation.uid", user.uid);
  const review = await getReview(id);
  await deleteReview(id, user.uid, new Date()).catch(reviewErrorToHttp);
  if (review) revalidateListingPaths({ publicId: review.targetPublicId });
  return noContent();
}

/** POST /api/reviews/{id}/reply: the reviewed seller, once. A reply holding sensitive data is refused. */
export async function handleReplyReview(request: Request, params: Params): Promise<Response> {
  const { user } = await requireUser(request, { mutation: true });
  const id = await reviewIdOf(params);
  const input = await readJson(request, reviewReplySchema);
  await enforceLimit("review.mutation.uid", user.uid);
  if (screened(input.text, "text").sensitive) throw new HttpError(422, "invalid_text", "reply holds sensitive data", { details: { field: "text", issue: "sensitive" } });
  const review = await replyToReview(id, user.uid, input.text, new Date()).catch(reviewErrorToHttp);
  revalidateListingPaths({ publicId: review.targetPublicId });
  return json(reviewView(review));
}

/** GET /api/reviews?vendeur={publicId}&apres={cursor}: public. */
export async function handleListReviews(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const publicId = publicIdSchema.safeParse(url.searchParams.get("vendeur"));
  if (!publicId.success) throw notFound();
  const cursorValue = url.searchParams.get("apres");
  const after = cursorValue ? decodeReviewCursor(cursorValue) : undefined;
  if (after === null) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "apres", code: "invalid_value" }] });
  await enforceLimit("review.read.ip", requestIdentity(request.headers).ipBucket);
  await assertQuotas(PUBLIC_READ_QUOTAS);
  const seller = await findUserByPublicId(publicId.data);
  if (!seller || !isVisibleAccount(seller)) throw notFound();
  return json(await sellerReviews(seller.uid, REVIEWS_PAGE, after));
}

function mineView(review: ReviewRecord, side: "given" | "received"): MyReviewView {
  return {
    ...reviewView(review),
    status: review.status === "deleted" ? "hidden" : review.status,
    counterpartName: side === "given" ? review.targetName : review.authorName,
    canReply: side === "received" && review.status === "published" && !review.reply,
    canDelete: side === "given" && review.status !== "hidden",
  };
}

/** GET /api/account/reviews?sens=recus|donnes: the member's own reviews. */
export async function handleMyReviews(request: Request): Promise<Response> {
  const { user } = await requireUser(request, { allowSuspended: true });
  const side = new URL(request.url).searchParams.get("sens") === "donnes" ? "given" : "received";
  await enforceLimit("review.mine.uid", user.uid);
  const records = side === "given" ? await listAuthoredReviews(user.uid, MINE_LIMIT) : await listPublishedReviews(user.uid, MINE_LIMIT);
  const body: MyReviews = { reviews: records.map((review) => mineView(review, side)) };
  return json(body);
}
