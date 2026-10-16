import type { PhotoVariant } from "@/lib/contracts/media";

/** `listings/{listingId}/{photoId}-{variant}.webp` under the public media base (design D6). */
export function photoUrl(mediaBaseUrl: string | null, listingId: string, photoId: string, variant: PhotoVariant): string | null {
  if (!mediaBaseUrl) return null;
  return `${mediaBaseUrl.replace(/\/+$/, "")}/listings/${listingId}/${photoId}-${variant}.webp`;
}
