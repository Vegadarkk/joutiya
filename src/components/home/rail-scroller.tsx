"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Drag, wheel and arrows for a scrolling row on mouse and trackpad screens (the home map's category
// rail): a pointer cannot swipe, and the row hides its scrollbar. Touch screens keep the swipe alone.

export interface RailScrollerProps {
  children: ReactNode;
  /** Accessible names of the two arrows. */
  previous: string;
  next: string;
  className?: string;
}

const ARROW =
  "absolute top-[1.125rem] z-10 inline-flex size-8 items-center justify-center rounded-full border border-border-strong bg-surface text-foreground shadow-sm transition-colors duration-150 ease-door hover:bg-surface-muted pointer-coarse:hidden";

export function RailScroller({ children, previous, next, className }: RailScrollerProps) {
  const root = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  useEffect(() => {
    const row = root.current?.querySelector("ul");
    if (!row) return;
    const update = () => {
      // scrollLeft runs negative in a right-to-left row: its size is still the distance from the start.
      const travelled = Math.abs(row.scrollLeft);
      const room = row.scrollWidth - row.clientWidth;
      setEdges({ start: travelled <= 1, end: travelled >= room - 1 });
    };
    // A mouse wheel turns vertically: over the row it scrolls the row sideways, and once the row is at
    // its end the wheel scrolls the panel again. Trackpads already send sideways deltas.
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const room = row.scrollWidth - row.clientWidth;
      const travelled = Math.abs(row.scrollLeft);
      const forward = event.deltaY > 0;
      if (room <= 1 || (forward && travelled >= room - 1) || (!forward && travelled <= 1)) return;
      event.preventDefault();
      const rtl = getComputedStyle(row).direction === "rtl";
      const step = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      row.scrollBy({ left: rtl ? -step : step });
    };
    // Click and hold drags the row like a swipe. The mouse press is cancelled, or the browser starts
    // a native link drag (or a text selection) that cancels the pointer; the click still fires. Past a
    // few pixels it is a drag, not a click: the release must not open the card under the pointer, and
    // snapping waits for the release.
    let drag: { x: number; left: number; moved: boolean } | null = null;
    let swallow = false;
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      drag = { x: event.clientX, left: row.scrollLeft, moved: false };
    };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      if (!drag.moved) {
        if (Math.abs(dx) < 5) return;
        drag.moved = true;
        row.setPointerCapture(event.pointerId);
        row.style.scrollSnapType = "none";
        row.style.cursor = "grabbing";
      }
      row.scrollLeft = drag.left - dx;
    };
    const up = () => {
      if (!drag) return;
      swallow = drag.moved;
      drag = null;
      row.style.scrollSnapType = "";
      row.style.cursor = "";
      setTimeout(() => (swallow = false));
    };
    const click = (event: MouseEvent) => {
      if (!swallow) return;
      event.preventDefault();
      event.stopPropagation();
      swallow = false;
    };
    const press = (event: MouseEvent) => {
      if (event.button === 0) event.preventDefault();
    };
    update();
    row.addEventListener("scroll", update, { passive: true });
    row.addEventListener("wheel", wheel, { passive: false });
    row.addEventListener("pointerdown", down);
    row.addEventListener("pointermove", move);
    row.addEventListener("pointerup", up);
    row.addEventListener("pointercancel", up);
    row.addEventListener("click", click, true);
    row.addEventListener("mousedown", press);
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
      row.removeEventListener("wheel", wheel);
      row.removeEventListener("pointerdown", down);
      row.removeEventListener("pointermove", move);
      row.removeEventListener("pointerup", up);
      row.removeEventListener("pointercancel", up);
      row.removeEventListener("click", click, true);
      row.removeEventListener("mousedown", press);
      observer.disconnect();
    };
  }, []);

  function scroll(direction: 1 | -1) {
    const row = root.current?.querySelector("ul");
    if (!row) return;
    const rtl = getComputedStyle(row).direction === "rtl";
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollBy({ left: direction * (rtl ? -1 : 1) * row.clientWidth * 0.75, behavior: smooth ? "smooth" : "auto" });
  }

  return (
    <div ref={root} data-testid="rail-scroller" className={cn("relative pointer-fine:[&>ul]:cursor-grab", className)}>
      {children}
      {edges.start ? null : (
        <button type="button" onClick={() => scroll(-1)} aria-label={previous} data-testid="rail-previous" className={cn(ARROW, "start-0")}>
          <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
        </button>
      )}
      {edges.end ? null : (
        <button type="button" onClick={() => scroll(1)} aria-label={next} data-testid="rail-next" className={cn(ARROW, "end-0")}>
          <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
