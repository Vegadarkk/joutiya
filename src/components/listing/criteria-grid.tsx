import { useTranslations } from "next-intl";
import { criterionById, subcategoryById, type Condition, type Criterion, type CriterionGroup } from "@/config/categories";
import type { ListingAttributes } from "@/lib/contracts/listings";
import { groupDigits } from "@/lib/listings/client/format";
import { cn } from "@/lib/utils";

// Criteria of a listing, from the declarative category config (design §2): the subcategory's
// fields in config order, the core `condition` first, values that were not filled skipped. Labels
// come from the Criteria namespace (`Criteria.<field>.label`, `.options.<option>`). The vehicle
// dossier (`group: "dossier"`) has its own section (vehicle-dossier.tsx): `group` picks the rows.

export interface CriteriaGridProps {
  subcategoryId: string;
  /** Fields shown elsewhere on the page (the property terms under the price). */
  exclude?: readonly string[];
  attributes: ListingAttributes;
  condition: Condition | null;
  className?: string;
  /** Rows of this criteria group; absent = the main criteria (and `condition`). */
  group?: CriterionGroup;
}

export interface CriterionRow {
  id: string;
  label: string;
  value: string;
  /** Free text typed by the seller (not a translated option): shown in its own direction. */
  userText?: boolean;
}

/** "120000" km -> "120 000 km"; years and small counts are not grouped. */
function formatNumber(value: number, criterion: Pick<Criterion, "unit">): string {
  if (criterion.unit === "an") return String(value);
  const digits = groupDigits(String(Math.abs(Math.trunc(value)))) || "0";
  return value < 0 ? `-${digits}` : digits;
}

export function useCriteriaRows({ subcategoryId, attributes, condition, group, exclude = [] }: Omit<CriteriaGridProps, "className">): CriterionRow[] {
  const t = useTranslations("Criteria");
  const page = useTranslations("ListingPage.criteria");
  type Key = Parameters<typeof t.has>[0];
  const label = (id: string) => (t.has(`${id}.label` as Key) ? t(`${id}.label` as Key) : id);
  const option = (id: string, value: string) => (t.has(`${id}.options.${value}` as Key) ? t(`${id}.options.${value}` as Key) : value);

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

function Rows({ rows, className }: { rows: CriterionRow[]; className?: string }) {
  return (
    <dl data-testid="criteria-grid" className={cn("grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3", className)}>
      {rows.map((row) => (
        <div key={row.id} className="flex min-w-0 flex-col gap-0.5 border-s-2 border-border ps-3">
          <dt className="text-sm text-foreground-muted">{row.label}</dt>
          <dd dir={row.userText ? "auto" : undefined} className="font-medium break-words">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CriteriaGrid({ className, ...props }: CriteriaGridProps) {
  const rows = useCriteriaRows(props);
  return rows.length === 0 ? null : <Rows rows={rows} className={className} />;
}

/** The grid under its heading, or nothing at all when no criterion was filled. */
export function CriteriaSection({ title, className, ...props }: CriteriaGridProps & { title: string }) {
  const rows = useCriteriaRows(props);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="criteria-title" className={cn("flex flex-col gap-4", className)}>
      <h2 id="criteria-title" className="text-lg font-semibold">
        {title}
      </h2>
      <Rows rows={rows} />
    </section>
  );
}
