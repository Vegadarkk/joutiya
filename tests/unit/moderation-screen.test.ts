import { describe, expect, it } from "vitest";
import { DEFAULT_AI } from "@/config/ai";
import { screenListing } from "@/lib/moderation/screen";
import type { ScreenInput } from "@/lib/moderation/types";

const ctx = { ai: DEFAULT_AI };

function cleanListing(overrides: Partial<ScreenInput> = {}): ScreenInput {
  return {
    title: "Dacia Logan 2019 diesel",
    description: "Logan 1.5 dCi, 85 000 km, entretien chez le concessionnaire, carnet à jour, 2 clés. Prix 95 000 DH négociable.",
    attributes: { "car-brand": "dacia", model: "Logan", year: 2019, mileage: 85000, fuel: "diesel", gearbox: "manuelle" },
    categoryId: "vehicules",
    subcategoryId: "voitures",
    price: 95_000,
    isDonation: false,
    contact: { showPhone: true, whatsapp: true },
    sensitiveDeclaration: null,
    photos: [{ checks: { nsfw: 0.02, faces: 0 } }, { checks: { nsfw: 0.1, faces: 0 } }],
    seller: { accountAgeDays: 30, listingsLast24h: 0, phoneVerified: true, previousRejections: 0 },
    duplicates: { sameText: 0, samePhoto: 0 },
    ...overrides,
  };
}

const codes = (input: ScreenInput) => screenListing(input, ctx).blockers.map((issue) => `${issue.path}:${issue.code}`);

describe("screenListing: clean listing", () => {
  it("is auto_ok with no flags, no blockers, score 0", () => {
    expect(screenListing(cleanListing(), ctx)).toEqual({ state: "auto_ok", score: 0, flags: [], blockers: [], evidence: [] });
  });

  it("is deterministic", () => {
    const input = cleanListing({ title: "Vends iPhone 13 128 Go", description: "iPhone 13 128 Go, état neuf, facture, 4500 dh. Contact par messagerie uniquement, merci.", photos: [{ checks: { faces: 1 } }] });
    const first = JSON.stringify(screenListing(input, ctx));
    for (let i = 0; i < 5; i += 1) expect(JSON.stringify(screenListing(input, ctx))).toBe(first);
  });
});

describe("screenListing: hard blockers", () => {
  it("blocks phone numbers in the title, description or a free-text attribute, never leaking them in evidence", () => {
    const result = screenListing(cleanListing({ title: "Logan 2019 appelez 06 12 34 56 78", description: "Appelez-moi au o6-12-34-56-78 ou au 0698765432 svp, voiture propre." }), ctx);
    expect(result.blockers).toEqual([
      { path: "title", code: "phone_in_text" },
      { path: "description", code: "phone_in_text" },
    ]);
    expect(result.flags).toContain("third_party_phone");
    expect(result.evidence).toEqual(["phone pattern in title", "phone pattern in description", "2 distinct phone numbers in text"]);
    expect(result.evidence.join(" ")).not.toMatch(/\d{4,}/);
    expect(codes(cleanListing({ attributes: { ...cleanListing().attributes, model: "Logan 0612345678" } }))).toEqual(["attributes.model:phone_in_text"]);
  });

  it("blocks e-mails and links", () => {
    expect(codes(cleanListing({ description: "Voiture propre, écrivez à ahmed@gmail.com ou sur wa.me/212612345678 pour plus de photos." }))).toEqual([
      "description:phone_in_text",
      "description:email_in_text",
      "description:url_in_text",
    ]);
  });

  it("screens the free axes of a Pro listing's variants like the other texts", () => {
    const axes = (label: string, value: string) => [{ label, values: ["500 g", value] }];
    expect(codes(cleanListing({ variantAxes: axes("Contenance", "1 kg") }))).toEqual([]);
    expect(codes(cleanListing({ variantAxes: axes("Contenance", "0612345678") }))).toEqual(["variants.axes.0.values.1:phone_in_text"]);
    expect(codes(cleanListing({ variantAxes: axes("www.vends-ici.ma", "1 kg") }))).toEqual(["variants.axes.0.label:url_in_text"]);
  });

  it("screens the free-text district like the other texts (it is shown on the public page)", () => {
    expect(codes(cleanListing({ district: "Maarif, appelez 0612345678" }))).toEqual(["location.district:phone_in_text"]);
    expect(codes(cleanListing({ district: "Maarif www.vends-ici.ma" }))).toEqual(["location.district:url_in_text"]);
    expect(codes(cleanListing({ district: "Maarif ahmed@gmail.com" }))).toEqual(["location.district:email_in_text"]);
    const hard = screenListing(cleanListing({ district: "Kalachnikov Maarif" }), ctx);
    expect(hard.blockers).toEqual([{ path: "location.district", code: "prohibited" }]);
    expect(hard.evidence).toEqual(["prohibited hard:weapons in location.district"]);
    const sensitive = screenListing(cleanListing({ district: "Chez ma mère malade du cancer" }), ctx);
    expect(sensitive).toMatchObject({ blockers: [], flags: ["sensitive_text"], state: "needs_review" });
    expect(screenListing(cleanListing({ district: "Maarif" }), ctx)).toEqual({ state: "auto_ok", score: 0, flags: [], blockers: [], evidence: [] });
    expect(screenListing(cleanListing({ district: "   " }), ctx).blockers).toEqual([]);
  });

  it("blocks hard prohibited keywords and records the group", () => {
    const result = screenListing(cleanListing({ title: "Kalachnikov de collection" }), ctx);
    expect(result.blockers).toEqual([{ path: "title", code: "prohibited" }]);
    expect(result.flags).toEqual(["prohibited_kw"]);
    expect(result.state).toBe("needs_review");
    expect(result.evidence).toEqual(["prohibited hard:weapons in title"]);
  });

  it("blocks missing, invalid and unknown criteria", () => {
    expect(codes(cleanListing({ attributes: { "car-brand": "dacia", model: "", year: "2019" as unknown as number, mileage: 85000, fuel: "plasma", gearbox: "manuelle", extra: "x" } }))).toEqual([
      "attributes.model:required",
      "attributes.year:invalid",
      "attributes.fuel:invalid",
      "attributes.extra:unknown",
    ]);
    expect(codes(cleanListing({ attributes: {} }))).toEqual(["attributes.car-brand:required", "attributes.model:required", "attributes.year:required", "attributes.mileage:required", "attributes.fuel:required", "attributes.gearbox:required"]);
  });

  it("blocks an unknown subcategory or a category mismatch", () => {
    expect(codes(cleanListing({ subcategoryId: "nope" }))).toEqual(["subcategoryId:unknown"]);
    expect(codes(cleanListing({ subcategoryId: "" }))).toEqual(["subcategoryId:required"]);
    expect(codes(cleanListing({ categoryId: "immobilier" }))).toEqual(["categoryId:invalid"]);
  });

  it("applies the price and donation rules of the subcategory (D4)", () => {
    expect(codes(cleanListing({ price: null }))).toEqual(["price:required"]);
    expect(codes(cleanListing({ price: null, isDonation: true }))).toEqual(["isDonation:not_allowed"]);
    expect(codes(cleanListing({ categoryId: "services", subcategoryId: "cours", attributes: { "course-subject": "langues" }, price: null }))).toEqual([]);
    expect(codes(cleanListing({ categoryId: "vehicules", subcategoryId: "velos", attributes: { "bike-type": "vtt" }, price: null, isDonation: true }))).toEqual([]);
  });

  it("requires a verified phone for showPhone and WhatsApp", () => {
    const seller = { ...cleanListing().seller, phoneVerified: false };
    expect(codes(cleanListing({ seller }))).toEqual(["contact.showPhone:phone_required", "contact.whatsapp:phone_required"]);
    expect(codes(cleanListing({ seller, contact: { showPhone: false, whatsapp: false } }))).toEqual([]);
  });
});

describe("screenListing: adults-only subcategory (decorative koumiyas)", () => {
  const koumiya = (overrides: Partial<ScreenInput> = {}) =>
    cleanListing({
      title: "Koumiya décorative en cuivre ciselé",
      description: "Koumiya de décoration faite à la main par un artisan de Fès, fourreau en cuivre ciselé, à accrocher au mur.",
      attributes: { material: "cuivre", handmade: true },
      categoryId: "maison-jardin",
      subcategoryId: "koumiyas-decoratives",
      price: 1_200,
      contact: { showPhone: false, whatsapp: false },
      ...overrides,
    });

  it("always sends the listing to a moderator, without adding risk points", () => {
    const result = screenListing(koumiya(), ctx);
    expect(result).toMatchObject({ state: "needs_review", flags: ["restricted_category"], score: 0, blockers: [] });
    // Dagger words are expected here: noted for the moderator, not flagged as risky vocabulary.
    expect(result.evidence).toEqual(["adults-only subcategory koumiyas-decoratives", "prohibited soft:weapons in title", "prohibited soft:weapons in description"]);
    const drugs = screenListing(koumiya({ description: "Koumiya décorative en cuivre, faite à la main, livrée avec un sachet de kif en cadeau pour la décoration." }), ctx);
    expect(drugs.flags).toEqual(["prohibited_soft", "restricted_category"]);
  });

  it("keeps the contact to the messaging, even with a verified phone", () => {
    expect(codes(koumiya({ contact: { showPhone: true, whatsapp: true } }))).toEqual(["contact.showPhone:messaging_only", "contact.whatsapp:messaging_only"]);
  });

  it("refuses a donation and flags koumiya words anywhere else for review", () => {
    expect(codes(koumiya({ price: null, isDonation: true }))).toEqual(["isDonation:not_allowed"]);
    const elsewhere = screenListing(cleanListing({ description: "Vends ma Logan, et aussi une koumiya ancienne en argent, à voir sur place." }), ctx);
    expect(elsewhere.flags).toEqual(["prohibited_soft"]);
    expect(elsewhere.state).toBe("needs_review");
  });
});

describe("screenListing: soft flags and state", () => {
  it("sends soft keywords and sensitive text to review", () => {
    const soft = screenListing(cleanListing({ description: "Voiture propre, vends aussi un pistolet à colle et des outils, le tout en bon état." }), ctx);
    expect(soft.blockers).toEqual([]);
    expect(soft.flags).toEqual(["prohibited_soft"]);
    expect(soft.state).toBe("needs_review");
    expect(soft.evidence).toEqual(["prohibited soft:weapons in description"]);

    const sensitive = screenListing(cleanListing({ description: "Voiture de ma mère décédée du cancer, très peu roulé, entretien complet chez Dacia." }), ctx);
    expect(sensitive.flags).toEqual(["sensitive_text"]);
    expect(sensitive.state).toBe("needs_review");
    expect(sensitive.evidence).toEqual(["sensitive health vocabulary near a person marker in description"]);
  });

  it("sends a photo kept with a face to a moderator, in every category (the wizard proposed a crop)", () => {
    const car = screenListing(cleanListing({ photos: [{ checks: { faces: 2 } }] }), ctx);
    expect(car).toMatchObject({ state: "needs_review", score: 0, flags: ["face"], evidence: ["face on photo 1"] });
    const baby = screenListing(cleanListing({ categoryId: "famille", subcategoryId: "equipement-bebe", attributes: { "baby-type": "poussette" }, price: 800, photos: [{}, { checks: { faces: 1 } }] }), ctx);
    expect(baby).toMatchObject({ state: "needs_review", flags: ["face"], evidence: ["face on photo 2"] });
  });

  it("flags nudity in the review band and above (a rejected photo should not reach the screen)", () => {
    const band = screenListing(cleanListing({ photos: [{ checks: { nsfw: 0.7 } }] }), ctx);
    expect(band).toMatchObject({ state: "needs_review", flags: ["nsfw_review"], evidence: ["nsfw 0.70 on photo 1"] });
    const above = screenListing(cleanListing({ photos: [{ checks: { nsfw: 0.9 } }] }), ctx);
    expect(above.evidence).toEqual(["nsfw 0.90 on photo 1 (above reject threshold)"]);
    expect(screenListing(cleanListing({ photos: [{ checks: { nsfw: 0.59 } }] }), ctx).flags).toEqual([]);
    const custom = screenListing(cleanListing({ photos: [{ checks: { nsfw: 0.5 } }] }), { ai: { ...DEFAULT_AI, nsfw: { reviewAt: 0.4, rejectAt: 0.9 } } });
    expect(custom.flags).toEqual(["nsfw_review"]);
  });

  it("flags implausible prices, not donations or 'à discuter'", () => {
    expect(screenListing(cleanListing({ price: 500 }), ctx)).toMatchObject({ state: "auto_ok", score: 20, flags: ["price_outlier"], evidence: ["price 500 outside 15000-2000000 (voitures)"] });
    expect(screenListing(cleanListing({ price: 9_000_000 }), ctx).flags).toEqual(["price_outlier"]);
    expect(screenListing(cleanListing({ price: 0 }), ctx).flags).toEqual(["price_outlier"]);
    expect(screenListing(cleanListing({ price: 5_000 }), ctx).flags).toEqual([]);
    expect(screenListing(cleanListing({ categoryId: "vehicules", subcategoryId: "velos", attributes: { "bike-type": "vtt" }, price: 0, isDonation: true }), ctx).flags).toEqual([]);
  });

  it("combines weak signals: new account + volume + outlier stay auto_ok, a duplicate tips them over", () => {
    const seller = { accountAgeDays: 0, listingsLast24h: 3, phoneVerified: true, previousRejections: 0 };
    const weak = screenListing(cleanListing({ seller, price: 500 }), ctx);
    expect(weak).toMatchObject({ state: "auto_ok", score: 50, flags: ["price_outlier", "new_account", "volume"] });
    const tipped = screenListing(cleanListing({ seller, price: 500, duplicates: { sameText: 1, samePhoto: 0 } }), ctx);
    expect(tipped).toMatchObject({ state: "needs_review", score: 80, flags: ["price_outlier", "dup_text", "new_account", "volume"] });
    expect(tipped.evidence).toContain("same text as 1 listing(s)");
    expect(screenListing(cleanListing({ duplicates: { sameText: 0, samePhoto: 2 } }), ctx)).toMatchObject({ state: "auto_ok", score: 30, flags: ["dup_photo"] });
    expect(screenListing(cleanListing({ duplicates: { sameText: 1, samePhoto: 1 } }), ctx).state).toBe("needs_review");
  });

  it("counts previous rejections in the score without a flag, and notes the declaration", () => {
    const seller = { ...cleanListing().seller, previousRejections: 2 };
    const result = screenListing(cleanListing({ seller, sensitiveDeclaration: { kind: "self" } }), ctx);
    expect(result).toMatchObject({ state: "auto_ok", score: 20, flags: [] });
    expect(result.evidence).toEqual(["2 previous rejection(s)", "declaration self"]);
    expect(screenListing(cleanListing({ seller, duplicates: { sameText: 2, samePhoto: 0 } }), ctx).score).toBe(50);
  });

  it("works on Arabic text", () => {
    const blocked = screenListing(cleanListing({ title: "داسيا لوغان 2019", description: "سيارة في حالة جيدة، اتصل على ٠٦١٢٣٤٥٦٧٨ أو عبر الرسائل، الثمن قابل للنقاش." }), ctx);
    expect(blocked.blockers).toEqual([{ path: "description", code: "phone_in_text" }]);
    const hard = screenListing(cleanListing({ description: "سيارة في حالة جيدة مع بندقية صيد هدية، الثمن قابل للنقاش، للجادين فقط." }), ctx);
    expect(hard.blockers).toEqual([{ path: "description", code: "prohibited" }]);
    const soft = screenListing(cleanListing({ description: "سيارة في حالة جيدة، كانت لوالدي المريض بالسكري، الثمن قابل للنقاش." }), ctx);
    expect(soft).toMatchObject({ blockers: [], flags: ["sensitive_text"], state: "needs_review" });
  });
});

describe("screenListing: food with an ONSSA number", () => {
  const honey = (sanitaryNumbers?: readonly string[], number = "M.07.113.20") =>
    cleanListing({
      title: "Miel de thym 500 g",
      description: "Miel de thym récolté cet été, pot en verre de 500 g, non chauffé.",
      attributes: { "onssa-number": number, "honey-type": "thym" },
      categoryId: "terroir",
      subcategoryId: "miel",
      price: 220,
      seller: { accountAgeDays: 30, listingsLast24h: 0, phoneVerified: true, previousRejections: 0, ...(sanitaryNumbers ? { sanitaryNumbers } : {}) },
    });

  it("sends a number new for the shop to a moderator, without risk points", () => {
    expect(screenListing(honey(), ctx)).toMatchObject({ state: "needs_review", flags: ["sanitary_check"], score: 0, blockers: [], evidence: ["ONSSA number M.07.113.20 not yet checked for this shop"] });
    expect(screenListing(honey(["HFO.24.07.15"]), ctx).flags).toEqual(["sanitary_check"]);
  });

  it("lets a number a moderator already checked through", () => {
    expect(screenListing(honey(["HFO.24.07.15", "M.07.113.20"]), ctx)).toMatchObject({ state: "auto_ok", flags: [], blockers: [] });
  });

  it("leaves a malformed number to the criteria check, and other subcategories alone", () => {
    const malformed = screenListing(honey(undefined, "M07113"), ctx);
    expect(malformed.blockers).toEqual([{ path: "attributes.onssa-number", code: "invalid" }]);
    expect(malformed.flags).not.toContain("sanitary_check");
    expect(screenListing(cleanListing(), ctx).flags).not.toContain("sanitary_check");
  });
});
