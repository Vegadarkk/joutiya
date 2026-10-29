"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Arrows for a scrolling row on mouse and trackpad screens (the home map's category rail): a
// pointer cannot swipe, and the row hides its scrollbar. Touch screens keep the swipe alone.

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
    update();
    row.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
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
    <div ref={root} data-testid="rail-scroller" className={cn("relative", className)}>
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
