import { criterionById, subcategoryById, type Condition, type Criterion, type CriterionGroup } from "@/config/categories";
import type { ListingAttributes } from "@/lib/contracts/listings";
import { groupDigits } from "@/lib/listings/client/format";

// Criteria of a listing as rows, from the declarative category config (design §2): the subcategory's
// fields in config order, the core `condition` first, values that were not filled skipped. Labels
// come from the Criteria namespace (`Criteria.<field>.label`, `.options.<option>`) and the units and
// yes/no from `ListingPage.criteria`. Pure: the listing page (useCriteriaRows) and the map's detail
// panel preview (src/lib/search/preview.ts, server side) share it.

export interface CriteriaRowsInput {
  subcategoryId: string;
  attributes: ListingAttributes;
  condition: Condition | null;
  /** Rows of this criteria group; absent = the main criteria (and `condition`). */
  group?: CriterionGroup;
  /** Fields shown elsewhere on the page (the property terms under the price). */
  exclude?: readonly string[];
}

export interface CriterionRow {
  id: string;
  label: string;
  value: string;
  /** Free text typed by the seller (not a translated option): shown in its own direction. */
  userText?: boolean;
}

/** The two translators the rows need, typed loosely (next-intl's own types are per namespace). */
export interface CriteriaTranslators {
  /** The `Criteria` namespace. */
  criteria: { (key: string): string; has(key: string): boolean };
  /** The `ListingPage.criteria` namespace (`yes`, `no`, `units.*`). */
  page: (key: string) => string;
}

/** "120000" km -> "120 000 km"; years and small counts are not grouped. */
function formatNumber(value: number, criterion: Pick<Criterion, "unit">): string {
  if (criterion.unit === "an") return String(value);
  const digits = groupDigits(String(Math.abs(Math.trunc(value)))) || "0";
  return value < 0 ? `-${digits}` : digits;
}

export function criteriaRows({ subcategoryId, attributes, condition, group, exclude = [] }: CriteriaRowsInput, { criteria: t, page }: CriteriaTranslators): CriterionRow[] {
  const label = (id: string) => (t.has(`${id}.label`) ? t(`${id}.label`) : id);
  const option = (id: string, value: string) => (t.has(`${id}.options.${value}`) ? t(`${id}.options.${value}`) : value);

  const rows: CriterionRow[] = [];
  const subcategory = subcategoryById(subcategoryId);
  if (condition && subcategory?.condition && !group) rows.push({ id: "condition", label: label("condition"), value: option("condition", condition) });
  for (const field of subcategory?.criteria ?? []) {
    if (field.group !== group || exclude.includes(field.id)) continue;
    const value = attributes[field.id];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    const def = criterionById(field.id) ?? field;
    let text: string;
    let userText = false;
    if (Array.isArray(value)) text = value.map((item) => option(field.id, item)).join(", ");
    else if (typeof value === "boolean") text = value ? page("yes") : page("no");
    else if (typeof value === "number") text = def.unit && def.unit !== "an" ? `${formatNumber(value, def)} ${page(`units.${def.unit}`)}` : formatNumber(value, def);
    else if (def.type === "select") text = option(field.id, value);
    else {
      text = value;
      userText = true;
    }
    rows.push({ id: field.id, label: label(field.id), value: text, ...(userText ? { userText } : {}) });
  }
  return rows;
}
