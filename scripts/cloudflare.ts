// Applies the Cloudflare edge configuration of infra/cloudflare/ (§2, §6) to the account and zone
// recorded in infra/targets.json, and nowhere else: the zone must be joutiya.ma in that account,
// each tunnel must be joutiya-<name>-tunnel. Dry run by default (prints the requests); --apply sends.
//
//   node --env-file=<owner env file> scripts/cloudflare.ts <part>... [--apply] [--replace-dns]
//   parts: zone (settings and rules), tunnel:staging, tunnel:prod, tunnel:ssh, access
//
// Environment (never printed): JOUTIYA_CLOUDFLARE_API_TOKEN, a custom token limited to the Joutiya
// account and the joutiya.ma zone (a prefixed name: a shared shell may hold other projects' tokens); for access: ACCESS_OWNER_EMAIL, ACCESS_CI_TOKEN_ID, ACCESS_PROBE_TOKEN_ID.
// An existing A, AAAA or CNAME record on a tunnel hostname is only replaced with --replace-dns.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateTargets, type Targets } from "./assert-target.ts";

export const ZONE_NAME = "joutiya.ma";
const API = "https://api.cloudflare.com/client/v4";
const DIR = new URL("../infra/cloudflare/", import.meta.url);

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
  policies: { name: string; decision: string; include: unknown[] }[];
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

/** Structure and Free-plan limits of the committed files. Returns the errors found. */
export function validateEdge(read: <T>(name: string) => T = readEdgeFile): string[] {
  const errors: string[] = [];
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
  for (const name of TUNNELS) {
    const file = `tunnel.${name}.json`;
    const ingress = read<TunnelConfig>(file).config.ingress;
    const last = ingress.at(-1);
    if (!last || last.hostname !== undefined || !last.service.startsWith("http_status:")) errors.push(`${file}: the last ingress rule must be a catch-all http_status`);
    for (const { hostname, service } of ingress) {
      if (hostname === undefined) continue;
      if (hostname !== ZONE_NAME && !hostname.endsWith(`.${ZONE_NAME}`)) errors.push(`${file}: ${hostname} is outside ${ZONE_NAME}`);
      // Universal SSL covers the apex and first-level subdomains only.
      if (hostname.split(".").length > ZONE_NAME.split(".").length + 1) errors.push(`${file}: ${hostname} is not covered by Universal SSL`);
      if (service.startsWith("ssh://") !== (name === "ssh")) errors.push(`${file}: ${hostname}: SSH goes through tunnel.ssh.json only`);
      const needsAccess = name !== "prod" || hostname.startsWith("admin.");
      if (needsAccess && !guarded.has(hostname)) errors.push(`${file}: ${hostname} has no Access application`);
      if (!needsAccess && guarded.has(hostname)) errors.push(`${file}: ${hostname} is public but has an Access application`);
    }
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

export function tunnelHostnames(config: TunnelConfig): string[] {
  return config.config.ingress.flatMap((rule) => (rule.hostname ? [rule.hostname] : []));
}

export interface DnsChange {
  create: boolean;
  deletes: DnsRecord[];
  /** Records that block the CNAME and need --replace-dns. */
  conflicts: DnsRecord[];
}

/** What to do so that `hostname` is a proxied CNAME to `target`. MX, TXT and others are kept. */
export function dnsChange(existing: DnsRecord[], target: string, replace: boolean): DnsChange {
  const blocking = existing.filter((record) => ["A", "AAAA", "CNAME"].includes(record.type));
  const [only] = blocking;
  const done = blocking.length === 1 && only?.type === "CNAME" && only.content === target && only.proxied === true;
  if (done) return { create: false, deletes: [], conflicts: [] };
  if (blocking.length === 0) return { create: true, deletes: [], conflicts: [] };
  return replace ? { create: true, deletes: blocking, conflicts: [] } : { create: false, deletes: [], conflicts: blocking };
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

function recorded(targets: Targets): { accountId: string; zoneId: string } {
  const { accountId, zoneId } = targets.shared.cloudflare;
  if (!accountId || !zoneId) throw new Error("shared.cloudflare.accountId and zoneId must be recorded in infra/targets.json first");
  return { accountId, zoneId };
}

async function checkZone(api: CloudflareApi, targets: Targets): Promise<{ accountId: string; zoneId: string }> {
  const ids = recorded(targets);
  const zone = await api.call<{ name: string; account: { id: string } }>({ method: "GET", path: `/zones/${ids.zoneId}` });
  if (zone.name !== ZONE_NAME || zone.account.id !== ids.accountId) {
    throw new Error(`zone ${ids.zoneId} is not ${ZONE_NAME} in account ${ids.accountId}: nothing written`);
  }
  return ids;
}

async function applyZone(api: CloudflareApi, targets: Targets): Promise<void> {
  const { zoneId } = await checkZone(api, targets);
  for (const setting of readEdgeFile<ZoneSettings>("zone-settings.json").settings) {
    await api.write({ method: "PATCH", path: `/zones/${zoneId}/settings/${setting.id}`, body: { value: setting.value } });
  }
  for (const file of RULESET_FILES) {
    const { phase, description, rules } = readEdgeFile<Ruleset>(file);
    // PUT replaces every rule of the phase: the file is the whole truth.
    await api.write({ method: "PUT", path: `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, body: { description, rules } });
  }
}

async function applyTunnel(api: CloudflareApi, targets: Targets, name: TunnelName, replaceDns: boolean): Promise<void> {
  const { accountId, zoneId } = await checkZone(api, targets);
  const tunnelId = name === "ssh" ? targets.shared.cloudflare.sshTunnelId : targets.environments[name].cloudflare.tunnelId;
  const field = name === "ssh" ? "shared.cloudflare.sshTunnelId" : `environments.${name}.cloudflare.tunnelId`;
  if (!tunnelId) throw new Error(`${field} must be recorded in infra/targets.json first`);
  const tunnel = await api.call<{ name: string; deleted_at: string | null }>({ method: "GET", path: `/accounts/${accountId}/cfd_tunnel/${tunnelId}` });
  if (tunnel.name !== `joutiya-${name}-tunnel` || tunnel.deleted_at) throw new Error(`tunnel ${tunnelId} is not joutiya-${name}-tunnel: nothing written`);

  const config = readEdgeFile<TunnelConfig>(`tunnel.${name}.json`);
  await api.write({ method: "PUT", path: `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, body: { config: config.config } });

  const target = `${tunnelId}.cfargotunnel.com`;
  const blocked: string[] = [];
  for (const hostname of tunnelHostnames(config)) {
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

async function applyAccess(api: CloudflareApi, targets: Targets): Promise<void> {
  const { accountId } = await checkZone(api, targets);
  const template = readEdgeFile<{ apps: AccessApp[] }>("access-apps.json").apps;
  const { value: apps, missing } = substitute(template, process.env);
  if (missing.length > 0) throw new Error(`set ${missing.join(", ")} in the environment first`);
  for (const [index, app] of apps.entries()) {
    const found = await api.call<{ id: string; domain: string; aud: string }[]>({
      method: "GET",
      path: `/accounts/${accountId}/access/apps?domain=${encodeURIComponent(app.domain)}&exact=true`,
    });
    const current = found.find((item) => item.domain === app.domain);
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const replaceDns = args.includes("--replace-dns");
  const parts = args.filter((arg) => !arg.startsWith("--"));
  const known = ["zone", "access", ...TUNNELS.map((name) => `tunnel:${name}`)];
  const unknown = parts.filter((part) => !known.includes(part));
  if (parts.length === 0 || unknown.length > 0) throw new Error(`usage: scripts/cloudflare.ts <${known.join("|")}>... [--apply] [--replace-dns]`);

  const edgeErrors = validateEdge();
  if (edgeErrors.length > 0) throw new Error(edgeErrors.join("\n"));
  const raw: unknown = JSON.parse(readFileSync(new URL("../infra/targets.json", import.meta.url), "utf8"));
  const targetErrors = validateTargets(raw);
  if (targetErrors.length > 0) throw new Error(targetErrors.join("\n"));
  const targets = raw as Targets;

  const token = process.env.JOUTIYA_CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error("JOUTIYA_CLOUDFLARE_API_TOKEN is not set");
  const api = new CloudflareApi(token, apply);
  for (const part of parts) {
    console.log(`\n== ${part}`);
    if (part === "zone") await applyZone(api, targets);
    else if (part === "access") await applyAccess(api, targets);
    else await applyTunnel(api, targets, part.slice("tunnel:".length) as TunnelName, replaceDns);
  }
  console.log(apply ? "\nDone." : "\nDry run: nothing written. Add --apply to send these requests.");
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]cloudflare\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`cloudflare: ${(error as Error).message}`);
    process.exit(1);
  });
}
