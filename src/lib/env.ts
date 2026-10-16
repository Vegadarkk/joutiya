import "server-only";
import { z } from "@/lib/zod";

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
/** Non-negative integer with a default; "" counts as unset. */
const integer = (fallback: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (!value) return fallback;
      if (!/^\d{1,15}$/.test(value)) {
        ctx.addIssue({ code: "custom", message: "must be a non-negative integer" });
        return z.NEVER;
      }
      return Number(value);
    });
/** Absolute http(s) URL or unset; the https requirement outside dev is checked in parseEnv. */
const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((value, ctx) => {
    if (!value) return undefined;
    if (!/^https?:\/\/[^\s/]+/.test(value) || !URL.canParse(value)) {
      ctx.addIssue({ code: "custom", message: "must be an absolute http(s) URL" });
      return z.NEVER;
    }
    return value;
  });

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
  /** Browser key of the Firebase web app (public, referrer-restricted). */
  FIREBASE_API_KEY: optional,
  /**
   * Server calls to the Identity Toolkit REST API (password sign-in, action codes). A key without
   * referrer restriction, limited to the Identity Toolkit API; defaults to FIREBASE_API_KEY.
   */
  FIREBASE_SERVER_API_KEY: optional,
  FIREBASE_APP_ID: optional,
  /** Auth domain given to the browser SDK; defaults to <project>.firebaseapp.com (custom tokens only). */
  FIREBASE_AUTH_DOMAIN: optional,
  /** joutiya-web@<project>.iam.gserviceaccount.com: signs custom tokens through IAM, no key. */
  FIREBASE_SERVICE_ACCOUNT: optional,
  FIRESTORE_EMULATOR_HOST: optional,
  FIREBASE_AUTH_EMULATOR_HOST: optional,
  GOOGLE_APPLICATION_CREDENTIALS: optional,
  /** OAuth web client used by Google Identity Services: audience of the Google ID tokens we verify. */
  GOOGLE_OAUTH_CLIENT_ID: optional,
  CF_ACCESS_TEAM_DOMAIN: optional,
  CF_ACCESS_AUD: optional,
  TURNSTILE_SITE_KEY: optional,
  TURNSTILE_SECRET_KEY: optional,
  // R2 object storage (§5 uploads, phase 3): the S3 endpoint, one token per environment and the
  // three bucket names (checked against infra/targets.json by scripts/assert-target.ts). Set all
  // of them with MEDIA_BASE_URL, or none: without them dev stores files under os.tmpdir()
  // (src/lib/storage/fs.ts) and deployed environments refuse uploads.
  /** Public media host, e.g. https://media.joutiya.ma; dev defaults to the dev storage route. */
  MEDIA_BASE_URL: optionalUrl,
  R2_S3_ENDPOINT: optional,
  R2_ACCESS_KEY_ID: optional,
  R2_SECRET_ACCESS_KEY: optional,
  R2_BUCKET_QUARANTINE: optional,
  R2_BUCKET_MEDIA: optional,
  R2_BUCKET_PRIVATE: optional,
  /**
   * Bytes stored in the shared Cloudflare account by its other project (D15): added to our own
   * byte accounting before the r2.storage gauge, so the 8 GB alert reflects the account total.
   */
  R2_STORAGE_BASELINE_BYTES: integer(4_140_000_000),
  /** Morocco PMTiles archive for the interactive map (D10); unset = static SVG map only. */
  MAP_PMTILES_URL: optionalUrl,
  /** Worker only: directory holding the local ONNX models (nudity, faces; docs/models.md). */
  MEDIA_MODELS_DIR: optional,
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
  /** age public key of the nightly Firestore backups (D17); the private key stays offline. */
  BACKUP_AGE_RECIPIENT: optional,
  /** Development only: keeps sent e-mails in memory, readable at /api/dev/mailbox (e2e tests). */
  DEV_MAILBOX: flag,
  // Search (phase 4): Meilisearch on the internal Docker network (http://meilisearch:7700).
  // The web reads with the search-only key, the worker indexes with the indexing key; the master
  // key never reaches the app (meilisearch.env, scripts/search-setup.ts). Unset in dev = in-memory engine.
  MEILI_URL: optionalUrl,
  MEILI_SEARCH_KEY: optional,
  MEILI_INDEX_KEY: optional,
});

export type ServerEnv = z.infer<typeof schema>;
export type AppEnv = ServerEnv["APP_ENV"];

/** The R2 configuration is complete or absent: a partial one is a deployment mistake (parseEnv). */
export const R2_STORAGE_VARS = [
  "R2_S3_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_QUARANTINE",
  "R2_BUCKET_MEDIA",
  "R2_BUCKET_PRIVATE",
  "MEDIA_BASE_URL",
] as const satisfies readonly (keyof ServerEnv)[];

/** True when every R2 variable is set: the S3 adapter applies (src/lib/storage). */
export function isR2Configured(env: Pick<ServerEnv, (typeof R2_STORAGE_VARS)[number]>): boolean {
  return R2_STORAGE_VARS.every((name) => Boolean(env[name]));
}

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
  // Photos and backups (phase 3): recommended, not required, until the bucket tokens exist.
  ...R2_STORAGE_VARS,
  "BACKUP_AGE_RECIPIENT",
  // Search (phase 4): without it the site serves pages but search answers 503 (design D2).
  "MEILI_URL",
  "MEILI_SEARCH_KEY",
  "MEILI_INDEX_KEY",
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
    // Object storage: half a configuration would sign uploads nobody can process.
    const r2Set = R2_STORAGE_VARS.filter((name) => env[name]);
    if (r2Set.length > 0 && r2Set.length < R2_STORAGE_VARS.length) {
      const missing = R2_STORAGE_VARS.filter((name) => !env[name]);
      errors.push(`R2 storage needs all of ${R2_STORAGE_VARS.join(", ")} or none (missing: ${missing.join(", ")})`);
    }
    if (env.MEILI_URL && !env.MEILI_SEARCH_KEY && !env.MEILI_INDEX_KEY) errors.push("MEILI_URL needs MEILI_SEARCH_KEY (web) or MEILI_INDEX_KEY (worker)");
    if ((env.MEILI_SEARCH_KEY || env.MEILI_INDEX_KEY) && !env.MEILI_URL) errors.push("MEILI_SEARCH_KEY and MEILI_INDEX_KEY need MEILI_URL");
    for (const name of ["MEDIA_BASE_URL", "MAP_PMTILES_URL"] as const) {
      if (env[name] && !env[name].startsWith("https://")) errors.push(`${name} must be https outside dev`);
    }
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
    // §6: report-only is a staging tool; production enforces its CSP.
    if (env.APP_ENV === "prod" && env.CSP_REPORT_ONLY) errors.push("CSP_REPORT_ONLY must not be set in prod");
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
