import { Montserrat, Readex_Pro } from "next/font/google";

/** Readex Pro covers Arabic and Latin; self-hosted by next/font at build time (font-src 'self'). */
export const readex = Readex_Pro({
  subsets: ["arabic", "latin", "latin-ext"],
  variable: "--font-readex",
  display: "swap",
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
