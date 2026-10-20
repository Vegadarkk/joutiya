import { Aref_Ruqaa, Montserrat, Readex_Pro } from "next/font/google";

/**
 * Readex Pro covers Arabic and Latin; self-hosted by next/font at build time (font-src 'self').
 * The CSS declares every subset and the browser fetches only those a page renders (unicode-range):
 * no preload, which would compete with the listing photo (the LCP element) for a phone's first
 * bytes, and would fetch the Arabic file on French pages that render no Arabic glyph (preloads
 * follow the module graph, not the locale). Text paints in the size-adjusted fallback until then.
 */
export const readex = Readex_Pro({
  subsets: ["arabic", "latin"],
  variable: "--font-readex",
  display: "swap",
  preload: false,
});

/**
 * Readex Pro has no ɛ, ɣ, Ɛ, Ɣ (Tarifit, Z9). Montserrat (geometric, like Readex) supplies them from latin-ext: the browser
 * fetches it only on pages that use one of those letters.
 */
export const tarifitFallback = Montserrat({
  subsets: ["latin-ext"],
  variable: "--font-tarifit",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

/**
 * Aref Ruqaa: calligraphic lettering (Ruqʿah in Arabic, a matching pen in Latin) for the inscription
 * over the welcome door. Only the welcome screen uses it, so only a first visit fetches it; "block"
 * keeps the inscription from flashing in the fallback during its reveal.
 */
export const ruqaa = Aref_Ruqaa({
  subsets: ["arabic", "latin"],
  weight: "700",
  variable: "--font-ruqaa",
  display: "block",
  preload: false,
});
