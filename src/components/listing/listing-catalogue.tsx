"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { CircleCheck, CircleSlash, PackageCheck, TriangleAlert } from "lucide-react";
import { radioKeyTarget } from "@/components/post/controls/chips";
import type { Locale } from "@/config/site";
import type { ListingVariants } from "@/lib/contracts/catalog";
import { isSoldOut, promoRunning, stockState, type PromoView, type StockState } from "@/lib/contracts/catalog-core";
import { formatPrice } from "@/lib/listings/client/format";
import { initialSelection, selectedKey, valueState, type ValueState } from "@/lib/listings/client/variant-picker";
import type { PublicCatalogue } from "@/lib/listings/public";
import { cn } from "@/lib/utils";
import { useNow } from "./use-now";
import { setVariantSelection } from "./variant-selection";

// Stock and variants of a Pro listing on its page (catalogue §2-3, decision 1). Without variants:
// the declared stock line. With them: one chip row per axis (« Taille : M »); a value whose matches
// are all sold out stays choosable, struck through; the chosen combination shows its price and
// stock, and the contact bar's first message names it. Rendered on the server too: no shift. The
// page translates the axes and values (no criteria catalog, no zod in the page's JavaScript).

/** An axis as the page names it: « Taille » and its values « S », « M »… (same order as the variants). */
export interface PickerAxis {
  name: string;
  values: string[];
}

export interface ListingCatalogueProps {
  listingId: string;
  catalogue: PublicCatalogue;
  /** Translated axes of `catalogue.variants`. */
  axes: PickerAxis[];
  /** The listing's price: a combination without its own takes it. */
  price: number | null;
  locale: Locale;
  /** Epoch ms of the server render (the promotion's clock). */
  renderedAt: number;
}

export function ListingCatalogue({ listingId, catalogue, axes, price, locale, renderedAt }: ListingCatalogueProps) {
  if (!catalogue.variants) return catalogue.stock === null ? null : <StockLine state={stockState(catalogue.stock)} count={catalogue.stock} />;
  return <VariantPicker listingId={listingId} variants={catalogue.variants} axes={axes} price={price} locale={locale} promo={catalogue.promo} renderedAt={renderedAt} />;
}

const STOCK_ICONS: Record<Exclude<StockState, "untracked">, typeof CircleCheck> = { in_stock: CircleCheck, low: TriangleAlert, sold_out: CircleSlash };

function StockLine({ state, count, className }: { state: StockState; count: number | null; className?: string }) {
  const t = useTranslations("ListingPage.catalogue");
  if (state === "untracked") return null;
  const Icon = STOCK_ICONS[state];
  return (
    <p
      data-testid="stock-line"
      data-state={state}
      className={cn(
        "inline-flex items-center gap-1.5 self-start text-sm font-medium",
        state === "in_stock" && "text-success",
        state === "low" && "text-warning",
        state === "sold_out" && "text-danger",
        className,
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {state === "low" ? t("low", { count: count ?? 0 }) : state === "sold_out" ? t("soldOut") : t("inStock")}
    </p>
  );
}

interface VariantPickerProps {
  listingId: string;
  variants: ListingVariants;
  axes: PickerAxis[];
  price: number | null;
  locale: Locale;
  promo: PromoView | null;
  renderedAt: number;
}

function VariantPicker({ listingId, variants, axes, price, locale, promo, renderedAt }: VariantPickerProps) {
  const t = useTranslations("ListingPage.catalogue");
  const now = useNow(renderedAt, 15_000, promo !== null);
  const [selection, setSelection] = useState<(string | undefined)[]>(() => initialSelection(variants));
  const key = selectedKey(selection);
  const item = key === null ? undefined : variants.items.find((entry) => entry.key === key);
  const valueName = (axis: number, value: string) => axes[axis]?.values[variants.axes[axis]?.values.indexOf(value) ?? -1] ?? value;
  const label = key === null ? null : selection.map((value, axis) => valueName(axis, value ?? "")).join(" / ");

  // The contact bar names the offered combination in the first message.
  useEffect(() => {
    setVariantSelection(listingId, item && label ? label : null);
    return () => setVariantSelection(listingId, null);
  }, [listingId, item, label]);

  const allSoldOut = isSoldOut({ variants });
  // The chosen combination's promotional price while the promotion runs, and its struck-out price.
  const promoted = item && promoRunning(promo, now) ? promo?.prices.find((entry) => entry.key === item.key) : undefined;
  const itemPrice = item ? (item.price ?? price) : null;

  return (
    <section data-testid="variant-picker" aria-label={t("title")} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 sm:max-w-xl">
      {variants.axes.map((axis, index) => (
        <AxisChoice
          key={axis.id}
          axis={axis}
          name={axes[index]?.name ?? ""}
          valueName={(value) => valueName(index, value)}
          chosen={selection[index]}
          states={axis.values.map((value) => valueState(variants, index, value, selection))}
          onChoose={(value) => setSelection((current) => current.map((entry, at) => (at === index ? value : entry)))}
        />
      ))}

      <div role="status" className="flex min-h-11 flex-col justify-center gap-1 border-t border-border pt-3">
        {key === null ? (
          <p className="text-sm text-foreground-muted text-pretty">{t("choose")}</p>
        ) : !item ? (
          <p className="text-sm text-foreground-muted text-pretty">{t("notOffered")}</p>
        ) : (
          <>
            <p data-testid="variant-summary" className="flex flex-wrap items-baseline gap-x-2 text-base">
              <span className="font-medium">{label}</span>
              {promoted ? (
                <>
                  <span className="font-semibold text-danger tabular-nums">{formatPrice(promoted.price, locale)}</span>
                  {promoted.reference !== null ? (
                    <s className="text-sm text-foreground-muted tabular-nums decoration-1">
                      <span className="sr-only">{t("before")} </span>
                      {formatPrice(promoted.reference, locale)}
                    </s>
                  ) : null}
                </>
              ) : itemPrice !== null ? (
                <span className="font-semibold tabular-nums">{formatPrice(itemPrice, locale)}</span>
              ) : null}
            </p>
            <StockLine state={stockState(item.stock)} count={item.stock ?? null} />
          </>
        )}
      </div>

      {allSoldOut ? (
        <p className="flex items-start gap-2 rounded-md bg-surface-muted px-3 py-2 text-sm text-pretty">
          <PackageCheck className="mt-0.5 size-4 shrink-0 text-foreground-muted" aria-hidden="true" />
          {t("allSoldOut")}
        </p>
      ) : null}
    </section>
  );
}

interface AxisChoiceProps {
  axis: ListingVariants["axes"][number];
  name: string;
  valueName: (value: string) => string;
  chosen: string | undefined;
  states: ValueState[];
  onChoose: (value: string) => void;
}

function AxisChoice({ axis, name: axisName, valueName, chosen, states, onChoose }: AxisChoiceProps) {
  const t = useTranslations("ListingPage.catalogue");
  const labelId = useId();
  const chosenIndex = axis.values.findIndex((value) => value === chosen);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const target = radioKeyTarget(event.key, index, axis.values.length, rtl);
    const value = target === null ? undefined : axis.values[target];
    if (target === null || value === undefined) return;
    event.preventDefault();
    onChoose(value);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[target]?.focus();
  }

  return (
    <div className="flex flex-col gap-2">
      <p id={labelId} className="text-sm">
        <span className="font-medium">{axisName}</span>
        {chosen !== undefined ? <span className="text-foreground-muted"> : {valueName(chosen)}</span> : null}
      </p>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {axis.values.map((value, index) => {
          const state = states[index] ?? "available";
          const checked = value === chosen;
          const name = valueName(value);
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={state === "available" ? name : t(state === "sold_out" ? "valueSoldOut" : "valueAbsent", { value: name })}
              tabIndex={checked || (chosenIndex === -1 && index === 0) ? 0 : -1}
              onClick={() => onChoose(value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border-control bg-surface px-3.5 py-2 text-base",
                "transition-[background-color,border-color,color,scale] duration-150 ease-door hover:bg-surface-muted active:scale-[0.98]",
                "aria-checked:border-structure aria-checked:bg-structure aria-checked:text-structure-foreground aria-checked:hover:bg-bab-600",
                state !== "available" && "border-dashed text-foreground-muted line-through decoration-1",
              )}
            >
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
