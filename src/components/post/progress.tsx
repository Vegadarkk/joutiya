"use client";

import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { WIZARD_STEPS, type WizardStep } from "@/lib/contracts/listings";
import type { StepState } from "@/lib/listings/client/validation";
import { cn } from "@/lib/utils";
import { useStepLabel } from "./field-messages";

interface StepProgressProps {
  current: WizardStep;
  states: Record<WizardStep, StepState>;
  /** Jump to a step (only steps already reached are links). */
  onSelect: (step: WizardStep) => void;
  /** Steps the person may jump to. */
  reachable: (step: WizardStep) => boolean;
}

/**
 * The threshold: nine segments, the ones behind you in structure green, the one you stand on in
 * gold, the rest to come. Compact strip on a phone; the full list of names on wide screens.
 */
export function StepProgress({ current, states, onSelect, reachable }: StepProgressProps) {
  const t = useTranslations("Listing.wizard");
  const label = useStepLabel();
  const currentIndex = WIZARD_STEPS.indexOf(current);

  return (
    <nav aria-label={t("stepsNav")} className="flex flex-col gap-3">
      <p className="text-sm font-medium text-foreground-muted lg:hidden">{t("stepOf", { current: currentIndex + 1, total: WIZARD_STEPS.length })}</p>
      <ol className="-my-3 flex gap-1 lg:hidden" aria-label={t("progress")}>
        {WIZARD_STEPS.map((step, index) => {
          const isCurrent = step === current;
          const state = states[step];
          const can = reachable(step) && !isCurrent;
          return (
            <li key={step} className="min-w-0 flex-1">
              <button
                type="button"
                disabled={!can}
                onClick={() => onSelect(step)}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={`${index + 1}. ${label(step)}, ${isCurrent ? t("stepCurrent") : state === "complete" ? t("stepDone") : state === "incomplete" ? t("stepIncomplete") : t("stepTodo")}`}
                // 44 px touch target around a 6 px segment.
                className="group flex h-11 w-full items-center rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-default"
              >
                <span
                  className={cn(
                    "block h-1.5 w-full rounded-full transition-[background-color,transform] duration-150 ease-door",
                    isCurrent && "scale-y-[1.35]",
                    isCurrent ? "bg-featured" : state === "complete" ? "bg-structure" : state === "incomplete" && index < currentIndex ? "bg-danger/70" : "bg-border",
                    can && "group-hover:bg-bab-500",
                  )}
                />
              </button>
            </li>
          );
        })}
      </ol>

      <ol className="hidden lg:flex lg:flex-col lg:gap-1">
        {WIZARD_STEPS.map((step, index) => {
          const isCurrent = step === current;
          const state = states[step];
          const can = reachable(step) && !isCurrent;
          return (
            <li key={step}>
              <button
                type="button"
                disabled={!can}
                onClick={() => onSelect(step)}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-start text-sm transition-colors duration-150 ease-door",
                  "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
                  isCurrent ? "bg-surface-brand font-semibold text-foreground" : can ? "text-foreground hover:bg-surface-muted" : "text-foreground-muted",
                  !can && !isCurrent && "cursor-default",
                )}
              >
                <span
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
                    isCurrent ? "bg-featured text-featured-foreground" : state === "complete" ? "bg-structure text-structure-foreground" : "border border-border-strong text-foreground-muted",
                  )}
                  aria-hidden="true"
                >
                  {state === "complete" && !isCurrent ? <Check className="size-4" /> : index + 1}
                </span>
                <span className="truncate">{label(step)}</span>
                {state === "incomplete" && !isCurrent && index < currentIndex ? <span className="ms-auto size-2 shrink-0 rounded-full bg-danger" aria-hidden="true" /> : null}
                <span className="sr-only">{isCurrent ? t("stepCurrent") : state === "complete" ? t("stepDone") : state === "incomplete" ? t("stepIncomplete") : t("stepTodo")}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
