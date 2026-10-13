import { describe, expect, it } from "vitest";
import { DEFAULT_LEGAL, missingLegalMentions, publisherIdentity, resolveLegalConfig, vatMention, type LegalConfig } from "@/config/legal";
import { LEGAL_PAGES } from "@/config/legal-pages";
import { fill, LEGAL_TEXTS, type LegalValues } from "@/content/legal/fr";
import { legalValues, mentionsText } from "@/content/legal/mentions";

const complete: LegalConfig = {
  ...DEFAULT_LEGAL,
  host: { name: "Oracle France SAS", address: "Paris", phone: "+33 1 00 00 00 00" },
  dataHosts: DEFAULT_LEGAL.dataHosts.map((host) => ({ ...host, address: host.address || "Dublin", phone: host.phone || "+353 1 000 0000" })),
};

describe("config/legal", () => {
  it("defaults to the EI publisher with the Paris domiciliation only", () => {
    expect(DEFAULT_LEGAL.legalForm).toBe("EI");
    expect(DEFAULT_LEGAL.hqAddress).toBe("6 rue d'Armaillé, 75017 Paris");
  });

  it("reports the host fields still missing in the defaults", () => {
    expect(missingLegalMentions(DEFAULT_LEGAL)).toEqual(["host.name", "host.address", "host.phone", "dataHosts[0].address", "dataHosts[0].phone"]);
    expect(missingLegalMentions(complete)).toEqual([]);
  });

  it("requires capital and RCS city for a company", () => {
    const company: LegalConfig = { ...complete, legalForm: "SASU", shareCapital: "", rcsCity: "" };
    expect(missingLegalMentions(company)).toEqual(["shareCapital", "rcsCity"]);
  });

  it("requires a VAT number once liable", () => {
    expect(missingLegalMentions({ ...complete, vatRegime: "assujetti", vatNumber: "" })).toEqual(["vatNumber"]);
  });

  it("renders the publisher by legal form", () => {
    expect(publisherIdentity(DEFAULT_LEGAL)).toBe("Adil DARKAOUI DAHMANI, entrepreneur individuel (EI), nom commercial Adark Prime");
    expect(publisherIdentity({ ...complete, legalForm: "SASU", shareCapital: "1 000", rcsCity: "Paris" })).toBe(
      "Adark Prime, SASU au capital de 1 000 €, RCS Paris 947788303",
    );
    expect(vatMention(DEFAULT_LEGAL)).toBe("TVA non applicable, article 293 B du CGI");
    expect(vatMention({ ...DEFAULT_LEGAL, vatRegime: "assujetti" })).toBe("TVA intracommunautaire : FR41947788303");
  });

  it("merges the stored document over the defaults and rejects unknown or invalid fields", () => {
    expect(resolveLegalConfig(undefined)).toEqual({ config: DEFAULT_LEGAL, errors: [] });
    expect(resolveLegalConfig({ phone: "+33 1 23" }).config.phone).toBe("+33 1 23");
    const unknown = resolveLegalConfig({ personalAddress: "x" });
    expect(unknown.config).toBe(DEFAULT_LEGAL);
    expect(unknown.errors.length).toBeGreaterThan(0);
    expect(resolveLegalConfig({ siren: "123" }).errors[0]).toMatch(/^siren/);
  });
});

describe("legal pages", () => {
  it("has a text for every page except the generated mentions", () => {
    const slugs = LEGAL_PAGES.map((page) => page.slug).filter((slug) => slug !== "mentions-legales");
    expect(Object.keys(LEGAL_TEXTS).sort()).toEqual([...slugs].sort());
    expect(LEGAL_PAGES.filter((page) => page.column === "legal")).toHaveLength(9);
  });

  it("only uses known placeholders", () => {
    const values = legalValues(DEFAULT_LEGAL);
    const known = new Set(Object.keys(values));
    for (const text of Object.values(LEGAL_TEXTS)) {
      const strings = [text.intro ?? "", ...text.sections.flatMap((section) => section.blocks.flatMap((block) => (typeof block === "string" ? [block] : block.list)))];
      for (const value of strings) {
        for (const [, key] of value.matchAll(/\{(\w+)\}/g)) expect(known, `unknown placeholder {${key}}`).toContain(key);
      }
    }
  });

  it("fills placeholders and leaves unknown ones visible", () => {
    const values = { publisher: "Adark Prime" } as LegalValues;
    expect(fill("{publisher} {nope}", values)).toBe("Adark Prime {nope}");
  });

  it("never renders an address other than the domiciliation for the publisher", () => {
    const text = JSON.stringify(mentionsText(complete, "2026-10-13"));
    expect(text).toContain("6 rue d'Armaillé, 75017 Paris");
    expect(text).toContain("Oracle France SAS");
  });
});
