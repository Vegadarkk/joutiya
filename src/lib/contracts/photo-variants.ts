// WebP variants of a listing photo (design D6), without zod: the gallery and the cards build their
// srcset from these in the browser. media.ts re-exports them.

/**
 * Published under `listings/{listingId}/{photoId}-{variant}.webp`: `l` (gallery on large screens,
 * lightbox, OG image), `m` (the gallery on phones: ~720 to 1000 device pixels wide) and `s` (cards,
 * thumbnails).
 */
export const PHOTO_VARIANTS = ["l", "m", "s"] as const;
export type PhotoVariant = (typeof PHOTO_VARIANTS)[number];
export const PHOTO_VARIANT_SPECS: Record<PhotoVariant, { maxEdge: number; quality: number }> = {
  l: { maxEdge: 1600, quality: 80 },
  m: { maxEdge: 960, quality: 78 },
  s: { maxEdge: 480, quality: 75 },
};

/** Variants of the photos processed before `m` existed: what a photo without a `variants` list has. */
export const LEGACY_PHOTO_VARIANTS: readonly PhotoVariant[] = ["l", "s"];
