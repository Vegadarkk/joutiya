import "server-only";
import { assertTargets, validateTargets, type Targets } from "../../../scripts/assert-target.ts";
import targets from "../../../infra/targets.json";
import { missingLegalMentions } from "@/config/legal";
import { parseEnv } from "@/lib/env";
import { fetchLegalConfig } from "@/lib/legal/config";
import { logger } from "@/lib/logging/logger";

// Startup gate of `web` and `worker`. Staging and production refuse to start on a wrong
// third-party target (§9), an incomplete environment, a missing CSP hook, or (production web)
// incomplete legal mentions (§7, art. 1-1 LCEN). A development server refuses to serve anything
// but a local host: APP_ENV=dev enables the x-dev-access-email bypass and skips every deployed check.

export type Service = "web" | "worker";

export interface StartupReport {
  fatal: string[];
  warnings: string[];
}

/** localhost, *.localhost, loopback or a private RFC 1918 address: the only hosts APP_ENV=dev may serve. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "::1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function siteHost(siteUrl: string | undefined): string | undefined {
  const value = (siteUrl ?? "").trim();
  if (!value) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    // Already reported by parseEnv.
    return undefined;
  }
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

  const host = siteHost(env.SITE_URL);
  if (!deployed && host !== undefined && !isLocalHost(host)) {
    fatal.push(
      `APP_ENV=dev serves local hosts only, not SITE_URL host ${host}: set APP_ENV=staging or APP_ENV=prod (dev enables the x-dev-access-email bypass and skips the deployed checks)`,
    );
  }

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
