import { MAX_CLIENT_EDGE_PX, MAX_UPLOAD_BYTES, type UploadDeclaredType } from "@/lib/contracts/media";

// Browser-side photo preparation (design D6): sniff the real type, convert HEIC/HEIF, resize so
// the longest edge is <= 2048 px, re-encode as JPEG q0.85 (WebP when the source is WebP). The
// canvas re-encode drops EXIF (GPS included) by construction. Heavy work runs in a module Web
// Worker (createImageBitmap + OffscreenCanvas); the main thread is the fallback. The pure parts
// (sniffing, dimension maths, output type) are unit-tested; decoding needs a browser.

export type SniffedImage = "jpeg" | "png" | "webp" | "gif" | "heic" | "avif";

/** Accepted by the file input; the real type is sniffed from the bytes, never trusted from the name. */
export const ACCEPTED_INPUT_TYPES = "image/jpeg,image/png,image/webp,image/heic,image/heif";
/** Browsers hand HEIC over under these MIME types (or none at all). */
export const HEIC_MIME_TYPES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"] as const;

export const JPEG_QUALITY = 0.85;
/** Second attempt when the first encode is still above the byte limit. */
const FALLBACK_QUALITY = 0.7;

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

/** The image container of the first bytes (64 are enough), or null for anything else. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (ascii(bytes, 4, 4) === "ftyp") {
    const size = ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
    const end = Math.min(bytes.length, size > 16 ? size : bytes.length);
    const brands = [ascii(bytes, 8, 4)];
    for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(ascii(bytes, offset, 4));
    // AVIF first: an AVIF can carry `mif1` as major brand.
    if (brands.some((brand) => AVIF_BRANDS.has(brand))) return "avif";
    if (brands.some((brand) => HEIC_BRANDS.has(brand))) return "heic";
  }
  return null;
}

/** Downscale so the longest edge is at most `maxEdge`; never upscales. Integer pixels, at least 1. */
export function fitWithin(width: number, height: number, maxEdge: number = MAX_CLIENT_EDGE_PX): { width: number; height: number; scale: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest <= 0) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), scale: 1 };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

/** What the browser sends: WebP stays WebP; everything else (JPEG, PNG, HEIC, AVIF) becomes JPEG. */
export function outputTypeFor(source: SniffedImage): UploadDeclaredType {
  return source === "webp" ? "image/webp" : "image/jpeg";
}

export type PrepareErrorCode = "unsupported_media" | "file_too_large" | "decode_failed";

export class PrepareImageError extends Error {
  readonly code: PrepareErrorCode;
  constructor(code: PrepareErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PrepareImageError";
    this.code = code;
  }
}

export interface PreparedImage {
  blob: Blob;
  type: UploadDeclaredType;
  width: number;
  height: number;
  source: SniffedImage;
}

export interface ResizeRequest {
  blob: Blob;
  maxEdge: number;
  type: UploadDeclaredType;
  quality: number;
}

export interface ResizeResult {
  blob: Blob;
  width: number;
  height: number;
}

export type Resizer = (request: ResizeRequest) => Promise<ResizeResult>;

export interface PrepareOptions {
  maxEdge?: number;
  maxBytes?: number;
  quality?: number;
  /** Injected in tests; defaults to the worker (or the main thread without OffscreenCanvas). */
  resize?: Resizer;
  /** Injected in tests; defaults to the lazy heic-to converter. */
  convertHeic?: (blob: Blob) => Promise<Blob>;
}

export async function readHead(blob: Blob, length = 64): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(0, length).arrayBuffer());
}

/** Prepares one photo for upload; throws PrepareImageError with a translatable code. */
export async function prepareImage(file: Blob, options: PrepareOptions = {}): Promise<PreparedImage> {
  const maxEdge = options.maxEdge ?? MAX_CLIENT_EDGE_PX;
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const quality = options.quality ?? JPEG_QUALITY;
  const resize = options.resize ?? defaultResizer;
  const source = sniffImage(await readHead(file));
  if (!source || source === "gif") throw new PrepareImageError("unsupported_media");
  const type = outputTypeFor(source);

  let input: Blob = file;
  if (source === "heic" || source === "avif") {
    // Native decode first (Safari 17+), the WASM converter only when the browser cannot.
    if (!(await canDecodeNatively(file))) {
      const convert = options.convertHeic ?? convertHeicWithLibrary;
      try {
        input = await convert(file);
      } catch {
        throw new PrepareImageError("decode_failed");
      }
    }
  }

  let result: ResizeResult;
  try {
    result = await resize({ blob: input, maxEdge, type, quality });
    if (result.blob.size > maxBytes && quality > FALLBACK_QUALITY) {
      result = await resize({ blob: input, maxEdge, type, quality: FALLBACK_QUALITY });
    }
  } catch {
    throw new PrepareImageError("decode_failed");
  }
  if (result.blob.size > maxBytes) throw new PrepareImageError("file_too_large");
  return { blob: result.blob, type, width: result.width, height: result.height, source };
}

async function canDecodeNatively(blob: Blob): Promise<boolean> {
  if (typeof createImageBitmap !== "function") return false;
  try {
    const bitmap = await createImageBitmap(blob);
    bitmap.close();
    return true;
  } catch {
    return false;
  }
}

/** heic-to (LGPL-3.0), CSP build (no `new Function`); loaded only when a HEIC needs converting. */
async function convertHeicWithLibrary(blob: Blob): Promise<Blob> {
  const { heicTo } = await import("heic-to/csp");
  return heicTo({ blob, type: "image/jpeg", quality: 0.92 });
}

// --- Resizers ---------------------------------------------------------------------------------

function supportsWorkerResize(): boolean {
  return typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function";
}

let worker: Worker | null = null;
let nextRequestId = 1;
const waiting = new Map<number, { resolve: (result: ResizeResult) => void; reject: (error: Error) => void }>();

type WorkerAnswer = { id: number; ok: true; blob: Blob; width: number; height: number } | { id: number; ok: false; error: string };

function getWorker(): Worker {
  if (worker) return worker;
  // Bundled by Turbopack as a module worker; `worker-src 'self'` allows it.
  worker = new Worker(new URL("./resize.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerAnswer>) => {
    const answer = event.data;
    const entry = waiting.get(answer.id);
    if (!entry) return;
    waiting.delete(answer.id);
    if (answer.ok) entry.resolve({ blob: answer.blob, width: answer.width, height: answer.height });
    else entry.reject(new Error(answer.error));
  };
  worker.onerror = () => {
    // The worker died: fail what is waiting and rebuild it on the next request.
    for (const entry of waiting.values()) entry.reject(new Error("worker failed"));
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function resizeInWorker(request: ResizeRequest): Promise<ResizeResult> {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ id, ...request });
  });
}

/** Main thread: a detached <canvas>; used when OffscreenCanvas or Worker is missing. */
export async function resizeOnMainThread(request: ResizeRequest): Promise<ResizeResult> {
  const bitmap = await createImageBitmap(request.blob, { imageOrientation: "from-image" });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, request.maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, request.type, request.quality));
    if (!blob) throw new Error("encode failed");
    return { blob, width, height };
  } finally {
    bitmap.close();
  }
}

export async function defaultResizer(request: ResizeRequest): Promise<ResizeResult> {
  if (supportsWorkerResize()) {
    try {
      return await resizeInWorker(request);
    } catch {
      // Fall through: the main thread decodes what the worker could not (or the worker failed to start).
    }
  }
  return resizeOnMainThread(request);
}
