"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronLeft, ChevronRight, Expand, ImageOff, RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { loadWithRetry } from "@/components/layout/chunk-retry";
import { Button } from "@/components/ui/button";
import { isolate } from "@/lib/i18n/bidi";
import { cn } from "@/lib/utils";
import { scrollToIndex, useTrackNavigation, useTrackIndex } from "./gallery-track";
import type { LightboxProps } from "./lightbox";
import { blurhashPlaceholder, photoSources, type PhotoLike } from "./photo";

export { clampIndex, stepForKey, targetIndex, type GalleryStep } from "./gallery-track";

// Photos of the listing page (design §5): a scroll-snap track (swipe on phones, arrows and
// thumbnails on larger screens), a counter, and a full-screen lightbox on the `l` variants. Plain
// <img srcSet sizes width height> (design §8): the first photo is the LCP element (fetchpriority
// high, eager), the others load lazily. The blurhash placeholder is in the server HTML.
// Each track is held in state (callback ref), not in a ref: the lightbox track only exists once the
// dialog's portal has mounted, a commit after `open` flips, and its scroll listener must follow it.
// The lightbox (dialog primitives) loads on the first open, warmed up when the visitor reaches for
// the photos: it is not part of the page's first JavaScript. When its chunk cannot be downloaded
// (dropped connection, tab opened before a redeploy) the download is tried again on that first open
// (chunk-retry.tsx); if it fails again the gallery stays as it is and asks for a reload.

const loadLightbox = () => import("./lightbox");

/** Stands in for the lightbox while its chunk cannot be downloaded: closes at once, under a reload prompt. */
export function LightboxUnavailable({ open, start, onClose }: LightboxProps) {
  const t = useTranslations("ListingPage.gallery");
  useEffect(() => {
    if (open) onClose(start);
  }, [open, start, onClose]);
  return (
    <div data-testid="lightbox-unavailable" className="flex flex-col items-start gap-2 px-4 sm:px-0">
      <InlineError>{t("unavailable")}</InlineError>
      <Button type="button" variant="outline" onClick={() => window.location.reload()}>
        <RotateCw aria-hidden="true" />
        {t("reload")}
      </Button>
    </div>
  );
}

export const loadLightboxView = loadWithRetry<LightboxProps>(() => loadLightbox().then((module) => module.Lightbox), LightboxUnavailable);

const Lightbox = dynamic(() => loadLightboxView(), { ssr: false });

/** Starts the lightbox download ahead of the click (pointer over or touching the photos, keyboard focus). */
function warmLightbox(): void {
  void loadLightbox().catch(() => undefined);
}

/** Width of the main column: full width on phones, ~44rem beside the aside (page grid). */
export const GALLERY_SIZES = "(min-width: 1280px) 46rem, (min-width: 1024px) 40rem, 100vw";

export interface GalleryProps {
  listingId: string;
  title: string;
  photos: PhotoLike[];
  mediaBaseUrl: string | null;
  className?: string;
}

export function Gallery({ listingId, title, photos, mediaBaseUrl, className }: GalleryProps) {
  const t = useTranslations("ListingPage.gallery");
  const [track, setTrack] = useState<HTMLUListElement | null>(null);
  const count = photos.length;
  const [index] = useTrackIndex(track, count);
  const { at, goTo, onKeyDown } = useTrackNavigation(track, index, count);
  const [lightbox, setLightbox] = useState<number | null>(null);
  // Mounted from the first open on, so its close animation and focus return keep working.
  const [lightboxMounted, setLightboxMounted] = useState(false);
  // Where the lightbox was closed: the track resumes there once the dialog has given focus back.
  const closedAt = useRef<number | null>(null);
  // The other photos mount once the page is idle after hydration: on a phone they no longer share
  // the first bytes with the first photo (the LCP element) and the page's JavaScript. Until then
  // their slide shows the blurhash and still opens the lightbox.
  const [restMounted, setRestMounted] = useState(false);
  useEffect(() => {
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(() => setRestMounted(true), { timeout: 2_000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(() => setRestMounted(true), 200);
    return () => window.clearTimeout(timer);
  }, []);

  if (count === 0 || !mediaBaseUrl) {
    return (
      <div data-testid="gallery" className={cn("flex aspect-[4/3] flex-col items-center justify-center gap-2 bg-surface-muted text-foreground-muted sm:rounded-lg", className)}>
        <ImageOff className="size-10" aria-hidden="true" strokeWidth={1.25} />
        <p className="text-sm">{t("empty")}</p>
      </div>
    );
  }

  return (
    <section data-testid="gallery" aria-roledescription={t("roledescription")} aria-label={t("label", { count })} className={cn("flex flex-col gap-3", className)}>
      <div className="relative">
        <ul
          ref={setTrack}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerEnter={warmLightbox}
          onTouchStart={warmLightbox}
          onFocus={warmLightbox}
          aria-label={t("trackLabel")}
          className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain bg-surface-muted [scrollbar-width:none] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:rounded-lg [&::-webkit-scrollbar]:hidden"
        >
          {photos.map((photo, position) => {
            const sources = photoSources(mediaBaseUrl, listingId, photo, "l");
            const placeholder = blurhashPlaceholder(photo.blurhash);
            if (!sources) return null;
            const first = position === 0;
            return (
              <li
                key={photo.id}
                className="relative aspect-[4/3] w-full shrink-0 snap-center snap-always overflow-hidden bg-cover bg-center"
                style={placeholder ? { backgroundImage: `url("${placeholder}")` } : undefined}
              >
                <button
                  type="button"
                  onClick={() => {
                    setLightboxMounted(true);
                    setLightbox(position);
                  }}
                  className="group absolute inset-0 flex cursor-zoom-in items-center justify-center bg-bab-950/10 outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {first || restMounted ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={sources.src}
                      srcSet={sources.srcSet}
                      sizes={GALLERY_SIZES}
                      width={sources.width}
                      height={sources.height}
                      alt={t("photoAlt", { title: isolate(title), index: position + 1, count })}
                      {...(first ? { fetchPriority: "high" as const, loading: "eager" as const } : { loading: "lazy" as const, decoding: "async" as const })}
                      className="size-full object-contain"
                    />
                  ) : null}
                  <span className="sr-only">{t("open")}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {count > 1 ? (
          <>
            <span aria-hidden="true" data-testid="gallery-counter" className="pointer-events-none absolute bottom-3 end-3 rounded-full bg-bab-950/75 px-3 py-1 text-sm font-medium text-cream-100 tabular-nums">
              {index + 1} / {count}
            </span>
            <ArrowButton direction="previous" label={t("previous")} disabled={index === 0} onClick={() => goTo(at() - 1)} className="start-3" />
            <ArrowButton direction="next" label={t("next")} disabled={index === count - 1} onClick={() => goTo(at() + 1)} className="end-3" />
          </>
        ) : null}
        <span aria-hidden="true" className="pointer-events-none absolute top-3 end-3 hidden size-9 items-center justify-center rounded-full bg-bab-950/60 text-cream-100 sm:flex">
          <Expand className="size-4" />
        </span>
      </div>

      {count > 1 ? (
        <ul aria-label={t("thumbnails")} className="hidden gap-2 overflow-x-auto pb-1 sm:flex">
          {photos.map((photo, position) => {
            const sources = photoSources(mediaBaseUrl, listingId, photo, "s");
            if (!sources) return null;
            const current = position === index;
            return (
              <li key={photo.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => goTo(position)}
                  aria-current={current ? "true" : undefined}
                  aria-label={t("show", { index: position + 1, count })}
                  className={cn(
                    "relative block h-14 w-[4.5rem] overflow-hidden rounded-md bg-surface-muted outline-none transition-opacity duration-150 focus-visible:ring-3 focus-visible:ring-ring",
                    current ? "ring-2 ring-primary" : "opacity-70 hover:opacity-100",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={sources.src} width={sources.width} height={sources.height} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {lightboxMounted ? (
        <Lightbox
          open={lightbox !== null}
          start={lightbox ?? 0}
          onClose={(last) => {
            closedAt.current = last;
            setLightbox(null);
          }}
          onCloseAutoFocus={(event) => {
            // The dialog would focus the photo that opened it, scrolling the track back to it: show the
            // photo the visitor closed on instead, and give its button the focus without scrolling.
            const last = closedAt.current;
            closedAt.current = null;
            if (last === null || !track) return;
            event.preventDefault();
            scrollToIndex(track, last, false);
            track.children[last]?.querySelector("button")?.focus({ preventScroll: true });
          }}
          listingId={listingId}
          title={title}
          photos={photos}
          mediaBaseUrl={mediaBaseUrl}
        />
      ) : null}
    </section>
  );
}

function ArrowButton({ direction, label, disabled, onClick, className }: { direction: "previous" | "next"; label: string; disabled: boolean; onClick: () => void; className?: string }) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "absolute top-1/2 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-surface/90 text-foreground shadow-lg shadow-bab-950/15 transition-opacity duration-150 hover:bg-surface focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-0 sm:flex",
        className,
      )}
    >
      <Icon className="size-5 rtl:-scale-x-100" aria-hidden="true" />
    </button>
  );
}

