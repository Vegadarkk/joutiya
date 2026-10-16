import { describe, expect, it } from "vitest";
import { PERSON_MARKERS, RESTRICTION_MARKERS, SENSITIVE_CATEGORY_IDS, SENSITIVE_VOCABULARY, SENSITIVE_WINDOW } from "@/config/sensitive";
import { normalizeTerm } from "@/lib/moderation/keywords";
import { detectSensitive, detectSensitiveDetailed } from "@/lib/moderation/sensitive";

describe("sensitive config integrity", () => {
  it("uses known category ids, non-empty unique normalised terms, a sane window", () => {
    expect(SENSITIVE_WINDOW).toBeGreaterThanOrEqual(4);
    for (const entry of SENSITIVE_VOCABULARY) {
      expect(SENSITIVE_CATEGORY_IDS).toContain(entry.id);
      const terms = entry.terms.map(normalizeTerm);
      for (const term of terms) expect(term, entry.id).not.toBe("");
      expect(new Set(terms).size, `${entry.id} duplicates`).toBe(terms.length);
    }
    for (const list of [PERSON_MARKERS, RESTRICTION_MARKERS]) {
      const terms = list.map(normalizeTerm);
      expect(new Set(terms).size).toBe(terms.length);
    }
  });
});

describe("detectSensitive: number patterns", () => {
  it("flags identity numbers (CIN / passport shapes) but not units, currency or model numbers", () => {
    expect(detectSensitive("CIN AB123456")).toEqual(["id_number"]);
    expect(detectSensitive("cin: bk 123456")).toEqual(["id_number"]);
    expect(detectSensitive("passeport XY1234567")).toEqual(["id_number"]);
    for (const clean of ["DH 150000", "prix de 150000 dh", "surface de 120000", "2 x 150000", "iPhone A2342", "ref 123456", "an 2015", "Clio 4 2019 95000km"]) {
      expect(detectSensitive(clean), clean).toEqual([]);
    }
  });

  it("flags bank accounts: 24-digit RIB and mod-97-valid IBAN only", () => {
    expect(detectSensitive("RIB 230 810 1234567890123456 78")).toEqual(["bank_account"]);
    expect(detectSensitive("IBAN MA64011519000001205000534921")).toEqual(["bank_account"]);
    expect(detectSensitive("IBAN FR76 3000 6000 0112 3456 7890 189")).toEqual(["bank_account"]);
    expect(detectSensitive("IBAN FR76 3000 6000 0112 3456 7890 180")).toEqual([]);
    expect(detectSensitive("code MA12 ABCD EFGH IJKL")).toEqual([]);
  });

  it("flags card numbers by Luhn and issuer prefix; IMEI and serial numbers stay clean", () => {
    expect(detectSensitive("carte 4539 1488 0343 6467")).toEqual(["card_number"]);
    expect(detectSensitive("visa 4111111111111111 exp 12/27")).toEqual(["card_number"]);
    expect(detectSensitive("amex 378282246310005")).toEqual(["card_number"]);
    expect(detectSensitive("IMEI 356938035643809")).toEqual([]);
    expect(detectSensitive("serial 1234567890123456")).toEqual([]);
    expect(detectSensitive("4539 1488 0343 6468")).toEqual([]);
  });
});

describe("detectSensitive: vocabulary with context", () => {
  it("flags health only near a person (FR, AR, darija)", () => {
    expect(detectSensitive("Fauteuil roulant de ma mère décédée du cancer")).toEqual(["health"]);
    expect(detectSensitive("ma femme est diabétique")).toEqual(["health"]);
    expect(detectSensitive("je suis handicapé, vends mon scooter")).toEqual(["health"]);
    expect(detectSensitive("والدي مريض بالسكري")).toEqual(["health"]);
    expect(detectSensitive("mama mrida")).toEqual(["health"]);
    expect(detectSensitive("khti m3a9a")).toEqual(["health"]);
    expect(detectSensitive("lah yrhmo baba kan mrid")).toEqual(["health"]);
    for (const clean of ["fauteuil roulant électrique", "glucomètre pour diabète", "enceinte JBL de mon frère", "je suis étudiant", "cancer"]) {
      expect(detectSensitive(clean), clean).toEqual([]);
    }
  });

  it("flags religion and politics near a person or a restriction", () => {
    expect(detectSensitive("location pour musulmans uniquement")).toEqual(["religion"]);
    expect(detectSensitive("famille musulmane de préférence")).toEqual(["religion"]);
    expect(detectSensitive("pour chrétiens seulement")).toEqual(["religion"]);
    expect(detectSensitive("tapis de prière musulman")).toEqual([]);
    expect(detectSensitive("chrétien")).toEqual([]);
    expect(detectSensitive("mon frère militant du pjd")).toEqual(["politics"]);
    expect(detectSensitive("polisario")).toEqual(["politics"]);
    expect(detectSensitive("avenue Istiqlal location uniquement familles")).toEqual([]);
  });

  it("flags ethnicity near a person, discriminatory phrases always, product adjectives never", () => {
    expect(detectSensitive("mon mari amazigh")).toEqual(["ethnicity"]);
    expect(detectSensitive("pas d'étrangers")).toEqual(["ethnicity"]);
    expect(detectSensitive("marocains uniquement")).toEqual(["ethnicity"]);
    expect(detectSensitive("للمغاربة فقط")).toEqual(["ethnicity"]);
    expect(detectSensitive("tapis amazigh fait main")).toEqual([]);
    expect(detectSensitive("caftan marocain disponible uniquement en vert")).toEqual([]);
    expect(detectSensitive("canapé noir uniquement")).toEqual([]);
  });

  it("flags sexual orientation vocabulary on its own", () => {
    expect(detectSensitive("gay friendly")).toEqual(["sexual_orientation"]);
    expect(detectSensitive("مثلي")).toEqual(["sexual_orientation"]);
  });

  it("returns unique ids in config order, with one detailed hit per occurrence", () => {
    const text = "je suis gay et ma mère a un cancer, CIN AB123456";
    expect(detectSensitive(text)).toEqual(["id_number", "health", "sexual_orientation"]);
    const detailed = detectSensitiveDetailed("والدي مريض بالسكري");
    expect(detailed).toHaveLength(2);
    for (const hit of detailed) expect(hit.evidence).not.toMatch(/\d/);
    expect(detectSensitive("")).toEqual([]);
  });
});
