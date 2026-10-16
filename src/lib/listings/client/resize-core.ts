import { fitWithin } from "./prepare-image";

// Shared by the Web Worker and the main-thread fallback: decode, downscale, re-encode. The
// re-encoded bytes come from the decoded pixels only: EXIF, XMP, ICC and GPS never survive.

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
