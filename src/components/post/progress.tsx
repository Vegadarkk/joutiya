"use client";

import { useId, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
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
 * gold, the rest to come. On a phone the strip and "Step 6 of 9" form one 44 px button that unfolds
 * the named list (nine 44 px targets do not fit side by side at 360 px); wide screens always show
 * the list.
 */
export function StepProgress({ current, states, onSelect, reachable }: StepProgressProps) {
  const t = useTranslations("Listing.wizard");
  const label = useStepLabel();
  const listId = useId();
  const currentIndex = WIZARD_STEPS.indexOf(current);
  // Open for the step it was unfolded on: reaching another step folds it again.
  const [openOn, setOpenOn] = useState<WizardStep | null>(null);
  const open = openOn === current;
  const status = (step: WizardStep) => (step === current ? t("stepCurrent") : states[step] === "complete" ? t("stepDone") : states[step] === "incomplete" ? t("stepIncomplete") : t("stepTodo"));

  return (
    <nav aria-label={t("stepsNav")} className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpenOn(open ? null : current)}
        className="group -mx-2 flex min-h-11 flex-col justify-center gap-3 rounded-md px-2 py-1.5 text-start lg:hidden"
      >
        <span className="flex w-full items-center justify-between gap-3 text-sm font-medium text-foreground-muted">
          {t("stepOf", { current: currentIndex + 1, total: WIZARD_STEPS.length })}
          <ChevronDown className={cn("size-4 shrink-0 transition-transform duration-150 ease-door group-hover:text-foreground", open && "rotate-180")} aria-hidden="true" />
        </span>
        <span className="flex w-full gap-1" aria-hidden="true">
          {WIZARD_STEPS.map((step, index) => {
            const isCurrent = step === current;
            const state = states[step];
            return (
              <span
                key={step}
                className={cn(
                  "block h-1.5 min-w-0 flex-1 rounded-full transition-[background-color,scale] duration-150 ease-door",
                  isCurrent && "scale-y-[1.35]",
                  isCurrent ? "bg-featured" : state === "complete" ? "bg-structure" : state === "incomplete" && index < currentIndex ? "bg-danger/70" : "bg-border",
                )}
              />
            );
          })}
        </span>
      </button>

      <ol id={listId} className={cn("flex-col gap-1 lg:flex", open ? "flex" : "hidden")}>
        {WIZARD_STEPS.map((step, index) => {
          const isCurrent = step === current;
          const state = states[step];
          const can = reachable(step) && !isCurrent;
          return (
            <li key={step}>
              <button
                type="button"
                disabled={!can}
                onClick={() => {
                  setOpenOn(null);
                  onSelect(step);
                }}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-start text-sm transition-colors duration-150 ease-door",
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
                <span className="sr-only">{status(step)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
