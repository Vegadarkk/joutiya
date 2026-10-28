// Sealed transfer of environment values to the one host that holds the private key of a transfer
// certificate: the PC2 staging now (docs/phase-1.md, « Staging provisoire sur le PC2 »), the VM
// later. CMS AuthEnvelopedData through openssl 3: AES-256-GCM, its key wrapped with RSA-OAEP
// (SHA-256) for the certificate, which is pinned by its SHA-256 fingerprint. The sealed file may
// travel through any channel, chat included: only the key holder opens it, and a changed byte makes
// it unreadable. Nothing here prints a value: names, sources and line numbers only.
//
//   node scripts/seal-env.ts app <env> --from=<file|-> --to=<certificate> --fingerprint=<sha256> --out=<file> [--only=<NAME,...>]
//       app.env lines of <env>, planned by scripts/vm-env.ts from infra/targets.json and the dotenv
//       file, by its rules (names of .env.example, NAME_STAGING / NAME_PROD or Nav's pairs): the
//       owner's .env.local, on his PC. --only keeps these names, for values piped in by Claude.
//   node scripts/seal-env.ts tunnel <env> --to=<certificate> --fingerprint=<sha256> --out=<file>
//       tunnel.env: the token of joutiya-<env>-tunnel, read from the Cloudflare API with
//       JOUTIYA_CLOUDFLARE_API_TOKEN (Claude's cloud session), never shown.
//
// <certificate>: a PEM file, or the base64 DER the host printed (`transfer-certificate ...`).
// The file: `joutiya-sealed v1 <env> <target>` in clear (the file it fills), then the CMS block. The
// sealed text starts with the same line, so a relabelled file is refused where it is opened.

import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateTargets, type Targets } from "./assert-target.ts";
import { DEPLOYED_ENVS, envPayload, planEnv, type DeployedEnv } from "./vm-env.ts";
import { requireEnvProxy } from "./env-proxy.ts";

export const SEALED_TARGETS = ["app.env", "tunnel.env"] as const;
export type SealedTarget = (typeof SEALED_TARGETS)[number];

export interface Sealed {
  env: DeployedEnv;
  target: SealedTarget;
  /** The CMS block, PEM. */
  pem: string;
}

export function sealedHeader(env: DeployedEnv, target: SealedTarget): string {
  return `joutiya-sealed v1 ${env} ${target}`;
}

/**
 * Root script lines opening sealed file <n>, whose CMS block is at "$work/<n>.pem", with the
 * transfer key and certificate in keyDir: the inner label must match the outer one, and the lines
 * land in "$work/<n>.lines". Shared by the PC2 staging and the VM; they expect $work.
 */
export function openSealedLines(file: Pick<Sealed, "env" | "target">, n: number, keyDir: string, host: string): string[] {
  const base = `"$work/${n}`;
  return [
    `openssl cms -decrypt -binary -inform PEM -in ${base}.pem" -inkey ${keyDir}/transfer.key -recip ${keyDir}/transfer.pem -out ${base}.txt" 2> /dev/null || { echo "sealed file ${n}: not sealed for this ${host}, or changed on the way" >&2; exit 1; }`,
    `[[ "$(head -n 1 ${base}.txt")" == '${sealedHeader(file.env, file.target)}' ]] || { echo "sealed file ${n}: its label does not match its content" >&2; exit 1; }`,
    `tail -n +2 ${base}.txt" > ${base}.lines"`,
  ];
}

/** The label and CMS block of a sealed file, also once pasted (line endings, spaces, blank lines). */
export function parseSealed(text: string): Sealed {
  const lines = text.split(/\r\n?|\n/).map((line) => line.trim()).filter((line) => line !== "");
  const [first = "", ...rest] = lines;
  const label = /^joutiya-sealed v1 (staging|prod) (app\.env|tunnel\.env)$/.exec(first);
  const pem = rest.join("\n");
  if (!label || !/^-----BEGIN CMS-----\n[A-Za-z0-9+/=\n]+\n-----END CMS-----$/.test(pem)) throw new Error("not a joutiya sealed file");
  return { env: label[1] as DeployedEnv, target: label[2] as SealedTarget, pem: `${pem}\n` };
}

/** "AB:CD:…", as X509Certificate.fingerprint256 spells it, from any spelling of a SHA-256. */
export function normalizeFingerprint(value: string): string {
  const hex = value.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 64) throw new Error("--fingerprint takes a SHA-256 fingerprint (64 hexadecimal digits)");
  return (hex.match(/../g) ?? []).join(":");
}

/** The certificate as PEM, from a PEM file, a file or text holding its base64 DER. */
export function readCertificate(to: string): string {
  const text = existsSync(to) ? readFileSync(to, "utf8") : to;
  try {
    return new X509Certificate(text.includes("-----BEGIN CERTIFICATE-----") ? text : Buffer.from(text.replace(/\s/g, ""), "base64")).toString();
  } catch {
    throw new Error("--to is neither a certificate file nor a base64 certificate");
  }
}

/** Why values must not be sealed for this certificate: another fingerprint, out of its dates, not RSA. */
export function certificateErrors(pem: string, fingerprint: string, now = new Date()): string[] {
  const certificate = new X509Certificate(pem);
  const errors: string[] = [];
  if (certificate.fingerprint256 !== normalizeFingerprint(fingerprint)) errors.push(`the certificate's fingerprint is ${certificate.fingerprint256}, not the one given`);
  if (now < new Date(certificate.validFrom) || now > new Date(certificate.validTo)) errors.push(`the certificate is valid from ${certificate.validFrom} to ${certificate.validTo} only`);
  if (certificate.publicKey.asymmetricKeyType !== "rsa") errors.push("the certificate's key is not RSA");
  return errors;
}

/** The CMS block that only the holder of the certificate's key opens. */
export function seal(plaintext: string, certificatePem: string, openssl = "openssl"): string {
  const version = spawnSync(openssl, ["version"], { encoding: "utf8" });
  if (version.error !== undefined || !/^OpenSSL [3-9]\./.test(version.stdout)) {
    throw new Error("openssl 3 is needed (Git for Windows ships it in Git Bash: git update-git-for-windows)");
  }
  const dir = mkdtempSync(join(tmpdir(), "joutiya-seal-"));
  try {
    const recipient = join(dir, "recipient.pem");
    writeFileSync(recipient, certificatePem);
    const args = ["cms", "-encrypt", "-binary", "-aes-256-gcm", "-recip", recipient, "-keyopt", "rsa_padding_mode:oaep", "-keyopt", "rsa_oaep_md:sha256", "-keyopt", "rsa_mgf1_md:sha256", "-outform", "PEM"];
    const result = spawnSync(openssl, args, { input: plaintext, encoding: "utf8" });
    if (result.status !== 0 || !result.stdout.startsWith("-----BEGIN CMS-----")) throw new Error(`openssl cms -encrypt failed: ${result.stderr.trim()}`);
    return result.stdout.replace(/\r\n/g, "\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function option(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/** app.env lines from the registry and --from, by vm-env.ts's rules; prints names and sources only. */
function appLines(env: DeployedEnv, targets: Targets, args: string[]): string {
  const from = option(args, "from");
  if (from === undefined) throw new Error("app needs --from=<file> (- reads stdin)");
  const only = option(args, "only")?.split(",").filter((name) => name !== "");
  const plan = planEnv({
    env,
    targets,
    example: readFileSync(new URL("../.env.example", import.meta.url), "utf8"),
    sources: [{ label: from === "-" ? "stdin" : basename(from), text: readFileSync(from === "-" ? 0 : from, "utf8") }],
    existing: new Set(),
  });
  const kept = only ?? Object.keys(plan.values);
  for (const name of kept) {
    if (plan.values[name] === undefined) plan.errors.push(`${name} has no value in this run`);
    else console.log(`  ${name.padEnd(28)} ${plan.sources[name] ?? ""}`);
  }
  if (only === undefined) {
    for (const line of plan.ignored) console.log(`ignored  ${line}`);
    console.log("generated where it is opened: CSRF_SECRET, the Valkey passwords (with the two Redis URLs) and Meilisearch's key");
    if (plan.missing.length > 0) console.log(`missing  ${plan.missing.join(", ")}`);
  }
  if (plan.errors.length > 0) {
    for (const error of plan.errors) console.error(`error    ${error}`);
    throw new Error(`${plan.errors.length} problem(s): nothing sealed`);
  }
  return envPayload(Object.fromEntries(kept.map((name) => [name, plan.values[name] ?? ""])));
}

async function main(): Promise<void> {
  requireEnvProxy();
  const args = process.argv.slice(2);
  const [kind, env, extra] = args.filter((arg) => !arg.startsWith("--"));
  const to = option(args, "to");
  const fingerprint = option(args, "fingerprint");
  const out = option(args, "out");
  if ((kind !== "app" && kind !== "tunnel") || !DEPLOYED_ENVS.some((name) => name === env) || extra !== undefined || !to || !fingerprint || !out) {
    throw new Error("usage: scripts/seal-env.ts <app|tunnel> <staging|prod> --to=<certificate> --fingerprint=<sha256> --out=<file> [--from=<file|->] [--only=<NAME,...>]");
  }
  const deployed = env as DeployedEnv;
  const raw: unknown = JSON.parse(readFileSync(new URL("../infra/targets.json", import.meta.url), "utf8"));
  const targetErrors = validateTargets(raw);
  if (targetErrors.length > 0) throw new Error(targetErrors.join("\n"));
  const targets = raw as Targets;
  const pem = readCertificate(to);
  const errors = certificateErrors(pem, fingerprint);
  if (errors.length > 0) throw new Error(errors.join("; "));

  const target: SealedTarget = kind === "app" ? "app.env" : "tunnel.env";
  let body: string;
  if (kind === "app") {
    console.log(`app.env of ${deployed}, values never shown:`);
    body = appLines(deployed, targets, args);
  } else {
    const { tunnelToken } = await import("./oracle-vm.ts");
    body = `TUNNEL_TOKEN=${await tunnelToken(targets, deployed)}\n`;
  }
  const header = sealedHeader(deployed, target);
  const file = `${header}\n${seal(`${header}\n${body}`, pem)}`;
  writeFileSync(out, file, { mode: 0o600 });
  const subject = new X509Certificate(pem).subject.replace(/\n/g, ", ");
  console.log(`${out}: ${target} of ${deployed} sealed for ${subject}, file sha256 ${createHash("sha256").update(file).digest("hex").slice(0, 16)}`);
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]seal-env\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`seal-env: ${(error as Error).message}`);
    process.exit(1);
  });
}
