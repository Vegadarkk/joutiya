import { apiDelete, apiGet, apiPost } from "@/lib/auth/client";
import { REVIEWS_API, type MyReviews, type ReviewCreated, type ReviewInput, type ReviewPage, type ReviewView } from "@/lib/contracts/reviews";

// Browser side of the reviews API (vitrine-avis §2): same-origin JSON with the CSRF header.

export function submitReview(input: ReviewInput): Promise<ReviewCreated> {
  return apiPost<ReviewCreated>(REVIEWS_API.create, input);
}

export function removeReview(id: string): Promise<void> {
  return apiDelete(REVIEWS_API.item(id));
}

export function replyReview(id: string, text: string): Promise<ReviewView> {
  return apiPost<ReviewView>(REVIEWS_API.reply(id), { text });
}

/** The next page of a seller's published reviews (the storefront's "more" button). */
export function fetchSellerReviews(publicId: string, after: string): Promise<ReviewPage> {
  const query = new URLSearchParams({ vendeur: publicId, apres: after });
  return apiGet<ReviewPage>(`${REVIEWS_API.list}?${query.toString()}`);
}

export function fetchMyReviews(side: "recus" | "donnes"): Promise<MyReviews> {
  return apiGet<MyReviews>(`${REVIEWS_API.mine}?sens=${side}`);
}
