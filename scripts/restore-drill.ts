// Restore drill (D20, docs/backups.md): restores the encrypted backups into a fresh project of the
// local emulators, reads every document back and compares it with the backup, counts the dangling
// references, then reports the RTO (time of the restore) and the RPO (age of the newest captured
// version). Run on the owner's machine (the age identity never leaves it), never against a real
// project.
//
//   firebase emulators:exec --only auth,firestore --project demo-joutiya \
//     "node scripts/restore-drill.ts --identity <age key file> --from <dir> [--until YYYY-MM-DD]"
//   (--from-bucket <staging|prod> reads the private bucket directly, as scripts/restore-firestore.ts)
//
// Needs FIRESTORE_EMULATOR_HOST; with FIREBASE_AUTH_EMULATOR_HOST also set, the Firebase Auth export
// is imported into the Auth emulator and counted back. Prints counts, digests and paths only, never
// document contents. Exit code 1 when a collection or the accounts do not match.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bucketSource } from "../src/lib/backup/bucket-source.ts";
import { redactSecrets } from "../src/lib/backup/crypto.ts";
import { verifyRestore, type DrillReport } from "../src/lib/backup/drill.ts";
import { applyAuthRestore, applyRestore, checkRestore, directorySource, planRestore, readAuthExport, type AuthImportTarget, type BackupSource } from "../src/lib/backup/restore.ts";
import { requireEnvProxy } from "./env-proxy.ts";
import { bucketConfig, readIdentity, readTargets } from "./restore-firestore.ts";
import { DEPLOYED_ENVS, type DeployedEnv } from "./vm-env.ts";

const USAGE = "usage: scripts/restore-drill.ts --identity <age key file> (--from <dir> | --from-bucket <staging|prod>) [--until YYYY-MM-DD]";

export interface DrillArgs {
  identity: string;
  from: string | null;
  fromBucket: DeployedEnv | null;
  until: string | null;
}

export function parseDrillCli(argv: readonly string[]): DrillArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: { identity: { type: "string" }, from: { type: "string" }, "from-bucket": { type: "string" }, until: { type: "string" } },
    strict: true,
  });
  const identity = values.identity?.trim() ?? "";
  const from = values.from?.trim() || null;
  const bucketEnv = values["from-bucket"]?.trim();
  if (!identity || (from === null) === (bucketEnv === undefined)) throw new Error(USAGE);
  if (bucketEnv !== undefined && !(DEPLOYED_ENVS as readonly string[]).includes(bucketEnv)) throw new Error(`--from-bucket: staging or prod expected\n${USAGE}`);
  const until = values.until?.trim() || null;
  if (until !== null && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error(`--until: a date (YYYY-MM-DD) expected\n${USAGE}`);
  return { identity, from, fromBucket: (bucketEnv as DeployedEnv | undefined) ?? null, until };
}

/** A project id no earlier drill used: the emulator starts it empty, so every document read back comes from the restore. */
export function drillProjectId(now: Date): string {
  return `demo-drill-${now.toISOString().replace(/\D/g, "").slice(0, 14)}`;
}

/** "3 h 12 min", "45 s": durations of the report. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/** The report's lines: one per collection, one per reference rule, then the verdict. */
export function reportLines(report: DrillReport): string[] {
  const lines: string[] = [];
  for (const [collection, result] of Object.entries(report.collections)) {
    const same = result.expectedSha256 === result.restoredSha256;
    lines.push(`  ${collection}: ${result.restored}/${result.expected} ${same ? "identical" : "DIFFERENT"} (SHA-256 ${result.restoredSha256.slice(0, 12)})`);
    if (result.missing.length > 0) lines.push(`    missing: ${result.missing.join(", ")}`);
    if (result.extra.length > 0) lines.push(`    not expected: ${result.extra.join(", ")}`);
    if (result.different.length > 0) lines.push(`    different: ${result.different.join(", ")}`);
  }
  for (const reference of report.references) lines.push(`  ${reference.rule}: ${reference.dangling} dangling of ${reference.checked}`);
  return lines;
}

async function main(): Promise<void> {
  requireEnvProxy();
  const args = parseDrillCli(process.argv.slice(2));
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("the drill restores into the local emulator only: run it under `firebase emulators:exec --only auth,firestore` (FIRESTORE_EMULATOR_HOST is not set)");
  const authEmulated = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);

  let source: BackupSource;
  if (args.fromBucket) {
    const { config, problems } = bucketConfig(readTargets(), args.fromBucket, process.env);
    if (!config) throw new Error(problems.join("\n"));
    source = bucketSource(config);
  } else {
    source = directorySource(args.from as string);
  }
  const { identity, recipient } = await readIdentity(args.identity);
  const project = drillProjectId(new Date());
  console.log(`Identity for ${recipient}`);
  console.log(`Source ${source.label}; target ${project} (Firestore emulator${authEmulated ? " and Auth emulator" : ""})`);

  const started = Date.now();
  const plan = await planRestore(source, identity, { until: args.until });
  for (const warning of plan.warnings) console.warn(`Warning: ${warning}`);
  if (plan.parts.length === 0) throw new Error(`no backup part to restore in ${source.label}`);
  console.log(`${plan.parts.length} part(s) from ${plan.dates[0]} to ${plan.dates[plan.dates.length - 1]}; manifests checked for ${plan.verifiedDates.length} of ${plan.dates.length} date(s)`);
  const check = await checkRestore(source, plan, identity);

  const { deleteApp, initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getAuth } = await import("firebase-admin/auth");
  const app = initializeApp({ projectId: project }, "restore-drill");
  let ok = true;
  try {
    const db = getFirestore(app);
    const result = await applyRestore(source, plan, check, identity, db);
    const restoredAt = Date.now();
    console.log(`${result.writes} documents restored in ${result.batches} batch(es).`);

    let authLine = "Firebase Auth: no export in these backups";
    const accounts = await readAuthExport(source, identity, { until: args.until });
    if (accounts && authEmulated) {
      const auth = getAuth(app);
      const imported = await applyAuthRestore(accounts.users, auth as unknown as AuthImportTarget);
      let listed = 0;
      let token: string | undefined;
      do {
        const page = await auth.listUsers(1000, token);
        listed += page.users.length;
        token = page.pageToken;
      } while (token);
      const same = imported.failed.length === 0 && listed === accounts.users.length;
      if (!same) ok = false;
      authLine = `Firebase Auth (${accounts.date}): ${listed}/${accounts.users.length} accounts ${same ? "restored" : "MISSING"}${imported.failed.length > 0 ? `, ${imported.failed.length} refused (${imported.failed.slice(0, 5).map((failure) => failure.uid).join(", ")})` : ""}`;
    } else if (accounts) {
      authLine = `Firebase Auth (${accounts.date}): ${accounts.users.length} accounts decrypted and checked (set FIREBASE_AUTH_EMULATOR_HOST to import them)`;
    }
    const finished = Date.now();

    const report = await verifyRestore(source, plan, check, identity, db);
    if (!report.ok) ok = false;
    console.log("\nComparison with the backup:");
    for (const line of reportLines(report)) console.log(line);
    console.log(authLine);
    console.log(`\nRTO: ${formatDuration(finished - started)} (Firestore ${formatDuration(restoredAt - started)}, on this machine and this emulator)`);
    console.log(report.newestCapture ? `RPO: ${formatDuration(finished - report.newestCapture.getTime())} (newest version captured ${report.newestCapture.toISOString()})` : "RPO: unknown (no update time in the backups)");
    console.log(ok ? "Drill passed." : "Drill FAILED: see the lines above.");
  } finally {
    await deleteApp(app);
  }
  if (!ok) process.exitCode = 1;
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]restore-drill\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`restore-drill: ${redactSecrets((error as Error).message)}`);
    process.exit(1);
  });
}
