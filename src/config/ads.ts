// Advertising slots (phase 6, D4 and D6; architecture §8). Client-safe. Each placement has one
// fixed format: the box reserves the unit's height plus its label from the first paint, so neither
// an ad nor the house promotion that replaces it ever shifts the page (CLS).

export const AD_FORMATS = {
  leaderboard: { width: 970, height: 90 },
  halfpage: { width: 300, height: 600 },
  rectangle: { width: 300, height: 250 },
  banner: { width: 320, height: 100 },
} as const;
export type AdFormat = keyof typeof AD_FORMATS;

/** Height of the "Publicité" label above an ad, px. */
export const AD_LABEL_HEIGHT = 20;
/** An ad not filled within this delay gives its place to the house promotion. */
export const AD_FILL_TIMEOUT_MS = 4000;

/**
 * Placements (AF §8 table). `media`: the slot shows, and may request an ad, only while it matches;
 * `hide` is the same breakpoint as a class, so the server-rendered box is hidden from the first
 * paint. A hidden slot never asks for an ad (AdSense forbids ads in hidden containers).
 */
export const AD_PLACEMENTS = {
  /** Home, under the search hero, desktop only. */
  "home-leaderboard": { format: "leaderboard", media: "(min-width: 1024px)", hide: "max-lg:hidden" },
  /** Search, sticky column beside the results, wide screens. */
  "search-aside": { format: "halfpage", media: "(min-width: 1280px)", hide: "max-xl:hidden" },
  /** Search, a full row inside the results grid (infeedPositions). */
  "search-infeed": { format: "rectangle" },
  /** Listing, last block of the page body, after the report link and the safety tips. */
  "listing-bottom": { format: "rectangle" },
  /** Profile and shop pages, under the listings (house promotion only, see the pages). */
  "profile-bottom": { format: "banner" },
} as const satisfies Record<string, { format: AdFormat; media?: string; hide?: string }>;
export type AdPlacement = keyof typeof AD_PLACEMENTS;

/** In-feed slots of the search results: after the 6th card, then every 10th, 3 at most (D6). */
export function infeedPositions(cardCount: number): number[] {
  const positions: number[] = [];
  for (let after = 6; after < cardCount && positions.length < 3; after += 10) positions.push(after);
  return positions;
}

/** The AdSense loader of a publisher id (D4). */
export function adsenseLoaderUrl(client: string): string {
  return `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
}
