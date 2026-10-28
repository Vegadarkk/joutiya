import "server-only";
import { DEFAULT_FLAGS, type FlagsConfig } from "@/config/flags";
import { MAX_PHOTOS_INDIVIDUAL, MAX_UPLOAD_BYTES } from "@/lib/contracts/media";
import { serverEnv, type ServerEnv } from "@/lib/env";
import { isPhoneVerificationConfigured } from "@/lib/phone-verify/config";
import { mediaBaseUrl } from "@/lib/storage/keys";
import type { PublicConfig } from "./public-types";

export type { PublicConfig, PublicFirebaseConfig, PublicMapConfig, PublicUploadLimits } from "./public-types";

/** Upload limits shown to the browser; the API enforces the same constants (design §3). */
const UPLOAD_LIMITS = { maxBytes: MAX_UPLOAD_BYTES, maxPhotos: MAX_PHOTOS_INDIVIDUAL } as const;

/** OSM data (ODbL) through Protomaps: shown on every map (D10). */
export const MAP_ATTRIBUTION = "© OpenStreetMap contributors · Protomaps";

/**
 * The browser's configuration, built from the server environment at request time; the ad flags
 * come from config/flags (getFlags), the defaults (ads off) when the caller has none.
 */
export function publicConfig(env: ServerEnv = serverEnv(), flags: Pick<FlagsConfig, "adsMode" | "adsCmpEea"> = DEFAULT_FLAGS): PublicConfig {
  const { FIREBASE_API_KEY: apiKey, FIREBASE_PROJECT_ID: projectId, FIREBASE_APP_ID: appId } = env;
  const emulator = env.APP_ENV === "dev" && env.FIREBASE_AUTH_EMULATOR_HOST ? `http://${env.FIREBASE_AUTH_EMULATOR_HOST}` : undefined;
  const firebase =
    apiKey && projectId
      ? {
          apiKey,
          projectId,
          appId: appId ?? "",
          authDomain: env.FIREBASE_AUTH_DOMAIN ?? `${projectId}.firebaseapp.com`,
          ...(emulator ? { authEmulatorUrl: emulator } : {}),
        }
      : null;
  return {
    env: env.APP_ENV,
    siteUrl: new URL(env.SITE_URL).origin,
    firebase,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
    googleClientId: env.GOOGLE_OAUTH_CLIENT_ID ?? null,
    sentry: env.SENTRY_DSN ? { dsn: env.SENTRY_DSN, environment: env.APP_ENV, release: env.RELEASE ?? "dev" } : null,
    // R2 keys and bucket names never leave the server: only the public media host is shared.
    mediaBaseUrl: mediaBaseUrl(env),
    upload: { ...UPLOAD_LIMITS },
    map: env.MAP_PMTILES_URL ? { pmtilesUrl: env.MAP_PMTILES_URL, attribution: MAP_ATTRIBUTION } : null,
    phoneVerification: isPhoneVerificationConfigured(env),
    ads: {
      mode: flags.adsMode,
      cmpEea: flags.adsCmpEea,
      client: env.ADSENSE_CLIENT_ID ?? null,
      units: { leaderboard: env.AD_SLOT_LEADERBOARD ?? null, halfpage: env.AD_SLOT_HALFPAGE ?? null, rectangle: env.AD_SLOT_RECTANGLE ?? null, banner: env.AD_SLOT_BANNER ?? null },
    },
  };
}
