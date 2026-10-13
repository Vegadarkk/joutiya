import { describe, expect, it } from "vitest";
import { parseEnv } from "@/lib/env";

const deployed = {
  APP_ENV: "staging",
  NEXT_PUBLIC_SITE_URL: "https://staging.joutiya.ma",
  ADMIN_HOST: "admin-staging.joutiya.ma",
  QUEUE_REDIS_URL: "redis://valkey-queue:6379",
  RATE_LIMIT_REDIS_URL: "redis://valkey-ratelimit:6379",
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_CHAT_ID: "1",
  ALERT_RELAY_URL: "https://probe.example/alert",
  ALERT_RELAY_SECRET: "s",
  HASH_PEPPER: "p".repeat(32),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "joutiya-staging",
  GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/gcp.json",
  CF_ACCESS_TEAM_DOMAIN: "joutiya.cloudflareaccess.com",
  CF_ACCESS_AUD: "a".repeat(64),
};

describe("parseEnv", () => {
  it("accepts an empty development environment", () => {
    expect(parseEnv({}).errors).toEqual([]);
  });

  it("accepts a complete deployed environment", () => {
    expect(parseEnv(deployed).errors).toEqual([]);
  });

  it("requires what staging and production cannot run without", () => {
    const { errors } = parseEnv({ APP_ENV: "prod", NEXT_PUBLIC_SITE_URL: "http://joutiya.ma", FIRESTORE_EMULATOR_HOST: "localhost:8080", HASH_PEPPER: "short" });
    expect(errors).toContain("QUEUE_REDIS_URL is required when APP_ENV=prod");
    expect(errors).toContain("CF_ACCESS_AUD is required when APP_ENV=prod");
    expect(errors).toContain("NEXT_PUBLIC_SITE_URL must be https outside dev");
    expect(errors).toContain("FIRESTORE_EMULATOR_HOST must not be set outside dev");
    expect(errors).toContain("HASH_PEPPER must be at least 32 characters");
  });

  it("rejects an unknown APP_ENV", () => {
    expect(parseEnv({ APP_ENV: "production" }).errors[0]).toMatch(/^APP_ENV/);
  });
});
