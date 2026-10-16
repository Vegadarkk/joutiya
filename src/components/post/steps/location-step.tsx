"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cityBySlug, regionByCode, regionName, type City } from "@/config/regions";
import type { Locale } from "@/config/site";
import { useLocale } from "next-intl";
import { useWizard } from "@/lib/listings/client/store";
import { DISTRICT_MAX, stepIssues } from "@/lib/listings/client/validation";
import { CityCombobox } from "../city-combobox";
import { useValidationMessage } from "../field-messages";
import { STEP_FORM_ID } from "../wizard-shell";

export function LocationStep({ onNext }: { onNext: () => void }) {
  const { listing, update, flush, blockers } = useWizard();
  const t = useTranslations("Listing.fields");
  const locale = useLocale() as Locale;
  const message = useValidationMessage();
  const [attempted, setAttempted] = useState(false);
  const [district, setDistrict] = useState(listing.location?.district ?? "");
  const city = listing.location ? (cityBySlug(listing.location.citySlug) ?? null) : null;
  const region = city ? regionByCode(city.regionCode) : undefined;
  const issues = useMemo(() => stepIssues("lieu", listing), [listing]);
  const cityIssue = blockers.find((issue) => issue.path.startsWith("location") && !issue.path.endsWith("district")) ?? (attempted ? issues.find((issue) => !issue.path.endsWith("district")) : undefined);
  const districtIssue = blockers.find((issue) => issue.path.endsWith("district")) ?? (attempted ? issues.find((issue) => issue.path.endsWith("district")) : undefined);

  function onCity(next: City) {
    const trimmed = district.trim();
    update({ location: { regionCode: next.regionCode, citySlug: next.slug, ...(trimmed ? { district: trimmed } : {}) } }, { flush: true });
  }

  function onDistrict(value: string) {
    setDistrict(value);
    if (!city) return;
    const trimmed = value.trim();
    update({ location: { regionCode: city.regionCode, citySlug: city.slug, ...(trimmed ? { district: trimmed.slice(0, DISTRICT_MAX) } : {}) } });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (stepIssues("lieu", listing).length === 0) {
      void flush();
      onNext();
    }
  }

  return (
    <form id={STEP_FORM_ID} onSubmit={onSubmit} onBlur={() => void flush()} noValidate className="flex flex-col gap-5">
      <CityCombobox value={city} onSelect={onCity} error={cityIssue ? message(cityIssue.code) : undefined} required autoFocus={!city} />
      {region ? (
        <Field label={t("region")}>
          <Input type="text" value={regionName(region, locale)} readOnly tabIndex={-1} className="bg-surface-muted" />
        </Field>
      ) : null}
      <Field label={t("district")} hint={t("districtHint")} error={districtIssue ? message(districtIssue.code, { max: DISTRICT_MAX }) : undefined}>
        <Input type="text" value={district} maxLength={DISTRICT_MAX} autoComplete="off" disabled={!city} onChange={(event) => onDistrict(event.target.value)} />
      </Field>
    </form>
  );
}
