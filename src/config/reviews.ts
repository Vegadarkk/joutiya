// Verified reviews (vitrine-avis §2, owner's choices of 28 Oct 2026): only the buyer of a
// conversation rates the seller, after a reciprocal exchange, from 24 h after the seller's first
// reply until 60 days after the last message, one review per conversation.

export const REVIEW_STATUSES = ["published", "pending", "hidden", "deleted"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** The review opens this long after the seller's first reply: time to meet. */
export const REVIEW_OPEN_DELAY_MS = 24 * 60 * 60 * 1000;
/** It closes this long after the conversation's last message. */
export const REVIEW_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export const REVIEW_TEXT_MIN = 20;
export const REVIEW_TEXT_MAX = 1000;
export const REVIEW_REPLY_MAX = 1000;

/** Reviews per page on a storefront and in "Mes avis". */
export const REVIEWS_PAGE = 10;

/** A deleted or hidden review is purged this long after (legal hold aside). */
export const REVIEW_PURGE_MONTHS = 12;
