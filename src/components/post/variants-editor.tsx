"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { criterionById, type Subcategory } from "@/config/categories";
import type { Locale } from "@/config/site";
import { STOCK_MAX, VARIANT_ITEMS_MAX, VARIANT_LABEL_MAX, VARIANT_VALUES_MAX, isVariantCriterion, type ListingVariants, type VariantAxis, type VariantAxisId, type VariantItem } from "@/lib/contracts/catalog";
import { currencyLabel, groupDigits, parsePriceInput } from "@/lib/listings/client/format";
import { PRICE_MAX } from "@/lib/listings/client/validation";
import { cleanValue, combinationCount, hasValue, nextFreeAxis, rebuildItems, remainingAxes, variantsPatch } from "@/lib/listings/client/variants";
import { cn } from "@/lib/utils";
import { ChipCheckboxGroup, ChipRadioGroup } from "./controls/chips";
import { Select } from "./controls/select";
import { SwitchField } from "./controls/switch";
import { useCriteriaLabels } from "./labels";
import { useVariantLabels } from "./variant-labels";

// Stock and variants of a Pro listing (catalogue §2-3, price step): one model with an optional
// declared stock, or up to two axes (a criterion of the subcategory such as the size, or a free
// one such as « Contenance ») and their combinations, each with its stock, price and reference.
// The block keeps its own draft and hands the wizard complete variants only (the API refuses a
// half-built axis), so typing never fails a save.

export interface VariantsEditorProps {
  subcategory: Subcategory;
  /** The listing's price: the default of a combination without its own. */
  price: number | null;
  variants: ListingVariants | null;
  stock: number | null;
  onChange: (patch: { variants: ListingVariants | null; stock: number | null }) => void;
  onBlur?: () => void;
}

type Mode = "single" | "variants";

/** Digits only, bounded: "" clears. */
function parseCount(text: string, max: number): number | undefined {
  const parsed = parsePriceInput(text);
  return parsed === null ? undefined : Math.min(parsed, max);
}

export function VariantsEditor({ subcategory, price, variants, stock, onChange, onBlur }: VariantsEditorProps) {
  const t = useTranslations("Listing.catalogue");
  const locale = useLocale() as Locale;
  const criteria = useCriteriaLabels();
  const names = useVariantLabels();
  const headingId = useId();
  const [mode, setMode] = useState<Mode>(variants ? "variants" : "single");
  const [axes, setAxes] = useState<VariantAxis[]>(variants?.axes ?? []);
  const [items, setItems] = useState<VariantItem[]>(variants?.items ?? []);

  /** The axes or items changed: the wizard gets the variants once they are complete. */
  function commit(nextAxes: VariantAxis[], nextItems: VariantItem[]) {
    setAxes(nextAxes);
    setItems(nextItems);
    const complete = variantsPatch(nextAxes, nextItems);
    if (complete) onChange({ variants: complete, stock: null });
  }

  function editAxes(nextAxes: VariantAxis[]) {
    commit(nextAxes, rebuildItems(axes, nextAxes, items));
  }

  function chooseMode(next: Mode) {
    setMode(next);
    if (next === "single") {
      onChange({ variants: null, stock });
      return;
    }
    if (axes.length === 0) {
      const first = remainingAxes(subcategory, [])[0];
      if (first) editAxes([emptyAxis(first)]);
    } else {
      commit(axes, items);
    }
  }

  function emptyAxis(id: VariantAxisId): VariantAxis {
    return isVariantCriterion(id) ? { id, values: [] } : { id, label: "", values: [] };
  }

  const axisName = (axis: Pick<VariantAxis, "id" | "label">) => (isVariantCriterion(axis.id) ? criteria.label(axis.id) : axis.label?.trim() || t("axisFree"));
  const combinationName = (key: string) => names.combination(axes, key);
  const total = combinationCount(axes);
  const offered = new Set(items.map((item) => item.key));

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4 rounded-lg border border-border p-4" onBlur={onBlur}>
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="text-base font-semibold">
          {t("title")}
        </h3>
        <p className="text-sm text-foreground-muted">{t("hint")}</p>
      </div>

      <ChipRadioGroup
        label={t("mode")}
        options={[
          { value: "single", label: t("single") },
          { value: "variants", label: t("multiple") },
        ]}
        value={mode}
        onChange={(value) => chooseMode(value as Mode)}
      />

      {mode === "single" ? (
        <SingleStock stock={stock} onStock={(next) => onChange({ variants: null, stock: next })} />
      ) : (
        <div className="flex flex-col gap-5">
          {axes.map((axis, index) => (
            <AxisEditor
              key={axis.id}
              index={index}
              axis={axis}
              choices={[axis.id, ...remainingAxes(subcategory, axes)]}
              axisName={axisName}
              onChange={(next) => editAxes(axes.map((current, at) => (at === index ? next : current)))}
              onRemove={axes.length > 1 ? () => editAxes(axes.filter((_, at) => at !== index)) : undefined}
              emptyAxis={emptyAxis}
            />
          ))}
          {remainingAxes(subcategory, axes).length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                const next = remainingAxes(subcategory, axes).find((id) => isVariantCriterion(id)) ?? nextFreeAxis(axes);
                if (next) editAxes([...axes, emptyAxis(next)]);
              }}
            >
              <Plus className="size-4" aria-hidden="true" />
              {t("addAxis")}
            </Button>
          ) : null}

          {total > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <h4 className="text-sm font-semibold">{t("combinations")}</h4>
                <p className="text-sm text-foreground-muted">{t("combinationsHint", { price: price === null ? "" : `${groupDigits(String(price))} ${currencyLabel(locale)}` })}</p>
              </div>
              {total > VARIANT_ITEMS_MAX ? <InlineError>{t("tooMany", { count: total, max: VARIANT_ITEMS_MAX })}</InlineError> : null}
              <div className="hidden grid-cols-[minmax(0,1fr)_6rem_8rem_8rem] gap-3 px-3 text-sm text-foreground-muted sm:grid" aria-hidden="true">
                <span>{t("combination")}</span>
                <span>{t("stock")}</span>
                <span>{t("price", { currency: currencyLabel(locale) })}</span>
                <span>{t("ref")}</span>
              </div>
              <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {rebuildItems([], axes, [])
                  .map((item) => item.key)
                  .slice(0, VARIANT_ITEMS_MAX)
                  .map((key) => (
                    <CombinationRow
                      key={key}
                      name={combinationName(key)}
                      item={items.find((item) => item.key === key)}
                      offered={offered.has(key)}
                      price={price}
                      locale={locale}
                      onOffered={(checked) => {
                        const all = rebuildItems([], axes, []).map((entry) => entry.key);
                        const next = checked ? all.filter((k) => offered.has(k) || k === key).map((k) => items.find((item) => item.key === k) ?? { key: k }) : items.filter((item) => item.key !== key);
                        commit(axes, next);
                      }}
                      onItem={(next) => commit(axes, items.map((item) => (item.key === key ? next : item)))}
                    />
                  ))}
              </ul>
              {items.length === 0 ? <InlineError>{t("noneOffered")}</InlineError> : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function SingleStock({ stock, onStock }: { stock: number | null; onStock: (stock: number | null) => void }) {
  const t = useTranslations("Listing.catalogue");
  const [tracked, setTracked] = useState(stock !== null);
  return (
    <div className="flex flex-col gap-3">
      <SwitchField
        label={t("trackStock")}
        hint={t("trackStockHint")}
        checked={tracked}
        onCheckedChange={(checked) => {
          setTracked(checked);
          onStock(checked ? (stock ?? 1) : null);
        }}
      />
      {tracked ? (
        <Field label={t("stock")} className="max-w-40">
          <Input type="text" inputMode="numeric" dir="ltr" autoComplete="off" className="tabular-nums" value={stock === null ? "" : String(stock)} onChange={(event) => onStock(parseCount(event.target.value, STOCK_MAX) ?? 0)} />
        </Field>
      ) : null}
    </div>
  );
}

interface AxisEditorProps {
  index: number;
  axis: VariantAxis;
  choices: VariantAxisId[];
  axisName: (axis: Pick<VariantAxis, "id" | "label">) => string;
  onChange: (axis: VariantAxis) => void;
  onRemove?: () => void;
  emptyAxis: (id: VariantAxisId) => VariantAxis;
}

function AxisEditor({ index, axis, choices, axisName, onChange, onRemove, emptyAxis }: AxisEditorProps) {
  const t = useTranslations("Listing.catalogue");
  const criteria = useCriteriaLabels();
  const criterion = isVariantCriterion(axis.id) ? criterionById(axis.id) : undefined;
  const options = criterion?.options?.filter((option) => option !== "autre") ?? [];
  const legendId = useId();

  return (
    <fieldset aria-labelledby={legendId} className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        <Field label={<span id={legendId}>{t("axis", { n: index + 1 })}</span>} className="flex-1">
          <Select value={axis.id} onChange={(event) => onChange(emptyAxis(event.target.value as VariantAxisId))}>
            {choices.map((id) => (
              <option key={id} value={id}>
                {isVariantCriterion(id) ? criteria.label(id) : t("axisFree")}
              </option>
            ))}
          </Select>
        </Field>
        {onRemove ? (
          <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label={t("removeAxis", { name: axisName(axis) })}>
            <X className="size-5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {criterion ? (
        <ChipCheckboxGroup
          label={axisName(axis)}
          options={options.map((option) => ({ value: option, label: criteria.option(axis.id, option) }))}
          values={axis.values}
          onChange={(values) => onChange({ ...axis, values: options.filter((option) => values.includes(option)) })}
        />
      ) : (
        <FreeAxisValues axis={axis} onChange={onChange} />
      )}
      {axis.values.length === 0 ? <p className="text-sm text-foreground-muted">{t("valuesRequired")}</p> : null}
    </fieldset>
  );
}

function FreeAxisValues({ axis, onChange }: { axis: VariantAxis; onChange: (axis: VariantAxis) => void }) {
  const t = useTranslations("Listing.catalogue");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>();
  const full = axis.values.length >= VARIANT_VALUES_MAX;

  function add() {
    const value = cleanValue(draft);
    if (!value) return;
    if (hasValue(axis.values, value)) {
      setError(t("duplicateValue"));
      return;
    }
    setError(undefined);
    setDraft("");
    onChange({ ...axis, values: [...axis.values, value] });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    add();
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label={t("axisLabel")} error={axis.label?.trim() ? undefined : t("labelRequired")} className="max-w-72">
        <Input value={axis.label ?? ""} maxLength={VARIANT_LABEL_MAX} placeholder={t("axisLabelPlaceholder")} onChange={(event) => onChange({ ...axis, label: event.target.value })} />
      </Field>
      {axis.values.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={t("values")}>
          {axis.values.map((value) => (
            <li key={value} className="inline-flex min-h-11 items-center gap-1 rounded-md border border-structure bg-structure ps-3.5 text-structure-foreground">
              <span>{value}</span>
              <button type="button" className="inline-flex size-11 items-center justify-center rounded-md hover:bg-bab-600" aria-label={t("removeValue", { value })} onClick={() => onChange({ ...axis, values: axis.values.filter((existing) => existing !== value) })}>
                <X className="size-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {full ? null : (
        <div className="flex items-start gap-2">
          <Field label={t("newValue")} error={error} className="max-w-56 flex-1">
            <Input value={draft} placeholder={t("valuePlaceholder")} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
          </Field>
          <Button type="button" variant="outline" className="mt-6.5" onClick={add} disabled={!cleanValue(draft)}>
            {t("addValue")}
          </Button>
        </div>
      )}
    </div>
  );
}

interface CombinationRowProps {
  name: string;
  item: VariantItem | undefined;
  offered: boolean;
  price: number | null;
  locale: Locale;
  onOffered: (offered: boolean) => void;
  onItem: (item: VariantItem) => void;
}

function CombinationRow({ name, item, offered, price, locale, onOffered, onItem }: CombinationRowProps) {
  const t = useTranslations("Listing.catalogue");
  const id = useId();
  const set = (patch: Partial<VariantItem>) => {
    if (!item) return;
    const next: VariantItem = { ...item, ...patch };
    for (const key of ["stock", "price", "ref"] as const) if (next[key] === undefined) delete next[key];
    onItem(next);
  };
  return (
    <li className={cn("flex flex-col gap-3 p-3 sm:grid sm:grid-cols-[minmax(0,1fr)_6rem_8rem_8rem] sm:items-center sm:gap-3", !offered && "bg-surface-muted")}>
      <label htmlFor={`${id}-offered`} className="flex min-h-11 cursor-pointer items-center gap-3">
        <input id={`${id}-offered`} type="checkbox" checked={offered} onChange={(event) => onOffered(event.target.checked)} className="size-5 accent-[var(--color-structure)]" />
        <span className={cn("font-medium", !offered && "text-foreground-muted line-through")}>{name}</span>
      </label>
      {offered && item ? (
        <div className="grid grid-cols-3 gap-2 sm:contents">
          <label className="flex flex-col gap-1 text-xs text-foreground-muted sm:text-sm">
            <span className="sm:sr-only">{t("stock")}</span>
            <Input
              type="text"
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              className="tabular-nums"
              aria-label={`${t("stock")} ${name}`}
              placeholder={t("untracked")}
              value={item.stock === undefined ? "" : String(item.stock)}
              onChange={(event) => set({ stock: parseCount(event.target.value, STOCK_MAX) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-muted sm:text-sm">
            <span className="sm:sr-only">{t("price", { currency: currencyLabel(locale) })}</span>
            <Input
              type="text"
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              className="tabular-nums"
              aria-label={`${t("price", { currency: currencyLabel(locale) })} ${name}`}
              placeholder={price === null ? "" : groupDigits(String(price))}
              value={item.price === undefined ? "" : groupDigits(String(item.price))}
              onChange={(event) => {
                const next = parseCount(event.target.value, PRICE_MAX);
                set({ price: next === 0 ? undefined : next });
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground-muted sm:text-sm">
            <span className="sm:sr-only">{t("ref")}</span>
            <Input aria-label={`${t("ref")} ${name}`} maxLength={80} autoComplete="off" value={item.ref ?? ""} onChange={(event) => set({ ref: event.target.value.trim() ? event.target.value : undefined })} />
          </label>
        </div>
      ) : null}
    </li>
  );
}
