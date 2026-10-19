// Browser configuration served at runtime (§2: one image for staging and production, no
// NEXT_PUBLIC_* frozen at build time). Public values only: never a secret here.

export interface PublicFirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  /** Development only: Auth emulator origin, e.g. http://127.0.0.1:9099. */
  authEmulatorUrl?: string;
}

/** Browser-side upload limits (phase 3); the API enforces the same numbers. */
export interface PublicUploadLimits {
  /** Largest accepted file, bytes (after the browser-side resize). */
  maxBytes: number;
  /** Photos per listing for an individual account. */
  maxPhotos: number;
}

/** Interactive map of the listing page (D10): unset when no PMTiles archive is configured. */
export interface PublicMapConfig {
  /** Absolute URL of the Morocco PMTiles archive, fetched with Range requests. */
  pmtilesUrl: string;
  /** Always displayed on the map (OSM data under ODbL). */
  attribution: string;
}

export interface PublicConfig {
  env: "dev" | "staging" | "prod";
  siteUrl: string;
  firebase: PublicFirebaseConfig | null;
  turnstileSiteKey: string | null;
  /** OAuth web client id of Google Identity Services (Google sign-in); null disables the button. */
  googleClientId: string | null;
  sentry: { dsn: string; environment: string; release: string } | null;
  /** Origin (plus path) photos are served from, without a trailing slash; null until storage exists. */
  mediaBaseUrl: string | null;
  upload: PublicUploadLimits;
  map: PublicMapConfig | null;
  /** True when a WhatsApp phone check can be started (§9); false hides the verification calls to action. */
  phoneVerification: boolean;
}
