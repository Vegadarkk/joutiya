"use client";

import type { FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { useWizard } from "@/lib/listings/client/store";
import { PhotoUploader } from "../photo-uploader";
import { useValidationMessage } from "../field-messages";
import { STEP_FORM_ID } from "../wizard-shell";

export function PhotosStep({ onNext }: { onNext: () => void }) {
  const { photos, maxPhotos, addFiles, removePhoto, retryPhoto, refreshPhoto, movePhoto, blockers, saveMode } = useWizard();
  const t = useTranslations("Listing.photos");
  const message = useValidationMessage();
  const blocker = blockers.find((issue) => issue.path.startsWith("photos"));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    onNext();
  }

  return (
    <form id={STEP_FORM_ID} onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <p className="text-sm text-foreground-muted">{t("hint", { max: maxPhotos })}</p>
      {blocker ? <ErrorBanner title={blocker.message && blocker.code === "unknown" ? blocker.message : message(blocker.code, { max: maxPhotos })} /> : null}
      <PhotoUploader photos={photos} maxPhotos={maxPhotos} onAdd={addFiles} onRemove={removePhoto} onRetry={retryPhoto} onRefresh={refreshPhoto} onMove={movePhoto} keepOne={saveMode === "manual"} />
    </form>
  );
}
