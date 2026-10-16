import { useTranslations } from "next-intl";
import { approximatePosition, cityBySlug, cityName, regionByCode, regionName } from "@/config/regions";
import type { Locale } from "@/config/site";
import { formatNumber } from "@/lib/map/projection";
import { regionsSvg, SVG_DECIMALS } from "@/lib/map/regions-paths";
import { cn } from "@/lib/utils";

// Static map of the listing page (D10): a Server Component, SSR only, no script. The 12 regions are
// drawn from our GeoJSON through the Web-Mercator projection of MOROCCO_BBOX; the listing's region is
// highlighted and an approximate-area marker (not a pin) sits at approximatePosition(city, seed), so the
// output is deterministic for the same props (visual-regression target). Colours come from the design
// tokens through classes only (hash CSP: no inline style, no script).

export interface StaticRegionsMapProps {
  /** Slug of the listing's city (src/config/regions.ts). */
  citySlug: string;
  /** Seed of the deterministic offset: the listing id. */
  seed: string;
  locale: Locale;
  /** Defaults to the city's region. */
  regionCode?: string;
  className?: string;
}

const MARKER_RING = 14;
const MARKER_CORE = 5;
const LABEL_SIZE = 15;
const LABEL_GAP = 17;

export function StaticRegionsMap({ citySlug, seed, locale, regionCode, className }: StaticRegionsMapProps) {
  const t = useTranslations("Map");
  const { projection, paths } = regionsSvg();
  const city = cityBySlug(citySlug);
  const code = regionCode ?? city?.regionCode;
  const region = code ? regionByCode(code) : undefined;
  const active = paths.find((p) => p.code === code);

  const label = city ? cityName(city, locale) : undefined;
  const description = city && region ? t("approximate", { city: label ?? citySlug, region: regionName(region, locale) }) : t("mapLabel");

  let marker: { cx: string; cy: string; x: string; y: string } | undefined;
  if (city && label) {
    const [px, py] = projection.project(...lngLat(approximatePosition(city, seed)));
    // Centred label (direction-agnostic, so RTL needs no mirroring), clamped inside the viewBox and
    // moved above the marker near the bottom edge.
    const halfWidth = label.length * LABEL_SIZE * 0.3;
    const x = Math.min(Math.max(px, halfWidth + 4), projection.width - halfWidth - 4);
    const below = py + MARKER_RING + LABEL_GAP + 6 <= projection.height;
    const y = below ? py + MARKER_RING + LABEL_GAP : py - MARKER_RING - 6;
    marker = { cx: formatNumber(px, SVG_DECIMALS), cy: formatNumber(py, SVG_DECIMALS), x: formatNumber(x, SVG_DECIMALS), y: formatNumber(y, SVG_DECIMALS) };
  }

  return (
    <figure data-testid="static-map" className={cn("m-0 flex flex-col gap-2", className)}>
      <div className="overflow-hidden rounded-lg border border-border bg-bab-50 dark:bg-bab-900">
        <svg viewBox={projection.viewBox} className="block h-auto w-full" aria-hidden="true" focusable="false">
          <g className="fill-surface-brand stroke-ochre-300 dark:stroke-ochre-800" strokeWidth={0.8} strokeLinejoin="round">
            {paths.map((p) => (
              <path
                key={p.code}
                d={p.d}
                data-region={p.code}
                data-active={p.code === code ? "true" : undefined}
                className={p.code === code ? "fill-ochre-100 dark:fill-ochre-900" : undefined}
              />
            ))}
          </g>
          {active ? <path d={active.d} className="fill-none stroke-ochre-500 dark:stroke-ochre-400" strokeWidth={1.6} strokeLinejoin="round" /> : null}
          {marker ? (
            <g data-testid="static-map-marker">
              <circle cx={marker.cx} cy={marker.cy} r={MARKER_RING} className="fill-bab-500/20 stroke-bab-500 dark:fill-bab-300/25 dark:stroke-bab-300" strokeWidth={1} />
              <circle cx={marker.cx} cy={marker.cy} r={MARKER_CORE} className="fill-bab-600 stroke-surface dark:fill-bab-200" strokeWidth={1.5} />
              <text
                x={marker.x}
                y={marker.y}
                textAnchor="middle"
                fontSize={LABEL_SIZE}
                fontWeight={500}
                paintOrder="stroke"
                strokeWidth={3}
                strokeLinejoin="round"
                className="fill-foreground stroke-surface font-sans"
              >
                {label}
              </text>
            </g>
          ) : null}
        </svg>
      </div>
      <p className="sr-only">{description}</p>
      <figcaption className="text-xs text-foreground-muted">
        {t.rich("attribution", {
          osm: (chunks) => (
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
              {chunks}
            </a>
          ),
        })}
        <span aria-hidden="true"> · </span>
        {t("regionsSource")}
      </figcaption>
    </figure>
  );
}

const lngLat = (p: { lng: number; lat: number }): [number, number] => [p.lng, p.lat];
