// Launch gate (D21, docs/lancement/mise-en-production.md): read-only checks of the production site
// and of the launch records, run after `oracle-vm.ts promote --tag=vX.Y.Z` and before the site
// opens to visitors. Public URLs only (no key, no sign-in), plus files of this repository.
//
//   NODE_USE_ENV_PROXY=1 node scripts/launch-check.ts [--tag=vX.Y.Z] [--site=https://joutiya.ma] [--ads=off|test|live]
//
// Automatic checks (exit code 1 when one fails):
//   - /api/health answers 200 "ok" with the tag's release: production started, so its startup gate
//     passed (legal mentions complete, targets, environment; src/lib/startup/checks.ts);
//   - /api/config: production, the expected ads mode (off until AdSense opens, D23), Turnstile,
//     Google sign-in and Firebase configured;
//   - the home page enforces its CSP (not report-only) and HSTS;
//   - MDN HTTP Observatory grade A or A+ (one public scan, at most one a minute per host);
//   - the restore drill B, the load test and the security audit are recorded.
// Then the items no public URL shows are listed, to confirm by hand.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { requireEnvProxy } from "./env-proxy.ts";

const USAGE = "usage: scripts/launch-check.ts [--tag=vX.Y.Z] [--site=https://joutiya.ma] [--ads=off|test|live]";
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?$/;
const ADS_MODES = ["off", "test", "live"] as const;
const OBSERVATORY = "https://observatory-api.mdn.mozilla.net/api/v2/scan";
const root = fileURLToPath(new URL("..", import.meta.url));

export type AdsMode = (typeof ADS_MODES)[number];

export interface LaunchArgs {
  tag: string | null;
  site: string;
  ads: AdsMode;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** What only a person can confirm: no public URL or repository file shows it. */
export const MANUAL_ITEMS = [
  "Google Auth Platform: the production OAuth app is published (In production), not in Testing",
  "Back office: salesEnabled=false, the Pro launch offer active, no 'Sauvegarde Firestore trop ancienne' alert in the last days",
  "Anti-abuse thresholds and moderation word lists changed or moved to config/ (their committed values are public)",
  "Tarifit catalogue reviewed by a native speaker",
  "Prod Firestore rules and indexes deployed (scripts/deploy-prod.ts firestore)",
  "Repository back to private on the day the site opens to visitors (spec §10)",
] as const;

export function parseLaunchCli(argv: readonly string[]): LaunchArgs {
  let tag: string | null = null;
  let site = "https://joutiya.ma";
  let ads: AdsMode = "off";
  for (const arg of argv) {
    const [name, ...rest] = arg.split("=");
    const value = rest.join("=");
    if (name === "--tag" && RELEASE_TAG.test(value)) tag = value;
    else if (name === "--site" && /^https:\/\/[a-z0-9.-]+$/.test(value)) site = value;
    else if (name === "--ads" && (ADS_MODES as readonly string[]).includes(value)) ads = value as AdsMode;
    else throw new Error(`${arg}: not understood\n${USAGE}`);
  }
  return { tag, site, ads };
}

/** /api/health: 200 "ok" and the release expected (`release`: 12 hex of the tag's commit, or null for any built release). */
export function checkHealth(status: number, body: unknown, release: string | null): Check {
  const report = (body ?? {}) as { status?: unknown; release?: unknown; checks?: Record<string, unknown> };
  const running = typeof report.release === "string" ? report.release : "";
  const failing = Object.entries(report.checks ?? {})
    .filter(([, state]) => state === "fail")
    .map(([name]) => name);
  if (status !== 200 || report.status !== "ok") return { name: "Production health", ok: false, detail: `HTTP ${status}, status ${String(report.status)}${failing.length > 0 ? `, failing: ${failing.join(", ")}` : ""}` };
  if (release !== null && running !== release) return { name: "Production health", ok: false, detail: `runs ${running || "no release"}, the tag is ${release}: promote it first` };
  if (release === null && !/^[0-9a-f]{12}$/.test(running)) return { name: "Production health", ok: false, detail: `runs "${running}", not a CI release` };
  return { name: "Production health", ok: true, detail: `ok, release ${running}` };
}

/** /api/config: production values, as decided for the launch. */
export function checkConfig(status: number, body: unknown, site: string, ads: AdsMode): Check {
  if (status !== 200) return { name: "Production config", ok: false, detail: `HTTP ${status}` };
  const config = (body ?? {}) as { env?: unknown; siteUrl?: unknown; ads?: { mode?: unknown }; turnstileSiteKey?: unknown; googleClientId?: unknown; firebase?: unknown };
  const problems = [
    config.env === "prod" ? null : `env ${String(config.env)}`,
    config.siteUrl === site ? null : `siteUrl ${String(config.siteUrl)}`,
    config.ads?.mode === ads ? null : `ads ${String(config.ads?.mode)} (expected ${ads})`,
    config.turnstileSiteKey ? null : "no Turnstile site key",
    config.googleClientId ? null : "no Google sign-in client",
    config.firebase ? null : "no Firebase config",
  ].filter((problem) => problem !== null);
  return { name: "Production config", ok: problems.length === 0, detail: problems.length === 0 ? `prod, ads ${ads}` : problems.join("; ") };
}

/** Home page headers: an enforced CSP and HSTS. */
export function checkHeaders(status: number, headers: Headers): Check {
  const csp = headers.get("content-security-policy") ?? "";
  const problems = [
    status === 200 ? null : `HTTP ${status}`,
    /default-src|script-src/.test(csp) ? null : headers.has("content-security-policy-report-only") ? "CSP in report-only" : "no CSP",
    headers.has("strict-transport-security") ? null : "no HSTS",
  ].filter((problem) => problem !== null);
  return { name: "Security headers", ok: problems.length === 0, detail: problems.length === 0 ? "CSP enforced, HSTS" : problems.join("; ") };
}

/** One HTTP Observatory v2 answer: grade A or A+. */
export function checkObservatory(body: unknown): Check {
  const scan = (body ?? {}) as { grade?: unknown; score?: unknown; error?: unknown; details_url?: unknown };
  if (scan.error) return { name: "HTTP Observatory", ok: false, detail: `scan error: ${String(scan.error)}` };
  const grade = typeof scan.grade === "string" ? scan.grade : "?";
  return { name: "HTTP Observatory", ok: grade === "A" || grade === "A+", detail: `grade ${grade} (score ${String(scan.score)})${typeof scan.details_url === "string" ? `, ${scan.details_url}` : ""}` };
}

/** The drill B row of docs/backups.md, filled in (a date in its first cell). */
export function drillRecorded(markdown: string): boolean {
  return /^\|\s*\d{4}-\d{2}-\d{2}\s*\|\s*B\s*\|/m.test(markdown);
}

/** Launch records of the repository: restore drill B, load test, security audit. */
export function checkRecords(read: (path: string) => string | null): Check[] {
  const backups = read("docs/backups.md");
  return [
    { name: "Restore drill B recorded", ok: backups !== null && drillRecorded(backups), detail: "docs/backups.md, row B of the drill table" },
    { name: "Load test recorded", ok: read("docs/lancement/charge.md") !== null, detail: "docs/lancement/charge.md (D17)" },
    { name: "Security audit recorded", ok: read("docs/lancement/audit-securite.md") !== null, detail: "docs/lancement/audit-securite.md (D18)" },
  ];
}

/** The 12 hex of the tag's commit, from origin (null when the tag is not there). */
function tagRelease(tag: string): string | null {
  spawnSync("git", ["fetch", "--quiet", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`], { cwd: root, stdio: "ignore" });
  const commit = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], { cwd: root, encoding: "utf8" });
  return commit.status === 0 ? commit.stdout.trim().slice(0, 12) : null;
}

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { ...init, headers: { accept: "application/json", ...init?.headers }, signal: AbortSignal.timeout(60_000) });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An HTML error page: the status says enough.
  }
  return { status: response.status, body };
}

/** Runs a check; a network failure is a failed check, not a crash. */
async function attempt(name: string, check: () => Promise<Check>): Promise<Check> {
  try {
    return await check();
  } catch (error) {
    return { name, ok: false, detail: `request failed (${(error as Error).message})` };
  }
}

async function main(): Promise<void> {
  requireEnvProxy();
  const args = parseLaunchCli(process.argv.slice(2));
  const release = args.tag ? tagRelease(args.tag) : null;
  if (args.tag && release === null) throw new Error(`tag ${args.tag} is not on origin`);
  const host = new URL(args.site).hostname;
  console.log(`Launch check of ${args.site}${args.tag ? ` for ${args.tag} (${release})` : ""}\n`);

  const checks: Check[] = [
    await attempt("Production health", async () => {
      const { status, body } = await getJson(`${args.site}/api/health`, { cache: "no-store" });
      return checkHealth(status, body, release);
    }),
    await attempt("Production config", async () => {
      const { status, body } = await getJson(`${args.site}/api/config`);
      return checkConfig(status, body, args.site, args.ads);
    }),
    await attempt("Security headers", async () => {
      const response = await fetch(`${args.site}/fr`, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
      return checkHeaders(response.status, response.headers);
    }),
    await attempt("HTTP Observatory", async () => checkObservatory((await getJson(`${OBSERVATORY}?host=${encodeURIComponent(host)}`, { method: "POST" })).body)),
    ...checkRecords((path) => {
      const file = `${root}/${path}`;
      return existsSync(file) ? readFileSync(file, "utf8") : null;
    }),
  ];
  for (const check of checks) console.log(`${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`);
  console.log("\nTo confirm by hand:");
  for (const item of MANUAL_ITEMS) console.log(`  [ ] ${item}`);
  const failed = checks.filter((check) => !check.ok).length;
  console.log(failed === 0 ? "\nAutomatic checks passed." : `\n${failed} automatic check(s) failed: the site does not open.`);
  if (failed > 0) process.exitCode = 1;
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]launch-check\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`launch-check: ${(error as Error).message}`);
    process.exit(1);
  });
}
