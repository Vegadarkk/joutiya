// Site-wide constants shared by the browser and the server. No secrets here.

export const LOCALES = ["fr", "ar", "rif"] as const;
export type Locale = (typeof LOCALES)[number];
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

export const SITE_NAME = "Joutiya";

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
  "recherches",
  "porte-monnaie",
  "factures",
  "parametres",
  "verifications",
  "signalements",
  "recours",
  // (pro)
  "pro",
];

/** Feature flags defaults; the live values come from Firestore `config/flags` (phase 2+). */
export const DEFAULT_FLAGS = {
  salesEnabled: false,
  paymentInstallmentsEnabled: false,
} as const;
