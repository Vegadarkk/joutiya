"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, CircleDot, CloudOff } from "lucide-react";
import { KhatamLoader } from "@/components/ui/khatam-loader";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/auth/client";
import type { WizardStep } from "@/lib/contracts/listings";
import type { AutosaveState } from "@/lib/listings/client/autosave";
import type { SaveMode } from "@/lib/listings/client/store";
import type { StepState } from "@/lib/listings/client/validation";
import { cn } from "@/lib/utils";
import { useSaveErrorMessage } from "./field-messages";
import { StepProgress } from "./progress";

export const STEP_FORM_ID = "wizard-step-form";

interface WizardShellProps {
  step: WizardStep;
  title: string;
  lead?: string;
  /** The draft's steps, in order (the price step is absent from a job-seeker ad). */
  steps?: readonly WizardStep[];
  /** Step names that differ for this draft (the price step of a job offer reads "Salaire"). */
  stepLabels?: Partial<Record<WizardStep, string>>;
  states: Record<WizardStep, StepState>;
  reachable: (step: WizardStep) => boolean;
  onSelect: (step: WizardStep) => void;
  onBack?: () => void;
  /** Label of the primary action (default "Continuer"); undefined hides it (the review step has its own). */
  nextLabel?: string | null;
  nextDisabled?: boolean;
  nextLoading?: boolean;
  saveState: AutosaveState;
  saveError?: unknown;
  saveMode?: SaveMode;
  onRetrySave: () => void;
  /** Live listing: saves the pending changes from any step. */
  onSaveNow?: () => void;
  /** A typed field is not sendable yet (under its minimum length). */
  held?: boolean;
  children: ReactNode;
}

/**
 * Frame of every step: progress, heading, the step's form, and the action bar (sticky at the
 * bottom on a phone). The Next button submits the step's form (`form` attribute), so each step
 * validates itself before the wizard moves on.
 */
export function WizardShell({ step, title, lead, steps, stepLabels, states, reachable, onSelect, onBack, nextLabel, nextDisabled, nextLoading, saveState, saveError, saveMode = "auto", onRetrySave, onSaveNow, held = false, children }: WizardShellProps) {
  const t = useTranslations("Listing.wizard");
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  // Each step change moves focus to the new heading (screen readers hear where they are).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [step]);

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start lg:gap-12">
      <div className="lg:sticky lg:top-24">
        <StepProgress current={step} steps={steps} labels={stepLabels} states={states} onSelect={onSelect} reachable={reachable} />
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 ref={heading} tabIndex={-1} className="rounded-sm text-2xl font-semibold text-balance outline-none focus-visible:ring-3 focus-visible:ring-ring/25 sm:text-3xl">
            {title}
          </h1>
          {lead ? <p className="text-foreground-muted text-pretty">{lead}</p> : null}
        </header>

        <div className="flex flex-col gap-6">{children}</div>

        <div
          className={cn(
            "sticky bottom-0 z-30 -mx-4 mt-2 flex flex-col gap-2 border-t border-border bg-surface/95 px-4 pt-3 backdrop-blur supports-[backdrop-filter]:bg-surface/85",
            "pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pb-0 sm:backdrop-blur-none",
          )}
        >
          <SaveIndicator state={saveState} error={saveError} mode={saveMode} held={held} onRetry={onRetrySave} onSave={onSaveNow} />
          <div className="flex items-center justify-between gap-3">
            {onBack ? (
              <Button type="button" variant="outline" onClick={onBack} className="min-w-28">
                <ArrowLeft className="rtl:-scale-x-100" aria-hidden="true" />
                {t("back")}
              </Button>
            ) : (
              <span />
            )}
            {nextLabel !== null ? (
              <Button type="submit" form={STEP_FORM_ID} disabled={nextDisabled} loading={nextLoading} className="min-w-36 flex-1 sm:flex-none">
                {nextLabel ?? t("next")}
                <ArrowRight className="rtl:-scale-x-100" aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Failures the autosave retries by itself (saveRetryDelay in store.tsx): the message says so. A
 * spent daily quota (503 quota_exhausted) is not retried: its message says when to come back.
 */
function isTransient(error: unknown): boolean {
  if (!isApiError(error)) return true;
  if (error.code === "quota_exhausted") return false;
  return error.status >= 500 || ["network", "unavailable", "internal", "rate_limited"].includes(error.code);
}

interface SaveIndicatorProps {
  state: AutosaveState;
  error?: unknown;
  mode?: SaveMode;
  onRetry: () => void;
  onSave?: () => void;
  held?: boolean;
}

/**
 * One line, polite live region. A draft: "Brouillon enregistré" (saved by itself). A live
 * listing: "Modifications non enregistrées" with its Save button. A failure says whether the
 * browser keeps retrying, and offers a retry.
 */
export function SaveIndicator({ state, error, mode = "auto", onRetry, onSave, held = false }: SaveIndicatorProps) {
  const t = useTranslations("Listing.wizard");
  const apiMessage = useSaveErrorMessage();
  const live = mode === "manual";
  // A field under its minimum length is not sent: say so rather than "saved".
  if (held && (state === "idle" || state === "saved")) {
    return (
      <p role="status" aria-live="polite" className="flex min-h-5 items-center gap-1.5 text-sm text-foreground-muted">
        <CircleDot className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{t("held")}</span>
      </p>
    );
  }
  if (state === "idle") return <p className="h-5" aria-hidden="true" />;
  const message =
    state === "saving"
      ? t("saving")
      : state === "saved"
        ? live
          ? t("savedLive")
          : t("saved")
        : state === "pending"
          ? live
            ? t("unsaved")
            : t("pending")
          : isApiError(error, "invalid_listing")
            ? t("saveBlocked")
            : isTransient(error)
              ? t("saveError")
              : `${t("saveStopped")} ${apiMessage(error)}`;
  return (
    <p role="status" aria-live="polite" className={cn("flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm", state === "error" ? "text-danger" : state === "pending" && live ? "text-warning" : "text-foreground-muted")}>
      {state === "saving" ? (
        <KhatamLoader size="sm" className="size-4" />
      ) : state === "saved" ? (
        <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
      ) : state === "error" ? (
        <CloudOff className="size-4 shrink-0" aria-hidden="true" />
      ) : live ? (
        <CircleDot className="size-4 shrink-0" aria-hidden="true" />
      ) : null}
      <span className="min-w-0">{message}</span>
      {state === "error" && !isApiError(error, "invalid_listing") ? (
        <button type="button" onClick={onRetry} className="-my-2 inline-flex min-h-11 items-center rounded-sm px-1 font-medium underline underline-offset-2">
          {t("retrySave")}
        </button>
      ) : null}
      {state === "pending" && live && onSave ? (
        <button type="button" onClick={onSave} className="-my-2 inline-flex min-h-11 items-center rounded-sm px-1 font-medium text-link underline underline-offset-2">
          {t("saveNow")}
        </button>
      ) : null}
    </p>
  );
}
