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
//
// Environment (never printed): JOUTIYA_OCI_TENANCY, _USER, _FINGERPRINT, _REGION, _COMPARTMENT,
// _KEY_B64 (base64 of the PEM key of joutiya-claude), JOUTIYA_CLOUDFLARE_API_TOKEN.

import { createHash, createSign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
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
/** Files of this repository installed on the VM (as `scripts/deploy-prod.ts vm-sync`, minus what only runs here). */
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

function vmFilesTarball(): string {
  const excluded = VM_FILES_EXCLUDED.map((file) => `--exclude=${file}`);
  const tar = spawnSync("tar", ["-czf", "-", "--owner=0", "--group=0", ...excluded, "-C", root, ...VM_FILES], { maxBuffer: 16 * 1024 * 1024 });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  return tar.stdout.toString("base64");
}

// ---------------------------------------------------------------------------------------------
// Cloudflare: tunnel tokens, read in memory only.

const CF_API = "https://api.cloudflare.com/client/v4";

async function cloudflare<T>(path: string): Promise<T> {
  const token = process.env.JOUTIYA_CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error("JOUTIYA_CLOUDFLARE_API_TOKEN is not set");
  const response = await fetch(`${CF_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = (await response.json().catch(() => null)) as { success?: boolean; errors?: { code: number; message: string }[]; result?: T } | null;
  if (!response.ok || !payload?.success) {
    throw new Error(`Cloudflare GET ${path.replace(/\/token$/, "/<token>")}: HTTP ${response.status} (${payload?.errors?.map((error) => error.message).join("; ") ?? "no JSON body"})`);
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
    // No SSH key: admin access goes through ssh.joutiya.ma (Access) or OCI Run Command.
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

async function reboot(oci: Oci, compartmentId: string): Promise<void> {
  const instance = await findOne<Instance>(oci, "/20160918/instances", { compartmentId }, NAMES.instance);
  if (!instance) throw new Error(`instance ${NAMES.instance}: none`);
  if (instance.lifecycleState !== "RUNNING") throw new Error(`instance ${NAMES.instance} is ${instance.lifecycleState}, not RUNNING`);
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
  const action = args.find((arg) => !arg.startsWith("--"));
  const retry = Number(/^--retry-minutes=(\d+)$/.exec(args.find((arg) => arg.startsWith("--retry-minutes=")) ?? "")?.[1] ?? 0);
  if (action !== "create" && action !== "status" && action !== "reboot") throw new Error("usage: scripts/oracle-vm.ts <create|status|reboot> [--apply] [--retry-minutes=<n>]");

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
  if (action === "create") await create(oci, targets, compartmentId as string, retry);
  else if (action === "reboot") await reboot(oci, compartmentId as string);
  else await status(oci, targets, compartmentId as string);
  if (action !== "status") console.log(oci.apply ? "\nDone." : "\nDry run: nothing written. Add --apply to send these requests.");
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]oracle-vm\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`oracle-vm: ${(error as Error).message}`);
    process.exit(1);
  });
}
