import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ACCEPTED_IMAGE_TYPES, checkImageType, isAcceptedImageType, SNIFF_BYTES, sniffImageType } from "@/lib/media/magic";

// Real-type sniffing from magic bytes (research/libs-media.md §7): fixtures are generated at test
// time by sharp or built by hand (ISO-BMFF boxes), nothing binary is committed.

const base = () => sharp({ create: { width: 16, height: 8, channels: 3, background: { r: 10, g: 120, b: 200 } } });

/** An ISO-BMFF ftyp box: size, "ftyp", major brand, minor version, compatible brands. */
function ftyp(major: string, compatible: string[]): Uint8Array {
  const size = 16 + compatible.length * 4;
  const box = Buffer.alloc(size + 16, 0);
  box.writeUInt32BE(size, 0);
  box.write("ftyp", 4, "latin1");
  box.write(major, 8, "latin1");
  box.writeUInt32BE(0, 12);
  compatible.forEach((brand, index) => box.write(brand, 16 + index * 4, "latin1"));
  return new Uint8Array(box);
}

describe("sniffImageType", () => {
  it("recognises JPEG, PNG and WebP produced by sharp, from the first 256 bytes only", async () => {
    const jpeg = await base().jpeg().toBuffer();
    const png = await base().png().toBuffer();
    const webp = await base().webp().toBuffer();
    expect(sniffImageType(jpeg)).toBe("image/jpeg");
    expect(sniffImageType(png)).toBe("image/png");
    expect(sniffImageType(webp)).toBe("image/webp");
    expect(sniffImageType(new Uint8Array(jpeg.subarray(0, SNIFF_BYTES)))).toBe("image/jpeg");
    expect(sniffImageType(new Uint8Array(webp.subarray(0, 12)))).toBe("image/webp");
  });

  it("names GIF, AVIF and HEIC so the caller can reject them explicitly", async () => {
    const gif = await base().gif().toBuffer();
    expect(sniffImageType(gif)).toBe("image/gif");
    expect(gif.subarray(0, 6).toString("latin1")).toMatch(/^GIF8[79]a$/);
    const avif = await base().avif({ effort: 0 }).toBuffer();
    expect(sniffImageType(avif)).toBe("image/avif");
    // iPhone-style HEIC: major brand mif1, HEVC in the compatible brands.
    expect(sniffImageType(ftyp("mif1", ["mif1", "heic", "hevc"]))).toBe("image/heic");
    expect(sniffImageType(ftyp("heic", []))).toBe("image/heic");
    expect(sniffImageType(ftyp("heix", ["mif1"]))).toBe("image/heic");
    // AVIF wins over the shared mif1 brand, whatever the major brand says.
    expect(sniffImageType(ftyp("mif1", ["avif", "miaf"]))).toBe("image/avif");
    expect(sniffImageType(ftyp("avif", ["mif1", "miaf"]))).toBe("image/avif");
    expect(sniffImageType(ftyp("avis", []))).toBe("image/avif");
  });

  it("returns null for anything else: SVG, TIFF, PDF, zip, text, short buffers", async () => {
    const tiff = await base().tiff().toBuffer();
    expect(sniffImageType(tiff)).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("%PDF-1.4 ... obj endobj"))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("PK\u0003\u0004 zip local file header"))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("<?php echo 1; ?> and more"))).toBeNull();
    expect(sniffImageType(ftyp("isom", ["mp41"]))).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
    expect(sniffImageType(new Uint8Array(32))).toBeNull();
  });
});

describe("checkImageType", () => {
  it("accepts JPEG, PNG and WebP only when the declared type matches the bytes", async () => {
    const jpeg = await base().jpeg().toBuffer();
    const png = await base().png().toBuffer();
    expect(checkImageType(jpeg, "image/jpeg")).toEqual({ type: "image/jpeg" });
    expect(checkImageType(png, "image/png")).toEqual({ type: "image/png" });
    expect(checkImageType(jpeg, "image/png")).toEqual({ reason: "bad_type" });
    expect(checkImageType(png, "image/jpeg")).toEqual({ reason: "bad_type" });
  });

  it("rejects every other real type, whatever the client declared", async () => {
    const gif = await base().gif().toBuffer();
    expect(checkImageType(gif, "image/jpeg")).toEqual({ reason: "bad_type" });
    expect(checkImageType(gif, "image/gif")).toEqual({ reason: "bad_type" });
    expect(checkImageType(ftyp("mif1", ["heic"]), "image/jpeg")).toEqual({ reason: "bad_type" });
    expect(checkImageType(new TextEncoder().encode("<svg></svg>"), "image/svg+xml")).toEqual({ reason: "bad_type" });
    expect(isAcceptedImageType("image/gif")).toBe(false);
    expect(isAcceptedImageType(null)).toBe(false);
    expect(ACCEPTED_IMAGE_TYPES).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });
});
