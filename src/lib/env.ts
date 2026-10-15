import "server-only";
import { z } from "zod";

// Server environment (§9). Values are read once and never logged. Staging and production
// require what they cannot run without; development falls back to local defaults.
// No NEXT_PUBLIC_* variable exists: one image serves staging and production, and the browser
// receives its configuration at runtime (src/lib/config/public.ts, §2).

const optional = z.string().trim().optional().transform((value) => (value ? value : undefined));
const flag = z
  .string()
  .trim()
  .optional()
  .transform((value) => value === "true");

const schema = z.object({
  APP_ENV: z.enum(["dev", "staging", "prod"]).default("dev"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  /** Public origin of this environment: https://joutiya.ma, https://staging.joutiya.ma. */
  SITE_URL: z.url().default("http://localhost:3000"),
  ADMIN_HOST: optional,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  RELEASE: optional,
  CSP_REPORT_ONLY: flag,
  QUEUE_REDIS_URL: optional,
  RATE_LIMIT_REDIS_URL: optional,
  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_CHAT_ID: optional,
  ALERT_RELAY_URL: optional,
  ALERT_RELAY_SECRET: optional,
  HASH_PEPPER: optional,
  CSRF_SECRET: optional,
  // Firebase: browser configuration (public by design) and the Admin SDK.
  FIREBASE_PROJECT_ID: optional,
  FIREBASE_API_KEY: optional,
  FIREBASE_APP_ID: optional,
  /** joutiya.ma (or staging.joutiya.ma) behind the /__/auth/* relay of src/proxy.ts. */
  FIREBASE_AUTH_DOMAIN: optional,
  /** joutiya-web@<project>.iam.gserviceaccount.com: signs custom tokens through IAM, no key. */
  FIREBASE_SERVICE_ACCOUNT: optional,
  FIRESTORE_EMULATOR_HOST: optional,
  FIREBASE_AUTH_EMULATOR_HOST: optional,
  GOOGLE_APPLICATION_CREDENTIALS: optional,
  /** OAuth web client of the Firebase Google provider: audience of Google ID tokens. */
  GOOGLE_OAUTH_CLIENT_ID: optional,
  CF_ACCESS_TEAM_DOMAIN: optional,
  CF_ACCESS_AUD: optional,
  TURNSTILE_SITE_KEY: optional,
  TURNSTILE_SECRET_KEY: optional,
  MEDIA_BASE_URL: optional,
  R2_S3_ENDPOINT: optional,
  MAIL_PROVIDER: z.enum(["resend"]).default("resend"),
  MAIL_API_KEY: optional,
  MAIL_WEBHOOK_SECRET: optional,
  MAIL_FALLBACK_API_KEY: optional,
  MAIL_FROM: z.string().trim().default("Joutiya <no-reply@notif.joutiya.ma>"),
  WHATSAPP_PHONE_NUMBER_ID: optional,
  WHATSAPP_APP_SECRET: optional,
  WHATSAPP_VERIFY_TOKEN: optional,
  /** Joutiya's WhatsApp number in international format, digits only (wa.me link). */
  WHATSAPP_DISPLAY_NUMBER: optional,
  SENTRY_DSN: optional,
  /** Development only: keeps sent e-mails in memory, readable at /api/dev/mailbox (e2e tests). */
  DEV_MAILBOX: flag,
});

export type ServerEnv = z.infer<typeof schema>;
export type AppEnv = ServerEnv["APP_ENV"];

/**
 * Variables without which staging and production must not start. The identifiers checked
 * against infra/targets.json (FIREBASE_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS,
 * CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD) are required by STRICT_REQUIRED in
 * scripts/assert-target.ts instead: one list per variable.
 */
export const REQUIRED_DEPLOYED = [
  "ADMIN_HOST",
  "QUEUE_REDIS_URL",
  "RATE_LIMIT_REDIS_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "ALERT_RELAY_URL",
  "ALERT_RELAY_SECRET",
  "HASH_PEPPER",
  "CSRF_SECRET",
  "FIREBASE_API_KEY",
  "FIREBASE_APP_ID",
  "FIREBASE_AUTH_DOMAIN",
  "FIREBASE_SERVICE_ACCOUNT",
  "GOOGLE_OAUTH_CLIENT_ID",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "MAIL_API_KEY",
  "MAIL_WEBHOOK_SECRET",
] as const satisfies readonly (keyof ServerEnv)[];

/** Features that degrade (with a startup warning) instead of stopping the app when unset. */
export const RECOMMENDED_DEPLOYED = [
  "MAIL_FALLBACK_API_KEY",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_DISPLAY_NUMBER",
  "SENTRY_DSN",
] as const satisfies readonly (keyof ServerEnv)[];

/** Cloudflare's documented dummy Turnstile keys: never in production. */
const TURNSTILE_TEST_KEY = /^[123]x0{20,}/;

function hostOf(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

export interface ParsedEnv {
  env: ServerEnv;
  errors: string[];
  warnings: string[];
}

export function parseEnv(source: Record<string, string | undefined>): ParsedEnv {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Keep every valid value: only the invalid ones fall back to their defaults.
    errors.push(...parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    const invalid = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
    parsed = schema.safeParse(Object.fromEntries(Object.entries(source).filter(([name]) => !invalid.has(name))));
  }
  const env = parsed.success ? parsed.data : schema.parse({});

  const legacy = Object.keys(source).filter((name) => name.startsWith("NEXT_PUBLIC_") && source[name]);
  if (env.APP_ENV !== "dev") {
    for (const name of REQUIRED_DEPLOYED) if (!env[name]) errors.push(`${name} is required when APP_ENV=${env.APP_ENV}`);
    for (const name of RECOMMENDED_DEPLOYED) if (!env[name]) warnings.push(`${name} is not set: the feature that needs it is unavailable`);
    if (!env.SITE_URL.startsWith("https://")) errors.push("SITE_URL must be https outside dev");
    if (env.FIRESTORE_EMULATOR_HOST) errors.push("FIRESTORE_EMULATOR_HOST must not be set outside dev");
    if (env.FIREBASE_AUTH_EMULATOR_HOST) errors.push("FIREBASE_AUTH_EMULATOR_HOST must not be set outside dev");
    if (env.DEV_MAILBOX) errors.push("DEV_MAILBOX must not be set outside dev");
    for (const name of ["HASH_PEPPER", "CSRF_SECRET"] as const) {
      const value = env[name];
      if (value && value.length < 32) errors.push(`${name} must be at least 32 characters`);
    }
    if (env.HASH_PEPPER && env.HASH_PEPPER === env.CSRF_SECRET) errors.push("HASH_PEPPER and CSRF_SECRET must differ");
    // §2: error tracking stays in the EU region (owner's choice of 2026-10-13).
    if (env.SENTRY_DSN && !hostOf(env.SENTRY_DSN)?.endsWith(".ingest.de.sentry.io")) {
      errors.push("SENTRY_DSN must use the EU region (*.ingest.de.sentry.io)");
    }
    if (env.APP_ENV === "prod" && (TURNSTILE_TEST_KEY.test(env.TURNSTILE_SITE_KEY ?? "") || TURNSTILE_TEST_KEY.test(env.TURNSTILE_SECRET_KEY ?? ""))) {
      errors.push("TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must not be Cloudflare test keys in prod");
    }
    // A leftover phase 1 name would be silently ignored: refuse it so the rename is not missed.
    for (const name of legacy) errors.push(`${name} is no longer read: use ${name.replace("NEXT_PUBLIC_", "")} (runtime configuration)`);
  } else if (legacy.length > 0) {
    warnings.push(`ignored NEXT_PUBLIC_* variables (runtime configuration): ${legacy.join(", ")}`);
  }
  return { env, errors, warnings };
}

let cached: ServerEnv | undefined;

/** Parsed server environment; startup (src/lib/startup) has already rejected invalid values. */
export function serverEnv(): ServerEnv {
  cached ??= parseEnv(process.env).env;
  return cached;
}

/** Tests only: forget the cached environment after changing process.env. */
export function resetServerEnv(): void {
  cached = undefined;
}

export function isDeployed(env: ServerEnv = serverEnv()): boolean {
  return env.APP_ENV !== "dev";
}
