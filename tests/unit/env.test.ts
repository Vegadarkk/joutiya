import { describe, expect, it } from "vitest";
import { parseEnv, RECOMMENDED_DEPLOYED, REQUIRED_DEPLOYED } from "@/lib/env";

const deployed: Record<string, string> = {
  APP_ENV: "staging",
  SITE_URL: "https://staging.joutiya.ma",
  ADMIN_HOST: "admin-staging.joutiya.ma",
  QUEUE_REDIS_URL: "redis://valkey-queue:6379",
  RATE_LIMIT_REDIS_URL: "redis://valkey-ratelimit:6379",
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_CHAT_ID: "1",
  ALERT_RELAY_URL: "https://probe.example/alert",
  ALERT_RELAY_SECRET: "s",
  HASH_PEPPER: "p".repeat(32),
  CSRF_SECRET: "c".repeat(32),
  FIREBASE_PROJECT_ID: "joutiya-staging",
  FIREBASE_API_KEY: "AIza-test",
  FIREBASE_APP_ID: "1:123456789:web:abc",
  FIREBASE_SERVICE_ACCOUNT: "joutiya-web@joutiya-staging.iam.gserviceaccount.com",
  GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/gcp.json",
  GOOGLE_OAUTH_CLIENT_ID: "123456789-abc.apps.googleusercontent.com",
  CF_ACCESS_TEAM_DOMAIN: "joutiya.cloudflareaccess.com",
  CF_ACCESS_AUD: "a".repeat(64),
  TURNSTILE_SITE_KEY: "0x4AAAAAAA-real",
  TURNSTILE_SECRET_KEY: "0x4AAAAAAA-secret",
  MAIL_API_KEY: "re_x",
  MAIL_WEBHOOK_SECRET: "whsec_x",
  MAIL_FALLBACK_API_KEY: "xkeysib-x",
  WHATSAPP_PHONE_NUMBER_ID: "106540352242922",
  WHATSAPP_APP_SECRET: "s",
  WHATSAPP_VERIFY_TOKEN: "v",
  WHATSAPP_DISPLAY_NUMBER: "212600000000",
  SENTRY_DSN: "https://key@o1.ingest.de.sentry.io/1",
};

describe("parseEnv", () => {
  it("accepts an empty development environment", () => {
    expect(parseEnv({}).errors).toEqual([]);
  });

  it("accepts a complete deployed environment without warnings", () => {
    const { errors, warnings } = parseEnv(deployed);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("requires what staging and production cannot run without", () => {
    const { errors } = parseEnv({ APP_ENV: "prod", SITE_URL: "http://joutiya.ma", FIRESTORE_EMULATOR_HOST: "localhost:8080", HASH_PEPPER: "short" });
    for (const name of REQUIRED_DEPLOYED) if (name !== "HASH_PEPPER") expect(errors).toContain(`${name} is required when APP_ENV=prod`);
    expect(errors).toContain("SITE_URL must be https outside dev");
    expect(errors).toContain("FIRESTORE_EMULATOR_HOST must not be set outside dev");
    expect(errors).toContain("HASH_PEPPER must be at least 32 characters");
  });

  it("warns on missing recommended variables only", () => {
    const partial = { ...deployed };
    for (const name of RECOMMENDED_DEPLOYED) delete partial[name];
    const { errors, warnings } = parseEnv(partial);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(RECOMMENDED_DEPLOYED.length);
  });

  it("refuses leftover NEXT_PUBLIC_* names outside dev and ignores them in dev", () => {
    expect(parseEnv({ ...deployed, NEXT_PUBLIC_SITE_URL: "https://x" }).errors).toContain("NEXT_PUBLIC_SITE_URL is no longer read: use SITE_URL (runtime configuration)");
    const dev = parseEnv({ NEXT_PUBLIC_SITE_URL: "https://x" });
    expect(dev.errors).toEqual([]);
    expect(dev.warnings[0]).toMatch(/ignored NEXT_PUBLIC_\*/);
  });

  it("keeps the valid values when one variable is invalid", () => {
    const { env, errors } = parseEnv({ APP_ENV: "staging", LOG_LEVEL: "verbose", SITE_URL: "https://staging.joutiya.ma" });
    expect(errors.some((error) => error.startsWith("LOG_LEVEL:"))).toBe(true);
    expect(env.APP_ENV).toBe("staging");
    expect(env.SITE_URL).toBe("https://staging.joutiya.ma");
  });

  it("enforces the EU Sentry region, distinct secrets and real Turnstile keys in prod", () => {
    const prod: Record<string, string> = { ...deployed, APP_ENV: "prod", SITE_URL: "https://joutiya.ma", ADMIN_HOST: "admin.joutiya.ma" };
    expect(parseEnv({ ...prod, SENTRY_DSN: "https://key@o1.ingest.us.sentry.io/1" }).errors).toContain("SENTRY_DSN must use the EU region (*.ingest.de.sentry.io)");
    expect(parseEnv({ ...prod, CSRF_SECRET: prod["HASH_PEPPER"] ?? "" }).errors).toContain("HASH_PEPPER and CSRF_SECRET must differ");
    expect(parseEnv({ ...prod, TURNSTILE_SITE_KEY: "1x00000000000000000000AA" }).errors).toContain("TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must not be Cloudflare test keys in prod");
    expect(parseEnv({ ...prod, DEV_MAILBOX: "true" }).errors).toContain("DEV_MAILBOX must not be set outside dev");
  });

  it("rejects an unknown APP_ENV", () => {
    expect(parseEnv({ APP_ENV: "production" }).errors[0]).toMatch(/^APP_ENV/);
  });
});
