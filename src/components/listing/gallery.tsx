"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Expand, ImageOff, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useTranslations } from "next-intl";
import { isolate } from "@/lib/i18n/bidi";
import { cn } from "@/lib/utils";
import { blurhashPlaceholder, photoSources, type PhotoLike } from "./photo";

// Photos of the listing page (design §5): a scroll-snap track (swipe on phones, arrows and
// thumbnails on larger screens), a counter, and a full-screen lightbox on the `l` variants. Plain
// <img srcSet sizes width height> (design §8): the first photo is the LCP element (fetchpriority
// high, eager), the others load lazily. The blurhash placeholder is in the server HTML.
// Each track is held in state (callback ref), not in a ref: the lightbox track only exists once the
// dialog's portal has mounted, a commit after `open` flips, and its scroll listener must follow it.

/** Width of the main column: full width on phones, ~44rem beside the aside (page grid). */
export const GALLERY_SIZES = "(min-width: 1280px) 46rem, (min-width: 1024px) 40rem, 100vw";

export interface GalleryProps {
  listingId: string;
  title: string;
  photos: PhotoLike[];
  mediaBaseUrl: string | null;
  className?: string;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** `index` kept inside [0, count - 1]. */
export function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(0, count - 1), Math.max(0, index));
}

/** Index of the slide in view; scrollLeft is negative in right-to-left scrollers. */
function currentIndex(track: HTMLElement, count: number): number {
  const width = track.clientWidth || 1;
  return clampIndex(Math.round(Math.abs(track.scrollLeft) / width), count);
}

function scrollToIndex(track: HTMLElement | null, index: number, smooth: boolean): void {
  if (!track) return;
  const rtl = getComputedStyle(track).direction === "rtl";
  const left = index * track.clientWidth * (rtl ? -1 : 1);
  track.scrollTo({ left, behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto" });
}

/**
 * The slide in view of `track` (one update per frame while it scrolls). The listener follows the
 * element: attached when it mounts, removed when it unmounts.
 */
function useTrackIndex(track: HTMLUListElement | null, count: number): [number, (index: number) => void] {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!track) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setIndex(currentIndex(track, count)));
    };
    track.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      track.removeEventListener("scroll", onScroll);
    };
  }, [track, count]);
  return [index, setIndex];
}

export type GalleryStep = number | "first" | "last";

/** Arrow keys move one photo, Home/End jump; "next" follows the reading direction (mirrored in RTL). */
export function stepForKey(key: string, rtl: boolean): GalleryStep | null {
  if (key === "ArrowRight") return rtl ? -1 : 1;
  if (key === "ArrowLeft") return rtl ? 1 : -1;
  if (key === "Home") return "first";
  if (key === "End") return "last";
  return null;
}

/** The photo a step leads to from `from`, inside the track. */
export function targetIndex(step: GalleryStep, from: number, count: number): number {
  return clampIndex(step === "first" ? 0 : step === "last" ? count - 1 : from + step, count);
}

/**
 * Keyboard and button navigation of one track. The photo in view is read from the scroll position
 * at the time of the action, so it is right even before the first scroll event.
 */
function trackNavigation(track: HTMLUListElement | null, index: number, count: number) {
  const at = () => (track ? currentIndex(track, count) : index);
  const goTo = (target: number) => scrollToIndex(track, clampIndex(target, count), true);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = stepForKey(event.key, getComputedStyle(event.currentTarget).direction === "rtl");
    if (step === null) return;
    event.preventDefault();
    goTo(targetIndex(step, at(), count));
  };
  return { at, goTo, onKeyDown };
}

export function Gallery({ listingId, title, photos, mediaBaseUrl, className }: GalleryProps) {
  const t = useTranslations("ListingPage.gallery");
  const [track, setTrack] = useState<HTMLUListElement | null>(null);
  const count = photos.length;
  const [index] = useTrackIndex(track, count);
  const { at, goTo, onKeyDown } = trackNavigation(track, index, count);
  const [lightbox, setLightbox] = useState<number | null>(null);
  // Where the lightbox was closed: the track resumes there once the dialog has given focus back.
  const closedAt = useRef<number | null>(null);

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
                  onClick={() => setLightbox(position)}
                  className="group absolute inset-0 flex cursor-zoom-in items-center justify-center bg-bab-950/10 outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
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

interface LightboxProps {
  open: boolean;
  start: number;
  onClose: (lastIndex: number) => void;
  onCloseAutoFocus: (event: Event) => void;
  listingId: string;
  title: string;
  photos: PhotoLike[];
  mediaBaseUrl: string;
}

function Lightbox({ open, start, onClose, onCloseAutoFocus, listingId, title, photos, mediaBaseUrl }: LightboxProps) {
  const t = useTranslations("ListingPage.gallery");
  // Set by the portal once the dialog content is in the DOM, cleared when it closes.
  const [track, setTrack] = useState<HTMLUListElement | null>(null);
  const count = photos.length;
  const [index, setIndex] = useTrackIndex(track, count);
  const { at, goTo, onKeyDown } = trackNavigation(track, index, count);

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
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/95 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
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
              <button type="button" aria-label={t("close")} className="flex size-11 items-center justify-center rounded-full bg-cream-100/10 hover:bg-cream-100/20 focus-visible:outline-2 focus-visible:outline-gold-300">
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
                  <li key={photo.id} className="flex h-full w-full shrink-0 snap-center snap-always items-center justify-center px-2 pb-4 sm:px-16">
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
        "absolute top-1/2 hidden size-12 -translate-y-1/2 items-center justify-center rounded-full bg-cream-100/10 hover:bg-cream-100/20 focus-visible:outline-2 focus-visible:outline-gold-300 disabled:pointer-events-none disabled:opacity-0 sm:flex",
        className,
      )}
    >
      <Icon className="size-6 rtl:-scale-x-100" aria-hidden="true" />
    </button>
  );
}
