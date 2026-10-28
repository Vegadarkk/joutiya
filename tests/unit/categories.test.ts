import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import {
  CAR_BRANDS,
  CATEGORIES,
  CATEGORY_IDS,
  CONDITIONS,
  CRITERIA,
  CRITERION_IDS,
  CRITERION_TEXT_MAX,
  CRITERION_TYPES,
  CRITERION_UNITS,
  DOSSIER_CRITERIA_MAX,
  MAIN_CRITERIA_MAX,
  PRO_CRITERIA_MAX,
  PRICE_UNITS,
  SUBCATEGORY_IDS,
  categoryById,
  criteriaFor,
  criteriaSchema,
  criterionById,
  searchCriteria,
  subcategoryById,
} from "@/config/categories";

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
type Labels = { Categories: Record<string, { name: string; sub: Record<string, string> }>; Criteria: Record<string, { label: string; options?: Record<string, string> }> };
const messages: Record<"fr" | "ar", Labels> = { fr: fr as unknown as Labels, ar: ar as unknown as Labels };

describe("category tree", () => {
  it("has the 11 categories of the product research, each with subcategories", () => {
    expect(CATEGORY_IDS).toEqual(["vehicules", "immobilier", "electronique", "maison-jardin", "mode", "famille", "loisirs", "animaux", "materiel-pro", "services", "divers"]);
    for (const category of CATEGORIES) expect(category.subcategories.length, category.id).toBeGreaterThan(0);
    expect(SUBCATEGORY_IDS.length).toBeGreaterThanOrEqual(50);
  });

  it("uses kebab-case ASCII ids everywhere, unique where they index something", () => {
    expect(new Set(CATEGORY_IDS).size).toBe(CATEGORY_IDS.length);
    expect(new Set(SUBCATEGORY_IDS).size).toBe(SUBCATEGORY_IDS.length);
    for (const category of CATEGORIES) {
      expect(category.id).toMatch(KEBAB);
      for (const subcategory of category.subcategories) {
        expect(subcategory.id).toMatch(KEBAB);
        expect(subcategory.categoryId).toBe(category.id);
        const fieldIds = subcategory.criteria.map((criterion) => criterion.id);
        expect(new Set(fieldIds).size, subcategory.id).toBe(fieldIds.length);
      }
    }
    for (const id of CRITERION_IDS) {
      expect(id).toMatch(KEBAB);
      const field = CRITERIA[id];
      expect(field.id).toBe(id);
      expect(CRITERION_TYPES).toContain(field.type);
      if (field.unit) expect(CRITERION_UNITS).toContain(field.unit);
      if (field.options) {
        expect(field.options.length).toBeGreaterThan(1);
        expect(new Set(field.options).size, id).toBe(field.options.length);
        for (const option of field.options) expect(option, `${id}.${option}`).toMatch(KEBAB);
      }
      if (field.type === "select" || field.type === "multiselect") expect(field.options, id).toBeDefined();
      else expect(field.options, id).toBeUndefined();
      if (field.type === "number") {
        expect(field.min, id).toBeDefined();
        expect(field.max, id).toBeDefined();
        expect(field.min ?? 0).toBeLessThan(field.max ?? 0);
      }
    }
  });

  it("keeps the criteria small (main ones, Pro-only ones and the folded dossier capped) and every field used by a subcategory", () => {
    const used = new Set<string>();
    for (const category of CATEGORIES) {
      for (const subcategory of category.subcategories) {
        const main = subcategory.criteria.filter((criterion) => !criterion.group);
        expect(main.filter((criterion) => !criterion.proOnly).length, subcategory.id).toBeLessThanOrEqual(MAIN_CRITERIA_MAX);
        expect(main.filter((criterion) => criterion.proOnly).length, subcategory.id).toBeLessThanOrEqual(PRO_CRITERIA_MAX);
        expect(subcategory.criteria.filter((criterion) => criterion.group === "dossier").length, subcategory.id).toBeLessThanOrEqual(DOSSIER_CRITERIA_MAX);
        for (const criterion of subcategory.criteria) used.add(criterion.id);
        if (subcategory.priceUnit) expect(PRICE_UNITS).toContain(subcategory.priceUnit);
      }
    }
    expect([...used].sort()).toEqual([...CRITERION_IDS].sort());
  });

  it("looks up categories, subcategories and fields by id", () => {
    expect(categoryById("vehicules")?.subcategories.map((s) => s.id)).toContain("voitures");
    expect(categoryById("nope")).toBeUndefined();
    expect(subcategoryById("voitures")?.categoryId).toBe("vehicules");
    expect(subcategoryById("voitures")?.condition).toBe("optional");
    expect(subcategoryById("location")).toMatchObject({ priceUnit: "month", priceOptional: true });
    expect(subcategoryById("location-vacances")?.priceUnit).toBe("night");
    expect(subcategoryById("location-voitures")?.proOnly).toBe(true);
    expect(subcategoryById("nope")).toBeUndefined();
    expect(criterionById("year")?.unit).toBe("an");
    expect(criterionById("__proto__")).toBeUndefined();
    expect(criterionById("toString")).toBeUndefined();
  });

  it("lists about 60 car brands plus `autre`, used by the car fields", () => {
    expect(CAR_BRANDS.length).toBeGreaterThanOrEqual(55);
    expect(CAR_BRANDS.at(-1)).toBe("autre");
    expect(CAR_BRANDS).toContain("dacia");
    expect(new Set(CAR_BRANDS).size).toBe(CAR_BRANDS.length);
    expect(CRITERIA["car-brand"].options).toBe(CAR_BRANDS);
    expect(CONDITIONS).toEqual(["new_tagged", "like_new", "very_good", "good", "for_parts"]);
  });
});

describe("criteriaSchema", () => {
  it("builds a strict schema for every subcategory", () => {
    for (const id of SUBCATEGORY_IDS) {
      const schema = criteriaSchema(id);
      expect(schema.safeParse({ unknownField: 1 }).success, id).toBe(false);
      expect(criteriaSchema(id)).toBe(schema);
    }
    expect(() => criteriaSchema("nope")).toThrow(RangeError);
  });

  it("validates a car: required fields, enums, integer bounds, free text", () => {
    const schema = criteriaSchema("voitures");
    const car = { "car-brand": "dacia", model: "Logan", year: 2019, mileage: 85000, fuel: "diesel", gearbox: "manuelle" };
    expect(schema.safeParse(car).success).toBe(true);
    expect(schema.safeParse({ ...car, "fiscal-power": 6, origin: "ww-maroc", "first-hand": true, doors: "5" }).success).toBe(true);
    expect(schema.safeParse({ ...car, fuel: "kerosene" }).success).toBe(false);
    expect(schema.safeParse({ ...car, year: 1900 }).success).toBe(false);
    expect(schema.safeParse({ ...car, year: 2019.5 }).success).toBe(false);
    expect(schema.safeParse({ ...car, mileage: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...car, model: "x".repeat(CRITERION_TEXT_MAX + 1) }).success).toBe(false);
    expect(schema.safeParse({ ...car, model: "  " }).success).toBe(false);
    expect(schema.safeParse({ ...car, "first-hand": "oui" }).success).toBe(false);
    const { model: _model, ...noModel } = car;
    expect(schema.safeParse(noModel).success).toBe(false);
  });

  it("validates multiselects as unique option ids and accepts an empty object where nothing is required", () => {
    const sale = criteriaSchema("vente");
    const flat = { "property-type": "appartement", surface: 90 };
    expect(sale.safeParse({ ...flat, amenities: ["parking", "ascenseur"] }).success).toBe(true);
    expect(sale.safeParse({ ...flat, amenities: ["parking", "parking"] }).success).toBe(false);
    expect(sale.safeParse({ ...flat, amenities: ["jacuzzi"] }).success).toBe(false);
    expect(sale.safeParse({ ...flat, amenities: "parking" }).success).toBe(false);
    expect(criteriaSchema("autres").safeParse({}).success).toBe(true);
    expect(criteriaSchema("autres").safeParse({ brand: "x" }).success).toBe(false);
  });

  it("binds the Pro-only criteria to Pros: hidden from individuals, required for Pros, optional when the seller is unknown", () => {
    const flat = { "property-type": "appartement", surface: 90 };
    const agency = { ...flat, mandate: "exclusif", "agency-fees": "en-sus", "agency-fees-amount": 25000, "agency-reference": "CASA-118" };
    expect(criteriaSchema("vente", "individual").safeParse(flat).success).toBe(true);
    expect(criteriaSchema("vente", "individual").safeParse({ ...flat, mandate: "exclusif" }).success).toBe(false);
    expect(criteriaSchema("vente", "pro").safeParse(flat).success).toBe(false);
    expect(criteriaSchema("vente", "pro").safeParse(agency).success).toBe(true);
    expect(criteriaSchema("vente", "pro").safeParse({ ...agency, mandate: "verbal" }).success).toBe(false);
    expect(criteriaSchema("vente").safeParse(flat).success).toBe(true);
    expect(criteriaSchema("vente").safeParse(agency).success).toBe(true);
    expect(criteriaSchema("vente", "pro")).not.toBe(criteriaSchema("vente", "individual"));
    const sale = subcategoryById("vente")!;
    expect(criteriaFor(sale, "individual").some((criterion) => criterion.proOnly)).toBe(false);
    expect(criteriaFor(sale, "pro").map((criterion) => criterion.id)).toEqual(expect.arrayContaining(["mandate", "agency-fees", "off-plan"]));
  });
});

describe("searchCriteria", () => {
  it("offers a subcategory's criteria, or the category's shared filters before one is chosen, never free text", () => {
    expect(searchCriteria("immobilier", undefined).map((criterion) => criterion.id)).toEqual(["property-type", "surface", "rooms", "bedrooms"]);
    expect(searchCriteria("immobilier", undefined).some((criterion) => criterion.required)).toBe(false);
    expect(searchCriteria("immobilier", "location").map((criterion) => criterion.id)).toContain("deposit");
    expect(searchCriteria("immobilier", "vente").map((criterion) => criterion.id)).not.toContain("agency-reference");
    expect(searchCriteria("vehicules", undefined)).toEqual([]);
    expect(searchCriteria(undefined, undefined)).toEqual([]);
  });

  it("names shared filters that exist and belong to at least one subcategory of their category", () => {
    for (const category of CATEGORIES) {
      for (const id of category.sharedFilters ?? []) {
        expect(criterionById(id), id).toBeDefined();
        expect(category.subcategories.some((subcategory) => subcategory.criteria.some((criterion) => criterion.id === id)), id).toBe(true);
      }
    }
  });
});

describe("labels", () => {
  for (const locale of ["fr", "ar"] as const) {
    it(`has a ${locale} label for every category, subcategory, criterion, option and condition`, () => {
      const labels = messages[locale];
      for (const category of CATEGORIES) {
        expect(labels.Categories[category.id]?.name, category.id).toBeTruthy();
        for (const subcategory of category.subcategories) expect(labels.Categories[category.id]?.sub[subcategory.id], subcategory.id).toBeTruthy();
      }
      for (const id of CRITERION_IDS) {
        const entry = labels.Criteria[id];
        expect(entry?.label, id).toBeTruthy();
        for (const option of CRITERIA[id].options ?? []) expect(entry?.options?.[option], `${id}.${option}`).toBeTruthy();
      }
      expect(labels.Criteria["condition"]?.label).toBeTruthy();
      for (const condition of CONDITIONS) expect(labels.Criteria["condition"]?.options?.[condition], condition).toBeTruthy();
    });

    it(`has no ${locale} label without an id behind it`, () => {
      const labels = messages[locale];
      for (const [categoryId, entry] of Object.entries(labels.Categories)) {
        const category = categoryById(categoryId);
        expect(category, categoryId).toBeDefined();
        expect(Object.keys(entry.sub).sort()).toEqual(category!.subcategories.map((s) => s.id).sort());
      }
      for (const [fieldId, entry] of Object.entries(labels.Criteria)) {
        const options = fieldId === "condition" ? CONDITIONS : criterionById(fieldId)?.options;
        expect(fieldId === "condition" || criterionById(fieldId) !== undefined, fieldId).toBe(true);
        expect(Object.keys(entry.options ?? {}).sort(), fieldId).toEqual([...(options ?? [])].sort());
      }
    });
  }

  it("writes Arabic labels in Arabic script (sizes and brand acronyms excepted)", () => {
    const arabic = /\p{Script=Arabic}/u;
    const latinOnly = new Set(["clothing-size", "shoe-size", "bike-size"]);
    for (const [fieldId, entry] of Object.entries(messages.ar.Criteria)) {
      expect(entry.label, fieldId).toMatch(arabic);
      if (latinOnly.has(fieldId)) continue;
      for (const [option, label] of Object.entries(entry.options ?? {})) expect(label, `${fieldId}.${option}`).toMatch(arabic);
    }
    for (const [categoryId, entry] of Object.entries(messages.ar.Categories)) {
      expect(entry.name, categoryId).toMatch(arabic);
      for (const [sub, label] of Object.entries(entry.sub)) expect(label, sub).toMatch(arabic);
    }
  });
});
