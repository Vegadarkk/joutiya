import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  APIS,
  Google,
  LEAF_DAYS,
  accountPlans,
  caFiles,
  certificateConfig,
  createCa,
  credentialConfig,
  csrFromOutput,
  derBase64,
  githubProviderBody,
  githubProviderName,
  missingGrants,
  openssl,
  providerChanges,
  readCa,
  setup,
  signCsr,
  signRequests,
  vmPrincipal,
  vmProviderBody,
  wifLines,
  withGrants,
  type IamPolicy,
  type Provider,
  type Waits,
} from "../../scripts/google-wif";
import { RUN_COMMAND_MAX_BYTES, rootCommand, wifCertificates, wifDir, wifInstallScript, wifKeyScript, wifRecreateScript } from "../../scripts/oracle-vm";

const work = mkdtempSync(join(tmpdir(), "joutiya-wif-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const quiet = (): string[] => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
  return lines;
};

const ca = caFiles(join(work, "home"));
quiet();
createCa(ca);
vi.restoreAllMocks();
const caPem = readFileSync(ca.cert, "utf8");

/** A key and its request for `cn`, made as the VM makes them; extra arguments go to `openssl req`. */
function request(dir: string, cn: string, extra: string[] = []): { key: string; csr: string } {
  mkdirSync(dir, { recursive: true });
  const key = join(dir, "key.pem");
  openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", key]);
  return { key, csr: openssl(["req", "-new", "-key", key, "-subj", `/CN=${cn}`, ...extra]) };
}

/** google-auth-library as firebase-admin loads it (its own copy, not firebase-tools'). */
interface AuthLibrary {
  ExternalAccountClient: { fromJSON(options: Record<string, unknown>): { constructor: { name: string }; retrieveSubjectToken(): Promise<string> } | null };
}
const authLibrary = createRequire(join(process.cwd(), "node_modules/firebase-admin/package.json"))("google-auth-library") as AuthLibrary;

describe("credential files", () => {
  it("are gcloud's create-cred-config output for the X.509 provider", () => {
    expect(credentialConfig({ projectNumber: "365736224142", project: "joutiya-staging", service: "web", certificateConfigPath: "/etc/joutiya/staging/gcp/web/certificate_config.json" })).toEqual({
      universe_domain: "googleapis.com",
      type: "external_account",
      audience: "//iam.googleapis.com/projects/365736224142/locations/global/workloadIdentityPools/joutiya-vm/providers/x509",
      subject_token_type: "urn:ietf:params:oauth:token-type:mtls",
      token_url: "https://sts.mtls.googleapis.com/v1/token",
      credential_source: { certificate: { certificate_config_location: "/etc/joutiya/staging/gcp/web/certificate_config.json" } },
      service_account_impersonation_url:
        "https://iamcredentials.mtls.googleapis.com/v1/projects/-/serviceAccounts/joutiya-web@joutiya-staging.iam.gserviceaccount.com:generateAccessToken",
    });
    expect(certificateConfig("/c.pem", "/k.pem")).toEqual({ cert_configs: { workload: { cert_path: "/c.pem", key_path: "/k.pem" } } });
  });
});

describe("what setup wants", () => {
  it("lets each environment's provider accept its own two containers only", () => {
    const prod = vmProviderBody("prod", `${caPem}\n\n`);
    expect(prod.attributeMapping).toEqual({ "google.subject": "assertion.subject.dn.cn" });
    expect(prod.attributeCondition).toBe('assertion.subject.dn.cn in ["joutiya-prod-web", "joutiya-prod-worker"]');
    expect(prod.x509?.trustStore?.trustAnchors).toEqual([{ pemCertificate: caPem.trim() }]);
    expect(prod.displayName?.length).toBeLessThanOrEqual(32);
  });

  it("lets GitHub act only for deploy-staging.yml on main of the recorded repository", () => {
    const github = githubProviderBody("1406007525");
    expect(github.oidc).toEqual({ issuerUri: "https://token.actions.githubusercontent.com" });
    expect(github.attributeCondition).toBe(
      'assertion.repository_id == "1406007525" && assertion.ref == "refs/heads/main" && assertion.workflow_ref.endsWith("/.github/workflows/deploy-staging.yml@refs/heads/main")',
    );
    expect(githubProviderName("365736224142")).toBe("projects/365736224142/locations/global/workloadIdentityPools/github/providers/joutiya");
  });

  it("gives the accounts the roles of §9, and the deployer to staging only", () => {
    const staging = accountPlans("staging", "joutiya-staging", "365736224142", "1406007525");
    expect(staging.map((plan) => [plan.name, plan.roles])).toEqual([
      ["joutiya-web", ["roles/datastore.user", "roles/firebaseauth.admin"]],
      ["joutiya-worker", ["roles/datastore.user", "roles/firebaseauth.admin"]],
      ["joutiya-deployer", ["roles/firebaserules.admin", "roles/datastore.indexAdmin", "roles/serviceusage.serviceUsageConsumer"]],
    ]);
    expect(staging[0]?.bindings).toEqual([
      { role: "roles/iam.workloadIdentityUser", member: "principal://iam.googleapis.com/projects/365736224142/locations/global/workloadIdentityPools/joutiya-vm/subject/joutiya-staging-web" },
      { role: "roles/iam.serviceAccountTokenCreator", member: "serviceAccount:joutiya-web@joutiya-staging.iam.gserviceaccount.com" },
    ]);
    expect(staging[2]?.bindings).toEqual([
      { role: "roles/iam.workloadIdentityUser", member: "principalSet://iam.googleapis.com/projects/365736224142/locations/global/workloadIdentityPools/github/attribute.repository_id/1406007525" },
    ]);
    expect(accountPlans("prod", "joutiya-prod", "652258095167", null).map((plan) => plan.name)).toEqual(["joutiya-web", "joutiya-worker"]);
    expect(() => accountPlans("staging", "joutiya-staging", "365736224142", null)).toThrow(/repositoryId is not recorded/);
  });

  it("adds grants to a policy without touching the rest", () => {
    const policy: IamPolicy = {
      version: 3,
      etag: "BwX1",
      bindings: [
        { role: "roles/owner", members: ["user:owner@example.com"] },
        { role: "roles/datastore.user", members: ["serviceAccount:a@p.iam.gserviceaccount.com"] },
        { role: "roles/firebaseauth.admin", members: ["serviceAccount:b@p.iam.gserviceaccount.com"], condition: { expression: "false" } },
      ],
    };
    const grants = [
      { role: "roles/datastore.user", member: "serviceAccount:a@p.iam.gserviceaccount.com" },
      { role: "roles/datastore.user", member: "serviceAccount:b@p.iam.gserviceaccount.com" },
      { role: "roles/firebaseauth.admin", member: "serviceAccount:b@p.iam.gserviceaccount.com" },
    ];
    const missing = missingGrants(policy, grants);
    expect(missing).toEqual(grants.slice(1));
    const updated = withGrants(policy, missing);
    expect(updated.etag).toBe("BwX1");
    expect(updated.version).toBe(3);
    expect(updated.bindings).toEqual([
      { role: "roles/owner", members: ["user:owner@example.com"] },
      { role: "roles/datastore.user", members: ["serviceAccount:a@p.iam.gserviceaccount.com", "serviceAccount:b@p.iam.gserviceaccount.com"] },
      { role: "roles/firebaseauth.admin", members: ["serviceAccount:b@p.iam.gserviceaccount.com"], condition: { expression: "false" } },
      { role: "roles/firebaseauth.admin", members: ["serviceAccount:b@p.iam.gserviceaccount.com"] },
    ]);
    expect(missingGrants(updated, grants)).toEqual([]);
    expect(policy.bindings?.[1]?.members).toHaveLength(1);
  });

  it("updates a provider only where it differs", () => {
    const wanted = vmProviderBody("staging", caPem);
    expect(providerChanges({ ...wanted, state: "ACTIVE", name: "x" }, wanted)).toEqual([]);
    const other = caFiles(join(work, "other"));
    quiet();
    createCa(other);
    expect(providerChanges(vmProviderBody("staging", readFileSync(other.cert, "utf8")), wanted)).toEqual(["x509"]);
    expect(providerChanges(vmProviderBody("prod", caPem), wanted)).toEqual(["attributeCondition"]);
    expect(providerChanges({ ...githubProviderBody("1"), oidc: { issuerUri: "https://example.com" } }, githubProviderBody("1"))).toEqual(["oidc"]);
  });
});

describe("the CA and the certificates", () => {
  it("makes the CA once (EC P-256, ten years, private key), and a new one only on --new", () => {
    const cert = readCa(ca);
    expect(cert.ca).toBe(true);
    expect(cert.subject).toBe("O=Joutiya\nCN=Joutiya VM CA");
    expect(new Date(cert.validTo).getTime() - Date.now()).toBeGreaterThan(3640 * 86_400_000);
    expect(statSync(ca.key).mode & 0o777).toBe(0o600);
    const lines = quiet();
    createCa(ca);
    expect(readFileSync(ca.cert, "utf8")).toBe(caPem);
    expect(lines.join("\n")).toContain(cert.fingerprint256);

    const rotated = caFiles(join(work, "rotated"));
    createCa(rotated);
    const before = readFileSync(rotated.cert, "utf8");
    createCa(rotated, true);
    expect(readFileSync(rotated.cert, "utf8")).not.toBe(before);
    expect(readdirSync(join(work, "rotated")).filter((name) => name.startsWith("wif-ca-"))).toHaveLength(1);
  });

  it("signs a one-year client certificate for the expected subject only", () => {
    const { csr } = request(join(work, "sign"), "joutiya-staging-web");
    const cert = new X509Certificate(signCsr({ csr, subject: "joutiya-staging-web", days: LEAF_DAYS, ca }));
    expect(cert.subject).toBe("CN=joutiya-staging-web");
    expect(cert.issuer).toBe("O=Joutiya\nCN=Joutiya VM CA");
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toEqual(["1.3.6.1.5.5.7.3.2"]);
    const days = (new Date(cert.validTo).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(LEAF_DAYS - 1);
    expect(days).toBeLessThan(LEAF_DAYS + 1);

    expect(() => signCsr({ csr, subject: "joutiya-prod-web", days: LEAF_DAYS, ca })).toThrow(/refused: subject CN=joutiya-staging-web instead of CN=joutiya-prod-web/);
  });

  it("never copies the request's extensions (a request cannot make itself a CA)", () => {
    const { csr } = request(join(work, "ca-request"), "joutiya-staging-worker", ["-addext", "basicConstraints=critical,CA:TRUE"]);
    expect(new X509Certificate(signCsr({ csr, subject: "joutiya-staging-worker", days: 1, ca })).ca).toBe(false);
  });

  it("reads the VM's request, and refuses anything else", () => {
    // The base64 of the DER request, on one line, as `base64 -w0` prints it on the VM.
    const base64 = request(join(work, "der"), "joutiya-prod-worker").csr.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    const pem = csrFromOutput(`warning: noise\ncsr ${base64}\n`);
    expect(pem.split("\n").every((line) => line.length <= 64 || line.startsWith("-----"))).toBe(true);
    expect(openssl(["req", "-noout", "-subject"], pem).trim()).toBe("subject=CN = joutiya-prod-worker");
    expect(() => csrFromOutput("csr \n")).toThrow(/no certificate request/);
    expect(() => csrFromOutput("nothing")).toThrow(/no certificate request/);
  });

  it("signs the request lines relayed as text, whatever surrounds them, for the four subjects only", () => {
    const der = (cn: string) => derBase64(request(join(work, "lines", cn), cn).csr);
    const text = [
      "Requests from the VM (copied from a chat):",
      `request joutiya-staging-web ${der("joutiya-staging-web")}\r`,
      `request joutiya-staging-worker ${der("joutiya-staging-worker")}`,
      `request joutiya-dev-web ${der("joutiya-dev-web")}`,
      `certificate joutiya-prod-web ${der("joutiya-prod-web")}`,
      "",
    ].join("\n");
    expect(wifLines(text, "request").map((line) => line.subject)).toEqual(["joutiya-staging-web", "joutiya-staging-worker"]);
    const certificates = signRequests(text, ca);
    expect(certificates.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual(["certificate joutiya-staging-web", "certificate joutiya-staging-worker"]);
    expect(wifCertificates(certificates.join("\n"), "staging").size).toBe(2);

    expect(() => signRequests("no request here", ca)).toThrow(/no `request/);
    const twice = `request joutiya-prod-web ${der("joutiya-prod-web")}\nrequest joutiya-prod-web ${der("joutiya-prod-web")}`;
    expect(() => wifLines(twice, "request")).toThrow(/joutiya-prod-web is given twice/);
    // A line may only carry its own subject's request.
    expect(() => signRequests(`request joutiya-prod-web ${der("joutiya-prod-worker")}`, ca)).toThrow(/refused: subject CN=joutiya-prod-worker/);
  });

  it("checks the certificate lines before they travel to the VM", () => {
    const sign = (cn: string, days = LEAF_DAYS) => derBase64(signCsr({ csr: request(join(work, "certs", cn), cn).csr, subject: cn, days, ca }));
    const web = sign("joutiya-prod-web");
    const worker = sign("joutiya-prod-worker");
    expect([...wifCertificates(`certificate joutiya-prod-web ${web}\ncertificate joutiya-prod-worker ${worker}`, "prod").keys()]).toEqual(["web", "worker"]);
    expect(() => wifCertificates(`certificate joutiya-prod-web ${web}`, "prod")).toThrow(/no `certificate joutiya-prod-worker/);
    expect(() => wifCertificates(`certificate joutiya-prod-web ${web}\ncertificate joutiya-prod-worker ${worker}`, "staging")).toThrow(/no `certificate joutiya-staging-web/);
    expect(() => wifCertificates(`certificate joutiya-prod-web ${worker}\ncertificate joutiya-prod-worker ${worker}`, "prod")).toThrow(/joutiya-prod-web: the certificate is for CN=joutiya-prod-worker/);
    const later = new Date(Date.now() + 2 * 86_400_000);
    const shortLived = sign("joutiya-prod-worker", 1);
    expect(() => wifCertificates(`certificate joutiya-prod-web ${web}\ncertificate joutiya-prod-worker ${shortLived}`, "prod", later)).toThrow(/joutiya-prod-worker: the certificate has expired/);
  });
});

describe("the VM side (oracle-vm.ts wif)", () => {
  const sandbox = join(work, "vm");
  const etc = join(sandbox, "etc");
  const state = join(sandbox, "state");
  const bin = join(sandbox, "bin");
  const calls = join(sandbox, "docker.log");
  mkdirSync(join(etc, "staging"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // As root on the VM: install -d with owner and group, chgrp to joutiya-<env>. Here: plain mkdir.
  writeFileSync(join(bin, "install"), '#!/bin/bash\ndirs=()\nwhile (($#)); do case "$1" in -d) shift;; -m|-o|-g) shift 2;; *) dirs+=("$1"); shift;; esac; done\nmkdir -p "${dirs[@]}"\n');
  writeFileSync(join(bin, "chgrp"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "docker"), '#!/bin/bash\necho "APP_ENV=$APP_ENV RELEASE=$RELEASE $*" >> "$CALLS"\n');
  for (const name of ["install", "chgrp", "docker"]) chmodSync(join(bin, name), 0o755);

  const local = (script: string): string => script.replaceAll("/etc/joutiya", join(etc, "joutiya")).replaceAll("/var/lib/joutiya", state);
  const run = (script: string) =>
    spawnSync("bash", ["-euo", "pipefail", "-c", local(script)], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, CALLS: calls } });
  mkdirSync(join(etc, "joutiya", "staging"), { recursive: true });
  // The files name the VM's paths, as oracle-vm.ts writes them; local() moves them into the sandbox.
  const vmDir = wifDir("staging", "web");
  const dir = local(vmDir);
  const files = {
    credentials: JSON.stringify(credentialConfig({ projectNumber: "365736224142", project: "joutiya-staging", service: "web", certificateConfigPath: `${vmDir}/certificate_config.json` })),
    certificateConfig: JSON.stringify(certificateConfig(`${vmDir}/cert.pem`, `${vmDir}/key.pem`)),
  };

  it("makes the key on the VM, installs the signed certificate, and google-auth-library reads the result", async () => {
    const key = run(wifKeyScript("staging", "web"));
    expect(key.status, key.stderr).toBe(0);
    // The text hand-off: request line from the VM, certificate line from the CA machine.
    const signed = signRequests(`request joutiya-staging-web ${derBase64(csrFromOutput(key.stdout))}`, ca).join("\n");
    const worker = signRequests(`request joutiya-staging-worker ${derBase64(request(join(work, "e2e-worker"), "joutiya-staging-worker").csr)}`, ca).join("\n");
    const certificate = wifCertificates(`${signed}\n${worker}`, "staging").get("web") ?? "";
    const install = run(wifInstallScript("staging", "web", certificate, files));
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toMatch(/^web: joutiya-staging-web installed, valid until /);
    expect(readdirSync(dir).sort()).toEqual(["cert.pem", "certificate_config.json", "credentials.json", "key.pem"]);
    for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o640);

    const client = authLibrary.ExternalAccountClient.fromJSON(JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")) as Record<string, unknown>);
    expect(client?.constructor.name).toBe("IdentityPoolClient");
    const chain = JSON.parse((await client?.retrieveSubjectToken()) ?? "[]") as string[];
    expect(chain).toEqual([new X509Certificate(certificate).raw.toString("base64")]);
  });

  it("refuses a certificate of another key and keeps the installed pair", () => {
    const before = readFileSync(join(dir, "cert.pem"), "utf8");
    expect(run(wifKeyScript("staging", "web")).status).toBe(0);
    const install = run(wifInstallScript("staging", "web", before, files));
    expect(install.status).toBe(1);
    expect(install.stderr).toContain("does not match key.next.pem");
    expect(readFileSync(join(dir, "cert.pem"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "key.next.pem"))).toBe(true);
  });

  it("recreates web and worker only when a release runs", () => {
    const idle = run(wifRecreateScript("staging"));
    expect(idle.status).toBe(0);
    expect(idle.stdout).toContain("runs no release yet");
    expect(existsSync(calls)).toBe(false);
    writeFileSync(join(state, "staging.release"), "0123456789abcdef\n");
    expect(run(wifRecreateScript("staging")).status).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain(
      "APP_ENV=staging RELEASE=0123456789abcdef compose --project-directory /opt/joutiya/docker -f /opt/joutiya/docker/compose.yml -f /opt/joutiya/docker/compose.staging.yml up -d --no-deps --force-recreate --wait --wait-timeout 240 web worker",
    );
  });

  it("fits each step in one Run Command, and refuses what a shell would misread", () => {
    const certificate = readFileSync(join(dir, "cert.pem"), "utf8");
    const real = {
      credentials: JSON.stringify(credentialConfig({ projectNumber: "652258095167", project: "joutiya-prod", service: "worker", certificateConfigPath: `${wifDir("prod", "worker")}/certificate_config.json` })),
      certificateConfig: JSON.stringify(certificateConfig(`${wifDir("prod", "worker")}/cert.pem`, `${wifDir("prod", "worker")}/key.pem`)),
    };
    for (const script of [wifKeyScript("prod", "worker"), wifInstallScript("prod", "worker", certificate, real), wifRecreateScript("prod")]) {
      expect(Buffer.byteLength(rootCommand(script))).toBeLessThan(RUN_COMMAND_MAX_BYTES);
    }
    expect(wifKeyScript("prod", "worker")).toContain("-subj /CN=joutiya-prod-worker");
    expect(() => wifInstallScript("prod", "worker", "not a certificate", real)).toThrow(/not a PEM certificate/);
    expect(() => wifInstallScript("prod", "worker", certificate, { ...real, credentials: "{\"a\":\"it's\"}" })).toThrow(/quote/);
  });
});

describe("setup", () => {
  const PROJECT = "joutiya-staging";
  const NUMBER = "365736224142";
  const waits: Waits = { sleep: () => Promise.resolve(), attempts: 3, operationMs: 0, policyMs: 0 };

  interface World {
    number: string;
    services: Record<string, string>;
    accounts: Set<string>;
    projectPolicy: IamPolicy;
    accountPolicies: Map<string, IamPolicy>;
    pools: Map<string, Provider>;
    providers: Map<string, Provider>;
    billing?: boolean;
  }

  const fresh = (): World => ({
    number: NUMBER,
    services: Object.fromEntries(APIS.map((api) => [api, api === "iam.googleapis.com" ? "ENABLED" : "DISABLED"])),
    accounts: new Set(),
    projectPolicy: { version: 1, etag: "e0", bindings: [{ role: "roles/owner", members: ["user:owner@example.com"] }] },
    accountPolicies: new Map(),
    pools: new Map(),
    providers: new Map(),
  });

  /** Google's REST API for one project, enough for setup; returns the requests it served. */
  function serve(world: World): string[] {
    const requests: string[] = [];
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const missing = () => reply(404, { error: { status: "NOT_FOUND", message: "not found" } });
    const done = { name: "operations/x", done: true };
    vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      const body = (init.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
      const path = decodeURIComponent(url.pathname);
      requests.push(`${method} ${url.host}${path}${url.search}`);
      let match: RegExpExecArray | null;
      if (url.host === "cloudresourcemanager.googleapis.com") {
        if (method === "GET" && path === `/v1/projects/${PROJECT}`) return reply(200, { projectNumber: world.number, lifecycleState: "ACTIVE" });
        if (path === `/v1/projects/${PROJECT}:getIamPolicy`) return reply(200, world.projectPolicy);
        if (path === `/v1/projects/${PROJECT}:setIamPolicy`) {
          world.projectPolicy = { ...(body.policy as IamPolicy), etag: "e1" };
          return reply(200, world.projectPolicy);
        }
      }
      if (url.host === "serviceusage.googleapis.com") {
        if ((match = /^\/v1\/projects\/[^/]+\/services\/(.+)$/.exec(path)) && method === "GET") return reply(200, { state: world.services[match[1] ?? ""] ?? "DISABLED" });
        if (path.endsWith("/services:batchEnable")) {
          if (world.billing) return reply(400, { error: { status: "FAILED_PRECONDITION", message: "Billing must be enabled for activation of service(s) 'sts.googleapis.com' to proceed." } });
          for (const api of body.serviceIds as string[]) world.services[api] = "ENABLED";
          return reply(200, done);
        }
      }
      if (url.host === "iam.googleapis.com") {
        if ((match = /^\/v1\/projects\/[^/]+\/serviceAccounts\/([^/:]+)(:getIamPolicy|:setIamPolicy)?$/.exec(path))) {
          const email = match[1] ?? "";
          if (!world.accounts.has(email)) return missing();
          if (match[2] === ":setIamPolicy") world.accountPolicies.set(email, body.policy as IamPolicy);
          if (match[2]) return reply(200, world.accountPolicies.get(email) ?? {});
          return reply(200, { email });
        }
        if (path === `/v1/projects/${PROJECT}/serviceAccounts` && method === "POST") {
          world.accounts.add(`${String(body.accountId)}@${PROJECT}.iam.gserviceaccount.com`);
          return reply(200, {});
        }
        if ((match = /^\/v1\/projects\/[^/]+\/locations\/global\/workloadIdentityPools(?:\/([^/:]+))?(?:\/providers(?:\/([^/:]+))?)?$/.exec(path))) {
          const [, pool, provider] = match;
          if (pool === undefined && method === "POST") {
            world.pools.set(url.searchParams.get("workloadIdentityPoolId") ?? "", { state: "ACTIVE" });
            return reply(200, done);
          }
          if (pool !== undefined && path.endsWith("/providers") && method === "POST") {
            world.providers.set(`${pool}/${url.searchParams.get("workloadIdentityPoolProviderId") ?? ""}`, { ...(body as Provider), state: "ACTIVE" });
            return reply(200, done);
          }
          if (pool !== undefined && provider !== undefined) {
            const found = world.providers.get(`${pool}/${provider}`);
            if (method === "PATCH") {
              world.providers.set(`${pool}/${provider}`, { ...found, ...(body as Provider) });
              return reply(200, done);
            }
            return found ? reply(200, found) : missing();
          }
          if (pool !== undefined) return world.pools.has(pool) ? reply(200, world.pools.get(pool)) : missing();
        }
      }
      return reply(500, { error: { status: "INTERNAL", message: `unexpected ${method} ${path}` } });
    });
    return requests;
  }

  const writes = (requests: string[]) => requests.filter((line) => !line.startsWith("GET ") && !line.includes(":getIamPolicy"));
  const input = { env: "staging" as const, project: PROJECT, projectNumber: NUMBER, caPem, repositoryId: "1406007525" };

  it("only reads in a dry run, and prints what it would do", async () => {
    const world = fresh();
    const requests = serve(world);
    const lines = quiet();
    await setup(new Google("token", false), input, waits);
    expect(writes(requests)).toEqual([]);
    const plan = lines.filter((line) => line.startsWith("plan "));
    expect(plan[0]).toBe("plan  enable iamcredentials.googleapis.com, sts.googleapis.com, cloudresourcemanager.googleapis.com");
    expect(plan).toContain("plan  create service account joutiya-deployer");
    expect(plan).toContain("plan  create pool joutiya-vm");
    expect(plan).toContain("plan  create provider github/joutiya");
    expect(plan.some((line) => line.includes(`roles/iam.workloadIdentityUser to ${vmPrincipal(NUMBER, "joutiya-staging-worker")}`))).toBe(true);
  });

  it("creates what is missing, then finds nothing left to do", async () => {
    const world = fresh();
    serve(world);
    quiet();
    await setup(new Google("token", true), input, waits);
    expect(Object.values(world.services)).toEqual(APIS.map(() => "ENABLED"));
    expect([...world.accounts].sort()).toEqual(["joutiya-deployer", "joutiya-web", "joutiya-worker"].map((name) => `${name}@${PROJECT}.iam.gserviceaccount.com`));
    expect(world.projectPolicy.bindings).toContainEqual({ role: "roles/owner", members: ["user:owner@example.com"] });
    expect(world.projectPolicy.bindings).toContainEqual({
      role: "roles/datastore.user",
      members: [`serviceAccount:joutiya-web@${PROJECT}.iam.gserviceaccount.com`, `serviceAccount:joutiya-worker@${PROJECT}.iam.gserviceaccount.com`],
    });
    expect([...world.pools.keys()]).toEqual(["joutiya-vm", "github"]);
    expect(world.providers.get("joutiya-vm/x509")?.attributeCondition).toBe('assertion.subject.dn.cn in ["joutiya-staging-web", "joutiya-staging-worker"]');
    expect(world.providers.get("github/joutiya")?.oidc?.issuerUri).toBe("https://token.actions.githubusercontent.com");
    expect(world.accountPolicies.get(`joutiya-web@${PROJECT}.iam.gserviceaccount.com`)?.bindings).toEqual([
      { role: "roles/iam.workloadIdentityUser", members: [vmPrincipal(NUMBER, "joutiya-staging-web")] },
      { role: "roles/iam.serviceAccountTokenCreator", members: [`serviceAccount:joutiya-web@${PROJECT}.iam.gserviceaccount.com`] },
    ]);

    const again = serve(world);
    await setup(new Google("token", true), input, waits);
    expect(writes(again)).toEqual([]);
  });

  it("realigns a provider that trusts another CA", async () => {
    const world = fresh();
    serve(world);
    quiet();
    await setup(new Google("token", true), input, waits);
    const other = caFiles(join(work, "realign"));
    createCa(other);
    const requests = serve(world);
    await setup(new Google("token", true), { ...input, caPem: readFileSync(other.cert, "utf8") }, waits);
    expect(writes(requests)).toEqual([
      "PATCH iam.googleapis.com/v1/projects/joutiya-staging/locations/global/workloadIdentityPools/joutiya-vm/providers/x509?updateMask=x509",
    ]);
  });

  it("stops before anything else when Google asks for billing, or on another project", async () => {
    const world = { ...fresh(), billing: true };
    const requests = serve(world);
    quiet();
    await expect(setup(new Google("token", true), input, waits)).rejects.toThrow(/billing account .* needs the owner's approval/);
    expect(writes(requests)).toEqual(["POST serviceusage.googleapis.com/v1/projects/joutiya-staging/services:batchEnable"]);
    expect(world.accounts.size).toBe(0);

    const elsewhere = serve({ ...fresh(), number: "100000000009" });
    await expect(setup(new Google("token", true), input, waits)).rejects.toThrow(/infra\/targets.json records 365736224142, ACTIVE: nothing done/);
    expect(writes(elsewhere)).toEqual([]);
  });
});
