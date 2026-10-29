import { CATEGORIES, CONDITIONS, CRITERION_TEXT_MAX, RENTAL_SUBCATEGORY, criteriaSchema, criterionApplies, subcategoryById, type Condition, type Criterion, type Subcategory } from "@/config/categories";
import { CITIES, type City } from "@/config/regions";
import {
  FREE_AXES,
  STOCK_MAX,
  VARIANT_ITEMS_MAX,
  VARIANT_KEY_SEPARATOR,
  VARIANT_LABEL_MAX,
  VARIANT_VALUES_MAX,
  VARIANT_VALUE_MAX,
  isVariantCriterion,
  listingVariantsSchema,
  variantKey,
  type ListingVariants,
  type VariantAxis,
  type VariantCriterion,
  type VariantItem,
} from "@/lib/contracts/catalog";
import { DESCRIPTION_MAX, DESCRIPTION_MIN, DISTRICT_MAX, PRICE_MAX, TITLE_MAX, TITLE_MIN, type ListingAttributes } from "@/lib/contracts/listings";
import { STOCK_WARNING_CODES, refKey, type StockRowIssue } from "@/lib/contracts/stock-import";
import { DAY_PATTERN, moroccoToday, normalizePeriods, type RentalPeriod } from "@/lib/listings/rental-availability";
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
// fields it sets, its issues and, without errors, is ready to become a draft or an update. A car
// rental line may carry its blocked periods (`indisponible`: "2026-11-02/2026-11-05; 2026-12-24").
// A shop's goods (catalogue §2) may carry their stock (`stock`) and their variants: one line per
// combination, `variante_1` / `variante_2` as « Taille : M », « Couleur : Noir » or a free axis
// (« Contenance : 500 g »), the lines of one reference grouped into one listing; the later lines
// may leave the listing's cells empty (they take the first line's) and give their own price.

export type CoreField = "ref" | "category" | "title" | "description" | "price" | "negotiable" | "city" | "district" | "condition" | "unavailable" | "variant1" | "variant2" | "stock";

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
  variant1: ["variante 1", "variante1", "variant 1", "declinaison 1", "déclinaison 1", "option 1", "المتغير 1"],
  variant2: ["variante 2", "variante2", "variant 2", "declinaison 2", "déclinaison 2", "option 2", "المتغير 2"],
  // Not « quantité »: the criterion of wholesale lots (`quantity`) keeps that name.
  stock: ["stock", "en stock", "quantite en stock", "quantité en stock", "qte stock", "المخزون"],
  unavailable: ["indisponible", "indisponibilite", "indisponibilités", "indisponibilites", "jours bloques", "jours bloqués", "periodes bloquees", "périodes bloquées", "unavailable", "غير متاح"],
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
  // Car rental (rental pack): the words agencies use in their fleet sheets.
  "rental-class": ["gamme", "categorie vehicule", "catégorie véhicule"],
  "mileage-policy": ["politique kilometrique", "politique kilométrique"],
  "km-per-day": ["km par jour", "km inclus", "kilometres par jour", "kilomètres par jour"],
  "vehicle-handover": ["remise", "livraison"],
  seats: ["places", "nombre de places"],
  "min-rental-days": ["duree minimum", "durée minimum", "jours minimum", "location minimum"],
  "rental-insurance": ["assurance"],
  "insurance-excess": ["franchise"],
  "rental-deposit": ["caution", "depot de garantie", "dépôt de garantie"],
  "driver-min-age": ["age minimum", "âge minimum", "age conducteur", "âge conducteur"],
  "licence-years": ["permis", "anciennete permis", "ancienneté permis"],
  "rate-7-days": ["tarif semaine", "prix semaine", "tarif 7 jours"],
  "rate-30-days": ["tarif mois", "prix mois", "tarif 30 jours"],
  "fleet-units": ["unites", "unités", "nombre de vehicules", "nombre de véhicules"],
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
  for (const [word, id] of Object.entries({ voiture: "voitures", auto: "voitures", vp: "voitures", utilitaire: "utilitaires-camions", utilitaires: "utilitaires-camions", camion: "utilitaires-camions", camions: "utilitaires-camions", moto: "motos-scooters", motos: "motos-scooters", scooter: "motos-scooters", "location voiture": RENTAL_SUBCATEGORY, "location voitures": RENTAL_SUBCATEGORY, "location auto": RENTAL_SUBCATEGORY, "location de voiture": RENTAL_SUBCATEGORY })) index.set(key(word), id);
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

/** An axis read in a variant cell: a criterion of the subcategory (size, colour) or a free one. */
export type ImportedAxis = { id: VariantCriterion } | { id: "free"; label: string };

/** A line's combination (catalogue §2): its axes and values in column order, its stock and price. */
export interface VariantLine {
  axes: ImportedAxis[];
  values: string[];
  stock?: number;
  price: number | null;
}

export interface ImportedFields {
  title: string;
  description: string;
  price: number | null;
  priceNegotiable: boolean;
  condition: Condition | null;
  attributes: ListingAttributes;
  location: { regionCode: string; citySlug: string; district?: string } | null;
  /** Car rentals: the blocked periods of the line (undefined: the file leaves them as they are). */
  unavailable?: RentalPeriod[];
  /** Variants of the reference's lines (undefined: the file has none for it). */
  variants?: ListingVariants;
  /** The listing's own stock, without variants (undefined: left as it is). */
  stock?: number;
}

export interface ParsedRow {
  line: number;
  ref: string;
  subcategoryId: string | null;
  fields: ImportedFields;
  issues: StockRowIssue[];
  /** The line's combination when it has a variant cell. */
  variant?: VariantLine;
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

/** Axis names a shop writes, on top of the criteria labels (« Taille : M »). */
const AXIS_NAMES: Record<VariantCriterion, readonly string[]> = {
  "clothing-size": ["taille", "size", FR.Criteria["clothing-size"]?.label ?? "", AR.Criteria["clothing-size"]?.label ?? ""],
  "shoe-size": ["pointure", "taille chaussure", FR.Criteria["shoe-size"]?.label ?? "", AR.Criteria["shoe-size"]?.label ?? ""],
  color: ["couleur", "coloris", "color", "colour", FR.Criteria["color"]?.label ?? "", AR.Criteria["color"]?.label ?? ""],
};
const VARIANT_CELL = /^([^:=：]+?)\s*[:=：]\s*(.+)$/u;

/**
 * A variant cell (« Taille : M »): a size or colour of the subcategory takes its option, any other
 * name is a free axis with the value as written. « Taille » of shoes is their size.
 */
function readVariantCell(raw: string, subcategory: Subcategory): { axis: ImportedAxis; value: string } | undefined {
  const match = VARIANT_CELL.exec(raw);
  if (!match) return undefined;
  const name = match[1]!.trim();
  const value = match[2]!.trim();
  const has = (id: string) => subcategory.criteria.find((criterion) => criterion.id === id);
  const wanted = key(name);
  for (const [id, names] of Object.entries(AXIS_NAMES) as [VariantCriterion, readonly string[]][]) {
    if (!names.some((candidate) => candidate && key(candidate) === wanted)) continue;
    const criterion = has(id) ?? (id === "clothing-size" ? has("shoe-size") : undefined);
    if (!criterion) break;
    const option = optionOf(criterion, value);
    return option === undefined ? undefined : { axis: { id: criterion.id as VariantCriterion }, value: option };
  }
  if (name.length > VARIANT_LABEL_MAX || value.length > VARIANT_VALUE_MAX || value.includes(VARIANT_KEY_SEPARATOR)) return undefined;
  return { axis: { id: "free", label: name }, value };
}

/** A cell meaning "no blocked day". */
const NO_PERIOD_WORDS = new Set(["aucune", "aucun", "libre", "-", "0", "none", "لا"].map(key));
const PERIOD = /^(\d{4}-\d{2}-\d{2})(?:\s*(?:\/|au|à|->|→|\.\.)\s*(\d{4}-\d{2}-\d{2}))?$/iu;

/** "2026-11-02/2026-11-05; 2026-12-24" -> merged periods from `today`; undefined when unreadable. */
export function parsePeriods(raw: string, today: number): RentalPeriod[] | undefined {
  if (NO_PERIOD_WORDS.has(key(raw))) return [];
  const periods: RentalPeriod[] = [];
  for (const part of raw.split(/\s*[;,|\n]\s*/).filter(Boolean)) {
    const match = PERIOD.exec(part.trim());
    if (!match || !DAY_PATTERN.test(match[1]!) || (match[2] !== undefined && !DAY_PATTERN.test(match[2]))) return undefined;
    periods.push({ from: match[1]!, to: match[2] ?? match[1]! });
  }
  const normalized = normalizePeriods(periods, today);
  return "periods" in normalized ? normalized.periods : undefined;
}

/**
 * One line: reads every mapped cell, then checks it against its subcategory's criteria. `today`
 * (Morocco day number, default now) bounds the blocked periods of a car rental.
 */
export function parseRow(record: { line: number; cells: readonly string[] }, header: readonly string[], columns: ColumnMap, options: { pro: boolean; today?: number }): ParsedRow {
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

  // Variant cells first: a size or colour axis takes over its criterion (its column is not read).
  const variantCells = (["variant1", "variant2"] as const).flatMap((field) => (core(field) ? [core(field)!] : []));
  const read = subcategory ? variantCells.map((cell) => ({ cell, parsed: readVariantCell(cell.raw, subcategory) })) : [];
  for (const { cell, parsed } of read) if (!parsed) issues.push({ column: cell.column, code: "variant_invalid", value: cut(cell.raw) });
  const axisCriteria = new Set<string>(read.flatMap(({ parsed }) => (parsed && isVariantCriterion(parsed.axis.id) ? [parsed.axis.id] : [])));
  let stock: number | undefined;
  const stockCell = core("stock");
  if (stockCell) {
    const value = parseInteger(stockCell.raw);
    if (value === undefined || value < 0 || value > STOCK_MAX) issues.push({ column: stockCell.column, code: "stock_invalid", value: cut(stockCell.raw) });
    else stock = value;
  }

  const attributes: ListingAttributes = {};
  // The reference is stored as the `stock-ref` criterion: only subcategories that have it import.
  if (subcategory && !subcategory.criteria.some((criterion) => criterion.id === STOCK_REF)) issues.push({ column: categoryCell?.column ?? "categorie", code: "category_unknown", value: cut(categoryCell?.raw ?? subcategory.id) });
  if (subcategory) {
    if (ref && REF_PATTERN.test(ref) && options.pro) attributes[STOCK_REF] = ref;
    for (const criterion of subcategory.criteria) {
      if (criterion.id === STOCK_REF || axisCriteria.has(criterion.id)) continue;
      // "Kilométrage" is the mileage of a car for sale and the mileage policy of a rental.
      const cell = cells.get(criterion.id) ?? (criterion === brandCriterion(subcategory) ? cells.get(BRAND) : criterion.id === "mileage-policy" ? cells.get("mileage") : undefined);
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
        if (!criterion || axisCriteria.has(id)) continue;
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

  let unavailable: RentalPeriod[] | undefined;
  const unavailableCell = core("unavailable");
  if (unavailableCell && subcategory?.id === RENTAL_SUBCATEGORY) {
    unavailable = parsePeriods(unavailableCell.raw, options.today ?? moroccoToday(Date.now()));
    if (!unavailable) issues.push({ column: unavailableCell.column, code: "periods_invalid", value: cut(unavailableCell.raw) });
  } else if (unavailableCell && subcategory) issues.push({ column: unavailableCell.column, code: "periods_ignored" });

  const combination = read.length > 0 && read.every(({ parsed }) => parsed) ? read.map(({ parsed }) => parsed!) : null;
  return {
    line: record.line,
    ref,
    subcategoryId: subcategory?.id ?? null,
    fields: {
      title,
      description: description.slice(0, DESCRIPTION_MAX),
      price,
      priceNegotiable: negotiable ?? false,
      condition,
      attributes,
      location,
      ...(unavailable ? { unavailable } : {}),
      ...(variantCells.length === 0 && stock !== undefined ? { stock } : {}),
    },
    issues,
    ...(combination ? { variant: { axes: combination.map((entry) => entry.axis), values: combination.map((entry) => entry.value), ...(stock !== undefined ? { stock } : {}), price } } : {}),
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

const axisKey = (axis: ImportedAxis) => (axis.id === "free" ? `free:${key(axis.label)}` : axis.id);

/**
 * One listing out of a reference's variant lines (catalogue §2): the first line's fields, the axes
 * in column order, a combination per line with its stock and its price when it differs. The other
 * lines' problems join the first line's, with their line number.
 */
function mergeVariantLines(head: ParsedRow, members: readonly ParsedRow[]): void {
  const first = head.variant;
  // A line without the head's size axis reads it as a missing criterion: its variant issue says it.
  const axisLabels = new Set((first?.axes ?? []).flatMap((axis) => (axis.id === "free" ? [] : [FR.Criteria[axis.id]?.label ?? axis.id])));
  for (const member of members) {
    if (member === head) continue;
    for (const issue of member.issues) {
      if (STOCK_WARNING_CODES.includes(issue.code) || (issue.code === "required" && axisLabels.has(issue.column))) continue;
      head.issues.push({ ...issue, line: member.line });
    }
  }
  if (!first) return;
  const lines = members.filter((member) => member.variant);
  const signature = first.axes.map(axisKey).join("|");
  let free = 0;
  const axes: VariantAxis[] = first.axes.map((axis) => (axis.id === "free" ? { id: FREE_AXES[free++]!, label: axis.label, values: [] } : { id: axis.id, values: [] }));
  const items: VariantItem[] = [];
  const keys = new Set<string>();
  let refused = lines.length !== members.length;
  for (const member of lines) {
    const variant = member.variant!;
    const at = member === head ? {} : { line: member.line };
    if (variant.axes.map(axisKey).join("|") !== signature) {
      head.issues.push({ column: "variante_1", code: "variant_axes", ...at });
      refused = true;
      continue;
    }
    // A free value keeps its first spelling (« 500 g » and « 500 G » are one value).
    const values = variant.values.map((value, index) => {
      const axis = axes[index]!;
      const known = axis.values.find((candidate) => candidate.toLowerCase() === value.toLowerCase());
      if (known) return known;
      axis.values.push(value);
      return value;
    });
    const itemKey = variantKey(values);
    if (keys.has(itemKey)) {
      head.issues.push({ column: "variante_1", code: "variant_duplicate", value: cut(values.join(" / ")), ...at });
      refused = true;
      continue;
    }
    keys.add(itemKey);
    items.push({ key: itemKey, ...(variant.stock !== undefined ? { stock: variant.stock } : {}), ...(variant.price !== null && variant.price !== head.fields.price ? { price: variant.price } : {}) });
  }
  if (refused) return;
  if (items.length > VARIANT_ITEMS_MAX || axes.some((axis) => axis.values.length > VARIANT_VALUES_MAX)) {
    head.issues.push({ column: "variante_1", code: "variant_too_many" });
    return;
  }
  const parsed = listingVariantsSchema.safeParse({ axes, items });
  if (!parsed.success) head.issues.push({ column: "variante_1", code: "variant_invalid" });
  else head.fields.variants = parsed.data;
}

/**
 * Every line of a parsed file. The variant lines of one reference make one row: its first line,
 * whose empty cells the next lines take before they are read.
 */
export function parseRows(table: CsvTable, options: { pro: boolean; today?: number }): { rows: ParsedRow[]; ignoredColumns: string[] } {
  const columns = mapColumns(table.header);
  const columnOf = (field: CoreField) => [...columns.targets].find(([, target]) => target === `core:${field}`)?.[0];
  const refAt = columnOf("ref");
  const own = new Set([columnOf("variant1"), columnOf("variant2"), columnOf("stock")].filter((index): index is number => index !== undefined));
  const heads = new Map<string, { cells: string[]; row: ParsedRow; members: ParsedRow[] }>();
  const rows: ParsedRow[] = [];
  for (const record of table.records) {
    const cell = (index: number | undefined) => (index === undefined ? "" : (record.cells[index] ?? "").trim());
    const refK = refKey(cell(refAt));
    const variantLine = refK !== "" && [...own].some((index) => index !== columnOf("stock") && cell(index) !== "");
    const head = variantLine ? heads.get(refK) : undefined;
    const cells = head ? table.header.map((_, index) => (own.has(index) || cell(index) !== "" ? (record.cells[index] ?? "") : (head.cells[index] ?? ""))) : record.cells;
    const row = parseRow({ line: record.line, cells }, table.header, columns, options);
    if (head) {
      head.members.push(row);
      continue;
    }
    rows.push(row);
    if (variantLine) heads.set(refK, { cells: table.header.map((_, index) => record.cells[index] ?? ""), row, members: [row] });
  }
  for (const group of heads.values()) mergeVariantLines(group.row, group.members);
  return { rows, ignoredColumns: columns.ignored };
}
