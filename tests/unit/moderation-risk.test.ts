import { describe, expect, it } from "vitest";
import { DEFAULT_AI } from "@/config/ai";
import { MODERATION_FLAGS, type ModerationFlag } from "@/lib/contracts/listings";
import { ALWAYS_REVIEW_FLAGS, FACE_REVIEW_CATEGORIES, PREVIOUS_REJECTION_CAP, RISK_WEIGHTS, decideState, riskScore, sortFlags } from "@/lib/moderation/risk";

describe("risk table", () => {
  it("weights every moderation flag with a reason, hard keywords and nudity the heaviest", () => {
    for (const flag of MODERATION_FLAGS) {
      expect(RISK_WEIGHTS[flag].weight).toBeGreaterThan(0);
      expect(RISK_WEIGHTS[flag].weight).toBeLessThanOrEqual(100);
      expect(RISK_WEIGHTS[flag].reason).not.toBe("");
    }
    expect(RISK_WEIGHTS.prohibited_kw.weight).toBeGreaterThanOrEqual(DEFAULT_AI.risk.reviewAt);
    expect(RISK_WEIGHTS.nsfw_review.weight).toBeGreaterThan(RISK_WEIGHTS.face.weight);
    for (const flag of ALWAYS_REVIEW_FLAGS) expect(MODERATION_FLAGS).toContain(flag);
    expect(ALWAYS_REVIEW_FLAGS.has("face")).toBe(false);
    expect(FACE_REVIEW_CATEGORIES.has("famille")).toBe(true);
  });
});

describe("riskScore", () => {
  it("sums the weights of unique flags, in a stable order, capped at 100", () => {
    expect(riskScore([])).toEqual({ score: 0, terms: [] });
    expect(riskScore(["new_account", "new_account"]).score).toBe(RISK_WEIGHTS.new_account.weight);
    const weak = riskScore(["volume", "new_account", "price_outlier"]);
    expect(weak.score).toBe(50);
    expect(weak.terms.map((term) => term.points)).toEqual([20, 15, 15]);
    expect(riskScore(MODERATION_FLAGS).score).toBe(100);
  });

  it("adds previous rejections, 10 each, capped", () => {
    expect(riskScore([], { previousRejections: 1 }).score).toBe(10);
    expect(riskScore([], { previousRejections: 7 }).score).toBe(PREVIOUS_REJECTION_CAP);
    expect(riskScore([], { previousRejections: -3 }).score).toBe(0);
    expect(riskScore(["dup_text"], { previousRejections: 3 }).terms.at(-1)).toEqual({ reason: "3 previous rejection(s)", points: 30 });
  });
});

describe("decideState", () => {
  const reviewAt = DEFAULT_AI.risk.reviewAt;

  it("reviews at the threshold, publishes below it", () => {
    expect(decideState(0, [], { reviewAt })).toBe("auto_ok");
    expect(decideState(reviewAt - 1, ["new_account"], { reviewAt })).toBe("auto_ok");
    expect(decideState(reviewAt, ["dup_text", "dup_photo"], { reviewAt })).toBe("needs_review");
    expect(decideState(100, [], { reviewAt })).toBe("needs_review");
  });

  it("always reviews the legal and strong signals whatever the score", () => {
    for (const flag of ["prohibited_soft", "sensitive_text", "third_party_phone", "nsfw_review", "prohibited_kw"] as ModerationFlag[]) {
      expect(decideState(0, [flag], { reviewAt }), flag).toBe("needs_review");
    }
    expect(decideState(0, ["price_outlier"], { reviewAt })).toBe("auto_ok");
    expect(decideState(0, ["price_outlier"], { reviewAt, alwaysReview: new Set<ModerationFlag>(["price_outlier"]) })).toBe("needs_review");
  });

  it("reviews a face only in a sensitive category", () => {
    expect(decideState(15, ["face"], { reviewAt, categoryId: "vehicules" })).toBe("auto_ok");
    expect(decideState(15, ["face"], { reviewAt, categoryId: "famille" })).toBe("needs_review");
    expect(decideState(15, ["face"], { reviewAt })).toBe("auto_ok");
  });
});

describe("sortFlags", () => {
  it("returns unique flags in the contract order", () => {
    expect(sortFlags(["volume", "face", "face", "prohibited_soft"])).toEqual(["prohibited_soft", "face", "volume"]);
  });
});
