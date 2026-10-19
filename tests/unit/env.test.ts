import { describe, expect, it } from "vitest";
import { isR2Configured, parseEnv, R2_STORAGE_VARS, RECOMMENDED_DEPLOYED, REQUIRED_DEPLOYED } from "@/lib/env";

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
  // Not real credentials (Gitleaks runs on this repository).
  R2_S3_ENDPOINT: "https://0123456789abcdef.eu.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "r2-key-id",
  R2_SECRET_ACCESS_KEY: "r2-key-secret",
  R2_BUCKET_QUARANTINE: "joutiya-staging-quarantine",
  R2_BUCKET_MEDIA: "joutiya-staging-media",
  R2_BUCKET_PRIVATE: "joutiya-staging-private",
  MEDIA_BASE_URL: "https://media-staging.joutiya.ma",
  BACKUP_AGE_RECIPIENT: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
  MEILI_URL: "http://meilisearch:7700",
  MEILI_SEARCH_KEY: "search-key-placeholder",
  MEILI_INDEX_KEY: "index-key-placeholder",
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

  it("refuses a report-only CSP in prod and accepts it in staging", () => {
    const prod: Record<string, string> = { ...deployed, APP_ENV: "prod", SITE_URL: "https://joutiya.ma", ADMIN_HOST: "admin.joutiya.ma" };
    expect(parseEnv({ ...prod, CSP_REPORT_ONLY: "true" }).errors).toEqual(["CSP_REPORT_ONLY must not be set in prod"]);
    expect(parseEnv({ ...prod, CSP_REPORT_ONLY: "false" }).errors).toEqual([]);
    expect(parseEnv({ ...deployed, CSP_REPORT_ONLY: "true" }).errors).toEqual([]);
  });

  it("rejects an unknown APP_ENV", () => {
    expect(parseEnv({ APP_ENV: "production" }).errors[0]).toMatch(/^APP_ENV/);
  });

  describe("object storage (phase 3)", () => {
    it("accepts a complete or absent R2 configuration and refuses a partial one outside dev", () => {
      expect(isR2Configured(parseEnv(deployed).env)).toBe(true);
      const none = { ...deployed };
      for (const name of R2_STORAGE_VARS) delete none[name];
      const without = parseEnv(none);
      expect(without.errors).toEqual([]);
      expect(isR2Configured(without.env)).toBe(false);
      const partial = { ...deployed };
      delete partial["R2_SECRET_ACCESS_KEY"];
      delete partial["MEDIA_BASE_URL"];
      expect(parseEnv(partial).errors).toEqual([expect.stringMatching(/^R2 storage needs all of .* or none \(missing: R2_SECRET_ACCESS_KEY, MEDIA_BASE_URL\)$/)]);
      // Dev may run half-configured (the file store takes over).
      expect(parseEnv({ R2_BUCKET_MEDIA: "joutiya-dev-media" }).errors).toEqual([]);
    });

    it("lists the storage and backup variables as recommended, never required", () => {
      for (const name of [...R2_STORAGE_VARS, "BACKUP_AGE_RECIPIENT"] as const) {
        expect(RECOMMENDED_DEPLOYED).toContain(name);
        expect(REQUIRED_DEPLOYED as readonly string[]).not.toContain(name);
      }
    });

    it("requires https media and tile URLs outside dev and a valid URL everywhere", () => {
      expect(parseEnv({ ...deployed, MEDIA_BASE_URL: "http://media-staging.joutiya.ma" }).errors).toEqual(["MEDIA_BASE_URL must be https outside dev"]);
      expect(parseEnv({ ...deployed, MAP_PMTILES_URL: "http://tiles.example/morocco.pmtiles" }).errors).toEqual(["MAP_PMTILES_URL must be https outside dev"]);
      expect(parseEnv({ ...deployed, MAP_PMTILES_URL: "https://media-staging.joutiya.ma/maps/morocco.pmtiles" }).errors).toEqual([]);
      expect(parseEnv({ MAP_PMTILES_URL: "http://localhost:3000/api/dev/storage/joutiya-dev-media/maps/morocco.pmtiles" }).errors).toEqual([]);
      const invalid = parseEnv({ MAP_PMTILES_URL: "maps/morocco.pmtiles", MEDIA_BASE_URL: "media.joutiya.ma" });
      expect(invalid.errors).toEqual(["MEDIA_BASE_URL: must be an absolute http(s) URL", "MAP_PMTILES_URL: must be an absolute http(s) URL"]);
      expect(invalid.env.MAP_PMTILES_URL).toBeUndefined();
    });

    it("parses the R2 storage baseline as an integer with the account's default", () => {
      expect(parseEnv({}).env.R2_STORAGE_BASELINE_BYTES).toBe(4_140_000_000);
      expect(parseEnv({ R2_STORAGE_BASELINE_BYTES: "" }).env.R2_STORAGE_BASELINE_BYTES).toBe(4_140_000_000);
      expect(parseEnv({ R2_STORAGE_BASELINE_BYTES: "123" }).env.R2_STORAGE_BASELINE_BYTES).toBe(123);
      const invalid = parseEnv({ R2_STORAGE_BASELINE_BYTES: "4.1e9" });
      expect(invalid.errors).toEqual(["R2_STORAGE_BASELINE_BYTES: must be a non-negative integer"]);
      expect(invalid.env.R2_STORAGE_BASELINE_BYTES).toBe(4_140_000_000);
    });
  });
});
