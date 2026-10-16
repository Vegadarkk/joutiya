"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useLocale, useTranslations } from "next-intl";
import { ChipCheckboxGroup, ChipRadioGroup } from "@/components/post/controls/chips";
import { Select } from "@/components/post/controls/select";
import { SwitchField } from "@/components/post/controls/switch";
import { NumberInput } from "@/components/post/criteria-fields";
import { useCategoryLabels } from "@/components/post/labels";
import { Button } from "@/components/ui/button";
import { CATEGORIES, CONDITIONS, subcategoryById, type Condition } from "@/config/categories";
import type { Locale } from "@/config/site";
import { currencyLabel } from "@/lib/listings/client/format";
import { canonicalSearchParams, RADIUS_KM, type SearchParams, type SellerTypeFilter } from "@/lib/search/params";
import type { SearchFacets } from "@/lib/search/types";
import { cn } from "@/lib/utils";
import { SearchCityCombobox } from "./city-combobox";
import { CriteriaFilters } from "./criteria-filters";
import { clearFilters, conditionApplies, countFilters, districtLabel, filterableCriteria } from "./filter-model";
import { locationOf, sameLocation, type LocationValue } from "./location";
import { useSearchNavigation } from "./search-navigation";

// Every filter of the search in one sheet (design §2 L3b): a bottom sheet on phones, a side panel
// from the inline end on larger screens (Radix Dialog: focus trap, Escape, scroll lock). Changes
// stay in a draft until "Voir les résultats", which navigates to the new URL (page 1).

/** Category select value: "" (all), "c:<category>" or "s:<subcategory>". */
export function categoryValue(params: Pick<SearchParams, "category" | "subcategory">): string {
  if (params.subcategory) return `s:${params.subcategory}`;
  if (params.category) return `c:${params.category}`;
  return "";
}

/** The draft after choosing a category value; criteria and conditions that no longer apply go. */
export function withCategory(draft: SearchParams, value: string): SearchParams {
  const next: SearchParams = { ...draft };
  const [kind, id] = value.split(":");
  if (kind === "s" && id && subcategoryById(id)) {
    if (next.subcategory !== id) delete next.criteria;
    next.subcategory = id;
    next.category = subcategoryById(id)?.categoryId;
  } else {
    delete next.subcategory;
    delete next.criteria;
    next.category = kind === "c" && id ? id : undefined;
  }
  if (!conditionApplies(next)) delete next.conditions;
  return next;
}

/** The draft after choosing a place: radius and district belong to the previous city. */
export function withLocation(draft: SearchParams, location: LocationValue): SearchParams {
  if (sameLocation(locationOf(draft), location)) return draft;
  const next: SearchParams = { ...draft, city: location.city, region: location.city ? undefined : location.region };
  delete next.radiusKm;
  delete next.district;
  if (!next.city && next.sort === "distance") delete next.sort;
  return next;
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-3 py-5 first:pt-1", className)}>
      <h3 id={id} className="text-base font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

interface FiltersSheetProps {
  params: SearchParams;
  facets?: SearchFacets;
  className?: string;
}

export function FiltersSheet({ params, facets, className }: FiltersSheetProps) {
  const t = useTranslations("SearchFilters");
  const conditionNames = useTranslations("Criteria.condition.options");
  const location = useTranslations("Search.location");
  const names = useCategoryLabels();
  const locale = useLocale() as Locale;
  const navigation = useSearchNavigation();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SearchParams>(params);
  const count = countFilters(params);
  const update = (patch: Partial<SearchParams>) => setDraft((current) => ({ ...current, ...patch }));

  // District choices come from the facet of the current city only (D7: no district list exists).
  const districts = draft.city && draft.city === params.city && !draft.radiusKm ? Object.entries(facets?.districts ?? {}).filter(([, n]) => n > 0) : [];
  districts.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const criteria = filterableCriteria(draft.subcategory);

  function apply(event: FormEvent) {
    event.preventDefault();
    navigation?.navigate(canonicalSearchParams({ ...draft, page: undefined }));
    setOpen(false);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(params);
        setOpen(next);
      }}
    >
      <Dialog.Trigger asChild>
        <Button type="button" variant="outline" className={cn("h-11 gap-2 px-3.5", count > 0 && "border-structure", className)} aria-label={count > 0 ? t("openCount", { count }) : undefined}>
          <SlidersHorizontal aria-hidden="true" />
          {t("open")}
          {count > 0 ? (
            <span aria-hidden="true" className="inline-flex min-w-5 items-center justify-center rounded-full bg-structure px-1.5 text-xs font-semibold text-structure-foreground tabular-nums">
              {count}
            </span>
          ) : null}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="filters-sheet"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-2xl border-t border-border bg-surface text-foreground shadow-2xl shadow-bab-950/30 outline-none",
            "sm:inset-y-0 sm:start-auto sm:end-0 sm:max-h-none sm:w-[26rem] sm:rounded-none sm:border-t-0 sm:border-s",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom",
            "sm:data-[state=open]:[--tw-enter-translate-y:0] ltr:sm:data-[state=open]:slide-in-from-right rtl:sm:data-[state=open]:slide-in-from-left",
          )}
        >
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong sm:hidden" />
          <form onSubmit={apply} className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-2 sm:py-3">
              <Dialog.Title className="text-lg font-semibold">{t("title")}</Dialog.Title>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="icon" aria-label={t("close")} className="-me-2">
                  <X aria-hidden="true" />
                </Button>
              </Dialog.Close>
            </div>

            <div className="flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto overscroll-contain px-5">
              <Section title={t("sections.category")}>
                <label htmlFor={`${ids}-category`} className="sr-only">
                  {t("sections.category")}
                </label>
                <Select id={`${ids}-category`} value={categoryValue(draft)} onChange={(event) => setDraft((current) => withCategory(current, event.target.value))}>
                  <option value="">{t("allCategories")}</option>
                  {CATEGORIES.map((category) => (
                    <optgroup key={category.id} label={names.category(category.id)}>
                      <option value={`c:${category.id}`}>{t("allOfCategory", { category: names.category(category.id) })}</option>
                      {category.subcategories.map((sub) => (
                        <option key={sub.id} value={`s:${sub.id}`}>
                          {names.subcategory(category.id, sub.id)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
                {draft.category && !draft.subcategory ? <p className="text-sm text-foreground-muted">{t("criteriaHint")}</p> : null}
              </Section>

              <Section title={t("sections.location")}>
                <SearchCityCombobox value={locationOf(draft)} onChange={(value) => setDraft((current) => withLocation(current, value))} label={location("label")} hideLabel inline />
                {draft.city ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor={`${ids}-radius`} className="text-sm font-medium">
                        {t("sections.radius")}
                      </label>
                      <Select
                        id={`${ids}-radius`}
                        value={draft.radiusKm ? String(draft.radiusKm) : ""}
                        onChange={(event) => {
                          const km = RADIUS_KM.find((value) => String(value) === event.target.value);
                          update({ radiusKm: km, district: km ? undefined : draft.district });
                        }}
                      >
                        <option value="">{t("radiusNone")}</option>
                        {RADIUS_KM.map((km) => (
                          <option key={km} value={km}>
                            {t("radiusKm", { km })}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {districts.length > 0 ? (
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={`${ids}-district`} className="text-sm font-medium">
                          {t("sections.district")}
                        </label>
                        <Select id={`${ids}-district`} value={draft.district ?? ""} onChange={(event) => update({ district: event.target.value || undefined })}>
                          <option value="">{t("allDistricts")}</option>
                          {districts.map(([key, n]) => (
                            <option key={key} value={key}>
                              {t("districtCount", { district: districtLabel(key), count: n })}
                            </option>
                          ))}
                        </Select>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-foreground-muted">{t("radiusHint")}</p>
                )}
              </Section>

              <Section title={t("sections.price")}>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`${ids}-price-min`} className="text-xs text-foreground-muted">
                      {t("priceMin")}
                    </label>
                    <NumberInput id={`${ids}-price-min`} value={draft.priceMin} min={0} unit={currencyLabel(locale)} onChange={(value) => update({ priceMin: value })} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`${ids}-price-max`} className="text-xs text-foreground-muted">
                      {t("priceMax")}
                    </label>
                    <NumberInput id={`${ids}-price-max`} value={draft.priceMax} min={0} unit={currencyLabel(locale)} onChange={(value) => update({ priceMax: value })} />
                  </div>
                </div>
              </Section>

              {draft.shop ? null : (
                <Section title={t("sections.seller")}>
                  <ChipRadioGroup
                    label={t("sections.seller")}
                    value={draft.sellerType ?? ""}
                    onChange={(value) => update({ sellerType: (value || undefined) as SellerTypeFilter | undefined })}
                    options={[
                      { value: "", label: t("sellerAll") },
                      { value: "individual", label: t("sellerIndividual") },
                      { value: "pro", label: t("sellerPro") },
                    ]}
                  />
                </Section>
              )}

              {conditionApplies(draft) ? (
                <Section title={t("sections.condition")}>
                  <ChipCheckboxGroup
                    label={t("sections.condition")}
                    values={draft.conditions ?? []}
                    onChange={(values) => update({ conditions: values.length ? CONDITIONS.filter((value) => values.includes(value)) : undefined })}
                    options={CONDITIONS.map((value: Condition) => ({ value, label: conditionNames(value) }))}
                  />
                </Section>
              ) : null}

              <Section title={t("sections.options")} className="gap-1">
                <SwitchField label={t("withPhoto")} checked={Boolean(draft.withPhoto)} onCheckedChange={(checked) => update({ withPhoto: checked ? true : undefined })} />
                <SwitchField label={t("donation")} checked={Boolean(draft.donation)} onCheckedChange={(checked) => update({ donation: checked ? true : undefined })} />
              </Section>

              {draft.subcategory && criteria.length > 0 ? (
                <Section title={t("sections.criteria", { subcategory: names.subcategory(draft.category ?? "", draft.subcategory) })}>
                  <CriteriaFilters subcategoryId={draft.subcategory} value={draft.criteria} onChange={(value) => update({ criteria: value })} />
                </Section>
              ) : null}
            </div>

            <div className="flex items-center gap-2 border-t border-border px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button type="button" variant="ghost" onClick={() => setDraft((current) => clearFilters(current))}>
                {t("reset")}
              </Button>
              <Button type="submit" className="flex-1">
                {t("apply")}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
