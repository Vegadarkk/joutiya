import { describe, expect, it } from "vitest";
import type { OwnerListing } from "@/lib/contracts/listings";
import { parseWizardPath, wizardPath } from "@/lib/listings/client/routes";
import { allIssues, firstIncompleteStep, nextStep, previousStep, stepIssues, stepOfPath, stepState } from "@/lib/listings/client/validation";

// Per-step readiness of the wizard (design D3/D4), derived from the shared contracts.

function draft(overrides: Partial<OwnerListing> = {}): OwnerListing {
  return {
    id: "abcdefgh",
    slugId: null,
    status: "draft",
    pausedReason: null,
    categoryId: null,
    subcategoryId: null,
    title: "",
    description: "",
    attributes: {},
    condition: null,
    price: null,
    priceNegotiable: false,
    isDonation: false,
    location: null,
    photos: [],
    contact: { showPhone: false, whatsapp: false },
    sensitiveDeclaration: null,
    moderation: { state: "auto_ok", flags: [] },
    version: 1,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    publishedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

const car = draft({
  categoryId: "vehicules",
  subcategoryId: "voitures",
  title: "Dacia Logan 2019 diesel",
  description: "Logan 1.5 dCi, 85 000 km, entretien chez le concessionnaire, carnet à jour.",
  attributes: { "car-brand": "dacia", model: "Logan", year: 2019, mileage: 85000, fuel: "diesel", gearbox: "manuelle" },
  condition: "very_good",
  price: 95000,
  location: { regionCode: "06", citySlug: "casablanca" },
  photos: [{ id: "upload0001", status: "ready", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }],
});

describe("stepIssues", () => {
  it("accepts a complete listing on every step", () => {
    expect(allIssues(car)).toEqual([]);
    expect(firstIncompleteStep(car)).toBe("apercu");
  });

  it("needs a subcategory before anything else", () => {
    const empty = draft();
    expect(stepIssues("categorie", empty).map((i) => i.code)).toContain("category_required");
    expect(stepIssues("criteres", empty)).toEqual([{ path: "subcategoryId", code: "subcategory_required" }]);
    expect(firstIncompleteStep(empty)).toBe("categorie");
    expect(stepIssues("categorie", draft({ categoryId: "vehicules", subcategoryId: "vente" })).map((i) => i.code)).toEqual(["subcategory_required"]);
  });

  it("reports missing and out-of-range criteria with stable codes", () => {
    const issues = stepIssues("criteres", { ...car, attributes: { "car-brand": "dacia", model: "", year: 1800, fuel: "kerosene" } });
    const byPath = Object.fromEntries(issues.map((i) => [i.path, i.code]));
    expect(byPath["attributes.model"]).toBe("criterion_required");
    expect(byPath["attributes.year"]).toBe("criterion_min");
    expect(byPath["attributes.fuel"]).toBe("criterion_invalid");
    expect(byPath["attributes.mileage"]).toBe("criterion_required");
    expect(byPath["attributes.gearbox"]).toBe("criterion_required");
  });

  it("requires the condition only where the subcategory says so", () => {
    const phone = draft({ categoryId: "electronique", subcategoryId: "telephones-objets-connectes", attributes: { "phone-device-type": "smartphone", "phone-brand": "samsung" } });
    expect(stepIssues("criteres", phone)).toEqual([{ path: "condition", code: "condition_required" }]);
    expect(stepIssues("criteres", { ...car, condition: null })).toEqual([]);
    // Real-estate sales have no condition at all: a value there is refused.
    const flat = draft({ categoryId: "immobilier", subcategoryId: "vente", attributes: { "property-type": "appartement", surface: 80 }, condition: "good" });
    expect(stepIssues("criteres", flat).map((i) => i.path)).toEqual(["condition"]);
  });

  it("checks title and description bounds", () => {
    expect(stepIssues("titre", { ...car, title: "Abc" })).toEqual([{ path: "title", code: "title_min" }]);
    expect(stepIssues("titre", { ...car, title: "x".repeat(71) })).toEqual([{ path: "title", code: "title_max" }]);
    expect(stepIssues("description", { ...car, description: "trop court" })).toEqual([{ path: "description", code: "description_min" }]);
  });

  it("applies the price rules of D4", () => {
    expect(stepIssues("prix", { ...car, price: null })).toEqual([{ path: "price", code: "price_required" }]);
    expect(stepIssues("prix", { ...car, price: null, isDonation: true })).toEqual([]);
    expect(stepIssues("prix", { ...car, price: 100_000_001 })).toEqual([{ path: "price", code: "price_max" }]);
    const service = draft({ categoryId: "services", subcategoryId: "cours", attributes: { "course-subject": "langues" } });
    expect(stepIssues("prix", service)).toEqual([]);
  });

  it("requires a known city in its region", () => {
    expect(stepIssues("lieu", { ...car, location: null }).map((i) => i.code)).toEqual(["city_required"]);
    expect(stepIssues("lieu", { ...car, location: { regionCode: "01", citySlug: "casablanca" } }).map((i) => i.code)).toEqual(["city_required"]);
    expect(stepIssues("lieu", { ...car, location: { regionCode: "06", citySlug: "casablanca", district: "x".repeat(65) } }).map((i) => i.code)).toEqual(["district_max"]);
  });

  it("lets photos be empty (the server decides) but caps them", () => {
    expect(stepIssues("photos", { ...car, photos: [] })).toEqual([]);
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `upload000${i}`, status: "ready" as const, w: 1, h: 1, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }));
    expect(stepIssues("photos", { ...car, photos: many }, { maxPhotos: 10 })).toEqual([{ path: "photos", code: "photos_max" }]);
  });

  it("tells empty steps apart from incomplete ones", () => {
    expect(stepState("titre", draft())).toBe("empty");
    expect(stepState("titre", draft({ title: "ab" }))).toBe("incomplete");
    expect(stepState("titre", car)).toBe("complete");
    expect(stepState("apercu", car)).toBe("incomplete");
  });

  it("resumes at the first incomplete step", () => {
    expect(firstIncompleteStep({ ...car, description: "" })).toBe("description");
    expect(firstIncompleteStep({ ...car, location: null })).toBe("lieu");
  });
});

describe("step navigation helpers", () => {
  it("maps blocker paths to steps", () => {
    expect(stepOfPath("title")).toBe("titre");
    expect(stepOfPath("attributes.year")).toBe("criteres");
    expect(stepOfPath("condition")).toBe("criteres");
    expect(stepOfPath("location.citySlug")).toBe("lieu");
    expect(stepOfPath("contact.showPhone")).toBe("contact");
    expect(stepOfPath("photos")).toBe("photos");
    expect(stepOfPath("isDonation")).toBe("prix");
    expect(stepOfPath("whatever")).toBe("apercu");
  });

  it("walks the steps in order", () => {
    expect(nextStep("categorie")).toBe("criteres");
    expect(previousStep("categorie")).toBeNull();
    expect(nextStep("apercu")).toBeNull();
    expect(previousStep("apercu")).toBe("contact");
  });

  it("builds and parses wizard paths", () => {
    expect(wizardPath("abcdefgh")).toBe("/deposer/abcdefgh");
    expect(wizardPath("abcdefgh", "titre")).toBe("/deposer/abcdefgh/titre");
    expect(parseWizardPath("/fr/deposer")).toEqual({ id: null, screen: null, invalid: false });
    expect(parseWizardPath("/deposer/abcdefgh")).toEqual({ id: "abcdefgh", screen: null, invalid: false });
    expect(parseWizardPath("/ar/deposer/abcdefgh/photos")).toEqual({ id: "abcdefgh", screen: "photos", invalid: false });
    expect(parseWizardPath("/deposer/abcdefgh/termine")).toEqual({ id: "abcdefgh", screen: "termine", invalid: false });
    expect(parseWizardPath("/deposer/abcdefgh/nope").invalid).toBe(true);
    expect(parseWizardPath("/deposer/ABCDEFGH").invalid).toBe(true);
    expect(parseWizardPath("/deposer/abcdefgh/titre/extra").invalid).toBe(true);
  });
});
