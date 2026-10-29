import { isBlurhashValid } from "blurhash";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { PHOTO_VARIANTS, PHOTO_VARIANT_SPECS } from "@/lib/contracts/media";
import { MediaError, isMediaError } from "@/lib/media/errors";
import { processImage, toMediaError } from "@/lib/media/process";
import { MAX_INPUT_PIXELS, sharp } from "@/lib/media/sharp-setup";

// Exit criteria of phase 3 for photos (design §6): EXIF and GPS stripped, orientation applied,
// bombs and polyglots rejected or neutralised, variants within spec. Every fixture is generated
// here by sharp or built by hand: no binary file is committed.

const create = (width: number, height: number, background = { r: 200, g: 40, b: 40 }) => sharp({ create: { width, height, channels: 3, background } });

/** A photo-like JPEG (gaussian noise) so that compression artefacts and truncation are realistic. */
const noisy = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: "gaussian", mean: 128, sigma: 40 } } })
    .jpeg({ quality: 90 })
    .toBuffer();

/** Marker ids of a JPEG's segments before the scan start (e1 = APP1 Exif/XMP, e2 = APP2 ICC, ed = APP13 IPTC). */
function jpegSegments(buffer: Buffer): string[] {
  const out: string[] = [];
  let i = 2;
  while (i + 4 < buffer.length && buffer[i] === 0xff && buffer[i + 1] !== 0xda) {
    out.push(buffer[i + 1]!.toString(16));
    i += 2 + buffer.readUInt16BE(i + 2);
  }
  return out;
}

/** RIFF chunk ids of a WebP (metadata would appear as EXIF, XMP , ICCP). */
function riffChunks(buffer: Buffer): string[] {
  const out: string[] = [];
  for (let i = 12; i + 8 <= buffer.length; ) {
    out.push(buffer.toString("latin1", i, i + 4));
    const size = buffer.readUInt32LE(i + 4);
    i += 8 + size + (size & 1);
  }
  return out;
}

/** A PNG whose header announces width x height and whose data is a few bytes: a decompression bomb. */
function pngBomb(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.alloc(16))), chunk("IEND", Buffer.alloc(0))]);
}

async function exifGpsFixture(): Promise<Buffer> {
  return create(100, 50)
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: "Aalan test", Model: "Fixture", Software: "vitest" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "33/1 35/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "7/1 36/1 0/1" },
    })
    .toBuffer();
}

describe("processImage", () => {
  it("strips EXIF and GPS, applies orientation 6 and emits metadata-free WebP variants", async () => {
    const fixture = await exifGpsFixture();
    const before = await sharp(fixture).metadata();
    expect(before.exif).toBeInstanceOf(Buffer);
    expect(before.orientation).toBe(6);
    expect(before.exif!.includes("Aalan test")).toBe(true);
    // The GPS IFD pointer tag (0x8825) is present in the fixture's EXIF block.
    expect(before.exif!.includes(Buffer.from([0x88, 0x25])) || before.exif!.includes(Buffer.from([0x25, 0x88]))).toBe(true);
    expect(jpegSegments(fixture)).toContain("e1");

    const result = await processImage(fixture);
    // 100x50 with orientation 6 (rotate 90 CW) -> 50x100; nothing enlarged.
    expect([result.sourceWidth, result.sourceHeight]).toEqual([50, 100]);
    expect([result.width, result.height]).toEqual([50, 100]);
    for (const variant of PHOTO_VARIANTS) {
      const buffer = result.variants[variant];
      const meta = await sharp(buffer).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.iptc).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect([meta.width, meta.height]).toEqual([50, 100]);
      const chunks = riffChunks(buffer);
      expect(chunks).not.toContain("EXIF");
      expect(chunks).not.toContain("XMP ");
      expect(chunks).not.toContain("ICCP");
      expect(buffer.includes("Aalan test")).toBe(false);
    }
    expect(result.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(isBlurhashValid(result.blurhash).result).toBe(true);
    expect(result.blurhash.length).toBe(28);
  });

  it("keeps variants within PHOTO_VARIANT_SPECS and never enlarges", async () => {
    const large = await processImage(await create(2048, 1536).jpeg().toBuffer());
    expect([large.width, large.height]).toEqual([PHOTO_VARIANT_SPECS.l.maxEdge, 1200]);
    const small = await sharp(large.variants.s).metadata();
    expect([small.width, small.height]).toEqual([PHOTO_VARIANT_SPECS.s.maxEdge, 360]);
    const medium = await sharp(large.variants.m).metadata();
    expect([medium.width, medium.height, medium.format]).toEqual([PHOTO_VARIANT_SPECS.m.maxEdge, 720, "webp"]);
    expect(large.variants.s.byteLength).toBeLessThan(large.variants.m.byteLength);
    expect(large.variants.m.byteLength).toBeLessThan(large.variants.l.byteLength);

    const portrait = await processImage(await create(1200, 2400).webp().toBuffer());
    expect([portrait.width, portrait.height]).toEqual([800, PHOTO_VARIANT_SPECS.l.maxEdge]);
    expect([portrait.sourceWidth, portrait.sourceHeight]).toEqual([1200, 2400]);

    const tiny = await processImage(await create(300, 200).png().toBuffer());
    expect([tiny.width, tiny.height]).toEqual([300, 200]);
    expect(await sharp(tiny.variants.s).metadata()).toMatchObject({ width: 300, height: 200, format: "webp" });
    expect(await sharp(tiny.variants.m).metadata()).toMatchObject({ width: 300, height: 200, format: "webp" });
  });

  it("flattens transparency on white", async () => {
    const png = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const result = await processImage(png);
    const { data, info } = await sharp(result.variants.l).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });

  it("re-encodes a polyglot JPEG without its trailer", async () => {
    const jpeg = await noisy(640, 480);
    const trailer = Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), Buffer.from("<?php system($_GET[0]); ?><html><script>alert(1)</script></html>")]);
    const polyglot = Buffer.concat([jpeg, trailer]);
    const result = await processImage(polyglot);
    expect([result.width, result.height]).toEqual([640, 480]);
    for (const buffer of Object.values(result.variants)) {
      expect(buffer.includes("PK\u0003\u0004", 0, "latin1")).toBe(false);
      expect(buffer.includes("<?php")).toBe(false);
      expect(buffer.includes("<script")).toBe(false);
      expect(riffChunks(buffer).every((id) => ["VP8 ", "VP8L", "VP8X", "ALPH"].includes(id))).toBe(true);
    }
  });

  it("rejects a PNG bomb from its header, before any decode", async () => {
    const bomb = pngBomb(20_000, 20_000);
    expect(bomb.byteLength).toBeLessThan(200);
    const started = performance.now();
    const error = await processImage(bomb).catch((e: unknown) => e);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(isMediaError(error)).toBe(true);
    expect((error as MediaError).reason).toBe("too_large");
    expect(20_000 * 20_000).toBeGreaterThan(MAX_INPUT_PIXELS);
    // Just under the cap is accepted by the header check (the decode then fails on the fake data).
    const smallBomb = pngBomb(7_000, 7_000);
    await expect(processImage(smallBomb)).rejects.toMatchObject({ reason: "decode_failed" });
  });

  it("rejects GIF, SVG, TIFF and AVIF as unsupported types (loader allowlist)", async () => {
    const gif = await create(20, 20).gif().toBuffer();
    const tiff = await create(20, 20).tiff().toBuffer();
    const avif = await create(20, 20).avif({ effort: 0 }).toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>');
    for (const buffer of [gif, tiff, avif, svg]) {
      await expect(processImage(buffer)).rejects.toMatchObject({ name: "MediaError", reason: "bad_type" });
    }
    await expect(processImage(Buffer.from("not an image at all"))).rejects.toMatchObject({ reason: "bad_type" });
    await expect(processImage(Buffer.alloc(0))).rejects.toBeInstanceOf(MediaError);
  });

  it("rejects a truncated JPEG as decode_failed", async () => {
    const jpeg = await noisy(800, 600);
    const truncated = jpeg.subarray(0, Math.floor(jpeg.byteLength * 0.6));
    // The header is intact: only the decode notices (failOn: "error").
    expect((await sharp(truncated).metadata()).format).toBe("jpeg");
    await expect(processImage(truncated)).rejects.toMatchObject({ reason: "decode_failed" });
  });
});

describe("MediaError", () => {
  it("maps sharp failures to reject reasons and keeps the cause", () => {
    expect(toMediaError(new Error("Input image exceeds pixel limit"))).toMatchObject({ reason: "too_large" });
    expect(toMediaError(new Error("Input buffer contains unsupported image format"))).toMatchObject({ reason: "bad_type" });
    expect(toMediaError(new Error("VipsJpeg: premature end of JPEG image"))).toMatchObject({ reason: "decode_failed" });
    expect(toMediaError("timeout: 100% complete")).toMatchObject({ reason: "decode_failed" });
    const original = new MediaError("nsfw");
    expect(toMediaError(original)).toBe(original);
    const cause = new Error("boom");
    const mapped = toMediaError(cause);
    expect(mapped.cause).toBe(cause);
    expect(mapped.name).toBe("MediaError");
    expect(isMediaError(new Error("x"))).toBe(false);
  });
});
