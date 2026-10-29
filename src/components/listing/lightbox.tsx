"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useTranslations } from "next-intl";
import { isolate } from "@/lib/i18n/bidi";
import { cn } from "@/lib/utils";
import { clampIndex, scrollToIndex, useTrackNavigation, useTrackIndex } from "./gallery-track";
import { photoSources, type PhotoLike } from "./photo";

// Full-screen view of the listing photos on the `l` variants (design §5). Loaded by the gallery on
// the first open (next/dynamic): the dialog primitives are not part of the page's first JavaScript.

export interface LightboxProps {
  open: boolean;
  start: number;
  onClose: (lastIndex: number) => void;
  onCloseAutoFocus: (event: Event) => void;
  listingId: string;
  title: string;
  photos: PhotoLike[];
  mediaBaseUrl: string;
}

export function Lightbox({ open, start, onClose, onCloseAutoFocus, listingId, title, photos, mediaBaseUrl }: LightboxProps) {
  const t = useTranslations("ListingPage.gallery");
  // Set by the portal once the dialog content is in the DOM, cleared when it closes.
  const [track, setTrack] = useState<HTMLUListElement | null>(null);
  const count = photos.length;
  const [index, setIndex] = useTrackIndex(track, count);
  const { at, goTo, onKeyDown } = useTrackNavigation(track, index, count);

  // The track has just mounted: show the photo that was clicked (no scroll event when it is the first).
  useEffect(() => {
    if (!track) return;
    setIndex(clampIndex(start, count));
    scrollToIndex(track, start, false);
  }, [track, start, count, setIndex]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose(at());
      }}
    >
      <Dialog.Portal>
        {/* Opaque: at 95 % the page's header and price showed through the photo (UX audit). */}
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          onKeyDown={onKeyDown}
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed inset-0 z-50 flex flex-col text-cream-100 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <Dialog.Title className="sr-only" dir="auto">
            {title}
          </Dialog.Title>
          <Dialog.Description className="sr-only">{t("lightboxHint")}</Dialog.Description>
          <div className="flex h-16 shrink-0 items-center justify-between gap-4 px-4">
            <span className="text-sm font-medium tabular-nums" aria-live="polite">
              {t("position", { index: index + 1, count })}
            </span>
            <Dialog.Close asChild>
              <button type="button" aria-label={t("close")} className="flex size-11 items-center justify-center rounded-full bg-cream-100/10 transition-[background-color,scale] duration-150 ease-door hover:bg-cream-100/20 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-gold-300">
                <X className="size-5" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>
          <div className="relative min-h-0 flex-1">
            <ul
              ref={setTrack}
              tabIndex={0}
              aria-label={t("trackLabel")}
              className="flex h-full snap-x snap-mandatory overflow-x-auto overscroll-contain [scrollbar-width:none] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gold-300 [&::-webkit-scrollbar]:hidden"
            >
              {photos.map((photo, position) => {
                const sources = photoSources(mediaBaseUrl, listingId, photo, "l");
                if (!sources) return null;
                return (
                  <li key={photo.id} className="flex h-full w-full shrink-0 snap-center snap-always items-center justify-center pb-4 sm:px-16">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={sources.large}
                      width={sources.width}
                      height={sources.height}
                      alt={t("photoAlt", { title: isolate(title), index: position + 1, count })}
                      loading={position === start ? "eager" : "lazy"}
                      decoding="async"
                      className="max-h-full max-w-full object-contain"
                    />
                  </li>
                );
              })}
            </ul>
            {count > 1 ? (
              <>
                <LightboxArrow direction="previous" label={t("previous")} disabled={index === 0} onClick={() => goTo(at() - 1)} className="start-3" />
                <LightboxArrow direction="next" label={t("next")} disabled={index === count - 1} onClick={() => goTo(at() + 1)} className="end-3" />
              </>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function LightboxArrow({ direction, label, disabled, onClick, className }: { direction: "previous" | "next"; label: string; disabled: boolean; onClick: () => void; className?: string }) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "absolute top-1/2 hidden size-12 -translate-y-1/2 items-center justify-center rounded-full bg-cream-100/10 transition-[background-color,opacity,scale] duration-150 ease-door hover:bg-cream-100/20 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-gold-300 disabled:pointer-events-none disabled:opacity-0 sm:flex",
        className,
      )}
    >
      <Icon className="size-6 rtl:-scale-x-100" aria-hidden="true" />
    </button>
  );
}
