import { describe, expect, it } from "vitest";
import { subcategoryAllowsAds } from "@/config/categories";
import { adsEligibleOf } from "@/lib/reports/visibility";

// adsEligible (§5) is never true on an adults-only subcategory (decorative koumiyas: Google's
// weapons and knives policy), whatever the listing's state.

const moderation = { state: "auto_ok", openReports: 0, flags: [], score: 0 } as never;

describe("ads eligibility", () => {
  it("excludes adults-only subcategories only", () => {
    expect(subcategoryAllowsAds("koumiyas-decoratives")).toBe(false);
    expect(subcategoryAllowsAds("voitures")).toBe(true);
    expect(subcategoryAllowsAds(undefined)).toBe(true);
  });

  it("keeps a published, unreported koumiya out of the ads", () => {
    expect(adsEligibleOf({ status: "published", moderation, subcategoryId: "koumiyas-decoratives" })).toBe(false);
    expect(adsEligibleOf({ status: "published", moderation, subcategoryId: "voitures" })).toBe(true);
    expect(adsEligibleOf({ status: "paused", moderation, subcategoryId: "voitures" })).toBe(false);
  });
});
