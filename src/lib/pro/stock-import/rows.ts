import { CATEGORIES, CONDITIONS, CRITERION_TEXT_MAX, criteriaSchema, criterionApplies, subcategoryById, type Condition, type Criterion, type Subcategory } from "@/config/categories";
import { CITIES, type City } from "@/config/regions";
import { DESCRIPTION_MAX, DESCRIPTION_MIN, DISTRICT_MAX, PRICE_MAX, TITLE_MAX, TITLE_MIN, type ListingAttributes } from "@/lib/contracts/listings";
import { refKey, type StockRowIssue } from "@/lib/contracts/stock-import";
import { normalizeText } from "@/lib/text/normalize";
import ar from "../../../../messages/ar.json";
import fr from "../../../../messages/fr.json";
import type { CsvTable } from "./csv";

// Lines of a stock file -> listing fields (design concession/concession.md §4), pure. Columns are
// matched on their normalized name: a criterion id (`car-brand`), its French or Arabic label
// ("Marque", "Kilométrage") or a short alias ("km", "boite"). Values accept the option id or its
// French or Arabic label, numbers their usual spellings ("41 000", "41.000 km"), booleans
// oui/non/1/0/x. The category column takes a subcategory id or name and defaults to cars; the
// brand column follows it (car brand, motorbike brand or free brand). A line comes out with the
// fields it sets, its issues and, without errors, is ready to become a draft or an update.

export type CoreField = "ref" | "category" | "title" | "description" | "price" | "negotiable" | "city" | "district" | "condition";

/** Criterion holding the stock reference (Pro-only). */
export const STOCK_REF = "stock-ref";

/** Generic brand column, resolved per line from its subcategory. */
const BRAND = "@brand";

type Labels = { Criteria: Record<string, { label: string; options?: Record<string, string> }>; Categories: Record<string, { name: string; sub: Record<string, string> }> };
const FR = fr as unknown as Labels;
const AR = ar as unknown as Labels;

const key = (value: string) => normalizeText(value);

const CORE_ALIASES: Record<CoreField, readonly string[]> = {
  ref: ["ref", "reference", "référence", "reference stock", "référence de stock", "stock ref", "stock-ref", "sku", "المرجع"],
  category: ["categorie", "catégorie", "sous categorie", "sous-catégorie", "category", "الفئة"],
  title: ["titre", "title", "العنوان"],
  description: ["description", "texte", "الوصف"],
  price: ["prix", "price", "prix dh", "prix mad", "الثمن", "السعر"],
  negotiable: ["negociable", "négociable", "prix negociable", "prix négociable", "قابل للتفاوض"],
  city: ["ville", "city", "المدينة"],
  district: ["quartier", "district", "الحي"],
  condition: ["etat", "état", "condition", "الحالة"],
};

/** Short names dealers use, on top of the criterion labels. */
const CRITERION_ALIASES: Record<string, readonly string[]> = {
  [BRAND]: ["marque", "brand", "الماركة", "العلامة"],
  model: ["modele", "modèle", "model"],
  year: ["annee", "année", "annee modele", "année-modèle", "year"],
  mileage: ["km", "kilometrage", "kilométrage", "kilometres", "mileage"],
  fuel: ["carburant", "energie", "énergie", "fuel"],
  gearbox: ["boite", "boîte", "boite de vitesse", "boîte de vitesses", "transmission", "gearbox"],
  "fiscal-power": ["cv", "puissance", "puissance fiscale", "chevaux fiscaux"],
  origin: ["origine", "dedouanement", "dédouanement"],
  doors: ["portes", "nombre de portes"],
  color: ["couleur", "colour"],
  "body-type": ["carrosserie", "type de carrosserie"],
  "first-hand": ["premiere main", "première main", "1ere main"],
  "service-history": ["carnet", "carnet d entretien", "entretien"],
  "no-accident": ["non accidente", "non accidenté", "sans accident"],
  "vehicle-papers": ["papiers", "documents"],
  "vehicle-warranty": ["garantie", "type de garantie"],
  "warranty-months": ["garantie mois", "duree garantie", "durée garantie", "duree de garantie", "durée de la garantie", "mois de garantie"],
  "trade-in": ["reprise", "reprise possible"],
  financing: ["financement", "credit", "crédit"],
  "car-equipment": ["equipements", "équipements", "options", "equipement"],
  "engine-size": ["cylindree", "cylindrée"],
  "utility-type": ["type utilitaire", "type de vehicule", "type de véhicule"],
};

/** Normalized header -> core field or criterion id (`@brand` for the brand). */
const HEADER_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>();
  const add = (name: string, target: string) => {
    const k = key(name);
    if (k && !index.has(k)) index.set(k, target);
  };
  for (const [field, aliases] of Object.entries(CORE_ALIASES)) for (const alias of aliases) add(alias, `core:${field}`);
  for (const [target, aliases] of Object.entries(CRITERION_ALIASES)) for (const alias of aliases) add(alias, target);
  for (const [id, entry] of Object.entries(FR.Criteria)) {
    if (id === "condition") continue;
    add(id, id);
    add(entry.label, id);
    const arabic = AR.Criteria[id]?.label;
    if (arabic) add(arabic, id);
  }
  return index;
})();

/** Subcategory by id, French or Arabic name, or a few plain words. */
const SUBCATEGORY_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const category of CATEGORIES) {
    for (const sub of category.subcategories) {
      index.set(key(sub.id), sub.id);
      const name = FR.Categories[category.id]?.sub[sub.id];
      if (name) index.set(key(name), sub.id);
      const arabic = AR.Categories[category.id]?.sub[sub.id];
      if (arabic) index.set(key(arabic), sub.id);
    }
  }
  for (const [word, id] of Object.entries({ voiture: "voitures", auto: "voitures", vp: "voitures", utilitaire: "utilitaires-camions", utilitaires: "utilitaires-camions", camion: "utilitaires-camions", camions: "utilitaires-camions", moto: "motos-scooters", motos: "motos-scooters", scooter: "motos-scooters" })) index.set(key(word), id);
  return index;
})();

const CITY_INDEX: Map<string, City> = (() => {
  const index = new Map<string, City>();
  // Larger cities first: a name shared by two places resolves to the larger one.
  for (const city of [...CITIES].sort((a, b) => b.population - a.population)) {
    for (const name of [city.slug, city.nameFr, city.nameAr]) if (!index.has(key(name))) index.set(key(name), city);
  }
  return index;
})();

const TRUE_WORDS = new Set(["oui", "yes", "o", "y", "1", "x", "vrai", "true", "نعم", "wah", "iyeh"].map(key));
const FALSE_WORDS = new Set(["non", "no", "n", "0", "faux", "false", "لا", "la"].map(key));
/**
 * Separators of a multiple choice cell ("GPS | Caméra de recul", "gps, camera-recul"): the bar or
 * semicolon first, so a label holding a slash or a comma ("CarPlay / Android Auto") stays whole.
 */
const LIST_SEPARATORS = [/\s*[|;]\s*/, /\s*[|,;/+]\s*/];

export interface ColumnMap {
  /** Column index -> core field or criterion target. */
  targets: Map<number, string>;
  /** Headers that map to nothing. */
  ignored: string[];
}

export function mapColumns(header: readonly string[]): ColumnMap {
  const targets = new Map<number, string>();
  const ignored: string[] = [];
  const taken = new Set<string>();
  header.forEach((name, index) => {
    const target = HEADER_INDEX.get(key(name));
    if (!target || taken.has(target)) {
      if (name.trim()) ignored.push(name);
      return;
    }
    taken.add(target);
    targets.set(index, target);
  });
  return { targets, ignored };
}

export interface ImportedFields {
  title: string;
  description: string;
  price: number | null;
  priceNegotiable: boolean;
  condition: Condition | null;
  attributes: ListingAttributes;
  location: { regionCode: string; citySlug: string; district?: string } | null;
}

export interface ParsedRow {
  line: number;
  ref: string;
  subcategoryId: string | null;
  fields: ImportedFields;
  issues: StockRowIssue[];
}

/** Stock references: letters, digits and - _ . / (case kept, compared without case). */
const REF_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\-_./]{0,39}$/u;
export { refKey };

function optionOf(criterion: Pick<Criterion, "id" | "options">, raw: string): string | undefined {
  const wanted = key(raw);
  for (const option of criterion.options ?? []) {
    if (key(option) === wanted) return option;
    const labels = [FR.Criteria[criterion.id]?.options?.[option], AR.Criteria[criterion.id]?.options?.[option]];
    if (labels.some((label) => label !== undefined && key(label) === wanted)) return option;
  }
  return undefined;
}

/** "41 000", "41.000 km", "41 000,00" -> 41000; anything else undefined. */
export function parseInteger(raw: string): number | undefined {
  const cleaned = raw
    .replace(/[  \s]/g, "")
    .replace(/(dhs?|mad|km|cv|mois|ans?|درهم)$/i, "")
    .replace(/[.,]00$/, "")
    .replace(/[.,](?=\d{3}(\D|$))/g, "");
  if (!/^-?\d+$/.test(cleaned)) return undefined;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value : undefined;
}

function parseBoolean(raw: string): boolean | undefined {
  const k = key(raw);
  if (TRUE_WORDS.has(k)) return true;
  if (FALSE_WORDS.has(k)) return false;
  return undefined;
}

const cut = (value: string) => (value.length > 80 ? `${value.slice(0, 79)}…` : value);

function conditionOf(raw: string): Condition | undefined {
  return CONDITIONS.find((condition) => key(condition) === key(raw) || key(FR.Criteria.condition?.options?.[condition] ?? "") === key(raw) || key(AR.Criteria.condition?.options?.[condition] ?? "") === key(raw));
}

function brandCriterion(subcategory: Subcategory): Criterion | undefined {
  return subcategory.criteria.find((criterion) => criterion.id === "car-brand" || criterion.id === "moto-brand" || criterion.id === "brand");
}

/** Generated title when the file has none: brand, model and year ("Dacia Duster 2022"). */
function generatedTitle(subcategory: Subcategory, attributes: ListingAttributes): string {
  const brand = brandCriterion(subcategory);
  const brandValue = brand ? attributes[brand.id] : undefined;
  const parts = [
    typeof brandValue === "string" ? (brand?.type === "select" ? (FR.Criteria[brand.id]?.options?.[brandValue] ?? brandValue) : brandValue) : undefined,
    typeof attributes["model"] === "string" ? attributes["model"] : undefined,
    typeof attributes["year"] === "number" ? String(attributes["year"]) : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" ").slice(0, TITLE_MAX);
}

/** One line: reads every mapped cell, then checks it against its subcategory's criteria. */
export function parseRow(record: { line: number; cells: readonly string[] }, header: readonly string[], columns: ColumnMap, options: { pro: boolean }): ParsedRow {
  const issues: StockRowIssue[] = [];
  const cells = new Map<string, { raw: string; column: string }>();
  for (const [index, target] of columns.targets) {
    const raw = (record.cells[index] ?? "").trim();
    if (raw !== "") cells.set(target, { raw, column: header[index] ?? target });
  }
  const core = (field: CoreField) => cells.get(`core:${field}`);

  const ref = core("ref")?.raw ?? "";
  if (!ref) issues.push({ column: "reference", code: "ref_required" });
  else if (!REF_PATTERN.test(ref)) issues.push({ column: core("ref")!.column, code: "ref_invalid", value: cut(ref) });

  const categoryCell = core("category");
  const subcategoryId = categoryCell ? (SUBCATEGORY_INDEX.get(key(categoryCell.raw)) ?? null) : "voitures";
  const subcategory = subcategoryId ? subcategoryById(subcategoryId) : undefined;
  if (categoryCell && !subcategory) issues.push({ column: categoryCell.column, code: "category_unknown", value: cut(categoryCell.raw) });
  if (subcategory?.proOnly && !options.pro) issues.push({ column: categoryCell?.column ?? "categorie", code: "pro_only" });

  const attributes: ListingAttributes = {};
  // The reference is stored as the `stock-ref` criterion: only subcategories that have it import.
  if (subcategory && !subcategory.criteria.some((criterion) => criterion.id === STOCK_REF)) issues.push({ column: categoryCell?.column ?? "categorie", code: "category_unknown", value: cut(categoryCell?.raw ?? subcategory.id) });
  if (subcategory) {
    if (ref && REF_PATTERN.test(ref) && options.pro) attributes[STOCK_REF] = ref;
    for (const criterion of subcategory.criteria) {
      if (criterion.id === STOCK_REF) continue;
      const cell = cells.get(criterion.id) ?? (criterion === brandCriterion(subcategory) ? cells.get(BRAND) : undefined);
      if (!cell) continue;
      if (criterion.proOnly && !options.pro) {
        issues.push({ column: cell.column, code: "pro_only" });
        continue;
      }
      const value = readCriterion(criterion, cell.raw);
      if (value === undefined) issues.push({ column: cell.column, code: criterion.type === "number" ? "number_invalid" : "value_unknown", value: cut(cell.raw) });
      else attributes[criterion.id] = value;
    }
    // Dependent criteria the line does not open (a duration without a warranty) are dropped with a note.
    for (const criterion of subcategory.criteria) {
      if (attributes[criterion.id] !== undefined && !criterionApplies(criterion, attributes)) {
        delete attributes[criterion.id];
        issues.push({ column: FR.Criteria[criterion.id]?.label ?? criterion.id, code: "column_ignored" });
      }
    }
    const parsed = criteriaSchema(subcategory.id).safeParse(attributes);
    if (!parsed.success) {
      for (const problem of parsed.error.issues) {
        const id = String(problem.path[0] ?? "");
        const criterion = subcategory.criteria.find((item) => item.id === id);
        if (!criterion) continue;
        const missing = attributes[id] === undefined;
        if (issues.some((issue) => issue.column === (cells.get(id)?.column ?? FR.Criteria[id]?.label))) continue;
        issues.push({ column: cells.get(id)?.column ?? FR.Criteria[id]?.label ?? id, code: missing ? "required" : criterion.type === "number" ? "number_invalid" : "value_unknown", ...(missing ? {} : { value: cut(String(attributes[id])) }) });
      }
    }
  }

  let title = core("title")?.raw ?? "";
  if (title.length > TITLE_MAX) issues.push({ column: core("title")!.column, code: "too_long", value: cut(title) });
  if (!title && subcategory) {
    title = generatedTitle(subcategory, attributes);
    issues.push({ column: "titre", code: "title_generated", value: title });
  }
  if (title.length < TITLE_MIN && subcategory) issues.push({ column: core("title")?.column ?? "titre", code: "required" });

  const description = core("description")?.raw ?? "";
  if (description.length > DESCRIPTION_MAX) issues.push({ column: core("description")!.column, code: "too_long" });
  else if (description.length < DESCRIPTION_MIN) issues.push({ column: core("description")?.column ?? "description", code: "description_short" });

  let price: number | null = null;
  const priceCell = core("price");
  if (priceCell) {
    const value = parseInteger(priceCell.raw);
    if (value === undefined || value < 1 || value > PRICE_MAX) issues.push({ column: priceCell.column, code: "price_invalid", value: cut(priceCell.raw) });
    else price = value;
  } else if (subcategory && !subcategory.priceOptional) issues.push({ column: "prix", code: "required" });
  const negotiable = core("negotiable") ? parseBoolean(core("negotiable")!.raw) : false;
  if (negotiable === undefined) issues.push({ column: core("negotiable")!.column, code: "value_unknown", value: cut(core("negotiable")!.raw) });

  let condition: Condition | null = null;
  const conditionCell = core("condition");
  if (conditionCell && subcategory?.condition) {
    const value = conditionOf(conditionCell.raw);
    if (!value) issues.push({ column: conditionCell.column, code: "value_unknown", value: cut(conditionCell.raw) });
    else condition = value;
  }
  if (!condition && subcategory?.condition === "required") issues.push({ column: conditionCell?.column ?? "etat", code: "required" });

  let location: ImportedFields["location"] = null;
  const cityCell = core("city");
  if (!cityCell) issues.push({ column: "ville", code: "required" });
  else {
    const city = CITY_INDEX.get(key(cityCell.raw));
    if (!city) issues.push({ column: cityCell.column, code: "city_unknown", value: cut(cityCell.raw) });
    else {
      const district = core("district")?.raw.slice(0, DISTRICT_MAX);
      location = { regionCode: city.regionCode, citySlug: city.slug, ...(district ? { district } : {}) };
    }
  }

  return {
    line: record.line,
    ref,
    subcategoryId: subcategory?.id ?? null,
    fields: { title, description: description.slice(0, DESCRIPTION_MAX), price, priceNegotiable: negotiable ?? false, condition, attributes, location },
    issues,
  };
}

function readCriterion(criterion: Criterion, raw: string): ListingAttributes[string] | undefined {
  switch (criterion.type) {
    case "select":
      return optionOf(criterion, raw);
    case "multiselect": {
      for (const separator of LIST_SEPARATORS) {
        const values = raw.split(separator).filter(Boolean).map((part) => optionOf(criterion, part));
        if (values.every((value): value is string => value !== undefined)) return [...new Set(values)];
      }
      return undefined;
    }
    case "number":
      return parseInteger(raw);
    case "boolean":
      return parseBoolean(raw);
    case "text":
      return raw.length > CRITERION_TEXT_MAX ? undefined : raw;
  }
}

/** Every line of a parsed file. */
export function parseRows(table: CsvTable, options: { pro: boolean }): { rows: ParsedRow[]; ignoredColumns: string[] } {
  const columns = mapColumns(table.header);
  return { rows: table.records.map((record) => parseRow(record, table.header, columns, options)), ignoredColumns: columns.ignored };
}
