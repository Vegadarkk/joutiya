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
import { WIZARD_STEPS, type OwnerListing, type PublishListingResponse, type WizardStep } from "@/lib/contracts/listings";
import { MAX_PHOTOS_INDIVIDUAL } from "@/lib/contracts/media";
import { getListing } from "@/lib/listings/client/api";
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
import { WizardShell } from "./wizard-shell";

// The wizard shell for one listing id: hydrates from GET /api/listings/{id}, then renders the
// step named by the URL. Step changes use the History API (no server round trip: the server page
// only validated the first URL), so the current step is read from the pathname.

type LoadState = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; listing: OwnerListing };

export function PostWizard({ listingId, nonce }: { listingId: string; nonce?: string }) {
  const t = useTranslations("Listing.wizard");
  const config = usePublicConfig();
  const apiMessage = useApiErrorMessage();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const started = useRef(false);

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
  return (
    <WizardProvider listing={state.listing} maxPhotos={config?.upload.maxPhotos ?? MAX_PHOTOS_INDIVIDUAL} mediaBaseUrl={config?.mediaBaseUrl ?? null}>
      <WizardScreens nonce={nonce} />
    </WizardProvider>
  );
}

function WizardScreens({ nonce }: { nonce?: string }) {
  const { listing, listingId, saveState, retrySave, maxPhotos, publishResult, setPublished, flush } = useWizard();
  const t = useTranslations("Listing");
  const locale = useLocale() as Locale;
  const pathname = usePathname();
  const router = useRouter();
  const stepLabel = useStepLabel();
  const [busy, setBusy] = useState(false);
  const parsed = parseWizardPath(pathname);
  const screen: WizardScreen | null = parsed.id === listingId ? parsed.screen : null;

  const navigate = useCallback(
    (next: WizardScreen, replace = false) => {
      const href = getPathname({ href: wizardPath(listingId, next), locale });
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

  // `/deposer/{id}`: resume where the draft stopped (a public listing opens on its review).
  useEffect(() => {
    if (screen !== null) return;
    navigate(listing.status === "draft" ? firstIncompleteStep(listing, { maxPhotos }) : "apercu", true);
  }, [screen, listing, maxPhotos, navigate]);

  const states = useMemo(() => Object.fromEntries(WIZARD_STEPS.map((step) => [step, stepState(step, listing, { maxPhotos })])) as Record<WizardStep, StepState>, [listing, maxPhotos]);
  const reachable = useCallback((step: WizardStep) => step === "categorie" || Boolean(listing.subcategoryId), [listing.subcategoryId]);

  const goTo = useCallback(
    (step: WizardStep) => {
      void flush();
      navigate(step);
    },
    [flush, navigate],
  );

  if (screen === null) return null;

  if (screen === "termine") {
    if (publishResult) return <DoneScreen status={publishResult.status} slugId={publishResult.slugId ?? listing.slugId} url={publishResult.url} listingId={listingId} />;
    if (listing.status !== "draft") return <DoneScreen status={listing.status} slugId={listing.slugId} listingId={listingId} />;
    navigate(firstIncompleteStep(listing, { maxPhotos }), true);
    return null;
  }

  const step = screen;
  const onNext = () => {
    const next = nextStep(step);
    if (next) navigate(next);
  };
  const previous = previousStep(step);
  const onBack = previous ? () => goTo(previous) : undefined;

  function onPublished(result: PublishListingResponse) {
    setPublished(result);
    navigate("termine");
  }

  function onSaved() {
    toast.success(t("done.savedTitle"));
    router.push("/mes-annonces");
  }

  const editable = listing.status === "draft" || listing.status === "rejected";

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
      onRetrySave={retrySave}
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
