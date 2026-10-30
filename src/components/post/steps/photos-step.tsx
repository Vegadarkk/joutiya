"use client";

import type { FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { subcategoryById } from "@/config/categories";
import { photoUrl } from "@/lib/listings/client/photo-url";
import { useWizard, type PhotoItem } from "@/lib/listings/client/store";
import { PhotoUploader } from "../photo-uploader";
import { useValidationMessage } from "../field-messages";
import { STEP_FORM_ID } from "../wizard-shell";

export function PhotosStep({ onNext }: { onNext: () => void }) {
  const { listing, photos, maxPhotos, addFiles, cropPhoto, removePhoto, retryPhoto, refreshPhoto, movePhoto, blockers, saveMode, mediaBaseUrl, listingId } = useWizard();
  const t = useTranslations("Listing.photos");
  // Job ads publish without a photo (a logo is welcome): no warning, the last one may go.
  const optional = Boolean(listing.subcategoryId && subcategoryById(listing.subcategoryId)?.photosOptional);
  const message = useValidationMessage();
  const blocker = blockers.find((issue) => issue.path.startsWith("photos"));

  const largeUrlOf = (item: PhotoItem) => (item.uploadId ? photoUrl(mediaBaseUrl, listingId, item.uploadId, "l") : null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    onNext();
  }

  return (
    <form id={STEP_FORM_ID} onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <p className="text-sm text-foreground-muted">{t("hint", { max: maxPhotos })}</p>
      {blocker ? <ErrorBanner title={blocker.message && blocker.code === "unknown" ? blocker.message : message(blocker.code, { max: maxPhotos })} /> : null}
      <PhotoUploader
        photos={photos}
        maxPhotos={maxPhotos}
        onAdd={addFiles}
        onRemove={removePhoto}
        onRetry={retryPhoto}
        onRefresh={refreshPhoto}
        onMove={movePhoto}
        keepOne={saveMode === "manual" && !optional}
        optional={optional}
        onCrop={cropPhoto}
        largeUrlOf={largeUrlOf}
      />
    </form>
  );
}
