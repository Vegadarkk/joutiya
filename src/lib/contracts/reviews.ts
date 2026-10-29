import { REVIEW_OPEN_DELAY_MS, REVIEW_WINDOW_MS } from "@/config/reviews";

// Verified reviews (vitrine-avis §2), shared by the browser and the route handlers. A review is
// written from a conversation by its buyer and shown on the seller's storefront. No zod here: the
// storefront's "more" button and the thread banner import it (schemas in review-schemas.ts).

export const REVIEWS_API = {
  /** GET ?vendeur={publicId}&apres={cursor} -> ReviewPage (public, rate limited). */
  list: "/api/reviews",
  /** POST ReviewInput -> ReviewCreated. */
  create: "/api/reviews",
  /** DELETE: the author removes the review. */
  item: (id: string) => `/api/reviews/${id}`,
  /** POST { text }: the seller's one public reply. */
  reply: (id: string) => `/api/reviews/${id}/reply`,
  /** GET ?sens=recus|donnes -> MyReviews. */
  mine: "/api/account/reviews",
} as const;

/** Where a buyer stands with the review of a conversation. */
export type ReviewWindow =
  | { state: "open"; closesAt: number }
  | { state: "too_early"; opensAt: number }
  /** The seller never answered: no reciprocal exchange. */
  | { state: "no_reply" }
  | { state: "closed" }
  | { state: "done" };

/**
 * The review window of a conversation for its buyer (pure, client and server): opens 24 h after
 * the seller's first reply, closes 60 days after the last message, once per conversation.
 */
export function reviewWindow(input: { sellerRepliedAt: number | null; lastActivityAt: number; reviewedAt: number | null }, now: number): ReviewWindow {
  if (input.reviewedAt !== null) return { state: "done" };
  if (input.sellerRepliedAt === null) return { state: "no_reply" };
  const opensAt = input.sellerRepliedAt + REVIEW_OPEN_DELAY_MS;
  const closesAt = Math.max(input.lastActivityAt, input.sellerRepliedAt) + REVIEW_WINDOW_MS;
  if (now >= closesAt) return { state: "closed" };
  if (now < opensAt) return { state: "too_early", opensAt };
  return { state: "open", closesAt };
}

/** A published review as the storefront shows it: no uid, no conversation, no author link. */
export interface ReviewView {
  id: string;
  rating: number;
  text: string;
  authorName: string;
  listingTitle: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms: the date of the exchange (the seller's first reply). */
  experienceAt: number;
  reply: { text: string; at: number } | null;
}

export interface RatingSummary {
  count: number;
  /** One decimal, null without reviews. */
  average: number | null;
  /** Counts of 1 to 5 stars, index 0 = 1 star. */
  histogram: [number, number, number, number, number];
}

export interface ReviewPage {
  reviews: ReviewView[];
  next: string | null;
}

/** POST /api/reviews body. */
export interface ReviewInput {
  cid: string;
  rating: number;
  text: string;
  /** "Nous avons conclu un échange ou une rencontre": the author's own statement. */
  exchangeConfirmed: true;
}

export interface ReviewCreated {
  id: string;
  /** "pending": held for a moderator (sensitive data), published once checked. */
  status: "published" | "pending";
  /** The buyer's earlier review of this seller (another conversation) was replaced: one per seller. */
  replaced: boolean;
}

/** "Mes avis": a review the member wrote or received, with its state. */
export interface MyReviewView extends ReviewView {
  status: "published" | "pending" | "hidden";
  /** The other member's display name (the seller for a given review, the buyer for a received one). */
  counterpartName: string;
  /** Received and published without a reply yet: the seller may answer. */
  canReply: boolean;
  /** Given and not hidden: the author may delete it. */
  canDelete: boolean;
}

export interface MyReviews {
  reviews: MyReviewView[];
}
