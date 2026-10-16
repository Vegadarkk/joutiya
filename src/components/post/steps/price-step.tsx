"use client";

import { useMemo, useState, type FormEvent } from "react";
import { subcategoryById } from "@/config/categories";
import { useWizard } from "@/lib/listings/client/store";
import { stepIssues } from "@/lib/listings/client/validation";
import { useValidationMessage } from "../field-messages";
import { PriceInput } from "../price-input";
import { STEP_FORM_ID } from "../wizard-shell";

export function PriceStep({ onNext }: { onNext: () => void }) {
  const { listing, update, flush, blockers } = useWizard();
  const message = useValidationMessage();
  const [attempted, setAttempted] = useState(false);
  const subcategory = listing.subcategoryId ? subcategoryById(listing.subcategoryId) : undefined;
  const issues = useMemo(() => stepIssues("prix", listing), [listing]);
  const blocker = blockers.find((issue) => issue.path === "price" || issue.path === "isDonation");
  const issue = blocker ?? (attempted ? issues[0] : undefined);
  const error = issue ? message(issue.code) : undefined;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (stepIssues("prix", listing).length === 0) {
      void flush();
      onNext();
    }
  }

  return (
    <form id={STEP_FORM_ID} onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <PriceInput
        value={listing.price}
        onChange={(price) => update({ price })}
        negotiable={listing.priceNegotiable}
        onNegotiable={(priceNegotiable) => update({ priceNegotiable }, { flush: true })}
        isDonation={listing.isDonation}
        onDonation={(isDonation) => update(isDonation ? { isDonation, price: null, priceNegotiable: false } : { isDonation }, { flush: true })}
        donationAllowed={Boolean(subcategory?.donationAllowed)}
        priceOptional={Boolean(subcategory?.priceOptional)}
        priceUnit={subcategory?.priceUnit}
        error={error}
        onBlur={() => void flush()}
      />
    </form>
  );
}
