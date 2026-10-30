import { describe, expect, it, vi } from "vitest";
import { CATEGORIES, criteriaSchema, jobOfferAbroad, subcategoryById } from "@/config/categories";
import { REGIONS, cityBySlug } from "@/config/regions";
import { withVariantAnswers } from "@/lib/contracts/catalog";
import { publishedListingSchema, userSchema } from "@/lib/db/schemas";
import { DEMO_ENTRIES, DEMO_SELLERS } from "@/lib/demo/catalog";
import { DEMO_ID_PREFIX, DEMO_LIFETIME_DAYS, DEMO_UID_PREFIX, demoListings, demoPhotoRefs, demoSellers, demoShops, pexelsUrl } from "@/lib/demo/data";
import { PRO_ID_PATTERN, proProfileSchema } from "@/lib/pro/profile-schema";
import { LISTING_ID_PATTERN, parseSlugId } from "@/lib/listings/ids";
import { containsProhibited } from "@/lib/moderation/prohibited";
import { toSearchDocument } from "@/lib/search/document";
import { downloadPhoto, parseSeedDemoCli, removeDemo, seedDemo, type SeedDemoTarget } from "../../scripts/seed-demo";

// Example listings: every subcategory and region covered, every listing valid as published,
// and a seed that removes exactly what it wrote.

const NOW = new Date("2026-11-01T10:00:00Z");

// The sharp pipeline has its own tests (media-process); 150 real images would take seconds here.
vi.mock("@/lib/media/process", () => ({
  processImage: vi.fn(async (input: Buffer) => {
    if (input.byteLength === 0) throw new Error("image could not be decoded");
    const variant = Buffer.alloc(100);
    return { width: 64, height: 48, sourceWidth: 64, sourceHeight: 48, blurhash: "LEHV6nWB2yk8", hash: "0123456789abcdef", variants: { l: variant, m: variant, s: variant } };
  }),
}));

describe("demo catalog", () => {
  it("covers every subcategory and every region", () => {
    const subs = new Set(DEMO_ENTRIES.map((entry) => entry.sub));
    for (const category of CATEGORIES) for (const sub of category.subcategories) expect(subs.has(sub.id), sub.id).toBe(true);
    const regions = new Set(DEMO_ENTRIES.map((entry) => cityBySlug(entry.city)?.regionCode));
    for (const region of REGIONS) expect(regions.has(region.code), region.code).toBe(true);
  });

  it("has unique keys, known sellers, one photo at least (a job ad apart), and no contact details in the texts", () => {
    expect(new Set(DEMO_ENTRIES.map((entry) => entry.key)).size).toBe(DEMO_ENTRIES.length);
    const sellers = new Set(DEMO_SELLERS.map((seller) => seller.key));
    for (const entry of DEMO_ENTRIES) {
      expect(sellers.has(entry.seller), entry.key).toBe(true);
      if (!subcategoryById(entry.sub)?.photosOptional) expect(entry.photos.length, entry.key).toBeGreaterThan(0);
      expect(`${entry.title} ${entry.description}`, entry.key).not.toMatch(/(?:\+212|\b0[5-7])\d{8}|@|https?:|www\./);
    }
  });

  it("respects each subcategory's rules", () => {
    const pros = new Set(DEMO_SELLERS.filter((seller) => seller.type === "pro").map((seller) => seller.key));
    for (const entry of DEMO_ENTRIES) {
      const sub = subcategoryById(entry.sub);
      if (!sub) throw new Error(entry.sub);
      if (sub.condition === "required") expect(entry.condition, entry.key).toBeDefined();
      if (!sub.condition) expect(entry.condition, entry.key).toBeUndefined();
      if (entry.price === null) expect(Boolean(sub.priceOptional || (entry.donation && sub.donationAllowed)), entry.key).toBe(true);
      if (entry.donation) expect(sub.donationAllowed, entry.key).toBe(true);
      if (sub.proOnly) expect(pros.has(entry.seller), entry.key).toBe(true);
      if (sub.individualOnly) expect(pros.has(entry.seller), entry.key).toBe(false);
      if (sub.priceMode === "none") expect(entry.price, entry.key).toBeNull();
    }
  });

  it("reads as a listing a member could publish: no prohibited or flagged term in its category", () => {
    for (const entry of DEMO_ENTRIES) {
      const sub = subcategoryById(entry.sub);
      const result = containsProhibited(`${entry.title}\n${entry.description}`, undefined, { categoryId: sub?.categoryId });
      // Restricted goods (koumiyas) are flagged by name and reviewed by a moderator: shown as reviewed (data.ts).
      expect(sub?.adultsOnly ? result.hard : result.matches, entry.key).toEqual([]);
    }
  });

  it("gives Emploi offers of every kind, each with its salary and in Morocco, and job-seeker ads", () => {
    const offers = DEMO_ENTRIES.filter((entry) => entry.sub === "offres-emploi");
    const seekers = DEMO_ENTRIES.filter((entry) => entry.sub === "demandes-emploi");
    // Interim apart: only an agency authorised by the ministry may offer it (CGU §7.12).
    expect(new Set(offers.map((entry) => entry.attributes["job-contract"]))).toEqual(new Set(["cdi", "cdd", "stage", "alternance", "freelance", "saisonnier"]));
    expect(new Set(offers.map((entry) => entry.attributes["job-mode"]))).toEqual(new Set(["sur-place", "hybride", "teletravail"]));
    for (const entry of offers) {
      expect(entry.price, entry.key).toBeGreaterThan(0);
      expect(jobOfferAbroad(entry.sub, entry.attributes), entry.key).toBe(false);
    }
    expect(seekers.length).toBeGreaterThanOrEqual(5);
  });
});

describe("demo listings", () => {
  it("are valid published listings with valid criteria, the same on every run", () => {
    const listings = demoListings(NOW);
    expect(new Set(listings.map((listing) => listing.id)).size).toBe(listings.length);
    for (const { id, ...doc } of listings) {
      expect(LISTING_ID_PATTERN.test(id) && id.startsWith(DEMO_ID_PREFIX), id).toBe(true);
      expect(publishedListingSchema.safeParse(doc).error?.issues ?? [], id).toEqual([]);
      // A size or colour taken over by the variants is answered by them (as the publish readiness does).
      const criteria = subcategoryById(doc.subcategoryId as string)?.criteria.map((criterion) => criterion.id) ?? [];
      expect(criteriaSchema(doc.subcategoryId as string, doc.sellerType).safeParse(withVariantAnswers(doc.attributes, doc.variants, criteria)).error?.issues ?? [], `${id} ${doc.subcategoryId}`).toEqual([]);
      expect(parseSlugId(doc.slugId as string)?.id).toBe(id);
      expect(doc.ownerUid.startsWith(DEMO_UID_PREFIX)).toBe(true);
      expect(toSearchDocument({ id, ...doc }, NOW), id).not.toBeNull();
    }
    expect(demoListings(NOW)).toEqual(listings);
  });

  it("are all labelled examples: no paid boost, no ad, not expiring like a member's listing", () => {
    for (const listing of demoListings(NOW)) {
      expect(listing.example, listing.id).toBe(true);
      expect(listing.boosts, listing.id).toEqual({});
      expect(listing.adsEligible, listing.id).toBe(false);
      expect((listing.expiresAt?.getTime() ?? 0) - NOW.getTime(), listing.id).toBe(DEMO_LIFETIME_DAYS * 86_400_000);
      expect(toSearchDocument(listing, NOW)?.isExample, listing.id).toBe(true);
    }
  });

  it("give each Pro seller a valid example shop, never verified, its listings linked to it", () => {
    const shops = demoShops(NOW);
    expect(shops.length).toBe(DEMO_SELLERS.filter((seller) => seller.type === "pro").length);
    for (const { proId, doc } of shops) {
      expect(PRO_ID_PATTERN.test(proId), proId).toBe(true);
      expect(proProfileSchema.safeParse(doc).error?.issues ?? [], proId).toEqual([]);
      expect(doc).toMatchObject({ example: true, kybc: { status: "none" } });
      expect(doc).not.toHaveProperty("certified");
    }
    expect(shops.map((shop) => shop.doc.sector).filter(Boolean).sort()).toEqual(["car_rental", "real_estate"]);
    const proIds = new Set(shops.map((shop) => shop.proId));
    for (const listing of demoListings(NOW)) expect(listing.sellerType === "pro" ? proIds.has(listing.proId ?? "") : listing.proId === undefined, listing.id).toBe(true);
  });

  it("belong to valid sellers", () => {
    for (const { uid, doc } of demoSellers(NOW)) {
      expect(userSchema.safeParse(doc).error?.issues ?? [], uid).toEqual([]);
      // Fictitious: never shown as certified or phone-checked.
      expect(doc.badges, uid).toMatchObject({ phoneVerified: false, proCertified: false });
    }
  });

  it("fetch photos from Pexels only", () => {
    expect(pexelsUrl("544997")).toBe("https://images.pexels.com/photos/544997/pexels-photo-544997.jpeg?auto=compress&cs=tinysrgb&w=1600");
    expect(() => pexelsUrl("../x")).toThrow();
  });
});

describe("seed-demo", () => {
  async function fakeTarget(): Promise<SeedDemoTarget & { docs: Map<string, unknown>; index: Set<string>; objects: Map<string, number>; bytes: number[] }> {
    const image = Buffer.from("jpeg");
    const docs = new Map<string, unknown>();
    const index = new Set<string>();
    const objects = new Map<string, number>();
    const bytes: number[] = [];
    return {
      docs,
      index,
      objects,
      bytes,
      async write(operations) {
        for (const { path, data } of operations) {
          if (data === null) docs.delete(path);
          else docs.set(path, data);
        }
      },
      store: {
        async head(_bucket, key) {
          const size = objects.get(key);
          return size === undefined ? null : ({ size, contentType: "image/webp" } as never);
        },
        async put(_bucket, key, body) {
          objects.set(key, body.byteLength);
        },
        async delete(_bucket, key) {
          objects.delete(key);
        },
      },
      engine: {
        async upsert(documents) {
          for (const document of documents) index.add(document.id);
        },
        async remove(ids) {
          for (const id of ids) index.delete(id);
        },
      } as SeedDemoTarget["engine"],
      download: async () => image,
      recordBytes: async (delta) => {
        bytes.push(delta);
      },
      log: () => undefined,
    };
  }

  it("parses its flags", () => {
    expect(parseSeedDemoCli([])).toEqual({ remove: false, apply: false, production: false });
    expect(parseSeedDemoCli(["--remove", "--apply"])).toEqual({ remove: true, apply: true, production: false });
    expect(parseSeedDemoCli(["--apply", "--production"])).toEqual({ remove: false, apply: true, production: true });
    expect(() => parseSeedDemoCli(["--all"])).toThrow();
  });

  it("stores the photos, writes sellers and listings, indexes them, then removes everything", async () => {
    const target = await fakeTarget();
    const photos = demoPhotoRefs().length;
    const result = await seedDemo(target, NOW);
    expect(result).toEqual({ documents: DEMO_SELLERS.length + demoShops(NOW).length + DEMO_ENTRIES.length, photos, indexed: DEMO_ENTRIES.length });
    expect(target.objects.size).toBe(photos * 3);
    const [first] = demoListings(NOW);
    const stored = target.docs.get(`listings/${first?.id}`) as { photos: { id: string; w: number }[] };
    expect(stored.photos.length).toBe(DEMO_ENTRIES[0]?.photos.length);
    expect(stored.photos[0]?.w).toBe(64);
    expect(target.bytes[0]).toBeGreaterThan(0);

    // A second run replaces the photos without counting their bytes twice.
    await seedDemo(target, NOW);
    expect(target.bytes[1] ?? 0).toBe(0);

    await removeDemo(target, NOW);
    expect(target.docs.size).toBe(0);
    expect(target.index.size).toBe(0);
    expect(target.objects.size).toBe(0);
    expect(target.bytes.at(-1)).toBe(-(target.bytes[0] as number));
  });

  it("refuses any host but images.pexels.com and oversized bodies", async () => {
    await expect(downloadPhoto("https://example.com/a.jpg")).rejects.toThrow(/host not allowed/);
    const big = (async () => new Response(new Uint8Array(15_000_001))) as unknown as typeof fetch;
    await expect(downloadPhoto(pexelsUrl("1"), big)).rejects.toThrow(/too large/);
    const missing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(downloadPhoto(pexelsUrl("1"), missing)).rejects.toThrow(/404/);
  });
});
