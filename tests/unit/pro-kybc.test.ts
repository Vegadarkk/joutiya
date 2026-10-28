import { describe, expect, it } from "vitest";
import { REQUIRED_IDENTIFIERS, iceFormatOk, normalizeIdentifier, proLegalSchema } from "@/lib/pro/kybc";

// KYBC identifiers per legal form (architecture §8): ICE format, required fields, normalisation.

const ICE = "001234567000089";

describe("ICE", () => {
  it("accepts 15 digits typed with spaces, dots or dashes", () => {
    expect(iceFormatOk(ICE)).toBe(true);
    expect(iceFormatOk("001 234 567 000 089")).toBe(true);
    expect(iceFormatOk("001.234.567-000.089")).toBe(true);
    expect(normalizeIdentifier(" 001 234 567 000 089 ")).toBe(ICE);
  });

  it("rejects other lengths and letters", () => {
    for (const bad of ["00123456700008", "0012345670000890", "00123456700008A", ""]) expect(iceFormatOk(bad)).toBe(false);
  });
});

describe("legal identifiers per form", () => {
  it("lists the required identifiers of §8", () => {
    expect(REQUIRED_IDENTIFIERS).toEqual({ societe: ["ice", "rc", "if"], auto_entrepreneur: ["ice", "aeNumber"], commercant: ["ice"] });
  });

  it("parses a company and normalises its identifiers", () => {
    const parsed = proLegalSchema.parse({ form: "societe", ice: "001 234 567 000 089", rc: "12345 / casa", if: "1234567" });
    expect(parsed).toEqual({ form: "societe", ice: ICE, rc: "12345/CASA", if: "1234567" });
  });

  it("requires every identifier of a company and of an auto-entrepreneur", () => {
    expect(proLegalSchema.safeParse({ form: "societe", ice: ICE, rc: "12345" }).success).toBe(false);
    expect(proLegalSchema.safeParse({ form: "auto_entrepreneur", ice: ICE }).success).toBe(false);
    expect(proLegalSchema.safeParse({ form: "auto_entrepreneur", ice: ICE, aeNumber: "998877" }).success).toBe(true);
  });

  it("requires RC or taxe professionnelle for a sole trader", () => {
    expect(proLegalSchema.safeParse({ form: "commercant", ice: ICE }).success).toBe(false);
    expect(proLegalSchema.safeParse({ form: "commercant", ice: ICE, tp: "55443322" }).success).toBe(true);
    expect(proLegalSchema.safeParse({ form: "commercant", ice: ICE, rc: "777" }).success).toBe(true);
  });

  it("rejects a bad ICE, unknown fields and odd characters", () => {
    expect(proLegalSchema.safeParse({ form: "auto_entrepreneur", ice: "123", aeNumber: "1" }).success).toBe(false);
    expect(proLegalSchema.safeParse({ form: "auto_entrepreneur", ice: ICE, aeNumber: "1", extra: "x" }).success).toBe(false);
    expect(proLegalSchema.safeParse({ form: "auto_entrepreneur", ice: ICE, aeNumber: "<script>" }).success).toBe(false);
  });
});
