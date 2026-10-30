// The searches and pages reached from the header and the menus (owner's choice B of 29 Oct 2026:
// "Louer" and "Espace Pro" beside "Vendre"). Plain paths without the locale prefix, for next-intl
// `Link`: the header's islands run on every page, the listing page included, and must not pull the
// search parameter module (zod) into the browser; tests/unit/shortcuts.test.ts keeps these strings
// equal to what src/lib/search/params.ts serializes.

/** `/recherche` narrowed to the car rentals: the page's dates bar chooses the city and the dates. */
export const RENT_CAR_SEARCH = "/recherche?categorie=vehicules&sous-categorie=location-voitures";

/** `/recherche` narrowed to the holiday rentals (Immobilier > Location de vacances, priced per night). */
export const HOLIDAY_RENTAL_SEARCH = "/recherche?categorie=immobilier&sous-categorie=location-vacances";

/** Public page of the Pro offer (visitors and members); a Pro goes straight to their space. */
export const PRO_LANDING_PATH = "/professionnels";
export const PRO_SPACE_PATH = "/pro";

/** The directory of verified shops and agencies, by city and activity (owner's choice of 30 Oct 2026). */
export const DIRECTORY_PATH = "/boutiques";
