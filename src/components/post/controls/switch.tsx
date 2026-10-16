"use client";

import { forwardRef, useId, type ReactNode } from "react";
import { Switch as RadixSwitch } from "radix-ui";
import { cn } from "@/lib/utils";

interface SwitchFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  className?: string;
}

/**
 * Labelled on/off control (44 px row). The whole row is the label, so the accessible name of
 * the switch is the label text and the touch target is generous: the label's hit area covers the
 * row and is at least 44 px tall even when a caller removes the row padding.
 */
export const SwitchField = forwardRef<HTMLButtonElement, SwitchFieldProps>(function SwitchField({ label, hint, checked, onCheckedChange, disabled, name, className }, ref) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={cn("relative flex items-start justify-between gap-4 py-2", disabled && "opacity-60", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <label
          htmlFor={id}
          className={cn(
            "text-base font-medium leading-6",
            "after:absolute after:inset-x-0 after:top-1/2 after:h-full after:min-h-11 after:-translate-y-1/2 after:content-['']",
            !disabled && "cursor-pointer",
          )}
        >
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="text-sm text-foreground-muted text-pretty">
            {hint}
          </p>
        ) : null}
      </div>
      <RadixSwitch.Root
        ref={ref}
        id={id}
        name={name}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        className={cn(
          "relative mt-0.5 inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-border-strong",
          "transition-colors duration-150 ease-door data-[state=checked]:bg-structure disabled:cursor-not-allowed",
          "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
          // 44 px touch target without growing the visual control.
          "before:absolute before:-inset-y-2.5 before:-inset-x-1 before:content-['']",
        )}
      >
        <RadixSwitch.Thumb className="block size-5 translate-x-1 rounded-full bg-surface shadow-sm transition-transform duration-150 ease-door data-[state=checked]:translate-x-6 rtl:-translate-x-1 rtl:data-[state=checked]:-translate-x-6" />
      </RadixSwitch.Root>
    </div>
  );
});
