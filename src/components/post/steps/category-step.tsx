"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import type { Subcategory } from "@/config/categories";
import { useWizard } from "@/lib/listings/client/store";
import { CategoryPicker } from "../category-picker";
import { STEP_FORM_ID } from "../wizard-shell";

export function CategoryStep({ onNext }: { onNext: () => void }) {
  const { listing, update } = useWizard();
  const t = useTranslations("Listing");
  const [picked, setPicked] = useState<string | null>(listing.categoryId);
  const [attempted, setAttempted] = useState(false);

  function onSubcategory(subcategory: Subcategory) {
    const changed = subcategory.id !== listing.subcategoryId;
    // A new subcategory has other criteria: the old attributes make no sense and are cleared.
    update({ categoryId: subcategory.categoryId, subcategoryId: subcategory.id, ...(changed ? { attributes: {}, condition: null } : {}) }, { flush: true });
    onNext();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (listing.subcategoryId) onNext();
    else setAttempted(true);
  }

  return (
    <form id={STEP_FORM_ID} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <CategoryPicker categoryId={picked} subcategoryId={listing.subcategoryId} onCategory={setPicked} onSubcategory={onSubcategory} isPro={listing.sellerType === "pro"} />
      {attempted && !listing.subcategoryId ? <InlineError>{picked ? t("validation.subcategory_required") : t("validation.category_required")}</InlineError> : null}
      {listing.subcategoryId && picked ? <p className="text-sm text-foreground-muted">{t("category.resetWarning")}</p> : null}
    </form>
  );
}
