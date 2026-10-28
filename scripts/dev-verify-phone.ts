// Marks a phone number verified on a test account, in dev and staging only. The WhatsApp inbound
// check (§6) is parked until Meta validates the app, and a Pro application needs a verified
// number (src/lib/pro/service.ts, assertCanApply): this seeds one on the accounts used to test
// the Pro path. Production is refused twice: APP_ENV=prod, and a FIREBASE_PROJECT_ID equal to the
// production project of infra/targets.json whatever APP_ENV says (in production the number is
// verified by WhatsApp, or by a moderator's logged call during the KYBC review). Runs from the
// owner's machine with his own Google credentials (`gcloud auth application-default login`), or
// against the local emulators when FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST are set.
//
//   APP_ENV=staging FIREBASE_PROJECT_ID=<project> node scripts/dev-verify-phone.ts \
//     --email <e-mail> --phone "06 12 34 56 78" [--apply]
//
// FIREBASE_PROJECT_ID must be the project recorded for APP_ENV in infra/targets.json (§9,
// scripts/assert-target.ts); against the emulators APP_ENV defaults to dev and a demo-* project
// passes. Dry run by default: prints the planned steps and exits 0. With --apply, one transaction
// like claimVerifiedPhone (src/lib/phone-verify/accounts.ts, server-only, so re-implemented here):
//   1. getUserByEmail -> uid; users/{uid} must exist and be activated;
//   2. no other account holds the number (one account per number): a seed never takes a number
//      away from another test account, pick another one instead;
//   3. users/{uid}/private/account: phoneE164 and phoneVerifiedAt; users/{uid}: badges.phoneVerified
//      true and updatedAt.
// Nothing from the environment is printed.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertTargets, validateTargets, type Targets } from "./assert-target.ts";

export interface VerifyPhoneArgs {
  email: string;
  /** E.164, +212 6/7 followed by 8 digits. */
  phone: string;
  apply: boolean;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Moroccan mobiles only, as users/{uid}/private/account.phoneE164 is validated (src/lib/db/schemas.ts). */
const MOBILE_E164 = /^\+212[67]\d{8}$/;
const USAGE = "usage: scripts/dev-verify-phone.ts --email <e-mail> --phone <06xxxxxxxx | +2126xxxxxxxx> [--apply]";

/** +212 form of a Moroccan mobile typed as 06…, 07…, 00212… or +212…, with spaces, dots or dashes; null otherwise. */
export function toE164(input: string): string | null {
  const digits = input.replace(/[\s.()-]/g, "");
  const e164 = /^0[67]\d{8}$/.test(digits) ? `+212${digits.slice(1)}` : digits.replace(/^00212/, "+212");
  return MOBILE_E164.test(e164) ? e164 : null;
}

export function parseCli(argv: readonly string[]): VerifyPhoneArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: { email: { type: "string" }, phone: { type: "string" }, apply: { type: "boolean", default: false } },
    strict: true,
  });
  const email = values.email?.trim().toLowerCase() ?? "";
  if (!EMAIL.test(email) || email.length > 254) throw new Error(USAGE);
  const phone = toE164(values.phone ?? "");
  if (!phone) throw new Error(`--phone must be a Moroccan mobile (06 or 07)\n${USAGE}`);
  return { email, phone, apply: values.apply === true };
}

/**
 * Why this environment cannot be seeded: production (by APP_ENV, or by the project id whatever
 * APP_ENV says), or FIREBASE_PROJECT_ID not the project recorded for APP_ENV in infra/targets.json.
 * Empty when dev or staging matches. The configured value is never printed.
 */
export function envProblems(targets: unknown, env: { APP_ENV?: string | undefined; FIREBASE_PROJECT_ID?: string | undefined }): string[] {
  const fileErrors = validateTargets(targets);
  if (fileErrors.length > 0) return fileErrors.map((error) => `infra/targets.json: ${error}`);
  const recorded = targets as Targets;
  const appEnv = env.APP_ENV?.trim();
  if (appEnv === "prod") return ["APP_ENV=prod: this script never runs against production"];
  const prodProject = recorded.environments.prod.firebase.projectId;
  if (prodProject !== null && env.FIREBASE_PROJECT_ID?.trim() === prodProject) {
    return ["FIREBASE_PROJECT_ID is environments.prod.firebase.projectId: this script never runs against production"];
  }
  return assertTargets(recorded, { APP_ENV: appEnv, FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID });
}

export interface AccountState {
  exists: boolean;
  activation?: unknown;
  status?: unknown;
}

/** Why users/{uid} cannot carry a verified number; null when it can. */
export function accountProblem(account: AccountState): string | null {
  if (!account.exists) return "users/<uid> does not exist: the sign-up never completed";
  if (account.activation !== "done") return "the account is not activated (e-mail not verified yet)";
  if (account.status !== "active") return `the account is ${String(account.status)}, not active`;
  return null;
}

/** Why the number cannot be seeded on `uid`: another account holds it. Null when free or already its own. */
export function holderProblem(uid: string, holderUids: readonly string[]): string | null {
  return holderUids.some((holder) => holder !== uid) ? "another account already holds this number: pick another test number" : null;
}

export interface PlanInput {
  args: VerifyPhoneArgs;
  appEnv: string;
  projectId: string;
  emulated: boolean;
}

export function planSteps({ args, appEnv, projectId, emulated }: PlanInput): string[] {
  return [
    `Project ${projectId} (${appEnv}, ${emulated ? "emulators" : "Application Default Credentials"})`,
    `1. Auth account ${args.email}: must exist, with an activated, active users/<uid>`,
    `2. ${args.phone}: refused if another account holds it`,
    `3. users/<uid>/private/account = { phoneE164: ${args.phone}, phoneVerifiedAt: now }; users/<uid> = { badges.phoneVerified: true, updatedAt: now }`,
    "Dry run: nothing changed. Add --apply to run these steps.",
  ];
}

function readTargets(): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL("../infra/targets.json", import.meta.url)), "utf8"));
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is required");
  const emulated = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST);
  if (emulated && !(process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST)) {
    throw new Error("FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST go together");
  }
  const appEnv = process.env.APP_ENV?.trim() || (emulated ? "dev" : "");
  if (!appEnv) throw new Error("APP_ENV is required (dev or staging)");
  const problems = envProblems(readTargets(), { APP_ENV: appEnv, FIREBASE_PROJECT_ID: projectId });
  if (problems.length > 0) throw new Error(problems.join("\n"));
  if (!args.apply) {
    for (const line of planSteps({ args, appEnv, projectId, emulated })) console.log(line);
    return;
  }

  const { applicationDefault, initializeApp } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app = initializeApp({ projectId, ...(emulated ? {} : { credential: applicationDefault() }) });
  const account = await getAuth(app).getUserByEmail(args.email);
  const firestore = getFirestore(app);
  const userRef = firestore.collection("users").doc(account.uid);
  const privateRef = userRef.collection("private").doc("account");
  const now = new Date();

  await firestore.runTransaction(async (tx) => {
    const [user, holders] = await Promise.all([tx.get(userRef), tx.get(firestore.collectionGroup("private").where("phoneE164", "==", args.phone))]);
    const problem = accountProblem({ exists: user.exists, activation: user.get("activation"), status: user.get("status") }) ?? holderProblem(account.uid, holders.docs.map((holder) => holder.ref.parent.parent?.id ?? "").filter((id) => id !== ""));
    if (problem) throw new Error(problem);
    tx.update(privateRef, { phoneE164: args.phone, phoneVerifiedAt: now });
    tx.update(userRef, { "badges.phoneVerified": true, updatedAt: now });
  });
  console.log(`${args.email}: ${args.phone} verified`);
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]dev-verify-phone\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`dev-verify-phone: ${(error as Error).message}`);
    process.exit(1);
  });
}
