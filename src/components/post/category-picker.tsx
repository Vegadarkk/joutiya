"use client";

import { ArrowRight, Baby, Building2, Car, Check, ChevronRight, Dumbbell, Handshake, Package, PawPrint, Shirt, Smartphone, Sofa, Wheat, Wrench, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { textLinkClassName } from "@/components/ui/text-link";
import { CATEGORIES, categoryById, type Subcategory } from "@/config/categories";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { useCategoryLabels } from "./labels";

/** One icon per category (lucide); ids from src/config/categories.ts. */
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  vehicules: Car,
  immobilier: Building2,
  electronique: Smartphone,
  "maison-jardin": Sofa,
  mode: Shirt,
  terroir: Wheat,
  famille: Baby,
  loisirs: Dumbbell,
  animaux: PawPrint,
  "materiel-pro": Wrench,
  services: Handshake,
  divers: Package,
};

interface CategoryPickerProps {
  categoryId: string | null;
  subcategoryId: string | null;
  onCategory: (categoryId: string | null) => void;
  onSubcategory: (subcategory: Subcategory) => void;
  /** Pro-only subcategories are listed but disabled until phase 7. */
  isPro?: boolean;
}

/** Step 1: the twelve categories as a grid of tiles, then the subcategories of the chosen one. */
export function CategoryPicker({ categoryId, subcategoryId, onCategory, onSubcategory, isPro = false }: CategoryPickerProps) {
  const t = useTranslations("Listing.category");
  const names = useCategoryLabels();
  const category = categoryId ? categoryById(categoryId) : undefined;

  if (!category) {
    return (
      <div role="radiogroup" aria-label={t("categories")} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {CATEGORIES.map((item) => {
          const Icon = CATEGORY_ICONS[item.id] ?? Package;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={false}
              onClick={() => onCategory(item.id)}
              className={cn(
                "flex min-h-24 flex-col items-start justify-between gap-3 rounded-lg border border-border bg-surface p-4 text-start",
                "transition-[border-color,background-color,scale] duration-150 ease-door hover:border-structure/60 hover:bg-surface-muted active:scale-[0.99]",
              )}
            >
              <Icon className="size-6 text-structure" aria-hidden="true" strokeWidth={1.75} />
              <span className="font-medium leading-tight">{names.category(item.id)}</span>
            </button>
          );
        })}
      </div>
    );
  }

  const Icon = CATEGORY_ICONS[category.id] ?? Package;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-brand px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Icon className="size-6 shrink-0 text-structure" aria-hidden="true" strokeWidth={1.75} />
          <div className="flex min-w-0 flex-col">
            <span className="text-xs text-foreground-muted">{t("chosen")}</span>
            <span className="truncate font-semibold">{names.category(category.id)}</span>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => onCategory(null)} className="shrink-0 max-sm:h-11">
          {t("change")}
        </Button>
      </div>
      {/* The radios are the group's direct children: a list in between would put list items under a
          radiogroup, which has no list semantics. */}
      <div role="radiogroup" aria-label={t("subcategories", { category: names.category(category.id) })} className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
        {category.subcategories.map((subcategory) => {
          const checked = subcategory.id === subcategoryId;
          const locked = Boolean(subcategory.proOnly) && !isPro;
          return (
            <button
              key={subcategory.id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-disabled={locked || undefined}
              onClick={() => (locked ? undefined : onSubcategory(subcategory))}
              className={cn(
                "flex min-h-12 w-full items-center justify-between gap-3 px-4 py-3 text-start transition-colors duration-150 ease-door",
                "first:rounded-t-lg last:rounded-b-lg focus-visible:-outline-offset-2",
                locked ? "cursor-not-allowed text-foreground-muted" : "hover:bg-surface-muted",
                checked && "bg-structure text-structure-foreground hover:bg-bab-600",
              )}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{names.subcategory(category.id, subcategory.id)}</span>
                {locked ? <span className="text-xs">{t("proOnly")}</span> : null}
              </span>
              {checked ? <Check className="size-5 shrink-0" aria-hidden="true" /> : <ChevronRight className="size-5 shrink-0 text-foreground-muted rtl:-scale-x-100" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      {category.subcategories.some((s) => s.proOnly) && !isPro ? (
        // The lock names the offer and leads to it (journey review 2026-10-29): it said the Pro accounts were not open yet.
        <ErrorBanner
          tone="info"
          title={t("proOnly")}
          action={
            <Link href="/professionnels" prefetch={false} className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-sm text-sm font-medium text-link sm:min-h-9", textLinkClassName)}>
              {t("proOnlyLink")}
              <ArrowRight aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
            </Link>
          }
        >
          {t("proOnlyBody")}
        </ErrorBanner>
      ) : null}
    </div>
  );
}
