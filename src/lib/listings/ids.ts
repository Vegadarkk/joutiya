// Listing identifiers and URL slugs (phase 3, design D1). Pure and client-safe: no server import,
// Web Crypto only (Node 24 and browsers), so the contracts can share the id pattern.
//
// URL: /annonce/{slug}-{id}. The slug is the slugified title + city (ASCII, hyphens, <= 60 chars);
// the id is the last 8 characters of the segment. A wrong slug 301s to the canonical URL, so only
// the id is trusted when parsing.

/** Same unambiguous alphabet as users.publicId (no 0/o, 1/i/l). */
export const LISTING_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const LISTING_ID_LENGTH = 8;
export const LISTING_ID_PATTERN = /^[a-hj-km-np-z2-9]{8}$/;
export const SLUG_MAX = 60;
/** `{slug}-{id}` or a bare id; the stored `slugId` always carries a slug. */
export const SLUG_ID_MAX = SLUG_MAX + 1 + LISTING_ID_LENGTH;
export const SLUG_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-hj-km-np-z2-9]{8}$/;

export function isListingId(value: string): boolean {
  return LISTING_ID_PATTERN.test(value);
}

/**
 * 8 random characters from the public-id alphabet (31 symbols, ~39.5 bits): unguessable enough for
 * a public URL, short enough to type. Unbiased: bytes >= 248 (8 * 31) are rejected and redrawn.
 */
export function newListingId(): string {
  const limit = LISTING_ID_ALPHABET.length * Math.floor(256 / LISTING_ID_ALPHABET.length);
  let id = "";
  const bytes = new Uint8Array(LISTING_ID_LENGTH * 2);
  while (id.length < LISTING_ID_LENGTH) {
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      id += LISTING_ID_ALPHABET[byte % LISTING_ID_ALPHABET.length];
      if (id.length === LISTING_ID_LENGTH) break;
    }
  }
  return id;
}

// Arabic letters -> Latin (simplified, readable; not reversible). Vowel marks are stripped by the
// NFKD pass. Letters shared with Persian/Darija transcriptions (پ چ ڤ گ) are included.
const ARABIC_LATIN: Record<string, string> = {
  "ا": "a", "أ": "a", "إ": "i", "آ": "a", "ء": "", "ؤ": "ou", "ئ": "i", "ى": "a", "ة": "a",
  "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "h", "خ": "kh", "د": "d", "ذ": "dh", "ر": "r",
  "ز": "z", "س": "s", "ش": "ch", "ص": "s", "ض": "d", "ط": "t", "ظ": "z", "ع": "a", "غ": "gh",
  "ف": "f", "ق": "q", "ك": "k", "ل": "l", "م": "m", "ن": "n", "ه": "h", "و": "ou", "ي": "i",
  "پ": "p", "چ": "ch", "ڤ": "v", "گ": "g", "ـ": "",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

function transliterate(text: string): string {
  let out = "";
  for (const char of text) out += ARABIC_LATIN[char] ?? char;
  return out;
}

/**
 * ASCII slug: lower case, letters and digits, single hyphens, no dot, at most `max` characters
 * (cut on a hyphen when possible). Arabic is transliterated; what remains unmapped is dropped.
 * Returns "" when nothing survives (the caller picks a fallback such as the category id).
 */
export function slugify(text: string, max: number = SLUG_MAX): string {
  const ascii = transliterate(text)
    .normalize("NFKD")
    // Combining marks (Latin diacritics, Arabic vowel signs) and everything outside [a-z0-9].
    .replace(/[̀-ͯؐ-ًؚ-ٰٟۖ-ۭ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii.length <= max) return ascii;
  const cut = ascii.slice(0, max);
  const lastHyphen = cut.lastIndexOf("-");
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/g, "");
}

export interface SlugIdInput {
  id: string;
  title: string;
  /** City name (fr), appended to the title. */
  city?: string;
  /** Fallback slug when the title and city give no ASCII at all (e.g. an emoji-only title). */
  categoryId?: string;
}

/** `{slug}-{id}` for the canonical URL; `id` must be a listing id. */
export function buildSlugId({ id, title, city, categoryId }: SlugIdInput): string {
  if (!isListingId(id)) throw new RangeError("invalid listing id");
  const slug = slugify([title, city].filter((part): part is string => Boolean(part && part.trim())).join(" ")) || slugify(categoryId ?? "") || "annonce";
  return `${slug}-${id}`;
}

export interface ParsedSlugId {
  id: string;
  /** Everything before `-{id}`; "" for a bare id. Compare with the stored `slugId` to 301. */
  slug: string;
}

/**
 * The `{slug}-{id}` segment of a URL, or a bare id; `null` when no listing id can be read. A slug
 * other than `slugify`'s alphabet is refused before any read: a dotted path skips proxy.ts and its
 * page limits, so `x.<n>-{id}` would cost one Firestore read per URL.
 */
export function parseSlugId(segment: string): ParsedSlugId | null {
  if (segment.length > SLUG_ID_MAX + 40 || segment.length < LISTING_ID_LENGTH || !/^[a-z0-9-]+$/.test(segment)) return null;
  const id = segment.slice(-LISTING_ID_LENGTH);
  if (!isListingId(id)) return null;
  if (segment.length === LISTING_ID_LENGTH) return { id, slug: "" };
  if (segment[segment.length - LISTING_ID_LENGTH - 1] !== "-") return null;
  return { id, slug: segment.slice(0, -LISTING_ID_LENGTH - 1) };
}
