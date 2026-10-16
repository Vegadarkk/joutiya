// Content Security Policy builder (architecture §6, XSS row). Pure: no env access, so the
// proxy, next.config.ts and the tests share it.
//
// Two variants:
// - "private" (account, auth, Pro, back office): dynamic rendering, per-request nonce + 'strict-dynamic'.
// - "public" (anonymous ISR pages cached by Cloudflare): no nonce, since the HTML is shared.
//   Script chunks carry SRI integrity attributes (experimental.sri); see publicScriptSources.

export type CspVariant = "public" | "private";

/** Proxy -> server hook marker: "hash the inline scripts of this HTML response". Never sent to clients. */
export const INLINE_HASH_MARKER = "x-csp-inline-hashes";

export interface CspOptions {
  variant: CspVariant;
  /** Required for the private variant: base64 nonce of this request. */
  nonce?: string;
  /** `next dev` needs 'unsafe-eval' (React error overlays) and no upgrade of http://localhost. */
  dev?: boolean;
  /** Public media host, e.g. https://media.joutiya.ma. */
  mediaOrigin?: string;
  /** R2 S3 host for presigned uploads, e.g. https://<account>.eu.r2.cloudflarestorage.com. */
  r2Origin?: string;
  /** Host of the PMTiles archive the interactive map fetches with Range requests (D10), if configured. */
  tilesOrigin?: string;
  /** Error-reporting ingest origin (Sentry EU), if configured. */
  errorIngestOrigin?: string;
  /** Development only: Firebase Auth emulator origin the browser SDK talks to. */
  authEmulatorOrigin?: string;
  /** Same-origin endpoint receiving violation reports. */
  reportPath?: string;
  /** Adds upgrade-insecure-requests (default: outside dev). Off for a plain-http local server. */
  upgradeInsecure?: boolean;
}

/** Hosts the browser talks to directly (§3 trust zone 1): Firebase Auth and Firestore realtime. */
const FIREBASE_ORIGINS = [
  "https://identitytoolkit.googleapis.com",
  "https://securetoken.googleapis.com",
  "https://firestore.googleapis.com",
];
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
/** Google Identity Services (Google sign-in, phase 2): script, button iframe, style sheet. */
const GIS_SCRIPT = "https://accounts.google.com/gsi/client";
const GIS_FRAME = "https://accounts.google.com/gsi/";
const GIS_STYLE = "https://accounts.google.com/gsi/style";

function origin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.protocol === "https:" || local ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function compact(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/** 16 random bytes, base64: unguessable and unique per request. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildCsp(options: CspOptions): string {
  const { variant, dev = false } = options;
  if (variant === "private" && !options.nonce) throw new Error("buildCsp: the private variant needs a nonce");

  // Private: nonce + 'strict-dynamic'. The https: and 'unsafe-inline' sources are ignored by
  // CSP3 browsers once a nonce is present; they only keep CSP1 browsers working.
  // Public: Next.js inlines the RSC payload as <script> tags whose content changes with each
  // render, so they cannot be pinned at build time; chunks are pinned by SRI instead.
  // Turnstile and GIS are loaded by <script nonce> tags on private pages ('strict-dynamic' then
  // ignores host sources); the hosts stay listed for CSP2 browsers and the public variant.
  // 'wasm-unsafe-eval' (private only, D13): the HEIC converter of the listing wizard runs in
  // WebAssembly; it never ships on public pages, whose script-src the hash hook rebuilds anyway.
  const scriptSrc =
    variant === "private"
      ? [`'nonce-${options.nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'", "https:", "'unsafe-inline'"]
      : ["'self'", "'unsafe-inline'", TURNSTILE_ORIGIN, GIS_SCRIPT];
  if (dev) scriptSrc.push("'unsafe-eval'");

  const media = origin(options.mediaOrigin);
  // MapLibre fetches PMTiles with fetch + Range (connect-src) and draws raster sprites as images.
  const tiles = origin(options.tilesOrigin);
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    // Radix and Sonner set inline style attributes; a nonce cannot cover attributes.
    "style-src": ["'self'", "'unsafe-inline'", GIS_STYLE],
    "img-src": compact(["'self'", "data:", "blob:", media, tiles]),
    "font-src": ["'self'"],
    "connect-src": compact([
      "'self'",
      ...FIREBASE_ORIGINS,
      GIS_FRAME,
      origin(options.r2Origin),
      tiles,
      origin(options.errorIngestOrigin),
      origin(options.authEmulatorOrigin),
      dev ? "ws:" : undefined,
    ]),
    // Turnstile widget and the Google sign-in button (GIS) render in iframes.
    "frame-src": ["'self'", TURNSTILE_ORIGIN, GIS_FRAME],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "media-src": compact(["'self'", media]),
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  if (options.reportPath) directives["report-uri"] = [options.reportPath];

  const parts = Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`);
  if (options.reportPath) parts.push("report-to csp");
  if (options.upgradeInsecure ?? !dev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}
