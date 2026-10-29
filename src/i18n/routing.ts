import { defineRouting } from "next-intl/routing";
import { DEFAULT_LOCALE, LOCALES } from "@/config/site";

export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  // /fr/..., /ar/..., /rif/...: every public URL carries its locale (§4).
  localePrefix: "always",
  // hreflang alternates are rendered in <head> (fr and ar only), not by the proxy.
  alternateLinks: false,
  localeCookie: {
    name: "NEXT_LOCALE",
    sameSite: "lax",
    // Also written by the locale switcher in the page (document.cookie): never HttpOnly.
    secure: true,
    maxAge: 60 * 60 * 24 * 365,
  },
});
