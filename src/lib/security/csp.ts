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
  /**
   * Private variant: base64 SHA-256 of constant inline scripts rendered without the nonce (the
   * theme script of a public layout on a dynamic public page). Hashes stay valid under 'strict-dynamic'.
   */
  scriptHashes?: readonly string[];
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
  /** Development only: Firebase Auth emulator origin (no browser code calls it since phase 5 D2). */
  authEmulatorOrigin?: string;
  /** Same-origin endpoint receiving violation reports. */
  reportPath?: string;
  /** Adds upgrade-insecure-requests (default: outside dev). Off for a plain-http local server. */
  upgradeInsecure?: boolean;
  /**
   * AdSense hosts (phase 6, D10), only once a publisher id is configured. "strict": the listed
   * hosts only (the report-only twin); "broad": also any https image and frame (ad creatives come
   * from advertisers' own hosts), the enforced policy until reports settle the list.
   */
  ads?: "strict" | "broad";
}

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
/** Google Identity Services (Google sign-in, phase 2): script, button iframe, style sheet. */
const GIS_SCRIPT = "https://accounts.google.com/gsi/client";
const GIS_FRAME = "https://accounts.google.com/gsi/";
const GIS_STYLE = "https://accounts.google.com/gsi/style";

// AdSense (phase 6, D10). Only the loader host is documented; the rest is the initial guess that
// the report-only twin confirms or corrects before the list is fixed.
export const ADSENSE_SCRIPT_HOSTS: readonly string[] = [
  "https://pagead2.googlesyndication.com",
  "https://tpc.googlesyndication.com",
  "https://*.adtrafficquality.google",
  "https://fundingchoicesmessages.google.com",
];
const ADSENSE_FRAME_HOSTS = [
  "https://googleads.g.doubleclick.net",
  "https://tpc.googlesyndication.com",
  "https://*.adtrafficquality.google",
  "https://www.google.com",
  "https://fundingchoicesmessages.google.com",
];
const ADSENSE_IMG_HOSTS = ["https://pagead2.googlesyndication.com", "https://tpc.googlesyndication.com", "https://googleads.g.doubleclick.net", "https://www.google.com", "https://*.adtrafficquality.google"];
const ADSENSE_CONNECT_HOSTS = ["https://pagead2.googlesyndication.com", "https://googleads.g.doubleclick.net", "https://*.adtrafficquality.google", "https://fundingchoicesmessages.google.com"];

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
      ? [
          `'nonce-${options.nonce}'`,
          ...(options.scriptHashes ?? []).map((hash) => `'sha256-${hash}'`),
          "'strict-dynamic'",
          "'wasm-unsafe-eval'",
          "https:",
          "'unsafe-inline'",
        ]
      : ["'self'", "'unsafe-inline'", TURNSTILE_ORIGIN, GIS_SCRIPT];
  if (dev) scriptSrc.push("'unsafe-eval'");
  const ads = options.ads;
  if (ads) scriptSrc.push(...ADSENSE_SCRIPT_HOSTS);
  const adHosts = (hosts: readonly string[]): string[] => (!ads ? [] : ads === "broad" ? [...hosts, "https:"] : [...hosts]);

  const media = origin(options.mediaOrigin);
  // MapLibre fetches PMTiles with fetch + Range (connect-src) and draws raster sprites as images.
  const tiles = origin(options.tilesOrigin);
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    // Radix and Sonner set inline style attributes; a nonce cannot cover attributes.
    "style-src": ["'self'", "'unsafe-inline'", GIS_STYLE],
    "img-src": compact(["'self'", "data:", "blob:", media, tiles, ...adHosts(ADSENSE_IMG_HOSTS)]),
    "font-src": ["'self'"],
    "connect-src": compact([
      "'self'",
      GIS_FRAME,
      origin(options.r2Origin),
      tiles,
      origin(options.errorIngestOrigin),
      origin(options.authEmulatorOrigin),
      dev ? "ws:" : undefined,
      ...(ads ? ADSENSE_CONNECT_HOSTS : []),
    ]),
    // Turnstile widget and the Google sign-in button (GIS) render in iframes.
    "frame-src": ["'self'", TURNSTILE_ORIGIN, GIS_FRAME, ...adHosts(ADSENSE_FRAME_HOSTS)],
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
