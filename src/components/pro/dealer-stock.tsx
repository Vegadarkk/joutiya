import { BadgeCheck, CarFront, HandCoins, Repeat2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { formatPrice } from "@/lib/listings/client/format";
import { DEALER_BRANDS_MAX, type DealerStock as Stock } from "@/lib/search/dealer";
import { SEARCH_PATH, searchQueryObject, type SearchParams } from "@/lib/search/params";
import { cn } from "@/lib/utils";

// Vehicle stock of a Pro shop on its storefront (Concession pack, design concession/concession.md
// §5): how many vehicles, from what price, by type, brand and engine, each a link to the search
// narrowed to the shop. Services are what the listings declare; the site checks none of them and
// sells nothing, so the note says where the terms are agreed.

export interface DealerStockProps {
  stock: Stock;
  /** The shop's public id: the search's `boutique` filter. */
  shop: string;
  className?: string;
}

/** Fuel and gearbox apply to cars and vans; a link narrows to cars when the shop sells some. */
function engineSubcategory(stock: Stock): string {
  return stock.subcategories.some((entry) => entry.value === "voitures") ? "voitures" : "utilitaires-camions";
}

function brandSubcategory(stock: Stock, criterion: "car-brand" | "moto-brand"): string {
  return criterion === "moto-brand" ? "motos-scooters" : engineSubcategory(stock);
}

const searchHref = (params: SearchParams) => ({ pathname: SEARCH_PATH, query: searchQueryObject(params) });

const chip =
  "inline-flex min-h-9 items-center gap-2 rounded-full border border-border bg-surface px-3.5 text-sm transition-colors duration-150 ease-door hover:border-structure hover:bg-surface-brand";

function Count({ value }: { value: number }) {
  return <span className="text-xs font-semibold text-foreground-muted tabular-nums">{value}</span>;
}

export function DealerStock({ stock, shop, className }: DealerStockProps) {
  const t = useTranslations("Storefront.dealer");
  const criteria = useTranslations("Criteria");
  const categories = useTranslations("Categories.vehicules.sub");
  const locale = useLocale() as Locale;
  type CriteriaKey = Parameters<typeof criteria.has>[0];
  const option = (id: string, value: string) => (criteria.has(`${id}.options.${value}` as CriteriaKey) ? criteria(`${id}.options.${value}` as CriteriaKey) : value);
  type SubKey = Parameters<typeof categories.has>[0];
  const subcategory = (id: string) => (categories.has(id as SubKey) ? categories(id as SubKey) : id);

  const brands = stock.brands.slice(0, DEALER_BRANDS_MAX);
  const otherBrands = stock.brands.length - brands.length;
  const engine = engineSubcategory(stock);
  const engines = [
    ...stock.fuels.map((entry) => ({ ...entry, criterion: "fuel" })),
    ...stock.gearboxes.map((entry) => ({ ...entry, criterion: "gearbox" })),
  ];
  const services = [
    { key: "tradeIn", count: stock.services.tradeIn, Icon: Repeat2 },
    { key: "financing", count: stock.services.financing, Icon: HandCoins },
    { key: "warranty", count: stock.services.warranty, Icon: BadgeCheck },
  ] as const;
  const declared = services.filter((service) => service.count > 0);
  const price = stock.price;

  return (
    <section data-testid="dealer-stock" aria-labelledby="dealer-stock-title" className={cn("flex flex-col gap-6 rounded-lg border border-border bg-surface p-5 sm:p-7", className)}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-4">
          <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300">
            <CarFront className="size-6" />
          </span>
          <div className="flex flex-col gap-0.5">
            <h2 id="dealer-stock-title" className="text-xl font-semibold">
              {t("title")}
            </h2>
            <p className="text-foreground-muted">
              <span className="font-semibold text-foreground tabular-nums">{t("count", { count: stock.total })}</span>
              {price ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="tabular-nums">{price.min === price.max ? formatPrice(price.min, locale) : t("priceRange", { min: formatPrice(price.min, locale), max: formatPrice(price.max, locale) })}</span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <Button asChild variant="structure" className="self-start sm:self-auto">
          <Link href={searchHref({ shop, category: "vehicules" })}>{t("seeAll")}</Link>
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {stock.subcategories.length > 1 ? (
          <div className="flex flex-col gap-2.5">
            <h3 className="text-sm font-medium text-foreground-muted">{t("types")}</h3>
            <ul className="flex flex-wrap gap-2">
              {stock.subcategories.map((entry) => (
                <li key={entry.value}>
                  <Link className={chip} href={searchHref({ shop, subcategory: entry.value })}>
                    {subcategory(entry.value)}
                    <Count value={entry.count} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {brands.length > 0 ? (
          <div className={cn("flex flex-col gap-2.5", stock.subcategories.length > 1 ? "" : "lg:col-span-2")}>
            <h3 className="text-sm font-medium text-foreground-muted">{t("brands")}</h3>
            <ul className="flex flex-wrap gap-2">
              {brands.map((entry) => (
                <li key={`${entry.criterion}:${entry.value}`}>
                  <Link className={chip} href={searchHref({ shop, subcategory: brandSubcategory(stock, entry.criterion), criteria: { [entry.criterion]: { kind: "options", values: [entry.value] } } })}>
                    {option(entry.criterion, entry.value)}
                    <Count value={entry.count} />
                  </Link>
                </li>
              ))}
              {otherBrands > 0 ? <li className="inline-flex min-h-9 items-center px-1 text-sm text-foreground-muted">{t("otherBrands", { count: otherBrands })}</li> : null}
            </ul>
          </div>
        ) : null}
        {engines.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            <h3 className="text-sm font-medium text-foreground-muted">{t("engine")}</h3>
            <ul className="flex flex-wrap gap-2">
              {engines.map((entry) => (
                <li key={`${entry.criterion}:${entry.value}`}>
                  <Link className={chip} href={searchHref({ shop, subcategory: engine, criteria: { [entry.criterion]: { kind: "options", values: [entry.value] } } })}>
                    {option(entry.criterion, entry.value)}
                    <Count value={entry.count} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {declared.length > 0 ? (
        <div className="flex flex-col gap-3 border-t border-border pt-5">
          <ul className="flex flex-wrap gap-x-6 gap-y-2.5">
            {declared.map(({ key, count, Icon }) => (
              <li key={key} className="inline-flex items-center gap-2 text-sm">
                <Icon className="size-4 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" />
                <span className="font-medium">{t(`services.${key}`)}</span>
                <span className="text-foreground-muted">{t("onVehicles", { count })}</span>
              </li>
            ))}
          </ul>
          <p className="max-w-prose text-xs text-foreground-muted text-pretty">{t("servicesNote")}</p>
        </div>
      ) : null}
    </section>
  );
}
