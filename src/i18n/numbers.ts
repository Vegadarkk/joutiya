import { createTranslator, useLocale, useMessages, useTimeZone, useTranslations } from "next-intl";
import { numbersLocale } from "./params";

// useTranslations for a namespace without Tarifit text whose messages print numbers or plurals
// (ICU `#`, `{count, plural}`): under "rif" its French catalog is formatted in French
// (numbersLocale: "1 200 annonces", "0 annonce"), as the server pages do with
// getTranslations({ locale: numbersLocale(locale) }). Other locales get useTranslations itself.

function useNumbersTranslator(namespace?: string) {
  const locale = useLocale();
  const messages = useMessages();
  const timeZone = useTimeZone();
  const t = useTranslations(namespace as never);
  const formatting = numbersLocale(locale);
  return formatting === locale ? t : createTranslator({ locale: formatting, messages, timeZone, namespace: namespace as never });
}

export const useNumbersTranslations = useNumbersTranslator as unknown as typeof useTranslations;
