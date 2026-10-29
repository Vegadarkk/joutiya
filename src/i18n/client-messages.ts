import type { AbstractIntlMessages } from "next-intl";

// Messages the browser receives (NextIntlClientProvider): the static public pages ship only the
// namespaces their client components read, not the whole catalog (~80 KB of JSON in every HTML and
// RSC payload). Server components translate on the server and need none of it. The list is kept
// complete by tests/unit/client-messages.test.ts, which walks the client modules of the public routes.

/** Namespaces (or dotted sub-namespaces) read by `useTranslations` in the client modules of the public pages. */
export const PUBLIC_CLIENT_NAMESPACES = [
  // Header, footer, error boundary and toast container.
  "Nav",
  "Locale",
  "Theme",
  "Error",
  "Toaster",
  // Cookie consent: banner, panel and the footer's "Gérer mes cookies".
  "Consent",
  // CGU change notice under the header (signed-in members, D11).
  "CguNotice",
  "Auth.menu",
  "Auth.settings",
  // Listing page islands: gallery, map, contact (the reveal errors and challenge load on demand).
  "ListingPage.gallery",
  "ListingPage.contact",
  "ListingPage.catalogue",
  "Map",
  "Auth.common",
  "Auth.errors",
  "Listing.errors",
  // Report button of the listing and profile pages; its dialog loads on demand (phase 5).
  "Report",
  // « Payer chez le vendeur » button and dialog of a Pro's listing and storefront (phase 7).
  "SellerPayment.public",
  // Car rental availability block of the listing page (rental pack §3).
  "Rental.listing",
  "Rental.calendar",
  // Home "Louer une voiture" module and its date fields (rental pack §4).
  "Rental.home",
  "Rental.search",
  // Fleet of a car rental agency's storefront, filtered by dates in place (rental pack §5).
  "Storefront.fleet",
  // Search islands shared by the home, category and listing pages (phase 4): favorite heart,
  // À la Une badge, search bar and the place field (the header's search pill too).
  "Favorites.button",
  "ListingCard",
  "Search.bar",
  "Search.location",
] as const;

/**
 * Added on the search page only (its own NextIntlClientProvider, on top of the public list): the
 * filters sheet reads the criteria and category labels (~30 KB), which no other public page needs.
 */
export const SEARCH_PAGE_CLIENT_NAMESPACES = [
  "SearchFilters",
  "SearchPage",
  "Criteria",
  "Categories",
  "Listing.units",
  "Listing.wizard",
  "Listing.fields",
  "SavedSearches.button",
  "SavedSearches.summary",
  "SavedSearches.dialog",
] as const;

/**
 * Added on the help centre pages only (src/app/[locale]/(public)/aide/layout.tsx): the article
 * search box and the Assistant Joutiya widget (design phase-5 D25).
 */
export const HELP_PAGE_CLIENT_NAMESPACES = ["Help.search", "Help.assistant"] as const;

/** The subtrees of `messages` named by `paths` ("Auth.menu" keeps `{ Auth: { menu } }`); unknown paths are skipped. */
export function pickMessages(messages: AbstractIntlMessages, paths: readonly string[]): AbstractIntlMessages {
  const out: AbstractIntlMessages = {};
  for (const path of paths) {
    const keys = path.split(".");
    let source: AbstractIntlMessages | string | undefined = messages;
    for (const key of keys) source = typeof source === "object" ? source[key] : undefined;
    if (source === undefined) continue;
    let target = out;
    keys.forEach((key, index) => {
      if (index === keys.length - 1) {
        target[key] = source;
        return;
      }
      const next = target[key];
      target = (target[key] = typeof next === "object" ? next : {}) as AbstractIntlMessages;
    });
  }
  return out;
}
