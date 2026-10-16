"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChipOption {
  value: string;
  label: string;
}

interface ChipGroupProps {
  options: readonly ChipOption[];
  /** Accessible name of the group (the field label). */
  label: string;
  labelledBy?: string;
  describedBy?: string;
  invalid?: boolean;
  className?: string;
}

interface SingleProps extends ChipGroupProps {
  value: string | null | undefined;
  onChange: (value: string) => void;
  /** Clicking the chosen chip clears it. */
  clearable?: boolean;
}

const chip = cn(
  "inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-3.5 py-2 text-base",
  "transition-[background-color,border-color,color] duration-150 ease-door hover:bg-surface-muted",
  "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
  "aria-checked:border-structure aria-checked:bg-structure aria-checked:text-structure-foreground",
  "aria-checked:hover:bg-bab-600",
);

/** One value among a few (radio semantics): chips read faster than a select on a phone. */
export function ChipRadioGroup({ options, value, onChange, label, labelledBy, describedBy, invalid, clearable, className }: SingleProps) {
  return (
    <div role="radiogroup" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-invalid={invalid || undefined} className={cn("flex flex-wrap gap-2", className)}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => (checked && clearable ? onChange("") : onChange(option.value))}
            className={chip}
          >
            {checked ? <Check className="size-4" aria-hidden="true" /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface MultiProps extends ChipGroupProps {
  values: readonly string[];
  onChange: (values: string[]) => void;
}

/** Several values (checkbox semantics). */
export function ChipCheckboxGroup({ options, values, onChange, label, labelledBy, describedBy, invalid, className }: MultiProps) {
  return (
    <div role="group" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-invalid={invalid || undefined} className={cn("flex flex-wrap gap-2", className)}>
      {options.map((option) => {
        const checked = values.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            role="checkbox"
            aria-checked={checked}
            onClick={() => onChange(checked ? values.filter((v) => v !== option.value) : [...values, option.value])}
            className={chip}
          >
            {checked ? <Check className="size-4" aria-hidden="true" /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
