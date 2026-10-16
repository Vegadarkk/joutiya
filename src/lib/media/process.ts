import "server-only";
import { encode as encodeBlurhash } from "blurhash";
import { PHOTO_VARIANT_SPECS, type PhotoVariant } from "@/lib/contracts/media";
import { MediaError } from "./errors";
import { dhash } from "./phash";
import { INPUT_OPTIONS, MAX_INPUT_PIXELS, openImage, sharp } from "./sharp-setup";

// The sharp pipeline of a listing photo (architecture §3 step 5, design D6): header check first
// (format, dimensions, pixel cap), then one decode with EXIF orientation applied, every metadata
// block dropped (EXIF, GPS, XMP, IPTC, ICC: sharp writes none unless asked), re-encoded as WebP
// `l` (1600 px) and `s` (480 px, from `l`), plus the blurhash placeholder and the dHash. The
// output container is always ours, so trailing data of a polyglot file never survives.

export interface ProcessedImage {
  /** Dimensions of the `l` variant (what pages render). */
  width: number;
  height: number;
  /** Dimensions of the oriented source. */
  sourceWidth: number;
  sourceHeight: number;
  blurhash: string;
  /** dHash, 16 hex chars. */
  hash: string;
  variants: Record<PhotoVariant, Buffer>;
}

/** Formats the loader allowlist decodes; the sniffer (magic.ts) agrees upstream. */
const DECODABLE_FORMATS: ReadonlySet<string> = new Set(["jpeg", "png", "webp"]);
const BLURHASH_SIZE = 32;
const BLURHASH_COMPONENTS = { x: 4, y: 3 } as const;
const WEBP_EFFORT = 4;

/** sharp failures mapped to reject reasons; anything unknown is a decode failure. */
export function toMediaError(error: unknown): MediaError {
  if (error instanceof MediaError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/exceeds pixel limit/i.test(message)) return new MediaError("too_large", "image exceeds the pixel limit", { cause: error });
  if (/unsupported image format/i.test(message)) return new MediaError("bad_type", "unsupported image format", { cause: error });
  return new MediaError("decode_failed", "image could not be decoded", { cause: error });
}

async function blurhashOf(image: Buffer): Promise<string> {
  const { data, info } = await openImage(image)
    .ensureAlpha()
    .resize(BLURHASH_SIZE, BLURHASH_SIZE, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return encodeBlurhash(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height, BLURHASH_COMPONENTS.x, BLURHASH_COMPONENTS.y);
}

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  try {
    // Header only: no pixel is decoded, and the pixel cap is enforced here (a bomb costs ~1 ms).
    const meta = await sharp(input, INPUT_OPTIONS).metadata();
    if (!meta.format || !DECODABLE_FORMATS.has(meta.format)) throw new MediaError("bad_type", "unsupported image format");
    if (!meta.width || !meta.height) throw new MediaError("decode_failed", "image has no dimensions");
    // metadata() dimensions ignore EXIF orientation: swap for 90-degree rotations (values 5 to 8).
    const swap = (meta.orientation ?? 1) >= 5;
    const sourceWidth = swap ? meta.height : meta.width;
    const sourceHeight = swap ? meta.width : meta.height;
    if (sourceWidth * sourceHeight > MAX_INPUT_PIXELS) throw new MediaError("too_large", "image exceeds the pixel limit");

    const large = await openImage(input)
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({ width: PHOTO_VARIANT_SPECS.l.maxEdge, height: PHOTO_VARIANT_SPECS.l.maxEdge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: PHOTO_VARIANT_SPECS.l.quality, effort: WEBP_EFFORT })
      .toBuffer({ resolveWithObject: true });
    const small = await openImage(large.data)
      .resize({ width: PHOTO_VARIANT_SPECS.s.maxEdge, height: PHOTO_VARIANT_SPECS.s.maxEdge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: PHOTO_VARIANT_SPECS.s.quality, effort: WEBP_EFFORT })
      .toBuffer();
    const blurhash = await blurhashOf(large.data);
    const hash = await dhash(large.data);
    return {
      width: large.info.width,
      height: large.info.height,
      sourceWidth,
      sourceHeight,
      blurhash,
      hash,
      variants: { l: large.data, s: small },
    };
  } catch (error) {
    throw toMediaError(error);
  }
}
