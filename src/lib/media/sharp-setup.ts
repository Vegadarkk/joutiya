import "server-only";
import sharp, { type Sharp, type SharpOptions } from "sharp";

// One hardened sharp for the whole process (research/libs-media.md §1, §8): no cache (bounded
// memory, one image at a time), a loader allowlist so libvips never parses SVG, TIFF, GIF, PDF or
// HEIF from our buffers, and a pixel cap on every call so a 109 KB "PNG" announcing 900 MP is
// refused from its header. Buffer inputs only: the file loaders stay blocked.

export const MAX_INPUT_PIXELS = 64_000_000;
/** Seconds a single pipeline may run before libvips aborts it. */
export const PIPELINE_TIMEOUT_SECONDS = 10;

sharp.cache(false);
sharp.concurrency(1);
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({ operation: ["VipsForeignLoadJpegBuffer", "VipsForeignLoadPngBuffer", "VipsForeignLoadWebpBuffer"] });

/** Constructor options of every sharp() call on untrusted input. */
export const INPUT_OPTIONS = {
  limitInputPixels: MAX_INPUT_PIXELS,
  failOn: "error",
  sequentialRead: true,
  animated: false,
  pages: 1,
} as const satisfies SharpOptions;

/** A hardened pipeline on an untrusted buffer: options above plus the timeout. */
export function openImage(input: Buffer): Sharp {
  return sharp(input, INPUT_OPTIONS).timeout({ seconds: PIPELINE_TIMEOUT_SECONDS });
}

export { sharp };
