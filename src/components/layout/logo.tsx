import { cn } from "@/lib/utils";

/**
 * Brand logo (public/brand): door v3-2 with the Aalan wordmark, option C (owner, 2026-10-29).
 * The light and dark files swap with the theme. The light one, shown by default, loads eagerly and
 * first (a lazy logo arrived about a second after the first paint of a cold visit: a blank box in
 * the header). The dark one stays lazy: the browser never fetches a lazy image hidden by
 * `display: none`, so a light page downloads one logo, a dark page both (17 KB, cached). The
 * width and height are each file's own: the box keeps its size until the image arrives.
 */
export function Logo({ className, label }: { className?: string; label: string }) {
  return (
    <span className={cn("relative inline-flex", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- static SVG, no optimization needed */}
      <img src="/brand/aalan-logo.svg" alt={label} width={396} height={211} fetchPriority="high" decoding="async" className="h-full w-auto dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/aalan-logo-dark.svg" alt={label} width={340} height={155} loading="lazy" decoding="async" className="hidden h-full w-auto dark:block" />
    </span>
  );
}
