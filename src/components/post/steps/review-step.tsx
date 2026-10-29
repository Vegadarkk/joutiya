"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CircleAlert, ImageOff, MapPin, MessageSquare, Phone, ShieldAlert, Tag } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { InlineError } from "@/components/feedback/inline-error";
import { FormMessage } from "@/components/auth/form-message";
import { TurnstileWidget, type TurnstileHandle } from "@/components/auth/turnstile-widget";
import { Badge } from "@/components/ui/badge";
import { RENTAL_SUBCATEGORY, criterionById, subcategoryById } from "@/config/categories";
import { cityBySlug, cityName, regionByCode, regionName } from "@/config/regions";
import { SITE_NAME, type Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { useNumbersTranslations } from "@/i18n/numbers";
import { isApiError } from "@/lib/auth/client";
import { SENSITIVE_DECLARATION_KINDS, type FieldIssue, type PublishListingResponse, type SensitiveDeclarationKind, type WizardStep } from "@/lib/contracts/listings";
import { publishListing } from "@/lib/listings/client/api";
import { formatPrice } from "@/lib/listings/client/format";
import { needsRealEstateAttestation } from "@/lib/listings/real-estate";
import { blockersOf, useWizard } from "@/lib/listings/client/store";
import { allIssues, stepOfPath } from "@/lib/listings/client/validation";
import { cn } from "@/lib/utils";
import { ChipRadioGroup } from "../controls/chips";
import { SwitchField } from "../controls/switch";
import { takeBlockers } from "../blockers-handoff";
import { groupIssuesByStep, useSaveErrorMessage, useStepLabel, useValidationMessage } from "../field-messages";
import { useCategoryLabels, useCriteriaLabels } from "../labels";
import { useIssueOptions } from "../use-issue-options";
import { STEP_FORM_ID } from "../wizard-shell";

// Step 9: the listing as buyers will see it, the declarations, Turnstile when the API asks for it
// (same mechanism as the phase 2 login) and Publish. A 422 lists the blockers with a jump link to
// the faulty step. On a listing that is already public the step saves and goes back to "Mes annonces".
// Publish first commits what is pending (a rejected listing is reopened as a draft by that save),
// and one publish runs at a time whatever the number of clicks.

interface ReviewStepProps {
  onEdit: (step: WizardStep) => void;
  onPublished: (result: PublishListingResponse) => void;
  onSaved: () => void;
  onBusy: (busy: boolean) => void;
  nonce?: string;
}

export function ReviewStep({ onEdit, onPublished, onSaved, onBusy, nonce }: ReviewStepProps) {
  const { listing, photos, photosBusy, blockers, setBlockers, save, saveState, saveError, saveMode, listingId, update } = useWizard();
  const t = useNumbersTranslations("Listing");
  const names = useCategoryLabels();
  const criteria = useCriteriaLabels();
  const locale = useLocale() as Locale;
  const stepLabel = useStepLabel();
  const message = useValidationMessage();
  const saveMessage = useSaveErrorMessage();
  const acceptId = useId();
  const adultsId = useId();
  const declaredId = useId();
  const sensitiveId = useId();
  const issueOptions = useIssueOptions();
  const [accepted, setAccepted] = useState(false);
  const [attested, setAttested] = useState(false);
  const [declared, setDeclared] = useState(false);
  const [sensitive, setSensitive] = useState(listing.sensitiveDeclaration !== null);
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<unknown>();
  const [publishing, setPublishing] = useState(false);
  const [turnstileNeeded, setTurnstileNeeded] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle>(null);
  const resubmitOnToken = useRef(false);
  const running = useRef(false);

  // A draft (or a rejected listing, reopened by its next save) is published; a live one is saved.
  const editable = saveMode === "auto";
  const issues = useMemo(() => allIssues(listing, issueOptions), [listing, issueOptions]);
  const sensitiveMissing = sensitive && listing.sensitiveDeclaration === null;
  const incomplete = issues.length > 0;
  const subcategory = listing.subcategoryId ? subcategoryById(listing.subcategoryId) : undefined;
  const city = listing.location ? cityBySlug(listing.location.citySlug) : undefined;
  const region = city ? regionByCode(city.regionCode) : undefined;
  const cover = photos.find((item) => item.status === "ready" && item.previewUrl) ?? photos.find((item) => item.previewUrl);
  const readyCount = photos.filter((item) => item.status === "ready").length;
  // The seller's attestation, sent with the publication: adults-only subcategory (decorative
  // koumiyas), car rental (the agency's licence, registration, insurance and declarations).
  const adultsOnly = Boolean(subcategory?.adultsOnly);
  const rental = listing.subcategoryId === RENTAL_SUBCATEGORY;
  const attestation = adultsOnly ? "adultsOnly" : rental ? "rental" : null;
  // Real estate: the advertiser attests its declared data (title, mandate, fees, authorisation).
  const realEstate = needsRealEstateAttestation(subcategory);
  const attestationMissing = (attestation !== null && !attested) || (realEstate && !declared);

  useEffect(() => onBusy(publishing), [publishing, onBusy]);

  // Blockers of a renewal refused from "Mes annonces" (422): listed like those of a refused save.
  useEffect(() => {
    const handed = takeBlockers(listingId);
    if (handed.length > 0) setBlockers(handed);
  }, [listingId, setBlockers]);

  async function publish() {
    if (running.current) return;
    running.current = true;
    setServerError(undefined);
    setPublishing(true);
    try {
      // The server publishes what it holds: pending edits first. The indicator shows a failed save.
      if (!(await save({ reopen: listing.status === "rejected" }))) return;
      const result = await publishListing(listingId, { acceptRules: true, ...(adultsOnly ? { adultsOnlyAttestation: true } : {}), ...(rental ? { rentalAttestation: true } : {}), ...(realEstate ? { realEstateAttestation: true } : {}), ...(token ? { turnstileToken: token } : {}) });
      setBlockers([]);
      onPublished(result);
    } catch (error) {
      setToken(null);
      if (isApiError(error, "invalid_listing")) {
        setBlockers(blockersOf(error));
      } else if (isApiError(error, "turnstile_required", "turnstile_failed")) {
        resubmitOnToken.current = !turnstileNeeded;
        setTurnstileNeeded(true);
        turnstile.current?.reset();
        if (error.code === "turnstile_failed") setServerError(error);
      } else {
        setServerError(error);
      }
    } finally {
      running.current = false;
      setPublishing(false);
    }
  }

  function onToken(next: string | null) {
    setToken(next);
    if (next && resubmitOnToken.current) {
      resubmitOnToken.current = false;
      void publish();
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (running.current) return;
    if (!editable) {
      // A live listing: the save re-checks it (refusals come back as blockers above).
      running.current = true;
      setPublishing(true);
      try {
        if (await save()) onSaved();
      } finally {
        running.current = false;
        setPublishing(false);
      }
      return;
    }
    setAttempted(true);
    if (incomplete || photosBusy || !accepted || attestationMissing || sensitiveMissing) return;
    if (turnstileNeeded && !token) return;
    await publish();
  }

  function onSensitive(on: boolean) {
    setSensitive(on);
    if (!on && listing.sensitiveDeclaration !== null) update({ sensitiveDeclaration: null }, { flush: true });
  }

  const sensitiveOptions = SENSITIVE_DECLARATION_KINDS.map((kind) => ({ value: kind, label: t(`review.sensitiveKinds.${kind}`) }));

  const serverBlockers = useMemo(() => groupIssuesByStep(blockers.map((issue) => ({ ...issue, step: stepOfPath(issue.path) }))), [blockers]);
  const missing = useMemo(() => groupIssuesByStep(issues), [issues]);

  const legal = (slug: "cgu" | "objets-interdits") =>
    function LegalLink(chunks: ReactNode) {
      return (
        <Link href={`/legal/${slug}`} target="_blank" rel="noopener" className="font-medium text-link underline underline-offset-2">
          {chunks}
        </Link>
      );
    };

  return (
    <form id={STEP_FORM_ID} onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-6">
      <FormMessage error={serverError} scope="listing" />
      {!editable ? <ErrorBanner tone="info" title={t("review.publishedListing")} /> : null}

      {serverBlockers.length > 0 ? (
        <ErrorBanner title={t("review.blockersTitle")}>
          <IssueList groups={serverBlockers} onEdit={onEdit} stepLabel={stepLabel} message={(issue) => (issue.message && !t.has(`validation.${issue.code}` as never) ? issue.message : message(issue.code))} fixLabel={(step) => t("review.fixStep", { step: stepLabel(step) })} />
        </ErrorBanner>
      ) : null}
      {incomplete && (attempted || missing.length > 0) ? (
        <ErrorBanner tone={attempted ? "danger" : "warning"} title={t("review.incompleteTitle")}>
          <p className="mb-2">{t("review.incompleteBody")}</p>
          <IssueList groups={missing} onEdit={onEdit} stepLabel={stepLabel} message={(issue) => message(issue.code)} fixLabel={(step) => t("review.goToStep", { step: stepLabel(step) })} />
        </ErrorBanner>
      ) : null}

      {/* The preview: what a buyer sees on the card and at the top of the page. */}
      <article aria-label={t("review.title")} className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="relative aspect-[16/9] w-full bg-surface-muted sm:aspect-[21/9]">
          {cover?.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cover.previewUrl} alt="" className="absolute inset-0 size-full object-cover" />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-foreground-muted">
              <ImageOff className="size-8" aria-hidden="true" strokeWidth={1.5} />
              <span className="text-sm">{t("review.noPhotos")}</span>
            </div>
          )}
          <Badge variant="neutral" className="absolute bottom-3 end-3 bg-surface/90">
            {readyCount === 0 ? t("review.noPhotos") : t("review.photos", { count: readyCount })}
          </Badge>
          <EditButton onClick={() => onEdit("photos")} label={t("review.editStep", { step: stepLabel("photos") })} className="absolute end-2 top-2 bg-surface/90 shadow-sm hover:bg-surface" />
        </div>

        <div className="flex flex-col gap-5 p-5">
          <Section onEdit={() => onEdit("titre")} label={t("review.editStep", { step: stepLabel("titre") })}>
            <h2 className={cn("text-xl font-semibold text-balance", !listing.title && "text-foreground-muted")}>{listing.title || t("review.untitled")}</h2>
          </Section>
          <Section onEdit={() => onEdit("prix")} label={t("review.editStep", { step: stepLabel("prix") })}>
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums">
                {listing.isDonation ? t("review.donation") : listing.price !== null ? formatPrice(listing.price, locale) : subcategory?.priceOptional ? t("review.toDiscuss") : <span className="text-base font-normal text-foreground-muted">{t("review.noPrice")}</span>}
              </span>
              {subcategory?.priceUnit && listing.price !== null && !listing.isDonation ? <span className="text-sm text-foreground-muted">{t(`fields.per.${subcategory.priceUnit}`)}</span> : null}
              {listing.priceNegotiable && !listing.isDonation ? <Badge variant="neutral">{t("review.negotiable")}</Badge> : null}
            </p>
          </Section>
          <Section onEdit={() => onEdit("lieu")} label={t("review.editStep", { step: stepLabel("lieu") })}>
            <p className="flex items-center gap-2 text-foreground-muted">
              <MapPin className="size-4 shrink-0" aria-hidden="true" />
              {city ? (
                <span>
                  {cityName(city, locale)}
                  {listing.location?.district ? `, ${listing.location.district}` : ""}
                  {region ? ` (${regionName(region, locale)})` : ""}
                </span>
              ) : (
                <span>{t("review.noCity")}</span>
              )}
            </p>
          </Section>
          <Section onEdit={() => onEdit("categorie")} label={t("review.editStep", { step: stepLabel("categorie") })}>
            <p className="flex items-center gap-2 text-sm text-foreground-muted">
              <Tag className="size-4 shrink-0" aria-hidden="true" />
              {listing.categoryId && listing.subcategoryId ? `${names.category(listing.categoryId)} › ${names.subcategory(listing.categoryId, listing.subcategoryId)}` : t("review.noCategory")}
            </p>
          </Section>

          {subcategory && (Object.keys(listing.attributes).length > 0 || listing.condition) ? (
            <Section onEdit={() => onEdit("criteres")} label={t("review.editStep", { step: stepLabel("criteres") })}>
              <h3 className="mb-2 text-sm font-semibold">{t("review.details")}</h3>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                {listing.condition ? (
                  <div className="flex justify-between gap-3 border-b border-border py-1">
                    <dt className="text-foreground-muted">{t("fields.condition")}</dt>
                    <dd className="text-end font-medium">{criteria.option("condition", listing.condition)}</dd>
                  </div>
                ) : null}
                {subcategory.criteria
                  .filter((criterion) => listing.attributes[criterion.id] !== undefined)
                  .map((criterion) => {
                    const value = listing.attributes[criterion.id];
                    const def = criterionById(criterion.id);
                    const text = Array.isArray(value)
                      ? value.map((v) => criteria.option(criterion.id, v)).join(", ")
                      : typeof value === "boolean"
                        ? value
                          ? "✓"
                          : "—"
                        : typeof value === "number"
                          ? `${value}${def?.unit && def.unit !== "an" ? ` ${t(`units.${def.unit}`)}` : ""}`
                          : criteria.option(criterion.id, String(value));
                    return (
                      <div key={criterion.id} className="flex justify-between gap-3 border-b border-border py-1">
                        <dt className="text-foreground-muted">{criteria.label(criterion.id)}</dt>
                        <dd className="text-end font-medium">{text}</dd>
                      </div>
                    );
                  })}
              </dl>
            </Section>
          ) : null}

          <Section onEdit={() => onEdit("description")} label={t("review.editStep", { step: stepLabel("description") })}>
            <p className={cn("whitespace-pre-line text-pretty", !listing.description && "text-foreground-muted")}>{listing.description || t("review.noDescription")}</p>
          </Section>

          <Section onEdit={() => onEdit("contact")} label={t("review.editStep", { step: stepLabel("contact") })}>
            <ul className="flex flex-wrap gap-2 text-sm">
              <li className="flex items-center gap-1.5 rounded-md bg-surface-muted px-2.5 py-1">
                <MessageSquare className="size-4" aria-hidden="true" />
                {t("review.contactMessages")}
              </li>
              {listing.contact.showPhone ? (
                <li className="flex items-center gap-1.5 rounded-md bg-surface-muted px-2.5 py-1">
                  <Phone className="size-4" aria-hidden="true" />
                  {t("review.contactPhone")}
                </li>
              ) : null}
              {listing.contact.whatsapp ? <li className="flex items-center gap-1.5 rounded-md bg-surface-muted px-2.5 py-1">{t("review.contactWhatsapp")}</li> : null}
            </ul>
          </Section>
        </div>
      </article>

      {editable ? (
        <section aria-labelledby="review-declarations" className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
          <h2 id="review-declarations" className="font-semibold">
            {t("review.declarations")}
          </h2>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={acceptId} className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
              <input
                id={acceptId}
                type="checkbox"
                checked={accepted}
                aria-required="true"
                aria-invalid={attempted && !accepted ? true : undefined}
                onChange={(event) => setAccepted(event.target.checked)}
                className="mt-1 size-5 shrink-0 cursor-pointer rounded-sm border-border-strong accent-primary"
              />
              <span className="text-pretty">{t.rich("review.acceptRules", { cgu: legal("cgu"), interdits: legal("objets-interdits") })}</span>
            </label>
            {attempted && !accepted ? <InlineError className="ps-8">{t("validation.accept_rules")}</InlineError> : null}
          </div>
          {attestation ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={adultsId} className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
                <input
                  id={adultsId}
                  type="checkbox"
                  checked={attested}
                  aria-required="true"
                  aria-invalid={attempted && !attested ? true : undefined}
                  onChange={(event) => setAttested(event.target.checked)}
                  className="mt-1 size-5 shrink-0 cursor-pointer rounded-sm border-border-strong accent-primary"
                />
                <span className="text-pretty">{t(attestation === "rental" ? "review.rentalAttestation" : "review.adultsOnlyAttestation")}</span>
              </label>
              {attempted && !attested ? <InlineError className="ps-8">{t(attestation === "rental" ? "validation.rental_attestation" : "validation.adults_only_attestation")}</InlineError> : null}
            </div>
          ) : null}
          {realEstate ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={declaredId} className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
                <input
                  id={declaredId}
                  type="checkbox"
                  checked={declared}
                  aria-required="true"
                  aria-invalid={attempted && !declared ? true : undefined}
                  onChange={(event) => setDeclared(event.target.checked)}
                  className="mt-1 size-5 shrink-0 cursor-pointer rounded-sm border-border-strong accent-primary"
                />
                <span className="text-pretty">{t.rich("review.realEstateAttestation", { cgu: legal("cgu"), brand: SITE_NAME })}</span>
              </label>
              {attempted && !declared ? <InlineError className="ps-8">{t("validation.real_estate_attestation")}</InlineError> : null}
            </div>
          ) : null}
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <SwitchField label={t("review.sensitiveLabel")} hint={t("review.sensitiveHint")} checked={sensitive} onCheckedChange={onSensitive} />
            {sensitive ? (
              <div className="flex flex-col gap-2 rounded-lg bg-surface-muted p-4">
                <p id={sensitiveId} className="flex gap-2 text-sm font-medium">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                  {t("review.sensitiveQuestion")}
                </p>
                <ChipRadioGroup
                  options={sensitiveOptions}
                  value={listing.sensitiveDeclaration?.kind ?? null}
                  onChange={(kind) => update({ sensitiveDeclaration: { kind: kind as SensitiveDeclarationKind } }, { flush: true })}
                  label={t("review.sensitiveQuestion")}
                  labelledBy={sensitiveId}
                  invalid={attempted && sensitiveMissing}
                />
                <p className="text-xs text-foreground-muted text-pretty">{t("review.sensitiveNote")}</p>
                {attempted && sensitiveMissing ? <InlineError>{t("validation.sensitive_required")}</InlineError> : null}
              </div>
            ) : null}
          </div>
          <p className="text-xs text-foreground-muted">{t("review.hostNote")}</p>
          {photosBusy ? (
            <p className="flex items-center gap-2 text-sm text-warning">
              <CircleAlert className="size-4" aria-hidden="true" />
              {t("review.photosPending")}
            </p>
          ) : null}
          {turnstileNeeded ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-muted p-4">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">{t("review.turnstileTitle")}</p>
                <p className="text-sm text-foreground-muted text-pretty">{t("review.turnstileBody")}</p>
              </div>
              <TurnstileWidget ref={turnstile} action="listing" nonce={nonce} onToken={onToken} error={attempted && !token ? t("validation.turnstile") : undefined} />
            </div>
          ) : null}
        </section>
      ) : null}
      {/* The last save failed: its reason (refused fields come back as blockers above). */}
      {saveState === "error" && !isApiError(saveError, "invalid_listing") ? <FormMessage error={saveError} tone="warning" title={saveMessage(saveError)} /> : null}
    </form>
  );
}

function Section({ children, onEdit, label }: { children: ReactNode; onEdit: () => void; label: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">{children}</div>
      <EditButton onClick={onEdit} label={label} />
    </div>
  );
}

function EditButton({ onClick, label, className }: { onClick: () => void; label: string; className?: string }) {
  const t = useTranslations("Listing.review");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn("-my-2 inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm font-medium text-link underline-offset-2 hover:underline", className)}
    >
      {t("edit")}
    </button>
  );
}

function IssueList<T extends FieldIssue & { step: WizardStep }>({
  groups,
  onEdit,
  stepLabel,
  message,
  fixLabel,
}: {
  groups: { step: WizardStep; issues: T[] }[];
  onEdit: (step: WizardStep) => void;
  stepLabel: (step: WizardStep) => string;
  message: (issue: T) => string;
  fixLabel: (step: WizardStep) => string;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {groups.map((group) => (
        <li key={group.step} className="flex flex-col gap-0.5">
          <button type="button" onClick={() => onEdit(group.step)} className="-my-1.5 inline-flex min-h-11 w-fit items-center rounded-sm text-start font-medium underline underline-offset-2" aria-label={fixLabel(group.step)}>
            {stepLabel(group.step)}
          </button>
          <ul className="list-disc ps-5 text-sm">
            {group.issues.map((issue) => (
              <li key={`${issue.path}-${issue.code}`}>{message(issue)}</li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
