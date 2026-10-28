import { describe, expect, it } from "vitest";
import { DEFAULT_LEGAL, type LegalConfig } from "@/config/legal";
import { legalAuditReason, legalChanges, legalOverrides, legalUpdateSchema, legalVersion } from "@/lib/legal/admin";

const edit = (patch: Partial<LegalConfig>): LegalConfig => ({ ...DEFAULT_LEGAL, ...patch });

describe("legal admin (D13)", () => {
  it("stores only the fields that differ from the defaults", () => {
    expect(legalOverrides(DEFAULT_LEGAL)).toEqual({});
    const changed = edit({ rcsCity: "Paris", host: { ...DEFAULT_LEGAL.host, phone: "+33 1 00 00 00 00" } });
    expect(legalOverrides(changed)).toEqual({ rcsCity: "Paris", host: changed.host });
  });

  it("lists leaf changes with their paths, list items and emptied lists included", () => {
    const after = edit({
      companyName: "Nouvelle Marque",
      dsaContactLanguages: ["fr"],
      dataHosts: DEFAULT_LEGAL.dataHosts.slice(0, 1),
    });
    const changes = legalChanges(DEFAULT_LEGAL, after);
    expect(changes).toContainEqual({ path: "companyName", before: "Adark Prime", after: "Nouvelle Marque" });
    expect(changes).toContainEqual({ path: "dsaContactLanguages[1]", before: "ar", after: "" });
    expect(changes).toContainEqual({ path: "dataHosts[2].name", before: DEFAULT_LEGAL.dataHosts[2]!.name, after: "" });
    expect(legalChanges(DEFAULT_LEGAL, DEFAULT_LEGAL)).toEqual([]);
    expect(legalChanges(edit({ dataHosts: [] }), DEFAULT_LEGAL)).toContainEqual({ path: "dataHosts", before: "[]", after: "" });
  });

  it("writes the changes in the audit reason within 500 characters", () => {
    expect(legalAuditReason([{ path: "rcsCity", before: "", after: "Paris" }])).toBe('rcsCity: "" → "Paris"');
    const many = Array.from({ length: 40 }, (_, index) => ({ path: `dataHosts[${index}].name`, before: "x".repeat(80), after: "y".repeat(80) }));
    const reason = legalAuditReason(many);
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason).toMatch(/ \(\+\d+\)$/);
    expect(reason).toContain("…");
    const huge = legalAuditReason([{ path: `p${"a".repeat(600)}`, before: "", after: "" }]);
    expect(huge.length).toBeLessThanOrEqual(500);
  });

  it("versions a stored document independently of key order", () => {
    expect(legalVersion(undefined)).toBe("none");
    expect(legalVersion({ a: 1, b: { c: "x", d: [1, 2] } })).toBe(legalVersion({ b: { d: [1, 2], c: "x" }, a: 1 }));
    expect(legalVersion({ a: 1 })).not.toBe(legalVersion({ a: 2 }));
  });

  it("accepts the full schema only: unknown or invalid fields are refused", () => {
    expect(legalUpdateSchema.safeParse({ config: DEFAULT_LEGAL, version: "none" }).success).toBe(true);
    expect(legalUpdateSchema.safeParse({ config: { ...DEFAULT_LEGAL, updatedAt: "x" }, version: "none" }).success).toBe(false);
    expect(legalUpdateSchema.safeParse({ config: { ...DEFAULT_LEGAL, siren: "123" }, version: "none" }).success).toBe(false);
    expect(legalUpdateSchema.safeParse({ config: DEFAULT_LEGAL }).success).toBe(false);
  });
});
