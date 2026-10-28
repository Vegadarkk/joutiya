import type { FlagsConfig } from "./flags";

// House promotions (phase 6, D7): what an ad slot shows when no ad runs (ads off, refused,
// unfilled, blocked, late). Labelled with the site's name, never "Publicité". Each promotion is
// offered only while its feature is open.

export const HOUSE_PROMOS = [
  { id: "post", href: "/deposer" },
  { id: "alert", href: "/recherche" },
  { id: "safety", href: "/legal/confiance-et-securite" },
  { id: "pro", href: "/pro", when: (flags: FlagsConfig) => flags.proSignupEnabled },
  { id: "boost", href: "/mes-annonces", when: (flags: FlagsConfig) => flags.salesEnabled },
] as const satisfies readonly { id: string; href: string; when?: (flags: FlagsConfig) => boolean }[];
export type HousePromo = (typeof HOUSE_PROMOS)[number];
export type HousePromoId = HousePromo["id"];

export function availablePromos(flags: FlagsConfig): HousePromo[] {
  return HOUSE_PROMOS.filter((promo) => !("when" in promo) || promo.when(flags));
}

/** A stable pick per slot (same page, same promotion: no hydration mismatch, no flicker). */
export function pickPromo(promos: readonly HousePromo[], key: string): HousePromo {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return promos[hash % promos.length] ?? HOUSE_PROMOS[0];
}
