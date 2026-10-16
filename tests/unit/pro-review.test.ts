import { describe, expect, it } from "vitest";
import { DEFAULT_PRICING } from "@/config/pricing";
import { proDecisionSchema } from "@/lib/contracts/pro";
import type { ProProfileRecord } from "@/lib/db/repositories/pro-profiles";
import { HttpError } from "@/lib/http/errors";
import { proProfileSchema } from "@/lib/pro/profile-schema";
import { retagWrite } from "@/lib/pro/retag";
import { decidedProfile } from "@/lib/pro/review";

// KYBC decision (phase 7 design §4): the profile after a moderator's verify or reject, and the
// listing patch of the retag effect.

const SUBMITTED = new Date("2026-10-16T09:00:00.000Z");
const NOW = new Date("2026-10-16T10:00:00.000Z");
const CTX = { staffUid: "uid-moderator", now: NOW, launchOfferActive: true, pricing: DEFAULT_PRICING };

function record(extra: Partial<ProProfileRecord> = {}): ProProfileRecord {
  return {
    proId: "abcdefgh",
    ownerUid: "uid-owner",
    members: { "uid-owner": "owner" },
    name: "Atlas Auto",
    slug: "atlas-auto-casablanca",
    description: "",
    whatsapp: false,
    regionCode: "06",
    citySlug: "casablanca",
    legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
    kybc: { status: "submitted", iceFormatOk: true, uploadIds: ["up1"], submittedAt: SUBMITTED, complianceCommitmentAt: SUBMITTED },
    lifecycle: "pending_verification",
    plan: "none",
    planSource: "none",
    quotas: DEFAULT_PRICING.pro.none,
    createdAt: SUBMITTED,
    updatedAt: SUBMITTED,
    ...extra,
  };
}

const verify = { action: "verify" as const, registrySource: "ompic" as const, submittedAt: SUBMITTED.toISOString() };
const reject = { action: "reject" as const, reason: "L'ICE ne correspond pas au registre.", submittedAt: SUBMITTED.toISOString() };

function conflict(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(409);
    return;
  }
  throw new Error("expected a 409");
}

describe("decidedProfile", () => {
  it("verifies with the launch offer: Essentiel quotas, registry check recorded", () => {
    const next = decidedProfile(record(), verify, CTX);
    expect(next).toMatchObject({ lifecycle: "verified", plan: "essentiel", planSource: "launch_offer", quotas: DEFAULT_PRICING.pro.essentiel, updatedAt: NOW });
    expect(next.kybc).toMatchObject({ status: "verified", registryCheck: { source: "ompic", at: NOW, by: "uid-moderator" } });
    expect(proProfileSchema.safeParse(next).success).toBe(true);
    expect(next).not.toHaveProperty("proId");
  });

  it("verifies without the launch offer: no plan, no quota", () => {
    const next = decidedProfile(record(), verify, { ...CTX, launchOfferActive: false });
    expect(next).toMatchObject({ lifecycle: "verified", plan: "none", planSource: "none", quotas: DEFAULT_PRICING.pro.none });
  });

  it("rejects with the moderator's reason and keeps the account on no plan", () => {
    const next = decidedProfile(record(), reject, CTX);
    expect(next).toMatchObject({ lifecycle: "rejected", plan: "none", planSource: "none" });
    expect(next.kybc).toMatchObject({ status: "rejected", rejectReason: reject.reason });
    expect(proProfileSchema.safeParse(next).success).toBe(true);
  });

  it("refuses a decided application or a resubmitted one (409)", () => {
    conflict(() => decidedProfile(record({ lifecycle: "verified", kybc: { ...record().kybc, status: "verified" } }), verify, CTX));
    conflict(() => decidedProfile(record({ lifecycle: "rejected", kybc: { ...record().kybc, status: "rejected" } }), reject, CTX));
    conflict(() => decidedProfile(record(), { ...verify, submittedAt: NOW.toISOString() }, CTX));
  });
});

describe("proDecisionSchema", () => {
  it("needs a specific reason to reject and a registry to verify", () => {
    expect(proDecisionSchema.safeParse(reject).success).toBe(true);
    expect(proDecisionSchema.safeParse({ ...reject, reason: "non" }).success).toBe(false);
    expect(proDecisionSchema.safeParse({ action: "verify", submittedAt: SUBMITTED.toISOString() }).success).toBe(false);
    expect(proDecisionSchema.safeParse({ ...verify, extra: true }).success).toBe(false);
  });
});

describe("retagWrite", () => {
  const listing = { ownerUid: "uid-owner", sellerType: "individual" as const, status: "published" as const, version: 3 };

  it("tags a published listing and reindexes it", () => {
    expect(retagWrite(listing, "uid-owner", "abcdefgh")).toEqual({ patch: { sellerType: "pro", proId: "abcdefgh", version: 4 }, search: "upsert" });
  });

  it("tags a draft without touching the index", () => {
    expect(retagWrite({ ...listing, status: "draft" }, "uid-owner", "abcdefgh")?.search).toBeNull();
  });

  it("skips a listing already tagged or owned by someone else", () => {
    expect(retagWrite({ ...listing, sellerType: "pro", proId: "abcdefgh" }, "uid-owner", "abcdefgh")).toBeNull();
    expect(retagWrite(listing, "uid-other", "abcdefgh")).toBeNull();
  });

  it("untags back to an individual listing", () => {
    expect(retagWrite({ ...listing, sellerType: "pro", proId: "abcdefgh" }, "uid-owner", null)).toEqual({ patch: { sellerType: "individual", proId: null, version: 4 }, search: "upsert" });
  });
});
