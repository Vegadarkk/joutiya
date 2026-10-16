// Real image type from the first bytes (research/libs-media.md §7): the browser's Content-Type and
// the extension are never trusted. Shared by the browser (first 256 bytes of the File) and the
// worker (quarantine object): no Buffer, no server-only import. ISO-BMFF brands are read from the
// whole ftyp box, major and compatible, because iPhone HEIC files use the major brand `mif1` and
// AVIF files may too; AVIF is tested first so a `mif1` + `avif` file is not called HEIC.

export type SniffedImageType = "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/heic" | "image/avif";

/** Types the server decodes (sharp loader allowlist); everything else is `bad_type`. */
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

/** Bytes a sniff needs; callers reading a prefix should read at least this many. */
export const SNIFF_BYTES = 256;

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(bytes, 1, 8) === "PNG\r\n\x1a\n") return "image/png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const boxSize = ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
    const end = Math.min(boxSize >= 16 ? boxSize : 32, bytes.length, SNIFF_BYTES);
    const brands = [ascii(bytes, 8, 12)];
    for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(ascii(bytes, offset, offset + 4));
    if (brands.some((brand) => AVIF_BRANDS.has(brand))) return "image/avif";
    if (brands.some((brand) => HEIC_BRANDS.has(brand))) return "image/heic";
  }
  return null;
}

export function isAcceptedImageType(type: string | null): type is AcceptedImageType {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type ?? "");
}

/**
 * The accepted type of an upload, or the reject reason: the sniffed type must be JPEG, PNG or
 * WebP and equal the type the client declared (and had signed into the presigned URL).
 */
export function checkImageType(bytes: Uint8Array, declaredType: string): { type: AcceptedImageType } | { reason: "bad_type" } {
  const sniffed = sniffImageType(bytes);
  if (!isAcceptedImageType(sniffed) || sniffed !== declaredType) return { reason: "bad_type" };
  return { type: sniffed };
}
