"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// Horizontal row of cards that scrolls (swipe, trackpad, keyboard focus) with previous / next
// buttons from lg. RTL: "next" moves toward the inline end, i.e. to the left (scrollLeft goes
// negative in right-to-left boxes).

interface ScrollRowProps {
  children: ReactNode;
  previousLabel: string;
  nextLabel: string;
  className?: string;
}

const EDGE = 4;

export function ScrollRow({ children, previousLabel, nextLabel, className }: ScrollRowProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const offset = Math.abs(element.scrollLeft);
    setEdges({ start: offset <= EDGE, end: offset + element.clientWidth >= element.scrollWidth - EDGE });
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);

  function scroll(direction: 1 | -1) {
    const element = viewport.current;
    if (!element) return;
    const rtl = getComputedStyle(element).direction === "rtl";
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollBy({ left: direction * (rtl ? -1 : 1) * element.clientWidth * 0.9, behavior: reduce ? "auto" : "smooth" });
  }

  const button = "absolute top-[30%] z-10 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface text-foreground shadow-md shadow-bab-950/10 transition-opacity duration-150 ease-door hover:bg-surface-muted disabled:pointer-events-none disabled:opacity-0 lg:flex";

  return (
    <div className={cn("relative", className)}>
      <div ref={viewport} className="-mx-4 snap-x snap-mandatory overflow-x-auto scroll-px-4 px-4 pb-2 [scrollbar-width:none] sm:-mx-6 sm:scroll-px-6 sm:px-6 lg:mx-0 lg:scroll-px-0 lg:px-0 [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
      <button type="button" aria-label={previousLabel} disabled={edges.start} onClick={() => scroll(-1)} className={cn(button, "-start-5")}>
        <ChevronLeft className="size-5 rtl:-scale-x-100" aria-hidden="true" />
      </button>
      <button type="button" aria-label={nextLabel} disabled={edges.end} onClick={() => scroll(1)} className={cn(button, "-end-5")}>
        <ChevronRight className="size-5 rtl:-scale-x-100" aria-hidden="true" />
      </button>
    </div>
  );
}
