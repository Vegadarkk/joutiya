import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CGU_NOTICE_DAYS, LAUNCH_LEGAL_VERSION, LEGAL_TEXTS_FROZEN, LEGAL_VERSIONS } from "@/config/legal-versions";
import { legalTextHashes, planHashes, readHashRecord, staleHashes, textHash } from "../../scripts/legal-hash.ts";

// Versions of the legal pages (D11, audit D-02/D-03): a CGU change after the launch version is
// announced with a summary and at least 30 days of notice (CGU §22.1), and frozen texts never
// change under the same version.

const ROOT = process.cwd();
const read = (file: string): string | null => (existsSync(path.join(ROOT, file)) ? readFileSync(path.join(ROOT, file), "utf8") : null);
const DAY = 86_400_000;

describe("CGU change notice", () => {
  const cgu = LEGAL_VERSIONS.cgu;

  it("announces a CGU change with a summary in French and Arabic and 30 days of notice", () => {
    if (cgu.version === LAUNCH_LEGAL_VERSION) return;
    expect(cgu.announced, "announced: the day the banner and the e-mails start").toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cgu.summary?.fr.length ?? 0).toBeGreaterThan(0);
    expect(cgu.summary?.ar.length).toBe(cgu.summary?.fr.length);
    if (!cgu.urgent) expect(Date.parse(cgu.effective) - Date.parse(cgu.announced!)).toBeGreaterThanOrEqual(CGU_NOTICE_DAYS * DAY);
  });

  it("matches the notice CGU §22.1 promises", () => {
    const text = read("src/content/legal/fr/cgu.md") ?? "";
    expect(text).toContain(`au moins ${CGU_NOTICE_DAYS} jours avant son entrée en vigueur`);
    expect(text).toContain("résument les changements");
  });
});

describe("appeal reviewers in the texts", () => {
  // src/lib/decisions/appeals.ts canReview: another moderator, or an admin, his own decisions included.
  it("say another moderator or an administrator, never only another person", () => {
    for (const language of ["fr", "ar"] as const) {
      const cgu = read(`src/content/legal/${language}/cgu.md`) ?? "";
      expect(cgu).toContain(language === "fr" ? "par un autre modérateur que celui qui a pris la décision, ou par un administrateur" : "مشرفٌ غير الذي اتخذ القرار، أو مدير");
    }
  });
});

describe("text hashes", () => {
  const actual = legalTextHashes(read);

  it("are recorded for the current versions once the texts are frozen", () => {
    if (!LEGAL_TEXTS_FROZEN) return;
    expect(staleHashes(readHashRecord(read), actual, LEGAL_VERSIONS), "a frozen text changed: bump its version (node scripts/legal-hash.ts)").toEqual([]);
  });

  it("refuse a frozen text changed under the same version, unless a correction of form", () => {
    const recorded = Object.fromEntries(Object.entries(actual).map(([slug, hashes]) => [slug, { version: LEGAL_VERSIONS[slug as keyof typeof LEGAL_VERSIONS].version, ...hashes }]));
    const edited = { ...actual, cgu: { ...actual.cgu, fr: textHash("autre texte") } };
    expect(planHashes(recorded, actual, LEGAL_VERSIONS, true, false)).toMatchObject({ changed: [], refused: [] });
    expect(planHashes(recorded, edited, LEGAL_VERSIONS, true, false)).toMatchObject({ changed: ["cgu"], refused: ["cgu"] });
    expect(planHashes(recorded, edited, LEGAL_VERSIONS, true, true).refused).toEqual([]);
    expect(planHashes(recorded, edited, LEGAL_VERSIONS, false, false).refused).toEqual([]);
    const bumped = { ...LEGAL_VERSIONS, cgu: { ...LEGAL_VERSIONS.cgu, version: "1.1" } };
    const plan = planHashes(recorded, edited, bumped, true, false);
    expect(plan).toMatchObject({ changed: ["cgu"], refused: [] });
    expect(plan.next.cgu).toEqual({ version: "1.1", fr: textHash("autre texte"), ar: actual.cgu.ar });
  });

  it("ignore line endings", () => {
    expect(textHash("a\r\nb\r\n")).toBe(textHash("a\nb\n"));
  });
});
