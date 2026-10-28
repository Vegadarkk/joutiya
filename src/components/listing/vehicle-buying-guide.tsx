import { AlertTriangle, CarFront } from "lucide-react";
import { useTranslations } from "next-intl";
import { SITE_NAME } from "@/config/site";
import type { ListingAttributes } from "@/lib/contracts/listings";
import { cn } from "@/lib/utils";

// "Buying this vehicle in Morocco" (Concession pack, design concession/concession.md §2 and §7):
// the checks and the ownership transfer (mutation) a buyer goes through, on every vehicle for sale.
// Facts that change with the listing: a vehicle not yet through customs, financing (loi 31-08
// art. 76-78: written offer with the APR), a seller's warranty (art. 66-67: written warranty).
// The site sells nothing and takes no payment: said last.

const STEPS = ["owner", "mutation", "pledge", "inspection", "payment"] as const;

export interface VehicleBuyingGuideProps {
  attributes: ListingAttributes;
  sellerType: "individual" | "pro";
  className?: string;
}

export function VehicleBuyingGuide({ attributes, sellerType, className }: VehicleBuyingGuideProps) {
  const t = useTranslations("ListingPage.buyingGuide");
  const notes: string[] = [];
  if (attributes["financing"] === true) notes.push(t("notes.financing"));
  if (attributes["vehicle-warranty"] === "vendeur" && sellerType === "pro") notes.push(t("notes.warranty"));

  return (
    <section data-testid="vehicle-buying-guide" aria-labelledby="buying-guide-title" className={cn("flex flex-col gap-4 rounded-lg border border-border p-5", className)}>
      <h2 id="buying-guide-title" className="flex items-center gap-2.5 text-lg font-semibold">
        <CarFront className="size-5 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" />
        {t("title")}
      </h2>
      {attributes["origin"] === "pas-dedouanee" ? (
        <p data-testid="buying-guide-customs" className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-surface px-3 py-2 text-sm text-pretty">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>{t("customs")}</span>
        </p>
      ) : null}
      <ol className="flex flex-col gap-3">
        {STEPS.map((step, index) => (
          <li key={step} className="flex items-start gap-3 text-sm text-pretty">
            <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-brand text-xs font-semibold tabular-nums text-structure dark:text-gold-300">
              {index + 1}
            </span>
            <span>{t(`steps.${step}`, { brand: SITE_NAME })}</span>
          </li>
        ))}
      </ol>
      {notes.length > 0 ? (
        <ul className="flex flex-col gap-2 border-t border-border pt-3">
          {notes.map((note) => (
            <li key={note} className="text-sm text-foreground-muted text-pretty">
              {note}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-foreground-muted text-pretty">{t("source")}</p>
    </section>
  );
}
