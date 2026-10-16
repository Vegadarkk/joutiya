import "server-only";
import { assertTargets, validateTargets, type Targets } from "../../../scripts/assert-target.ts";
import targets from "../../../infra/targets.json";
import { missingLegalMentions } from "@/config/legal";
import { parseEnv } from "@/lib/env";
import { fetchLegalConfig } from "@/lib/legal/config";
import { logger } from "@/lib/logging/logger";

// Startup gate of `web` and `worker`. Staging and production refuse to start on a wrong
// third-party target (§9), an incomplete environment, a missing CSP hook, or (production web)
// incomplete legal mentions (§7, art. 1-1 LCEN).

export type Service = "web" | "worker";

export interface StartupReport {
  fatal: string[];
  warnings: string[];
}

export async function startupReport(service: Service, env: Record<string, string | undefined> = process.env): Promise<StartupReport> {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const parsed = parseEnv(env);
  const appEnv = parsed.env.APP_ENV;
  // Decided from the raw value: a parse failure falls back to dev defaults and must not demote
  // staging or production to a development server (errors as warnings, strict mode off).
  const rawAppEnv = (env.APP_ENV ?? "").trim();
  const deployed = rawAppEnv !== "" && rawAppEnv !== "dev";

  (deployed ? fatal : warnings).push(...parsed.errors);
  warnings.push(...parsed.warnings);

  const fileErrors = validateTargets(targets);
  if (fileErrors.length > 0) fatal.push(...fileErrors.map((error) => `infra/targets.json: ${error}`));
  else fatal.push(...assertTargets(targets as Targets, env, { strict: deployed }));

  if (service === "web" && deployed && !(globalThis as { __joutiyaCspHashHook?: boolean }).__joutiyaCspHashHook) {
    fatal.push("CSP hash hook not loaded: start with `node --import ./dist/server/csp-hash-hook.mjs server.js`");
  }

  if (service === "web" && deployed && fatal.length === 0) {
    try {
      const { config, errors } = await fetchLegalConfig();
      const missing = missingLegalMentions(config).map((field) => `config/legal.${field} is required (art. 1-1 LCEN)`);
      const problems = [...errors.map((error) => `config/legal invalid: ${error}`), ...missing];
      (appEnv === "prod" ? fatal : warnings).push(...problems);
    } catch (error) {
      (appEnv === "prod" ? fatal : warnings).push(`config/legal unreadable: ${(error as Error).message}`);
    }
  }
  return { fatal, warnings };
}

/** Logs the report and exits on any fatal problem. */
export async function runStartupChecks(service: Service): Promise<void> {
  const { fatal, warnings } = await startupReport(service);
  for (const warning of warnings) logger.warn({ service }, `startup: ${warning}`);
  if (fatal.length > 0) {
    for (const problem of fatal) logger.fatal({ service }, `startup: ${problem}`);
    // Give pino a tick to flush before exiting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.exit(1);
  }
  logger.info({ service }, "startup checks passed");
}
