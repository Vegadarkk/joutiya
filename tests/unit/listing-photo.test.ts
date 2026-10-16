import { describe, expect, it } from "vitest";
import { blurhashPlaceholder, photoSources, smallWidth, srcSetOf, variantWidth } from "@/components/listing/photo";

// Image attributes of listing photos (design §8): srcset over the s/m/l variants (s/l before m)
// with their real widths, and the blurhash placeholder as a tiny BMP data URL that the server can render.

const BASE = "https://media.joutiya.ma";
const HASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";

describe("photoSources", () => {
  it("lists both variants with their widths, s as the default source of cards", () => {
    const sources = photoSources(BASE, "abcd2345", { id: "photo0001", w: 1600, h: 1200, blurhash: HASH });
    expect(sources).toEqual({
      src: `${BASE}/listings/abcd2345/photo0001-s.webp`,
      srcSet: `${BASE}/listings/abcd2345/photo0001-s.webp 480w, ${BASE}/listings/abcd2345/photo0001-l.webp 1600w`,
      width: 1600,
      height: 1200,
      large: `${BASE}/listings/abcd2345/photo0001-l.webp`,
    });
    expect(photoSources(BASE, "abcd2345", { id: "photo0001", w: 1600, h: 1200, blurhash: HASH }, "l")?.src).toBe(`${BASE}/listings/abcd2345/photo0001-l.webp`);
  });

  it("derives the small width of portrait photos from the longest edge", () => {
    expect(smallWidth({ w: 1200, h: 1600 })).toBe(360);
    expect(smallWidth({ w: 1600, h: 900 })).toBe(480);
    expect(photoSources(`${BASE}/`, "abcd2345", { id: "photo0002", w: 1200, h: 1600, blurhash: HASH })?.srcSet).toBe(
      `${BASE}/listings/abcd2345/photo0002-s.webp 360w, ${BASE}/listings/abcd2345/photo0002-l.webp 1200w`,
    );
  });

  it("keeps one candidate for photos smaller than the s variant", () => {
    expect(photoSources(BASE, "abcd2345", { id: "photo0003", w: 400, h: 300, blurhash: HASH })?.srcSet).toBe(`${BASE}/listings/abcd2345/photo0003-l.webp 400w`);
  });

  it("adds the m variant between s and l when the photo has it", () => {
    const sources = photoSources(BASE, "abcd2345", { id: "photo0004", w: 1600, h: 1200, blurhash: HASH, variants: ["l", "m", "s"] });
    expect(sources?.srcSet).toBe(
      `${BASE}/listings/abcd2345/photo0004-s.webp 480w, ${BASE}/listings/abcd2345/photo0004-m.webp 960w, ${BASE}/listings/abcd2345/photo0004-l.webp 1600w`,
    );
    expect(sources?.src).toBe(`${BASE}/listings/abcd2345/photo0004-s.webp`);
    expect(variantWidth({ w: 1200, h: 1600 }, "m")).toBe(720);
  });

  it("leaves out a variant as wide as the next one (photo smaller than its edge)", () => {
    const url = (variant: string) => variant;
    expect(srcSetOf({ w: 900, h: 600, variants: ["l", "m", "s"] }, url)).toBe("s 480w, l 900w");
    expect(srcSetOf({ w: 400, h: 300, variants: ["l", "m", "s"] }, url)).toBe("l 400w");
    expect(srcSetOf({ w: 1600, h: 1200, variants: ["l", "s"] }, url)).toBe("s 480w, l 1600w");
    expect(srcSetOf({ w: 1600, h: 1200 }, url)).toBe("s 480w, l 1600w");
  });

  it("returns null without a media host", () => {
    expect(photoSources(null, "abcd2345", { id: "photo0001", w: 1600, h: 1200, blurhash: HASH })).toBeNull();
  });
});

describe("blurhashPlaceholder", () => {
  it("decodes the hash into an 8x6 24-bit BMP data URL", () => {
    const url = blurhashPlaceholder(HASH);
    expect(url).toMatch(/^data:image\/bmp;base64,[A-Za-z0-9+/]+=*$/);
    const bytes = Buffer.from(url!.split(",")[1]!, "base64");
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("BM");
    expect(bytes.readUInt32LE(2)).toBe(bytes.length);
    expect(bytes.readInt32LE(18)).toBe(8);
    expect(bytes.readInt32LE(22)).toBe(6);
    expect(bytes.readUInt16LE(28)).toBe(24);
    expect(bytes.length).toBe(54 + 8 * 3 * 6);
    expect(url!.length).toBeLessThan(400);
    // Same hash, same URL (memoized and deterministic: server and client render the same HTML).
    expect(blurhashPlaceholder(HASH)).toBe(url);
  });

  it("answers null for a missing or invalid hash", () => {
    expect(blurhashPlaceholder(undefined)).toBeNull();
    expect(blurhashPlaceholder("not-a-hash")).toBeNull();
  });
});
