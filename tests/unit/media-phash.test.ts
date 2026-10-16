import { describe, expect, it } from "vitest";
import { dhash, dhashFromGrey, hammingDistance, isImageHash } from "@/lib/media/phash";
import { sharp } from "@/lib/media/sharp-setup";

// dHash: a recompressed or resized copy stays close, a different picture does not.

/** 8x8 blocks of pseudo-random grey (LCG, deterministic) scaled to `size` px, as a JPEG. */
async function blocky(seed: number, size = 512): Promise<Buffer> {
  const cells = 8;
  const raw = Buffer.alloc(cells * cells * 3);
  let state = seed >>> 0;
  for (let i = 0; i < cells * cells; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const grey = state >>> 24;
    raw[i * 3] = grey;
    raw[i * 3 + 1] = grey;
    raw[i * 3 + 2] = grey;
  }
  return sharp(raw, { raw: { width: cells, height: cells, channels: 3 } })
    .resize(size, size, { kernel: "nearest" })
    .jpeg({ quality: 92 })
    .toBuffer();
}

describe("dhashFromGrey", () => {
  it("sets a bit when the left pixel is brighter than its right neighbour", () => {
    const rising = new Uint8Array(72).map((_, i) => (i % 9) * 20);
    expect(dhashFromGrey(rising)).toBe("0000000000000000");
    const falling = new Uint8Array(72).map((_, i) => 200 - (i % 9) * 20);
    expect(dhashFromGrey(falling)).toBe("ffffffffffffffff");
    const alternating = new Uint8Array(72).map((_, i) => (i % 2 === 0 ? 255 : 0));
    // Row 0 of 9: 255 0 255 0 255 0 255 0 255 -> 10101010 = 0xaa; row 1 starts at index 9 -> 0x55.
    expect(dhashFromGrey(alternating)).toBe("aa55aa55aa55aa55");
    expect(() => dhashFromGrey(new Uint8Array(10))).toThrow(RangeError);
  });
});

describe("hammingDistance", () => {
  it("counts differing bits of two 64-bit hex hashes", () => {
    expect(hammingDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hammingDistance("8000000000000001", "0000000000000000")).toBe(2);
    expect(hammingDistance("aaaaaaaaaaaaaaaa", "5555555555555555")).toBe(64);
    expect(() => hammingDistance("abc", "0000000000000000")).toThrow(RangeError);
    expect(isImageHash("0123456789abcdef")).toBe(true);
    expect(isImageHash("0123456789ABCDEF")).toBe(false);
  });
});

describe("dhash", () => {
  it("is small between an image and its recompressed, resized copy and large between different images", async () => {
    const original = await blocky(7);
    const copy = await sharp(original).resize(360).jpeg({ quality: 55 }).toBuffer();
    const webpCopy = await sharp(original).webp({ quality: 70 }).toBuffer();
    const other = await blocky(99);
    const [a, b, c, d] = await Promise.all([dhash(original), dhash(copy), dhash(webpCopy), dhash(other)]);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(6);
    expect(hammingDistance(a, c)).toBeLessThanOrEqual(4);
    expect(hammingDistance(a, d)).toBeGreaterThan(16);
  });

  it("applies the EXIF orientation first and ignores alpha", async () => {
    const upright = await blocky(3, 256);
    const rotated = await sharp(await sharp(upright).rotate(270).toBuffer()).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    expect(hammingDistance(await dhash(upright), await dhash(rotated))).toBeLessThanOrEqual(4);
    const withAlpha = await sharp(upright).ensureAlpha().png().toBuffer();
    expect(hammingDistance(await dhash(upright), await dhash(withAlpha))).toBeLessThanOrEqual(2);
  });
});
