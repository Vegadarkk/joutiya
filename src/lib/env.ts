import "server-only";
import { z } from "zod";

// Server environment (§9). Values are read once and never logged. Staging and production
// require what they cannot run without; development falls back to local defaults.

const optional = z.string().trim().optional().transform((value) => (value ? value : undefined));

const schema = z.object({
  APP_ENV: z.enum(["dev", "staging", "prod"]).default("dev"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
  ADMIN_HOST: optional,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  QUEUE_REDIS_URL: optional,
  RATE_LIMIT_REDIS_URL: optional,
  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_CHAT_ID: optional,
  ALERT_RELAY_URL: optional,
  ALERT_RELAY_SECRET: optional,
  HASH_PEPPER: optional,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: optional,
  FIRESTORE_EMULATOR_HOST: optional,
  GOOGLE_APPLICATION_CREDENTIALS: optional,
  CF_ACCESS_TEAM_DOMAIN: optional,
  CF_ACCESS_AUD: optional,
});

export type ServerEnv = z.infer<typeof schema>;

/** Variables without which staging and production must not start. */
const REQUIRED_DEPLOYED = [
  "ADMIN_HOST",
  "QUEUE_REDIS_URL",
  "RATE_LIMIT_REDIS_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "ALERT_RELAY_URL",
  "ALERT_RELAY_SECRET",
  "HASH_PEPPER",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
] as const satisfies readonly (keyof ServerEnv)[];

export function parseEnv(source: Record<string, string | undefined>): { env: ServerEnv; errors: string[] } {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    return {
      env: schema.parse({}),
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  const env = parsed.data;
  const errors: string[] = [];
  if (env.APP_ENV !== "dev") {
    for (const name of REQUIRED_DEPLOYED) if (!env[name]) errors.push(`${name} is required when APP_ENV=${env.APP_ENV}`);
    if (!env.NEXT_PUBLIC_SITE_URL.startsWith("https://")) errors.push("NEXT_PUBLIC_SITE_URL must be https outside dev");
    if (env.FIRESTORE_EMULATOR_HOST) errors.push("FIRESTORE_EMULATOR_HOST must not be set outside dev");
    if (env.HASH_PEPPER && env.HASH_PEPPER.length < 32) errors.push("HASH_PEPPER must be at least 32 characters");
  }
  return { env, errors };
}

let cached: ServerEnv | undefined;

/** Parsed server environment; startup (src/lib/startup) has already rejected invalid values. */
export function serverEnv(): ServerEnv {
  cached ??= parseEnv(process.env).env;
  return cached;
}
