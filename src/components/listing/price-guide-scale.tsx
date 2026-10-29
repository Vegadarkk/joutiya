import type { PriceGuideView } from "@/lib/price-guide/view";

// Markup of the « Prix repère » (Carte vivante lot 5), from a PriceGuideView worked out on the
// server: the scale of the comparable prices (outliers dropped), the typical range (P25-P75) as a
// deeper band, the listing's price as a marker, how many listings and where. Joutiya is a neutral
// host: it positions the price, it never says "bon prix" or "trop cher". The scale follows the
// reading direction (low price on the right in Arabic). No hook: the listing page renders it on
// the server, the map's detail panel in the browser.

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;

export function PriceGuideScale({ view, titleId, className }: { view: PriceGuideView; titleId: string; className?: string }) {
  return (
    <section aria-labelledby={titleId} data-testid="price-guide" data-scope={view.scope} className={className}>
      <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface px-3.5 pt-3 pb-3.5">
        <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span id={titleId} className="text-sm font-semibold">
            {view.title}
          </span>
          <span className="text-xs text-foreground-muted" data-testid="price-guide-count">
            {view.count}
          </span>
        </p>
        <div className="relative h-5" aria-hidden="true">
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-bab-100 dark:bg-bab-800" />
          <div
            className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-bab-300 dark:bg-bab-400"
            style={{ insetInlineStart: percent(view.bandStart), width: percent(Math.max(0.02, view.bandEnd - view.bandStart)) }}
          />
          <div
            data-testid="price-guide-marker"
            className="absolute top-1/2 size-4 -translate-y-1/2 rounded-full border-2 border-surface bg-primary shadow-[0_1px_3px_rgb(11_30_31/0.35)] ltr:-translate-x-1/2 rtl:translate-x-1/2"
            style={{ insetInlineStart: percent(view.marker) }}
          />
        </div>
        <p className="flex items-baseline justify-between gap-2 text-xs text-foreground-muted tabular-nums">
          <span>{view.low}</span>
          <span className="font-medium text-foreground" data-testid="price-guide-range">
            {view.range}
          </span>
          <span>{view.high}</span>
        </p>
        <p className="sr-only">{view.position}</p>
      </div>
      <p className="mt-1.5 text-xs text-foreground-muted text-pretty">{view.notice}</p>
    </section>
  );
}
