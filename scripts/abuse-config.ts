// Writes Firestore `config/abuse` of one environment (spec §10 launch item: private anti-abuse values,
// since the committed ones are public) from a local JSON file kept outside the repository, with the
// gcloud sign-in of scripts/google-wif.ts `login` (as scripts/legal-config.ts). The file holds only
// the sections that differ from DEFAULT_ABUSE (src/config/abuse.ts): risk thresholds and weights,
// extra prohibited terms by group, extra message keywords, rate-limit overrides by id. The whole
// document is replaced. The terms are never printed: the plan shows counts.
//
//   node scripts/abuse-config.ts <staging|prod> <file.json> [--apply]     dry run without --apply

import { readFileSync, realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAbuseConfig, type AbuseConfig } from "../src/config/abuse.ts";
import { validateTargets, type Targets } from "./assert-target.ts";
import { requireEnvProxy } from "./env-proxy.ts";
import { firestoreFields } from "./firestore-rest.ts";
import { gcloudAccessToken } from "./google-wif.ts";

export interface AbusePlan {
  config: AbuseConfig;
  errors: string[];
  /** What the document changes, without any term. */
  summary: string[];
}

export function planAbuse(stored: unknown): AbusePlan {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return { config: resolveAbuseConfig(undefined).config, errors: ["the file must hold a JSON object"], summary: [] };
  }
  const { config, errors } = resolveAbuseConfig(stored);
  const summary: string[] = [];
  const { weights, ...thresholds } = config.risk;
  summary.push(`risk: ${Object.entries(thresholds).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  const weighted = Object.entries(weights);
  if (weighted.length > 0) summary.push(`risk weights: ${weighted.map(([flag, weight]) => `${flag}=${weight}`).join(", ")}`);
  for (const [group, terms] of Object.entries(config.prohibited)) summary.push(`prohibited ${group}: +${terms?.hard?.length ?? 0} hard, +${terms?.soft?.length ?? 0} soft`);
  summary.push(`messaging: +${config.messaging.paymentKeywords.length} payment, +${config.messaging.contactAppKeywords.length} contact-app keywords`);
  for (const [id, override] of Object.entries(config.rateLimits)) summary.push(`rate limit ${id}: ${JSON.stringify(override)}`);
  return { config, errors, summary };
}

/** The private values stay out of Git: a file inside the repository is refused, ignored or not. */
export function insideRepository(file: string, root: string): boolean {
  const path = relative(root, file);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function main(): Promise<void> {
  requireEnvProxy();
  const [env, file] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const apply = process.argv.includes("--apply");
  if ((env !== "staging" && env !== "prod") || !file) throw new Error("usage: scripts/abuse-config.ts <staging|prod> <file.json> [--apply]");
  const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  if (insideRepository(realpathSync(file), root)) throw new Error("keep the file outside the repository (e.g. ~/.joutiya/abuse-prod.json): its values are private");

  const raw: unknown = JSON.parse(readFileSync(new URL("../infra/targets.json", import.meta.url), "utf8"));
  const targetErrors = validateTargets(raw);
  if (targetErrors.length > 0) throw new Error(targetErrors.join("\n"));
  const projectId = (raw as Targets).environments[env].firebase.projectId;
  if (!projectId) throw new Error(`environments.${env}.firebase.projectId must be recorded in infra/targets.json first`);

  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const { errors, summary } = planAbuse(stored);
  if (errors.length > 0) throw new Error(`invalid config/abuse:\n  ${errors.join("\n  ")}`);
  console.log(summary.join("\n"));
  if (!apply) {
    console.log(`\nDry run: nothing written. Add --apply to write config/abuse in ${projectId}.`);
    return;
  }
  // The whole document, as set() would write it: a PATCH without updateMask replaces every field.
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/config/abuse`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: { authorization: `Bearer ${gcloudAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ fields: firestoreFields(stored) }),
  });
  // The answer echoes the document: only the status is shown.
  if (!response.ok) throw new Error(`Firestore answered HTTP ${response.status}`);
  console.log(`\nconfig/abuse written in ${projectId}. The app picks it up within 5 minutes.`);
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]abuse-config\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`abuse-config: ${(error as Error).message}`);
    process.exit(1);
  });
}
