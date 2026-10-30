// Site-wide constants shared by the browser and the server. No secrets here.

export const LOCALES = ["fr", "ar", "rif"] as const;
export type Locale = (typeof LOCALES)[number];
/**
 * Locales offered by the language menu and the account setting. Tarifit stays out until its native
 * review (owner, decision card of 29 Oct 2026; 2 of its 4 089 strings were translated): the /rif
 * pages stay reachable by URL, with their French fallback.
 */
export const SWITCHABLE_LOCALES: readonly Locale[] = ["fr", "ar"];
export const DEFAULT_LOCALE: Locale = "fr";

/** Right-to-left locales: `dir="rtl"` on <html>. */
export const RTL_LOCALES: readonly Locale[] = ["ar"];

/** Locales in the hreflang cluster: Tarifit stays out (AdSense and search engines do not support it). */
export const HREFLANG_LOCALES: readonly Locale[] = ["fr", "ar"];

/** BCP 47 tags for Intl formatting and the `lang` attribute. */
export const LOCALE_TAGS: Record<Locale, string> = {
  fr: "fr-MA",
  ar: "ar-MA",
  rif: "rif-Latn",
};

export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.includes(locale);
}

/**
 * Public brand (owner, 2026-10-29: Joutiya renamed Aalan; OMPIC word mark AALAN). Arabic and
 * Tifinagh spellings chosen by the owner the same day. "Joutiya" stays the internal project name
 * (repository, cloud resources, JOUTIYA_* variables) and joutiya.ma stays ours as a redirect.
 */
export const BRAND = { latin: "Aalan", arabic: "أعلان", tifinagh: "ⴰⵄⵍⴰⵏ" } as const;

export const SITE_NAME = BRAND.latin;

/** Production origin, used for canonical URLs of prerendered pages (src/lib/i18n/metadata.ts). */
export const CANONICAL_ORIGIN = "https://joutiya.ma";

/**
 * First path segment (after the locale) of the private pages: account, auth and Pro areas.
 * They render dynamically with a nonce-based CSP; every other localized page is public
 * (ISR, hash-based CSP, cacheable by Cloudflare while no session cookie is present).
 */
export const PRIVATE_SEGMENTS: readonly string[] = [
  // (auth)
  "connexion",
  "inscription",
  "mot-de-passe-oublie",
  "action",
  // (account)
  "deposer",
  "mes-annonces",
  "messages",
  "favoris",
  "mes-avis",
  "recherches",
  "porte-monnaie",
  "factures",
  "parametres",
  "verifications",
  "signalements",
  "recours",
  // (pro)
  "pro",
  // Phase 4, outside (account): page challenge of the SSR limits, alert e-mail unsubscribe.
  "anti-robot",
  "alertes",
];
