// Storefront of a member (/profil/{publicId}): what an individual can set to present themselves
// (vitrine-avis design §1). The banner is one of the house patterns below, never an uploaded file:
// no storage, no image moderation, no third party's face (owner's choice, 28 Oct 2026).

export const BANNER_KEYS = ["zellige", "zellige-ochre", "arcades", "losanges", "dunes", "nuit"] as const;
export type BannerKey = (typeof BANNER_KEYS)[number];

/** Shown until the member picks one. */
export const DEFAULT_BANNER: BannerKey = "zellige";

/** "About" text of the storefront. */
export const BIO_MAX = 500;

/** Listings rendered on the storefront page (newest first); beyond, the search lists them all. */
export const STOREFRONT_LISTINGS = 48;
