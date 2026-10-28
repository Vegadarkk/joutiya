import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  CONDITIONS,
  LISTING_STATUSES,
  MODERATION_FLAGS,
  MODERATION_STATES,
  UPLOAD_REJECT_REASONS,
  UPLOAD_STATUSES,
  contentOpSchema,
  listingSchema,
  listingStatsSchema,
  moderationDecisionSchema,
  publishedListingSchema,
  revealLogSchema,
  searchOutboxSchema,
  uploadSchema,
  type ListingDoc,
  type UploadDoc,
} from "@/lib/db/schemas";

const now = new Date("2026-10-16T08:00:00Z");

const draft: ListingDoc = {
  ownerUid: "uid-1",
  sellerType: "individual",
  sellerName: "Salma",
  sellerPublicId: "abcdefghjk",
  status: "draft",
  title: "",
  description: "",
  attributes: {},
  price: null,
  priceNegotiable: false,
  isDonation: false,
  photos: [],
  contact: { messaging: true, showPhone: false, whatsapp: false },
  boosts: {},
  sortAt: now,
  sortSource: "publish",
  moderation: { state: "auto_ok", score: 0, flags: [], openReports: 0 },
  adsEligible: false,
  legalHold: [],
  createdAt: now,
  updatedAt: now,
  version: 0,
};

const published: ListingDoc = {
  ...draft,
  status: "published",
  slugId: "dacia-logan-2019-diesel-casablanca-abcdefgh",
  title: "Dacia Logan 2019 diesel",
  description: "Logan 1.5 dCi, 85 000 km, entretien chez le concessionnaire, carnet à jour.",
  categoryId: "vehicules",
  subcategoryId: "voitures",
  attributes: { "car-brand": "dacia", model: "Logan", year: 2019, mileage: 85000, fuel: "diesel", gearbox: "manuelle", amenities: ["a", "b"], "first-hand": true },
  condition: "very_good",
  price: 95000,
  priceNegotiable: true,
  location: { regionCode: "06", citySlug: "casablanca", district: "Maarif", geo: { lat: 33.57, lng: -7.59 } },
  photos: [{ id: "abcdefghjk", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", hash: "0123456789abcdef" }],
  contact: { messaging: true, showPhone: true, whatsapp: true },
  boosts: { bumpedAt: now },
  moderation: {
    state: "needs_review",
    score: 65,
    flags: ["new_account", "price_outlier"],
    sensitiveDeclaration: { kind: "self", at: now },
    openReports: 0,
    ai: { decisionId: "ai-1", action: "hold", confidence: 0.7, applied: false },
  },
  adsEligible: true,
  publishedAt: now,
  expiresAt: new Date("2026-12-15T08:00:00Z"),
  version: 3,
};

describe("listingSchema", () => {
  it("parses a fresh draft and a published listing", () => {
    expect(listingSchema.parse(draft)).toEqual(draft);
    expect(listingSchema.parse(published)).toEqual(published);
    expect(publishedListingSchema.safeParse(published).success).toBe(true);
  });

  it("requires slug, category, location and dates once published", () => {
    expect(publishedListingSchema.safeParse(draft).success).toBe(false);
    expect(publishedListingSchema.safeParse({ ...published, slugId: undefined }).success).toBe(false);
    expect(publishedListingSchema.safeParse({ ...published, location: undefined }).success).toBe(false);
    expect(publishedListingSchema.safeParse({ ...published, expiresAt: undefined }).success).toBe(false);
    expect(publishedListingSchema.safeParse({ ...published, extra: 1 }).success).toBe(false);
  });

  it("refuses unknown fields at every level and out-of-enum values", () => {
    expect(listingSchema.safeParse({ ...draft, id: "abcdefgh" }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, contact: { ...draft.contact, phone: "0612345678" } }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, contact: { ...draft.contact, messaging: false } }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, moderation: { ...draft.moderation, note: "x" } }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, moderation: { ...draft.moderation, flags: ["unknown"] } }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, moderation: { ...draft.moderation, score: 101 } }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, status: "archived" }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, sortSource: "featured" }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, condition: "mint" }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, boosts: { bumpedAt: "2026-10-16" } }).success).toBe(false);
    expect(listingSchema.safeParse({ ...published, location: { ...published.location, geo: { lat: 91, lng: 0 } } }).success).toBe(false);
    expect(listingSchema.safeParse({ ...published, location: { ...published.location, address: "rue" } }).success).toBe(false);
    expect(listingSchema.safeParse({ ...published, photos: [{ ...published.photos[0], url: "x" }] }).success).toBe(false);
    expect(listingSchema.safeParse({ ...published, slugId: "Dacia-abcdefgh" }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, title: "x".repeat(71) }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, price: 1.5 }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, version: -1 }).success).toBe(false);
    expect(listingSchema.safeParse({ ...draft, createdAt: "2026-10-16" }).success).toBe(false);
  });

  it("exposes the enums of §5 and the design", () => {
    expect(LISTING_STATUSES).toEqual(["draft", "pending_review", "published", "paused", "sold", "expired", "rejected", "removed", "purged"]);
    expect(MODERATION_STATES).toEqual(["auto_ok", "needs_review", "auto_rejected", "human_ok", "human_rejected"]);
    expect(MODERATION_FLAGS).toEqual(["prohibited_kw", "prohibited_soft", "sensitive_text", "third_party_phone", "face", "nsfw_review", "price_outlier", "dup_text", "dup_photo", "new_account", "volume", "restricted_category", "credit_ad", "rental_review"]);
    expect(UPLOAD_STATUSES).toEqual(["signed", "processing", "ready", "rejected"]);
    expect(UPLOAD_REJECT_REASONS).toEqual(["too_large", "bad_type", "decode_failed", "nsfw", "expired", "quota", "active_content"]);
    expect(CONDITIONS).toEqual(["new_tagged", "like_new", "very_good", "good", "for_parts"]);
  });
});

describe("uploadSchema", () => {
  const signed: UploadDoc = {
    ownerUid: "uid-1",
    purpose: "listing",
    targetId: "abcdefgh",
    declaredSize: 2_000_000,
    declaredType: "image/jpeg",
    status: "signed",
    quarantineKey: "quarantine/abcdefgh/abcdefghjk.jpg",
    bucket: "media",
    checks: {},
    purgeAt: new Date("2026-10-23T08:00:00Z"),
    createdAt: now,
    updatedAt: now,
  };

  it("parses a signed upload, then a ready and a rejected one", () => {
    expect(uploadSchema.parse(signed)).toEqual(signed);
    const ready: UploadDoc = {
      ...signed,
      status: "ready",
      finalKey: "listings/abcdefgh/abcdefghjk",
      size: 1_950_000,
      width: 1600,
      height: 1200,
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      hash: "0123456789abcdef",
      checks: { nsfw: 0.02, faces: 0 },
      variants: ["l", "s"],
    };
    expect(uploadSchema.safeParse(ready).success).toBe(true);
    expect(uploadSchema.safeParse({ ...signed, status: "rejected", rejectReason: "too_large", size: 12_000_000 }).success).toBe(true);
  });

  it("refuses unknown fields, foreign types and oversized declarations", () => {
    expect(uploadSchema.safeParse({ ...signed, url: "https://x" }).success).toBe(false);
    expect(uploadSchema.safeParse({ ...signed, checks: { nsfw: 1.2 } }).success).toBe(false);
    expect(uploadSchema.safeParse({ ...signed, checks: { skin: 0.5 } }).success).toBe(false);
    expect(uploadSchema.safeParse({ ...signed, declaredType: "image/gif" }).success).toBe(false);
    expect(uploadSchema.safeParse({ ...signed, declaredSize: 10 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(uploadSchema.safeParse({ ...signed, rejectReason: "ugly" }).success).toBe(false);
    expect(uploadSchema.safeParse({ ...signed, variants: ["xl"] }).success).toBe(false);
    expect(uploadSchema.safeParse({ ...signed, purpose: "kyb", bucket: "private" }).success).toBe(true);
    expect(uploadSchema.safeParse({ ...signed, bucket: "quarantine" }).success).toBe(false);
  });
});

describe("outbox, content ops, reveal logs, decisions, stats", () => {
  it("parses valid documents and refuses unknown fields", () => {
    expect(searchOutboxSchema.safeParse({ op: "upsert", version: 3, enqueuedAt: now }).success).toBe(true);
    expect(searchOutboxSchema.safeParse({ op: "index", version: 3, enqueuedAt: now }).success).toBe(false);
    expect(searchOutboxSchema.safeParse({ op: "delete", version: 3, enqueuedAt: now, listingId: "x" }).success).toBe(false);

    const op = { uid: "uid-1", op: "listing.publish", contentRef: "listings/abcdefgh", ip: "196.200.1.1", at: now, purgeAt: now };
    expect(contentOpSchema.safeParse(op).success).toBe(true);
    expect(contentOpSchema.safeParse({ ...op, op: "listing.view" }).success).toBe(false);
    expect(contentOpSchema.safeParse({ ...op, userAgent: "x" }).success).toBe(false);

    const reveal = { viewerUid: "uid-2", listingId: "abcdefgh", ipPrefixHash: "h".repeat(32), deviceHash: "d".repeat(32), at: now, purgeAt: now };
    expect(revealLogSchema.safeParse(reveal).success).toBe(true);
    expect(revealLogSchema.safeParse({ ...reveal, listingId: "ABCDEFGH" }).success).toBe(false);
    expect(revealLogSchema.safeParse({ ...reveal, phone: "+212600000000" }).success).toBe(false);

    const decision = {
      target: { type: "listing", id: "abcdefgh" },
      affectedUid: "uid-1",
      action: "remove",
      facts: "Numéro de téléphone dans le texte.",
      origin: "own_initiative",
      automation: { detection: true, decision: true },
      ground: { type: "terms", ref: "CGU §7.2", explanation: "Coordonnées dans l'annonce." },
      reportIds: [],
      templateId: "phone_in_text",
      decidedBy: "system",
      appealDeadline: new Date("2027-04-16T08:00:00Z"),
      createdAt: now,
      purgeAt: new Date("2031-10-16T08:00:00Z"),
    };
    expect(moderationDecisionSchema.safeParse(decision).success).toBe(true);
    expect(moderationDecisionSchema.safeParse({ ...decision, appeal: { status: "open", openedAt: now } }).success).toBe(true);
    expect(moderationDecisionSchema.safeParse({ ...decision, action: "delete" }).success).toBe(false);
    expect(moderationDecisionSchema.safeParse({ ...decision, ground: { type: "terms", ref: "x" } }).success).toBe(false);
    expect(moderationDecisionSchema.safeParse({ ...decision, note: "x" }).success).toBe(false);

    const stats = { views: 10, favorites: 2, contacts: 1, phoneReveals: 3, flushedAt: now };
    expect(listingStatsSchema.safeParse(stats).success).toBe(true);
    expect(listingStatsSchema.safeParse({ ...stats, views: -1 }).success).toBe(false);
    expect(listingStatsSchema.safeParse({ ...stats, clicks: 1 }).success).toBe(false);
  });

  it("names the new collections", () => {
    expect(COLLECTIONS).toMatchObject({
      listings: "listings",
      listingStats: "listingStats",
      uploads: "uploads",
      searchOutbox: "searchOutbox",
      contentOps: "contentOps",
      revealLogs: "revealLogs",
      moderationDecisions: "moderationDecisions",
      system: "system",
    });
    expect(COLLECTIONS.users).toBe("users");
  });
});

describe("firestore.indexes.json", () => {
  type Index = { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order?: string; arrayConfig?: string }[] };
  type Override = { collectionGroup: string; fieldPath: string; indexes: unknown[] };
  const file = JSON.parse(readFileSync(new URL("../../firestore.indexes.json", import.meta.url), "utf8")) as { indexes: Index[]; fieldOverrides: Override[] };
  const key = (index: Index) => `${index.collectionGroup}:${index.fields.map((f) => `${f.fieldPath} ${f.order ?? f.arrayConfig}`).join(",")}`;

  it("declares the listing composite indexes of the design and keeps the users one", () => {
    const keys = file.indexes.map(key);
    expect(keys).toContain("users:activation ASCENDING,createdAt ASCENDING");
    expect(keys).toContain("listings:ownerUid ASCENDING,status ASCENDING,updatedAt DESCENDING");
    expect(keys).toContain("listings:ownerUid ASCENDING,status ASCENDING,sortAt DESCENDING");
    expect(keys).toContain("listings:status ASCENDING,expiresAt ASCENDING");
    // No query filters on moderation.state: the moderation queue reads status + updatedAt (below).
    expect(keys).not.toContain("listings:moderation.state ASCENDING,createdAt ASCENDING");
    // Queries of the phase 3 lots (the emulator never asks for composite indexes; production does).
    expect(keys).toContain("listings:status ASCENDING,updatedAt ASCENDING");
    expect(keys).toContain("listings:ownerUid ASCENDING,publishedAt ASCENDING");
    expect(keys).toContain("revealLogs:listingId ASCENDING,at ASCENDING");
    expect(keys).toContain("moderationDecisions:affectedUid ASCENDING,createdAt DESCENDING");
    expect(keys).toContain("uploads:status ASCENDING,createdAt ASCENDING");
    expect(keys).toContain("uploads:status ASCENDING,size ASCENDING");
    expect(keys).toContain("uploads:heldObjects ASCENDING,size ASCENDING");
    expect(keys).toContain("uploads:targetId ASCENDING,status ASCENDING");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has no single-field composite index (the Firebase CLI refuses them) and exempts the heavy listing fields", () => {
    for (const index of file.indexes) {
      expect(index.fields.length, key(index)).toBeGreaterThanOrEqual(2);
      expect(index.queryScope).toBe("COLLECTION");
    }
    const exempt = file.fieldOverrides.filter((o) => o.collectionGroup === "listings" && o.indexes.length === 0).map((o) => o.fieldPath).sort();
    expect(exempt).toEqual(["attributes", "description", "photos"]);
    expect(file.fieldOverrides.some((o) => o.collectionGroup === "private" && o.fieldPath === "phoneE164")).toBe(true);
  });

  it("keeps the automatic purgeAt index the journal purges query (no composite index needed)", () => {
    // purge-connection-logs and retention-purge ask `purgeAt <= now` (ordered by purgeAt) and nothing
    // else: the automatic single-field index serves it, and the CLI refuses a one-field composite.
    // An exemption of purgeAt would break those nightly purges in production only.
    for (const group of ["connectionLogs", "contentOps", "revealLogs"]) {
      expect(file.fieldOverrides.some((o) => o.collectionGroup === group && o.fieldPath === "purgeAt"), group).toBe(false);
    }
  });
});
