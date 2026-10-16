import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING } from "@/config/pricing";
import { proProfileSchema, type ProProfileDoc } from "@/lib/pro/profile-schema";

// proProfiles/{proId} document shape (architecture §5): strict, normalised legal identifiers,
// https-only website, bounded pieces.

const NOW = new Date("2026-10-16T10:00:00.000Z");

function profile(extra: Partial<ProProfileDoc> = {}): ProProfileDoc {
  return {
    ownerUid: "uid-owner",
    members: { "uid-owner": "owner" },
    name: "Atlas Auto",
    slug: "atlas-auto-casablanca",
    description: "Voitures d'occasion contrôlées.",
    whatsapp: false,
    regionCode: "06",
    citySlug: "casablanca",
    legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
    kybc: { status: "submitted", iceFormatOk: true, uploadIds: ["up1"], submittedAt: NOW, complianceCommitmentAt: NOW },
    lifecycle: "pending_verification",
    plan: "none",
    planSource: "none",
    quotas: DEFAULT_PRICING.pro.none,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

describe("proProfileSchema", () => {
  it("accepts a pending application", () => {
    expect(proProfileSchema.safeParse(profile()).success).toBe(true);
  });

  it("normalises the ICE typed with spaces", () => {
    const parsed = proProfileSchema.parse(profile({ legal: { form: "auto_entrepreneur", ice: "001 234 567 000 089", aeNumber: "998877" } }));
    expect(parsed.legal).toEqual({ form: "auto_entrepreneur", ice: "001234567000089", aeNumber: "998877" });
  });

  it("rejects unknown fields, http websites, bad slugs and too many pieces", () => {
    expect(proProfileSchema.safeParse({ ...profile(), extra: 1 }).success).toBe(false);
    expect(proProfileSchema.safeParse(profile({ website: "http://atlas.ma" })).success).toBe(false);
    expect(proProfileSchema.safeParse(profile({ website: "https://atlas.ma" })).success).toBe(true);
    expect(proProfileSchema.safeParse(profile({ slug: "Atlas Auto" })).success).toBe(false);
    expect(proProfileSchema.safeParse(profile({ kybc: { status: "submitted", iceFormatOk: true, uploadIds: Array.from({ length: 7 }, (_, i) => `u${i}`) } })).success).toBe(false);
  });

  it("carries the launch offer plan source", () => {
    expect(proProfileSchema.safeParse(profile({ lifecycle: "verified", plan: "essentiel", planSource: "launch_offer", quotas: DEFAULT_PRICING.pro.essentiel })).success).toBe(true);
    expect(proProfileSchema.safeParse(profile({ planSource: "free" as never })).success).toBe(false);
  });
});
