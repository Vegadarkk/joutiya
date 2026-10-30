// Applies the Cloudflare edge configuration of infra/cloudflare/ (§2, §6) to the account and zones
// recorded in infra/targets.json, and nowhere else: each zone id must be that zone (joutiya.ma,
// aalan.ma, a3lan.ma) in that account, each tunnel must be joutiya-<name>-tunnel. A zone not
// recorded yet is skipped. Dry run by default (prints the requests); --apply sends.
//
//   node --env-file=<owner env file> scripts/cloudflare.ts <part>... [--apply] [--replace-dns]
//   node --env-file=<owner env file> scripts/cloudflare.ts zone --check
//   node --env-file=<owner env file> scripts/cloudflare.ts loadtest --on|--off [--apply]
//   parts: zone (settings and rules), tunnel:staging, tunnel:prod, tunnel:ssh, access, r2, loadtest
// zone --check reads the live settings and rules, compares them with the files and exits 1 on any
// drift (a missing transform rule lets a client forge X-Verified-Bot); zone --apply runs it after
// its writes. Every recorded zone gets the same settings and rulesets: their rules name hosts, so
// a rule only fires in its own zone. Hostnames that only redirect (redirect-hosts.json) get a
// proxied AAAA 100:: record in their zone, so the redirect rules see their requests.
//
// Environment (never printed): JOUTIYA_CLOUDFLARE_API_TOKEN, a custom token limited to the Joutiya
// account and its zones (a prefixed name: a shared shell may hold other projects' tokens);
// for access: ACCESS_OWNER_EMAIL, ACCESS_CI_TOKEN_ID, ACCESS_PROBE_TOKEN_ID, ACCESS_SCAN_TOKEN_ID.
// r2 only checks: Nav applies r2-buckets.json in the dashboard (bucket settings need account-wide
// R2 rights), and this part sends its CORS preflights, which need no token.
// loadtest --on puts a temporary skip rule first in the WAF custom rules (load test of staging,
// D17: no edge rate limit, managed rules, Browser Integrity Check or Security Level for requests
// to staging carrying x-joutiya-loadtest = JOUTIYA_LOADTEST_BYPASS_SECRET, never printed);
// loadtest --off puts waf-rules.json back. zone --check reports the rule as drift while it is on.
// An existing A, AAAA or CNAME record on a tunnel hostname is only replaced with --replace-dns, and
// a hostname guarded by Access gets its DNS record only once its Access application exists.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLOUDFLARE_ZONES, recordedZoneId, validateTargets, zoneOf, type AppEnv, type EnvTargets, type Targets, type ZoneName } from "./assert-target.ts";
import { requireEnvProxy } from "./env-proxy.ts";

const API = "https://api.cloudflare.com/client/v4";
const DIR = new URL("../infra/cloudflare/", import.meta.url);
const TARGETS = new URL("../infra/targets.json", import.meta.url);

/** Rule counts of Cloudflare Free per phase. */
export const FREE_LIMITS: Record<string, number> = {
  http_request_firewall_custom: 5,
  http_ratelimit: 1,
  http_request_late_transform: 10,
  http_request_cache_settings: 10,
  http_request_dynamic_redirect: 10,
};

export const RULESET_FILES = ["waf-rules.json", "ratelimit-rules.json", "transform-rules.json", "cache-rules.json", "redirect-rules.json"];
/** One Tunnel per environment (Compose connector) and one for SSH (host connector, §2). */
export const TUNNELS = ["staging", "prod", "ssh"] as const;
export type TunnelName = (typeof TUNNELS)[number];

export interface Rule {
  ref: string;
  description: string;
  expression: string;
  action: string;
  [key: string]: unknown;
}
export interface Ruleset {
  phase: string;
  description: string;
  rules: Rule[];
}
export interface ZoneSettings {
  settings: { id: string; value: unknown }[];
}
export interface Ingress {
  hostname?: string;
  service: string;
}
export interface TunnelConfig {
  config: { ingress: Ingress[] };
}
export interface AccessApp {
  name: string;
  domain: string;
  type: string;
  session_duration: string;
  allowed_idps?: string[];
  auto_redirect_to_identity?: boolean;
  /** Single-header service token authentication (the security scan and the load test). */
  read_service_tokens_from_header?: string;
  policies: { name: string; decision: string; include: unknown[] }[];
}

/** Staff sign in with Google only (§6); the identity provider is looked up in the account. */
export const GOOGLE_IDP = "${ACCESS_GOOGLE_IDP_ID}";
/** infra/targets.json, unchecked: callers validate it with validateTargets. */
export function readTargets(): Targets {
  return JSON.parse(readFileSync(TARGETS, "utf8")) as Targets;
}

/** The site host of an environment (hosts.site of infra/targets.json). */
export function siteHost(targets: Targets, env: AppEnv): string {
  const host = targets.environments[env].hosts.site;
  if (host === null) throw new Error(`environments.${env}.hosts.site must be recorded in infra/targets.json first`);
  return host;
}

/**
 * Resend and Meta cannot sign in, so their webhooks reach the staging site through this path
 * without Access; the routes check each sender's signature and the WAF skips the path. The
 * production site is public: it needs no such path.
 */
export function webhookBypass(targets: Targets): string {
  return `${siteHost(targets, "staging")}/api/webhooks/*`;
}
export const LOADTEST_RULE_REF = "loadtest_skip";
export const LOADTEST_HEADER = "x-joutiya-loadtest";

/** The temporary skip rule of the load test of `host` (staging). The secret is checked first: it goes into an expression. */
export function loadtestRule(secret: string, host: string): Rule {
  if (!/^[A-Za-z0-9]{32,128}$/.test(secret)) throw new Error("JOUTIYA_LOADTEST_BYPASS_SECRET must be 32 to 128 letters and digits");
  return {
    ref: LOADTEST_RULE_REF,
    description: "Load test of staging (temporary, D17): no edge rate limit, managed rules, Browser Integrity Check or Security Level",
    expression: `http.host eq "${host}" and any(http.request.headers["${LOADTEST_HEADER}"][*] eq "${secret}")`,
    action: "skip",
    action_parameters: { phases: ["http_ratelimit", "http_request_firewall_managed"], products: ["bic", "securityLevel"] },
    logging: { enabled: true },
  };
}

/** waf-rules.json with the load test rule of `host` first (secret set) or as committed (null). */
export function loadtestRuleset(base: Ruleset, secret: string | null, host: string): Ruleset {
  if (secret === null) return base;
  const rules = [loadtestRule(secret, host), ...base.rules.filter((rule) => rule.ref !== LOADTEST_RULE_REF)];
  const limit = FREE_LIMITS[base.phase] ?? 0;
  if (rules.length > limit) throw new Error(`${base.phase}: ${rules.length} rules with the load test rule, Free allows ${limit}`);
  return { ...base, rules };
}

/** A value to print, with every occurrence of the secret masked. */
export function redact<T>(value: T, secret: string): T {
  return JSON.parse(JSON.stringify(value).split(secret).join("***")) as T;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

export function readEdgeFile<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, DIR), "utf8")) as T;
}

/** Hostnames that only redirect: no tunnel, a proxied AAAA 100:: record so the redirect rules apply. */
export interface RedirectHosts {
  hostnames: string[];
}
export const PARKED_RECORD = { type: "AAAA", content: "100::" } as const;

/** Where a hostname may live: a project zone, at most one level below it (Universal SSL). */
function hostnameErrors(file: string, hostname: string): string[] {
  const zone = zoneOf(hostname);
  if (zone === null) return [`${file}: ${hostname} is outside ${CLOUDFLARE_ZONES.map(({ name }) => name).join(", ")}`];
  // Universal SSL covers the apex and first-level subdomains only.
  if (hostname.split(".").length > zone.split(".").length + 1) return [`${file}: ${hostname} is not covered by Universal SSL`];
  return [];
}

/** Structure and Free-plan limits of the committed files, and their hosts against infra/targets.json. Returns the errors found. */
export function validateEdge(read: <T>(name: string) => T = readEdgeFile, targets: Targets = readTargets()): string[] {
  const errors: string[] = [];
  const bypassPath = webhookBypass(targets);
  for (const file of RULESET_FILES) {
    const ruleset = read<Ruleset>(file);
    const limit = FREE_LIMITS[ruleset.phase];
    if (limit === undefined) errors.push(`${file}: unknown phase ${ruleset.phase}`);
    else if (ruleset.rules.length > limit) errors.push(`${file}: ${ruleset.rules.length} rules, Free allows ${limit}`);
    const refs = new Set<string>();
    for (const rule of ruleset.rules) {
      if (!rule.ref || !rule.description || !rule.expression || !rule.action) errors.push(`${file}: every rule needs ref, description, expression and action`);
      if (refs.has(rule.ref)) errors.push(`${file}: duplicate ref ${rule.ref}`);
      refs.add(rule.ref);
      if (/\bmatches\b|~/.test(rule.expression)) errors.push(`${file}: ${rule.ref} uses a regex (not on Free)`);
    }
  }
  const access = read<{ apps: AccessApp[] }>("access-apps.json").apps;
  const guarded = new Set(access.map((app) => app.domain));
  for (const app of access) {
    const bypass = app.policies.some((policy) => policy.decision === "bypass");
    if (app.domain === bypassPath) {
      if (app.policies.length !== 1 || !bypass) errors.push(`access-apps.json: ${app.domain} must have a single bypass policy`);
    } else if (bypass || app.domain.includes("/")) {
      errors.push(`access-apps.json: ${app.domain}: only ${bypassPath} may bypass Access`);
    } else if (app.allowed_idps?.length !== 1 || app.allowed_idps[0] !== GOOGLE_IDP || app.auto_redirect_to_identity !== true) {
      errors.push(`access-apps.json: ${app.domain} must allow the Google login method only (§6)`);
    }
  }
  if (!guarded.has(bypassPath)) errors.push(`access-apps.json: no application for ${bypassPath}`);
  const tunneled = new Set<string>();
  for (const name of TUNNELS) {
    const file = `tunnel.${name}.json`;
    const ingress = read<TunnelConfig>(file).config.ingress;
    const last = ingress.at(-1);
    if (!last || last.hostname !== undefined || !last.service.startsWith("http_status:")) errors.push(`${file}: the last ingress rule must be a catch-all http_status`);
    for (const { hostname, service } of ingress) {
      if (hostname === undefined) continue;
      tunneled.add(hostname);
      errors.push(...hostnameErrors(file, hostname));
      if (service.startsWith("ssh://") !== (name === "ssh")) errors.push(`${file}: ${hostname}: SSH goes through tunnel.ssh.json only`);
      const guardedHost = needsAccess(name, hostname);
      if (guardedHost && !guarded.has(hostname)) errors.push(`${file}: ${hostname} has no Access application`);
      if (!guardedHost && guarded.has(hostname)) errors.push(`${file}: ${hostname} is public but has an Access application`);
    }
    // The hosts the app is configured with (SITE_URL, ADMIN_HOST) must reach this environment's tunnel.
    if (name !== "ssh") {
      const hosts = tunnelHostnames(read<TunnelConfig>(file));
      for (const role of ["site", "www", "admin"] as const) {
        const host = targets.environments[name].hosts[role];
        if (host !== null && !hosts.includes(host)) errors.push(`${file}: environments.${name}.hosts.${role} ${host} has no ingress rule`);
      }
    }
  }
  for (const hostname of read<RedirectHosts>("redirect-hosts.json").hostnames) {
    errors.push(...hostnameErrors("redirect-hosts.json", hostname));
    if (tunneled.has(hostname)) errors.push(`redirect-hosts.json: ${hostname} is a tunnel hostname`);
  }
  return errors;
}

/** Replaces ${NAME} in every string of a JSON value. Unset names are reported, never guessed. */
export function substitute<T>(value: T, env: Record<string, string | undefined>): { value: T; missing: string[] } {
  const missing = new Set<string>();
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return node.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
        const resolved = env[name]?.trim();
        if (!resolved) {
          missing.add(name);
          return "";
        }
        return resolved;
      });
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    return node;
  };
  return { value: walk(value) as T, missing: [...missing] };
}

/** Every tunnel hostname is behind Access, except the public production site (§6). */
export function needsAccess(tunnel: TunnelName, hostname: string): boolean {
  return tunnel !== "prod" || hostname.startsWith("admin.");
}

export function tunnelHostnames(config: TunnelConfig): string[] {
  return config.config.ingress.flatMap((rule) => (rule.hostname ? [rule.hostname] : []));
}

export interface DnsChange {
  create: boolean;
  deletes: DnsRecord[];
  /** Records that block the CNAME and need --replace-dns. */
  conflicts: DnsRecord[];
}

/** What to do so that `hostname` is a proxied `type` record to `target` (a tunnel CNAME by default). MX, TXT and others are kept. */
export function dnsChange(existing: DnsRecord[], target: string, replace: boolean, type: "CNAME" | "AAAA" = "CNAME"): DnsChange {
  const blocking = existing.filter((record) => ["A", "AAAA", "CNAME"].includes(record.type));
  const [only] = blocking;
  const done = blocking.length === 1 && only?.type === type && only.content === target && only.proxied === true;
  if (done) return { create: false, deletes: [], conflicts: [] };
  if (blocking.length === 0) return { create: true, deletes: [], conflicts: [] };
  return replace ? { create: true, deletes: blocking, conflicts: [] } : { create: false, deletes: [], conflicts: blocking };
}

/** True when every key of `expected` holds the same value in `live` (live may add API defaults). */
export function containsEdge(expected: unknown, live: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(live) && live.length === expected.length && expected.every((item, index) => containsEdge(item, live[index]));
  }
  if (expected !== null && typeof expected === "object") {
    if (live === null || typeof live !== "object" || Array.isArray(live)) return false;
    return Object.entries(expected).every(([key, value]) => containsEdge(value, (live as Record<string, unknown>)[key]));
  }
  return expected === live;
}

/** Differences between a ruleset file and the live entrypoint of its phase (null: none exists). */
export function rulesetDrift(expected: Ruleset, live: Rule[] | null): string[] {
  if (live === null) return [`${expected.phase}: no ruleset on the zone (${expected.rules.length} rules expected)`];
  const wanted = expected.rules.map((rule) => rule.ref);
  const found = live.map((rule) => rule.ref);
  if (wanted.join(",") !== found.join(",")) return [`${expected.phase}: rules ${found.join(", ") || "(none)"} instead of ${wanted.join(", ")}`];
  return expected.rules.flatMap((rule, index) => (containsEdge(rule, live[index]) ? [] : [`${expected.phase}: rule ${rule.ref} differs from the file`]));
}

/** Differences between zone-settings.json and the live values. */
export function settingsDrift(expected: ZoneSettings, live: Record<string, unknown>): string[] {
  return expected.settings.flatMap((setting) =>
    containsEdge(setting.value, live[setting.id]) ? [] : [`setting ${setting.id} is ${JSON.stringify(live[setting.id])}, expected ${JSON.stringify(setting.value)}`],
  );
}

class CloudflareApi {
  private readonly token: string;
  readonly apply: boolean;
  constructor(token: string, apply: boolean) {
    this.token = token;
    this.apply = apply;
  }

  async call<T>(request: ApiRequest): Promise<T> {
    const response = await fetch(`${API}${request.path}`, {
      method: request.method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    const payload = (await response.json().catch(() => null)) as { success?: boolean; errors?: { code: number; message: string }[]; result?: T } | null;
    if (!response.ok || !payload?.success) {
      const detail = payload?.errors?.map((error) => `${error.code} ${error.message}`).join("; ") ?? "no JSON body";
      throw new Error(`${request.method} ${request.path}: HTTP ${response.status} (${detail})`);
    }
    return payload.result as T;
  }

  /** Reads always run; writes run with --apply, otherwise they are printed. */
  async write(request: ApiRequest, shown: unknown = request.body): Promise<unknown> {
    console.log(`${this.apply ? "apply" : "plan "} ${request.method} ${request.path}${shown === undefined ? "" : `\n${JSON.stringify(shown, null, 2)}`}`);
    return this.apply ? this.call(request) : undefined;
  }
}

interface Zone {
  name: ZoneName;
  id: string;
}

/** The zones recorded in infra/targets.json; the others are printed as not added yet. */
function recordedZones(targets: Targets): Zone[] {
  if (!targets.shared.cloudflare.accountId) throw new Error("shared.cloudflare.accountId must be recorded in infra/targets.json first");
  const zones: Zone[] = [];
  for (const { name, field } of CLOUDFLARE_ZONES) {
    const id = recordedZoneId(targets, name);
    if (id) zones.push({ name, id });
    else console.log(`skip  ${name}: not added yet (shared.cloudflare.${field})`);
  }
  if (zones.length === 0) throw new Error("no zone is recorded in infra/targets.json");
  return zones;
}

/** The recorded zone of a hostname, or null when that zone is not added yet. */
function hostZone(targets: Targets, hostname: string): Zone | null {
  const name = zoneOf(hostname);
  if (name === null) throw new Error(`${hostname} is outside the project zones`);
  const id = recordedZoneId(targets, name);
  return id ? { name, id } : null;
}

async function checkZone(api: CloudflareApi, targets: Targets, zone: Zone): Promise<{ accountId: string; zoneId: string }> {
  const accountId = targets.shared.cloudflare.accountId;
  if (!accountId) throw new Error("shared.cloudflare.accountId must be recorded in infra/targets.json first");
  const live = await api.call<{ name: string; account: { id: string } }>({ method: "GET", path: `/zones/${zone.id}` });
  if (live.name !== zone.name || live.account.id !== accountId) {
    throw new Error(`zone ${zone.id} is not ${zone.name} in account ${accountId}: nothing written`);
  }
  return { accountId, zoneId: zone.id };
}

/** Proxied AAAA 100:: records of the redirect-only hostnames of a zone, so its redirect rules see them. */
async function applyParked(api: CloudflareApi, zone: Zone, replaceDns: boolean): Promise<string[]> {
  const blocked: string[] = [];
  for (const hostname of readEdgeFile<RedirectHosts>("redirect-hosts.json").hostnames.filter((host) => zoneOf(host) === zone.name)) {
    const existing = await api.call<DnsRecord[]>({ method: "GET", path: `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}` });
    const change = dnsChange(existing, PARKED_RECORD.content, replaceDns, PARKED_RECORD.type);
    for (const record of change.conflicts) blocked.push(`${hostname}: existing ${record.type} ${record.content}`);
    for (const record of change.deletes) await api.write({ method: "DELETE", path: `/zones/${zone.id}/dns_records/${record.id}` }, { type: record.type, name: record.name, content: record.content });
    if (change.create) {
      await api.write({ method: "POST", path: `/zones/${zone.id}/dns_records`, body: { ...PARKED_RECORD, name: hostname, proxied: true, comment: "joutiya-redirect" } });
    }
  }
  return blocked;
}

async function applyZone(api: CloudflareApi, targets: Targets, replaceDns: boolean): Promise<void> {
  const blocked: string[] = [];
  for (const zone of recordedZones(targets)) {
    console.log(`-- ${zone.name}`);
    const { zoneId } = await checkZone(api, targets, zone);
    for (const setting of readEdgeFile<ZoneSettings>("zone-settings.json").settings) {
      await api.write({ method: "PATCH", path: `/zones/${zoneId}/settings/${setting.id}`, body: { value: setting.value } });
    }
    for (const file of RULESET_FILES) {
      const { phase, description, rules } = readEdgeFile<Ruleset>(file);
      // PUT replaces every rule of the phase: the file is the whole truth.
      await api.write({ method: "PUT", path: `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, body: { description, rules } });
    }
    blocked.push(...(await applyParked(api, zone, replaceDns)));
  }
  if (blocked.length > 0) throw new Error(`DNS records in the way (rerun with --replace-dns to replace them):\n  ${blocked.join("\n  ")}`);
}

/** Reads the live settings and rulesets of every recorded zone back and throws on any difference with the files. */
async function verifyZone(api: CloudflareApi, targets: Targets): Promise<void> {
  const expected = readEdgeFile<ZoneSettings>("zone-settings.json");
  const drift: string[] = [];
  for (const zone of recordedZones(targets)) {
    const { zoneId } = await checkZone(api, targets, zone);
    const live: Record<string, unknown> = {};
    for (const setting of expected.settings) {
      live[setting.id] = (await api.call<{ value: unknown }>({ method: "GET", path: `/zones/${zoneId}/settings/${setting.id}` })).value;
    }
    const found = settingsDrift(expected, live);
    for (const file of RULESET_FILES) {
      const ruleset = readEdgeFile<Ruleset>(file);
      const rules = await api
        .call<{ rules?: Rule[] }>({ method: "GET", path: `/zones/${zoneId}/rulesets/phases/${ruleset.phase}/entrypoint` })
        .then((result) => result.rules ?? [])
        .catch((error: unknown) => {
          if (/HTTP 404/.test((error as Error).message)) return null;
          throw error;
        });
      found.push(...rulesetDrift(ruleset, rules));
    }
    drift.push(...found.map((line) => `${zone.name}: ${line}`));
  }
  if (drift.length > 0) throw new Error(`the zones differ from infra/cloudflare:\n${drift.join("\n")}\nRe-apply with: scripts/cloudflare.ts zone --apply`);
  console.log("zone settings and rules match infra/cloudflare");
}

async function applyLoadtest(api: CloudflareApi, targets: Targets, on: boolean): Promise<void> {
  const host = siteHost(targets, "staging");
  const zone = hostZone(targets, host);
  if (zone === null) throw new Error(`the zone of ${host} is not recorded in infra/targets.json`);
  const { zoneId } = await checkZone(api, targets, zone);
  const secret = on ? (process.env.JOUTIYA_LOADTEST_BYPASS_SECRET?.trim() ?? "") : null;
  if (secret === "") throw new Error("JOUTIYA_LOADTEST_BYPASS_SECRET is not set");
  const { phase, description, rules } = loadtestRuleset(readEdgeFile<Ruleset>("waf-rules.json"), secret, host);
  const request: ApiRequest = { method: "PUT", path: `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, body: { description, rules } };
  await api.write(request, secret === null ? request.body : redact(request.body, secret));
  if (!api.apply) return;
  const live = await api.call<{ rules?: Rule[] }>({ method: "GET", path: `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint` });
  const refs = (live.rules ?? []).map((rule) => rule.ref);
  if (refs.includes(LOADTEST_RULE_REF) !== on) throw new Error(`${phase}: the load test rule is ${on ? "missing" : "still there"} (rules ${refs.join(", ")})`);
  console.log(on ? "load test rule on: turn it off after the run (loadtest --off --apply)" : "load test rule off: the WAF rules match waf-rules.json");
}

async function applyTunnel(api: CloudflareApi, targets: Targets, name: TunnelName, replaceDns: boolean): Promise<void> {
  const accountId = targets.shared.cloudflare.accountId;
  if (!accountId) throw new Error("shared.cloudflare.accountId must be recorded in infra/targets.json first");
  const tunnelId = name === "ssh" ? targets.shared.cloudflare.sshTunnelId : targets.environments[name].cloudflare.tunnelId;
  const field = name === "ssh" ? "shared.cloudflare.sshTunnelId" : `environments.${name}.cloudflare.tunnelId`;
  if (!tunnelId) throw new Error(`${field} must be recorded in infra/targets.json first`);
  const tunnel = await api.call<{ name: string; deleted_at: string | null }>({ method: "GET", path: `/accounts/${accountId}/cfd_tunnel/${tunnelId}` });
  if (tunnel.name !== `joutiya-${name}-tunnel` || tunnel.deleted_at) throw new Error(`tunnel ${tunnelId} is not joutiya-${name}-tunnel: nothing written`);

  const config = readEdgeFile<TunnelConfig>(`tunnel.${name}.json`);
  await api.write({ method: "PUT", path: `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, body: { config: config.config } });

  const target = `${tunnelId}.cfargotunnel.com`;
  const blocked: string[] = [];
  const checked = new Map<ZoneName, string>();
  for (const hostname of tunnelHostnames(config)) {
    const zone = hostZone(targets, hostname);
    if (zone === null) {
      console.log(`held  ${hostname}: its zone is not recorded in infra/targets.json yet, DNS record not created`);
      continue;
    }
    if (!checked.has(zone.name)) checked.set(zone.name, (await checkZone(api, targets, zone)).zoneId);
    const zoneId = checked.get(zone.name) as string;
    // A guarded hostname gets its DNS record only once its Access application exists: otherwise
    // the record would publish the service unguarded as soon as the zone is active.
    if (needsAccess(name, hostname) && !(await accessApp(api, accountId, hostname))) {
      console.log(`held  ${hostname}: no Access application yet, DNS record not created (run the access part first)`);
      continue;
    }
    const existing = await api.call<DnsRecord[]>({ method: "GET", path: `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}` });
    const change = dnsChange(existing, target, replaceDns);
    for (const record of change.conflicts) blocked.push(`${hostname}: existing ${record.type} ${record.content}`);
    for (const record of change.deletes) await api.write({ method: "DELETE", path: `/zones/${zoneId}/dns_records/${record.id}` }, { type: record.type, name: record.name, content: record.content });
    if (change.create) {
      await api.write({ method: "POST", path: `/zones/${zoneId}/dns_records`, body: { type: "CNAME", name: hostname, content: target, proxied: true, comment: `joutiya-${name}-tunnel` } });
    }
  }
  if (blocked.length > 0) throw new Error(`DNS records in the way (rerun with --replace-dns to replace them):\n  ${blocked.join("\n  ")}`);
}

/** The account's Google login method, set up in Zero Trust with the owner (docs/phase-1.md, step 5). */
export function googleIdp(providers: { id: string; type: string }[]): string {
  const google = providers.filter((provider) => provider.type === "google");
  const [only] = google;
  if (!only || google.length > 1) throw new Error(`expected one Google login method in Zero Trust, found ${google.length} (docs/phase-1.md, step 5)`);
  return only.id;
}

async function accessApp(api: CloudflareApi, accountId: string, domain: string): Promise<{ id: string; domain: string; aud: string } | undefined> {
  // The API documents exact matching of the domain filter, not whether a path takes part in it:
  // the partial filter on the hostname also returns its path applications, compared exactly here.
  const hostname = domain.split("/")[0] ?? domain;
  const found = await api.call<{ id: string; domain: string; aud: string }[]>({
    method: "GET",
    path: `/accounts/${accountId}/access/apps?domain=${encodeURIComponent(hostname)}`,
  });
  return found.find((item) => item.domain === domain);
}

async function applyAccess(api: CloudflareApi, targets: Targets): Promise<void> {
  const accountId = targets.shared.cloudflare.accountId;
  if (!accountId) throw new Error("shared.cloudflare.accountId must be recorded in infra/targets.json first");
  const template = readEdgeFile<{ apps: AccessApp[] }>("access-apps.json").apps;
  const providers = await api.call<{ id: string; type: string }[]>({ method: "GET", path: `/accounts/${accountId}/access/identity_providers` });
  const { value: apps, missing } = substitute(template, { ...process.env, ACCESS_GOOGLE_IDP_ID: googleIdp(providers) });
  if (missing.length > 0) throw new Error(`set ${missing.join(", ")} in the environment first`);
  for (const [index, app] of apps.entries()) {
    const current = await accessApp(api, accountId, app.domain);
    // PUT overwrites the whole application, policies included.
    const request: ApiRequest = current
      ? { method: "PUT", path: `/accounts/${accountId}/access/apps/${current.id}`, body: app }
      : { method: "POST", path: `/accounts/${accountId}/access/apps`, body: app };
    // The template is printed, not the substituted body: identifiers stay out of terminal logs.
    const result = (await api.write(request, template[index])) as { aud?: string } | undefined;
    const aud = result?.aud ?? current?.aud;
    if (aud) console.log(`  ${app.domain}: AUD ${aud}`);
  }
}

/** A CORS rule as pasted in the R2 dashboard's JSON tab. */
export interface R2CorsRule {
  AllowedOrigins: string[];
  AllowedMethods: string[];
  AllowedHeaders?: string[];
  ExposeHeaders?: string[];
  MaxAgeSeconds?: number;
}
export interface R2Settings {
  jurisdiction: string;
  /** Cloudflare's own rule on every bucket, kept: a lifecycle PUT by API would have to repeat it. */
  defaultMultipartAbort: { name: string; abortAfterDays: number };
  buckets: Record<string, { cors?: R2CorsRule[]; lifecycle?: { name: string; prefix: string; deleteAfterDays: number }[] }>;
}
type BucketRole = keyof EnvTargets["r2"];

/** The two zones that serve the site in turn: their origins are both admitted until joutiya.ma only redirects. */
const SITE_ZONES: readonly ZoneName[] = ["joutiya.ma", "aalan.ma"];

/**
 * The site origins of each environment (hosts.site and hosts.www), each with its twin in the other
 * site zone: a bucket never admits another environment's pages.
 */
export function siteOrigins(targets: Targets, env: AppEnv): string[] {
  if (env === "dev") return ["http://localhost:3000"];
  const { site, www } = targets.environments[env].hosts;
  return [site, www].flatMap((host) => {
    if (host === null) return [];
    const zone = zoneOf(host);
    const twins = zone !== null && SITE_ZONES.includes(zone) ? SITE_ZONES.map((other) => `${host.slice(0, -zone.length)}${other}`) : [host];
    return twins.map((name) => `https://${name}`);
  });
}
const CORS_METHODS: Record<BucketRole, string[]> = { quarantine: ["PUT"], media: ["GET", "HEAD"], private: [] };

/** r2-buckets.json against the registry: its buckets, each role's methods, each environment's origins. */
export function validateR2(settings: R2Settings, targets: Targets): string[] {
  const errors: string[] = [];
  const owners = new Map<string, { env: AppEnv; role: BucketRole }>();
  for (const [env, recorded] of Object.entries(targets.environments) as [AppEnv, EnvTargets][]) {
    for (const [role, bucket] of Object.entries(recorded.r2) as [BucketRole, string][]) owners.set(bucket, { env, role });
  }
  if (settings.jurisdiction !== "eu") errors.push("r2-buckets.json: the buckets were created in the EU jurisdiction");
  for (const [bucket, { cors = [], lifecycle = [] }] of Object.entries(settings.buckets)) {
    const owner = owners.get(bucket);
    if (!owner) {
      errors.push(`r2-buckets.json: ${bucket} is not a bucket of infra/targets.json`);
      continue;
    }
    for (const rule of cors) {
      for (const method of rule.AllowedMethods) if (!CORS_METHODS[owner.role].includes(method)) errors.push(`r2-buckets.json: ${bucket} must not allow ${method}`);
      for (const origin of rule.AllowedOrigins) if (!siteOrigins(targets, owner.env).includes(origin)) errors.push(`r2-buckets.json: ${bucket} must not admit ${origin}`);
    }
    for (const rule of lifecycle) {
      if (!Number.isInteger(rule.deleteAfterDays) || rule.deleteAfterDays < 1) errors.push(`r2-buckets.json: ${bucket}: ${rule.name} needs a whole number of days`);
      // Media holds published photos, private holds backups and account files: only quarantine empties.
      if (rule.prefix === "" && owner.role !== "quarantine") errors.push(`r2-buckets.json: ${bucket}: ${rule.name} would empty the bucket`);
    }
  }
  return errors;
}

/** Browsers accept any 2xx answer to a preflight; R2 sends 204. */
const okStatus = (status: number): boolean => status >= 200 && status <= 299;

/** What a preflight answer lacks to let `origin` send `method` under `rule`; [] when it is allowed. */
export function preflightErrors(rule: R2CorsRule, origin: string, method: string, status: number, headers: Headers): string[] {
  if (!okStatus(status)) return [`HTTP ${status}`];
  const list = (name: string) => (headers.get(name) ?? "").split(",").map((value) => value.trim().toLowerCase());
  const errors: string[] = [];
  if (headers.get("access-control-allow-origin") !== origin) errors.push(`allow-origin ${headers.get("access-control-allow-origin") ?? "missing"}`);
  if (!list("access-control-allow-methods").includes(method.toLowerCase())) errors.push(`allow-methods lacks ${method}`);
  for (const header of rule.AllowedHeaders ?? []) if (!list("access-control-allow-headers").includes(header.toLowerCase())) errors.push(`allow-headers lacks ${header}`);
  if (rule.MaxAgeSeconds !== undefined && headers.get("access-control-max-age") !== String(rule.MaxAgeSeconds)) errors.push(`max-age ${headers.get("access-control-max-age") ?? "missing"}`);
  return errors;
}

async function preflight(url: string, origin: string, method: string, headers: string[]): Promise<{ status: number; headers: Headers }> {
  const response = await fetch(url, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": method, ...(headers.length > 0 ? { "Access-Control-Request-Headers": headers.join(",").toLowerCase() } : {}) },
  });
  await response.body?.cancel();
  return { status: response.status, headers: response.headers };
}

/** Sends the CORS preflights of r2-buckets.json, plus one from a foreign origin per bucket, which must fail. */
async function checkR2(targets: Targets): Promise<void> {
  const settings = readEdgeFile<R2Settings>("r2-buckets.json");
  const errors = validateR2(settings, targets);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const endpoint = `https://${targets.shared.cloudflare.accountId}.${settings.jurisdiction}.r2.cloudflarestorage.com`;
  let failed = 0;
  for (const [bucket, { cors = [], lifecycle = [] }] of Object.entries(settings.buckets)) {
    const url = `${endpoint}/${bucket}/cors-check`;
    for (const rule of cors) {
      for (const origin of rule.AllowedOrigins) {
        for (const method of rule.AllowedMethods) {
          const answer = await preflight(url, origin, method, rule.AllowedHeaders ?? []);
          const problems = preflightErrors(rule, origin, method, answer.status, answer.headers);
          if (problems.length > 0) failed += 1;
          console.log(`${problems.length > 0 ? "FAIL" : "ok  "}  ${bucket}: ${method} from ${origin}${problems.length > 0 ? ` (${problems.join("; ")})` : ""}`);
        }
      }
    }
    const firstMethod = cors[0]?.AllowedMethods[0];
    if (firstMethod !== undefined) {
      const foreign = await preflight(url, "https://example.org", firstMethod, []);
      const admitted = okStatus(foreign.status) && foreign.headers.get("access-control-allow-origin") !== null;
      if (admitted) failed += 1;
      console.log(`${admitted ? "FAIL" : "ok  "}  ${bucket}: a foreign origin is ${admitted ? "admitted" : "refused"}`);
    }
    for (const rule of lifecycle) console.log(`      ${bucket}: lifecycle ${rule.name} (prefix "${rule.prefix}", ${rule.deleteAfterDays} d), read back by Nav`);
    console.log(`      ${bucket}: lifecycle ${settings.defaultMultipartAbort.name} (abort after ${settings.defaultMultipartAbort.abortAfterDays} d), read back by Nav`);
  }
  if (failed > 0) throw new Error(`${failed} CORS check(s) failed: apply r2-buckets.json in the dashboard (docs/phase-1.md, step 14)`);
}

async function main(): Promise<void> {
  requireEnvProxy();
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const replaceDns = args.includes("--replace-dns");
  const check = args.includes("--check");
  const parts = args.filter((arg) => !arg.startsWith("--"));
  const known = ["zone", "access", "r2", "loadtest", ...TUNNELS.map((name) => `tunnel:${name}`)];
  const unknown = parts.filter((part) => !known.includes(part));
  if (parts.length === 0 || unknown.length > 0) throw new Error(`usage: scripts/cloudflare.ts <${known.join("|")}>... [--apply] [--replace-dns] | zone --check`);
  if (check && (apply || parts.join() !== "zone")) throw new Error("--check reads the zone only: scripts/cloudflare.ts zone --check");
  const on = args.includes("--on");
  if (parts.includes("loadtest") && (parts.length !== 1 || on === args.includes("--off"))) throw new Error("usage: scripts/cloudflare.ts loadtest --on|--off [--apply]");

  const targets = readTargets();
  const targetErrors = validateTargets(targets);
  if (targetErrors.length > 0) throw new Error(targetErrors.join("\n"));
  const edgeErrors = validateEdge(readEdgeFile, targets);
  if (edgeErrors.length > 0) throw new Error(edgeErrors.join("\n"));

  const token = process.env.JOUTIYA_CLOUDFLARE_API_TOKEN?.trim() ?? "";
  if (!token && parts.some((part) => part !== "r2")) throw new Error("JOUTIYA_CLOUDFLARE_API_TOKEN is not set");
  const api = new CloudflareApi(token, apply);
  for (const part of parts) {
    console.log(`\n== ${part}`);
    if (part === "zone" && check) await verifyZone(api, targets);
    else if (part === "zone") {
      await applyZone(api, targets, replaceDns);
      if (apply) await verifyZone(api, targets);
    }
    else if (part === "access") await applyAccess(api, targets);
    else if (part === "loadtest") await applyLoadtest(api, targets, on);
    else if (part === "r2") await checkR2(targets);
    else await applyTunnel(api, targets, part.slice("tunnel:".length) as TunnelName, replaceDns);
  }
  if (check || parts.every((part) => part === "r2")) console.log(`\nChecks only: ${check ? "zone --check" : "the r2 part"} writes nothing.`);
  else console.log(apply ? "\nDone." : "\nDry run: nothing written. Add --apply to send these requests.");
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]cloudflare\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`cloudflare: ${(error as Error).message}`);
    process.exit(1);
  });
}
