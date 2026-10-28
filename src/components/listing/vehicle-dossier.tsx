import { BadgeCheck, Check, FileText, Landmark, Repeat, ShieldCheck, UserRound, Wrench, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { subcategoryById } from "@/config/categories";
import type { ListingAttributes } from "@/lib/contracts/listings";
import { cn } from "@/lib/utils";

// Vehicle dossier of a listing (Concession pack, design concession/concession.md §2): the
// `group: "dossier"` criteria the seller filled, as highlights (warranty, trade-in, financing,
// history), the papers as a checklist and the equipment as chips. Nothing filled, nothing shown.
// Every statement is the seller's declaration, said under the section.

export interface VehicleDossierProps {
  subcategoryId: string;
  attributes: ListingAttributes;
  className?: string;
}

interface Highlight {
  id: string;
  icon: LucideIcon;
  title: string;
  detail?: string;
}

export function VehicleDossier({ subcategoryId, attributes, className }: VehicleDossierProps) {
  const t = useTranslations("Criteria");
  const d = useTranslations("ListingPage.dossier");
  const subcategory = subcategoryById(subcategoryId);
  const has = (id: string) => subcategory?.criteria.some((criterion) => criterion.id === id && criterion.group === "dossier") === true;
  type Key = Parameters<typeof t>[0];
  const option = (id: string, value: string) => t(`${id}.options.${value}` as Key);

  const highlights: Highlight[] = [];
  const warranty = has("vehicle-warranty") ? attributes["vehicle-warranty"] : undefined;
  if (warranty === "constructeur" || warranty === "vendeur") {
    const months = attributes["warranty-months"];
    highlights.push({ id: "warranty", icon: ShieldCheck, title: option("vehicle-warranty", warranty), ...(typeof months === "number" ? { detail: d("months", { count: months }) } : {}) });
  }
  if (has("trade-in") && attributes["trade-in"] === true) highlights.push({ id: "trade-in", icon: Repeat, title: d("tradeIn"), detail: d("tradeInDetail") });
  if (has("financing") && attributes["financing"] === true) highlights.push({ id: "financing", icon: Landmark, title: d("financing"), detail: d("financingDetail") });
  const history = has("service-history") ? attributes["service-history"] : undefined;
  if (typeof history === "string" && history !== "aucun") highlights.push({ id: "history", icon: Wrench, title: d("history"), detail: option("service-history", history) });
  if (has("first-hand") && attributes["first-hand"] === true) highlights.push({ id: "first-hand", icon: UserRound, title: t("first-hand.label") });
  if (has("no-accident") && attributes["no-accident"] === true) highlights.push({ id: "no-accident", icon: BadgeCheck, title: t("no-accident.label") });

  const papers = has("vehicle-papers") && Array.isArray(attributes["vehicle-papers"]) ? attributes["vehicle-papers"] : [];
  const equipment = has("car-equipment") && Array.isArray(attributes["car-equipment"]) ? attributes["car-equipment"] : [];
  const stockRef = has("stock-ref") && typeof attributes["stock-ref"] === "string" ? attributes["stock-ref"] : undefined;

  if (highlights.length === 0 && papers.length === 0 && equipment.length === 0 && !stockRef) return null;

  return (
    <section data-testid="vehicle-dossier" aria-labelledby="dossier-title" className={cn("flex flex-col gap-5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="dossier-title" className="text-lg font-semibold">
          {d("title")}
        </h2>
        {stockRef ? (
          <p className="text-sm text-foreground-muted">
            {d("stockRef")}{" "}
            <span dir="auto" className="font-medium text-foreground">
              {stockRef}
            </span>
          </p>
        ) : null}
      </div>

      {highlights.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {highlights.map(({ id, icon: Icon, title, detail }) => (
            <li key={id} data-testid={`dossier-${id}`} className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
              <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300">
                <Icon className="size-[1.125rem]" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{title}</span>
                {detail ? <span className="text-sm text-foreground-muted text-pretty">{detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {papers.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="size-4 text-foreground-muted" aria-hidden="true" />
            {t("vehicle-papers.label")}
          </h3>
          <ul className="flex flex-wrap gap-2">
            {papers.map((paper) => (
              <li key={paper} className="inline-flex items-center gap-1.5 rounded-full bg-success-surface px-3 py-1 text-sm">
                <Check className="size-3.5 text-success" aria-hidden="true" />
                {option("vehicle-papers", paper)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {equipment.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          <h3 className="text-sm font-semibold">{t("car-equipment.label")}</h3>
          <ul className="flex flex-wrap gap-2">
            {equipment.map((item) => (
              <li key={item} className="rounded-full border border-border px-3 py-1 text-sm">
                {option("car-equipment", item)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-foreground-muted text-pretty">{d("declared")}</p>
    </section>
  );
}
