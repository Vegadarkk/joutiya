// MapLibre GL 6 requires WebGL2: checked before the map chunk is even downloaded (client only).

let cached: boolean | undefined;

export function supportsWebGL2(): boolean {
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    cached = Boolean(canvas.getContext("webgl2"));
  } catch {
    cached = false;
  }
  return cached;
}
