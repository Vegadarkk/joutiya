// Shared by the Web Worker and the main-thread fallback: decode, downscale, re-encode. The
// re-encoded bytes come from the decoded pixels only: EXIF, XMP, ICC and GPS never survive.
// Dependency-free on purpose: the worker bundle carries nothing else.

/** Downscale so the longest edge is at most `maxEdge`; never upscales. Integer pixels, at least 1. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest <= 0) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), scale: 1 };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

export interface CanvasResizeInput {
  blob: Blob;
  maxEdge: number;
  type: string;
  quality: number;
}

export async function resizeWithOffscreenCanvas({ blob, maxEdge, type, quality }: CanvasResizeInput): Promise<{ blob: Blob; width: number; height: number }> {
  // `from-image` applies the EXIF orientation before the tag disappears with the re-encode.
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const out = await canvas.convertToBlob({ type, quality });
    return { blob: out, width, height };
  } finally {
    bitmap.close();
  }
}
