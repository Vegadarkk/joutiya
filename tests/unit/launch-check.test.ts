import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { checkConfig, checkHeaders, checkHealth, checkLegal, checkObservatory, checkRecords, drillRecorded, MANUAL_ITEMS, parseLaunchCli, type LegalState } from "../../scripts/launch-check.ts";

// scripts/launch-check.ts (D21): what each public answer must say before the site opens.

const SITE = "https://joutiya.ma";

describe("parseLaunchCli", () => {
  it("defaults to the production site with ads off", () => {
    const now = new Date("2026-12-01T23:30:00Z");
    expect(parseLaunchCli([], now)).toEqual({ tag: null, site: SITE, ads: "off", opening: "2026-12-01" });
    expect(parseLaunchCli(["--tag=v1.0.0", "--site=https://staging.joutiya.ma", "--ads=test", "--opening=2026-12-03"], now)).toEqual({ tag: "v1.0.0", site: "https://staging.joutiya.ma", ads: "test", opening: "2026-12-03" });
  });

  it("refuses anything else", () => {
    for (const arg of ["--tag=1.0.0", "--site=http://joutiya.ma", "--site=https://joutiya.ma/fr", "--ads=on", "--apply", "--opening=2026-13-45", "--opening=1er décembre"]) expect(() => parseLaunchCli([arg])).toThrow(/not understood/);
  });
});

describe("checkHealth", () => {
  it("passes when production is up on the tag's release", () => {
    expect(checkHealth(200, { status: "ok", release: "0123456789ab" }, "0123456789ab")).toMatchObject({ ok: true });
    expect(checkHealth(200, { status: "ok", release: "0123456789ab" }, null)).toMatchObject({ ok: true });
  });

  it("names what is wrong", () => {
    expect(checkHealth(503, { status: "degraded", checks: { worker: "fail", valkeyQueue: "ok" } }, null).detail).toBe("HTTP 503, status degraded, failing: worker");
    expect(checkHealth(200, { status: "ok", release: "fedcba987654" }, "0123456789ab").detail).toMatch(/runs fedcba987654, the tag is 0123456789ab/);
    expect(checkHealth(200, { status: "ok", release: "dev" }, null)).toMatchObject({ ok: false });
    expect(checkHealth(502, null, null)).toMatchObject({ ok: false });
  });
});

describe("checkConfig", () => {
  const config = { env: "prod", siteUrl: SITE, ads: { mode: "off" }, turnstileSiteKey: "0x4AAA", googleClientId: "123.apps.googleusercontent.com", firebase: { projectId: "joutiya-prod" } };

  it("passes with the launch values", () => {
    expect(checkConfig(200, config, SITE, "off")).toMatchObject({ ok: true });
  });

  it("lists every difference", () => {
    expect(checkConfig(200, { ...config, env: "staging", ads: { mode: "test" }, googleClientId: null }, SITE, "off").detail).toBe("env staging; ads test (expected off); no Google sign-in client");
    expect(checkConfig(200, null, SITE, "off")).toMatchObject({ ok: false });
    expect(checkConfig(530, null, SITE, "off").detail).toBe("HTTP 530");
  });
});

describe("checkHeaders", () => {
  it("wants an enforced CSP and HSTS", () => {
    expect(checkHeaders(200, new Headers({ "content-security-policy": "default-src 'self'", "strict-transport-security": "max-age=63072000" }))).toMatchObject({ ok: true });
    expect(checkHeaders(200, new Headers({ "content-security-policy-report-only": "default-src 'self'", "strict-transport-security": "max-age=1" })).detail).toBe("CSP in report-only");
    expect(checkHeaders(302, new Headers()).detail).toBe("HTTP 302; no CSP; no HSTS");
  });
});

describe("checkObservatory", () => {
  it("passes A and A+ only", () => {
    expect(checkObservatory({ grade: "A+", score: 110, error: null })).toMatchObject({ ok: true });
    expect(checkObservatory({ grade: "A", score: 90, error: null })).toMatchObject({ ok: true });
    expect(checkObservatory({ grade: "A-", score: 85, error: null })).toMatchObject({ ok: false });
    expect(checkObservatory({ error: "site down" })).toMatchObject({ ok: false, detail: "scan error: site down" });
  });
});

describe("launch records", () => {
  it("finds a filled drill B row", () => {
    expect(drillRecorded("| | B | prod -> `joutiya-staging` | | |")).toBe(false);
    expect(drillRecorded("| 2026-11-20 | B | prod -> `joutiya-staging` | 2 nuits | 14 |")).toBe(true);
    expect(drillRecorded("| 2026-11-20 | A | staging -> émulateur | |")).toBe(false);
  });

  it("checks the three records", () => {
    const files: Record<string, string> = { "docs/backups.md": "| 2026-11-20 | B | x |", "docs/lancement/charge.md": "# Charge" };
    expect(checkRecords((path) => files[path] ?? null).map((check) => check.ok)).toEqual([true, true, false]);
  });

  it("the repository's own docs/backups.md has its drill table, not yet filled", async () => {
    const { readFileSync } = await import("node:fs");
    const markdown = readFileSync(new URL("../../docs/backups.md", import.meta.url), "utf8");
    expect(markdown).toMatch(/^\| \| B \|/m);
    expect(drillRecorded(markdown)).toBe(false);
  });
});

describe("legal reset", () => {
  const hashes = { fr: "f", ar: "a" };
  function state(overrides: Partial<LegalState> = {}): LegalState {
    return {
      versions: { cgu: { version: "1.0", effective: "2026-12-01" }, cookies: { version: "1.0", effective: "2026-12-01" }, cgv: { version: "0.3", effective: "2026-11-20" } },
      provisional: new Set(["cgv"]),
      frozen: true,
      recorded: { cgu: { version: "1.0", ...hashes }, cookies: { version: "1.0", ...hashes }, cgv: { version: "0.3", ...hashes } },
      actual: { cgu: hashes, cookies: hashes, cgv: hashes },
      ...overrides,
    };
  }

  it("passes when every page is at 1.0 from the opening day, frozen and hashed (provisional pages aside)", () => {
    expect(checkLegal(state(), "2026-12-01")).toMatchObject({ ok: true, detail: "2 pages at 1.0 from 2026-12-01, texts frozen" });
  });

  it("names what is not reset", () => {
    const bumped = state({ versions: { ...state().versions, cgu: { version: "1.2", effective: "2026-10-28" } }, frozen: false, recorded: null });
    const check = checkLegal(bumped, "2026-12-01");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("not at 1.0: cgu 1.2");
    expect(check.detail).toContain("not in force on 2026-12-01: cgu 2026-10-28");
    expect(check.detail).toContain("LEGAL_TEXTS_FROZEN is false");
    expect(check.detail).toContain("hashes not recorded (node scripts/legal-hash.ts --apply): cgu, cookies, cgv");
    expect(checkLegal(state({ actual: { ...state().actual, cookies: { fr: "changed", ar: "a" } } }), "2026-12-01").detail).toBe("hashes not recorded (node scripts/legal-hash.ts --apply): cookies");
  });

  it("lists the load-test bypass removal among the manual items", () => {
    expect(MANUAL_ITEMS.some((item) => item.includes("loadtest --off") && item.includes("LOADTEST_BYPASS_SECRET") && item.includes("LOAD_TEST_ENABLED"))).toBe(true);
  });
});

describe("plain Node", () => {
  it("refuses unknown arguments before any request", async () => {
    const failure = await promisify(execFile)(process.execPath, ["scripts/launch-check.ts", "--apply"], { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" } }).catch((error: { stderr: string }) => error);
    expect((failure as { stderr: string }).stderr).toContain("--apply: not understood");
  });
});
