"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { ChevronLeft, ChevronRight, Expand, ImageOff, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { blurhashPlaceholder, photoSources, type PhotoLike } from "./photo";

// Photos of the listing page (design §5): a scroll-snap track (swipe on phones, arrows and
// thumbnails on larger screens), a counter, and a full-screen lightbox on the `l` variants. Plain
// <img srcSet sizes width height> (design §8): the first photo is the LCP element (fetchpriority
// high, eager), the others load lazily. The blurhash placeholder is in the server HTML.

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

/** Index of the slide in view; scrollLeft is negative in right-to-left scrollers. */
function currentIndex(track: HTMLElement): number {
  const width = track.clientWidth || 1;
  return Math.round(Math.abs(track.scrollLeft) / width);
}

function scrollToIndex(track: HTMLElement | null, index: number, smooth: boolean): void {
  if (!track) return;
  const rtl = getComputedStyle(track).direction === "rtl";
  const left = index * track.clientWidth * (rtl ? -1 : 1);
  track.scrollTo({ left, behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto" });
}

/** Keeps `index` in sync with the scroll position of `track` (one update per frame). */
function useTrackIndex(track: RefObject<HTMLUListElement | null>, count: number, active = true): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const element = track.current;
    if (!element || !active) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setIndex(Math.min(count - 1, Math.max(0, currentIndex(element)))));
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", onScroll);
    };
  }, [track, count, active]);
  return index;
}

/** Arrow keys move one photo, Home/End jump; "next" follows the reading direction. */
function stepForKey(event: KeyboardEvent<HTMLElement>): number | "first" | "last" | null {
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
  if (event.key === "ArrowRight") return rtl ? -1 : 1;
  if (event.key === "ArrowLeft") return rtl ? 1 : -1;
  if (event.key === "Home") return "first";
  if (event.key === "End") return "last";
  return null;
}

export function Gallery({ listingId, title, photos, mediaBaseUrl, className }: GalleryProps) {
  const t = useTranslations("ListingPage.gallery");
  const track = useRef<HTMLUListElement>(null);
  const count = photos.length;
  const index = useTrackIndex(track, count);
  const [lightbox, setLightbox] = useState<number | null>(null);

  const go = useCallback((target: number) => scrollToIndex(track.current, Math.min(count - 1, Math.max(0, target)), true), [count]);

  if (count === 0 || !mediaBaseUrl) {
    return (
      <div data-testid="gallery" className={cn("flex aspect-[4/3] flex-col items-center justify-center gap-2 bg-surface-muted text-foreground-muted sm:rounded-lg", className)}>
        <ImageOff className="size-10" aria-hidden="true" strokeWidth={1.25} />
        <p className="text-sm">{t("empty")}</p>
      </div>
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const step = stepForKey(event);
    if (step === null) return;
    event.preventDefault();
    go(step === "first" ? 0 : step === "last" ? count - 1 : index + step);
  }

  return (
    <section data-testid="gallery" aria-roledescription={t("roledescription")} aria-label={t("label", { count })} className={cn("flex flex-col gap-3", className)}>
      <div className="relative">
        <ul
          ref={track}
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
                    alt={t("photoAlt", { title, index: position + 1, count })}
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
            <ArrowButton direction="previous" label={t("previous")} disabled={index === 0} onClick={() => go(index - 1)} className="start-3" />
            <ArrowButton direction="next" label={t("next")} disabled={index === count - 1} onClick={() => go(index + 1)} className="end-3" />
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
                  onClick={() => go(position)}
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
          setLightbox(null);
          scrollToIndex(track.current, last, false);
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
  listingId: string;
  title: string;
  photos: PhotoLike[];
  mediaBaseUrl: string;
}

function Lightbox({ open, start, onClose, listingId, title, photos, mediaBaseUrl }: LightboxProps) {
  const t = useTranslations("ListingPage.gallery");
  const track = useRef<HTMLUListElement>(null);
  const count = photos.length;
  const index = useTrackIndex(track, count, open);

  // The dialog content mounts in the commit that opens it: jump to the photo that was clicked.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => scrollToIndex(track.current, start, false));
    return () => cancelAnimationFrame(frame);
  }, [open, start]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const step = stepForKey(event);
    if (step === null) return;
    event.preventDefault();
    const target = step === "first" ? 0 : step === "last" ? count - 1 : index + step;
    scrollToIndex(track.current, Math.min(count - 1, Math.max(0, target)), true);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose(index);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/95 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          onKeyDown={onKeyDown}
          className="fixed inset-0 z-50 flex flex-col text-cream-100 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
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
            <ul ref={track} className="flex h-full snap-x snap-mandatory overflow-x-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                      alt={t("photoAlt", { title, index: position + 1, count })}
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
                <LightboxArrow direction="previous" label={t("previous")} disabled={index === 0} onClick={() => scrollToIndex(track.current, index - 1, true)} className="start-3" />
                <LightboxArrow direction="next" label={t("next")} disabled={index === count - 1} onClick={() => scrollToIndex(track.current, index + 1, true)} className="end-3" />
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
