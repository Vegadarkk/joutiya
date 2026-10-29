// Browser configuration served at runtime (§2: one image for staging and production, no
// NEXT_PUBLIC_* frozen at build time). Public values only: never a secret here.

/**
 * The Firebase project, checked by scripts/launch-check.ts. No Web API key: the browser has no
 * Firebase SDK, and a published key would let anyone call Identity Toolkit directly (password
 * guessing, reset mails, sign-ups) past the API's limits and Turnstile (security review, M2).
 */
export interface PublicFirebaseConfig {
  projectId: string;
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

/** Advertising and consent (phase 6, D2 and D8): flags from config/flags, publisher id from the environment. */
export interface PublicAdsConfig {
  /** "off": no ad script and no cookie banner; "test": test ads; "live": real ads. */
  mode: "off" | "test" | "live";
  /** Google's consent message handles EEA/UK/CH visitors (D5). */
  cmpEea: boolean;
  /** AdSense publisher id (ca-pub-…), null while unset. */
  client: string | null;
  /** Ad unit id per slot format (src/config/ads.ts), null while unset. */
  units: Record<"leaderboard" | "halfpage" | "rectangle" | "banner", string | null>;
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
  ads: PublicAdsConfig;
}
