import { describe, expect, it } from "vitest";
import { LOCALES } from "@/config/site";
import {
  GUIDE_PROCEDURE_IDS,
  GUIDE_RUBRICS,
  GUIDE_SOURCE_IDS,
  GUIDE_SOURCES,
  guideRubricPage,
  OFFICIAL_HOSTS,
  rubricForCategory,
  validateGuide,
  type GuideLocaleContent,
} from "@/content/guide";
import { GUIDE_AR } from "@/content/guide/ar";
import { GUIDE_FR } from "@/content/guide/fr";
import { GUIDE_RIF } from "@/content/guide/rif";

// Admin procedures guide (design guide-demarches G1-G2): complete in every locale, links only to the
// closed list of official hosts, no address or file in a text, every source used.

const CONTENT = { fr: GUIDE_FR, ar: GUIDE_AR, rif: GUIDE_RIF };

describe("guide corpus", () => {
  it("validates: official https hosts only, every text in fr, ar and rif, every source used", () => {
    expect(validateGuide()).toEqual([]);
    for (const locale of LOCALES) {
      expect(Object.keys(CONTENT[locale].procedures).sort()).toEqual([...GUIDE_PROCEDURE_IDS].sort());
      expect(Object.keys(CONTENT[locale].sources).sort()).toEqual([...GUIDE_SOURCE_IDS].sort());
    }
    for (const host of Object.keys(OFFICIAL_HOSTS)) expect(host).toMatch(/(?:^|\.)(?:gov\.)?ma$/);
  });

  it("refuses an http link, a foreign host, a file, an address in a text and an unused source", () => {
    const sources = {
      ...GUIDE_SOURCES,
      "dgi-teleservices": { ...GUIDE_SOURCES["dgi-teleservices"], url: "http://www.tax.gov.ma/wps/portal/DGI/Teleservices" },
      ancfcc: { ...GUIDE_SOURCES.ancfcc, url: "https://ancfcc-maroc.com/" },
      "ancfcc-tarifs": { ...GUIDE_SOURCES["ancfcc-tarifs"], url: "https://www.ancfcc.gov.ma/formulaire.pdf" },
      extra: { url: "https://www.onousc.ma/autre", reviewedAt: "2026-10-28" },
    };
    const fr: GuideLocaleContent = { ...GUIDE_FR, procedures: { ...GUIDE_FR.procedures, massar: { title: "Massar", body: ["Allez sur massar.men.gov.ma pour vos notes."] } } };
    const problems = validateGuide({ fr, ar: GUIDE_AR, rif: GUIDE_RIF }, sources);
    expect(problems).toEqual(
      expect.arrayContaining([
        "source dgi-teleservices: not https",
        "source ancfcc: host ancfcc-maroc.com is not in OFFICIAL_HOSTS",
        "source ancfcc: host ancfcc-maroc.com is not a .ma host",
        "source ancfcc-tarifs: links a file, link the official page that lists it",
        "source extra: unused",
        "fr/procedure massar: a text holds an address; link a source instead",
      ]),
    );
  });

  it("fills the brand, dates a rubric by its latest reviewed source, maps categories", () => {
    const page = guideRubricPage("fr", "auto-entrepreneur");
    expect(page.intro).not.toContain("{brand}");
    expect(page.intro).toContain("Aalan");
    expect(page.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const rubric of GUIDE_RUBRICS) expect(guideRubricPage("ar", rubric).procedures.length).toBeGreaterThan(0);
    expect(rubricForCategory("vehicules")).toBe("vehicule");
    expect(rubricForCategory("immobilier")).toBe("immobilier");
    expect(rubricForCategory("mode")).toBeUndefined();
  });
});
