import { afterEach, describe, expect, it } from "vitest";
import { publicConfig, searchMapConfig } from "@/lib/config/public";
import { parseEnv, resetServerEnv } from "@/lib/env";

// The /api/config payload (§2: runtime configuration, no NEXT_PUBLIC_*): public values only.

const DSN = "https://examplePublicKey@o0.ingest.de.sentry.io/0";

const configured: Record<string, string> = {
  APP_ENV: "staging",
  SITE_URL: "https://staging.joutiya.ma/",
  RELEASE: "0123456789ab",
  FIREBASE_PROJECT_ID: "joutiya-staging",
  FIREBASE_API_KEY: "AIza-browser",
  FIREBASE_APP_ID: "1:123456789:web:abc",
  TURNSTILE_SITE_KEY: "0x4AAAAAAA-site",
  GOOGLE_OAUTH_CLIENT_ID: "123456789-abc.apps.googleusercontent.com",
  SENTRY_DSN: DSN,
  MEDIA_BASE_URL: "https://media-staging.joutiya.ma/",
  MAP_PMTILES_URL: "https://media-staging.joutiya.ma/maps/morocco.pmtiles",
};

// Not real secrets (Gitleaks runs on this repository): values that must never reach the browser.
const secrets: Record<string, string> = {
  FIREBASE_SERVER_API_KEY: "AIza-server-only",
  FIREBASE_SERVICE_ACCOUNT: "joutiya-web@joutiya-staging.iam.gserviceaccount.com",
  GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/gcp.json",
  TURNSTILE_SECRET_KEY: "0x4AAAAAAA-secret",
  HASH_PEPPER: "pepper-".repeat(5),
  CSRF_SECRET: "csrf-".repeat(7),
  TELEGRAM_BOT_TOKEN: "123:bot-token",
  ALERT_RELAY_SECRET: "relay-secret",
  ALERT_RELAY_URL: "https://probe.example/alert",
  QUEUE_REDIS_URL: "redis://:queue-pw@valkey-queue:6379",
  RATE_LIMIT_REDIS_URL: "redis://:rl-pw@valkey-ratelimit:6379",
  MAIL_API_KEY: "mail-key",
  MAIL_WEBHOOK_SECRET: "whsec-x",
  MAIL_FALLBACK_API_KEY: "fallback-key",
  WHATSAPP_APP_SECRET: "wa-secret",
  WHATSAPP_VERIFY_TOKEN: "wa-verify",
  CF_ACCESS_AUD: "a".repeat(64),
  R2_S3_ENDPOINT: "https://0123456789abcdef.eu.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "r2-key-id",
  R2_SECRET_ACCESS_KEY: "r2-key-secret",
  R2_BUCKET_QUARANTINE: "joutiya-staging-quarantine",
  R2_BUCKET_MEDIA: "joutiya-staging-media",
  R2_BUCKET_PRIVATE: "joutiya-staging-private",
  BACKUP_AGE_RECIPIENT: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
};

describe("publicConfig", () => {
  it("carries the public values and nothing else", () => {
    const config = publicConfig(parseEnv({ ...configured, ...secrets }).env);
    expect(config).toEqual({
      env: "staging",
      siteUrl: "https://staging.joutiya.ma",
      firebase: { projectId: "joutiya-staging" },
      turnstileSiteKey: "0x4AAAAAAA-site",
      googleClientId: "123456789-abc.apps.googleusercontent.com",
      sentry: { dsn: DSN, environment: "staging", release: "0123456789ab" },
      mediaBaseUrl: "https://media-staging.joutiya.ma",
      upload: { maxBytes: 10 * 1024 * 1024, maxPhotos: 10 },
      map: { pmtilesUrl: "https://media-staging.joutiya.ma/maps/morocco.pmtiles", attribution: "© OpenStreetMap contributors · Protomaps" },
      // The app secret is set but not the display number or the phone number id: no challenge can start.
      phoneVerification: false,
      ads: { mode: "off", cmpEea: false, client: null, units: { leaderboard: null, halfpage: null, rectangle: null, banner: null } },
    });
    const json = JSON.stringify(config);
    for (const [name, value] of Object.entries(secrets)) {
      expect(json, name).not.toContain(value);
      expect(json).not.toContain(name);
    }
    expect(json).not.toMatch(/NEXT_PUBLIC_/);
  });

  it("hands the ad flags and the AdSense publisher id to the browser (phase 6, D8)", () => {
    const env = parseEnv({ ADSENSE_CLIENT_ID: "ca-pub-1234567890123456", AD_SLOT_RECTANGLE: "1234567890" }).env;
    expect(publicConfig(env, { adsMode: "test", adsCmpEea: true }).ads).toEqual({
      mode: "test",
      cmpEea: true,
      client: "ca-pub-1234567890123456",
      units: { leaderboard: null, halfpage: null, rectangle: "1234567890", banner: null },
    });
    expect(parseEnv({ ADSENSE_CLIENT_ID: "pub-1234" }).errors.join(" ")).toContain("ADSENSE_CLIENT_ID");
  });

  it("nulls what is not configured and names the Sentry DSN only when set", () => {
    expect(publicConfig(parseEnv({}).env)).toEqual({
      env: "dev",
      siteUrl: "http://localhost:3000",
      firebase: null,
      turnstileSiteKey: null,
      googleClientId: null,
      sentry: null,
      // Development without MEDIA_BASE_URL: photos come from the signed dev storage route (D11).
      mediaBaseUrl: "http://localhost:3000/api/dev/storage/joutiya-dev-media",
      upload: { maxBytes: 10 * 1024 * 1024, maxPhotos: 10 },
      map: null,
      phoneVerification: false,
      ads: { mode: "off", cmpEea: false, client: null, units: { leaderboard: null, halfpage: null, rectangle: null, banner: null } },
    });
    // Outside dev the media host is null until MEDIA_BASE_URL exists: no bucket name leaks.
    const staging = publicConfig(parseEnv({ APP_ENV: "staging", SITE_URL: "https://staging.joutiya.ma", R2_BUCKET_MEDIA: "joutiya-staging-media" }).env);
    expect(staging.mediaBaseUrl).toBeNull();
    expect(JSON.stringify(staging)).not.toContain("joutiya-staging-media");
    expect(publicConfig(parseEnv({ MEDIA_BASE_URL: "http://localhost:3000/media/" }).env).mediaBaseUrl).toBe("http://localhost:3000/media");
    expect(publicConfig(parseEnv({ SENTRY_DSN: DSN }).env).sentry).toEqual({ dsn: DSN, environment: "dev", release: "dev" });
    // The project only: the Web API key never reaches the browser.
    expect(publicConfig(parseEnv({ FIREBASE_API_KEY: "AIza-browser" }).env).firebase).toBeNull();
    expect(publicConfig(parseEnv({ FIREBASE_PROJECT_ID: "joutiya-dev", FIREBASE_API_KEY: "AIza-browser", FIREBASE_AUTH_DOMAIN: "auth.joutiya.ma" }).env).firebase).toEqual({ projectId: "joutiya-dev" });
  });

  it("gives the search and home maps the same runtime basemap as the browser config", () => {
    const env = parseEnv(configured).env;
    expect(searchMapConfig(env)).toEqual(publicConfig(env).map);
    expect(searchMapConfig(env)?.pmtilesUrl).toBe("https://media-staging.joutiya.ma/maps/morocco.pmtiles");
    // No archive configured: no map, the pages stay lists.
    expect(searchMapConfig(parseEnv({}).env)).toBeNull();
  });

  it("never hands the browser the Web API key or the Auth emulator", () => {
    const emulated = { FIREBASE_PROJECT_ID: "demo-joutiya", FIREBASE_API_KEY: "AIza-fake-key", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" };
    const json = JSON.stringify(publicConfig(parseEnv(emulated).env));
    expect(json).not.toContain("AIza-fake-key");
    expect(json).not.toContain("9099");
  });

  it("offers the phone check only when a WhatsApp challenge can complete", () => {
    const whatsapp = { WHATSAPP_DISPLAY_NUMBER: "+212 600 000 000", WHATSAPP_APP_SECRET: "wa-secret", WHATSAPP_PHONE_NUMBER_ID: "123" };
    expect(publicConfig(parseEnv({ ...configured, ...whatsapp }).env).phoneVerification).toBe(true);
    // Meta parked: no phone number id, so /api/auth/phone/start answers 503 and the browser hides the calls to action.
    expect(publicConfig(parseEnv({ ...configured, ...whatsapp, WHATSAPP_PHONE_NUMBER_ID: "" }).env).phoneVerification).toBe(false);
    // Development falls back to the placeholder number but still needs the webhook credentials.
    expect(publicConfig(parseEnv({ WHATSAPP_APP_SECRET: "wa-secret", WHATSAPP_PHONE_NUMBER_ID: "123" }).env).phoneVerification).toBe(true);
    expect(JSON.stringify(publicConfig(parseEnv({ ...configured, ...whatsapp }).env))).not.toContain("wa-secret");
  });
});

describe("GET /api/config", () => {
  const names = ["SENTRY_DSN", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    resetServerEnv();
  });

  it("answers the public configuration as JSON with a short shared cache", async () => {
    process.env.SENTRY_DSN = DSN;
    process.env.TURNSTILE_SITE_KEY = "0x4AAAAAAA-site";
    process.env.TURNSTILE_SECRET_KEY = "0x4AAAAAAA-secret";
    resetServerEnv();
    const { GET, dynamic } = await import("@/app/api/config/route");
    expect(dynamic).toBe("force-dynamic");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ turnstileSiteKey: "0x4AAAAAAA-site", sentry: { dsn: DSN }, ads: { mode: "off", cmpEea: false, client: null, units: { leaderboard: null, halfpage: null, rectangle: null, banner: null } } });
    expect(JSON.stringify(body)).not.toContain("0x4AAAAAAA-secret");
  });
});
