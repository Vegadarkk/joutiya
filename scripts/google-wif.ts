// Keyless Google access (§9, guide phase 1, step 9): Workload Identity Federation with X.509
// certificates for the VM's web and worker, and with GitHub's OIDC tokens for the staging CI
// deployer. Runs on the machine that holds the CA (the owner's PC2, by his agent): the CA key never
// leaves it, and gcloud signs in through a configuration of its own (~/.joutiya/gcloud), so the
// gcloud setup of his other projects stays as it is. Dry run unless --apply; nothing here prints a
// token or a key.
//
//   node scripts/google-wif.ts ca [--new]
//       the CA (EC P-256, 10 years) in ~/.joutiya/wif-ca, once; afterwards its fingerprint. --new
//       moves the current one aside and makes another (rotation: then setup and oracle-vm.ts wif).
//   node scripts/google-wif.ts login
//       gcloud sign-in (browser) in that configuration, with the Google account of the Firebase projects.
//   node scripts/google-wif.ts setup <staging|prod> [--apply]
//       in the environment's Firebase project recorded in infra/targets.json: the IAM, IAM Credentials,
//       STS and Resource Manager APIs; the service accounts joutiya-web and joutiya-worker with their
//       roles (§9); pool joutiya-vm, whose provider x509 trusts the CA and accepts the subjects
//       joutiya-<env>-web and joutiya-<env>-worker only. Staging also gets joutiya-deployer and pool
//       github, for deploy-staging.yml on main. Adds what is missing, never removes anything.
//   node scripts/google-wif.ts test <staging|prod>
//       one-day certificates signed here prove the chain end to end: a Firestore read and a custom
//       token (web), a Firestore read and a Firebase Auth admin call (worker). Their keys are deleted.
//       scripts/restore-firestore.ts writes the same way, as the worker (mintCredentials).
//   node scripts/google-wif.ts sign <file>
//       signs the VM's requests, the `request joutiya-<env>-<service> <base64>` lines printed by
//       `oracle-vm.ts wif <env> --apply` (keys made on the VM), for 365 days; prints one
//       `certificate ...` line each, for `oracle-vm.ts wif <env> --certificates=<file> --apply`.
//       Requests and certificates are public: they travel as text, the keys never do.

import { spawnSync } from "node:child_process";
import { X509Certificate, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateTargets, type Targets } from "./assert-target.ts";
import { DEPLOYED_ENVS, type DeployedEnv } from "./vm-env.ts";

export const WIF_SERVICES = ["web", "worker"] as const;
export type WifService = (typeof WIF_SERVICES)[number];
export const VM_POOL = "joutiya-vm";
export const VM_PROVIDER = "x509";
export const GITHUB_POOL = "github";
export const GITHUB_PROVIDER = "joutiya";
/** Google refuses leaf certificates valid more than 390 days. */
export const LEAF_DAYS = 365;
const CA_DAYS = 3650;
export const APIS = ["iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com", "cloudresourcemanager.googleapis.com"] as const;
const DEPLOY_WORKFLOW = ".github/workflows/deploy-staging.yml";

const RESOURCE_MANAGER = "https://cloudresourcemanager.googleapis.com/v1";
const SERVICE_USAGE = "https://serviceusage.googleapis.com/v1";
const IAM = "https://iam.googleapis.com/v1";

// ---------------------------------------------------------------------------------------------
// Names and files.

export function subjectName(env: DeployedEnv, service: WifService): string {
  return `joutiya-${env}-${service}`;
}

export function serviceAccountEmail(name: string, project: string): string {
  return `${name}@${project}.iam.gserviceaccount.com`;
}

function poolPath(projectNumber: string, pool: string): string {
  return `projects/${projectNumber}/locations/global/workloadIdentityPools/${pool}`;
}

/** IAM member of one container: the CN of its certificate, mapped to google.subject. */
export function vmPrincipal(projectNumber: string, subject: string): string {
  return `principal://iam.googleapis.com/${poolPath(projectNumber, VM_POOL)}/subject/${subject}`;
}

export function githubPrincipalSet(projectNumber: string, repositoryId: string): string {
  return `principalSet://iam.googleapis.com/${poolPath(projectNumber, GITHUB_POOL)}/attribute.repository_id/${repositoryId}`;
}

/** Value of the GitHub variable FIREBASE_STAGING_WIF_PROVIDER (deploy-staging.yml). */
export function githubProviderName(projectNumber: string): string {
  return `${poolPath(projectNumber, GITHUB_POOL)}/providers/${GITHUB_PROVIDER}`;
}

/** The CA and the gcloud configuration live there on the CA machine (JOUTIYA_WIF_HOME: tests only). */
export function wifHome(): string {
  return process.env.JOUTIYA_WIF_HOME?.trim() || join(homedir(), ".joutiya");
}

export interface CaFiles {
  dir: string;
  key: string;
  cert: string;
}

export function caFiles(home = wifHome()): CaFiles {
  const dir = join(home, "wif-ca");
  return { dir, key: join(dir, "ca.key"), cert: join(dir, "ca.pem") };
}

/** What gcloud's `iam workload-identity-pools create-cred-config` writes for an X.509 provider. */
export function credentialConfig(input: { projectNumber: string; project: string; service: WifService; certificateConfigPath: string }): Record<string, unknown> {
  const account = serviceAccountEmail(`joutiya-${input.service}`, input.project);
  return {
    universe_domain: "googleapis.com",
    type: "external_account",
    audience: `//iam.googleapis.com/${poolPath(input.projectNumber, VM_POOL)}/providers/${VM_PROVIDER}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:mtls",
    token_url: "https://sts.mtls.googleapis.com/v1/token",
    credential_source: { certificate: { certificate_config_location: input.certificateConfigPath } },
    service_account_impersonation_url: `https://iamcredentials.mtls.googleapis.com/v1/projects/-/serviceAccounts/${account}:generateAccessToken`,
  };
}

/** Certificate and key of the workload, read again by google-auth-library at each token refresh. */
export function certificateConfig(certPath: string, keyPath: string): Record<string, unknown> {
  return { cert_configs: { workload: { cert_path: certPath, key_path: keyPath } } };
}

// ---------------------------------------------------------------------------------------------
// Certificates (openssl: Git Bash ships it on Windows, Ubuntu on the VM).

export function openssl(args: string[], input?: string): string {
  const result = spawnSync("openssl", args, { input, encoding: "utf8", maxBuffer: 1 << 20 });
  if (result.error) {
    throw new Error((result.error as NodeJS.ErrnoException).code === "ENOENT" ? "openssl not found: run this from Git Bash" : `openssl: ${result.error.message}`);
  }
  if (result.status !== 0) throw new Error(`openssl ${args[0] ?? ""} failed: ${result.stderr.trim().split("\n").slice(-2).join(" ")}`);
  return result.stdout;
}

/** An openssl configuration whose distinguished name is `dn` (one "KEY = value" per line). */
function opensslConfig(dn: string[]): string {
  return [
    "[req]",
    "prompt = no",
    "distinguished_name = dn",
    "[dn]",
    ...dn,
    "[ca_ext]",
    "basicConstraints = critical, CA:TRUE, pathlen:0",
    "keyUsage = critical, keyCertSign, cRLSign",
    "subjectKeyIdentifier = hash",
    "[leaf_ext]",
    "basicConstraints = critical, CA:FALSE",
    "keyUsage = critical, digitalSignature",
    "extendedKeyUsage = clientAuth",
    "subjectKeyIdentifier = hash",
    "authorityKeyIdentifier = keyid",
    "",
  ].join("\n");
}

function withConfig<T>(dn: string[], run: (config: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "joutiya-openssl-"));
  try {
    const config = join(dir, "openssl.cnf");
    writeFileSync(config, opensslConfig(dn));
    return run(config);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CA_DN = ["O = Joutiya", "CN = Joutiya VM CA"];

/** The CA, checked: still valid, a CA, EC P-256. */
export function readCa(files: CaFiles, now = new Date()): X509Certificate {
  if (!existsSync(files.cert) || !existsSync(files.key)) throw new Error(`no CA in ${files.dir}: run \`node scripts/google-wif.ts ca\` first`);
  const ca = new X509Certificate(readFileSync(files.cert));
  const key = ca.publicKey.asymmetricKeyDetails;
  if (!ca.ca || ca.publicKey.asymmetricKeyType !== "ec" || key?.namedCurve !== "prime256v1") throw new Error(`${files.cert} is not the Joutiya VM CA`);
  if (new Date(ca.validTo).getTime() <= now.getTime()) throw new Error(`the CA expired on ${ca.validTo}: \`ca --new\`, then setup and oracle-vm.ts wif for both environments`);
  return ca;
}

function describeCa(files: CaFiles): void {
  const ca = readCa(files);
  console.log(`CA ${files.cert}: ${ca.subject.replace(/\n/g, ", ")}, valid until ${ca.validTo}, SHA-256 ${ca.fingerprint256}`);
}

export function createCa(files: CaFiles, rotate = false): void {
  if (existsSync(files.cert) || existsSync(files.key)) {
    if (!rotate) {
      describeCa(files);
      return;
    }
    const aside = `${files.dir}-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
    renameSync(files.dir, aside);
    console.log(`previous CA moved to ${aside}: delete it once both environments trust the new one`);
  }
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  withConfig(CA_DN, (config) =>
    openssl(["req", "-x509", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", files.key, "-out", files.cert, "-days", String(CA_DAYS), "-sha256", "-config", config, "-extensions", "ca_ext"]),
  );
  chmodSync(files.key, 0o600);
  describeCa(files);
}

/** Positive 128-bit serial, as openssl's -set_serial reads it. */
export function randomSerial(): string {
  const bytes = randomBytes(16);
  bytes.writeUInt8((bytes.readUInt8(0) & 0x7f) | 0x40, 0);
  return `0x${bytes.toString("hex")}`;
}

/** Why `pem` is not a client certificate of `subject` from this CA, valid at most `days` days. */
export function leafProblems(pem: string, subject: string, ca: X509Certificate, days: number, now = new Date()): string[] {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return ["not a certificate"];
  }
  const problems: string[] = [];
  if (cert.subject !== `CN=${subject}`) problems.push(`subject ${cert.subject.replace(/\n/g, ", ")} instead of CN=${subject}`);
  if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) problems.push("not signed by the CA");
  if (cert.ca) problems.push("a CA certificate");
  if (cert.publicKey.asymmetricKeyType !== "ec" || cert.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") problems.push("key is not EC P-256");
  const end = new Date(cert.validTo).getTime();
  if (end <= now.getTime()) problems.push("already expired");
  if (end - now.getTime() > (days + 1) * 86_400_000) problems.push(`valid more than ${days} days`);
  return problems;
}

/**
 * Signs a request (PEM) as a client certificate of `subject`. The request's extensions are never
 * copied, and the result is checked before anyone uses it.
 */
export function signCsr(input: { csr: string; subject: string; days: number; ca: CaFiles }): string {
  const ca = readCa(input.ca);
  const pem = withConfig(CA_DN, (config) =>
    openssl(["x509", "-req", "-CA", input.ca.cert, "-CAkey", input.ca.key, "-set_serial", randomSerial(), "-days", String(input.days), "-sha256", "-extfile", config, "-extensions", "leaf_ext"], input.csr),
  ).replace(/\r\n/g, "\n");
  const problems = leafProblems(pem, input.subject, ca, input.days);
  if (problems.length > 0) throw new Error(`certificate for ${input.subject} refused: ${problems.join("; ")}`);
  return pem;
}

/** PEM of a base64 DER block. */
export function pemBlock(label: "CERTIFICATE" | "CERTIFICATE REQUEST", der: string): string {
  return [`-----BEGIN ${label}-----`, ...(der.match(/.{1,64}/g) ?? []), `-----END ${label}-----`, ""].join("\n");
}

/** Base64 DER of a PEM block. */
export function derBase64(pem: string): string {
  return pem.replace(/-----(?:BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
}

/** The request the VM prints as `csr <base64 DER>`, as PEM. */
export function csrFromOutput(output: string): string {
  const match = /^csr ([A-Za-z0-9+/]{100,2000}={0,2})$/m.exec(output);
  if (!match?.[1]) throw new Error("the VM sent no certificate request");
  return pemBlock("CERTIFICATE REQUEST", match[1]);
}

export interface WifLine {
  env: DeployedEnv;
  service: WifService;
  subject: string;
  /** Base64 DER of the request or of the certificate. */
  der: string;
}

const WIF_LINE = /^(request|certificate) joutiya-(staging|prod)-(web|worker) ([A-Za-z0-9+/]{100,4000}={0,2})$/gm;

/**
 * The `request` or `certificate` lines of a text relayed by hand: other lines (and the other kind)
 * are ignored, a subject given twice is refused.
 */
export function wifLines(text: string, kind: "request" | "certificate"): WifLine[] {
  const lines: WifLine[] = [];
  for (const match of text.replace(/\r\n/g, "\n").matchAll(WIF_LINE)) {
    if (match[1] !== kind) continue;
    const env = match[2] as DeployedEnv;
    const service = match[3] as WifService;
    const subject = subjectName(env, service);
    if (lines.some((line) => line.subject === subject)) throw new Error(`${subject} is given twice`);
    lines.push({ env, service, subject, der: match[4] as string });
  }
  return lines;
}

/** Signs every request line of `text` (LEAF_DAYS days) and returns the certificate lines. */
export function signRequests(text: string, ca: CaFiles): string[] {
  const requests = wifLines(text, "request");
  if (requests.length === 0) throw new Error("no `request joutiya-<env>-<web|worker> <base64>` line found");
  return requests.map(({ subject, der }) => {
    const certificate = signCsr({ csr: pemBlock("CERTIFICATE REQUEST", der), subject, days: LEAF_DAYS, ca });
    return `certificate ${subject} ${derBase64(certificate)}`;
  });
}

// ---------------------------------------------------------------------------------------------
// What `setup` wants in each project (§9).

export interface Grant {
  role: string;
  member: string;
}

export interface AccountPlan {
  name: string;
  displayName: string;
  description: string;
  /** Project roles of the account. */
  roles: string[];
  /** Who may act as the account (its own IAM policy). */
  bindings: Grant[];
}

export function accountPlans(env: DeployedEnv, project: string, projectNumber: string, repositoryId: string | null): AccountPlan[] {
  const plans: AccountPlan[] = [
    {
      name: "joutiya-web",
      displayName: "Joutiya web",
      description: `web container of joutiya-vm (${env}), through Workload Identity Federation`,
      roles: ["roles/datastore.user", "roles/firebaseauth.admin"],
      bindings: [
        { role: "roles/iam.workloadIdentityUser", member: vmPrincipal(projectNumber, subjectName(env, "web")) },
        // Custom tokens are signed by IAM (signBlob) with this very account, never with a key.
        { role: "roles/iam.serviceAccountTokenCreator", member: `serviceAccount:${serviceAccountEmail("joutiya-web", project)}` },
      ],
    },
    {
      name: "joutiya-worker",
      displayName: "Joutiya worker",
      description: `worker container of joutiya-vm (${env}), through Workload Identity Federation`,
      roles: ["roles/datastore.user", "roles/firebaseauth.admin"],
      bindings: [{ role: "roles/iam.workloadIdentityUser", member: vmPrincipal(projectNumber, subjectName(env, "worker")) }],
    },
  ];
  if (env === "staging") {
    if (repositoryId === null) throw new Error("shared.github.repositoryId is not recorded in infra/targets.json");
    plans.push({
      name: "joutiya-deployer",
      displayName: "Joutiya deployer (CI)",
      description: `Firestore rules and indexes from ${DEPLOY_WORKFLOW} on main`,
      // `firebase deploy --only firestore:rules,firestore:indexes`; its API check sends
      // x-goog-user-project, which needs serviceusage.services.get and .use.
      roles: ["roles/firebaserules.admin", "roles/datastore.indexAdmin", "roles/serviceusage.serviceUsageConsumer"],
      bindings: [{ role: "roles/iam.workloadIdentityUser", member: githubPrincipalSet(projectNumber, repositoryId) }],
    });
  }
  return plans;
}

export interface Provider {
  name?: string;
  state?: string;
  disabled?: boolean;
  displayName?: string;
  description?: string;
  attributeMapping?: Record<string, string>;
  attributeCondition?: string;
  x509?: { trustStore?: { trustAnchors?: { pemCertificate?: string }[] } };
  oidc?: { issuerUri?: string };
}

export function vmProviderBody(env: DeployedEnv, caPem: string): Provider {
  const subjects = WIF_SERVICES.map((service) => JSON.stringify(subjectName(env, service))).join(", ");
  return {
    displayName: "Joutiya VM",
    description: `Containers of joutiya-vm (${env}), certificates of the Joutiya VM CA (guide phase 1, step 9)`,
    attributeMapping: { "google.subject": "assertion.subject.dn.cn" },
    attributeCondition: `assertion.subject.dn.cn in [${subjects}]`,
    // openssl on Windows writes ca.pem with CRLF, which Google refuses ("not in PEM format").
    x509: { trustStore: { trustAnchors: [{ pemCertificate: caPem.replace(/\r\n/g, "\n").trim() }] } },
  };
}

export function githubProviderBody(repositoryId: string): Provider {
  return {
    displayName: "GitHub Actions",
    description: `${DEPLOY_WORKFLOW} on main of repository ${repositoryId} only`,
    attributeMapping: {
      "google.subject": "assertion.sub",
      "attribute.repository_id": "assertion.repository_id",
      "attribute.ref": "assertion.ref",
      "attribute.workflow_ref": "assertion.workflow_ref",
    },
    attributeCondition: `assertion.repository_id == "${repositoryId}" && assertion.ref == "refs/heads/main" && assertion.workflow_ref.endsWith("/${DEPLOY_WORKFLOW}@refs/heads/main")`,
    oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
  };
}

function fingerprints(provider: Provider | undefined): string[] | undefined {
  try {
    return (provider?.x509?.trustStore?.trustAnchors ?? []).map((anchor) => new X509Certificate(anchor.pemCertificate ?? "").fingerprint256).sort();
  } catch {
    return undefined;
  }
}

/** Fields of `found` that differ from `wanted`: the update mask of a PATCH. */
export function providerChanges(found: Provider, wanted: Provider): string[] {
  const changes: string[] = [];
  const mapping = (value: Record<string, string> | undefined): string => JSON.stringify(Object.entries(value ?? {}).sort());
  if (mapping(found.attributeMapping) !== mapping(wanted.attributeMapping)) changes.push("attributeMapping");
  if ((found.attributeCondition ?? "") !== (wanted.attributeCondition ?? "")) changes.push("attributeCondition");
  if (wanted.x509 && JSON.stringify(fingerprints(found)) !== JSON.stringify(fingerprints(wanted))) changes.push("x509");
  if (wanted.oidc && found.oidc?.issuerUri !== wanted.oidc.issuerUri) changes.push("oidc");
  return changes;
}

export interface IamBinding {
  role: string;
  members?: string[];
  condition?: unknown;
}

export interface IamPolicy {
  version?: number;
  etag?: string;
  bindings?: IamBinding[];
}

/** Grants the policy lacks; a conditional binding does not count. */
export function missingGrants(policy: IamPolicy, grants: Grant[]): Grant[] {
  return grants.filter(
    ({ role, member }) => !(policy.bindings ?? []).some((binding) => binding.role === role && binding.condition === undefined && (binding.members ?? []).includes(member)),
  );
}

/** The policy plus these grants; everything else (etag, version, other bindings) kept as read. */
export function withGrants(policy: IamPolicy, grants: Grant[]): IamPolicy {
  const bindings = (policy.bindings ?? []).map((binding) => ({ ...binding, members: [...(binding.members ?? [])] }));
  for (const { role, member } of grants) {
    const binding = bindings.find((item) => item.role === role && item.condition === undefined);
    if (!binding) bindings.push({ role, members: [member] });
    else if (!binding.members.includes(member)) binding.members.push(member);
  }
  return { ...policy, bindings };
}

// ---------------------------------------------------------------------------------------------
// Google REST, with the owner's gcloud token. Reads always run; writes are printed, and sent with --apply.

export class GoogleError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export class Google {
  readonly apply: boolean;
  readonly #token: string;

  constructor(token: string, apply: boolean) {
    this.#token = token;
    this.apply = apply;
  }

  async call<T>(method: "GET" | "POST" | "PATCH", url: string, body?: unknown): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) {
      let reason = "";
      let message = raw.slice(0, 300);
      try {
        const parsed = JSON.parse(raw) as { error?: { status?: string; message?: string } };
        reason = parsed.error?.status ?? "";
        message = parsed.error?.message ?? message;
      } catch {
        // not JSON: keep the start of the body
      }
      throw new GoogleError(response.status, reason, `${method} ${new URL(url).pathname}: HTTP ${response.status} ${reason} ${message}`);
    }
    return (raw === "" ? {} : JSON.parse(raw)) as T;
  }

  /** undefined when the resource does not exist. */
  async get<T>(url: string): Promise<T | undefined> {
    try {
      return await this.call<T>("GET", url);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 404) return undefined;
      throw error;
    }
  }

  async write<T>(method: "POST" | "PATCH", url: string, body: unknown, what: string): Promise<T | undefined> {
    console.log(`${this.apply ? "apply" : "plan "} ${what}`);
    return this.apply ? this.call<T>(method, url, body) : undefined;
  }
}

interface Operation {
  name?: string;
  done?: boolean;
  error?: { message?: string };
}

export interface Waits {
  sleep: (ms: number) => Promise<void>;
  /** Polls of an operation, and tries of an IAM policy update. */
  attempts: number;
  operationMs: number;
  /** IAM needs a few seconds to know an account it has just created. */
  policyMs: number;
}

const WAITS: Waits = { sleep: (ms) => new Promise((done) => setTimeout(done, ms)), attempts: 30, operationMs: 2_000, policyMs: 10_000 };

async function waitOperation(google: Google, host: string, operation: Operation | undefined, what: string, waits: Waits): Promise<void> {
  let current = operation;
  for (let poll = 1; current && !current.done; poll += 1) {
    if (!current.name || poll > waits.attempts) throw new Error(`${what}: not done in time, run setup again`);
    await waits.sleep(waits.operationMs);
    current = await google.call<Operation>("GET", `${host}/${current.name}`);
  }
  if (current?.error) throw new GoogleError(400, "FAILED_PRECONDITION", `${what}: ${current.error.message ?? "failed"}`);
}

function billing(error: unknown): boolean {
  return error instanceof GoogleError && /billing/i.test(error.message);
}

async function enableApis(google: Google, project: string, waits: Waits): Promise<void> {
  const states = await Promise.all(
    APIS.map(async (api) => ({ api, state: (await google.get<{ state?: string }>(`${SERVICE_USAGE}/projects/${project}/services/${api}`))?.state })),
  );
  const missing = states.filter(({ state }) => state !== "ENABLED").map(({ api }) => api);
  if (missing.length === 0) {
    console.log(`APIs enabled: ${APIS.join(", ")}`);
    return;
  }
  try {
    const operation = await google.write<Operation>("POST", `${SERVICE_USAGE}/projects/${project}/services:batchEnable`, { serviceIds: missing }, `enable ${missing.join(", ")}`);
    await waitOperation(google, SERVICE_USAGE, operation, "enabling the APIs", waits);
  } catch (error) {
    if (billing(error)) {
      throw new Error(
        `Google asks for a billing account to enable ${missing.join(", ")}: nothing else done. The fallback (one JSON key per container, renewed every 90 days) needs the owner's approval (guide phase 1, step 9).`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** True when the account exists (or was just created). */
async function ensureAccount(google: Google, project: string, plan: AccountPlan): Promise<boolean> {
  const email = serviceAccountEmail(plan.name, project);
  const account = await google.get<{ disabled?: boolean }>(`${IAM}/projects/${project}/serviceAccounts/${email}`);
  if (account) {
    if (account.disabled) throw new Error(`service account ${email} is disabled: enable it on purpose, this tool never does`);
    console.log(`service account ${plan.name}: exists`);
    return true;
  }
  try {
    await google.write(
      "POST",
      `${IAM}/projects/${project}/serviceAccounts`,
      { accountId: plan.name, serviceAccount: { displayName: plan.displayName, description: plan.description } },
      `create service account ${plan.name}`,
    );
  } catch (error) {
    if (!(error instanceof GoogleError && error.status === 409)) throw error;
  }
  return google.apply;
}

/** Read-modify-write of one IAM policy, adding the grants it lacks. */
async function grant(google: Google, label: string, read: { url: string; body?: unknown }, writeUrl: string, grants: Grant[], waits: Waits): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const policy = await google.call<IamPolicy>("POST", read.url, read.body);
      const missing = missingGrants(policy, grants);
      if (missing.length === 0) {
        console.log(`${label}: every grant in place`);
        return;
      }
      await google.write("POST", writeUrl, { policy: withGrants(policy, missing) }, `${label}: ${missing.map(({ role, member }) => `${role} to ${member}`).join("; ")}`);
      return;
    } catch (error) {
      // A concurrent change (409), or an account IAM does not know yet (404, 400 "does not exist").
      const again = error instanceof GoogleError && (error.status === 404 || error.status === 409 || (error.status === 400 && /does not exist/i.test(error.message)));
      if (!again || attempt >= waits.attempts) throw error;
      await waits.sleep(waits.policyMs);
    }
  }
}

async function ensurePool(google: Google, project: string, pool: string, displayName: string, description: string, waits: Waits): Promise<void> {
  const pools = `${IAM}/projects/${project}/locations/global/workloadIdentityPools`;
  const found = await google.get<Provider>(`${pools}/${pool}`);
  if (found?.disabled) throw new Error(`pool ${pool} is disabled: enable it on purpose, this tool never does`);
  if (found?.state === "ACTIVE") {
    console.log(`pool ${pool}: exists`);
    return;
  }
  const operation =
    found?.state === "DELETED"
      ? await google.write<Operation>("POST", `${pools}/${pool}:undelete`, {}, `undelete pool ${pool} (deleted less than 30 days ago)`)
      : await google.write<Operation>("POST", `${pools}?workloadIdentityPoolId=${pool}`, { displayName, description }, `create pool ${pool}`);
  await waitOperation(google, IAM, operation, `pool ${pool}`, waits);
}

async function ensureProvider(google: Google, project: string, pool: string, provider: string, wanted: Provider, waits: Waits): Promise<void> {
  const providers = `${IAM}/projects/${project}/locations/global/workloadIdentityPools/${pool}/providers`;
  let found = await google.get<Provider>(`${providers}/${provider}`);
  if (found?.disabled) throw new Error(`provider ${pool}/${provider} is disabled: enable it on purpose, this tool never does`);
  if (found?.state === "DELETED") {
    const operation = await google.write<Operation>("POST", `${providers}/${provider}:undelete`, {}, `undelete provider ${pool}/${provider}, then align its settings`);
    await waitOperation(google, IAM, operation, `provider ${pool}/${provider}`, waits);
    if (!google.apply) return;
    found = await google.get<Provider>(`${providers}/${provider}`);
  }
  if (!found) {
    const operation = await google.write<Operation>("POST", `${providers}?workloadIdentityPoolProviderId=${provider}`, wanted, `create provider ${pool}/${provider}`);
    await waitOperation(google, IAM, operation, `provider ${pool}/${provider}`, waits);
    return;
  }
  const changes = providerChanges(found, wanted);
  if (changes.length === 0) {
    console.log(`provider ${pool}/${provider}: as wanted`);
    return;
  }
  const operation = await google.write<Operation>("PATCH", `${providers}/${provider}?updateMask=${changes.join(",")}`, wanted, `update provider ${pool}/${provider}: ${changes.join(", ")}`);
  await waitOperation(google, IAM, operation, `provider ${pool}/${provider}`, waits);
}

export interface SetupInput {
  env: DeployedEnv;
  project: string;
  projectNumber: string;
  caPem: string;
  repositoryId: string | null;
}

export async function setup(google: Google, input: SetupInput, waits: Waits = WAITS): Promise<void> {
  const { env, project, projectNumber } = input;
  const found = await google.get<{ projectNumber?: string; lifecycleState?: string }>(`${RESOURCE_MANAGER}/projects/${project}`);
  if (!found) throw new Error(`project ${project}: not found, or this Google account cannot see it`);
  if (found.projectNumber !== projectNumber || found.lifecycleState !== "ACTIVE") {
    throw new Error(`project ${project} is number ${found.projectNumber ?? "?"}, ${found.lifecycleState ?? "?"}; infra/targets.json records ${projectNumber}, ACTIVE: nothing done`);
  }
  await enableApis(google, project, waits);

  const plans = accountPlans(env, project, projectNumber, input.repositoryId);
  const exists = new Map<string, boolean>();
  for (const plan of plans) exists.set(plan.name, await ensureAccount(google, project, plan));
  const roles = plans.flatMap((plan) => plan.roles.map((role) => ({ role, member: `serviceAccount:${serviceAccountEmail(plan.name, project)}` })));
  const projectPolicy = `${RESOURCE_MANAGER}/projects/${project}`;
  await grant(google, `project ${project}`, { url: `${projectPolicy}:getIamPolicy`, body: { options: { requestedPolicyVersion: 3 } } }, `${projectPolicy}:setIamPolicy`, roles, waits);

  await ensurePool(google, project, VM_POOL, "Joutiya VM", `Containers of joutiya-vm (${env})`, waits);
  await ensureProvider(google, project, VM_POOL, VM_PROVIDER, vmProviderBody(env, input.caPem), waits);
  if (env === "staging" && input.repositoryId !== null) {
    await ensurePool(google, project, GITHUB_POOL, "GitHub Actions", "Repository joutiya, staging deploys only", waits);
    await ensureProvider(google, project, GITHUB_POOL, GITHUB_PROVIDER, githubProviderBody(input.repositoryId), waits);
  }

  for (const plan of plans) {
    const label = `service account ${plan.name}`;
    if (!exists.get(plan.name)) {
      console.log(`plan  ${label}: ${plan.bindings.map(({ role, member }) => `${role} to ${member}`).join("; ")}`);
      continue;
    }
    const resource = `${IAM}/projects/${project}/serviceAccounts/${serviceAccountEmail(plan.name, project)}`;
    await grant(google, label, { url: `${resource}:getIamPolicy?options.requestedPolicyVersion=3` }, `${resource}:setIamPolicy`, plan.bindings, waits);
  }
  if (env === "staging") {
    console.log(`GitHub variables of step 8: FIREBASE_STAGING_WIF_PROVIDER=${githubProviderName(projectNumber)} FIREBASE_STAGING_DEPLOYER=${serviceAccountEmail("joutiya-deployer", project)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// gcloud, in its own configuration directory.

export function gcloudConfigDir(): string {
  return join(wifHome(), "gcloud");
}

function gcloud(args: string[], capture: boolean): { status: number | null; stdout: string } {
  mkdirSync(gcloudConfigDir(), { recursive: true, mode: 0o700 });
  // gcloud is a .cmd on Windows, which Node starts only through a shell; the arguments are constants.
  const result = spawnSync("gcloud", args, {
    env: { ...process.env, CLOUDSDK_CONFIG: gcloudConfigDir() },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw new Error(`gcloud: ${result.error.message} (install the Google Cloud CLI)`);
  return { status: result.status, stdout: result.stdout ?? "" };
}

/** Access token of the gcloud sign-in made by `login` (also used by scripts/legal-config.ts). */
export function gcloudAccessToken(): string {
  const { status, stdout } = gcloud(["auth", "print-access-token"], true);
  const token = stdout.trim();
  if (status !== 0 || !/^[\w.-]{20,}$/.test(token)) throw new Error(`no gcloud sign-in in ${gcloudConfigDir()}: run \`node scripts/google-wif.ts login\` first`);
  return token;
}

function login(): void {
  if (gcloud(["auth", "login", "--brief"], false).status !== 0) throw new Error("gcloud sign-in failed");
  console.log(`signed in; configuration ${gcloudConfigDir()} only, the other gcloud settings are untouched`);
}

// ---------------------------------------------------------------------------------------------
// One-day credentials of a container's identity, signed here: `test`, and the writes of
// scripts/restore-firestore.ts (as the worker).

export function recorded(targets: Targets, env: DeployedEnv): { project: string; projectNumber: string } {
  const { projectId, projectNumber } = targets.environments[env].firebase;
  if (projectId === null || projectNumber === null) throw new Error(`environments.${env}.firebase is not recorded in infra/targets.json`);
  return { project: projectId, projectNumber };
}

export interface MintedCredentials {
  /** The file for GOOGLE_APPLICATION_CREDENTIALS. */
  path: string;
  /** Deletes the key, its certificate and their configurations. */
  remove(): void;
}

/**
 * Credentials of `service` in `env` for one day: a key made here, its certificate signed by this
 * machine's CA, in a private temporary folder that `remove` deletes. google-auth-library reads the
 * certificate again at each token refresh: remove only once done.
 */
export function mintCredentials(targets: Targets, env: DeployedEnv, service: WifService, ca = caFiles()): MintedCredentials {
  const { project, projectNumber } = recorded(targets, env);
  readCa(ca);
  const dir = mkdtempSync(join(tmpdir(), `joutiya-wif-${service}-`));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  try {
    const subject = subjectName(env, service);
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    const certificateConfigPath = join(dir, "certificate_config.json");
    const path = join(dir, "credentials.json");
    openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", key]);
    const csr = withConfig([`CN = ${subject}`], (config) => openssl(["req", "-new", "-key", key, "-config", config]));
    writeFileSync(cert, signCsr({ csr, subject, days: 1, ca }));
    writeFileSync(certificateConfigPath, JSON.stringify(certificateConfig(cert, key)));
    writeFileSync(path, JSON.stringify(credentialConfig({ projectNumber, project, service, certificateConfigPath })));
    return { path, remove };
  } catch (error) {
    remove();
    throw error;
  }
}

/** Variables that would send the Google libraries elsewhere: an emulator, a client certificate of their own, another gcloud setup. */
const FOREIGN_GOOGLE_ENV = [
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "GOOGLE_API_CERTIFICATE_CONFIG",
  "GOOGLE_API_USE_CLIENT_CERTIFICATE",
  "GOOGLE_API_USE_MTLS_ENDPOINT",
  "CLOUDSDK_CONFIG",
  "CLOUDSDK_CORE_PROJECT",
] as const;

/** `base` signed in with these credentials only, in `project`: never an emulator or another project's settings. */
export function keylessEnv(project: string, credentials: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GOOGLE_APPLICATION_CREDENTIALS: credentials, GOOGLE_CLOUD_PROJECT: project, GCLOUD_PROJECT: project };
  for (const name of FOREIGN_GOOGLE_ENV) Reflect.deleteProperty(env, name);
  return env;
}

// ---------------------------------------------------------------------------------------------
// test: the chain end to end, from a child process per container.

const self = fileURLToPath(import.meta.url);
const PROBE_TRIES = 6;
const PROBE_PAUSE_MS = 60_000;

async function test(env: DeployedEnv, targets: Targets): Promise<void> {
  const { project } = recorded(targets, env);
  const ca = caFiles();
  let failed = 0;
  for (const service of WIF_SERVICES) {
    const credentials = mintCredentials(targets, env, service, ca);
    try {
      let ok = false;
      for (let attempt = 1; attempt <= PROBE_TRIES && !ok; attempt += 1) {
        if (attempt > 1) {
          console.log(`${service}: trying again in ${PROBE_PAUSE_MS / 1000} s (IAM changes take a few minutes to apply)`);
          await new Promise((done) => setTimeout(done, PROBE_PAUSE_MS));
        }
        ok = spawnSync(process.execPath, [self, "probe", service, project], { env: keylessEnv(project, credentials.path), stdio: "inherit" }).status === 0;
      }
      if (!ok) failed += 1;
    } finally {
      credentials.remove();
    }
  }
  if (failed > 0) throw new Error(`${env}: ${failed} of ${WIF_SERVICES.length} containers cannot reach Google without a key`);
  console.log(`${env}: web and worker reach Firestore and Firebase Auth without a key`);
}

/** Child of `test`: what web and worker do with these credentials, as src/lib/firebase/admin.ts does it. */
async function probe(service: WifService, project: string): Promise<void> {
  const { applicationDefault, deleteApp, initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getAuth } = await import("firebase-admin/auth");
  const app = initializeApp({
    projectId: project,
    credential: applicationDefault(),
    ...(service === "web" ? { serviceAccountId: serviceAccountEmail("joutiya-web", project) } : {}),
  });
  try {
    const legal = await getFirestore(app).doc("config/legal").get();
    console.log(`${service}: Firestore read ok (config/legal ${legal.exists ? "present" : "not written yet"})`);
    if (service === "web") {
      await getAuth(app).createCustomToken("joutiya-wif-test");
      console.log("web: custom token signed by IAM ok");
    } else {
      await getAuth(app).listUsers(1);
      console.log("worker: Firebase Auth admin ok");
    }
  } finally {
    await deleteApp(app);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [action, env, extra] = args.filter((arg) => !arg.startsWith("--"));
  if (action === "probe") {
    if (!(WIF_SERVICES as readonly string[]).includes(env ?? "") || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(extra ?? "")) throw new Error("usage: probe <web|worker> <project>");
    await probe(env as WifService, extra as string);
    return;
  }
  const perEnv = action === "setup" || action === "test";
  const argument = perEnv || action === "sign";
  if (!action || !["ca", "login", "setup", "test", "sign"].includes(action) || argument !== (env !== undefined) || (perEnv && !(DEPLOYED_ENVS as readonly string[]).includes(env ?? ""))) {
    throw new Error("usage: scripts/google-wif.ts <ca [--new]|login|setup <staging|prod> [--apply]|test <staging|prod>|sign <file>>");
  }
  if (action === "ca") return createCa(caFiles(), args.includes("--new"));
  if (action === "login") return login();
  if (action === "sign") {
    console.log(signRequests(readFileSync(env as string, "utf8"), caFiles()).join("\n"));
    console.log(`\nValid ${LEAF_DAYS} days. These lines are public: send them back as they are.`);
    return;
  }

  const raw: unknown = JSON.parse(readFileSync(new URL("../infra/targets.json", import.meta.url), "utf8"));
  const errors = validateTargets(raw);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const targets = raw as Targets;
  const deployed = env as DeployedEnv;
  if (action === "test") return test(deployed, targets);

  const ca = caFiles();
  readCa(ca);
  const google = new Google(gcloudAccessToken(), args.includes("--apply"));
  await setup(google, { env: deployed, ...recorded(targets, deployed), caPem: readFileSync(ca.cert, "utf8"), repositoryId: targets.shared.github.repositoryId });
  console.log(google.apply ? "\nDone." : "\nDry run: nothing written. Add --apply to send these requests.");
}

if (/[\\/]google-wif\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().then(
    // The probe's Firestore client may keep a gRPC channel open: exit once done.
    () => process.exit(0),
    (error: unknown) => {
      console.error(`google-wif: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
