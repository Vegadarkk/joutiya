"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CircleAlert, ImageOff, MapPin, MessageSquare, Phone, Tag } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { InlineError } from "@/components/feedback/inline-error";
import { FormMessage } from "@/components/auth/form-message";
import { TurnstileWidget, type TurnstileHandle } from "@/components/auth/turnstile-widget";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { criterionById, subcategoryById } from "@/config/categories";
import { cityBySlug, cityName, regionByCode, regionName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { isApiError, type ApiError } from "@/lib/auth/client";
import type { FieldIssue, PublishListingResponse, WizardStep } from "@/lib/contracts/listings";
import { publishListing } from "@/lib/listings/client/api";
import { formatPrice } from "@/lib/listings/client/format";
import { useWizard } from "@/lib/listings/client/store";
import { allIssues, stepOfPath } from "@/lib/listings/client/validation";
import { cn } from "@/lib/utils";
import { groupIssuesByStep, useStepLabel, useValidationMessage } from "../field-messages";
import { useCategoryLabels, useCriteriaLabels } from "../labels";
import { STEP_FORM_ID } from "../wizard-shell";

// Step 9: the listing as buyers will see it, the declarations, Turnstile when the API asks for it
// (same mechanism as the phase 2 login) and Publish. A 422 lists the blockers with a jump link to
// the faulty step. On a listing that is already public the step saves and goes back to "Mes annonces".

interface ReviewStepProps {
  onEdit: (step: WizardStep) => void;
  onPublished: (result: PublishListingResponse) => void;
  onSaved: () => void;
  onBusy: (busy: boolean) => void;
  nonce?: string;
}

/** Blockers of a 422 `invalid_listing`: `details` is the FieldIssue list, or `{ blockers }`. */
export function blockersOf(error: ApiError): FieldIssue[] {
  const details = error.details as unknown;
  if (Array.isArray(details)) return details as FieldIssue[];
  if (details && typeof details === "object" && Array.isArray((details as { blockers?: unknown }).blockers)) return (details as { blockers: FieldIssue[] }).blockers;
  return [];
}

export function ReviewStep({ onEdit, onPublished, onSaved, onBusy, nonce }: ReviewStepProps) {
  const { listing, photos, photosBusy, maxPhotos, blockers, setBlockers, flush, saveState, listingId } = useWizard();
  const t = useTranslations("Listing");
  const names = useCategoryLabels();
  const criteria = useCriteriaLabels();
  const locale = useLocale() as Locale;
  const stepLabel = useStepLabel();
  const message = useValidationMessage();
  const acceptId = useId();
  const [accepted, setAccepted] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<unknown>();
  const [publishing, setPublishing] = useState(false);
  const [turnstileNeeded, setTurnstileNeeded] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle>(null);
  const resubmitOnToken = useRef(false);

  const editable = listing.status === "draft" || listing.status === "rejected";
  const issues = useMemo(() => allIssues(listing, { maxPhotos }), [listing, maxPhotos]);
  const incomplete = issues.length > 0;
  const subcategory = listing.subcategoryId ? subcategoryById(listing.subcategoryId) : undefined;
  const city = listing.location ? cityBySlug(listing.location.citySlug) : undefined;
  const region = city ? regionByCode(city.regionCode) : undefined;
  const cover = photos.find((item) => item.status === "ready" && item.previewUrl) ?? photos.find((item) => item.previewUrl);
  const readyCount = photos.filter((item) => item.status === "ready").length;

  useEffect(() => onBusy(publishing), [publishing, onBusy]);

  async function publish() {
    setServerError(undefined);
    setPublishing(true);
    try {
      await flush();
      const result = await publishListing(listingId, { acceptRules: true, ...(token ? { turnstileToken: token } : {}) });
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
    if (!editable) {
      setPublishing(true);
      try {
        await flush();
        onSaved();
      } finally {
        setPublishing(false);
      }
      return;
    }
    setAttempted(true);
    if (incomplete || photosBusy || !accepted) return;
    if (turnstileNeeded && !token) return;
    await publish();
  }

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
      <FormMessage error={serverError} />
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
          <EditButton onClick={() => onEdit("photos")} label={t("review.editStep", { step: stepLabel("photos") })} className="absolute end-3 top-3" />
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
      {saveState === "error" ? <ErrorBanner tone="warning" title={t("wizard.saveError")} /> : null}
      <Button type="submit" size="lg" loading={publishing} className="w-full sm:hidden" disabled={editable && (photosBusy || (turnstileNeeded && !token))}>
        {editable ? t("review.publish") : t("review.save")}
      </Button>
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
    <button type="button" onClick={onClick} aria-label={label} className={cn("shrink-0 rounded-md px-2 py-1 text-sm font-medium text-link underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25", className)}>
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
          <button type="button" onClick={() => onEdit(group.step)} className="w-fit text-start font-medium underline underline-offset-2" aria-label={fixLabel(group.step)}>
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
