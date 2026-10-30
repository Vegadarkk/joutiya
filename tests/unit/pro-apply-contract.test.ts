import { describe, expect, it } from "vitest";
import { proApplySchema } from "@/lib/contracts/pro";

// POST /api/pro/apply body (phase 7 design §4): strict, commitment ticked, 1 to 6 pieces.

const base = {
  name: "Atlas Auto",
  regionCode: "06",
  citySlug: "casablanca",
  legal: { form: "auto_entrepreneur", ice: "001 234 567 000 089", aeNumber: "998877" },
  uploadIds: ["up1"],
  complianceCommitment: true,
  turnstileToken: "token",
};

describe("proApplySchema", () => {
  it("accepts a complete application and defaults the description", () => {
    const parsed = proApplySchema.parse(base);
    expect(parsed.description).toBe("");
    expect(parsed.legal.ice).toBe("001234567000089");
  });

  it("requires the compliance commitment and at least one piece", () => {
    expect(proApplySchema.safeParse({ ...base, complianceCommitment: false }).success).toBe(false);
    expect(proApplySchema.safeParse({ ...base, uploadIds: [] }).success).toBe(false);
    expect(proApplySchema.safeParse({ ...base, uploadIds: Array.from({ length: 7 }, (_, i) => `u${i}`) }).success).toBe(false);
  });

  it("takes the activity: a general shop by default, an agency with its commitments", () => {
    expect(proApplySchema.parse(base).sector).toBe("general");
    expect(proApplySchema.parse({ ...base, sector: "real_estate", sectorCommitment: true })).toMatchObject({ sector: "real_estate", sectorCommitment: true });
    // The server refuses an agency without its commitments (src/lib/pro/service.ts); the schema only knows the sectors.
    expect(proApplySchema.safeParse({ ...base, sector: "dealer" }).success).toBe(false);
    expect(proApplySchema.safeParse({ ...base, sectorCommitment: false }).success).toBe(false);
  });

  it("refuses unknown fields and a missing Turnstile token", () => {
    expect(proApplySchema.safeParse({ ...base, role: "pro" }).success).toBe(false);
    const { turnstileToken: _omit, ...withoutToken } = base;
    expect(proApplySchema.safeParse(withoutToken).success).toBe(false);
  });
});
