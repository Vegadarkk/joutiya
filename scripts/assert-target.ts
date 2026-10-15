// Third-party isolation guard (architecture §9). Every identifier the app is configured
// with must equal the exact value recorded in infra/targets.json, otherwise the process
// stops. Runs in CI; web and worker run it at startup in strict mode (staging, prod).
// Erasable TypeScript only, so Node runs it directly: `node scripts/assert-target.ts [--strict]`.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const APP_ENVS = ["dev", "staging", "prod"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

type Id = string | null;
type Shape = Record<string, Record<string, RegExp>>;
type Env = Record<string, string | undefined>;

const HEX32 = /^[0-9a-f]{32}$/;
// Lowercase, as Cloudflare prints them: tunnel tokens are compared to the recorded value verbatim.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const META_ID = /^[0-9]{5,25}$/;
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

// Format of each recorded identifier; null means "not created yet".
const SHARED_SHAPE = {
  cloudflare: {
    accountId: HEX32,
    zoneId: HEX32,
    accessTeamDomain: /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/,
    // Tunnel of the host's cloudflared (SSH only), independent of Docker.
    sshTunnelId: UUID,
  },
  oracle: {
    homeRegion: /^eu-(paris|marseille)-1$/,
    // OCIDs of the tenancy and of the `joutiya` compartment Claude's user is limited to (§9).
    tenancyId: /^ocid1\.tenancy\.oc1\.\.[a-z0-9]{20,}$/,
    compartmentId: /^ocid1\.compartment\.oc1\.\.[a-z0-9]{20,}$/,
  },
  anthropic: { organizationId: UUID },
  stripe: { accountId: /^acct_[A-Za-z0-9]{8,}$/ },
  revenuecat: { projectId: /^proj[A-Za-z0-9]{4,251}$/ },
  meta: { businessId: META_ID, appId: META_ID },
} satisfies Shape;

const ENV_SHAPE = {
  firebase: {
    projectId: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
    // Numeric project number: prefix of the web app id and of the OAuth client id.
    projectNumber: /^[0-9]{6,20}$/,
    firestoreLocation: /^europe-west[19]$/,
  },
  r2: { quarantine: R2_BUCKET, media: R2_BUCKET, private: R2_BUCKET },
  whatsapp: { wabaId: META_ID, phoneNumberId: META_ID },
  // Tunnel of this environment and AUD tag of the Access application protecting its back office.
  cloudflare: { tunnelId: UUID, accessAud: /^[0-9a-f]{64}$/ },
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
// GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT and CLOUDSDK_CORE_PROJECT are read implicitly by Google
// tools, CLOUDFLARE_ACCOUNT_ID by Wrangler.
const BINDINGS: Binding[] = [
  firebaseProject("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
  firebaseProject("FIREBASE_PROJECT_ID"),
  firebaseProject("GOOGLE_CLOUD_PROJECT"),
  firebaseProject("GCLOUD_PROJECT"),
  firebaseProject("CLOUDSDK_CORE_PROJECT"),
  {
    // 1:<project number>:web:<hash>
    variable: "NEXT_PUBLIC_FIREBASE_APP_ID",
    target: "environments.<env>.firebase.projectNumber",
    expected: (t, env) => t.environments[env].firebase.projectNumber,
    normalize: (value) => value.split(":")[1] ?? "",
  },
  {
    // <project number>-<hash>.apps.googleusercontent.com
    variable: "GOOGLE_OAUTH_CLIENT_ID",
    target: "environments.<env>.firebase.projectNumber",
    expected: (t, env) => t.environments[env].firebase.projectNumber,
    normalize: (value) => value.split("-")[0] ?? "",
  },
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
    variable: "CLOUDFLARE_ACCOUNT_ID",
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
    variable: "CF_ACCESS_AUD",
    target: "environments.<env>.cloudflare.accessAud",
    expected: (t, env) => t.environments[env].cloudflare.accessAud,
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
    claim("firebase-number", `environments.${env}.firebase.projectNumber`, t.firebase.projectNumber);
    claim("tunnel", `environments.${env}.cloudflare.tunnelId`, t.cloudflare.tunnelId);
    claim("access", `environments.${env}.cloudflare.accessAud`, t.cloudflare.accessAud);
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

// Restricted keys only (§9): live in prod, test everywhere else. The key itself is never printed.
function checkStripeMode(appEnv: AppEnv, key: string): string[] {
  const wanted = appEnv === "prod" ? "rk_live_" : "rk_test_";
  return key.startsWith(wanted) ? [] : [`STRIPE_SECRET_KEY must be a restricted ${wanted}… key when APP_ENV=${appEnv}`];
}

/** Variables a deployed web or worker cannot start without (strict mode). */
export const STRICT_REQUIRED = [
  "APP_ENV",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
] as const;

// Variables checked against the targets of APP_ENV outside BINDINGS: setting one requires APP_ENV.
const CONTEXT_VARIABLES = ["STRIPE_SECRET_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_CONFIG", "TUNNEL_TOKEN"] as const;

export interface AssertOptions {
  /** Staging and production: every STRICT_REQUIRED variable must be set and recorded. */
  strict?: boolean;
  /** Reads credential files (GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_CONFIG as a path). */
  readFile?: (path: string) => string;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Cloudflare tunnel tokens are base64 JSON: { a: account tag, t: tunnel id, s: secret }. */
function tunnelTokenErrors(variable: string, token: string, targets: Targets, target: string, tunnel: Id): string[] {
  const decoded = parseJson(Buffer.from(token, "base64").toString("utf8"));
  if (!decoded || typeof decoded.a !== "string" || typeof decoded.t !== "string") {
    return [`${variable} is not a Cloudflare tunnel token`];
  }
  const errors: string[] = [];
  const account = targets.shared.cloudflare.accountId;
  if (account === null) errors.push(`${variable} is set but shared.cloudflare.accountId is not recorded in infra/targets.json`);
  else if (decoded.a !== account) errors.push(`${variable} belongs to another account than shared.cloudflare.accountId (${account})`);
  if (tunnel === null) errors.push(`${variable} is set but ${target} is not recorded in infra/targets.json`);
  else if (decoded.t !== tunnel) errors.push(`${variable} is for another tunnel than ${target} (${tunnel})`);
  return errors;
}

// Tunnel tokens kept in the owner's .env.local (docs/phase-1.md step 2), checked whatever APP_ENV.
const OWNER_TUNNEL_TOKENS: readonly { variable: string; target: string; tunnel: (targets: Targets) => Id }[] = [
  { variable: "JOUTIYA_SSH_TUNNEL_TOKEN", target: "shared.cloudflare.sshTunnelId", tunnel: (t) => t.shared.cloudflare.sshTunnelId },
  { variable: "JOUTIYA_PROD_TUNNEL_TOKEN", target: "environments.prod.cloudflare.tunnelId", tunnel: (t) => t.environments.prod.cloudflare.tunnelId },
  {
    variable: "JOUTIYA_STAGING_TUNNEL_TOKEN",
    target: "environments.staging.cloudflare.tunnelId",
    tunnel: (t) => t.environments.staging.cloudflare.tunnelId,
  },
];

// Claude's Oracle access (cloud environment, docs/phase-0.md step 4), checked whatever APP_ENV.
const SHARED_BINDINGS: readonly { variable: string; target: string; expected: (targets: Targets) => Id }[] = [
  { variable: "JOUTIYA_OCI_TENANCY", target: "shared.oracle.tenancyId", expected: (t) => t.shared.oracle.tenancyId },
  { variable: "JOUTIYA_OCI_COMPARTMENT", target: "shared.oracle.compartmentId", expected: (t) => t.shared.oracle.compartmentId },
  { variable: "JOUTIYA_OCI_REGION", target: "shared.oracle.homeRegion", expected: (t) => t.shared.oracle.homeRegion },
];

function sharedBindingErrors(targets: Targets, value: (name: string) => string): string[] {
  return SHARED_BINDINGS.filter(({ variable }) => value(variable) !== "").flatMap(({ variable, target, expected }) => {
    const recorded = expected(targets);
    if (recorded === null) return [`${variable} is set but ${target} is not recorded in infra/targets.json`];
    return value(variable) === recorded ? [] : [`${variable} does not match ${target} (${recorded})`];
  });
}

/**
 * Google project behind a credential file: the impersonated service account of a Workload
 * Identity Federation config (§9), or project_id of a service account key (documented exception).
 */
export function credentialProject(credential: Record<string, unknown>): string | null {
  if (credential.type === "service_account") return typeof credential.project_id === "string" ? credential.project_id : null;
  if (credential.type === "external_account" && typeof credential.service_account_impersonation_url === "string") {
    const match = /serviceAccounts\/[^@/]+@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com:/.exec(
      credential.service_account_impersonation_url,
    );
    return match?.[1] ?? null;
  }
  return null;
}

function projectFileErrors(variable: string, path: string, expected: Id, appEnv: AppEnv, options: AssertOptions): string[] {
  const target = `environments.${appEnv}.firebase.projectId`;
  if (expected === null) return [`${variable} is set but ${target} is not recorded in infra/targets.json`];
  let credential: Record<string, unknown> | null;
  try {
    credential = parseJson((options.readFile ?? ((file: string) => readFileSync(file, "utf8")))(path));
  } catch {
    return [`${variable}: cannot read the file it points to`];
  }
  if (!credential) return [`${variable}: the file is not a JSON object`];
  const project = variable === "FIREBASE_CONFIG" ? credential.projectId : credentialProject(credential);
  if (typeof project !== "string") return [`${variable}: cannot tell which Google project the credential belongs to`];
  return project === expected ? [] : [`${variable} belongs to another project than ${target} (${expected})`];
}

/**
 * Compares the configured identifiers with the targets of APP_ENV. Returns the errors found.
 * Configured values are never printed: a secret pasted into the wrong variable stays out of logs.
 */
export function assertTargets(targets: Targets, env: Env, options: AssertOptions = {}): string[] {
  const value = (name: string): string => (env[name] ?? "").trim();
  const configured = BINDINGS.filter((binding) => value(binding.variable) !== "");
  const stripeKey = value("STRIPE_SECRET_KEY");
  const appEnv = value("APP_ENV");
  const ownerTunnels = [
    ...OWNER_TUNNEL_TOKENS.filter(({ variable }) => value(variable) !== "").flatMap(({ variable, target, tunnel }) =>
      tunnelTokenErrors(variable, value(variable), targets, target, tunnel(targets)),
    ),
    ...sharedBindingErrors(targets, value),
  ];

  if (appEnv === "") {
    if (options.strict) return [...STRICT_REQUIRED.filter((name) => value(name) === "").map((name) => `${name} is required in strict mode`), ...ownerTunnels];
    const names = [...configured.map((binding) => binding.variable), ...CONTEXT_VARIABLES.filter((name) => value(name) !== "")];
    return names.length === 0 ? ownerTunnels : [`APP_ENV is required when ${names.join(", ")} is set`, ...ownerTunnels];
  }
  if (!isAppEnv(appEnv)) return [`APP_ENV must be one of ${APP_ENVS.join(", ")}`];

  const errors: string[] = [...ownerTunnels];
  if (options.strict) {
    for (const name of STRICT_REQUIRED) if (value(name) === "") errors.push(`${name} is required in strict mode`);
  }
  for (const binding of configured) {
    const target = binding.target.replace("<env>", appEnv);
    const expected = binding.expected(targets, appEnv);
    const actual = binding.normalize ? binding.normalize(value(binding.variable)) : value(binding.variable);
    if (expected === null) {
      errors.push(`${binding.variable} is set but ${target} is not recorded in infra/targets.json`);
    } else if (actual !== expected) {
      errors.push(`${binding.variable} does not match ${target} (${expected})`);
    }
  }
  if (stripeKey !== "") errors.push(...checkStripeMode(appEnv, stripeKey));
  // cloudflared's own variable (/etc/joutiya/<env>/tunnel.env on the VM, docs/phase-1.md step 9):
  // `node --env-file=/etc/joutiya/<env>/tunnel.env scripts/assert-target.ts` checks it in place.
  const tunnelToken = value("TUNNEL_TOKEN");
  if (tunnelToken !== "") {
    const target = `environments.${appEnv}.cloudflare.tunnelId`;
    errors.push(...tunnelTokenErrors("TUNNEL_TOKEN", tunnelToken, targets, target, targets.environments[appEnv].cloudflare.tunnelId));
  }
  const expectedProject = targets.environments[appEnv].firebase.projectId;
  const credentials = value("GOOGLE_APPLICATION_CREDENTIALS");
  if (credentials !== "") errors.push(...projectFileErrors("GOOGLE_APPLICATION_CREDENTIALS", credentials, expectedProject, appEnv, options));
  const firebaseConfig = value("FIREBASE_CONFIG");
  if (firebaseConfig !== "") {
    if (expectedProject === null) {
      errors.push(`FIREBASE_CONFIG is set but environments.${appEnv}.firebase.projectId is not recorded in infra/targets.json`);
    } else if (firebaseConfig.startsWith("{")) {
      const project = parseJson(firebaseConfig)?.projectId;
      if (project !== expectedProject) errors.push(`FIREBASE_CONFIG does not match environments.${appEnv}.firebase.projectId (${expectedProject})`);
    } else {
      errors.push(...projectFileErrors("FIREBASE_CONFIG", firebaseConfig, expectedProject, appEnv, options));
    }
  }
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
  const strict = process.argv.includes("--strict");
  const errors = assertTargets(raw as Targets, process.env, { strict });
  if (errors.length > 0) fail(errors);
  const appEnv = process.env.APP_ENV?.trim();
  const mode = strict ? ", strict" : "";
  console.log(`assert-target: OK (${appEnv ? `APP_ENV=${appEnv}` : "targets file valid, APP_ENV not set"}${mode})`);
}

// realpath: Node resolves symlinks in import.meta.url, so a symlinked checkout still runs main().
// The file name check keeps main() out of bundles that import this module (dist/worker/index.mjs
// shares import.meta.url with its entry point).
const self = fileURLToPath(import.meta.url);
if (/[\\/]assert-target\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) main();
