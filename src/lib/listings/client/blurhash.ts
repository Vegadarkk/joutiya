import { decode } from "blurhash";

// Blurhash placeholder as a data URL (img-src allows data:), decoded once per hash at 32x32.

const cache = new Map<string, string | null>();

export function blurhashDataUrl(hash: string | undefined, width = 32, height = 24): string | null {
  if (!hash || typeof document === "undefined") return null;
  const key = `${hash}:${width}x${height}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let url: string | null = null;
  try {
    const pixels = decode(hash, width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context) {
      const image = context.createImageData(width, height);
      image.data.set(pixels);
      context.putImageData(image, 0, 0);
      url = canvas.toDataURL();
    }
  } catch {
    url = null;
  }
  cache.set(key, url);
  return url;
}
