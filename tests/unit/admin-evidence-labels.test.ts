import { describe, expect, it } from "vitest";
import { catalogLabels, evidenceLabel } from "@/app/admin/_components/moderation-labels";
import { DEFAULT_AI } from "@/config/ai";
import { screenListing } from "@/lib/moderation/screen";
import type { ScreenInput } from "@/lib/moderation/types";

// The back office shows the pre-moderation evidence in French (the screen writes it in English).
// Every line the screen can produce is translated: a rule added there without a label here fails.

const ctx = { ai: DEFAULT_AI };

function listing(overrides: Partial<ScreenInput> = {}): ScreenInput {
  return {
    title: "Dacia Logan 2019 diesel",
    description: "Logan 1.5 dCi, 85 000 km, entretien chez le concessionnaire, carnet à jour, 2 clés.",
    attributes: { "car-brand": "dacia", model: "Logan", year: 2019, mileage: 85000, fuel: "diesel", gearbox: "manuelle" },
    categoryId: "vehicules",
    subcategoryId: "voitures",
    price: 95_000,
    isDonation: false,
    contact: { showPhone: false, whatsapp: false },
    sensitiveDeclaration: null,
    photos: [{ checks: { nsfw: 0.02, faces: 0 } }],
    seller: { accountAgeDays: 30, listingsLast24h: 0, phoneVerified: true, previousRejections: 0 },
    duplicates: { sameText: 0, samePhoto: 0 },
    ...overrides,
  };
}

const SCENARIOS: Partial<ScreenInput>[] = [
  { title: "Logan 2019 appelez 06 12 34 56 78", description: "Appelez-moi au 0698765432 svp, voiture propre et entretenue." },
  { description: "Voiture propre, écrivez à ahmed@gmail.com ou sur www.vends-ici.ma pour plus de photos." },
  { attributes: { "car-brand": "dacia", model: "Logan 0612345678", year: 2019, mileage: 85000, fuel: "diesel", gearbox: "manuelle" } },
  { district: "Kalachnikov Maarif" },
  { description: "Voiture propre, vends aussi un pistolet à colle et des outils, le tout en bon état." },
  { description: "Voiture de ma mère décédée du cancer, très peu roulé. Location pour musulmans uniquement. Gay friendly." },
  { description: "Paiement par virement IBAN MA64011519000001205000534921 ou RIB 230 810 1234567890123456 78, carte 4539 1488 0343 6467, CIN AB123456." },
  { photos: [{ checks: { faces: 2, nsfw: 0.7 } }, { checks: { nsfw: 0.95 } }] },
  { price: 500 },
  { duplicates: { sameText: 1, samePhoto: 3 } },
  { seller: { accountAgeDays: 0, listingsLast24h: 3, phoneVerified: true, previousRejections: 2 }, sensitiveDeclaration: { kind: "explicit_consent" } },
  { seller: { accountAgeDays: 1, listingsLast24h: 5, phoneVerified: true, previousRejections: 1 }, sensitiveDeclaration: { kind: "self" } },
];

/** English words of the screen's evidence that must not reach the moderator. */
const ENGLISH = /(?<!\p{L})(in|on|pattern|vocabulary|marker|outside|listings?|account|age|days?|previous|rejections?|declaration|distinct|numbers?|text|same|face|above|threshold|hard|soft|sensitive|prohibited|email|url|phone)(?!\p{L})/u;

describe("evidence labels of the moderation review", () => {
  it("translates every evidence line the screen produces", async () => {
    const labels = await catalogLabels();
    const lines = new Set<string>();
    for (const scenario of SCENARIOS) for (const line of screenListing(listing(scenario), ctx).evidence) lines.add(line);
    // Every kind of line is covered by the scenarios above.
    expect(lines.size).toBeGreaterThanOrEqual(20);
    for (const line of lines) {
      const label = labels.evidence(line);
      expect(label, line).not.toBe(line);
      expect(label, line).not.toMatch(ENGLISH);
    }
  });

  it("names the field, the group and the photo in French", async () => {
    const labels = await catalogLabels();
    expect(labels.evidence("phone pattern in title")).toBe("Numéro de téléphone dans le titre");
    expect(labels.evidence("url in location.district")).toBe("Lien dans le quartier");
    expect(labels.evidence("email in attributes.model")).toBe("Adresse e-mail dans le critère « Modèle »");
    expect(labels.evidence("prohibited hard:weapons in description")).toBe("Mot-clé interdit (armes) dans la description");
    expect(labels.evidence("prohibited soft:drugs in title")).toBe("Vocabulaire à risque (drogues) dans le titre");
    expect(labels.evidence("sensitive health vocabulary near a person marker in description")).toBe("Donnée sensible (santé, près d'une mention de personne) dans la description");
    expect(labels.evidence("sensitive iban pattern in description")).toBe("Donnée sensible (IBAN) dans la description");
    expect(labels.evidence("2 distinct phone numbers in text")).toBe("2 numéros de téléphone différents dans les textes");
    expect(labels.evidence("nsfw 0.90 on photo 2 (above reject threshold)")).toBe("Nudité probable (score 0,90) sur la photo 2, au-delà du seuil de refus");
    expect(labels.evidence("3 listings in 24h")).toBe("3 annonces en 24 h");
    expect(labels.evidence("same text as 1 listing(s)")).toBe("Même texte que 1 autre annonce du vendeur");
    expect(labels.evidence("account age 0 day(s)")).toBe("Compte créé aujourd'hui");
    expect(labels.evidence("1 previous rejection(s)")).toBe("1 refus antérieur");
    expect(labels.evidence("declaration self")).toBe("Déclaration du vendeur : le vendeur est la personne concernée");
    expect(labels.evidence("ONSSA number M.07.113.20 not yet checked for this shop")).toMatch(/^N° ONSSA M\.07\.113\.20 encore jamais vérifié pour cette boutique/);
  });

  it("formats the price range in dirhams with the subcategory's name", async () => {
    const labels = await catalogLabels();
    const group = (value: number) => new Intl.NumberFormat("fr-FR").format(value);
    expect(labels.evidence("price 500 outside 15000-2000000 (voitures)")).toBe(`Prix de 500 DH hors de la fourchette habituelle ${group(15000)}–${group(2000000)} DH (Véhicules › Voitures)`);
    expect(labels.evidence("price 0 outside ?-? (inconnue)")).toBe("Prix de 0 DH hors de la fourchette habituelle ?–? DH (Sans catégorie)");
  });

  it("shows a line it does not know unchanged", () => {
    expect(evidenceLabel("something new in title", { category: () => "", criterion: (id) => id })).toBe("something new in title");
  });
});
