import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import registry from "../../infra/targets.json";
import { STRICT_REQUIRED, type Targets } from "../../scripts/assert-target";
import { RUN_COMMAND_MAX_BYTES, rootCommand } from "../../scripts/oracle-vm";
import {
  PAIRED,
  REQUIRED,
  VM_GENERATED,
  appEnvNames,
  derivedValues,
  envPayload,
  envScripts,
  namesScript,
  parseMissing,
  parseNames,
  pepperLines,
  planEnv,
  type Source,
} from "../../scripts/vm-env";
import { REQUIRED_DEPLOYED } from "../../src/lib/env";

const targets = registry as unknown as Targets;
const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

// The owner's .env.local, shared with another product: development values, the other product's
// keys, Nav's pairs (production active, staging commented under it) and suffixed lines.
const ENV_LOCAL = [
  "APP_ENV=dev",
  "HASH_PEPPER=development-pepper-0123456789abcdef",
  "FIREBASE_APP_ID=1:89741285084:web:4178e0fff46cf770cb0619",
  "TELEGRAM_BOT_TOKEN=other-product-bot",
  'FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account"}',
  "FIREBASE_SERVER_API_KEY=server-key-prod",
  "# FIREBASE_SERVER_API_KEY=server-key-staging",
  "TURNSTILE_SITE_KEY=0x4AAAAAAFYY2RkrwQRAswcZ",
  "# TURNSTILE_SITE_KEY=0x4AAAAAAFYY7P8KeaWCGihV",
  'TURNSTILE_SECRET_KEY="turnstile-secret-prod" # production',
  "# TURNSTILE_SECRET_KEY=turnstile-secret-staging",
  "MAIL_FALLBACK_API_KEY=brevo-prod",
  "# MAIL_FALLBACK_API_KEY=brevo-staging",
  "SENTRY_DSN=https://other@o1.ingest.de.sentry.io/1",
  "# SENTRY_DSN=https://other@o1.ingest.de.sentry.io/2",
  `HASH_PEPPER_STAGING=${"5".repeat(64)}`,
  `HASH_PEPPER_PROD=${"7".repeat(64)}`,
  "R2_ACCESS_KEY_ID_STAGING=r2-id-staging",
  "R2_SECRET_ACCESS_KEY_STAGING=r2-secret-staging",
  `CSRF_SECRET_STAGING=${"c".repeat(64)}`,
].join("\n");

const local = (text = ENV_LOCAL): Source => ({ label: ".env.local", text });
const plan = (env: "staging" | "prod", sources: Source[] = [local()], existing: string[] = []) => planEnv({ env, targets, example, sources, existing: new Set(existing) });

describe("app.env names", () => {
  const names = appEnvNames(example);

  it("keeps .env.example's names, less Compose's, development's and the owner's tooling", () => {
    for (const name of ["APP_ENV", "NODE_ENV", "RELEASE", "GOOGLE_APPLICATION_CREDENTIALS", "DEV_MAILBOX", "FIRESTORE_EMULATOR_HOST", "ACCESS_CI_TOKEN_ID", "JOUTIYA_CLOUDFLARE_API_TOKEN"]) {
      expect(names).not.toContain(name);
    }
    for (const name of [...REQUIRED, ...VM_GENERATED, ...PAIRED, ...Object.keys(derivedValues("staging", targets))]) expect(names).toContain(name);
  });

  it("requires everything the app needs to start in staging and production", () => {
    for (const name of REQUIRED_DEPLOYED) expect(REQUIRED).toContain(name);
    for (const name of STRICT_REQUIRED.filter((item) => item !== "APP_ENV" && item !== "GOOGLE_APPLICATION_CREDENTIALS")) expect(REQUIRED).toContain(name);
  });

  it("derives each environment's hosts and identifiers from the registry", () => {
    const staging = derivedValues("staging", targets);
    expect(staging).toMatchObject({
      SITE_URL: "https://staging.joutiya.ma",
      ADMIN_HOST: "admin-staging.joutiya.ma",
      CSP_REPORT_ONLY: "true",
      FIREBASE_SERVICE_ACCOUNT: "joutiya-web@joutiya-staging.iam.gserviceaccount.com",
      TURNSTILE_SITE_KEY: "0x4AAAAAAFYY7P8KeaWCGihV",
      MEDIA_BASE_URL: "https://media-staging.joutiya.ma",
    });
    const prod = derivedValues("prod", targets);
    expect(prod).toMatchObject({ SITE_URL: "https://joutiya.ma", ADMIN_HOST: "admin.joutiya.ma", MEDIA_BASE_URL: "https://media.joutiya.ma" });
    expect(prod.CSP_REPORT_ONLY).toBeUndefined();
  });
});

describe("planEnv", () => {
  it("reads Nav's pairs and the suffixed lines, and ignores development's and the other product's", () => {
    const staging = plan("staging");
    expect(staging.errors).toEqual([]);
    expect(staging.values).toMatchObject({
      FIREBASE_SERVER_API_KEY: "server-key-staging",
      TURNSTILE_SECRET_KEY: "turnstile-secret-staging",
      MAIL_FALLBACK_API_KEY: "brevo-staging",
      HASH_PEPPER: "5".repeat(64),
      R2_ACCESS_KEY_ID: "r2-id-staging",
      R2_S3_ENDPOINT: `https://${targets.shared.cloudflare.accountId ?? ""}.eu.r2.cloudflarestorage.com`,
      R2_BUCKET_MEDIA: "joutiya-staging-media",
      SENTRY_DSN: targets.environments.staging.sentry.dsn,
      TURNSTILE_SITE_KEY: "0x4AAAAAAFYY7P8KeaWCGihV",
    });
    expect(staging.sources.TURNSTILE_SECRET_KEY).toBe(".env.local:11 (staging line of a pair)");
    expect(staging.sources.HASH_PEPPER).toBe(".env.local:16");
    expect(staging.sources.SITE_URL).toBe("infra/targets.json");
    expect(staging.values.CSRF_SECRET).toBeUndefined();
    expect(staging.values.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(staging.ignored.map((line) => line.split(":")[0])).toEqual(["HASH_PEPPER", "FIREBASE_APP_ID", "TELEGRAM_BOT_TOKEN", "SENTRY_DSN", "CSRF_SECRET"]);
    expect(staging.ignored.join("\n")).not.toContain("FIREBASE_SERVICE_ACCOUNT_JSON");
    expect(staging.missing).toEqual(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "ALERT_RELAY_URL", "ALERT_RELAY_SECRET", "FIREBASE_API_KEY", "MAIL_API_KEY", "MAIL_WEBHOOK_SECRET", "CF_ACCESS_AUD"]);

    const prod = plan("prod");
    expect(prod.errors).toEqual([]);
    expect(prod.values).toMatchObject({ TURNSTILE_SECRET_KEY: "turnstile-secret-prod", FIREBASE_SERVER_API_KEY: "server-key-prod", HASH_PEPPER: "7".repeat(64) });
    expect(prod.sources.TURNSTILE_SECRET_KEY).toBe(".env.local:10 (production line of a pair)");
    // No production R2 key yet: none of the R2 settings is written (a partial set stops the app).
    expect(prod.values.R2_S3_ENDPOINT).toBeUndefined();
    expect(prod.values.MEDIA_BASE_URL).toBeUndefined();
    expect(plan("prod", [local()], ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]).values.MEDIA_BASE_URL).toBe("https://media.joutiya.ma");
  });

  it("refuses a swapped pair, two different values, a lone R2 key and values app.env cannot hold", () => {
    const swapped = ENV_LOCAL.replace("TURNSTILE_SITE_KEY=0x4AAAAAAFYY2RkrwQRAswcZ\n# TURNSTILE_SITE_KEY=0x4AAAAAAFYY7P8KeaWCGihV", "TURNSTILE_SITE_KEY=0x4AAAAAAFYY7P8KeaWCGihV\n# TURNSTILE_SITE_KEY=0x4AAAAAAFYY2RkrwQRAswcZ");
    const extra: Source = { label: "extra", text: "TURNSTILE_SECRET_KEY_STAGING=another\nR2_ACCESS_KEY_ID_PROD=r2-id-prod\nMAIL_FROM_STAGING=it's\nHASH_PEPPER_PROD=short" };
    expect(plan("staging", [local(swapped), extra]).errors).toEqual([
      "TURNSTILE_SECRET_KEY: .env.local:11 (staging line of a pair) and extra:1 differ",
      "MAIL_FROM (extra:3) holds a single quote or a control character, which app.env cannot hold",
      "TURNSTILE_SITE_KEY (.env.local:9 (staging line of a pair)) differs from infra/targets.json: check which line holds which environment",
    ]);
    expect(plan("prod", [local(), extra]).errors).toEqual([
      "HASH_PEPPER: .env.local:17 and extra:4 differ",
      "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY go together: only R2_ACCESS_KEY_ID is set",
    ]);
    expect(plan("prod", [{ label: "short", text: "HASH_PEPPER_PROD=short" }]).errors).toEqual(["HASH_PEPPER must be at least 32 characters"]);
    expect(() => envPayload({ MAIL_FROM: "it's" })).toThrow("cannot be written");
  });
});

describe("app.env on the VM", () => {
  // Run as the test user: a sudo stub drops -n and runs the rest.
  const work = mkdtempSync(join(tmpdir(), "joutiya-vm-env-"));
  writeFileSync(join(work, "sudo"), '#!/bin/sh\n[ "$1" = "-n" ] && shift\nexec "$@"\n');
  chmodSync(join(work, "sudo"), 0o755);
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const dirs = { etc: join(work, "etc"), stage: join(work, "stage") };
  const appEnv = join(dirs.etc, "staging", "app.env");
  const run = (script: string) => {
    writeFileSync(join(work, "command.sh"), rootCommand(script));
    return spawnSync("bash", [join(work, "command.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${work}:${process.env.PATH ?? ""}` } });
  };
  const runAll = (payload: string) => envScripts("staging", payload, dirs, 200).map((script) => run(script));

  it("merges the payload, keeps the other names and generates the VM's own secrets once", () => {
    mkdirSync(join(dirs.etc, "staging"), { recursive: true });
    writeFileSync(appEnv, "KEEP_ME='kept'\nTURNSTILE_SECRET_KEY='old'\nQUEUE_REDIS_URL='stale'\n");
    expect(parseNames(run(namesScript("staging", dirs)).stdout)).toEqual(new Set(["KEEP_ME", "TURNSTILE_SECRET_KEY", "QUEUE_REDIS_URL"]));

    const results = runAll(envPayload({ LONG_VALUE: "x".repeat(300), MAIL_FROM: "Joutiya <no-reply@notif.joutiya.ma>", TURNSTILE_SECRET_KEY: "new $secret #1" }));
    expect(results.length).toBeGreaterThan(3);
    expect(results.map((result) => result.status)).toEqual(results.map(() => 0));
    const merged = readFileSync(appEnv, "utf8");
    const queue = readFileSync(join(dirs.etc, "staging", "valkey-queue.env"), "utf8").trim().replace("VALKEY_PASSWORD=", "");
    expect(queue).toMatch(/^[0-9a-f]{64}$/);
    expect(merged.split("\n").filter((line) => line.startsWith("TURNSTILE_SECRET_KEY="))).toEqual(["TURNSTILE_SECRET_KEY='new $secret #1'"]);
    expect(merged).toContain("KEEP_ME='kept'\n");
    expect(merged).toContain("MAIL_FROM='Joutiya <no-reply@notif.joutiya.ma>'\n");
    expect(merged).toContain(`QUEUE_REDIS_URL='redis://:${queue}@valkey-queue:6379'\n`);
    expect(merged).not.toContain("stale");
    expect(merged).toMatch(/^CSRF_SECRET='[0-9a-f]{64}'$/m);
    expect(statSync(appEnv).mode & 0o777).toBe(0o600);
    expect(statSync(join(dirs.etc, "staging", "valkey-ratelimit.env")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dirs.stage, "staging.b64"))).toBe(false);
    expect(parseNames(results.at(-1)?.stdout ?? "")).toEqual(new Set(["CSRF_SECRET", "KEEP_ME", "LONG_VALUE", "MAIL_FROM", "QUEUE_REDIS_URL", "RATE_LIMIT_REDIS_URL", "TURNSTILE_SECRET_KEY"]));
    expect(results.map((result) => result.stdout).join("")).not.toContain("new $secret");
    const missing = parseMissing(results.at(-1)?.stdout ?? "");
    expect(missing).toContain("HASH_PEPPER");
    expect(missing).not.toContain("CSRF_SECRET");
    expect(missing).not.toContain("TURNSTILE_SECRET_KEY");
    expect(parseMissing("names: A")).toBeUndefined();

    const csrf = /^CSRF_SECRET=.*$/m.exec(merged)?.[0];
    expect(runAll(envPayload({ SENTRY_DSN: "https://key@o1.ingest.de.sentry.io/1" })).every((result) => result.status === 0)).toBe(true);
    const again = readFileSync(appEnv, "utf8");
    expect(/^CSRF_SECRET=.*$/m.exec(again)?.[0]).toBe(csrf);
    expect(again).toContain(`QUEUE_REDIS_URL='redis://:${queue}@valkey-queue:6379'\n`);
    expect(again).toContain("TURNSTILE_SECRET_KEY='new $secret #1'\n");
  });

  it("changes nothing when a chunk is missing", () => {
    const before = readFileSync(appEnv, "utf8");
    const scripts = envScripts("staging", envPayload({ MAIL_FROM: "x".repeat(600) }), dirs, 200);
    expect(run(scripts[0] ?? "").status).toBe(0);
    expect(run(scripts.at(-1) ?? "").status).not.toBe(0);
    expect(readFileSync(appEnv, "utf8")).toBe(before);
  });

  it("fits each command in Run Command's limit", () => {
    const values = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`NAME_${index}`, "v".repeat(100)]));
    for (const script of envScripts("prod", envPayload(values))) expect(Buffer.byteLength(rootCommand(script))).toBeLessThanOrEqual(RUN_COMMAND_MAX_BYTES);
    expect(() => envScripts("prod", "")).toThrow("nothing to write");
  });
});

describe("pepperLines", () => {
  it("appends the missing peppers after the last line and never rewrites one", () => {
    let count = 0;
    const random = () => String(++count).repeat(64);
    expect(pepperLines("A=1", random)).toEqual({ append: `\nHASH_PEPPER_STAGING=${"1".repeat(64)}\nHASH_PEPPER_PROD=${"2".repeat(64)}\n`, added: ["HASH_PEPPER_STAGING", "HASH_PEPPER_PROD"] });
    expect(pepperLines(`HASH_PEPPER_STAGING=${"a".repeat(64)}\nHASH_PEPPER_PROD=\n`, random)).toEqual({ append: `HASH_PEPPER_PROD=${"3".repeat(64)}\n`, added: ["HASH_PEPPER_PROD"] });
    expect(pepperLines(`HASH_PEPPER_STAGING=x\nHASH_PEPPER_PROD=y\n`, random)).toEqual({ append: "", added: [] });
  });
});
