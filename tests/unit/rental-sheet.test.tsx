import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { RentalGuide } from "@/components/listing/rental-guide";
import { RentalTerms } from "@/components/listing/rental-terms";
import { DEFAULT_AI } from "@/config/ai";
import { RENTAL_SUBCATEGORY, criteriaFor, criteriaSchema, searchCriteria, subcategoryById } from "@/config/categories";
import { cityBySlug } from "@/config/regions";
import type { Locale } from "@/config/site";
import type { ListingDoc } from "@/lib/db/schemas";
import { assessReadiness, issuesByPath, type SellerFacts } from "@/lib/listings/readiness";
import { rentalDayRate } from "@/lib/listings/rental";
import { rentalReviewReasons } from "@/lib/moderation/rental";
import { screenListing } from "@/lib/moderation/screen";
import type { ScreenInput } from "@/lib/moderation/types";

// Rental pack, rental sheet (design location-voitures/location-voitures.md §2): the criteria and the
// folded rental terms, the cross-field rules, the moderator review and the listing page sections.

const NOW = new Date("2026-10-28T10:00:00.000Z");
const PRO: SellerFacts = { seller: { type: "pro", plan: "business" }, phoneVerified: true };
const marrakech = cityBySlug("marrakech")!;
const VEHICLE = { "rental-class": "berline", "car-brand": "dacia", model: "Logan", gearbox: "manuelle", fuel: "diesel" };
const TERMS = {
  seats: 5,
  "min-rental-days": 3,
  "mileage-policy": "illimite",
  "rental-insurance": "tous-risques-franchise",
  "insurance-excess": 5000,
  "rental-deposit": 4000,
  "driver-min-age": 21,
  "licence-years": 2,
  "vehicle-handover": ["agence", "aeroport"],
  "one-way": true,
  "rental-extras": ["siege-bebe", "gps"],
  "rate-7-days": 260,
  "rate-30-days": 220,
  "fleet-units": 6,
};

function rental(attributes: Record<string, unknown> = {}, overrides: Partial<ListingDoc> = {}): ListingDoc {
  return {
    ownerUid: "uid-1",
    sellerType: "pro",
    sellerName: "Océan Rent",
    sellerPublicId: "abcdefghjk",
    status: "draft",
    title: "Dacia Logan ou similaire à Marrakech",
    description: "Berline diesel climatisée, kilométrage illimité, livraison à l'aéroport Marrakech Menara, tarif dégressif à partir de 7 jours.",
    categoryId: "vehicules",
    subcategoryId: RENTAL_SUBCATEGORY,
    attributes: { ...VEHICLE, ...attributes } as ListingDoc["attributes"],
    price: 300,
    priceNegotiable: false,
    isDonation: false,
    location: { regionCode: marrakech.regionCode, citySlug: marrakech.slug, geo: { lat: marrakech.lat, lng: marrakech.lng } },
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

const codes = (listing: ListingDoc) => issuesByPath(assessReadiness(listing, PRO));

describe("rental criteria", () => {
  it("asks for the vehicle up front and folds the rental terms, the filters a renter needs offered", () => {
    const sub = subcategoryById(RENTAL_SUBCATEGORY)!;
    expect(sub.proOnly).toBe(true);
    expect(sub.priceUnit).toBe("day");
    expect(sub.priceOptional).toBeFalsy();
    expect(sub.criteria.filter((criterion) => criterion.required).map((criterion) => criterion.id)).toEqual(["rental-class", "car-brand", "model", "gearbox", "fuel"]);
    expect(sub.criteria.filter((criterion) => criterion.group === "rental").map((criterion) => criterion.id)).toContain("rental-deposit");
    expect(criteriaFor(sub, "pro")).toHaveLength(sub.criteria.length);
    const filters = searchCriteria("vehicules", RENTAL_SUBCATEGORY).map((criterion) => criterion.id);
    expect(filters).toEqual(expect.arrayContaining(["rental-class", "gearbox", "seats", "min-rental-days", "mileage-policy", "rental-insurance", "vehicle-handover", "one-way"]));
    expect(filters).not.toContain("rental-deposit");
    expect(filters).not.toContain("model");
  });

  it("validates full terms and rejects out-of-range values", () => {
    const schema = criteriaSchema(RENTAL_SUBCATEGORY, "pro");
    expect(schema.safeParse({ ...VEHICLE, ...TERMS }).success).toBe(true);
    expect(schema.safeParse({ ...VEHICLE, "driver-min-age": 17 }).success).toBe(false);
    expect(schema.safeParse({ ...VEHICLE, seats: 12 }).success).toBe(false);
    expect(schema.safeParse({ ...VEHICLE, "vehicle-handover": ["teleportation"] }).success).toBe(false);
  });
});

describe("readiness of a rental", () => {
  it("accepts full terms", () => {
    expect(assessReadiness(rental(TERMS), PRO)).toEqual([]);
  });

  it("needs a day price and keeps long-term rates below it", () => {
    expect(codes(rental({}, { price: null })).get("price")).toEqual(["price_required"]);
    expect(codes(rental({ "rate-7-days": 320 })).get("attributes.rate-7-days")).toEqual(["rental_rate_max"]);
    expect(codes(rental({ "rate-7-days": 260, "rate-30-days": 270 })).get("attributes.rate-30-days")).toEqual(["rental_rate_max"]);
    expect(codes(rental({ "rate-30-days": 301 })).get("attributes.rate-30-days")).toEqual(["rental_rate_max"]);
    expect(codes(rental({ "rate-7-days": 300, "rate-30-days": 300 })).size).toBe(0);
  });

  it("asks the daily allowance of a limited mileage, and refuses one without the limit", () => {
    expect(codes(rental({ "mileage-policy": "limite" })).get("attributes.km-per-day")).toEqual(["criterion_required"]);
    expect(codes(rental({ "mileage-policy": "limite", "km-per-day": 250 })).size).toBe(0);
    expect(codes(rental({ "mileage-policy": "illimite", "km-per-day": 250 })).get("attributes.km-per-day")).toEqual(["criterion_invalid"]);
  });

  it("prices a stay with the longest-term rate that applies", () => {
    expect(rentalDayRate(TERMS, 300, 3)).toBe(300);
    expect(rentalDayRate(TERMS, 300, 7)).toBe(260);
    expect(rentalDayRate(TERMS, 300, 30)).toBe(220);
    expect(rentalDayRate({ "rate-7-days": 260 }, 300, 45)).toBe(260);
  });
});

describe("moderator review of a rental", () => {
  const input = (description: string, attributes: Record<string, unknown> = {}): ScreenInput => ({
    title: "Dacia Logan à louer",
    description,
    attributes: { ...VEHICLE, year: 2024, ...attributes },
    categoryId: "vehicules",
    subcategoryId: RENTAL_SUBCATEGORY,
    price: 300,
    isDonation: false,
    contact: { showPhone: false, whatsapp: false },
    sensitiveDeclaration: null,
    photos: [{ checks: { nsfw: 0.02, faces: 0 } }],
    seller: { accountAgeDays: 30, listingsLast24h: 0, phoneVerified: true, previousRejections: 0 },
    duplicates: { sameText: 0, samePhoto: 0 },
  });

  it("spots a driver, an identity paper or a blank cheque as a guarantee, and an old vehicle", () => {
    const reasons = (text: string, attributes: Record<string, unknown> = {}) => rentalReviewReasons({ subcategoryId: RENTAL_SUBCATEGORY, description: text, attributes: { year: 2024, ...attributes } }, NOW);
    expect(reasons("Location avec chauffeur pour vos mariages.")).toEqual(["rental with driver"]);
    expect(reasons("كراء سيارة مع السائق")).toEqual(["rental with driver"]);
    expect(reasons("Passeport laissé en garantie pendant la location.")).toHaveLength(1);
    expect(reasons("Caution : chèque en blanc.")).toHaveLength(1);
    expect(reasons("Location sans chauffeur, caution par empreinte de carte bancaire.")).toEqual([]);
    expect(reasons("Berline récente.", { year: 2019 })).toEqual(["vehicle from 2019, past the 5-year fleet limit"]);
    expect(reasons("Citadine électrique.", { year: 2020, fuel: "electrique" })).toEqual([]);
    expect(rentalReviewReasons({ subcategoryId: "voitures", description: "Vendue avec chauffeur" }, NOW)).toEqual([]);
  });

  it("holds such a listing for a moderator", () => {
    const held = screenListing(input("Location avec chauffeur, passeport en garantie."), { ai: DEFAULT_AI, now: NOW });
    expect(held.flags).toContain("rental_review");
    expect(held.state).toBe("needs_review");
    const clean = screenListing(input("Location sans chauffeur, kilométrage illimité."), { ai: DEFAULT_AI, now: NOW });
    expect(clean.flags).not.toContain("rental_review");
  });
});

/** Markup with the narrow no-break spaces of grouped digits read as plain spaces. */
function render(node: ReactNode, locale: Locale = "fr") {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
  return html.replace(/[\u00a0\u202f]/g, " ");
}

describe("rental sections of the listing page", () => {
  it("shows the declared terms as highlights, with the agency's sole responsibility", () => {
    const html = render(<RentalTerms subcategoryId={RENTAL_SUBCATEGORY} attributes={{ ...VEHICLE, ...TERMS }} locale="fr" />);
    expect(html).toContain("Conditions de location");
    expect(html).toContain("Kilométrage illimité");
    expect(html).toContain("Location minimum : 3 jours");
    expect(html).toContain("Tous risques avec franchise");
    expect(html).toContain("Franchise de 5 000 DH");
    expect(html).toContain("Caution de 4 000 DH");
    expect(html).toContain("21 ans minimum · permis depuis 2 ans");
    expect(html).toContain("En agence, À l&#x27;aéroport");
    expect(html).toContain("260 DH par jour dès 7 jours · 220 DH par jour dès 30 jours");
    expect(html).toContain("6 véhicules de ce modèle");
    expect(html).toContain("Siège bébé");
    expect(html).toContain("sous sa seule responsabilité");
  });

  it("shows nothing without terms or outside rentals, and renders in Arabic", () => {
    expect(render(<RentalTerms subcategoryId={RENTAL_SUBCATEGORY} attributes={VEHICLE} locale="fr" />)).toBe("");
    expect(render(<RentalTerms subcategoryId="voitures" attributes={{ ...VEHICLE, ...TERMS }} locale="fr" />)).toBe("");
    const html = render(<RentalTerms subcategoryId={RENTAL_SUBCATEGORY} attributes={{ ...VEHICLE, ...TERMS }} locale="ar" />, "ar");
    expect(html).toContain("شروط الكراء");
    expect(html).toContain("ضمانة بمبلغ 4 000 درهم");
  });

  it("guides the renter and says the site rents nothing", () => {
    const html = render(<RentalGuide />);
    expect(html).toContain("Louer un véhicule au Maroc");
    expect(html).toContain("chèque en blanc");
    expect(html).toContain("ne loue pas ce véhicule");
  });
});
