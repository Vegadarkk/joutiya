// The search page's path and URL names, without the parsing (params.ts, which pulls the category
// tree and zod): what a plain GET search form needs, such as the header's search pill on every page.

export const SEARCH_PATH = "/recherche";
export const SEARCH_Q_MAX = 100;

/** URL parameter names. `breadcrumb.tsx` links use the same names. */
export const SEARCH_QUERY_KEYS = {
  q: "q",
  /** `brut=1`: the words are searched as typed, never interpreted (search/interpret). */
  raw: "brut",
  category: "categorie",
  subcategory: "sous-categorie",
  region: "region",
  city: "ville",
  radius: "rayon",
  district: "quartier",
  /** Map area of "Rechercher dans cette zone": `lat,lng,km` (params.ts). */
  zone: "zone",
  /** `position=1`: the zone is a circle around the visitor's own position (« Utiliser ma position »). */
  fromPosition: "position",
  priceMin: "prix-min",
  priceMax: "prix-max",
  sellerType: "vendeur",
  sellerId: "vendeur-id",
  shop: "boutique",
  section: "section",
  donation: "don",
  withPhoto: "photo",
  includeSoldOut: "epuises",
  promo: "promo",
  conditions: "etat",
  rentFrom: "du",
  rentTo: "au",
  sort: "tri",
  page: "page",
} as const;
