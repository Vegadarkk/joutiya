import type { ReactNode } from "react";
import type { BannerKey } from "@/config/storefront";
import { cn } from "@/lib/utils";

// House banners of the member storefront (vitrine-avis §1): six patterns drawn from the brand's
// door (zellige star, arcades, threshold lozenges, desert dunes, night sky) in its four colours.
// Inline SVG: no file, nothing for the CSP to allow, sharp at any width. The banner is decoration
// (aria-hidden); the same colours in both themes, like a photo.

interface Pattern {
  background: string;
  /** Tile size of the repeating pattern, px. */
  tile: [number, number];
  shapes: ReactNode;
}

/** A four-point star centred on (x, y), r its half-span. */
function sparkle(x: number, y: number, r: number): string {
  return `M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`;
}

function zellige(line: string, dot: string): ReactNode {
  return (
    <g fill="none" stroke={line} strokeWidth="1.5" strokeLinejoin="round">
      <polygon points="16,16 40,16 40,40 16,40" />
      <polygon points="28,11 45,28 28,45 11,28" />
      <path d="M28 0V11M28 45V56M0 28H11M45 28H56" />
      <circle cx="28" cy="28" r="3" fill={dot} stroke="none" />
      <circle cx="0" cy="0" r="2.5" fill={dot} stroke="none" />
      <circle cx="56" cy="56" r="2.5" fill={dot} stroke="none" />
      <circle cx="56" cy="0" r="2.5" fill={dot} stroke="none" />
      <circle cx="0" cy="56" r="2.5" fill={dot} stroke="none" />
    </g>
  );
}

const PATTERNS: Record<BannerKey, Pattern> = {
  zellige: { background: "#0d4b4d", tile: [56, 56], shapes: zellige("#d2a24c", "#c0582c") },
  "zellige-ochre": { background: "#a94b26", tile: [56, 56], shapes: zellige("#f2e9d8", "#d2a24c") },
  arcades: {
    background: "#f2e9d8",
    tile: [48, 72],
    shapes: (
      <g fill="none" stroke="#0d4b4d" strokeWidth="1.5">
        <path d="M8 72V36a16 16 0 0 1 32 0V72" />
        <path d="M14 72V38a10 10 0 0 1 20 0V72" stroke="#c0582c" />
      </g>
    ),
  },
  losanges: {
    background: "#f7ecd3",
    tile: [40, 40],
    shapes: (
      <g fill="none" stroke="#b8873a" strokeWidth="1.5">
        <path d="M20 2L38 20L20 38L2 20Z" />
        <path d="M20 12L28 20L20 28L12 20Z" fill="#d2a24c" stroke="none" opacity="0.55" />
      </g>
    ),
  },
  dunes: {
    background: "#e6d8bd",
    tile: [160, 40],
    shapes: (
      <g fill="none" strokeWidth="1.5" strokeLinecap="round">
        <path d="M0 14Q40 2 80 14T160 14" stroke="#c0582c" />
        <path d="M0 32Q40 20 80 32T160 32" stroke="#b8873a" />
      </g>
    ),
  },
  nuit: {
    background: "#0b1e1f",
    tile: [140, 90],
    shapes: (
      <g fill="#e2b865">
        <path d={sparkle(24, 22, 7)} />
        <path d={sparkle(96, 58, 4)} />
        <path d={sparkle(118, 16, 2.5)} />
        <circle cx="60" cy="34" r="1.2" />
        <circle cx="40" cy="74" r="1" />
        <circle cx="130" cy="80" r="1.2" />
      </g>
    ),
  },
};

export function StorefrontBanner({ bannerKey, id, className }: { bannerKey: BannerKey; id: string; className?: string }) {
  const pattern = PATTERNS[bannerKey];
  const patternId = `banner-${id}-${bannerKey}`;
  return (
    <svg aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid slice" viewBox="0 0 1200 240" className={cn("block h-full w-full", className)}>
      <defs>
        <pattern id={patternId} width={pattern.tile[0]} height={pattern.tile[1]} patternUnits="userSpaceOnUse">
          {pattern.shapes}
        </pattern>
      </defs>
      <rect width="1200" height="240" fill={pattern.background} />
      <rect width="1200" height="240" fill={`url(#${patternId})`} />
    </svg>
  );
}
