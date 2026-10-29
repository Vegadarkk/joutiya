import { describe, expect, it } from "vitest";
import { CATEGORIES, subcategoryById } from "@/config/categories";
import { CITIES, cityBySlug } from "@/config/regions";
import type { ListingDoc } from "@/lib/db/schemas";
import { READINESS_CODES, assessReadiness, issuesByPath, type SellerFacts } from "@/lib/listings/readiness";

// Publish readiness (§7 step 1, D4): the blockers matrix on the real categories and regions data.

const NOW = new Date("2026-10-16T10:00:00.000Z");
const INDIVIDUAL: SellerFacts = { seller: { type: "individual" }, phoneVerified: false };
const VERIFIED: SellerFacts = { seller: { type: "individual" }, phoneVerified: true };
const PRO: SellerFacts = { seller: { type: "pro", plan: "essentiel" }, phoneVerified: true };

const casablanca = cityBySlug("casablanca")!;
const photo = { id: "photo000000000001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" };

function ready(overrides: Partial<ListingDoc> = {}): ListingDoc {
  return {
    ownerUid: "uid-1",
    sellerType: "individual",
    sellerName: "Salma",
    sellerPublicId: "abcdefghjk",
    status: "draft",
    title: "Vélo de ville Peugeot en bon état",
    description: "Vélo de ville 28 pouces, 6 vitesses, révisé récemment, deux pneus neufs. Remise en main propre à Casablanca.",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: { "bike-type": "ville", brand: "Peugeot" },
    condition: "good",
    price: 1500,
    priceNegotiable: true,
    isDonation: false,
    location: { regionCode: casablanca.regionCode, citySlug: casablanca.slug, geo: { lat: casablanca.lat, lng: casablanca.lng } },
    photos: [photo],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: NOW,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 0, flags: [], openReports: 0 },
    adsEligible: false,
    legalHold: [],
    createdAt: NOW,
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

const codes = (listing: ListingDoc, facts = INDIVIDUAL) => issuesByPath(assessReadiness(listing, facts));

describe("assessReadiness", () => {
  it("accepts a complete listing", () => {
    expect(assessReadiness(ready(), INDIVIDUAL)).toEqual([]);
  });

  it("blocks an empty draft on every required field at once", () => {
    const blockers = codes(ready({ title: "", description: "", categoryId: undefined, subcategoryId: undefined, attributes: {}, condition: undefined, price: null, location: undefined, photos: [] }));
    expect(blockers.get("title")).toEqual(["title_min"]);
    expect(blockers.get("description")).toEqual(["description_min"]);
    expect(blockers.get("categoryId")).toEqual(["category_required"]);
    expect(blockers.get("subcategoryId")).toEqual(["subcategory_required"]);
    expect(blockers.get("location")).toEqual(["city_required"]);
    expect(blockers.get("photos")).toEqual(["photos_required"]);
    // Without a subcategory, criteria, condition and price cannot be judged.
    expect(blockers.has("price")).toBe(false);
    expect(blockers.has("condition")).toBe(false);
    for (const code of [...blockers.values()].flat()) expect(READINESS_CODES).toContain(code);
  });

  it("checks the text bounds (5-70, 20-4000, trimmed)", () => {
    expect(codes(ready({ title: "Vélo" })).get("title")).toEqual(["title_min"]);
    expect(codes(ready({ title: "   Vélo    " })).get("title")).toEqual(["title_min"]);
    expect(codes(ready({ title: "x".repeat(71) })).get("title")).toEqual(["title_max"]);
    expect(codes(ready({ description: "Trop court" })).get("description")).toEqual(["description_min"]);
    expect(codes(ready({ description: "d".repeat(4001) })).get("description")).toEqual(["description_max"]);
    expect(codes(ready({ title: "Vélos" })).has("title")).toBe(false);
  });

  it("checks the category tree: unknown, mismatch, Pro-only", () => {
    expect(codes(ready({ subcategoryId: "licornes" })).get("subcategoryId")).toEqual(["unknown"]);
    expect(codes(ready({ categoryId: "mode", subcategoryId: "velos" })).get("subcategoryId")).toEqual(["subcategory_mismatch"]);
    const rental = ready({ subcategoryId: "location-voitures", attributes: { "rental-class": "berline", "car-brand": "dacia", model: "Logan", gearbox: "manuelle", fuel: "diesel" }, price: 300, condition: undefined });
    expect(codes(rental).get("subcategoryId")).toEqual(["pro_only"]);
    expect(codes(rental, PRO).has("subcategoryId")).toBe(false);
  });

  it("validates the attributes with the subcategory criteria: required, invalid, unknown", () => {
    const car = ready({ subcategoryId: "voitures", attributes: { "car-brand": "dacia", model: "Logan", year: 2019, mileage: 85000, fuel: "diesel", gearbox: "manuelle" }, price: 95000, condition: undefined });
    expect(assessReadiness(car, INDIVIDUAL)).toEqual([]);
    const missing = codes(ready({ ...car, attributes: { "car-brand": "dacia", model: "", mileage: 85000, fuel: "diesel", gearbox: "manuelle" } }));
    expect(missing.get("attributes.year")).toEqual(["criterion_required"]);
    expect(missing.get("attributes.model")).toEqual(["criterion_required"]);
    const invalid = codes(ready({ ...car, attributes: { ...car.attributes, fuel: "charbon", year: 1800, mileage: -5, "first-hand": "oui" } }));
    expect(invalid.get("attributes.fuel")).toEqual(["criterion_invalid"]);
    expect(invalid.get("attributes.year")).toEqual(["criterion_invalid"]);
    expect(invalid.get("attributes.mileage")).toEqual(["criterion_invalid"]);
    expect(invalid.get("attributes.first-hand")).toEqual(["criterion_invalid"]);
    expect(codes(ready({ attributes: { "bike-type": "ville", couleur: "rouge" } })).get("attributes.couleur")).toEqual(["unknown"]);
    // Multiselect duplicates and unknown options are invalid too.
    const flat = ready({ categoryId: "immobilier", subcategoryId: "location", condition: undefined, attributes: { "property-type": "appartement", surface: 80, furnished: true, amenities: ["parking", "parking"] }, price: 4500 });
    expect(codes(flat).get("attributes.amenities")).toEqual(["criterion_invalid"]);
  });

  it("requires every required criterion of every subcategory, and accepts a minimal valid set", () => {
    for (const category of CATEGORIES) {
      for (const subcategory of category.subcategories) {
        const required = subcategory.criteria.filter((criterion) => criterion.required);
        const empty = codes(ready({ categoryId: category.id, subcategoryId: subcategory.id, attributes: {}, condition: "good", price: 1000 }), PRO);
        for (const criterion of required) expect(empty.get(`attributes.${criterion.id}`), `${subcategory.id}.${criterion.id}`).toEqual(["criterion_required"]);
        const attributes: Record<string, string | number | boolean | string[]> = {};
        for (const criterion of required) {
          if (criterion.type === "select") attributes[criterion.id] = criterion.options![0]!;
          else if (criterion.type === "multiselect") attributes[criterion.id] = [criterion.options![0]!];
          else if (criterion.type === "number") attributes[criterion.id] = criterion.min ?? 1;
          else if (criterion.type === "boolean") attributes[criterion.id] = true;
          else attributes[criterion.id] = criterion.format === "onssa" ? "M.07.113.20" : "ok";
        }
        const filled = assessReadiness(ready({ categoryId: category.id, subcategoryId: subcategory.id, attributes, condition: "good", price: 1000 }), PRO);
        expect(filled.filter((issue) => issue.path.startsWith("attributes")), subcategory.id).toEqual([]);
      }
    }
  });

  it("keeps food to Pros, with an ONSSA number of the right shape", () => {
    const honey = (number: string) => ready({ categoryId: "terroir", subcategoryId: "miel", attributes: { "onssa-number": number, "honey-type": "thym" }, condition: undefined, price: 220 });
    expect(codes(honey("M.07.113.20")).get("subcategoryId")).toEqual(["pro_only"]);
    expect(codes(honey("M.07.113.20"), PRO).size).toBe(0);
    expect(codes(honey("HFO.24.07.15"), PRO).size).toBe(0);
    for (const bad of ["M07113", "m.07.113.20", "M.07.113.2026", "MIEL.07.113", "ABCDEFG.1.1.20"]) expect(codes(honey(bad), PRO).get("attributes.onssa-number"), bad).toEqual(["criterion_format_onssa"]);
    expect(codes(honey(""), PRO).get("attributes.onssa-number")).toEqual(["criterion_required"]);
  });

  it("requires the condition where the subcategory says so", () => {
    expect(codes(ready({ condition: undefined })).get("condition")).toEqual(["condition_required"]);
    const car = ready({ subcategoryId: "voitures", attributes: { "car-brand": "dacia", model: "Logan", year: 2019, mileage: 85000, fuel: "diesel", gearbox: "manuelle" }, price: 95000, condition: undefined });
    expect(codes(car).has("condition")).toBe(false);
    expect(subcategoryById("voitures")?.condition).toBe("optional");
  });

  it("applies the price rules of D4", () => {
    expect(codes(ready({ price: null })).get("price")).toEqual(["price_required"]);
    expect(codes(ready({ price: 0 })).get("price")).toEqual(["price_invalid"]);
    // Donation: allowed on velos, price must be empty or 0.
    expect(codes(ready({ isDonation: true, price: null })).has("price")).toBe(false);
    expect(codes(ready({ isDonation: true, price: 0 })).has("price")).toBe(false);
    expect(codes(ready({ isDonation: true, price: 50 })).get("price")).toEqual(["donation_price"]);
    // Donation refused where the subcategory does not allow it (cars).
    const car = ready({ subcategoryId: "voitures", attributes: { "car-brand": "dacia", model: "Logan", year: 2019, mileage: 85000, fuel: "diesel", gearbox: "manuelle" }, isDonation: true, price: null, condition: undefined });
    expect(codes(car).get("isDonation")).toEqual(["donation_not_allowed"]);
    // Price optional for services.
    const service = ready({ categoryId: "services", subcategoryId: "cours", attributes: { "course-subject": "langues" }, price: null, condition: undefined });
    expect(assessReadiness(service, INDIVIDUAL)).toEqual([]);
  });

  it("requires a real city in its region, for every city of the dataset", () => {
    expect(codes(ready({ location: { regionCode: "06", citySlug: "atlantis", geo: { lat: 0, lng: 0 } } })).get("location.citySlug")).toEqual(["unknown"]);
    expect(codes(ready({ location: { regionCode: "04", citySlug: "casablanca", geo: { lat: 0, lng: 0 } } })).get("location.regionCode")).toEqual(["region_mismatch"]);
    for (const city of CITIES) {
      const listing = ready({ location: { regionCode: city.regionCode, citySlug: city.slug, geo: { lat: city.lat, lng: city.lng } } });
      expect(assessReadiness(listing, INDIVIDUAL), city.slug).toEqual([]);
    }
  });

  it("needs at least one photo and respects the seller's photo quota", () => {
    expect(codes(ready({ photos: [] })).get("photos")).toEqual(["photos_required"]);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ ...photo, id: `photo${String(i).padStart(12, "0")}` }));
    expect(codes(ready({ photos: eleven })).get("photos")).toEqual(["photos_max"]);
    expect(codes(ready({ photos: eleven }), PRO).has("photos")).toBe(false);
    expect(codes(ready({ photos: eleven.slice(0, 10) })).has("photos")).toBe(false);
  });

  it("ties showPhone and WhatsApp to a verified number", () => {
    const both = ready({ contact: { messaging: true, showPhone: true, whatsapp: true } });
    const blocked = codes(both);
    expect(blocked.get("contact.showPhone")).toEqual(["phone_required"]);
    expect(blocked.get("contact.whatsapp")).toEqual(["phone_required"]);
    expect(assessReadiness(both, VERIFIED)).toEqual([]);
    expect(codes(ready({ contact: { messaging: true, showPhone: false, whatsapp: true } })).has("contact.showPhone")).toBe(false);
  });
});

describe("assessReadiness: real estate (Agence pack)", () => {
  const flat = (overrides: Partial<ListingDoc> = {}) =>
    ready({ title: "Appartement 3 chambres à Maarif", description: "Appartement lumineux de 95 m², 3 chambres, cuisine équipée, proche du tramway et des écoles.", categoryId: "immobilier", subcategoryId: "vente", attributes: { "property-type": "appartement", surface: 95, rooms: 5, "property-title": "titre-foncier" }, condition: undefined, price: 1_250_000, ...overrides });
  const agency = { mandate: "exclusif", "agency-fees": "en-sus", "agency-fees-amount": 25_000 };

  it("refuses the Pro-only fields from an individual and requires the mandate and fees from a Pro", () => {
    expect(assessReadiness(flat(), INDIVIDUAL)).toEqual([]);
    expect(codes(flat({ attributes: { "property-type": "appartement", surface: 95, mandate: "exclusif" } })).get("attributes.mandate")).toEqual(["criterion_pro_only"]);
    const pro = codes(flat({ sellerType: "pro" }), PRO);
    expect(pro.get("attributes.mandate")).toEqual(["criterion_required"]);
    expect(pro.get("attributes.agency-fees")).toEqual(["criterion_required"]);
    expect(assessReadiness(flat({ sellerType: "pro", attributes: { "property-type": "appartement", surface: 95, ...agency } }), PRO)).toEqual([]);
  });

  it("caps a lease deposit at two months' rent (law 67-12 art. 20)", () => {
    const lease = (deposit: number) => flat({ subcategoryId: "location", price: 6000, attributes: { "property-type": "appartement", surface: 95, furnished: false, deposit } });
    expect(assessReadiness(lease(12_000), INDIVIDUAL)).toEqual([]);
    expect(codes(lease(12_001)).get("attributes.deposit")).toEqual(["deposit_max"]);
    expect(assessReadiness(flat({ subcategoryId: "location", price: null, attributes: { "property-type": "appartement", surface: 95, furnished: false, deposit: 50_000 } }), INDIVIDUAL)).toEqual([]);
  });

  it("asks an off-plan sale for its building permit and delivery year (VEFA)", () => {
    const offPlan = (extra: Record<string, unknown>) => flat({ sellerType: "pro", attributes: { "property-type": "appartement", surface: 95, ...agency, "off-plan": true, ...extra } as ListingDoc["attributes"] });
    const missing = codes(offPlan({}), PRO);
    expect(missing.get("attributes.building-permit")).toEqual(["criterion_required"]);
    expect(missing.get("attributes.delivery-year")).toEqual(["criterion_required"]);
    expect(assessReadiness(offPlan({ "building-permit": "PC 2026/1184", "delivery-year": 2028 }), PRO)).toEqual([]);
  });
});
