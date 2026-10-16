"use client";

import { useId, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { CONDITIONS, CRITERION_TEXT_MAX, type Condition, type Criterion, type Subcategory } from "@/config/categories";
import type { ListingAttributes } from "@/lib/contracts/listings";
import { cn } from "@/lib/utils";
import { ChipCheckboxGroup, ChipRadioGroup } from "./controls/chips";
import { Select } from "./controls/select";
import { SwitchField } from "./controls/switch";
import { useCriteriaLabels } from "./labels";

// Step 2: the criteria of the chosen subcategory, generated from src/config/categories.ts.
// select -> chips (few options) or native select; multiselect -> chips; number -> numeric input
// with its unit; boolean -> switch; text -> input. `condition` (core field) comes first when the
// subcategory defines it. Labels: Criteria.<field>.label / .options.<opt>; units: Listing.units.

export type AttributeValue = ListingAttributes[string];

interface CriteriaFieldsProps {
  subcategory: Subcategory;
  attributes: ListingAttributes;
  condition: Condition | null;
  /** Messages by path ("attributes.year", "condition"). */
  errors?: Record<string, string | undefined>;
  onAttribute: (id: string, value: AttributeValue | undefined) => void;
  onCondition: (value: Condition | null) => void;
  onBlur?: () => void;
}

/** Chips read faster than a select up to this many options; brands and sizes get the native picker. */
const CHIP_MAX_OPTIONS = 8;

export function CriteriaFields({ subcategory, attributes, condition, errors = {}, onAttribute, onCondition, onBlur }: CriteriaFieldsProps) {
  const labels = useCriteriaLabels();
  const w = useTranslations("Listing.wizard");
  const f = useTranslations("Listing.fields");
  const units = useTranslations("Listing.units");
  const label = labels.label;
  const optionLabel = labels.option;

  return (
    <div className="flex flex-col gap-5" onBlur={onBlur}>
      {subcategory.condition ? (
        <GroupField label={f("condition")} required={subcategory.condition === "required"} optionalLabel={w("optional")} error={errors["condition"]}>
          {(ids) => (
            <ChipRadioGroup
              options={CONDITIONS.map((value) => ({ value, label: optionLabel("condition", value) }))}
              value={condition}
              onChange={(value) => onCondition(value ? (value as Condition) : null)}
              label={f("condition")}
              labelledBy={ids.labelId}
              describedBy={ids.describedBy}
              invalid={Boolean(errors["condition"])}
              clearable={subcategory.condition !== "required"}
            />
          )}
        </GroupField>
      ) : null}
      {subcategory.criteria.map((criterion) => (
        <CriterionField
          key={criterion.id}
          criterion={criterion}
          value={attributes[criterion.id]}
          error={errors[`attributes.${criterion.id}`]}
          label={label(criterion.id)}
          optionLabel={(option) => optionLabel(criterion.id, option)}
          unit={criterion.unit && criterion.unit !== "an" ? units(criterion.unit) : undefined}
          optionalLabel={w("optional")}
          onChange={(value) => onAttribute(criterion.id, value)}
        />
      ))}
    </div>
  );
}

interface CriterionFieldProps {
  criterion: Criterion;
  value: AttributeValue | undefined;
  error?: string;
  label: string;
  optionLabel: (option: string) => string;
  unit?: string;
  optionalLabel: string;
  onChange: (value: AttributeValue | undefined) => void;
}

function CriterionField({ criterion, value, error, label, optionLabel, unit, optionalLabel, onChange }: CriterionFieldProps) {
  const required = Boolean(criterion.required);
  switch (criterion.type) {
    case "select": {
      const options = criterion.options ?? [];
      if (options.length <= CHIP_MAX_OPTIONS) {
        return (
          <GroupField label={label} required={required} optionalLabel={optionalLabel} error={error}>
            {(ids) => (
              <ChipRadioGroup
                options={options.map((option) => ({ value: option, label: optionLabel(option) }))}
                value={typeof value === "string" ? value : null}
                onChange={(next) => onChange(next || undefined)}
                label={label}
                labelledBy={ids.labelId}
                describedBy={ids.describedBy}
                invalid={Boolean(error)}
                clearable={!required}
              />
            )}
          </GroupField>
        );
      }
      return (
        <Field label={label} hint={required ? undefined : optionalLabel} error={error} required={required}>
          <Select value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)}>
            <option value="">{"—"}</option>
            {options.map((option) => (
              <option key={option} value={option}>
                {optionLabel(option)}
              </option>
            ))}
          </Select>
        </Field>
      );
    }
    case "multiselect": {
      const options = criterion.options ?? [];
      const values = Array.isArray(value) ? value : [];
      return (
        <GroupField label={label} required={required} optionalLabel={optionalLabel} error={error}>
          {(ids) => (
            <ChipCheckboxGroup
              options={options.map((option) => ({ value: option, label: optionLabel(option) }))}
              values={values}
              onChange={(next) => onChange(next.length ? next : undefined)}
              label={label}
              labelledBy={ids.labelId}
              describedBy={ids.describedBy}
              invalid={Boolean(error)}
            />
          )}
        </GroupField>
      );
    }
    case "number":
      return (
        <Field label={label} hint={required ? undefined : optionalLabel} error={error} required={required}>
          <NumberInput value={typeof value === "number" ? value : undefined} min={criterion.min} max={criterion.max} unit={unit} onChange={onChange} />
        </Field>
      );
    case "boolean":
      return <SwitchField label={label} checked={value === true} onCheckedChange={(checked) => onChange(checked)} className="border-b border-border pb-3" />;
    case "text":
      return (
        <Field label={label} hint={required ? undefined : optionalLabel} error={error} required={required}>
          <Input type="text" value={typeof value === "string" ? value : ""} maxLength={CRITERION_TEXT_MAX} autoComplete="off" onChange={(event) => onChange(event.target.value || undefined)} />
        </Field>
      );
  }
}

interface NumberInputProps {
  value: number | undefined;
  min?: number;
  max?: number;
  unit?: string;
  onChange: (value: number | undefined) => void;
  id?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  "aria-required"?: boolean;
}

/** Integer input (numeric keypad) with the unit as a suffix; negatives only when the minimum allows them. */
export function NumberInput({ value, min, max, unit, onChange, ...aria }: NumberInputProps) {
  const allowNegative = min !== undefined && min < 0;
  // The whole field is LTR (digits, then the unit at the end): with an RTL wrapper the unit's end-3
  // would sit on the left, over the digits of the LTR input.
  return (
    <div className="relative" dir="ltr">
      <Input
        type="text"
        inputMode={allowNegative ? "text" : "numeric"}
        autoComplete="off"
        value={value === undefined ? "" : String(value)}
        min={min}
        max={max}
        dir="ltr"
        className={cn("text-start tabular-nums", unit && "pe-14")}
        onChange={(event) => {
          const raw = event.target.value.replace(allowNegative ? /[^\d-]/g : /\D/g, "");
          if (raw === "" || raw === "-") {
            onChange(undefined);
            return;
          }
          const parsed = Number(raw);
          onChange(Number.isFinite(parsed) ? parsed : undefined);
        }}
        {...aria}
      />
      {unit ? (
        <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-sm text-foreground-muted" aria-hidden="true">
          {unit}
        </span>
      ) : null}
    </div>
  );
}

interface GroupFieldProps {
  label: ReactNode;
  required?: boolean;
  optionalLabel: string;
  error?: string;
  children: (ids: { labelId: string; describedBy: string | undefined }) => ReactNode;
}

/** Label + chip group + message, with the ids a `radiogroup` / `group` needs (a <label for> cannot name them). */
function GroupField({ label, required, optionalLabel, error, children }: GroupFieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-sm font-medium text-foreground">
        {label}
        {required ? (
          <span className="ms-0.5 text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>
      {children({ labelId, describedBy: error ? errorId : required ? undefined : hintId })}
      {error ? (
        <InlineError id={errorId}>{error}</InlineError>
      ) : !required ? (
        <p id={hintId} className="text-sm text-foreground-muted">
          {optionalLabel}
        </p>
      ) : null}
    </div>
  );
}
