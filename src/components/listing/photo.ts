import { decode } from "blurhash";
import { LEGACY_PHOTO_VARIANTS, PHOTO_VARIANT_SPECS, type PhotoVariant } from "@/lib/contracts/photo-variants";
import { photoUrl } from "@/lib/listings/client/photo-url";

// Image attributes of listing photos (design §8 Option A): plain <img srcSet sizes width height>
// over the WebP variants a photo has (D6: s, m and l; s and l before m existed), and a blurhash
// placeholder computed where the HTML is rendered (no script needed: it is in the ISR HTML, so it
// paints before hydration). Isomorphic and pure.

export interface PhotoLike {
  id: string;
  /** Size of the `l` variant. */
  w: number;
  h: number;
  blurhash: string;
  /** Variants stored for the photo; absent on photos processed before `m` (LEGACY_PHOTO_VARIANTS). */
  variants?: readonly PhotoVariant[];
}

/** Width of a variant: the `l` size scaled to the variant's longest edge, never enlarged. */
export function variantWidth(photo: Pick<PhotoLike, "w" | "h">, variant: PhotoVariant): number {
  const scale = Math.min(1, PHOTO_VARIANT_SPECS[variant].maxEdge / Math.max(photo.w, photo.h));
  return Math.max(1, Math.round(photo.w * scale));
}

/** Width of the `s` variant. */
export function smallWidth(photo: Pick<PhotoLike, "w" | "h">): number {
  return variantWidth(photo, "s");
}

const SRCSET_ORDER: readonly PhotoVariant[] = ["s", "m", "l"];

/**
 * `srcset` over the variants the photo has, narrowest first. A variant as wide as the next one is
 * left out (a photo smaller than its maxEdge): the wider one is the same image at a higher quality.
 */
export function srcSetOf(photo: Pick<PhotoLike, "w" | "h" | "variants">, url: (variant: PhotoVariant) => string): string {
  const stored = photo.variants ?? LEGACY_PHOTO_VARIANTS;
  const candidates = SRCSET_ORDER.filter((variant) => variant === "l" || stored.includes(variant)).map((variant) => ({ variant, width: variant === "l" ? photo.w : variantWidth(photo, variant) }));
  return candidates
    .filter((candidate, index) => index === candidates.length - 1 || candidate.width < (candidates[index + 1]?.width ?? Infinity))
    .map(({ variant, width }) => `${url(variant)} ${width}w`)
    .join(", ");
}

export interface PhotoSources {
  /** The `s` variant (default source of cards) or `l` (gallery). */
  src: string;
  srcSet: string;
  /** Intrinsic size (aspect ratio for the layout: no shift). */
  width: number;
  height: number;
  large: string;
}

/** The photo's variants as `src` + `srcSet`; null when no media host is configured. */
export function photoSources(mediaBaseUrl: string | null, listingId: string, photo: PhotoLike, prefer: "s" | "l" = "s"): PhotoSources | null {
  const small = photoUrl(mediaBaseUrl, listingId, photo.id, "s");
  const large = photoUrl(mediaBaseUrl, listingId, photo.id, "l");
  if (!small || !large) return null;
  const srcSet = srcSetOf(photo, (variant) => photoUrl(mediaBaseUrl, listingId, photo.id, variant) ?? large);
  return { src: prefer === "s" ? small : large, srcSet, width: photo.w, height: photo.h, large };
}

/**
 * `photos` with the variant list of their stored record (by id): the public view keeps the four
 * display fields only, and the gallery needs to know which photos have `m`.
 */
export function withStoredVariants<T extends PhotoLike>(photos: readonly T[], stored: readonly { id: string; variants?: readonly PhotoVariant[] }[]): T[] {
  const byId = new Map(stored.map((photo) => [photo.id, photo.variants]));
  return photos.map((photo) => {
    const variants = byId.get(photo.id);
    return variants ? { ...photo, variants } : photo;
  });
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

/** 24-bit uncompressed BMP of RGBA pixels: the smallest image format a browser decodes without a library. */
function bmp(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const imageSize = rowSize * height;
  const out = new Uint8Array(54 + imageSize);
  const view = new DataView(out.buffer);
  out[0] = 0x42; // "B"
  out[1] = 0x4d; // "M"
  view.setUint32(2, out.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, imageSize, true);
  // Rows bottom-up, pixels as B, G, R.
  for (let y = 0; y < height; y += 1) {
    const row = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      out[row + x * 3] = pixels[source + 2] ?? 0;
      out[row + x * 3 + 1] = pixels[source + 1] ?? 0;
      out[row + x * 3 + 2] = pixels[source] ?? 0;
    }
  }
  return out;
}

const placeholderCache = new Map<string, string | null>();

/**
 * The blurhash as a tiny data: URL (8x6 px, ~270 bytes; img-src allows data:), scaled up and
 * smoothed by the browser. Null for an invalid hash: the tile keeps its muted background.
 */
export function blurhashPlaceholder(hash: string | undefined, width = 8, height = 6): string | null {
  if (!hash) return null;
  const key = `${hash}:${width}x${height}`;
  const cached = placeholderCache.get(key);
  if (cached !== undefined) return cached;
  let url: string | null = null;
  try {
    url = `data:image/bmp;base64,${base64(bmp(decode(hash, width, height), width, height))}`;
  } catch {
    url = null;
  }
  if (placeholderCache.size > 2000) placeholderCache.clear();
  placeholderCache.set(key, url);
  return url;
}
