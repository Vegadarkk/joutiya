// Writes Firestore `config/legal` of one environment (§7) from a JSON file (infra/legal.json), on
// the machine that holds the CA of scripts/google-wif.ts, with the gcloud sign-in of its `login`
// (own configuration, ~/.joutiya/gcloud): never `gcloud auth application-default login`, which
// would replace the machine-wide credentials of the owner's other projects.
// The file holds only the fields that differ from DEFAULT_LEGAL (src/config/legal.ts), which
// already holds the hosts, e.g. the consumer mediator; the app merges the document over the defaults. Production refuses to start while
// a mention required by art. 1-1 LCEN is missing.
//
//   node scripts/legal-config.ts <staging|prod> <file.json> [--apply]     dry run without --apply

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { missingLegalMentions, resolveLegalConfig, type LegalConfig } from "../src/config/legal.ts";
import { validateTargets, type Targets } from "./assert-target.ts";
import { gcloudAccessToken } from "./google-wif.ts";

export interface LegalPlan {
  config: LegalConfig;
  errors: string[];
  missing: string[];
}

export function planLegal(stored: unknown): LegalPlan {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return { config: resolveLegalConfig(undefined).config, errors: ["the file must hold a JSON object"], missing: [] };
  }
  const { config, errors } = resolveLegalConfig(stored);
  return { config, errors, missing: errors.length > 0 ? [] : missingLegalMentions(config) };
}

/** A JSON value as a Firestore REST value (config/legal holds strings, numbers, booleans, lists, maps). */
export function firestoreValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: value.length === 0 ? {} : { values: value.map(firestoreValue) } };
  if (typeof value === "object") return { mapValue: { fields: firestoreFields(value as Record<string, unknown>) } };
  throw new Error(`cannot store ${typeof value} in Firestore`);
}

export function firestoreFields(object: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, firestoreValue(value)]));
}

async function main(): Promise<void> {
  const [env, file] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const apply = process.argv.includes("--apply");
  if ((env !== "staging" && env !== "prod") || !file) throw new Error("usage: scripts/legal-config.ts <staging|prod> <file.json> [--apply]");

  const raw: unknown = JSON.parse(readFileSync(new URL("../infra/targets.json", import.meta.url), "utf8"));
  const targetErrors = validateTargets(raw);
  if (targetErrors.length > 0) throw new Error(targetErrors.join("\n"));
  const projectId = (raw as Targets).environments[env].firebase.projectId;
  if (!projectId) throw new Error(`environments.${env}.firebase.projectId must be recorded in infra/targets.json first`);

  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const { config, errors, missing } = planLegal(stored);
  if (errors.length > 0) throw new Error(`invalid config/legal:\n  ${errors.join("\n  ")}`);
  console.log(JSON.stringify(config, null, 2));
  if (missing.length > 0) console.warn(`\nMentions still missing (production will not start): ${missing.join(", ")}`);
  if (!apply) {
    console.log(`\nDry run: nothing written. Add --apply to write config/legal in ${projectId}.`);
    return;
  }
  // The whole document, as set() would write it: a PATCH without updateMask replaces every field.
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/config/legal`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: { authorization: `Bearer ${gcloudAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ fields: firestoreFields(stored) }),
  });
  if (!response.ok) throw new Error(`Firestore answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  console.log(`\nconfig/legal written in ${projectId}. The app picks it up within 5 minutes.`);
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]legal-config\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`legal-config: ${(error as Error).message}`);
    process.exit(1);
  });
}
