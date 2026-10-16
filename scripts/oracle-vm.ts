// Creates the Joutiya VM and its network on Oracle Cloud (§2), by API, in the `joutiya` compartment
// recorded in infra/targets.json and nowhere else. Run from Claude's cloud environment (or any
// shell holding the JOUTIYA_OCI_* and JOUTIYA_CLOUDFLARE_API_TOKEN variables). Dry run by default.
//
//   node scripts/oracle-vm.ts create [--apply] [--retry-minutes=<n>]
//       joutiya-vcn (no ingress rule anywhere), joutiya-igw, joutiya-public, then joutiya-vm
//       (VM.Standard.A1.Flex, 2 OCPU, 12 GB, Ubuntu 24.04 aarch64, 100 GB boot volume) whose
//       cloud-init is infra/vm/bootstrap.sh filled in memory with the three tunnel tokens (read from
//       the Cloudflare API) and a tarball of infra/vm and docker/. Out of host capacity: retried
//       every minute for <n> minutes (default 0). Never a paid shape.
//   node scripts/oracle-vm.ts status
//       instance state, SSH tunnel connections, bootstrap progress from the serial console.
//   node scripts/oracle-vm.ts reboot [--apply]
//       soft reboot (ACPI) of joutiya-vm: a bootstrap that failed runs again (it stays as a per-boot
//       script until it succeeds).
//   node scripts/oracle-vm.ts agent
//       recent Run Command commands of the compartment, and the state of the Oracle Cloud Agent
//       plugins on joutiya-vm (Run Command among them).
//   node scripts/oracle-vm.ts run <script> [--apply]
//       runs a local bash script as root on joutiya-vm through OCI Run Command (at most ~3.7 KB;
//       the last 1 KB of output comes back). Oracle keeps the text 7 days: no secret that must not
//       outlive the command.
//   node scripts/oracle-vm.ts sync [--apply] [--deploy-staging-key=<file.pub>]
//       installs infra/vm and docker/ on joutiya-vm (infra/vm/install.sh) through Run Command, and
//       the CI's public key for deploy-staging when given.
//   node scripts/oracle-vm.ts deploy-status
//       releases and image IDs running in staging and production (read only).
//   node scripts/oracle-vm.ts promote [--apply]
//       the release running in staging, if it is a commit of origin/main, goes to production
//       (pinned by image ID), then the Cloudflare cache of the zone is purged.
//   node scripts/oracle-vm.ts rollback [--apply]
//       production back to its previous release, then the cache is purged.
//
// Environment (never printed): JOUTIYA_OCI_TENANCY, _USER, _FINGERPRINT, _REGION, _COMPARTMENT,
// _KEY_B64 (base64 of the PEM key of joutiya-claude), JOUTIYA_CLOUDFLARE_API_TOKEN.

import { createHash, createSign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { tunnelTokenErrors, validateTargets, type Targets } from "./assert-target.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

export const NAMES = { vcn: "joutiya-vcn", gateway: "joutiya-igw", securityList: "joutiya-vcn-security-list", subnet: "joutiya-public", instance: "joutiya-vm" } as const;
export const VCN_CIDR = "10.0.0.0/16";
export const SUBNET_CIDR = "10.0.0.0/24";
/** Always Free: Ampere A1, at most 4 OCPU and 24 GB per tenancy; the joutiya-free-tier quota allows 2 and 12. */
export const SHAPE = { shape: "VM.Standard.A1.Flex", ocpus: 2, memoryInGBs: 12 } as const;
export const BOOT_VOLUME_GB = 100;
export const IMAGE = { operatingSystem: "Canonical Ubuntu", operatingSystemVersion: "24.04" } as const;
/** OCI limit on the metadata of an instance (user_data included, base64). */
export const MAX_METADATA_BYTES = 32_000;
/** Files of this repository installed on the VM, at first boot and by `sync` (the bootstrap itself and the OCI-side files stay here). */
export const VM_FILES = ["infra/vm", "docker/compose.yml", "docker/compose.prod.yml", "docker/compose.staging.yml", "docker/valkey"];
const VM_FILES_EXCLUDED = ["infra/vm/bootstrap.sh", "infra/vm/oci-security-list.json"];

// ---------------------------------------------------------------------------------------------
// Request signing (OCI HTTP signatures, as the official SDKs do).

export interface OciCredentials {
  tenancy: string;
  user: string;
  fingerprint: string;
  region: string;
  privateKey: string;
}

/** The headers to sign and the string to sign for one request. */
export function signingString(method: string, url: URL, headers: Record<string, string>): { names: string[]; text: string } {
  const names = ["date", "(request-target)", "host"];
  if (["POST", "PUT", "PATCH"].includes(method)) names.push("content-length", "content-type", "x-content-sha256");
  const value = (name: string): string => (name === "(request-target)" ? `${method.toLowerCase()} ${url.pathname}${url.search}` : (headers[name] ?? ""));
  return { names, text: names.map((name) => `${name}: ${value(name)}`).join("\n") };
}

export function signedHeaders(credentials: OciCredentials, method: string, url: URL, body: string | undefined, date = new Date()): Record<string, string> {
  const headers: Record<string, string> = { date: date.toUTCString(), host: url.host };
  if (["POST", "PUT", "PATCH"].includes(method)) {
    const payload = body ?? "";
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
    headers["x-content-sha256"] = createHash("sha256").update(payload).digest("base64");
  }
  const { names, text } = signingString(method, url, headers);
  const signature = createSign("RSA-SHA256").update(text).sign(credentials.privateKey, "base64");
  const keyId = `${credentials.tenancy}/${credentials.user}/${credentials.fingerprint}`;
  headers.authorization = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${names.join(" ")}",signature="${signature}"`;
  return headers;
}

export class OciError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Out of host capacity (or throttled): worth retrying later, nothing was created. */
export function isCapacityError(error: unknown): boolean {
  if (!(error instanceof OciError)) return false;
  return error.status === 429 || (error.status === 500 && /out of (host )?capacity/i.test(error.message));
}

class Oci {
  private readonly credentials: OciCredentials;
  readonly apply: boolean;
  constructor(credentials: OciCredentials, apply: boolean) {
    this.credentials = credentials;
    this.apply = apply;
  }

  host(service: "iaas" | "identity"): string {
    return `https://${service}.${this.credentials.region}.oraclecloud.com`;
  }

  /** The response body as text (the console history data endpoint answers text/plain). */
  async text(method: "GET" | "POST" | "PUT" | "DELETE", service: "iaas" | "identity", path: string, body?: unknown): Promise<string> {
    const url = new URL(`${this.host(service)}${path}`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = await fetch(url, { method, headers: signedHeaders(this.credentials, method, url, payload), body: payload });
    const raw = await response.text();
    if (!response.ok) {
      let code = "";
      let message = raw.slice(0, 300);
      try {
        const parsed = JSON.parse(raw) as { code?: string; message?: string };
        code = parsed.code ?? "";
        message = parsed.message ?? message;
      } catch {
        // not JSON: keep the start of the body
      }
      throw new OciError(response.status, code, `${method} ${url.pathname}: HTTP ${response.status} ${code} ${message}`);
    }
    return raw;
  }

  async call<T>(method: "GET" | "POST" | "PUT" | "DELETE", service: "iaas" | "identity", path: string, body?: unknown): Promise<T> {
    const raw = await this.text(method, service, path, body);
    return (raw === "" ? undefined : JSON.parse(raw)) as T;
  }

  /** Reads always run; writes run with --apply, otherwise they are printed. */
  async write<T>(method: "POST" | "PUT", path: string, body: unknown, shown: unknown = body): Promise<T | undefined> {
    console.log(`${this.apply ? "apply" : "plan "} ${method} ${path}\n${JSON.stringify(shown, null, 2)}`);
    return this.apply ? this.call<T>(method, "iaas", path, body) : undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Cloud-init user data.

export interface UserDataInput {
  template: string;
  sshTunnelToken: string;
  stagingTunnelToken: string;
  prodTunnelToken: string;
  /** base64 of a gzip tarball of VM_FILES. */
  vmFiles: string;
}

const PLACEHOLDERS: Record<keyof Omit<UserDataInput, "template">, string> = {
  sshTunnelToken: "__JOUTIYA_SSH_TUNNEL_TOKEN__",
  stagingTunnelToken: "__JOUTIYA_STAGING_TUNNEL_TOKEN__",
  prodTunnelToken: "__JOUTIYA_PROD_TUNNEL_TOKEN__",
  vmFiles: "__JOUTIYA_VM_FILES__",
};

/** bootstrap.sh with its placeholders filled, gzipped (cloud-init decompresses it) and base64-encoded for the instance metadata. */
export function buildUserData(input: UserDataInput): string {
  let script = input.template;
  for (const [key, placeholder] of Object.entries(PLACEHOLDERS) as [keyof typeof PLACEHOLDERS, string][]) {
    const value = input[key];
    // Placed between single quotes in bash: base64 characters only, so nothing can escape them.
    if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) throw new Error(`${key} is not a base64 value`);
    const occurrences = script.split(`'${placeholder}'`).length - 1;
    if (occurrences !== 1) throw new Error(`bootstrap.sh must contain '${placeholder}' once (found ${occurrences})`);
    script = script.replace(`'${placeholder}'`, `'${value}'`);
  }
  if (/__JOUTIYA_[A-Z_]+__/.test(script)) throw new Error("bootstrap.sh has a placeholder this script does not fill");
  const userData = gzipSync(Buffer.from(script, "utf8"), { level: 9 }).toString("base64");
  if (userData.length > MAX_METADATA_BYTES) throw new Error(`user data is ${userData.length} bytes, OCI allows ${MAX_METADATA_BYTES}`);
  return userData;
}

/** The CI's public key for deploy-staging: one ed25519 key, no option (install.sh adds "restrict"). */
export function deployStagingKey(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || !/^ssh-ed25519 [A-Za-z0-9+/]+=* ?[\w@.-]*$/.test(lines[0] ?? "")) throw new Error("expected one ssh-ed25519 public key");
  return `${lines[0]}\n`;
}

/** base64 of a gzip tarball of VM_FILES, plus keys/deploy-staging.pub when the CI key changes. */
function vmFilesTarball(stagingKey?: string): string {
  const excluded = VM_FILES_EXCLUDED.map((file) => `--exclude=${file}`);
  const keys = stagingKey === undefined ? undefined : mkdtempSync(join(tmpdir(), "joutiya-keys-"));
  try {
    if (keys) {
      mkdirSync(join(keys, "keys"));
      writeFileSync(join(keys, "keys", "deploy-staging.pub"), deployStagingKey(stagingKey ?? ""));
    }
    const extra = keys ? ["-C", keys, "keys"] : [];
    const tar = spawnSync("tar", ["-czf", "-", "--owner=0", "--group=0", ...excluded, "-C", root, ...VM_FILES, ...extra], { maxBuffer: 16 * 1024 * 1024 });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
    return tar.stdout.toString("base64");
  } finally {
    if (keys) rmSync(keys, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Cloudflare: tunnel tokens, read in memory only.

const CF_API = "https://api.cloudflare.com/client/v4";

async function cloudflare<T>(path: string, post?: unknown): Promise<T> {
  const token = process.env.JOUTIYA_CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error("JOUTIYA_CLOUDFLARE_API_TOKEN is not set");
  const init = post === undefined ? {} : { method: "POST", body: JSON.stringify(post), headers: { "Content-Type": "application/json" } };
  const response = await fetch(`${CF_API}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  const payload = (await response.json().catch(() => null)) as { success?: boolean; errors?: { code: number; message: string }[]; result?: T } | null;
  if (!response.ok || !payload?.success) {
    throw new Error(`Cloudflare ${post === undefined ? "GET" : "POST"} ${path.replace(/\/token$/, "/<token>")}: HTTP ${response.status} (${payload?.errors?.map((error) => error.message).join("; ") ?? "no JSON body"})`);
  }
  return payload.result as T;
}

type TunnelName = "ssh" | "staging" | "prod";

function tunnelId(targets: Targets, name: TunnelName): { id: string; field: string } {
  const field = name === "ssh" ? "shared.cloudflare.sshTunnelId" : `environments.${name}.cloudflare.tunnelId`;
  const id = name === "ssh" ? targets.shared.cloudflare.sshTunnelId : targets.environments[name].cloudflare.tunnelId;
  if (!id) throw new Error(`${field} must be recorded in infra/targets.json first`);
  return { id, field };
}

async function tunnelToken(targets: Targets, name: TunnelName): Promise<string> {
  const account = targets.shared.cloudflare.accountId;
  if (!account) throw new Error("shared.cloudflare.accountId must be recorded in infra/targets.json first");
  const { id, field } = tunnelId(targets, name);
  const tunnel = await cloudflare<{ name: string; deleted_at: string | null }>(`/accounts/${account}/cfd_tunnel/${id}`);
  if (tunnel.name !== `joutiya-${name}-tunnel` || tunnel.deleted_at) throw new Error(`tunnel ${id} is not joutiya-${name}-tunnel`);
  const token = await cloudflare<string>(`/accounts/${account}/cfd_tunnel/${id}/token`);
  const errors = tunnelTokenErrors(`token of joutiya-${name}-tunnel`, token, targets, field, id);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return token;
}

// ---------------------------------------------------------------------------------------------
// Network and instance.

interface Resource {
  id: string;
  displayName: string;
  lifecycleState: string;
}
interface Vcn extends Resource {
  defaultRouteTableId: string;
  defaultSecurityListId: string;
}
interface Instance extends Resource {
  availabilityDomain: string;
  timeCreated: string;
}
interface Image extends Resource {
  operatingSystem: string;
  operatingSystemVersion: string;
}

export interface SecurityListFile {
  displayName: string;
  ingressSecurityRules: unknown[];
  egressSecurityRules: unknown[];
}

/** The committed security list must keep the VM closed: no ingress rule (§6). */
export function securityList(): SecurityListFile {
  const list = JSON.parse(readFileSync(new URL("../infra/vm/oci-security-list.json", import.meta.url), "utf8")) as SecurityListFile;
  if (list.ingressSecurityRules.length !== 0) throw new Error("infra/vm/oci-security-list.json must not have any ingress rule");
  if (list.displayName !== NAMES.securityList) throw new Error(`infra/vm/oci-security-list.json must be named ${NAMES.securityList}`);
  return list;
}

/** The newest platform image of Ubuntu 24.04 for A1 (not Minimal, not a GPU build). */
export function pickImage(images: Image[]): Image {
  const candidates = images.filter(
    (image) =>
      image.lifecycleState === "AVAILABLE" &&
      image.operatingSystem === IMAGE.operatingSystem &&
      image.operatingSystemVersion === IMAGE.operatingSystemVersion &&
      /^Canonical-Ubuntu-24\.04-aarch64-\d{4}\.\d{2}\.\d{2}-\d+$/.test(image.displayName),
  );
  const [newest] = candidates.sort((a, b) => b.displayName.localeCompare(a.displayName));
  if (!newest) throw new Error("no Canonical Ubuntu 24.04 aarch64 platform image found");
  return newest;
}

const alive = (resource: Resource): boolean => !["TERMINATED", "TERMINATING", "DELETED"].includes(resource.lifecycleState);
const query = (params: Record<string, string>): string => `?${new URLSearchParams(params).toString()}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function findOne<T extends Resource>(oci: Oci, path: string, params: Record<string, string>, name: string): Promise<T | undefined> {
  const found = (await oci.call<T[]>("GET", "iaas", `${path}${query(params)}`)).filter((item) => item.displayName === name && alive(item));
  if (found.length > 1) throw new Error(`${found.length} live resources named ${name}: fix this by hand first`);
  return found[0];
}

async function waitFor<T extends Resource>(oci: Oci, path: string, state: string, minutes = 10): Promise<T> {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const resource = await oci.call<T>("GET", "iaas", path);
    if (resource.lifecycleState === state) return resource;
    if (!alive(resource) || Date.now() > deadline) throw new Error(`${resource.displayName}: ${resource.lifecycleState} instead of ${state}`);
    await sleep(5_000);
  }
}

/** Finds the live resource named `name`, or creates it (in a dry run: prints it, returns a placeholder). */
async function ensure<T extends Resource>(oci: Oci, kind: string, path: string, params: Record<string, string>, name: string, body: Record<string, unknown>): Promise<T> {
  const found = await findOne<T>(oci, path, params, name);
  if (found) {
    console.log(`exists   ${kind} ${name}`);
    return found;
  }
  const created = await oci.write<T>("POST", path, body);
  if (!created) return { id: `<new ${kind}>`, displayName: name, lifecycleState: "PLANNED" } as T;
  return waitFor<T>(oci, `${path}/${created.id}`, "AVAILABLE");
}

async function ensureNetwork(oci: Oci, compartmentId: string): Promise<string> {
  const vcn = await ensure<Vcn>(oci, "vcn", "/20160918/vcns", { compartmentId }, NAMES.vcn, { compartmentId, displayName: NAMES.vcn, cidrBlocks: [VCN_CIDR], dnsLabel: "joutiya" });
  const inVcn = { compartmentId, vcnId: vcn.id };
  const gateway = await ensure<Resource>(oci, "internet gateway", "/20160918/internetGateways", inVcn, NAMES.gateway, { ...inVcn, displayName: NAMES.gateway, isEnabled: true });
  const defaultRouteTable = vcn.defaultRouteTableId ?? "<default route table>";
  // Outbound only: the default route goes to the internet gateway, the security lists admit nothing.
  await oci.write("PUT", `/20160918/routeTables/${defaultRouteTable}`, {
    routeRules: [{ destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: gateway.id, description: "Outbound internet" }],
  });
  const rules = securityList();
  const closed = { ingressSecurityRules: [], egressSecurityRules: rules.egressSecurityRules };
  // The VCN's default list comes with SSH and ICMP ingress: emptied too, though no subnet uses it.
  await oci.write("PUT", `/20160918/securityLists/${vcn.defaultSecurityListId ?? "<default security list>"}`, closed);
  const list = await ensure<Resource>(oci, "security list", "/20160918/securityLists", inVcn, NAMES.securityList, { ...inVcn, ...rules });
  if (list.lifecycleState !== "PLANNED") await oci.write("PUT", `/20160918/securityLists/${list.id}`, closed);
  const subnet = await ensure<Resource>(oci, "subnet", "/20160918/subnets", inVcn, NAMES.subnet, {
    ...inVcn,
    displayName: NAMES.subnet,
    cidrBlock: SUBNET_CIDR,
    dnsLabel: "public",
    routeTableId: defaultRouteTable,
    securityListIds: [list.id],
    // A public IP lets the VM reach the internet through the gateway; nothing comes in.
    prohibitPublicIpOnVnic: false,
  });
  return subnet.id;
}

export function launchDetails(input: { availabilityDomain: string; compartmentId: string; subnetId: string; imageId: string; userData: string }): Record<string, unknown> {
  return {
    availabilityDomain: input.availabilityDomain,
    compartmentId: input.compartmentId,
    displayName: NAMES.instance,
    shape: SHAPE.shape,
    shapeConfig: { ocpus: SHAPE.ocpus, memoryInGBs: SHAPE.memoryInGBs },
    sourceDetails: { sourceType: "image", imageId: input.imageId, bootVolumeSizeInGBs: BOOT_VOLUME_GB },
    createVnicDetails: { subnetId: input.subnetId, assignPublicIp: true, displayName: NAMES.instance, hostnameLabel: NAMES.instance },
    // No SSH key: administration goes through OCI Run Command; ssh.joutiya.ma serves the CI only.
    metadata: { user_data: input.userData },
    agentConfig: {
      isMonitoringDisabled: false,
      isManagementDisabled: false,
      pluginsConfig: [{ name: "Compute Instance Run Command", desiredState: "ENABLED" }],
    },
    // Metadata service v2 only (header-authenticated); v1 endpoints are disabled.
    instanceOptions: { areLegacyImdsEndpointsDisabled: true },
    freeformTags: { project: "joutiya" },
  };
}

async function create(oci: Oci, targets: Targets, compartmentId: string, retryMinutes: number): Promise<void> {
  const existing = await findOne<Instance>(oci, "/20160918/instances", { compartmentId }, NAMES.instance);
  if (existing) {
    console.log(`instance ${NAMES.instance} already exists (${existing.lifecycleState}): nothing to create`);
    return;
  }
  const subnetId = await ensureNetwork(oci, compartmentId);
  const tenancy = targets.shared.oracle.tenancyId as string;
  const [ad] = await oci.call<{ name: string }[]>("GET", "identity", `/20160918/availabilityDomains${query({ compartmentId: tenancy })}`);
  if (!ad) throw new Error("no availability domain");
  const image = pickImage(
    await oci.call<Image[]>("GET", "iaas", `/20160918/images${query({ compartmentId, ...IMAGE, shape: SHAPE.shape, sortBy: "TIMECREATED", sortOrder: "DESC" })}`),
  );
  console.log(`image    ${image.displayName}`);

  const userData = buildUserData({
    template: readFileSync(new URL("../infra/vm/bootstrap.sh", import.meta.url), "utf8"),
    sshTunnelToken: await tunnelToken(targets, "ssh"),
    stagingTunnelToken: await tunnelToken(targets, "staging"),
    prodTunnelToken: await tunnelToken(targets, "prod"),
    vmFiles: vmFilesTarball(),
  });
  const details = launchDetails({ availabilityDomain: ad.name, compartmentId, subnetId, imageId: image.id, userData });
  const shown = { ...details, metadata: { user_data: `<bootstrap.sh with tokens, ${userData.length} bytes>` } };
  if (!oci.apply) {
    await oci.write("POST", "/20160918/instances", details, shown);
    return;
  }
  const deadline = Date.now() + retryMinutes * 60_000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const instance = await oci.write<Instance>("POST", "/20160918/instances", details, attempt === 1 ? shown : { attempt });
      if (!instance) return;
      const running = await waitFor<Instance>(oci, `/20160918/instances/${instance.id}`, "RUNNING", 15);
      console.log(`instance ${NAMES.instance} ${running.lifecycleState} (${running.id})`);
      return;
    } catch (error) {
      if (!isCapacityError(error) || Date.now() > deadline) throw error;
      console.log(`no A1 capacity (attempt ${attempt}): retrying in 60 s`);
      await sleep(60_000);
    }
  }
}

/** Bootstrap lines (joutiya-bootstrap: ...) and cloud-init's verdict, from the serial console. */
export function bootstrapLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => /joutiya-bootstrap: |Cloud-init v\. .* finished/.test(line)).map((line) => line.replace(/^.*?(joutiya-bootstrap: |Cloud-init)/, "$1"));
}

async function status(oci: Oci, targets: Targets, compartmentId: string): Promise<void> {
  const instance = await findOne<Instance>(oci, "/20160918/instances", { compartmentId }, NAMES.instance);
  if (!instance) {
    console.log(`instance ${NAMES.instance}: none`);
    return;
  }
  console.log(`instance ${NAMES.instance} ${instance.lifecycleState} since ${instance.timeCreated}`);
  const account = targets.shared.cloudflare.accountId;
  const { id } = tunnelId(targets, "ssh");
  const tunnel = await cloudflare<{ status: string; connections: unknown[] }>(`/accounts/${account}/cfd_tunnel/${id}`);
  console.log(`ssh tunnel ${tunnel.status}, ${tunnel.connections.length} connection(s)`);
  if (instance.lifecycleState !== "RUNNING") return;
  // Console history: captured, read, then deleted (it would otherwise stay in the compartment).
  const history = await oci.call<Resource>("POST", "iaas", "/20160918/instanceConsoleHistories", { instanceId: instance.id, displayName: "joutiya-vm-console" });
  try {
    await waitFor<Resource>(oci, `/20160918/instanceConsoleHistories/${history.id}`, "SUCCEEDED", 3);
    const data = await oci.text("GET", "iaas", `/20160918/instanceConsoleHistories/${history.id}/data${query({ offset: "0", length: String(1024 * 1024) })}`);
    for (const line of bootstrapLines(data)) console.log(`console  ${line}`);
  } finally {
    await oci.call("DELETE", "iaas", `/20160918/instanceConsoleHistories/${history.id}`);
  }
}

// ---------------------------------------------------------------------------------------------
// OCI Run Command (Compute Instance Agent API): Claude's admin channel to the VM (docs/phase-1.md,
// step 4). The agent runs each command as ocarun, which infra/vm/sudoers.oracle-run-command makes
// root. Who may send commands is decided by OCI IAM (policy joutiya-run-command-policy).

/** Inline script limit of Run Command (text source); the output that comes back is its last 1 KB. */
export const RUN_COMMAND_MAX_BYTES = 4_000;
const ROOT_SCRIPT_END = "JOUTIYA_ROOT_SCRIPT";
/** Root-only directory where `sync` assembles the bundle on the VM. */
export const SYNC_DIR = "/var/lib/joutiya/sync";

/**
 * A root script as Run Command text: ocarun writes it to a temporary file, root runs it through
 * sudo in strict mode, stdin closed (a command reading stdin cannot eat the rest of the script).
 */
export function rootCommand(script: string): string {
  if (script.split("\n").includes(ROOT_SCRIPT_END)) throw new Error(`a line of the script is ${ROOT_SCRIPT_END}`);
  const text = [
    "#!/bin/bash",
    "set -euo pipefail",
    'script="$(mktemp)"',
    `trap 'rm -f "$script"' EXIT`,
    `cat > "$script" << '${ROOT_SCRIPT_END}'`,
    script.replace(/\n+$/, ""),
    ROOT_SCRIPT_END,
    'sudo -n /bin/bash -euo pipefail "$script" < /dev/null 2>&1',
    "",
  ].join("\n");
  const bytes = Buffer.byteLength(text);
  if (bytes > RUN_COMMAND_MAX_BYTES) throw new Error(`command is ${bytes} bytes, Run Command allows ${RUN_COMMAND_MAX_BYTES}`);
  return text;
}

/**
 * `sync` as Run Command texts: the bundle (base64 of the VM files tarball) appended in chunks to a
 * root-only file, then checked against its SHA-256 and installed by infra/vm/install.sh.
 */
export function syncCommands(bundle: string, dir = SYNC_DIR, chunkSize = 3_500): string[] {
  if (!/^[A-Za-z0-9+/=]+$/.test(bundle)) throw new Error("the bundle is not base64");
  const file = `${dir}/bundle.b64`;
  const chunks = bundle.match(new RegExp(`.{1,${chunkSize}}`, "g")) ?? [];
  const append = chunks.map((chunk, index) =>
    rootCommand(
      [
        ...(index === 0 ? [`install -d -m 0700 ${dir}`, `: > ${file}`] : []),
        `printf '%s' '${chunk}' >> ${file}`,
        `echo "chunk ${index + 1}/${chunks.length}: $(wc -c < ${file}) bytes"`,
      ].join("\n"),
    ),
  );
  const sha256 = createHash("sha256").update(bundle).digest("hex");
  const install = rootCommand(
    [
      `trap 'rm -rf "\${files:-}" ${dir}' EXIT`,
      `echo "${sha256}  ${file}" | sha256sum -c --quiet`,
      'files="$(mktemp -d)"',
      `base64 -d ${file} | tar -xzf - -C "$files"`,
      'bash "$files/infra/vm/install.sh" "$files"',
    ].join("\n"),
  );
  return [...append, install];
}

interface CommandExecution {
  lifecycleState: string;
  deliveryState?: string;
  content?: { exitCode?: number; message?: string; text?: string };
}
const COMMAND_DONE = ["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELED"];

/**
 * Sends one command and waits for it; throws unless it exits 0. Returns its last 1 KB of output.
 * A read-only command (it changes nothing on the VM) also runs in a dry run.
 */
async function runCommand(oci: Oci, compartmentId: string, instanceId: string, displayName: string, text: string, timeoutSeconds = 900, readOnly = false): Promise<string> {
  const shown = { displayName, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
  const body = {
    compartmentId,
    displayName,
    executionTimeOutInSeconds: timeoutSeconds,
    target: { instanceId },
    content: { source: { sourceType: "TEXT", text }, output: { outputType: "TEXT" } },
  };
  const command = readOnly
    ? await oci.call<{ id: string }>("POST", "iaas", "/20180530/instanceAgentCommands", body)
    : await oci.write<{ id: string }>("POST", "/20180530/instanceAgentCommands", body, shown);
  if (!command) return "";
  // Delivery waits for the agent's next poll; past the timeout plus a delivery margin, it is cancelled.
  const deadline = Date.now() + (timeoutSeconds + 300) * 1000;
  for (;;) {
    const execution = await oci
      .call<CommandExecution>("GET", "iaas", `/20180530/instanceAgentCommands/${command.id}/status${query({ instanceId })}`)
      .catch((error: unknown) => {
        if (error instanceof OciError && error.status === 404) return undefined; // not delivered yet
        throw error;
      });
    if (execution && COMMAND_DONE.includes(execution.lifecycleState)) {
      const output = execution.content?.text ?? "";
      const exitCode = execution.content?.exitCode;
      if (execution.lifecycleState !== "SUCCEEDED" || exitCode !== 0) {
        const message = execution.content?.message ? ` (${execution.content.message})` : "";
        throw new Error(`${displayName}: ${execution.lifecycleState}, exit ${exitCode ?? "?"}${message}\n${output}`);
      }
      return output;
    }
    if (Date.now() > deadline) {
      await oci.call("DELETE", "iaas", `/20180530/instanceAgentCommands/${command.id}`).catch(() => undefined);
      throw new Error(`${displayName}: not run in time (delivery ${execution?.deliveryState ?? "unknown"}), cancelled`);
    }
    await sleep(5_000);
  }
}

async function runningInstance(oci: Oci, compartmentId: string): Promise<Instance> {
  const instance = await findOne<Instance>(oci, "/20160918/instances", { compartmentId }, NAMES.instance);
  if (!instance) throw new Error(`instance ${NAMES.instance}: none`);
  if (instance.lifecycleState !== "RUNNING") throw new Error(`instance ${NAMES.instance} is ${instance.lifecycleState}, not RUNNING`);
  return instance;
}

async function agent(oci: Oci, compartmentId: string): Promise<void> {
  // The compartment's recent commands: reading them also proves the Run Command policy.
  const commands = await oci.call<{ displayName?: string; timeCreated: string; isCanceled?: boolean }[]>(
    "GET",
    "iaas",
    `/20180530/instanceAgentCommands${query({ compartmentId, sortBy: "TIMECREATED", sortOrder: "DESC", limit: "5" })}`,
  );
  console.log(`commands ${commands.length} recent`);
  for (const command of commands) console.log(`command  ${command.timeCreated} ${command.displayName ?? ""}${command.isCanceled ? " (cancelled)" : ""}`);
  const instance = await findOne<Instance>(oci, "/20160918/instances", { compartmentId }, NAMES.instance);
  if (instance?.lifecycleState !== "RUNNING") {
    console.log(`instance ${NAMES.instance}: ${instance?.lifecycleState ?? "none"}`);
    return;
  }
  const plugins = await oci.call<{ name: string; status: string; message?: string }[]>("GET", "iaas", `/20180530/instanceagents/${instance.id}/plugins${query({ compartmentId })}`);
  for (const plugin of plugins) console.log(`plugin   ${plugin.name}: ${plugin.status}${plugin.message ? ` (${plugin.message})` : ""}`);
}

async function run(oci: Oci, compartmentId: string, file: string): Promise<void> {
  const instance = await runningInstance(oci, compartmentId);
  const output = await runCommand(oci, compartmentId, instance.id, `joutiya-run ${basename(file)}`, rootCommand(readFileSync(file, "utf8")));
  if (output) console.log(output.trimEnd());
}

async function sync(oci: Oci, compartmentId: string, stagingKeyFile?: string): Promise<void> {
  const instance = await runningInstance(oci, compartmentId);
  const commands = syncCommands(vmFilesTarball(stagingKeyFile === undefined ? undefined : readFileSync(stagingKeyFile, "utf8")));
  for (const [index, text] of commands.entries()) {
    const output = await runCommand(oci, compartmentId, instance.id, `joutiya-sync ${index + 1}/${commands.length}`, text);
    if (output) console.log(output.trimEnd());
  }
}

// ---------------------------------------------------------------------------------------------
// Production releases (§2), run by root through Run Command with the forced command of the deploy
// users (infra/vm/deploy-forced-command.sh, environment prod). Production only runs images already
// running in staging, pinned by image ID; no production key exists anywhere.

const RELEASE = /^[0-9a-f]{12,40}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export interface EnvStatus {
  release: string;
  web: string;
  worker: string;
}
export type VmStatus = Record<"staging" | "prod", EnvStatus>;

/** Parses the JSON printed by the forced command's `status` action. */
export function parseStatus(text: string): VmStatus {
  const value = JSON.parse(text) as Partial<VmStatus>;
  for (const env of ["staging", "prod"] as const) {
    const item = value[env];
    if (!item || typeof item.release !== "string" || typeof item.web !== "string" || typeof item.worker !== "string") {
      throw new Error(`unexpected status from the VM: ${env} is missing`);
    }
  }
  return value as VmStatus;
}

/** The promote request, built only from values that passed validation. */
export function promoteCommand(staging: EnvStatus): string {
  if (!RELEASE.test(staging.release)) throw new Error("staging runs no valid release");
  if (!IMAGE_ID.test(staging.web) || !IMAGE_ID.test(staging.worker)) throw new Error("staging image IDs are missing");
  return `promote ${staging.release} ${staging.web} ${staging.worker}`;
}

/** Root script sending one request to the forced command of production (it splits the request on spaces, no shell parses it). */
export function deployScript(request: string): string {
  if (!/^[a-z]+( [0-9a-z:]+)*$/.test(request)) throw new Error("invalid deploy request");
  return `SSH_ORIGINAL_COMMAND='${request}' /usr/local/sbin/joutiya-deploy prod`;
}

async function deployStatus(oci: Oci, compartmentId: string, instanceId: string): Promise<VmStatus> {
  const output = await runCommand(oci, compartmentId, instanceId, "joutiya-deploy status", rootCommand(`${deployScript("status")} 2> /dev/null`), 300, true);
  return parseStatus(output.trim().split("\n").at(-1) ?? "");
}

function printStatus(current: VmStatus): void {
  for (const env of ["staging", "prod"] as const) {
    const { release, web, worker } = current[env];
    console.log(`${env.padEnd(8)} ${release || "(no release)"}  web ${web.slice(7, 19) || "-"}  worker ${worker.slice(7, 19) || "-"}`);
  }
}

function isOnMain(release: string): boolean {
  spawnSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: root, stdio: "ignore" });
  return spawnSync("git", ["merge-base", "--is-ancestor", release, "origin/main"], { cwd: root, stdio: "ignore" }).status === 0;
}

/** Purges the zone's cache after a production change. Warns only: the release itself is done. */
async function purgeCache(targets: Targets): Promise<void> {
  const zone = targets.shared.cloudflare.zoneId;
  try {
    if (!zone) throw new Error("shared.cloudflare.zoneId is not recorded");
    await cloudflare(`/zones/${zone}/purge_cache`, { purge_everything: true });
    console.log("Cloudflare cache purged");
  } catch (error) {
    console.warn(`warning: Cloudflare cache not purged (${(error as Error).message})`);
  }
}

async function release(oci: Oci, targets: Targets, compartmentId: string, action: "status" | "promote" | "rollback"): Promise<void> {
  const instance = await runningInstance(oci, compartmentId);
  const current = await deployStatus(oci, compartmentId, instance.id);
  printStatus(current);
  if (action === "status") return;
  let request = "rollback";
  if (action === "promote") {
    request = promoteCommand(current.staging);
    if (current.staging.release === current.prod.release) throw new Error("production already runs this release");
    if (!isOnMain(current.staging.release)) throw new Error(`release ${current.staging.release} is not a commit of origin/main: not promoted`);
  }
  const output = await runCommand(oci, compartmentId, instance.id, `joutiya-deploy ${request.split(" ").slice(0, 2).join(" ")}`, rootCommand(deployScript(request)));
  if (!oci.apply) return;
  console.log(output.trimEnd());
  await purgeCache(targets);
  printStatus(await deployStatus(oci, compartmentId, instance.id));
}

async function reboot(oci: Oci, compartmentId: string): Promise<void> {
  const instance = await runningInstance(oci, compartmentId);
  await oci.write("POST", `/20160918/instances/${instance.id}${query({ action: "SOFTRESET" })}`, undefined, { action: "SOFTRESET" });
  if (oci.apply) console.log("reboot requested: follow it with `node scripts/oracle-vm.ts status`");
}

function credentialsFromEnv(): OciCredentials {
  const read = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  return {
    tenancy: read("JOUTIYA_OCI_TENANCY"),
    user: read("JOUTIYA_OCI_USER"),
    fingerprint: read("JOUTIYA_OCI_FINGERPRINT"),
    region: read("JOUTIYA_OCI_REGION"),
    privateKey: Buffer.from(read("JOUTIYA_OCI_KEY_B64"), "base64").toString("utf8"),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [action, file] = args.filter((arg) => !arg.startsWith("--"));
  const retry = Number(/^--retry-minutes=(\d+)$/.exec(args.find((arg) => arg.startsWith("--retry-minutes=")) ?? "")?.[1] ?? 0);
  const actions = ["create", "status", "reboot", "agent", "run", "sync", "deploy-status", "promote", "rollback"];
  if (!action || !actions.includes(action) || (action === "run") !== (file !== undefined)) {
    throw new Error("usage: scripts/oracle-vm.ts <create|status|reboot|agent|sync|run <script>|deploy-status|promote|rollback> [--apply] [--retry-minutes=<n>]");
  }

  const raw: unknown = JSON.parse(readFileSync(new URL("../infra/targets.json", import.meta.url), "utf8"));
  const errors = validateTargets(raw);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const targets = raw as Targets;
  const credentials = credentialsFromEnv();
  const { tenancyId, userId, compartmentId, homeRegion } = targets.shared.oracle;
  // The variables must name exactly the recorded tenancy, user, region and compartment (§9).
  if (credentials.tenancy !== tenancyId || credentials.user !== userId || credentials.region !== homeRegion || process.env.JOUTIYA_OCI_COMPARTMENT?.trim() !== compartmentId) {
    throw new Error("JOUTIYA_OCI_* do not match shared.oracle in infra/targets.json: nothing done");
  }
  const oci = new Oci(credentials, args.includes("--apply"));
  const compartment = compartmentId as string;
  if (action === "create") await create(oci, targets, compartment, retry);
  else if (action === "reboot") await reboot(oci, compartment);
  else if (action === "agent") await agent(oci, compartment);
  else if (action === "run") await run(oci, compartment, file as string);
  else if (action === "sync") await sync(oci, compartment, args.find((arg) => arg.startsWith("--deploy-staging-key="))?.split("=").slice(1).join("="));
  else if (action === "deploy-status") await release(oci, targets, compartment, "status");
  else if (action === "promote" || action === "rollback") await release(oci, targets, compartment, action);
  else await status(oci, targets, compartment);
  if (!["status", "agent", "deploy-status"].includes(action)) console.log(oci.apply ? "\nDone." : "\nDry run: nothing written. Add --apply to send these requests.");
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]oracle-vm\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`oracle-vm: ${(error as Error).message}`);
    process.exit(1);
  });
}
