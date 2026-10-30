"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Drag, wheel and arrows for a scrolling row on mouse and trackpad screens (the home map's category
// rail, the header's category row): a pointer cannot swipe, and the row hides its scrollbar. Touch
// screens keep the swipe alone. The arrows float over the ends of the row (the rail) or stand after
// it at the end of the line, with the row's fixed end group (the category row: owner's report of
// 30 Oct 2026, the categories past the fade were out of reach on a desktop).

export interface RailScrollerProps {
  children: ReactNode;
  /** Accessible names of the two arrows. */
  previous: string;
  next: string;
  className?: string;
  /**
   * "overlay" (default): an arrow floats over each end of the row that has more to show. "trailing":
   * the two arrows stand after the row, each disabled at its edge, gone when the whole row fits,
   * and `trailing` renders after them.
   */
  arrows?: "overlay" | "trailing";
  /** The trailing layout's fixed end group, after the arrows. */
  trailing?: ReactNode;
  /** Display classes of the trailing arrows' box: which screens show it. */
  arrowsClassName?: string;
  /**
   * A vertical wheel over the row scrolls it sideways (default). Off for a row of a page that scrolls
   * under the pointer: the wheel keeps scrolling the page.
   */
  wheel?: boolean;
}

const ARROW = "inline-flex items-center justify-center rounded-full border border-border-strong bg-surface text-foreground shadow-sm transition-colors duration-150 ease-door hover:bg-surface-muted";
const OVERLAY_ARROW = cn(ARROW, "absolute top-[1.125rem] z-10 size-8 pointer-coarse:hidden");
const TRAILING_ARROW = cn(ARROW, "size-9 disabled:opacity-40 disabled:hover:bg-surface");

export function RailScroller({ children, previous, next, className, arrows = "overlay", trailing, arrowsClassName, wheel = true }: RailScrollerProps) {
  const root = useRef<HTMLDivElement>(null);
  // Until the first measure, the trailing layout takes the row for longer than its line (the usual
  // case): its arrows are in the server markup and the end group does not shift when they appear.
  const [edges, setEdges] = useState({ start: true, end: arrows !== "trailing" });

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
    const onWheel = (event: WheelEvent) => {
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
    if (wheel) row.addEventListener("wheel", onWheel, { passive: false });
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
      row.removeEventListener("wheel", onWheel);
      row.removeEventListener("pointerdown", down);
      row.removeEventListener("pointermove", move);
      row.removeEventListener("pointerup", up);
      row.removeEventListener("pointercancel", up);
      row.removeEventListener("click", click, true);
      row.removeEventListener("mousedown", press);
      observer.disconnect();
    };
  }, [wheel]);

  function scroll(direction: 1 | -1) {
    const row = root.current?.querySelector("ul");
    if (!row) return;
    const rtl = getComputedStyle(row).direction === "rtl";
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollBy({ left: direction * (rtl ? -1 : 1) * row.clientWidth * 0.75, behavior: smooth ? "smooth" : "auto" });
  }

  if (arrows === "trailing") {
    return (
      <div ref={root} data-testid="rail-scroller" className={cn("flex items-start pointer-fine:[&>ul]:cursor-grab", className)}>
        {children}
        {edges.start && edges.end ? null : (
          <div data-testid="rail-arrows" className={cn("h-11 shrink-0 items-center gap-1", arrowsClassName)}>
            <button type="button" onClick={() => scroll(-1)} aria-label={previous} disabled={edges.start} data-testid="rail-previous" className={TRAILING_ARROW}>
              <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => scroll(1)} aria-label={next} disabled={edges.end} data-testid="rail-next" className={TRAILING_ARROW}>
              <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            </button>
          </div>
        )}
        {trailing}
      </div>
    );
  }
  return (
    <div ref={root} data-testid="rail-scroller" className={cn("relative pointer-fine:[&>ul]:cursor-grab", className)}>
      {children}
      {edges.start ? null : (
        <button type="button" onClick={() => scroll(-1)} aria-label={previous} data-testid="rail-previous" className={cn(OVERLAY_ARROW, "start-0")}>
          <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
        </button>
      )}
      {edges.end ? null : (
        <button type="button" onClick={() => scroll(1)} aria-label={next} data-testid="rail-next" className={cn(OVERLAY_ARROW, "end-0")}>
          <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
