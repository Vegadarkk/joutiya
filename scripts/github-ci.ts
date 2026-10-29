// GitHub Actions secrets and variables of deploy-staging (docs/phase-1.md, step 8), the security
// scan and the load test (docs/lancement/). The cloud session cannot write them (its proxy refuses
// the Actions API), the PC2 can: Claude prepares and seals in the cloud, Nav sends from the PC2. Each secret is a libsodium sealed box for the
// repository's Actions public key, the format GitHub's API takes: the bundle may travel through any
// channel, chat included, and only GitHub opens it. Nothing here prints a value: names only.
//
//   node scripts/github-ci.ts public-key
//       (Nav, PC2, JOUTIYA_GITHUB_ACTIONS_TOKEN) prints the repository's Actions public key, which
//       is public, and the names of its secrets and variables.
//   node scripts/github-ci.ts seal --public-key=<file> --host-key=<ssh-ed25519 AAAA...> --out=<file> [--enable] [--apply]
//       (Claude, cloud, JOUTIYA_CLOUDFLARE_API_TOKEN) a new deploy-staging key pair, whose public
//       half goes to <out>.pub for `oracle-vm.ts sync --deploy-staging-key=<out>.pub`, and a new
//       secret for the Access service token joutiya-ci (rotated: the previous one stops at once),
//       sealed into <out> with VM_SSH_KNOWN_HOSTS and, with --enable, STAGING_DEPLOY_ENABLED=true.
//       <file> is the JSON that public-key printed. Install the public half on the VM before the
//       bundle goes out with --enable: the next push on main deploys.
//   node scripts/github-ci.ts seal-scan --public-key=<file> --age-recipient=<age1...> --out=<file> [--apply]
//       (Claude, cloud, JOUTIYA_CLOUDFLARE_API_TOKEN) the Access service token joutiya-scan (created,
//       or rotated if it exists) and a new load-test bypass secret, sealed into <out> with the scan
//       and load-test variables (both workflows enabled). The bypass secret also goes, unsealed and
//       mode 0600, to <out>.staging.env (LOADTEST_BYPASS_SECRET, for seal-env.ts app staging) and
//       <out>.cloudflare.env (JOUTIYA_LOADTEST_BYPASS_SECRET, for cloudflare.ts loadtest). Prints
//       the token's id, ACCESS_SCAN_TOKEN_ID of cloudflare.ts access.
//   node scripts/github-ci.ts apply <bundle> [--apply]
//       (Nav, PC2) checks the bundle against the repository and its current key, then writes its
//       secrets and variables.

import { generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sodium from "libsodium-wrappers";
import { validateTargets, type Targets } from "./assert-target.ts";
import { requireEnvProxy } from "./env-proxy.ts";

export const BUNDLE_FORMAT = "joutiya-github-ci v1";
export const SSH_HOST = "ssh.joutiya.ma";
const CI_TOKEN_NAME = "joutiya-ci";
export const SCAN_TOKEN_NAME = "joutiya-scan";
/** Single-header Access authentication of staging.joutiya.ma (infra/cloudflare/access-apps.json). */
export const SCAN_HEADER = "x-joutiya-access-token";
/** The only names a bundle may write: those of deploy-staging.yml, security-scan.yml and load-test.yml. */
export const SECRET_NAMES = ["STAGING_DEPLOY_SSH_KEY", "STAGING_ACCESS_CLIENT_ID", "STAGING_ACCESS_CLIENT_SECRET", "STAGING_SCAN_ACCESS_TOKEN", "LOADTEST_BYPASS_SECRET"] as const;
export const VARIABLE_NAMES = ["VM_SSH_KNOWN_HOSTS", "STAGING_DEPLOY_ENABLED", "ACCESS_TOKEN_HEADER", "SCAN_REPORT_AGE_RECIPIENT", "SECURITY_SCAN_ENABLED", "LOAD_TEST_ENABLED"] as const;
/** Variables that turn a workflow on: "true" or absent. */
const SWITCHES = ["STAGING_DEPLOY_ENABLED", "SECURITY_SCAN_ENABLED", "LOAD_TEST_ENABLED"] as const;
export const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;
const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export interface PublicKey {
  keyId: string;
  /** base64 of the 32-byte X25519 key. */
  key: string;
}

export interface Bundle {
  format: typeof BUNDLE_FORMAT;
  repository: string;
  keyId: string;
  /** name -> base64 sealed box */
  secrets: Record<string, string>;
  /** name -> value (public) */
  variables: Record<string, string>;
}

export function parsePublicKey(text: string): PublicKey {
  const raw = JSON.parse(text) as { keyId?: unknown; key_id?: unknown; key?: unknown };
  const keyId = raw.keyId ?? raw.key_id;
  if (typeof keyId !== "string" || !/^\d+$/.test(keyId)) throw new Error("public key: keyId must be the digits GitHub gives");
  if (typeof raw.key !== "string" || Buffer.from(raw.key, "base64").length !== 32) throw new Error("public key: key must be 32 bytes in base64");
  return { keyId, key: raw.key };
}

export function knownHostsLine(hostKey: string): string {
  const key = hostKey.trim();
  if (!/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/]+=*$/.test(key)) throw new Error("host key: expected `ssh-ed25519 AAAA...` (the bootstrap's `host key` line)");
  return `${SSH_HOST} ${key}`;
}

export async function seal(value: string, publicKey: PublicKey): Promise<string> {
  await sodium.ready;
  return sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL)), sodium.base64_variants.ORIGINAL);
}

function sshString(data: Buffer | string): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** A new ed25519 key pair: OpenSSH private key (unencrypted, as ssh -i reads it) and public line. */
export function sshKeyPair(comment: string): { privateKey: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d ?? "", "base64url");
  const pk = Buffer.from(jwk.x ?? "", "base64url");
  if (seed.length !== 32 || pk.length !== 32) throw new Error("ed25519 key export failed");
  const publicBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(pk)]);
  const check = randomBytes(4);
  let secret = Buffer.concat([check, check, sshString("ssh-ed25519"), sshString(pk), sshString(Buffer.concat([seed, pk])), sshString(comment)]);
  const padding = (8 - (secret.length % 8)) % 8;
  secret = Buffer.concat([secret, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
  const body = Buffer.concat([Buffer.from("openssh-key-v1\0", "latin1"), sshString("none"), sshString("none"), sshString(""), Buffer.from([0, 0, 0, 1]), sshString(publicBlob), sshString(secret)]);
  const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${publicBlob.toString("base64")} ${comment}`,
  };
}

/** A bundle as read back: format, repository, names and base64, so a changed file is refused. */
export function parseBundle(text: string, repository: string): Bundle {
  const raw = JSON.parse(text) as Partial<Bundle>;
  if (raw.format !== BUNDLE_FORMAT) throw new Error(`bundle: format must be "${BUNDLE_FORMAT}"`);
  if (raw.repository !== repository) throw new Error(`bundle: made for ${String(raw.repository)}, not ${repository}`);
  if (typeof raw.keyId !== "string" || !/^\d+$/.test(raw.keyId)) throw new Error("bundle: keyId missing");
  const secrets = raw.secrets ?? {};
  const variables = raw.variables ?? {};
  for (const [name, value] of Object.entries(secrets)) {
    if (!(SECRET_NAMES as readonly string[]).includes(name)) throw new Error(`bundle: secret ${name} is not one of the workflows'`);
    if (typeof value !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(value)) throw new Error(`bundle: secret ${name} is not a sealed box`);
  }
  for (const [name, value] of Object.entries(variables)) {
    if (!(VARIABLE_NAMES as readonly string[]).includes(name)) throw new Error(`bundle: variable ${name} is not one of the workflows'`);
    if (typeof value !== "string") throw new Error(`bundle: variable ${name} is not text`);
  }
  if (variables.VM_SSH_KNOWN_HOSTS !== undefined) knownHostsLine(variables.VM_SSH_KNOWN_HOSTS.replace(`${SSH_HOST} `, ""));
  for (const name of SWITCHES) if (variables[name] !== undefined && variables[name] !== "true") throw new Error(`bundle: ${name} can only be true`);
  if (variables.ACCESS_TOKEN_HEADER !== undefined && variables.ACCESS_TOKEN_HEADER !== SCAN_HEADER) throw new Error(`bundle: ACCESS_TOKEN_HEADER must be ${SCAN_HEADER}`);
  if (variables.SCAN_REPORT_AGE_RECIPIENT !== undefined && !AGE_RECIPIENT.test(variables.SCAN_REPORT_AGE_RECIPIENT)) throw new Error("bundle: SCAN_REPORT_AGE_RECIPIENT is not an age public key");
  return { format: BUNDLE_FORMAT, repository, keyId: raw.keyId, secrets, variables };
}

// ---------------------------------------------------------------------------------------------
// GitHub (PC2 only: the cloud proxy refuses /actions/ paths).

async function github<T>(repository: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: T | undefined }> {
  const token = process.env.JOUTIYA_GITHUB_ACTIONS_TOKEN?.trim();
  if (!token) throw new Error("JOUTIYA_GITHUB_ACTIONS_TOKEN is not set");
  const response = await fetch(`https://api.github.com/repos/${repository}/actions${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "joutiya-github-ci", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok && response.status !== 404) {
    const message = ((await response.json().catch(() => null)) as { message?: string } | null)?.message ?? "no JSON body";
    throw new Error(`GitHub ${method} /actions${path}: HTTP ${response.status} (${message})`);
  }
  const data = response.status === 204 || response.status === 404 ? undefined : ((await response.json().catch(() => undefined)) as T | undefined);
  return { status: response.status, data };
}

async function repositoryKey(repository: string): Promise<PublicKey> {
  const { data } = await github<{ key_id: string; key: string }>(repository, "GET", "/secrets/public-key");
  if (!data) throw new Error("GitHub gave no Actions public key: check the token's repository and Secrets permission");
  return parsePublicKey(JSON.stringify(data));
}

async function names(repository: string, kind: "secrets" | "variables"): Promise<string[]> {
  const { data } = await github<Record<string, { name: string }[]>>(repository, "GET", `/${kind}?per_page=100`);
  return (data?.[kind] ?? []).map((item) => item.name).sort();
}

async function publicKeyAction(repository: string): Promise<void> {
  const key = await repositoryKey(repository);
  console.log(JSON.stringify(key));
  console.log(`secrets:   ${(await names(repository, "secrets")).join(", ") || "(none)"}`);
  console.log(`variables: ${(await names(repository, "variables")).join(", ") || "(none)"}`);
}

async function applyAction(repository: string, file: string, apply: boolean): Promise<void> {
  const bundle = parseBundle(readFileSync(file, "utf8"), repository);
  const key = await repositoryKey(repository);
  if (key.keyId !== bundle.keyId) throw new Error(`bundle sealed for key ${bundle.keyId}, the repository's is now ${key.keyId}: run seal again`);
  for (const [name, encrypted] of Object.entries(bundle.secrets)) {
    console.log(`secret   ${name}`);
    if (apply) await github(repository, "PUT", `/secrets/${name}`, { encrypted_value: encrypted, key_id: bundle.keyId });
  }
  // The *_ENABLED switches last: a workflow stays inert until everything else is in place.
  const last = (name: string): number => Number((SWITCHES as readonly string[]).includes(name));
  const variables = Object.entries(bundle.variables).sort(([a], [b]) => last(a) - last(b));
  for (const [name, value] of variables) {
    const exists = (await github(repository, "GET", `/variables/${name}`)).status === 200;
    console.log(`variable ${name} (${exists ? "update" : "create"})`);
    if (apply) {
      if (exists) await github(repository, "PATCH", `/variables/${name}`, { name, value });
      else await github(repository, "POST", "/variables", { name, value });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Cloudflare (cloud): the Access service token joutiya-ci, rotated, its secret kept in memory.

async function cloudflare<T>(method: string, path: string, body: unknown = {}): Promise<T> {
  const token = process.env.JOUTIYA_CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new Error("JOUTIYA_CLOUDFLARE_API_TOKEN is not set");
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
  const payload = (await response.json().catch(() => null)) as { success?: boolean; errors?: { message: string }[]; result?: T } | null;
  if (!response.ok || !payload?.success) throw new Error(`Cloudflare ${method} ${path}: HTTP ${response.status} (${payload?.errors?.map((error) => error.message).join("; ") ?? "no JSON body"})`);
  return payload.result as T;
}

async function sealAction(targets: Targets, repository: string, args: string[], apply: boolean): Promise<void> {
  const option = (name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const keyFile = option("public-key");
  const hostKey = option("host-key");
  const out = option("out");
  if (!keyFile || !hostKey || !out) throw new Error("seal needs --public-key=<file> --host-key=<ssh-ed25519 AAAA...> --out=<file>");
  const publicKey = parsePublicKey(readFileSync(keyFile, "utf8"));
  const knownHosts = knownHostsLine(hostKey);
  const accountId = targets.shared.cloudflare.accountId;
  if (!accountId) throw new Error("shared.cloudflare.accountId must be recorded in infra/targets.json first");
  const tokens = await cloudflare<{ id: string; name: string }[]>("GET", `/accounts/${accountId}/access/service_tokens?per_page=100`);
  const ci = tokens.filter((token) => token.name === CI_TOKEN_NAME);
  if (ci.length !== 1) throw new Error(`expected one Access service token named ${CI_TOKEN_NAME}, found ${ci.length}`);
  const enable = args.includes("--enable");
  console.log(`deploy-staging key: new ed25519 pair, public half to ${out}.pub`);
  console.log(`Access service token ${CI_TOKEN_NAME} (${ci[0]?.id}): new secret, the previous one stops at once`);
  console.log(`bundle ${out} for ${repository}, key ${publicKey.keyId}: secrets ${SECRET_NAMES.join(", ")}; variables VM_SSH_KNOWN_HOSTS${enable ? ", STAGING_DEPLOY_ENABLED=true" : ""}`);
  if (!apply) return;
  const pair = sshKeyPair("deploy-staging@github-actions");
  const rotated = await cloudflare<{ client_id: string; client_secret: string }>("POST", `/accounts/${accountId}/access/service_tokens/${ci[0]?.id}/rotate`);
  if (!rotated.client_id || !rotated.client_secret) throw new Error("Cloudflare gave no client id or secret");
  const bundle: Bundle = {
    format: BUNDLE_FORMAT,
    repository,
    keyId: publicKey.keyId,
    secrets: {
      STAGING_DEPLOY_SSH_KEY: await seal(pair.privateKey, publicKey),
      STAGING_ACCESS_CLIENT_ID: await seal(rotated.client_id, publicKey),
      STAGING_ACCESS_CLIENT_SECRET: await seal(rotated.client_secret, publicKey),
    },
    variables: { VM_SSH_KNOWN_HOSTS: knownHosts, ...(enable ? { STAGING_DEPLOY_ENABLED: "true" } : {}) },
  };
  writeFileSync(`${out}.pub`, `${pair.publicKey}\n`);
  writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
}

/** A random secret of letters and digits, as LOADTEST_BYPASS_SECRET takes (src/lib/env.ts). */
export function bypassSecret(length = 64): string {
  return Array.from({ length }, () => ALPHANUMERIC[randomInt(ALPHANUMERIC.length)]).join("");
}

async function sealScanAction(targets: Targets, repository: string, args: string[], apply: boolean): Promise<void> {
  const option = (name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const keyFile = option("public-key");
  const recipient = option("age-recipient");
  const out = option("out");
  if (!keyFile || !recipient || !out) throw new Error("seal-scan needs --public-key=<file> --age-recipient=<age1...> --out=<file>");
  if (!AGE_RECIPIENT.test(recipient)) throw new Error("--age-recipient is not an age public key");
  const publicKey = parsePublicKey(readFileSync(keyFile, "utf8"));
  const accountId = targets.shared.cloudflare.accountId;
  if (!accountId) throw new Error("shared.cloudflare.accountId must be recorded in infra/targets.json first");
  const tokens = await cloudflare<{ id: string; name: string }[]>("GET", `/accounts/${accountId}/access/service_tokens?per_page=100`);
  const scan = tokens.filter((token) => token.name === SCAN_TOKEN_NAME);
  if (scan.length > 1) throw new Error(`expected at most one Access service token named ${SCAN_TOKEN_NAME}, found ${scan.length}`);
  console.log(scan[0] ? `Access service token ${SCAN_TOKEN_NAME} (${scan[0].id}): new secret, the previous one stops at once` : `Access service token ${SCAN_TOKEN_NAME}: created (one year)`);
  console.log(`bundle ${out} for ${repository}, key ${publicKey.keyId}: secrets STAGING_SCAN_ACCESS_TOKEN, LOADTEST_BYPASS_SECRET; variables ACCESS_TOKEN_HEADER=${SCAN_HEADER}, SCAN_REPORT_AGE_RECIPIENT, SECURITY_SCAN_ENABLED=true, LOAD_TEST_ENABLED=true`);
  console.log(`bypass secret: ${out}.staging.env and ${out}.cloudflare.env (mode 0600)`);
  if (!apply) return;
  const token = scan[0]
    ? await cloudflare<{ id?: string; client_id: string; client_secret: string }>("POST", `/accounts/${accountId}/access/service_tokens/${scan[0].id}/rotate`)
    : await cloudflare<{ id?: string; client_id: string; client_secret: string }>("POST", `/accounts/${accountId}/access/service_tokens`, { name: SCAN_TOKEN_NAME, duration: "8760h" });
  if (!token.client_id || !token.client_secret) throw new Error("Cloudflare gave no client id or secret");
  const bypass = bypassSecret();
  const bundle: Bundle = {
    format: BUNDLE_FORMAT,
    repository,
    keyId: publicKey.keyId,
    secrets: {
      STAGING_SCAN_ACCESS_TOKEN: await seal(JSON.stringify({ "cf-access-client-id": token.client_id, "cf-access-client-secret": token.client_secret }), publicKey),
      LOADTEST_BYPASS_SECRET: await seal(bypass, publicKey),
    },
    variables: { ACCESS_TOKEN_HEADER: SCAN_HEADER, SCAN_REPORT_AGE_RECIPIENT: recipient, SECURITY_SCAN_ENABLED: "true", LOAD_TEST_ENABLED: "true" },
  };
  writeFileSync(`${out}.staging.env`, `LOADTEST_BYPASS_SECRET=${bypass}\n`, { mode: 0o600 });
  writeFileSync(`${out}.cloudflare.env`, `JOUTIYA_LOADTEST_BYPASS_SECRET=${bypass}\n`, { mode: 0o600 });
  writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
  console.log(`ACCESS_SCAN_TOKEN_ID=${token.id ?? scan[0]?.id ?? "(see the dashboard)"}`);
}

async function main(): Promise<void> {
  requireEnvProxy();
  const args = process.argv.slice(2);
  const [action, file] = args.filter((arg) => !arg.startsWith("--"));
  if (!(action === "public-key" || action === "seal" || action === "seal-scan" || (action === "apply" && file !== undefined))) {
    throw new Error("usage: scripts/github-ci.ts <public-key|seal --public-key=<file> --host-key=<key> --out=<file> [--enable]|seal-scan --public-key=<file> --age-recipient=<age1...> --out=<file>|apply <bundle>> [--apply]");
  }
  const raw: unknown = JSON.parse(readFileSync(new URL("../infra/targets.json", import.meta.url), "utf8"));
  const errors = validateTargets(raw);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const targets = raw as Targets;
  const repository = targets.shared.github.repository;
  if (!repository) throw new Error("shared.github.repository must be recorded in infra/targets.json first");
  const apply = args.includes("--apply");
  if (action === "public-key") return publicKeyAction(repository);
  if (action === "seal") await sealAction(targets, repository, args, apply);
  else if (action === "seal-scan") await sealScanAction(targets, repository, args, apply);
  else await applyAction(repository, file as string, apply);
  console.log(apply ? "\nDone." : "\nDry run: nothing written. Add --apply to send these requests.");
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]github-ci\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`github-ci: ${(error as Error).message}`);
    process.exit(1);
  });
}
