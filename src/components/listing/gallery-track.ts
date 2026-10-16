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

export interface TrackNavigator {
  /** The photo the next step counts from: where a scroll started by `goTo` is heading, else the one in view. */
  at(track: HTMLElement | null, count: number, fallback: number): number;
  /** Smooth scroll to a photo (instant with reduced motion). */
  goTo(track: HTMLElement | null, target: number, count: number): void;
  /** Scroll listener: once the running scroll is past halfway to its photo, the position tells it again. */
  onScroll(track: HTMLElement, count: number): void;
  /** `scrollend`: a track resting on a photo is done scrolling (a scroll cut short by the next one is not). */
  onScrollEnd(track: HTMLElement): void;
  /** The visitor took over (touch, drag, wheel): back to the scroll position. */
  settle(): void;
}

/** Whether the track rests on a photo, not between two (scroll-snap ends every finished scroll on one). */
function atRest(track: HTMLElement): boolean {
  const position = Math.abs(track.scrollLeft) / (track.clientWidth || 1);
  return Math.abs(position - Math.round(position)) < 0.02;
}

/**
 * Keeps the target of a smooth scroll until the track gets there. Read from the position alone, a
 * second press made before the first scroll is halfway would aim at the same photo again: two quick
 * presses must move two photos.
 */
export function createTrackNavigator(): TrackNavigator {
  let pending: number | null = null;
  return {
    at: (track, count, fallback) => pending ?? (track ? currentIndex(track, count) : fallback),
    goTo(track, target, count) {
      const next = clampIndex(target, count);
      scrollToIndex(track, next, true);
      // Read after the call: an instant scroll (reduced motion) or no move at all is already there.
      pending = track && currentIndex(track, count) !== next ? next : null;
    },
    onScroll(track, count) {
      if (pending !== null && currentIndex(track, count) === pending) pending = null;
    },
    onScrollEnd(track) {
      if (atRest(track)) pending = null;
    },
    settle() {
      pending = null;
    },
  };
}

/** The visitor's own gestures on the track: whatever they do, the scroll position is the truth again. */
const SETTLE_EVENTS = ["pointerdown", "touchstart", "wheel"] as const;

/**
 * Keyboard and button navigation of one track. The photo in view is read from the scroll position
 * at the time of the action, so it is right even before the first scroll event, or from the target
 * of a scroll still running (createTrackNavigator).
 */
export function useTrackNavigation(track: HTMLUListElement | null, index: number, count: number) {
  const [navigator] = useState(createTrackNavigator);
  useEffect(() => {
    if (!track) return;
    const onScroll = () => navigator.onScroll(track, count);
    const onScrollEnd = () => navigator.onScrollEnd(track);
    const settle = () => navigator.settle();
    track.addEventListener("scroll", onScroll, { passive: true });
    track.addEventListener("scrollend", onScrollEnd);
    for (const type of SETTLE_EVENTS) track.addEventListener(type, settle, { passive: true });
    return () => {
      track.removeEventListener("scroll", onScroll);
      track.removeEventListener("scrollend", onScrollEnd);
      for (const type of SETTLE_EVENTS) track.removeEventListener(type, settle);
      navigator.settle();
    };
  }, [navigator, track, count]);
  const at = () => navigator.at(track, count, index);
  const goTo = (target: number) => navigator.goTo(track, target, count);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = stepForKey(event.key, getComputedStyle(event.currentTarget).direction === "rtl");
    if (step === null) return;
    event.preventDefault();
    goTo(targetIndex(step, at(), count));
  };
  return { at, goTo, onKeyDown };
}
