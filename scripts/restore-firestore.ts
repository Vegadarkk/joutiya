// Restores the encrypted Firestore backups (D17, docs/backups.md) into a project or the local
// emulator, from the owner's machine: the age identity (private key) never leaves it.
//
//   node scripts/restore-firestore.ts --identity <age key file> --from <dir> --project <id> \
//     [--collections users,listings] [--until YYYY-MM-DD] [--apply] [--allow-production] \
//     [--allow-unverified] [--allow-over-quota]
//   node --env-file=.env.local scripts/restore-firestore.ts --identity <file> --from-bucket --project <id> ...
//
// <dir> is a download of the private bucket's `backups/` prefix (the files stay encrypted);
// --from-bucket reads it directly with R2_S3_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and
// R2_BUCKET_PRIVATE (a private bucket recorded in infra/targets.json). Dry run by default: every
// part is decrypted in memory, checked against its manifest and decoded, and the plan is printed
// (counts only, never document contents, never the identity). With --apply the newest version of
// each document is written with set() in batches of 500.
// Refusals: parts of a date without manifest (a run that did not finish) unless --allow-unverified;
// more than Spark's 20 000 daily writes into a real project unless --allow-over-quota (a project on
// Blaze, where they are billed): split with --collections over several days (docs/backups.md).
// Target: with FIRESTORE_EMULATOR_HOST set, the emulator (any project id); otherwise a project
// recorded in infra/targets.json, the production one only with --allow-production. Credentials:
// Application Default Credentials (`gcloud auth application-default login`).

import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bucketSource } from "../src/lib/backup/bucket-source.ts";
import { loadAgeIdentity, redactSecrets } from "../src/lib/backup/crypto.ts";
import { applyRestore, checkRestore, directorySource, planRestore, type BackupSource } from "../src/lib/backup/restore.ts";
import { APP_ENVS, validateTargets, type Targets } from "./assert-target.ts";

const USAGE =
  "usage: scripts/restore-firestore.ts --identity <age key file> (--from <dir> | --from-bucket) --project <id> [--collections a,b] [--until YYYY-MM-DD] [--apply] [--allow-production] [--allow-unverified] [--allow-over-quota]";
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** Spark: 20 000 document writes a day, the app's own included; past it every write fails until the Pacific midnight. */
export const SPARK_DAILY_WRITES = 20_000;

export interface RestoreArgs {
  identity: string;
  from: string | null;
  fromBucket: boolean;
  project: string;
  collections: string[] | null;
  until: string | null;
  apply: boolean;
  allowProduction: boolean;
  allowUnverified: boolean;
  allowOverQuota: boolean;
}

export function parseCli(argv: readonly string[]): RestoreArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      identity: { type: "string" },
      from: { type: "string" },
      "from-bucket": { type: "boolean", default: false },
      project: { type: "string" },
      collections: { type: "string" },
      until: { type: "string" },
      apply: { type: "boolean", default: false },
      "allow-production": { type: "boolean", default: false },
      "allow-unverified": { type: "boolean", default: false },
      "allow-over-quota": { type: "boolean", default: false },
    },
    strict: true,
  });
  const identity = values.identity?.trim() ?? "";
  const from = values.from?.trim() || null;
  const fromBucket = values["from-bucket"] === true;
  const project = values.project?.trim() ?? "";
  if (!identity || !project || (from === null) === !fromBucket) throw new Error(USAGE);
  const collections = values.collections
    ? values.collections
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : null;
  if (collections?.some((id) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(id))) throw new Error(`--collections: comma-separated collection ids expected\n${USAGE}`);
  const until = values.until?.trim() || null;
  if (until !== null && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error(`--until: a date (YYYY-MM-DD) expected\n${USAGE}`);
  return {
    identity,
    from,
    fromBucket,
    project,
    collections: collections?.length ? collections : null,
    until,
    apply: values.apply === true,
    allowProduction: values["allow-production"] === true,
    allowUnverified: values["allow-unverified"] === true,
    allowOverQuota: values["allow-over-quota"] === true,
  };
}

/**
 * Why the restore must not write into `projectId`; null when it may. The emulator takes any id
 * (nothing leaves the machine); a real project must be recorded in infra/targets.json, and the
 * production one needs --allow-production.
 */
export function projectProblem(targets: Targets, projectId: string, options: { emulated: boolean; allowProduction: boolean }): string | null {
  if (!PROJECT_ID.test(projectId)) return "--project: not a Firebase project id";
  if (options.emulated) return null;
  const env = APP_ENVS.find((name) => targets.environments[name].firebase.projectId === projectId);
  if (!env) return `--project ${projectId} is not recorded in infra/targets.json (environments.<env>.firebase.projectId): record it first`;
  if (env === "prod" && !options.allowProduction) return `--project ${projectId} is the production project: check the dry run, then add --allow-production to write into it`;
  return null;
}

/**
 * Why `documents` writes must not go into the target; null when they may. Spark refuses every
 * write past 20 000 a day: a restore cut half-way leaves a mix of restored and live documents, and
 * the app's own writes fail with it. The emulator has no quota; --allow-over-quota is for a project
 * on Blaze (writes past the free tier billed).
 */
export function writesProblem(documents: number, options: { emulated: boolean; allowOverQuota: boolean }): string | null {
  if (options.emulated || options.allowOverQuota || documents <= SPARK_DAILY_WRITES) return null;
  return (
    `${documents} documents exceed Spark's ${SPARK_DAILY_WRITES} writes a day (the app's included): restore with --collections ` +
    `over several days, one batch of collections under that number a day, or, on a project switched to Blaze, add --allow-over-quota`
  );
}

/** Why the R2 variables cannot be used for --from-bucket (names only, never values); empty when they can. */
export function bucketProblems(targets: Targets, env: Record<string, string | undefined>): string[] {
  const missing = ["R2_S3_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_PRIVATE"].filter((name) => !env[name]);
  if (missing.length > 0) return [`--from-bucket needs ${missing.join(", ")}`];
  const bucket = env["R2_BUCKET_PRIVATE"] as string;
  if (!APP_ENVS.some((name) => targets.environments[name].r2.private === bucket)) return ["R2_BUCKET_PRIVATE is not a private bucket recorded in infra/targets.json"];
  return [];
}

function readTargets(): Targets {
  const raw: unknown = JSON.parse(readFileSync(fileURLToPath(new URL("../infra/targets.json", import.meta.url)), "utf8"));
  const errors = validateTargets(raw);
  if (errors.length > 0) throw new Error(errors.map((error) => `infra/targets.json: ${error}`).join("\n"));
  return raw as Targets;
}

async function readIdentity(path: string): Promise<{ identity: string; recipient: string }> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`--identity: cannot read the file (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) console.warn("Warning: the identity file is readable by other users (chmod 600 it).");
  return loadAgeIdentity(text);
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const targets = readTargets();
  const emulated = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  const problem = projectProblem(targets, args.project, { emulated, allowProduction: args.allowProduction });
  if (problem) throw new Error(problem);

  let source: BackupSource;
  if (args.fromBucket) {
    const problems = bucketProblems(targets, process.env);
    if (problems.length > 0) throw new Error(problems.join("\n"));
    const env = process.env as Record<string, string>;
    source = bucketSource({ endpoint: env["R2_S3_ENDPOINT"]!, accessKeyId: env["R2_ACCESS_KEY_ID"]!, secretAccessKey: env["R2_SECRET_ACCESS_KEY"]!, bucket: env["R2_BUCKET_PRIVATE"]! });
  } else {
    source = directorySource(args.from as string);
  }

  const { identity, recipient } = await readIdentity(args.identity);
  // The public key only: compare it with BACKUP_AGE_RECIPIENT.
  console.log(`Identity for ${recipient}`);
  console.log(`Source ${source.label}; target ${args.project} (${emulated ? "Firestore emulator" : "Application Default Credentials"})`);

  const plan = await planRestore(source, identity, { collections: args.collections, until: args.until, allowUnverified: args.allowUnverified });
  for (const warning of plan.warnings) console.warn(`Warning: ${warning}`);
  if (plan.parts.length === 0) throw new Error(`no backup part to restore in ${source.label}`);
  console.log(`${plan.parts.length} part(s) from ${plan.dates[0]} to ${plan.dates[plan.dates.length - 1]}; manifests checked for ${plan.verifiedDates.length} of ${plan.dates.length} date(s)`);

  const check = await checkRestore(source, plan, identity);
  console.log(`${check.lines} lines decrypted and decoded; ${check.documents} documents to write:`);
  for (const [collection, count] of Object.entries(check.byCollection).sort()) console.log(`  ${collection}: ${count}`);
  const writes = writesProblem(check.documents, { emulated, allowOverQuota: args.allowOverQuota });
  if (!args.apply) {
    if (writes) console.warn(`Warning: --apply will refuse: ${writes}.`);
    console.log(`\nDry run: nothing written. Add --apply to write these ${check.documents} documents into ${args.project}.`);
    return;
  }
  if (writes) throw new Error(writes);

  const { applicationDefault, initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = initializeApp({ projectId: args.project, ...(emulated ? {} : { credential: applicationDefault() }) }, "restore-firestore");
  const result = await applyRestore(source, plan, check, identity, getFirestore(app), { log: (line) => console.log(line) });
  console.log(`\n${result.writes} documents written into ${args.project} in ${result.batches} batch(es).`);
  console.log("Deletions are not in the backups: documents purged after a backup are back. Run retention-purge and purge-unactivated before reopening the site.");
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]restore-firestore\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`restore-firestore: ${redactSecrets((error as Error).message)}`);
    process.exit(1);
  });
}
