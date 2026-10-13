import { cn } from "@/lib/utils";

/** Brand logo v3-2 (public/brand): light and dark files swap with the theme. */
export function Logo({ className, label }: { className?: string; label: string }) {
  return (
    <span className={cn("relative inline-flex", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- static SVG, no optimization needed */}
      <img src="/brand/joutiya-logo.svg" alt={label} width={392} height={155} className="h-full w-auto dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/joutiya-logo-dark.svg" alt={label} width={392} height={155} className="hidden h-full w-auto dark:block" />
    </span>
  );
}
