import "server-only";
import { serverEnv, type ServerEnv } from "@/lib/env";
import type { PublicConfig } from "./public-types";

export type { PublicConfig, PublicFirebaseConfig } from "./public-types";

/** The browser's configuration, built from the server environment at request time. */
export function publicConfig(env: ServerEnv = serverEnv()): PublicConfig {
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
    sentry: env.SENTRY_DSN ? { dsn: env.SENTRY_DSN, environment: env.APP_ENV, release: env.RELEASE ?? "dev" } : null,
  };
}
