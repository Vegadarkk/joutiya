import { useTranslations } from "next-intl";
import type { Condition, CriterionGroup } from "@/config/categories";
import type { ListingAttributes } from "@/lib/contracts/listings";
import { criteriaRows, type CriteriaTranslators, type CriterionRow } from "@/lib/listings/criteria-rows";
import { cn } from "@/lib/utils";

// Criteria of a listing (design §2), rows from src/lib/listings/criteria-rows.ts. The vehicle
// dossier (`group: "dossier"`) has its own section (vehicle-dossier.tsx): `group` picks the rows.

export type { CriterionRow };

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

export function useCriteriaRows(props: Omit<CriteriaGridProps, "className">): CriterionRow[] {
  const criteria = useTranslations("Criteria");
  const page = useTranslations("ListingPage.criteria");
  return criteriaRows(props, { criteria, page } as unknown as CriteriaTranslators);
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
