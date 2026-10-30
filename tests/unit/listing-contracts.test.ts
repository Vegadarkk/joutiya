import { describe, expect, it } from "vitest";
import { TURNSTILE_ACTIONS } from "@/lib/contracts/auth";
import {
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  LISTING_API,
  MAX_DRAFTS,
  PRICE_MAX,
  TITLE_MAX,
  TITLE_MIN,
  WIZARD_DONE,
  WIZARD_STEPS,
  createListingSchema,
  descriptionSchema,
  listingPatchSchema,
  publishListingSchema,
  slugIdSchema,
  titleSchema,
  type ListingPatch,
} from "@/lib/contracts/listings";
import { LEGACY_PHOTO_VARIANTS, MAX_PHOTOS_INDIVIDUAL, MAX_PHOTOS_PRO, MAX_UPLOAD_BYTES, MEDIA_API, PHOTO_VARIANT_SPECS, listingPhotoSchema, signUploadSchema, uploadIdSchema } from "@/lib/contracts/media";

const fullPatch: ListingPatch = {
  categoryId: "vehicules",
  subcategoryId: "voitures",
  title: "Dacia Logan 2019 diesel",
  description: "Logan 1.5 dCi, 85 000 km, entretien chez le concessionnaire, carnet à jour.",
  attributes: { "car-brand": "dacia", model: "Logan", year: 2019, mileage: 85000, fuel: "diesel", gearbox: "manuelle", "first-hand": true },
  condition: "very_good",
  price: 95000,
  priceNegotiable: true,
  isDonation: false,
  location: { regionCode: "06", citySlug: "casablanca", district: "Maarif" },
  photos: ["abcdefghjk", "a1B2c3D4e5F6"],
  contact: { showPhone: true, whatsapp: false },
  sensitiveDeclaration: null,
};

describe("listingPatchSchema", () => {
  it("parses a full valid patch and an empty one", () => {
    expect(listingPatchSchema.parse(fullPatch)).toEqual(fullPatch);
    expect(listingPatchSchema.safeParse({}).success).toBe(true);
    expect(listingPatchSchema.safeParse({ price: null, condition: null }).success).toBe(true);
  });

  it("lets drafts keep short text and caps its length; the minimums belong to publication", () => {
    // D2: autosave stores half-typed text; assessReadiness (titleSchema / descriptionSchema) checks the minimums.
    expect(listingPatchSchema.safeParse({ title: "x".repeat(TITLE_MIN - 1) }).success).toBe(true);
    expect(listingPatchSchema.safeParse({ title: "x".repeat(TITLE_MAX) }).success).toBe(true);
    expect(listingPatchSchema.safeParse({ title: "x".repeat(TITLE_MAX + 1) }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ description: "x".repeat(DESCRIPTION_MIN - 1) }).success).toBe(true);
    expect(listingPatchSchema.safeParse({ description: "x".repeat(DESCRIPTION_MAX) }).success).toBe(true);
    expect(listingPatchSchema.safeParse({ description: "x".repeat(DESCRIPTION_MAX + 1) }).success).toBe(false);
    expect(titleSchema.safeParse("x".repeat(TITLE_MIN)).success).toBe(true);
    expect(titleSchema.safeParse(`  ${"x".repeat(TITLE_MIN - 1)}  `).success).toBe(false);
    expect(descriptionSchema.safeParse("x".repeat(DESCRIPTION_MIN - 1)).success).toBe(false);
    expect([TITLE_MIN, TITLE_MAX, DESCRIPTION_MIN, DESCRIPTION_MAX, PRICE_MAX, MAX_DRAFTS]).toEqual([5, 70, 20, 4000, 100_000_000, 5]);
  });

  it("refuses unknown fields, bad prices, bad locations and too many photos", () => {
    expect(listingPatchSchema.safeParse({ ownerUid: "x" }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ status: "published" }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ price: -1 }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ price: 10.5 }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ price: PRICE_MAX + 1 }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ location: { regionCode: "13", citySlug: "casablanca" } }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ location: { regionCode: "06", citySlug: "Casablanca" } }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 0, lng: 0 } } }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ photos: Array.from({ length: MAX_PHOTOS_PRO + 1 }, () => "abcdefghjk") }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ photos: ["../etc"] }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ contact: { showPhone: true } }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ attributes: { "Bad Key": 1 } }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ attributes: { nested: { a: 1 } } }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ sensitiveDeclaration: { kind: "other" } }).success).toBe(false);
  });

  it("checks the category tree", () => {
    expect(listingPatchSchema.safeParse({ categoryId: "nope" }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ subcategoryId: "nope" }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ categoryId: "immobilier", subcategoryId: "voitures" }).success).toBe(false);
    expect(listingPatchSchema.safeParse({ subcategoryId: "voitures" }).success).toBe(true);
    expect(createListingSchema.safeParse({}).success).toBe(true);
    expect(createListingSchema.safeParse({ categoryId: "vehicules", subcategoryId: "voitures" }).success).toBe(true);
    expect(createListingSchema.safeParse({ categoryId: "vehicules", subcategoryId: "vente" }).success).toBe(false);
    expect(createListingSchema.safeParse({ title: "x" }).success).toBe(false);
    expect(createListingSchema.safeParse({ categoryId: "loisirs", subcategoryId: "livres", isDonation: true }).success).toBe(true);
  });
});

describe("publish, wizard and API maps", () => {
  it("requires the rules to be accepted and allows an optional Turnstile token", () => {
    expect(publishListingSchema.safeParse({ acceptRules: true }).success).toBe(true);
    expect(publishListingSchema.safeParse({ acceptRules: true, turnstileToken: "tok" }).success).toBe(true);
    expect(publishListingSchema.safeParse({ acceptRules: false }).success).toBe(false);
    expect(publishListingSchema.safeParse({}).success).toBe(false);
    expect(publishListingSchema.safeParse({ acceptRules: true, force: true }).success).toBe(false);
    expect(TURNSTILE_ACTIONS).toContain("listing");
  });

  it("orders the 9 wizard steps", () => {
    expect(WIZARD_STEPS).toEqual(["categorie", "criteres", "titre", "description", "photos", "prix", "lieu", "contact", "apercu"]);
    expect(WIZARD_DONE).toBe("termine");
  });

  it("builds the API paths", () => {
    expect(LISTING_API.listings).toBe("/api/listings");
    expect(LISTING_API.mine("drafts")).toBe("/api/listings/mine?status=drafts");
    expect(LISTING_API.listing("abcdefgh")).toBe("/api/listings/abcdefgh");
    expect(LISTING_API.publish("abcdefgh")).toBe("/api/listings/abcdefgh/publish");
    expect(LISTING_API.renew("abcdefgh")).toBe("/api/listings/abcdefgh/renew");
    expect(LISTING_API.phone("abcdefgh")).toBe("/api/listings/abcdefgh/phone");
    expect(MEDIA_API.sign).toBe("/api/uploads/sign");
    expect(MEDIA_API.upload("u1")).toBe("/api/uploads/u1");
    expect(MEDIA_API.complete("u1")).toBe("/api/uploads/u1/complete");
  });

  it("accepts the stored slugId shape only", () => {
    expect(slugIdSchema.safeParse("velo-electrique-casablanca-abcdefgh").success).toBe(true);
    expect(slugIdSchema.safeParse("abcdefgh").success).toBe(false);
    expect(slugIdSchema.safeParse("Velo-abcdefgh").success).toBe(false);
    expect(slugIdSchema.safeParse(`${"a".repeat(70)}-abcdefgh`).success).toBe(false);
  });
});

describe("media contracts", () => {
  it("signs a listing photo within the size and type limits", () => {
    const sign = { purpose: "listing", targetId: "abcdefgh", declaredSize: 1024, declaredType: "image/jpeg" };
    expect(signUploadSchema.safeParse(sign).success).toBe(true);
    expect(signUploadSchema.safeParse({ ...sign, declaredSize: MAX_UPLOAD_BYTES }).success).toBe(true);
    expect(signUploadSchema.safeParse({ ...sign, declaredSize: MAX_UPLOAD_BYTES + 1 }).success).toBe(false);
    expect(signUploadSchema.safeParse({ ...sign, declaredSize: 0 }).success).toBe(false);
    expect(signUploadSchema.safeParse({ ...sign, declaredType: "image/gif" }).success).toBe(false);
    expect(signUploadSchema.safeParse({ ...sign, declaredType: "image/heic" }).success).toBe(false);
    expect(signUploadSchema.safeParse({ ...sign, purpose: "avatar" }).success).toBe(false);
    expect(signUploadSchema.safeParse({ ...sign, targetId: "ABCDEFGH" }).success).toBe(false);
    expect(signUploadSchema.safeParse({ ...sign, fileName: "x.jpg" }).success).toBe(false);
    expect([MAX_UPLOAD_BYTES, MAX_PHOTOS_INDIVIDUAL, MAX_PHOTOS_PRO]).toEqual([10 * 1024 * 1024, 10, 20]);
    expect(PHOTO_VARIANT_SPECS).toEqual({ l: { maxEdge: 1600, quality: 80 }, m: { maxEdge: 960, quality: 78 }, s: { maxEdge: 480, quality: 75 } });
  });

  it("validates photo ids and the stored photo shape", () => {
    expect(uploadIdSchema.safeParse("abcdefgh").success).toBe(true);
    expect(uploadIdSchema.safeParse("Ab3".repeat(10)).success).toBe(true);
    expect(uploadIdSchema.safeParse("short").success).toBe(false);
    expect(uploadIdSchema.safeParse("with-dash1").success).toBe(false);
    expect(uploadIdSchema.safeParse("a".repeat(41)).success).toBe(false);
    const photo = { id: "abcdefghjk", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" };
    expect(listingPhotoSchema.safeParse(photo).success).toBe(true);
    expect(listingPhotoSchema.safeParse({ ...photo, hash: "0123456789abcdef" }).success).toBe(true);
    expect(listingPhotoSchema.safeParse({ ...photo, hash: "0123456789ABCDEF" }).success).toBe(false);
    expect(listingPhotoSchema.safeParse({ ...photo, w: 0 }).success).toBe(false);
    expect(listingPhotoSchema.safeParse({ ...photo, url: "https://x" }).success).toBe(false);
    expect(listingPhotoSchema.safeParse({ ...photo, variants: ["l", "m", "s"] }).success).toBe(true);
    expect(listingPhotoSchema.safeParse({ ...photo, variants: [...LEGACY_PHOTO_VARIANTS] }).success).toBe(true);
    expect(listingPhotoSchema.safeParse({ ...photo, variants: [] }).success).toBe(false);
    expect(listingPhotoSchema.safeParse({ ...photo, variants: ["xl"] }).success).toBe(false);
  });
});
