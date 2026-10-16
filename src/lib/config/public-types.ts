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

export interface PublicConfig {
  env: "dev" | "staging" | "prod";
  siteUrl: string;
  firebase: PublicFirebaseConfig | null;
  turnstileSiteKey: string | null;
  /** OAuth web client id of Google Identity Services (Google sign-in); null disables the button. */
  googleClientId: string | null;
  sentry: { dsn: string; environment: string; release: string } | null;
}
