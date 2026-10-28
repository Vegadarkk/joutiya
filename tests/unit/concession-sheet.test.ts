import { describe, expect, it } from "vitest";
import { DEFAULT_AI } from "@/config/ai";
import { VEHICLE_SALE_SUBCATEGORIES, criteriaSchema, criterionApplies, subcategoryById } from "@/config/categories";
import { cityBySlug } from "@/config/regions";
import type { ListingDoc } from "@/lib/db/schemas";
import { assessReadiness, issuesByPath, type SellerFacts } from "@/lib/listings/readiness";
import { quotesCreditWithoutApr } from "@/lib/moderation/credit";
import { screenListing } from "@/lib/moderation/screen";
import type { ScreenInput } from "@/lib/moderation/types";

// Concession pack, vehicle sheet (design concession/concession.md §2 and §7): the dossier criteria,
// the Pro-only stock reference, the warranty's dependent duration and the credit-ad review rule.

const NOW = new Date("2026-10-28T10:00:00.000Z");
const INDIVIDUAL: SellerFacts = { seller: { type: "individual" }, phoneVerified: true };
const PRO: SellerFacts = { seller: { type: "pro", plan: "business" }, phoneVerified: true };
const casablanca = cityBySlug("casablanca")!;
const BASE_ATTRIBUTES = { "car-brand": "dacia", model: "Duster", year: 2022, mileage: 41000, fuel: "diesel", gearbox: "manuelle" };

function car(attributes: Record<string, unknown> = {}, overrides: Partial<ListingDoc> = {}): ListingDoc {
  return {
    ownerUid: "uid-1",
    sellerType: "pro",
    sellerName: "Auto Atlas",
    sellerPublicId: "abcdefghjk",
    status: "draft",
    title: "Dacia Duster 1.5 dCi 2022",
    description: "Duster 4x2, première main, entretien complet en concession, garantie 12 mois, reprise possible de votre véhicule.",
    categoryId: "vehicules",
    subcategoryId: "voitures",
    attributes: { ...BASE_ATTRIBUTES, ...attributes } as ListingDoc["attributes"],
    condition: "very_good",
    price: 189_000,
    priceNegotiable: false,
    isDonation: false,
    location: { regionCode: casablanca.regionCode, citySlug: casablanca.slug, geo: { lat: casablanca.lat, lng: casablanca.lng } },
    photos: [{ id: "photo000000000001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }],
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

const FULL_DOSSIER = {
  "first-hand": true,
  "service-history": "complet",
  "no-accident": true,
  "vehicle-papers": ["carte-grise", "visite-technique", "libre-de-gage"],
  "vehicle-warranty": "vendeur",
  "warranty-months": 12,
  "trade-in": true,
  financing: true,
  "car-equipment": ["climatisation", "camera-recul"],
  "stock-ref": "DUS-2022-041",
};

describe("vehicle dossier criteria", () => {
  it("gives every vehicle for sale the same folded dossier, the stock reference reserved to Pros", () => {
    for (const id of VEHICLE_SALE_SUBCATEGORIES) {
      const dossier = subcategoryById(id)!.criteria.filter((criterion) => criterion.group === "dossier").map((criterion) => criterion.id);
      expect(dossier, id).toEqual(expect.arrayContaining(["service-history", "vehicle-papers", "vehicle-warranty", "warranty-months", "trade-in", "financing", "stock-ref"]));
      expect(subcategoryById(id)!.criteria.find((criterion) => criterion.id === "stock-ref")?.proOnly, id).toBe(true);
      for (const criterion of subcategoryById(id)!.criteria.filter((item) => item.group === "dossier")) expect(criterion.required, criterion.id).toBeFalsy();
    }
    expect(subcategoryById("voitures")!.criteria.find((criterion) => criterion.id === "car-equipment")?.group).toBe("dossier");
  });

  it("validates a full dossier and rejects out-of-range values", () => {
    expect(criteriaSchema("voitures").safeParse({ ...BASE_ATTRIBUTES, ...FULL_DOSSIER }).success).toBe(true);
    expect(criteriaSchema("voitures").safeParse({ ...BASE_ATTRIBUTES, "warranty-months": 0 }).success).toBe(false);
    expect(criteriaSchema("voitures").safeParse({ ...BASE_ATTRIBUTES, "vehicle-papers": ["carte-grise", "carte-grise"] }).success).toBe(false);
  });

  it("opens the warranty's duration only with a manufacturer's or seller's warranty", () => {
    const months = subcategoryById("voitures")!.criteria.find((criterion) => criterion.id === "warranty-months")!;
    expect(criterionApplies(months, {})).toBe(false);
    expect(criterionApplies(months, { "vehicle-warranty": "aucune" })).toBe(false);
    expect(criterionApplies(months, { "vehicle-warranty": "constructeur" })).toBe(true);
    expect(criterionApplies(months, { "vehicle-warranty": "vendeur" })).toBe(true);
  });
});

describe("readiness of the dossier", () => {
  it("accepts a Pro's full dossier", () => {
    expect(assessReadiness(car(FULL_DOSSIER), PRO)).toEqual([]);
  });

  it("blocks a stock reference from an individual and a duration without a warranty", () => {
    const blockers = issuesByPath(assessReadiness(car({ "stock-ref": "X1", "vehicle-warranty": "aucune", "warranty-months": 6 }, { sellerType: "individual" }), INDIVIDUAL));
    expect(blockers.get("attributes.stock-ref")).toEqual(["pro_only"]);
    expect(blockers.get("attributes.warranty-months")).toEqual(["criterion_invalid"]);
    expect(assessReadiness(car({ "trade-in": true }, { sellerType: "individual" }), INDIVIDUAL)).toEqual([]);
  });
});

describe("credit advertising without the APR", () => {
  it("spots an instalment quoted without TEG, in French, darija and Arabic", () => {
    expect(quotesCreditWithoutApr("Crédit possible : 2 500 DH par mois sans apport")).toBe(true);
    expect(quotesCreditWithoutApr("Mensualités de 1 900 dh sur 60 mois")).toBe(true);
    expect(quotesCreditWithoutApr("Taqsit 3000dh/mois m3a l'banque")).toBe(true);
    expect(quotesCreditWithoutApr("بالتقسيط 3000 درهم شهريا")).toBe(true);
  });

  it("lets through the TEG, a plain price, rent and financing without figures", () => {
    expect(quotesCreditWithoutApr("Crédit : 2 500 DH par mois sur 60 mois, TEG 6,9 %, coût total 150 000 DH, organisme X")).toBe(false);
    expect(quotesCreditWithoutApr("Prix 95 000 DH, entretien tous les 6 mois")).toBe(false);
    expect(quotesCreditWithoutApr("Financement possible, renseignez-vous")).toBe(false);
    expect(quotesCreditWithoutApr("Révisée il y a 2 mois, crédit soldé")).toBe(false);
  });

  const input = (description: string, subcategoryId = "voitures"): ScreenInput => ({
    title: "Dacia Duster 2022",
    description,
    attributes: subcategoryId === "voitures" ? BASE_ATTRIBUTES : { "property-type": "appartement", surface: 80, furnished: false },
    categoryId: subcategoryId === "voitures" ? "vehicules" : "immobilier",
    subcategoryId,
    price: 189_000,
    isDonation: false,
    contact: { showPhone: false, whatsapp: false },
    sensitiveDeclaration: null,
    photos: [{ checks: { nsfw: 0.02, faces: 0 } }],
    seller: { accountAgeDays: 30, listingsLast24h: 0, phoneVerified: true, previousRejections: 0 },
    duplicates: { sameText: 0, samePhoto: 0 },
  });

  it("sends such a listing to a moderator, never a rental", () => {
    const held = screenListing(input("Duster en excellent état. Crédit possible à partir de 2 500 DH par mois, sans apport."), { ai: DEFAULT_AI });
    expect(held.flags).toContain("credit_ad");
    expect(held.state).toBe("needs_review");
    expect(held.blockers).toEqual([]);
    const rent = screenListing(input("Appartement meublé, loyer payable par mois, crédit d'impôt non applicable : 4 000 DH par mois.", "location"), { ai: DEFAULT_AI });
    expect(rent.flags).not.toContain("credit_ad");
  });
});
