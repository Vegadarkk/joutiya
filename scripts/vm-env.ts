// Environment files of the VM (docs/phase-1.md, step 16): /etc/joutiya/<env>/app.env and the two
// Valkey passwords, merged by OCI Run Command through `node scripts/oracle-vm.ts env`, which uses
// this module. No value is ever printed: names, sources and line numbers only.
//
// Where each value comes from:
// - infra/targets.json and the hosts of §1 (derivedValues), never a file;
// - the VM itself for CSRF_SECRET, the Valkey passwords (with the two Redis URLs) and Meilisearch's
//   master key (meilisearch.env, phase 4): generated there once, they never leave it, and a rebuilt
//   VM simply gets new ones. The app's two Meilisearch keys come from that master key
//   (infra/vm/search-setup.sh);
// - the dotenv files given with --from for everything else. On the owner's PC that is his
//   .env.local, which he shares with another product: it is only read, and only names of
//   .env.example count. For <env> (staging or prod):
//     NAME_STAGING=… or NAME_PROD=…             the value of that environment;
//     NAME=… then, on the next line, # NAME=…    Nav's layout of 16 October for the PAIRED names:
//                                                production active, staging commented under it;
//     any other NAME=…                           development's or the other product's: ignored.
//
//   node scripts/vm-env.ts pepper <file>
//       appends HASH_PEPPER_STAGING and HASH_PEPPER_PROD (64 random hex characters each) to <file>
//       when missing, without touching its other lines. HASH_PEPPER keys the hashed e-mails,
//       phones and suppressions in Firestore: this copy, and one in the owner's password manager,
//       is what survives a rebuilt VM.

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { assertTargets, type Targets } from "./assert-target.ts";

export const DEPLOYED_ENVS = ["staging", "prod"] as const;
export type DeployedEnv = (typeof DEPLOYED_ENVS)[number];

const HOSTS: Record<DeployedEnv, { site: string; admin: string; media: string }> = {
  staging: { site: "staging.joutiya.ma", admin: "admin-staging.joutiya.ma", media: "media-staging.joutiya.ma" },
  prod: { site: "joutiya.ma", admin: "admin.joutiya.ma", media: "media.joutiya.ma" },
};

/** Set by Compose or the image, development only, or the owner's own tooling: never in app.env. */
const NOT_IN_APP_ENV = new Set([
  "APP_ENV",
  "NODE_ENV",
  "RELEASE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "STANDALONE_HOST",
  "DEV_MAILBOX",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FIRESTORE_EMULATOR_HOST",
  "ACCESS_OWNER_EMAIL",
  "ACCESS_CI_TOKEN_ID",
  "ACCESS_PROBE_TOKEN_ID",
  // Meilisearch's own key, in meilisearch.env only: the app holds two scoped keys made from it.
  "MEILI_MASTER_KEY",
]);

/** Generated on the VM (by the merge script, the Meilisearch keys by search-setup.sh), never taken from a file. */
export const VM_GENERATED = ["CSRF_SECRET", "QUEUE_REDIS_URL", "RATE_LIMIT_REDIS_URL", "MEILI_SEARCH_KEY", "MEILI_INDEX_KEY"] as const;

/** A partial R2 set stops the app: the derived R2 settings are written only with both keys. */
export const R2_KEYS = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
const R2_DERIVED = ["R2_S3_ENDPOINT", "R2_BUCKET_QUARANTINE", "R2_BUCKET_MEDIA", "R2_BUCKET_PRIVATE", "MEDIA_BASE_URL"];

/**
 * What staging and production cannot start without: REQUIRED_DEPLOYED of src/lib/env.ts, SITE_URL
 * (https outside dev) and the identifiers scripts/assert-target.ts requires in strict mode, less
 * APP_ENV and GOOGLE_APPLICATION_CREDENTIALS, which Compose sets.
 */
export const REQUIRED = [
  "SITE_URL",
  "ADMIN_HOST",
  "QUEUE_REDIS_URL",
  "RATE_LIMIT_REDIS_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "ALERT_RELAY_URL",
  "ALERT_RELAY_SECRET",
  "HASH_PEPPER",
  "CSRF_SECRET",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_API_KEY",
  "FIREBASE_APP_ID",
  "FIREBASE_SERVICE_ACCOUNT",
  "GOOGLE_OAUTH_CLIENT_ID",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "MAIL_API_KEY",
  "MAIL_WEBHOOK_SECRET",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
] as const;

/** Names app.env may hold: those of .env.example, less NOT_IN_APP_ENV and the JOUTIYA_* tooling names. */
export function appEnvNames(example: string): string[] {
  const names = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? "");
  return [...new Set(names)].filter((name) => name !== "" && !name.startsWith("JOUTIYA_") && !NOT_IN_APP_ENV.has(name));
}

/** Values that follow from infra/targets.json and the hosts of §1 (R2's join only with its keys). */
export function derivedValues(env: DeployedEnv, targets: Targets): Record<string, string> {
  const recorded = targets.environments[env];
  const { accountId, accessTeamDomain } = targets.shared.cloudflare;
  const project = recorded.firebase.projectId;
  const values: Record<string, string | null> = {
    SITE_URL: `https://${HOSTS[env].site}`,
    ADMIN_HOST: HOSTS[env].admin,
    LOG_LEVEL: "info",
    // §6: staging starts with its CSP in report-only mode; production enforces it.
    CSP_REPORT_ONLY: env === "staging" ? "true" : null,
    FIREBASE_PROJECT_ID: project,
    FIREBASE_APP_ID: recorded.firebase.appId,
    FIREBASE_SERVICE_ACCOUNT: project === null ? null : `joutiya-web@${project}.iam.gserviceaccount.com`,
    GOOGLE_OAUTH_CLIENT_ID: recorded.google.oauthClientId,
    TURNSTILE_SITE_KEY: recorded.turnstile.siteKey,
    SENTRY_DSN: recorded.sentry.dsn,
    CF_ACCOUNT_ID: accountId,
    CF_ACCESS_TEAM_DOMAIN: accessTeamDomain,
    CF_ACCESS_AUD: recorded.cloudflare.accessAud,
    WHATSAPP_PHONE_NUMBER_ID: recorded.whatsapp.phoneNumberId,
    MAIL_PROVIDER: "resend",
    MAIL_FROM: "Joutiya <no-reply@notif.joutiya.ma>",
    R2_S3_ENDPOINT: accountId === null ? null : `https://${accountId}.eu.r2.cloudflarestorage.com`,
    R2_BUCKET_QUARANTINE: recorded.r2.quarantine,
    R2_BUCKET_MEDIA: recorded.r2.media,
    R2_BUCKET_PRIVATE: recorded.r2.private,
    MEDIA_BASE_URL: `https://${HOSTS[env].media}`,
    // Phase 4: Meilisearch on the environment's internal data network.
    MEILI_URL: "http://meilisearch:7700",
  };
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null));
}

/** A dotenv file to read (its name, or "stdin", labels the lines in messages). */
export interface Source {
  label: string;
  text: string;
}

export interface EnvPlan {
  /** What this run writes, by name. */
  values: Record<string, string>;
  /** Where each written value comes from: infra/targets.json or <file>:<line>. */
  sources: Record<string, string>;
  /** Lines not used, names only. */
  ignored: string[];
  /** Required names neither in this run, nor already on the VM, nor generated there. */
  missing: string[];
  errors: string[];
}

/** Names Nav laid out in pairs in the owner's .env.local (16 October 2026); any other needs a suffix. */
export const PAIRED = ["FIREBASE_SERVER_API_KEY", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "MAIL_FALLBACK_API_KEY"] as const;

const LINE = /^(#[ \t]?)?(?:export[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*=(.*)$/;
// Inside single quotes in app.env (Compose reads them literally): no quote, no control character.
const UNSAFE = /['\p{Cc}]/u;

/** The value of one NAME=… line, as Node's --env-file reads it (quotes, inline comments). */
function lineValue(name: string, rest: string): string {
  return (parseEnv(`${name}=${rest}`)[name] ?? "").trim();
}

interface Found {
  value: string;
  where: string;
}

/** The values a --from file gives <env>, by the rules of the header. */
function readSource(env: DeployedEnv, source: Source, allowed: ReadonlySet<string>, found: Map<string, Found>, ignored: string[], errors: string[]): void {
  const suffix = `_${env.toUpperCase()}`;
  const lines = source.text.replace(/^\uFEFF/, "").split(/\r?\n/).map((raw) => {
    const match = LINE.exec(raw);
    return match ? { commented: match[1] !== undefined, name: match[2] ?? "", rest: match[3] ?? "" } : undefined;
  });
  const take = (name: string, value: string, where: string): void => {
    if (value === "") {
      ignored.push(`${name}: empty at ${where}`);
      return;
    }
    if (UNSAFE.test(value)) {
      errors.push(`${name} (${where}) holds a single quote or a control character, which app.env cannot hold`);
      return;
    }
    const previous = found.get(name);
    if (previous === undefined) found.set(name, { value, where });
    else if (previous.value !== value) errors.push(`${name}: ${previous.where} and ${where} differ`);
  };
  for (const [index, line] of lines.entries()) {
    if (line === undefined || line.commented) continue;
    const where = `${source.label}:${index + 1}`;
    const base = line.name.endsWith(suffix) ? line.name.slice(0, -suffix.length) : undefined;
    if (base !== undefined && allowed.has(base)) {
      take(base, lineValue(base, line.rest), where);
    } else if (allowed.has(line.name)) {
      const next = lines[index + 1];
      if ((PAIRED as readonly string[]).includes(line.name) && next?.commented === true && next.name === line.name) {
        if (env === "prod") take(line.name, lineValue(line.name, line.rest), `${where} (production line of a pair)`);
        else take(line.name, lineValue(line.name, next.rest), `${source.label}:${index + 2} (staging line of a pair)`);
      } else {
        ignored.push(`${line.name}: ${where} is development's or another product's, ignored (this environment's value goes in ${line.name}${suffix})`);
      }
    }
  }
}

/** What `env <env>` writes, from the registry, the --from files and the names already on the VM. */
export function planEnv(input: { env: DeployedEnv; targets: Targets; example: string; sources: Source[]; existing: ReadonlySet<string> }): EnvPlan {
  const { env, targets, existing } = input;
  const allowed = new Set(appEnvNames(input.example));
  const derived = derivedValues(env, targets);
  const found = new Map<string, Found>();
  const ignored: string[] = [];
  const errors: string[] = [];
  for (const source of input.sources) readSource(env, source, allowed, found, ignored, errors);

  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const [name, { value, where }] of found) {
    if ((VM_GENERATED as readonly string[]).includes(name)) {
      ignored.push(`${name}: ${where} not used, generated on the VM`);
    } else if (derived[name] !== undefined) {
      // The registry decides; a different line is a sign that the layout was misread.
      if (derived[name] !== value) errors.push(`${name} (${where}) differs from infra/targets.json: check which line holds which environment`);
    } else {
      values[name] = value;
      sources[name] = where;
    }
  }

  const keys = R2_KEYS.filter((name) => values[name] !== undefined || existing.has(name));
  if (keys.length === 1) errors.push(`${R2_KEYS.join(" and ")} go together: only ${keys[0] ?? ""} is set`);
  for (const [name, value] of Object.entries(derived)) {
    if (R2_DERIVED.includes(name) && keys.length < R2_KEYS.length) continue;
    values[name] = value;
    sources[name] = "infra/targets.json";
  }

  const pepper = values.HASH_PEPPER;
  if (pepper !== undefined && pepper.length < 32) errors.push("HASH_PEPPER must be at least 32 characters");
  errors.push(...assertTargets(targets, { APP_ENV: env, ...values }));
  for (const name of Object.keys(values)) if (!allowed.has(name)) errors.push(`${name} is not a variable of .env.example`);

  const generated = new Set<string>(VM_GENERATED);
  const missing = REQUIRED.filter((name) => values[name] === undefined && !existing.has(name) && !generated.has(name));
  const sorted = Object.keys(values).sort();
  return {
    values: Object.fromEntries(sorted.map((name) => [name, values[name] ?? ""])),
    sources: Object.fromEntries(sorted.map((name) => [name, sources[name] ?? ""])),
    ignored,
    missing,
    errors,
  };
}

/** app.env lines, single-quoted: Compose reads them literally (no interpolation, no escapes). */
export function envPayload(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || UNSAFE.test(value)) throw new Error(`${name}: cannot be written to app.env`);
      return `${name}='${value}'\n`;
    })
    .join("");
}

export interface EnvDirs {
  /** /etc/joutiya, where each environment has its directory (infra/vm/install.sh). */
  etc: string;
  /** Root-only directory where the payload is assembled, removed once merged. */
  stage: string;
}
const VM_DIRS: EnvDirs = { etc: "/etc/joutiya", stage: "/var/lib/joutiya/env" };

/** Read-only root script: the names already in app.env, never a value. */
export function namesScript(env: DeployedEnv, dirs: EnvDirs = VM_DIRS): string {
  const file = `${dirs.etc}/${env}/app.env`;
  return [`if [[ -f ${file} ]]; then`, `  echo "names: $(cut -d= -f1 ${file} | grep -E '^[A-Z][A-Z0-9_]*$' | sort -u | tr '\\n' ' ')"`, "else", '  echo "names:"', "fi"].join("\n");
}

/** The required names a merge reports as still missing, or undefined when its report is not there. */
export function parseMissing(output: string): string[] | undefined {
  const line = output.split("\n").find((text) => text.startsWith("missing:"));
  return line === undefined ? undefined : line.slice("missing:".length).trim().split(/\s+/).filter((name) => name !== "");
}

/** The names a namesScript or a merge printed. */
export function parseNames(output: string): Set<string> {
  const line = output.split("\n").find((text) => text.startsWith("names:")) ?? "names:";
  return new Set(line.slice("names:".length).trim().split(/\s+/).filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name)));
}

/**
 * Root scripts for Run Command: the payload (base64) appended in chunks to a root-only file, then
 * checked against its SHA-256 and merged into app.env. The merge keeps the lines of other names,
 * generates CSRF_SECRET and each Valkey password once, rebuilds the two Redis URLs from those
 * passwords, replaces app.env atomically (0600), then prints the names it holds and, last (Run
 * Command returns the last 1 KB), the required names still missing.
 */
export function envScripts(env: DeployedEnv, payload: string, dirs: EnvDirs = VM_DIRS, chunkSize = 3_000): string[] {
  const names = [...payload.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? "");
  if (names.length === 0) throw new Error("nothing to write");
  const encoded = Buffer.from(payload).toString("base64");
  const staged = `${dirs.stage}/${env}.b64`;
  const dir = `${dirs.etc}/${env}`;
  const chunks = encoded.match(new RegExp(`.{1,${chunkSize}}`, "g")) ?? [];
  const append = chunks.map((chunk, index) =>
    [...(index === 0 ? [`install -d -m 0700 ${dirs.stage}`, `: > ${staged}`] : []), `printf '%s' '${chunk}' >> ${staged}`, `echo "chunk ${index + 1}/${chunks.length}"`].join("\n"),
  );
  const sha256 = createHash("sha256").update(encoded).digest("hex");
  const replaced = [...names, "QUEUE_REDIS_URL", "RATE_LIMIT_REDIS_URL"].join("|");
  const merge = [
    `trap 'rm -f ${staged} "\${new:-}"' EXIT`,
    `echo "${sha256}  ${staged}" | sha256sum -c --quiet`,
    "umask 077",
    `install -d -m 0700 ${dir}`,
    `new="$(mktemp ${dir}/.app.env.XXXXXX)"`,
    `if [[ -f ${dir}/app.env ]]; then grep -v -E '^(${replaced})=' ${dir}/app.env > "$new" || [[ $? -eq 1 ]]; fi`,
    `base64 -d ${staged} >> "$new"`,
    `grep -q '^CSRF_SECRET=' "$new" || printf "CSRF_SECRET='%s'\\n" "$(openssl rand -hex 32)" >> "$new"`,
    "for role in queue ratelimit; do",
    `  file=${dir}/valkey-$role.env`,
    `  [[ -s $file ]] || printf 'VALKEY_PASSWORD=%s\\n' "$(openssl rand -hex 32)" > "$file"`,
    '  chmod 0600 "$file"',
    "done",
    `queue="$(sed -n 's/^VALKEY_PASSWORD=//p' ${dir}/valkey-queue.env)"`,
    `ratelimit="$(sed -n 's/^VALKEY_PASSWORD=//p' ${dir}/valkey-ratelimit.env)"`,
    `[[ -s ${dir}/meilisearch.env ]] || printf 'MEILI_MASTER_KEY=%s\\n' "$(openssl rand -hex 32)" > ${dir}/meilisearch.env`,
    `chmod 0600 ${dir}/meilisearch.env`,
    `printf "QUEUE_REDIS_URL='redis://:%s@valkey-queue:6379'\\nRATE_LIMIT_REDIS_URL='redis://:%s@valkey-ratelimit:6379'\\n" "$queue" "$ratelimit" >> "$new"`,
    'chmod 0600 "$new"',
    `mv -f "$new" ${dir}/app.env`,
    `echo "app.env $(sha256sum ${dir}/app.env | cut -c1-12)"`,
    `echo "names: $(cut -d= -f1 ${dir}/app.env | sort | tr '\\n' ' ')"`,
    'missing=""',
    `for name in ${REQUIRED.join(" ")}; do grep -q "^$name=" ${dir}/app.env || missing="$missing $name"; done`,
    'echo "missing:$missing"',
  ].join("\n");
  return [...append, merge];
}

/** Lines to append so that the file holds HASH_PEPPER_STAGING and HASH_PEPPER_PROD; never rewrites one. */
export function pepperLines(text: string, random: () => string = () => randomBytes(32).toString("hex")): { append: string; added: string[] } {
  const present = (name: string): boolean => text.split(/\r?\n/).some((line) => line.startsWith(`${name}=`) && line.slice(name.length + 1).trim() !== "");
  const added = DEPLOYED_ENVS.map((env) => `HASH_PEPPER_${env.toUpperCase()}`).filter((name) => !present(name));
  if (added.length === 0) return { append: "", added };
  const lead = text === "" || text.endsWith("\n") ? "" : "\n";
  return { append: lead + added.map((name) => `${name}=${random()}\n`).join(""), added };
}

function main(): void {
  const [action, file] = process.argv.slice(2);
  if (action !== "pepper" || file === undefined) throw new Error("usage: node scripts/vm-env.ts pepper <file>");
  if (!existsSync(file)) throw new Error(`${file}: no such file`);
  const { append, added } = pepperLines(readFileSync(file, "utf8"));
  if (append !== "") appendFileSync(file, append);
  console.log(added.length > 0 ? `${file}: added ${added.join(", ")} (values not shown)` : `${file}: HASH_PEPPER_STAGING and HASH_PEPPER_PROD already set`);
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]vm-env\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  try {
    main();
  } catch (error) {
    console.error(`vm-env: ${(error as Error).message}`);
    process.exit(1);
  }
}
