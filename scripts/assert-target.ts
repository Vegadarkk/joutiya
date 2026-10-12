// Third-party isolation guard (architecture §9). Every identifier the app is configured
// with must equal the exact value recorded in infra/targets.json, otherwise the process
// stops. Runs in CI; web and worker run it at startup from phase 1.
// Erasable TypeScript only, so Node runs it directly: `node scripts/assert-target.ts`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ENVS = ["dev", "staging", "prod"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

type Id = string | null;
type Shape = Record<string, Record<string, RegExp>>;
type Env = Record<string, string | undefined>;

const HEX32 = /^[0-9a-f]{32}$/;
const META_ID = /^[0-9]{5,25}$/;
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

// Format of each recorded identifier; null means "not created yet".
const SHARED_SHAPE = {
  cloudflare: {
    accountId: HEX32,
    zoneId: HEX32,
    accessTeamDomain: /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/,
  },
  oracle: { homeRegion: /^eu-(paris|marseille)-1$/ },
  anthropic: { organizationId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ },
  stripe: { accountId: /^acct_[A-Za-z0-9]{8,}$/ },
  revenuecat: { projectId: /^[A-Za-z0-9_-]{4,64}$/ },
  meta: { businessId: META_ID, appId: META_ID },
} satisfies Shape;

const ENV_SHAPE = {
  firebase: {
    projectId: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
    firestoreLocation: /^europe-west[19]$/,
  },
  r2: { quarantine: R2_BUCKET, media: R2_BUCKET, private: R2_BUCKET },
  whatsapp: { wabaId: META_ID, phoneNumberId: META_ID },
} satisfies Shape;

type Recorded<S extends Shape> = { [K in keyof S]: { [F in keyof S[K]]: Id } };
export type EnvTargets = Recorded<typeof ENV_SHAPE>;
export interface Targets {
  shared: Recorded<typeof SHARED_SHAPE>;
  environments: Record<AppEnv, EnvTargets>;
}

interface Binding {
  variable: string;
  target: string;
  expected: (targets: Targets, env: AppEnv) => Id;
  normalize?: (value: string) => string;
}

const firebaseProject = (variable: string): Binding => ({
  variable,
  target: "environments.<env>.firebase.projectId",
  expected: (t, env) => t.environments[env].firebase.projectId,
});

const r2Bucket = (variable: string, role: keyof EnvTargets["r2"]): Binding => ({
  variable,
  target: `environments.<env>.r2.${role}`,
  expected: (t, env) => t.environments[env].r2[role],
});

// Configured identifiers checked against the targets of APP_ENV.
// GOOGLE_CLOUD_PROJECT and GCLOUD_PROJECT are read implicitly by Google client libraries.
const BINDINGS: Binding[] = [
  firebaseProject("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
  firebaseProject("FIREBASE_PROJECT_ID"),
  firebaseProject("GOOGLE_CLOUD_PROJECT"),
  firebaseProject("GCLOUD_PROJECT"),
  r2Bucket("R2_BUCKET_QUARANTINE", "quarantine"),
  r2Bucket("R2_BUCKET_MEDIA", "media"),
  r2Bucket("R2_BUCKET_PRIVATE", "private"),
  {
    variable: "R2_S3_ENDPOINT",
    target: "shared.cloudflare.accountId (EU jurisdiction endpoint)",
    expected: (t) => {
      const account = t.shared.cloudflare.accountId;
      return account === null ? null : `https://${account}.eu.r2.cloudflarestorage.com`;
    },
    normalize: (value) => value.replace(/\/+$/, ""),
  },
  {
    variable: "CF_ACCOUNT_ID",
    target: "shared.cloudflare.accountId",
    expected: (t) => t.shared.cloudflare.accountId,
  },
  {
    variable: "CF_ACCESS_TEAM_DOMAIN",
    target: "shared.cloudflare.accessTeamDomain",
    expected: (t) => t.shared.cloudflare.accessTeamDomain,
    normalize: (value) => value.replace(/^https:\/\//, "").replace(/\/+$/, ""),
  },
  {
    variable: "WHATSAPP_PHONE_NUMBER_ID",
    target: "environments.<env>.whatsapp.phoneNumberId",
    expected: (t, env) => t.environments[env].whatsapp.phoneNumberId,
  },
  {
    variable: "REVENUECAT_PROJECT_ID",
    target: "shared.revenuecat.projectId",
    expected: (t) => t.shared.revenuecat.projectId,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(
  where: string,
  value: unknown,
  expected: readonly string[],
  errors: string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(`${where}: expected an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) errors.push(`${where}.${key}: unknown key`);
  }
  for (const key of expected) {
    if (!(key in value)) errors.push(`${where}.${key}: missing key`);
  }
  return true;
}

function checkShape(where: string, value: unknown, shape: Shape, errors: string[]): void {
  if (!checkKeys(where, value, Object.keys(shape), errors)) return;
  for (const [section, fields] of Object.entries(shape)) {
    const recorded = value[section];
    if (!checkKeys(`${where}.${section}`, recorded, Object.keys(fields), errors)) continue;
    for (const [field, format] of Object.entries(fields)) {
      const id = recorded[field];
      if (id === null || id === undefined) continue;
      if (typeof id !== "string" || !format.test(id)) {
        errors.push(`${where}.${section}.${field}: ${JSON.stringify(id)} does not match ${format}`);
      }
    }
  }
}

// An identifier recorded twice would let one environment write into another's resources.
function checkDistinct(targets: Targets): string[] {
  const errors: string[] = [];
  const owners = new Map<string, string>();
  const claim = (kind: string, where: string, id: Id): void => {
    if (id === null) return;
    const owner = owners.get(`${kind}:${id}`);
    if (owner === undefined) owners.set(`${kind}:${id}`, where);
    else errors.push(`${where}: ${id} is already recorded at ${owner}`);
  };
  for (const env of APP_ENVS) {
    const t = targets.environments[env];
    claim("firebase", `environments.${env}.firebase.projectId`, t.firebase.projectId);
    for (const role of ["quarantine", "media", "private"] as const) {
      claim("r2", `environments.${env}.r2.${role}`, t.r2[role]);
    }
  }
  // dev and staging share Meta's test number; production must use its own.
  const prodNumber = targets.environments.prod.whatsapp.phoneNumberId;
  for (const env of ["dev", "staging"] as const) {
    if (prodNumber !== null && targets.environments[env].whatsapp.phoneNumberId === prodNumber) {
      errors.push(`environments.prod.whatsapp.phoneNumberId: same number as ${env}`);
    }
  }
  return errors;
}

/** Checks the structure and formats of infra/targets.json. Returns the errors found. */
export function validateTargets(raw: unknown): string[] {
  const errors: string[] = [];
  if (!checkKeys("targets", raw, ["shared", "environments"], errors)) return errors;
  checkShape("shared", raw.shared, SHARED_SHAPE, errors);
  const environments = raw.environments;
  if (checkKeys("environments", environments, APP_ENVS, errors)) {
    for (const env of APP_ENVS) checkShape(`environments.${env}`, environments[env], ENV_SHAPE, errors);
  }
  if (errors.length === 0) errors.push(...checkDistinct(raw as unknown as Targets));
  return errors;
}

function isAppEnv(value: string): value is AppEnv {
  return (APP_ENVS as readonly string[]).includes(value);
}

// Live keys only in prod, test keys everywhere else. The key itself is never printed.
function checkStripeMode(appEnv: AppEnv, key: string): string[] {
  const mode = /^(sk|rk)_live_/.test(key) ? "live" : /^(sk|rk)_test_/.test(key) ? "test" : "unknown";
  const wanted = appEnv === "prod" ? "live" : "test";
  return mode === wanted ? [] : [`STRIPE_SECRET_KEY must be a ${wanted}-mode key when APP_ENV=${appEnv}`];
}

/** Compares the configured identifiers with the targets of APP_ENV. Returns the errors found. */
export function assertTargets(targets: Targets, env: Env): string[] {
  const value = (name: string): string => (env[name] ?? "").trim();
  const configured = BINDINGS.filter((binding) => value(binding.variable) !== "");
  const stripeKey = value("STRIPE_SECRET_KEY");
  const appEnv = value("APP_ENV");

  if (appEnv === "") {
    const names = configured.map((binding) => binding.variable);
    if (stripeKey !== "") names.push("STRIPE_SECRET_KEY");
    return names.length === 0 ? [] : [`APP_ENV is required when ${names.join(", ")} is set`];
  }
  if (!isAppEnv(appEnv)) return [`APP_ENV=${appEnv} is not one of ${APP_ENVS.join(", ")}`];

  const errors: string[] = [];
  for (const binding of configured) {
    const target = binding.target.replace("<env>", appEnv);
    const expected = binding.expected(targets, appEnv);
    const actual = binding.normalize ? binding.normalize(value(binding.variable)) : value(binding.variable);
    if (expected === null) {
      errors.push(`${binding.variable} is set but ${target} is not recorded in infra/targets.json`);
    } else if (actual !== expected) {
      errors.push(`${binding.variable}=${actual} does not match ${target} (${expected})`);
    }
  }
  if (stripeKey !== "") errors.push(...checkStripeMode(appEnv, stripeKey));
  return errors;
}

function fail(errors: string[]): never {
  for (const error of errors) console.error(`assert-target: ${error}`);
  process.exit(1);
}

function main(): void {
  const file = fileURLToPath(new URL("../infra/targets.json", import.meta.url));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail([`cannot read ${file}: ${(error as Error).message}`]);
  }
  const fileErrors = validateTargets(raw);
  if (fileErrors.length > 0) fail(fileErrors);
  const errors = assertTargets(raw as Targets, process.env);
  if (errors.length > 0) fail(errors);
  const appEnv = process.env.APP_ENV?.trim();
  console.log(`assert-target: OK (${appEnv ? `APP_ENV=${appEnv}` : "targets file valid, APP_ENV not set"})`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
