import * as rootParams from "next/root-params";
import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, type Locale } from "@/config/site";
import { routing } from "./routing";
import { loadMessages } from "./messages";

export default getRequestConfig(async ({ locale }) => {
  let resolved: Locale = DEFAULT_LOCALE;
  if (hasLocale(routing.locales, locale)) {
    resolved = locale;
  } else {
    // Localized pages carry [locale] as root param; the back office (French only) has none.
    const param = await rootParams.locale();
    if (hasLocale(routing.locales, param)) resolved = param;
  }
  return {
    locale: resolved,
    messages: await loadMessages(resolved),
    timeZone: "Africa/Casablanca",
    // A missing Tarifit key falls back to French (Z9); never crash a page on a missing key.
    onError() {},
    getMessageFallback({ namespace, key }) {
      return [namespace, key].filter(Boolean).join(".");
    },
  };
});
