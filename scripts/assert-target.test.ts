import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { assertTargets, validateTargets } from "./assert-target.ts";
import type { EnvTargets, Targets } from "./assert-target.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TEST_NUMBER = "111111111111111";
const PROD_NUMBER = "222222222222222";

function envTargets(name: string, phoneNumberId: string): EnvTargets {
  return {
    firebase: { projectId: `joutiya-${name}-4821`, firestoreLocation: "europe-west9" },
    r2: { quarantine: `joutiya-${name}-quarantine`, media: `joutiya-${name}-media`, private: `joutiya-${name}-private` },
    whatsapp: { wabaId: "102030405060708", phoneNumberId },
  };
}

function recorded(): Targets {
  return {
    shared: {
      cloudflare: { accountId: ACCOUNT, zoneId: "fedcba9876543210fedcba9876543210", accessTeamDomain: "joutiya.cloudflareaccess.com" },
      oracle: { homeRegion: "eu-paris-1" },
      anthropic: { organizationId: "123e4567-e89b-12d3-a456-426614174000" },
      stripe: { accountId: "acct_1Q2w3E4r5T6y7U8i" },
      revenuecat: { projectId: "proj5a6b7c8d" },
      meta: { businessId: "1234567890123", appId: "9876543210987" },
    },
    environments: {
      dev: envTargets("dev", TEST_NUMBER),
      staging: envTargets("staging", TEST_NUMBER),
      prod: envTargets("prod", PROD_NUMBER),
    },
  };
}

describe("validateTargets", () => {
  it("accepts the committed infra/targets.json", () => {
    const raw: unknown = JSON.parse(readFileSync(new URL("../infra/targets.json", import.meta.url), "utf8"));
    assert.deepEqual(validateTargets(raw), []);
  });

  it("accepts fully recorded targets", () => {
    assert.deepEqual(validateTargets(recorded()), []);
  });

  it("rejects unknown and missing keys", () => {
    const raw = JSON.parse(JSON.stringify(recorded()));
    delete raw.environments.dev.firebase.projectId;
    raw.environments.dev.firebase.projectID = "joutiya-dev";
    raw.shared.github = { repo: "Vegadarkk/joutiya" };
    assert.deepEqual(validateTargets(raw).sort(), [
      "environments.dev.firebase.projectID: unknown key",
      "environments.dev.firebase.projectId: missing key",
      "shared.github: unknown key",
    ]);
  });

  it("rejects malformed identifiers and regions outside the spec", () => {
    const targets = recorded();
    targets.shared.cloudflare.accountId = "not-an-account";
    targets.shared.oracle.homeRegion = "eu-frankfurt-1";
    targets.environments.prod.firebase.firestoreLocation = "nam5";
    const errors = validateTargets(targets);
    assert.equal(errors.length, 3);
    assert.match(errors.join("\n"), /shared\.cloudflare\.accountId/);
    assert.match(errors.join("\n"), /shared\.oracle\.homeRegion/);
    assert.match(errors.join("\n"), /environments\.prod\.firebase\.firestoreLocation/);
  });

  it("rejects an identifier recorded for two environments", () => {
    const targets = recorded();
    targets.environments.staging.firebase.projectId = targets.environments.prod.firebase.projectId;
    targets.environments.staging.r2.media = targets.environments.dev.r2.media;
    assert.deepEqual(validateTargets(targets), [
      "environments.staging.r2.media: joutiya-dev-media is already recorded at environments.dev.r2.media",
      "environments.prod.firebase.projectId: joutiya-prod-4821 is already recorded at environments.staging.firebase.projectId",
    ]);
  });

  it("rejects Meta's test number in production", () => {
    const targets = recorded();
    targets.environments.prod.whatsapp.phoneNumberId = TEST_NUMBER;
    assert.deepEqual(validateTargets(targets), [
      "environments.prod.whatsapp.phoneNumberId: same number as dev",
      "environments.prod.whatsapp.phoneNumberId: same number as staging",
    ]);
  });
});

describe("assertTargets", () => {
  const staging = {
    APP_ENV: "staging",
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: "joutiya-staging-4821",
    R2_BUCKET_QUARANTINE: "joutiya-staging-quarantine",
    R2_BUCKET_MEDIA: "joutiya-staging-media",
    R2_BUCKET_PRIVATE: "joutiya-staging-private",
    R2_S3_ENDPOINT: `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`,
    CF_ACCOUNT_ID: ACCOUNT,
    CF_ACCESS_TEAM_DOMAIN: "https://joutiya.cloudflareaccess.com/",
    WHATSAPP_PHONE_NUMBER_ID: TEST_NUMBER,
    REVENUECAT_PROJECT_ID: "proj5a6b7c8d",
    STRIPE_SECRET_KEY: "rk_test_x",
  };

  it("passes when nothing is configured", () => {
    assert.deepEqual(assertTargets(recorded(), {}), []);
  });

  it("accepts identifiers that match the targets of APP_ENV", () => {
    assert.deepEqual(assertTargets(recorded(), staging), []);
  });

  it("requires APP_ENV once an identifier is configured", () => {
    assert.deepEqual(assertTargets(recorded(), { GOOGLE_CLOUD_PROJECT: "joutiya-dev-4821", STRIPE_SECRET_KEY: "rk_test_x" }), [
      "APP_ENV is required when GOOGLE_CLOUD_PROJECT, STRIPE_SECRET_KEY is set",
    ]);
  });

  it("rejects an unknown APP_ENV", () => {
    assert.deepEqual(assertTargets(recorded(), { APP_ENV: "production" }), [
      "APP_ENV must be one of dev, staging, prod",
    ]);
  });

  it("rejects an identifier that belongs to another environment", () => {
    assert.deepEqual(assertTargets(recorded(), { ...staging, NEXT_PUBLIC_FIREBASE_PROJECT_ID: "joutiya-prod-4821" }), [
      "NEXT_PUBLIC_FIREBASE_PROJECT_ID does not match environments.staging.firebase.projectId (joutiya-staging-4821)",
    ]);
  });

  it("rejects a configured identifier that was never recorded", () => {
    const targets = recorded();
    targets.environments.dev.firebase.projectId = null;
    assert.deepEqual(assertTargets(targets, { APP_ENV: "dev", FIREBASE_PROJECT_ID: "punk-records-1234" }), [
      "FIREBASE_PROJECT_ID is set but environments.dev.firebase.projectId is not recorded in infra/targets.json",
    ]);
  });

  it("requires the EU endpoint of the recorded R2 account", () => {
    const errors = assertTargets(recorded(), { ...staging, R2_S3_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com` });
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /^R2_S3_ENDPOINT does not match/);
  });

  it("checks the account Wrangler and gcloud read implicitly", () => {
    assert.deepEqual(
      assertTargets(recorded(), { ...staging, CLOUDFLARE_ACCOUNT_ID: "ffffffffffffffffffffffffffffffff", CLOUDSDK_CORE_PROJECT: "punk-records-1234" }),
      [
        "CLOUDSDK_CORE_PROJECT does not match environments.staging.firebase.projectId (joutiya-staging-4821)",
        `CLOUDFLARE_ACCOUNT_ID does not match shared.cloudflare.accountId (${ACCOUNT})`,
      ],
    );
  });

  it("never prints a configured value", () => {
    const leaked = "pasted-secret-value";
    const errors = assertTargets(recorded(), { ...staging, APP_ENV: "staging", FIREBASE_PROJECT_ID: leaked, CF_ACCOUNT_ID: leaked });
    assert.equal(errors.length, 2);
    assert.doesNotMatch(errors.join("\n"), new RegExp(leaked));
    assert.doesNotMatch(assertTargets(recorded(), { APP_ENV: leaked }).join("\n"), new RegExp(leaked));
  });

  it("accepts restricted Stripe keys only, live in production only", () => {
    assert.deepEqual(assertTargets(recorded(), { ...staging, STRIPE_SECRET_KEY: "rk_live_x" }), [
      "STRIPE_SECRET_KEY must be a restricted rk_test_… key when APP_ENV=staging",
    ]);
    assert.deepEqual(assertTargets(recorded(), { ...staging, STRIPE_SECRET_KEY: "sk_test_x" }), [
      "STRIPE_SECRET_KEY must be a restricted rk_test_… key when APP_ENV=staging",
    ]);
    assert.deepEqual(assertTargets(recorded(), { APP_ENV: "prod", STRIPE_SECRET_KEY: "sk_live_x" }), [
      "STRIPE_SECRET_KEY must be a restricted rk_live_… key when APP_ENV=prod",
    ]);
    assert.deepEqual(assertTargets(recorded(), { APP_ENV: "prod", STRIPE_SECRET_KEY: "rk_live_x" }), []);
  });
});
