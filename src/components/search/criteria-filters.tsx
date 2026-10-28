"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { ChipCheckboxGroup } from "@/components/post/controls/chips";
import { SwitchField } from "@/components/post/controls/switch";
import { NumberInput } from "@/components/post/criteria-fields";
import { useCriteriaLabels } from "@/components/post/labels";
import type { Criterion } from "@/config/categories";
import type { CriterionFilter } from "@/lib/search/params";
import { filterableCriteria, setCriterion } from "./filter-model";

// Criteria of the chosen subcategory (or the category's shared filters) as filters (design §2, params.ts `f-*`): select and
// multiselect -> several values (chips for short lists, a scrolling checklist for long ones such
// as car brands), number -> min/max, boolean -> "yes only". Text criteria are left to the words.

/** Above this many options, a checklist reads better than wrapping chips. */
const CHIP_OPTIONS_MAX = 10;

interface CriteriaFiltersProps {
  categoryId: string | undefined;
  subcategoryId: string | undefined;
  value: Record<string, CriterionFilter> | undefined;
  onChange: (value: Record<string, CriterionFilter> | undefined) => void;
}

function OptionChecklist({ criterionId, options, values, label, onChange }: { criterionId: string; options: { value: string; label: string }[]; values: string[]; label: string; onChange: (values: string[]) => void }) {
  return (
    <div role="group" aria-label={label} className="flex max-h-60 flex-col overflow-y-auto rounded-md border border-border">
      {options.map((option) => {
        const checked = values.includes(option.value);
        return (
          <label key={option.value} className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-border px-3 transition-colors duration-150 ease-door last:border-b-0 hover:bg-surface-muted">
            <input
              type="checkbox"
              name={`${criterionId}-${option.value}`}
              checked={checked}
              onChange={() => onChange(checked ? values.filter((v) => v !== option.value) : [...values, option.value])}
              className="size-5 shrink-0 accent-structure"
            />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}

function RangeFilter({ criterion, label, unit, value, onChange }: { criterion: Criterion; label: string; unit?: string; value: CriterionFilter | undefined; onChange: (filter: CriterionFilter | undefined) => void }) {
  const t = useTranslations("SearchFilters");
  const id = useId();
  const range = value?.kind === "range" ? value : { kind: "range" as const };
  const set = (bound: "min" | "max", next: number | undefined) => onChange({ ...range, [bound]: next });
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-min`} className="text-xs text-foreground-muted">
            {t("min")}
          </label>
          <NumberInput id={`${id}-min`} value={range.min} min={criterion.min} max={criterion.max} unit={unit} onChange={(next) => set("min", next)} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-max`} className="text-xs text-foreground-muted">
            {t("max")}
          </label>
          <NumberInput id={`${id}-max`} value={range.max} min={criterion.min} max={criterion.max} unit={unit} onChange={(next) => set("max", next)} />
        </div>
      </div>
    </fieldset>
  );
}

export function CriteriaFilters({ categoryId, subcategoryId, value, onChange }: CriteriaFiltersProps) {
  const id = useId();
  const labels = useCriteriaLabels();
  const units = useTranslations("Listing.units");
  const criteria = filterableCriteria(categoryId, subcategoryId);
  if (criteria.length === 0) return null;

  return (
    <div className="flex flex-col gap-6">
      {criteria.map((criterion) => {
        const label = labels.label(criterion.id);
        const current = value?.[criterion.id];
        const update = (filter: CriterionFilter | undefined) => onChange(setCriterion(value, criterion.id, filter));
        if (criterion.type === "number") {
          const unit = criterion.unit && criterion.unit !== "an" ? units(criterion.unit) : undefined;
          return <RangeFilter key={criterion.id} criterion={criterion} label={label} unit={unit} value={current} onChange={update} />;
        }
        if (criterion.type === "boolean") {
          return <SwitchField key={criterion.id} label={label} checked={current?.kind === "flag"} onCheckedChange={(checked) => update(checked ? { kind: "flag" } : undefined)} className="py-0" />;
        }
        const options = (criterion.options ?? []).map((option) => ({ value: option, label: labels.option(criterion.id, option) }));
        const values = current?.kind === "options" ? current.values : [];
        const setValues = (next: string[]) => update({ kind: "options", values: next });
        return (
          <div key={criterion.id} className="flex flex-col gap-2">
            <p className="text-sm font-medium" id={`${id}-${criterion.id}`}>
              {label}
            </p>
            {options.length > CHIP_OPTIONS_MAX ? (
              <OptionChecklist criterionId={criterion.id} options={options} values={values} label={label} onChange={setValues} />
            ) : (
              <ChipCheckboxGroup options={options} values={values} onChange={setValues} label={label} labelledBy={`${id}-${criterion.id}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
