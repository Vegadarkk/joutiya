import { getTranslations } from "next-intl/server";
import type { Locale } from "@/config/site";
import { numbersLocale } from "@/i18n/params";
import type { MapListingLabels } from "./map-listings";

// The words of the map listings (Carte vivante, lots 2 and 3), translated on the server for the
// search page and the home page: prices, units and key facts as the results card prints them.

export async function mapListingLabels(locale: Locale): Promise<MapListingLabels> {
  const [own, card, units] = await Promise.all([
    getTranslations({ locale, namespace: "SearchMap" }),
    // Prices print numbers: Tarifit pages format them as French (no Intl data for "rif").
    getTranslations({ locale: numbersLocale(locale), namespace: "ListingCard" }),
    getTranslations({ locale, namespace: "SearchMap.pin.per" }),
  ]);
  return {
    donation: card("donation"),
    toDiscuss: card("toDiscuss"),
    salaryToDiscuss: card("salaryToDiscuss"),
    today: own("today"),
    per: (unit) => card(`per.${unit}`),
    pinPer: (unit) => units(unit),
    fact: (id, value) => (card.has(`facts.${id as "surface"}`) ? card(`facts.${id as "surface"}`, { count: value }) : null),
  };
}
