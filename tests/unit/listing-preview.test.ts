import { afterEach, describe, expect, it, vi } from "vitest";
import { searchDoc } from "../search/fixtures";
import { priceGuideCacheKey, setPriceGuideCacheForTests, type GuideCache } from "@/lib/price-guide/service";
import { MemoryEngine } from "@/lib/search/memory";
import { listingPreview, PREVIEW_DESCRIPTION_MAX } from "@/lib/search/preview";

// Map detail panel preview (Carte vivante): criteria, description, « Prix repère » and seller, read
// from the search index only, in the visitor's language.

vi.mock("server-only", () => ({}));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = { fr: (await import("../../messages/fr.json")).default, ar: (await import("../../messages/ar.json")).default };
  return {
    getTranslations: async ({ locale, namespace }: { locale: "fr" | "ar"; namespace?: string }) =>
      createTranslator({ locale, messages: messages[locale] ?? messages.fr, namespace: namespace as never }),
  };
});

function bike(id: string, price: number, extra: { example?: boolean; description?: string; seller?: string; raw?: boolean } = {}) {
  const doc = searchDoc({
    id,
    title: `Vélo ${id}`,
    categoryId: "vehicules",
    subcategoryId: "velos",
    categoryText: "Véhicules Vélos",
    citySlug: "casablanca",
    price,
    daysAgo: 1,
    description: extra.description ?? "",
    attributes: { "bike-type": "enfant" },
  });
  doc.sellerPublicId = extra.seller ?? `seller${id}`;
  doc.condition = "good";
  // Documents indexed before the field existed have no `attributes`.
  if (!extra.raw) doc.attributes = { "bike-type": "enfant", brand: "Btwin" };
  if (extra.example) doc.isExample = true;
  return doc;
}

function memoryCache(): GuideCache & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return { entries, get: async (key) => entries.get(key) ?? null, set: async (key, value) => void entries.set(key, value) };
}

const PRICES = [300, 320, 350, 380, 400, 420, 450, 480, 500, 520];

async function engineWith(...subjects: ReturnType<typeof bike>[]) {
  const engine = new MemoryEngine();
  await engine.upsert([...PRICES.map((price, index) => bike(`c${index}`, price)), ...subjects]);
  return engine;
}

afterEach(() => setPriceGuideCacheForTests(undefined));

describe("listing preview", () => {
  it("gives the criteria, the start of the description, the guide and the seller, in French", async () => {
    setPriceGuideCacheForTests(memoryCache());
    const engine = await engineWith(bike("subject1", 450, { description: "Vélo enfant très bon état. ".repeat(60), seller: "abcdefghjk" }));
    const preview = await listingPreview("subject1", "fr", engine);
    expect(preview?.criteria.map((row) => [row.label, row.value])).toEqual([
      ["État", "Bon état"],
      ["Type de vélo", "Enfant"],
      ["Marque", "Btwin"],
    ]);
    expect(preview?.criteria.at(-1)?.userText).toBe(true);
    expect(preview?.description.length).toBeLessThanOrEqual(PREVIEW_DESCRIPTION_MAX);
    expect(preview?.description.startsWith("Vélo enfant très bon état.")).toBe(true);
    expect(preview?.guide?.title).toBe("Prix repère");
    expect(preview?.guide?.count).toContain("à Casablanca");
    expect(preview?.guide?.marker).toBeGreaterThan(0);
    expect(preview?.seller).toEqual({ type: "individual", publicId: "abcdefghjk" });
  });

  it("speaks Arabic", async () => {
    setPriceGuideCacheForTests(null);
    const preview = await listingPreview("subject1", "ar", await engineWith(bike("subject1", 450)));
    expect(preview?.criteria[1]).toMatchObject({ label: "نوع الدراجة" });
    expect(preview?.guide?.title).toBe("السعر المرجعي");
  });

  it("names no seller and computes no guide for an example listing", async () => {
    setPriceGuideCacheForTests(null);
    const preview = await listingPreview("demo1", "fr", await engineWith(bike("demo1", 450, { example: true })));
    expect(preview?.seller).toBeNull();
    expect(preview?.guide).toBeNull();
    expect(preview?.criteria.length).toBeGreaterThan(0);
  });

  it("leaves the page's cached guide alone for a document indexed without its criteria", async () => {
    const cache = memoryCache();
    setPriceGuideCacheForTests(cache);
    const preview = await listingPreview("old1", "fr", await engineWith(bike("old1", 450, { raw: true })));
    expect(preview?.guide).toBeNull();
    expect(preview?.criteria.map((row) => row.id)).toEqual(["condition"]);
    expect(cache.entries.has(priceGuideCacheKey("old1"))).toBe(false);
  });

  it("is null for a listing the index does not hold", async () => {
    setPriceGuideCacheForTests(null);
    expect(await listingPreview("missing1", "fr", await engineWith())).toBeNull();
  });
});
