import { describe, expect, it, vi } from "vitest";
import { reviewInvited } from "@/components/reviews/review-prompt";
import { textLength } from "@/components/reviews/review-dialog";
import { REVIEW_OPEN_DELAY_MS, REVIEW_WINDOW_MS } from "@/config/reviews";
import { reviewInputSchema } from "@/lib/contracts/review-schemas";
import { reviewWindow } from "@/lib/contracts/reviews";
import type { ConversationView } from "@/lib/contracts/messaging";
import { screenFreeText } from "@/lib/moderation/free-text";

// Verified reviews (vitrine-avis §2-3): the buyer's window, the body, the thread's invitation, the
// aggregates and the storefront cursor.

vi.mock("server-only", () => ({}));
const { decodeReviewCursor, encodeReviewCursor, ratingSummary } = await import("@/lib/reviews/views");

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 10);

describe("reviewWindow", () => {
  it("needs the seller's reply, opens 24 h after it and closes 60 days after the last message", () => {
    expect(reviewWindow({ sellerRepliedAt: null, lastActivityAt: T0, reviewedAt: null }, T0 + 5 * DAY)).toEqual({ state: "no_reply" });
    expect(reviewWindow({ sellerRepliedAt: T0, lastActivityAt: T0, reviewedAt: null }, T0 + 1000)).toEqual({ state: "too_early", opensAt: T0 + REVIEW_OPEN_DELAY_MS });
    expect(reviewWindow({ sellerRepliedAt: T0, lastActivityAt: T0 + 3 * DAY, reviewedAt: null }, T0 + 2 * DAY)).toEqual({ state: "open", closesAt: T0 + 3 * DAY + REVIEW_WINDOW_MS });
    expect(reviewWindow({ sellerRepliedAt: T0, lastActivityAt: T0, reviewedAt: null }, T0 + REVIEW_WINDOW_MS)).toEqual({ state: "closed" });
    expect(reviewWindow({ sellerRepliedAt: T0, lastActivityAt: T0, reviewedAt: T0 + DAY }, T0 + 2 * DAY)).toEqual({ state: "done" });
  });

  it("is never open before it opens, even when the last message is old", () => {
    // A seller reply with an older last-activity field (clock skew): the window still waits 24 h.
    expect(reviewWindow({ sellerRepliedAt: T0, lastActivityAt: T0 - DAY, reviewedAt: null }, T0 + DAY / 2).state).toBe("too_early");
  });
});

describe("review body", () => {
  const base = { cid: "a".repeat(22), rating: 4, text: "Échange rapide, article conforme à la description.", exchangeConfirmed: true };

  it("needs the author's statement, a note from 1 to 5 and 20 to 1 000 characters", () => {
    expect(reviewInputSchema.parse({ ...base, text: `  ${base.text}  ` }).text).toBe(base.text);
    expect(reviewInputSchema.safeParse({ ...base, exchangeConfirmed: false }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ ...base, rating: 0 }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ ...base, rating: 4.5 }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ ...base, text: "Très bien merci" }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ ...base, text: "x".repeat(1001) }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ ...base, listingId: "x" }).success).toBe(false);
  });

  it("counts characters as the person sees them", () => {
    expect(textLength("  مرحبا  ")).toBe(5);
    expect(textLength("👍🏽 ok")).toBe(5);
  });

  it("holds sensitive data for a moderator rather than refusing it", () => {
    const screen = screenFreeText("Rencontre agréable, ma femme est diabétique et le vendeur a porté le colis jusqu'à la voiture.");
    expect(screen).toEqual({ blockers: [], sensitive: true });
  });
});

describe("thread invitation", () => {
  const conversation = (overrides: Partial<ConversationView> = {}): ConversationView =>
    ({
      cid: "c".repeat(22),
      role: "buyer",
      frozen: false,
      blockedByMe: false,
      blockedMe: false,
      counterpartClosed: false,
      lastMessage: { preview: "", mine: false, at: T0, flagged: false },
      review: { sellerRepliedAt: T0, reviewedAt: null },
      ...overrides,
    }) as ConversationView;

  it("asks the buyer only, while the window is open and the conversation is writable", () => {
    expect(reviewInvited(conversation(), T0 + 2 * DAY)).toBe(true);
    expect(reviewInvited(conversation(), T0 + DAY / 2)).toBe(false);
    expect(reviewInvited(conversation({ role: "seller" }), T0 + 2 * DAY)).toBe(false);
    expect(reviewInvited(conversation({ blockedMe: true }), T0 + 2 * DAY)).toBe(false);
    expect(reviewInvited(conversation({ frozen: true }), T0 + 2 * DAY)).toBe(false);
    expect(reviewInvited(conversation({ counterpartClosed: true }), T0 + 2 * DAY)).toBe(false);
    expect(reviewInvited(conversation({ review: { sellerRepliedAt: T0, reviewedAt: T0 + DAY } }), T0 + 2 * DAY)).toBe(false);
  });
});

describe("rating summary and cursor", () => {
  it("averages from the stored sum to one decimal, none without reviews", () => {
    expect(ratingSummary({ activeListings: 0, responseRate: 0, medianReplyMin: 0, ratingCount: 0 })).toEqual({ count: 0, average: null, histogram: [0, 0, 0, 0, 0] });
    expect(ratingSummary({ activeListings: 0, responseRate: 0, medianReplyMin: 0, ratingCount: 3, ratingSum: 13, ratingAvg: 4.33, ratingHistogram: [0, 0, 0, 2, 1] })).toEqual({
      count: 3,
      average: 4.3,
      histogram: [0, 0, 0, 2, 1],
    });
  });

  it("round-trips the position and refuses anything else", () => {
    const position = { at: new Date(T0), id: "A".repeat(22) };
    expect(decodeReviewCursor(encodeReviewCursor(position))).toEqual(position);
    expect(decodeReviewCursor("not a cursor!")).toBeNull();
    expect(decodeReviewCursor(Buffer.from("12.short").toString("base64url"))).toBeNull();
    expect(decodeReviewCursor(Buffer.from(`x.${"A".repeat(22)}`).toString("base64url"))).toBeNull();
  });
});

describe("ratingStatsOf", async () => {
  const { ratingStatsOf } = await import("@/lib/reviews/repository");
  const snapshot = (stats: unknown) => ({ get: (field: string) => (field === "stats" ? stats : undefined) }) as unknown as Parameters<typeof ratingStatsOf>[0];

  it("keeps the ratings when another stats counter is out of range (staging, 28 Oct)", () => {
    const stats = { activeListings: -1, responseRate: 0.9, medianReplyMin: 12, ratingCount: 40, ratingSum: 184, ratingAvg: 4.6, ratingHistogram: [0, 1, 2, 9, 28] };
    expect(ratingStatsOf(snapshot(stats))).toEqual({ ratingCount: 40, ratingSum: 184, ratingHistogram: [0, 1, 2, 9, 28] });
  });

  it("starts at zero before the first review and reads a negative counter as zero", () => {
    expect(ratingStatsOf(snapshot(undefined))).toEqual({ ratingCount: 0, ratingSum: 0, ratingHistogram: [0, 0, 0, 0, 0] });
    expect(ratingStatsOf(snapshot({ ratingCount: -2, ratingHistogram: [1, -1, 0, 0, 0] }))).toEqual({ ratingCount: 0, ratingSum: 0, ratingHistogram: [1, 0, 0, 0, 0] });
  });

  it("derives the sum from the average for an account from before ratingSum", () => {
    expect(ratingStatsOf(snapshot({ ratingCount: 4, ratingAvg: 4.5 })).ratingSum).toBe(18);
  });
});
