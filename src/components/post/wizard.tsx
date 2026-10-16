"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { EmptyState } from "@/components/feedback/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link, getPathname, usePathname, useRouter } from "@/i18n/navigation";
import type { Locale } from "@/config/site";
import { isApiError } from "@/lib/auth/client";
import { usePublicConfig } from "@/lib/config/client";
import { WIZARD_DONE, WIZARD_STEPS, type ListingPatch, type ListingStatus, type OwnerListing, type PublishListingResponse, type WizardStep } from "@/lib/contracts/listings";
import { MAX_PHOTOS_INDIVIDUAL } from "@/lib/contracts/media";
import { getListing, patchListing } from "@/lib/listings/client/api";
import { parseWizardPath, wizardPath, type WizardScreen } from "@/lib/listings/client/routes";
import { WizardProvider, useWizard } from "@/lib/listings/client/store";
import { firstIncompleteStep, nextStep, previousStep, stepState, type StepState } from "@/lib/listings/client/validation";
import { DoneScreen } from "./done-screen";
import { useStepLabel } from "./field-messages";
import { CategoryStep } from "./steps/category-step";
import { ContactStep } from "./steps/contact-step";
import { CriteriaStep } from "./steps/criteria-step";
import { DescriptionStep } from "./steps/description-step";
import { LocationStep } from "./steps/location-step";
import { PhotosStep } from "./steps/photos-step";
import { PriceStep } from "./steps/price-step";
import { ReviewStep } from "./steps/review-step";
import { TitleStep } from "./steps/title-step";
import { useIssueOptions } from "./use-issue-options";
import { WizardShell } from "./wizard-shell";

// The wizard shell for one listing id: hydrates from GET /api/listings/{id}, then renders the
// step named by the URL. Step changes use the History API (no server round trip: the server page
// only validated the first URL), so the current step is read from the pathname.

type LoadState = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; listing: OwnerListing };

/** Statuses the API refuses to edit (service EDITABLE_STATUSES). */
const READ_ONLY: readonly ListingStatus[] = ["sold", "removed", "purged"];

export function PostWizard({ listingId, nonce }: { listingId: string; nonce?: string }) {
  const t = useTranslations("Listing.wizard");
  const config = usePublicConfig();
  const apiMessage = useApiErrorMessage();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const started = useRef(false);

  // A live listing left with unsaved changes (header link): one toast offers to save them.
  const onUnsavedLeave = useCallback(
    (patch: ListingPatch) => {
      toast.warning(t("unsavedLeftTitle"), {
        description: t("unsavedLeftBody"),
        duration: 20_000,
        action: {
          label: t("saveNow"),
          onClick: () => {
            patchListing(listingId, patch).then(
              () => toast.success(t("savedLive")),
              (error: unknown) => toast.error(apiMessage(error)),
            );
          },
        },
      });
    },
    [apiMessage, listingId, t],
  );

  const load = useCallback(async () => {
    try {
      const { listing } = await getListing(listingId);
      setState({ kind: "ready", listing });
    } catch (error) {
      setState({ kind: "failed", error });
    }
  }, [listingId]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  if (state.kind === "loading") {
    return (
      <div role="status" aria-busy="true" aria-label={t("loading")} className="flex flex-col gap-6">
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }
  if (state.kind === "failed") {
    if (isApiError(state.error, "not_found", "forbidden")) {
      return (
        <EmptyState
          headingLevel="h1"
          title={t("notFoundTitle")}
          action={
            <Button asChild>
              <Link href={{ pathname: "/deposer", query: { nouveau: "1" } }}>{t("newListing")}</Link>
            </Button>
          }
        >
          {t("notFoundBody")}
        </EmptyState>
      );
    }
    return (
      <FormMessage
        error={state.error}
        title={t("loadFailedTitle")}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setState({ kind: "loading" });
              void load();
            }}
          >
            {t("retry")}
          </Button>
        }
      >
        {apiMessage(state.error)}
      </FormMessage>
    );
  }
  if (READ_ONLY.includes(state.listing.status)) {
    return (
      <EmptyState
        headingLevel="h1"
        title={t("readOnlyTitle")}
        action={
          <Button asChild>
            <Link href="/mes-annonces">{t("myListings")}</Link>
          </Button>
        }
      >
        {t("readOnlyBody")}
      </EmptyState>
    );
  }
  return (
    <WizardProvider listing={state.listing} maxPhotos={config?.upload.maxPhotos ?? MAX_PHOTOS_INDIVIDUAL} mediaBaseUrl={config?.mediaBaseUrl ?? null} onUnsavedLeave={onUnsavedLeave}>
      <WizardScreens nonce={nonce} />
    </WizardProvider>
  );
}

function WizardScreens({ nonce }: { nonce?: string }) {
  const { listing, listingId, saveState, saveError, saveMode, retrySave, save, publishResult, setPublished, flush } = useWizard();
  const t = useTranslations("Listing");
  const locale = useLocale() as Locale;
  const pathname = usePathname();
  const router = useRouter();
  const stepLabel = useStepLabel();
  const issueOptions = useIssueOptions();
  const [busy, setBusy] = useState(false);
  const parsed = parseWizardPath(pathname);
  const screen: WizardScreen | null = parsed.id === listingId ? parsed.screen : null;

  const navigate = useCallback(
    (next: WizardScreen, replace = false) => {
      const href = getPathname({ href: wizardPath(listingId, next), locale });
      // History API: Next.js syncs usePathname with it, no server round trip between steps.
      if (typeof window !== "undefined" && typeof window.history?.pushState === "function") {
        if (replace) window.history.replaceState(null, "", href);
        else window.history.pushState(null, "", href);
      } else if (replace) {
        router.replace(wizardPath(listingId, next));
      } else {
        router.push(wizardPath(listingId, next));
      }
    },
    [listingId, locale, router],
  );

  // `/deposer/{id}`: resume where the draft stopped (a live listing opens on its review). The
  // result screen without a result (reload of a draft) goes back to the steps.
  const needsRedirect = screen === null || (screen === WIZARD_DONE && !publishResult && listing.status === "draft");
  useEffect(() => {
    if (!needsRedirect) return;
    navigate(listing.status === "draft" ? firstIncompleteStep(listing, issueOptions) : "apercu", true);
  }, [needsRedirect, listing, issueOptions, navigate]);

  const states = useMemo(() => Object.fromEntries(WIZARD_STEPS.map((step) => [step, stepState(step, listing, issueOptions)])) as Record<WizardStep, StepState>, [listing, issueOptions]);
  const reachable = useCallback((step: WizardStep) => step === "categorie" || Boolean(listing.subcategoryId), [listing.subcategoryId]);

  const goTo = useCallback(
    (step: WizardStep) => {
      void flush();
      navigate(step);
    },
    [flush, navigate],
  );

  const onSaveNow = useCallback(async () => {
    if (await save()) toast.success(t("done.savedTitle"));
  }, [save, t]);

  if (screen === null || needsRedirect) return null;

  if (screen === WIZARD_DONE) {
    if (publishResult) return <DoneScreen status={publishResult.status} slugId={publishResult.slugId ?? listing.slugId} url={publishResult.url} listingId={listingId} />;
    return <DoneScreen status={listing.status} slugId={listing.slugId} listingId={listingId} />;
  }

  const step = screen;
  const onNext = () => {
    const next = nextStep(step);
    if (next) {
      void flush();
      navigate(next);
    }
  };
  const previous = previousStep(step);
  const onBack = previous ? () => goTo(previous) : undefined;

  function onPublished(result: PublishListingResponse) {
    setPublished(result);
    navigate(WIZARD_DONE);
  }

  function onSaved() {
    toast.success(t("done.savedTitle"));
    router.push("/mes-annonces");
  }

  const editable = saveMode === "auto";

  return (
    <WizardShell
      step={step}
      title={step === "categorie" && !listing.subcategoryId ? t("wizard.title") : stepLabel(step)}
      lead={t(`stepLead.${step}`)}
      states={states}
      reachable={reachable}
      onSelect={goTo}
      onBack={onBack}
      nextLabel={step === "apercu" ? (editable ? t("review.publish") : t("review.save")) : undefined}
      nextLoading={step === "apercu" ? busy : false}
      saveState={saveState}
      saveError={saveError}
      saveMode={saveMode}
      onRetrySave={retrySave}
      onSaveNow={() => void onSaveNow()}
    >
      {step === "categorie" ? <CategoryStep onNext={onNext} /> : null}
      {step === "criteres" ? <CriteriaStep onNext={onNext} /> : null}
      {step === "titre" ? <TitleStep onNext={onNext} /> : null}
      {step === "description" ? <DescriptionStep onNext={onNext} /> : null}
      {step === "photos" ? <PhotosStep onNext={onNext} /> : null}
      {step === "prix" ? <PriceStep onNext={onNext} /> : null}
      {step === "lieu" ? <LocationStep onNext={onNext} /> : null}
      {step === "contact" ? <ContactStep onNext={onNext} /> : null}
      {step === "apercu" ? <ReviewStep onEdit={goTo} onPublished={onPublished} onSaved={onSaved} onBusy={setBusy} nonce={nonce} /> : null}
    </WizardShell>
  );
}
