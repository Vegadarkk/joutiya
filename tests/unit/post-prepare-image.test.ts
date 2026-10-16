import { describe, expect, it, vi } from "vitest";
import { MAX_CLIENT_EDGE_PX } from "@/lib/contracts/media";
import { fitWithin, outputTypeFor, prepareImage, PrepareImageError, sniffImage, type ResizeRequest } from "@/lib/listings/client/prepare-image";
import { daysUntil, formatPrice, formatRelativeDays, groupDigits, parsePriceInput } from "@/lib/listings/client/format";
import { photoUrl } from "@/lib/listings/client/photo-url";

// Pure parts of the browser-side photo preparation (design D6). Decoding, the Web Worker and the
// HEIC converter need a real browser: they are exercised by the e2e wizard flow, not here.

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 "), 0, 0, 0, 0]);
const GIF = new Uint8Array([...Buffer.from("GIF89a"), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

function ftyp(major: string, compat: string[]): Uint8Array {
  const size = 16 + compat.length * 4;
  const bytes = [0, 0, 0, size, ...Buffer.from("ftyp"), ...Buffer.from(major), 0, 0, 0, 0];
  for (const brand of compat) bytes.push(...Buffer.from(brand));
  return new Uint8Array(bytes);
}

describe("sniffImage", () => {
  it("recognises the containers from their bytes", () => {
    expect(sniffImage(JPEG)).toBe("jpeg");
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(WEBP)).toBe("webp");
    expect(sniffImage(GIF)).toBe("gif");
    expect(sniffImage(ftyp("heic", ["mif1", "heic"]))).toBe("heic");
    // iPhone HEIC: major brand mif1, hevc in the compatible brands.
    expect(sniffImage(ftyp("mif1", ["mif1", "heic", "hevc"]))).toBe("heic");
    // AVIF carrying mif1 is AVIF, not HEIC.
    expect(sniffImage(ftyp("mif1", ["avif", "miaf"]))).toBe("avif");
    expect(sniffImage(ftyp("avif", ["mif1", "miaf"]))).toBe("avif");
  });

  it("rejects anything else", () => {
    expect(sniffImage(new Uint8Array(Buffer.from("<svg xmlns='x'></svg>")))).toBeNull();
    expect(sniffImage(new Uint8Array(Buffer.from("%PDF-1.7 ......")))).toBeNull();
    expect(sniffImage(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(sniffImage(new Uint8Array(4))).toBeNull();
  });
});

describe("fitWithin", () => {
  it("keeps small images as they are", () => {
    expect(fitWithin(1200, 900)).toEqual({ width: 1200, height: 900, scale: 1 });
    expect(fitWithin(MAX_CLIENT_EDGE_PX, 10)).toEqual({ width: MAX_CLIENT_EDGE_PX, height: 10, scale: 1 });
  });

  it("scales the longest edge down to the limit, landscape or portrait", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 2048, height: 1536, scale: 0.512 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1536, height: 2048, scale: 0.512 });
    const tiny = fitWithin(10000, 1);
    expect(tiny.width).toBe(2048);
    expect(tiny.height).toBe(1);
  });

  it("honours a custom edge", () => {
    expect(fitWithin(1000, 500, 100)).toEqual({ width: 100, height: 50, scale: 0.1 });
  });
});

describe("outputTypeFor", () => {
  it("keeps WebP and converts the rest to JPEG", () => {
    expect(outputTypeFor("webp")).toBe("image/webp");
    expect(outputTypeFor("jpeg")).toBe("image/jpeg");
    expect(outputTypeFor("png")).toBe("image/jpeg");
    expect(outputTypeFor("heic")).toBe("image/jpeg");
  });
});

describe("prepareImage", () => {
  const resized = (size: number) => ({ blob: new Blob([new Uint8Array(size)], { type: "image/jpeg" }), width: 2048, height: 1536 });

  it("sniffs, resizes and reports the output type", async () => {
    const resize = vi.fn(async (request: ResizeRequest) => ({ ...resized(1000), blob: new Blob([new Uint8Array(1000)], { type: request.type }) }));
    const out = await prepareImage(new Blob([JPEG]), { resize });
    expect(out.type).toBe("image/jpeg");
    expect(out.source).toBe("jpeg");
    expect(out.width).toBe(2048);
    expect(resize).toHaveBeenCalledWith(expect.objectContaining({ maxEdge: MAX_CLIENT_EDGE_PX, type: "image/jpeg", quality: 0.85 }));
    const webp = await prepareImage(new Blob([WEBP]), { resize });
    expect(webp.type).toBe("image/webp");
  });

  it("refuses unsupported files before decoding", async () => {
    const resize = vi.fn();
    await expect(prepareImage(new Blob([Buffer.from("<svg></svg>")]), { resize })).rejects.toMatchObject({ code: "unsupported_media" });
    await expect(prepareImage(new Blob([GIF]), { resize })).rejects.toMatchObject({ code: "unsupported_media" });
    expect(resize).not.toHaveBeenCalled();
  });

  it("converts HEIC through the injected converter when the browser cannot decode it", async () => {
    const converted = new Blob([JPEG], { type: "image/jpeg" });
    const convertHeic = vi.fn(async () => converted);
    const resize = vi.fn(async () => resized(500));
    const out = await prepareImage(new Blob([ftyp("mif1", ["mif1", "heic", "hevc"])]), { resize, convertHeic });
    expect(convertHeic).toHaveBeenCalledTimes(1);
    expect(resize.mock.calls[0]?.[0].blob).toBe(converted);
    expect(out.type).toBe("image/jpeg");
  });

  it("maps a converter failure to decode_failed", async () => {
    const convertHeic = vi.fn(async () => {
      throw new Error("libheif");
    });
    await expect(prepareImage(new Blob([ftyp("heic", [])]), { resize: vi.fn(), convertHeic })).rejects.toMatchObject({ code: "decode_failed" });
  });

  it("retries at a lower quality, then rejects a file still above the byte limit", async () => {
    const resize = vi.fn(async () => resized(300));
    await expect(prepareImage(new Blob([JPEG]), { resize, maxBytes: 200 })).rejects.toBeInstanceOf(PrepareImageError);
    expect(resize).toHaveBeenCalledTimes(2);
    expect(resize.mock.calls[1]?.[0].quality).toBe(0.7);
    const ok = vi.fn(async (request: ResizeRequest) => resized(request.quality < 0.85 ? 100 : 300));
    const out = await prepareImage(new Blob([JPEG]), { resize: ok, maxBytes: 200 });
    expect(out.blob.size).toBe(100);
  });

  it("maps a decoder failure to decode_failed", async () => {
    const resize = vi.fn(async () => {
      throw new Error("bad image");
    });
    await expect(prepareImage(new Blob([PNG]), { resize })).rejects.toMatchObject({ code: "decode_failed" });
  });
});

describe("price and date formatting", () => {
  it("groups thousands with a narrow no-break space", () => {
    expect(groupDigits("1500")).toBe("1 500");
    expect(groupDigits("1500000")).toBe("1 500 000");
    expect(groupDigits("007")).toBe("7");
    expect(groupDigits("")).toBe("");
    expect(groupDigits("12")).toBe("12");
  });

  it("parses what people type, Arabic-Indic digits included", () => {
    expect(parsePriceInput("1 500")).toBe(1500);
    expect(parsePriceInput("1.500,00")).toBe(150000);
    expect(parsePriceInput("١٥٠٠")).toBe(1500);
    expect(parsePriceInput("")).toBeNull();
    expect(parsePriceInput("abc")).toBeNull();
  });

  it("formats prices per locale", () => {
    expect(formatPrice(1500, "fr")).toBe("1 500 DH");
    expect(formatPrice(1500, "rif")).toBe("1 500 DH");
    expect(formatPrice(1500, "ar")).toBe("1 500 درهم");
    expect(formatPrice(0, "fr")).toBe("0 DH");
  });

  it("counts days and words them", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    expect(daysUntil(new Date("2026-10-28T12:00:00Z"), now)).toBe(12);
    expect(daysUntil(new Date("2026-10-13T12:00:00Z"), now)).toBe(-3);
    expect(formatRelativeDays(12, "fr")).toBe("dans 12 jours");
    expect(formatRelativeDays(-3, "fr")).toBe("il y a 3 jours");
    expect(formatRelativeDays(1, "fr")).toBe("demain");
    expect(formatRelativeDays(-3, "ar")).toContain("3");
  });

  it("builds variant URLs under the media base", () => {
    expect(photoUrl("https://media.joutiya.ma/", "abcdefgh", "upload0001", "s")).toBe("https://media.joutiya.ma/listings/abcdefgh/upload0001-s.webp");
    expect(photoUrl(null, "abcdefgh", "upload0001", "l")).toBeNull();
  });
});
