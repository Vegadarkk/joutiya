import { BadgeCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Locale } from "@/config/site";
import type { ListingAttributes } from "@/lib/contracts/listings";
import { formatPrice } from "@/lib/listings/client/format";
import { cn } from "@/lib/utils";

// The terms of a property listing, under the price (Agence pack design §3): an agency's mandate,
// reference and fees (law 31-08 art. 3: the price and what comes on top of it, side by side), an
// off-plan sale's delivery and permit (law 44-00), a holiday rental's tourist authorisation as
// declared by the host (law 80-14: never checked by the site). These fields leave the criteria
// grid (PROPERTY_TERM_FIELDS) so each shows once.

export const PROPERTY_TERM_FIELDS: readonly string[] = ["mandate", "agency-reference", "agency-fees", "agency-fees-amount", "off-plan", "building-permit", "delivery-year", "tourism-authorization"];

interface Row {
  id: string;
  label: string;
  value: string;
  /** Free text typed by the seller: its own direction. */
  userText?: boolean;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const integer = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) ? value : undefined);

export function PropertyTerms({ attributes, locale, className }: { attributes: ListingAttributes; locale: Locale; className?: string }) {
  const t = useTranslations("ListingPage.terms");
  const rows: Row[] = [];
  const mandate = text(attributes["mandate"]);
  if (mandate === "exclusif" || mandate === "simple" || mandate === "vente-directe") rows.push({ id: "mandate", label: t("mandate"), value: t(`mandates.${mandate}`) });
  const reference = text(attributes["agency-reference"]);
  if (reference) rows.push({ id: "reference", label: t("reference"), value: reference, userText: true });
  const fees = text(attributes["agency-fees"]);
  const amount = integer(attributes["agency-fees-amount"]);
  if (fees === "en-sus") rows.push({ id: "fees", label: t("fees"), value: amount !== undefined ? t("feesOnTopAmount", { amount: formatPrice(amount, locale) }) : t("feesOnTop") });
  else if (fees === "inclus") rows.push({ id: "fees", label: t("fees"), value: amount !== undefined ? t("feesIncludedAmount", { amount: formatPrice(amount, locale) }) : t("feesIncluded") });
  else if (fees === "sans-frais") rows.push({ id: "fees", label: t("fees"), value: t("feesNone") });
  if (attributes["off-plan"] === true) {
    const year = integer(attributes["delivery-year"]);
    rows.push({ id: "off-plan", label: t("offPlan"), value: year !== undefined ? t("delivery", { year: String(year) }) : t("offPlanYes") });
    const permit = text(attributes["building-permit"]);
    if (permit) rows.push({ id: "permit", label: t("permit"), value: permit, userText: true });
  }
  const authorization = text(attributes["tourism-authorization"]);
  if (authorization) rows.push({ id: "authorization", label: t("authorization"), value: t("declared", { number: authorization }) });
  if (rows.length === 0) return null;

  return (
    <div data-testid="property-terms" className={cn("flex flex-col gap-3 rounded-md border border-border bg-surface-muted/60 p-4", className)}>
      {mandate === "exclusif" ? (
        <p className="inline-flex items-center gap-1.5 self-start rounded-sm bg-featured px-2 py-0.5 text-xs font-medium text-featured-foreground">
          <BadgeCheck className="size-3.5" aria-hidden="true" />
          {t("exclusive")}
        </p>
      ) : null}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        {rows.map((row) => (
          <div key={row.id} className="contents">
            <dt className="text-foreground-muted">{row.label}</dt>
            <dd dir={row.userText ? "auto" : undefined} className="mb-1 font-medium break-words sm:mb-0">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
