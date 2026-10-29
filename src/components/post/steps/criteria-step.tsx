"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { criterionApplies, criterionById, subcategoryById, type Condition } from "@/config/categories";
import type { FieldIssue } from "@/lib/contracts/listings";
import { useWizard } from "@/lib/listings/client/store";
import { criterionBounds, stepIssues } from "@/lib/listings/client/validation";
import { variantCriteria } from "@/lib/contracts/catalog";
import { CriteriaFields, type AttributeValue } from "../criteria-fields";
import { useCriteriaLabels } from "../labels";
import { useValidationMessage } from "../field-messages";
import { STEP_FORM_ID } from "../wizard-shell";

export function CriteriaStep({ onNext }: { onNext: () => void }) {
  const { listing, update, flush, blockers } = useWizard();
  const t = useTranslations("Listing");
  const message = useValidationMessage();
  const labels = useCriteriaLabels();
  const [attempted, setAttempted] = useState(false);
  const subcategory = listing.subcategoryId ? subcategoryById(listing.subcategoryId) : undefined;

  const issues = useMemo(() => stepIssues("criteres", listing), [listing]);
  const errors = useMemo(() => {
    const shown: FieldIssue[] = attempted ? issues : [];
    const out: Record<string, string> = {};
    for (const issue of [...shown, ...blockers.filter((b) => b.path.startsWith("attributes") || b.path === "condition")]) {
      const criterionId = issue.path.startsWith("attributes.") ? issue.path.slice("attributes.".length) : undefined;
      const criterion = criterionId ? criterionById(criterionId) : undefined;
      out[issue.path] = issue.message && !message(issue.code) ? issue.message : message(issue.code, criterion ? { ...criterionBounds({ ...criterion }), max: criterion.type === "text" ? 80 : (criterion.max ?? "") } : undefined);
    }
    return out;
  }, [attempted, issues, blockers, message]);

  if (!subcategory) {
    return (
      <form id={STEP_FORM_ID} onSubmit={(event) => event.preventDefault()}>
        <ErrorBanner tone="warning" title={t("validation.subcategory_required")} />
      </form>
    );
  }

  // A criterion a variant axis takes over (the size of clothes) is set at the price step.
  const taken = new Set<string>(variantCriteria(listing.variants));
  const covered = subcategory.criteria.filter((criterion) => taken.has(criterion.id));
  const shown = covered.length > 0 ? { ...subcategory, criteria: subcategory.criteria.filter((criterion) => !taken.has(criterion.id)) } : subcategory;

  function onAttribute(id: string, value: AttributeValue | undefined) {
    const attributes = { ...listing.attributes };
    if (value === undefined) delete attributes[id];
    else attributes[id] = value;
    // A dependent criterion (a warranty's duration) goes with the value that opened it.
    for (const criterion of subcategory?.criteria ?? []) {
      if (criterion.showIf?.id === id && !criterionApplies(criterion, attributes)) delete attributes[criterion.id];
    }
    update({ attributes });
  }

  function onCondition(value: Condition | null) {
    update({ condition: value });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (stepIssues("criteres", listing).length === 0) onNext();
  }

  return (
    <form id={STEP_FORM_ID} onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      {subcategory.criteria.length === 0 && !subcategory.condition ? (
        <p className="text-foreground-muted">{t("wizard.optional")}</p>
      ) : (
        <>
          <p className="text-sm text-foreground-muted">{t("wizard.requiredHint")}</p>
          {covered.length > 0 ? <p className="text-sm text-foreground-muted">{t("catalogue.fromVariants", { criteria: covered.map((criterion) => labels.label(criterion.id)).join(", ") })}</p> : null}
          <CriteriaFields subcategory={shown} attributes={listing.attributes} condition={listing.condition} errors={errors} onAttribute={onAttribute} onCondition={onCondition} onBlur={() => void flush()} pro={listing.sellerType === "pro"} />
        </>
      )}
    </form>
  );
}
