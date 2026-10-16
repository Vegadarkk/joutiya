"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import type { FieldError } from "react-hook-form";
import { useApiErrorMessage } from "@/components/auth/form-message";
import { isApiError } from "@/lib/auth/client";
import { WIZARD_STEPS, type FieldIssue, type WizardStep } from "@/lib/contracts/listings";
import { DESCRIPTION_MAX, DESCRIPTION_MIN, DISTRICT_MAX, PRICE_MAX, TITLE_MAX, TITLE_MIN } from "@/lib/listings/client/validation";
import { groupDigits } from "@/lib/listings/client/format";

// Words of the wizard's validation: codes come from validation.ts (client) or from the server's
// 422 blockers; the messages live in Listing.validation.

type Params = Record<string, string | number>;

/**
 * Why a save of the listing failed. A 409 `listing_limit` on a save only comes from an edit of a
 * paused or expired listing that the pre-moderation holds: in review it takes an active slot, so
 * the generic "to publish a new one" sentence would not fit; this one says why and what to do.
 * A degraded Firestore day (quota_exhausted) takes the deposit wording of Listing.errors.
 */
export function useSaveErrorMessage(): (error: unknown) => string {
  const t = useTranslations("Listing.wizard");
  const apiMessage = useApiErrorMessage("listing");
  return useCallback((error) => (isApiError(error, "listing_limit") ? t("saveLimit") : apiMessage(error)), [t, apiMessage]);
}

/** Message of a stable validation code; unknown server codes fall back to a generic sentence. */
export function useValidationMessage(): (code: string, params?: Params) => string {
  const t = useTranslations("Listing.validation");
  return useCallback(
    (code, params = {}) => {
      const defaults: Params = { min: TITLE_MIN, max: TITLE_MAX };
      if (code.startsWith("description")) Object.assign(defaults, { min: DESCRIPTION_MIN, max: DESCRIPTION_MAX });
      if (code === "price_max") defaults.max = groupDigits(String(PRICE_MAX));
      if (code === "district_max") defaults.max = DISTRICT_MAX;
      const key = code as Parameters<typeof t.has>[0];
      return t.has(key) ? t(key, { ...defaults, ...params }) : t("unknown");
    },
    [t],
  );
}

/** The message of a react-hook-form error: a server message as is, else the mapped code. */
export function useFieldErrorMessage(): (code: string, error?: FieldError, params?: Params) => string | undefined {
  const message = useValidationMessage();
  return useCallback(
    (code, error, params) => {
      if (!error) return undefined;
      if (error.type === "server" && error.message) return error.message;
      // Custom refinements put the stable code in the message; built-in issues use the caller's code.
      const custom = error.type === "custom" && error.message ? error.message : undefined;
      return message(custom ?? code, params);
    },
    [message],
  );
}

/** Step names, for the progress rail, the headings and the blocker jump links. */
export function useStepLabel(): (step: WizardStep) => string {
  const t = useTranslations("Listing.steps");
  return useCallback((step) => t(step), [t]);
}

/** Groups blockers by step, in wizard order (the review step's checklist). */
export function groupIssuesByStep<T extends FieldIssue & { step: WizardStep }>(issues: readonly T[]): { step: WizardStep; issues: T[] }[] {
  return WIZARD_STEPS.map((step) => ({ step, issues: issues.filter((issue) => issue.step === step) })).filter((group) => group.issues.length > 0);
}
