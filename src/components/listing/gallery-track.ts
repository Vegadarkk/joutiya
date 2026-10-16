import { useEffect, useState, type KeyboardEvent } from "react";

// Scroll-snap tracks of the listing gallery and its lightbox: the slide in view, keyboard and button
// navigation. Shared by gallery.tsx and lightbox.tsx (loaded on the first open).

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** `index` kept inside [0, count - 1]. */
export function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(0, count - 1), Math.max(0, index));
}

/** Index of the slide in view; scrollLeft is negative in right-to-left scrollers. */
export function currentIndex(track: HTMLElement, count: number): number {
  const width = track.clientWidth || 1;
  return clampIndex(Math.round(Math.abs(track.scrollLeft) / width), count);
}

export function scrollToIndex(track: HTMLElement | null, index: number, smooth: boolean): void {
  if (!track) return;
  const rtl = getComputedStyle(track).direction === "rtl";
  const left = index * track.clientWidth * (rtl ? -1 : 1);
  track.scrollTo({ left, behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto" });
}

/**
 * The slide in view of `track` (one update per frame while it scrolls). The listener follows the
 * element: attached when it mounts, removed when it unmounts.
 */
export function useTrackIndex(track: HTMLUListElement | null, count: number): [number, (index: number) => void] {
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
export function trackNavigation(track: HTMLUListElement | null, index: number, count: number) {
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
