import { describe, expect, it } from "vitest";
import { firestoreFields, planLegal } from "../../scripts/legal-config";

describe("legal-config", () => {
  it("lists the mentions production still needs", () => {
    expect(planLegal({})).toMatchObject({ errors: [], missing: [] });
    const plan = planLegal({ host: { name: "", address: "", phone: "" } });
    expect(plan.errors).toEqual([]);
    expect(plan.missing).toEqual(["host.name", "host.address", "host.phone"]);
  });

  it("accepts the host entity and reports nothing missing once complete", () => {
    const entity = { name: "Hébergeur Exemple SAS", address: "1 rue de l'Exemple, 75000 Paris", phone: "+33 1 00 00 00 00" };
    const plan = planLegal({ host: entity, dataHosts: [{ ...entity, region: "europe-west9, Paris" }] });
    expect(plan.errors).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it("sends the document as Firestore REST values", () => {
    expect(
      firestoreFields({ host: { name: "H", phone: "+33 1" }, dataHosts: [{ name: "D" }], dsaContactLanguages: [], listingTtlDays: 60, ratio: 0.5, open: true, rcsCity: null }),
    ).toEqual({
      host: { mapValue: { fields: { name: { stringValue: "H" }, phone: { stringValue: "+33 1" } } } },
      dataHosts: { arrayValue: { values: [{ mapValue: { fields: { name: { stringValue: "D" } } } }] } },
      dsaContactLanguages: { arrayValue: {} },
      listingTtlDays: { integerValue: "60" },
      ratio: { doubleValue: 0.5 },
      open: { booleanValue: true },
      rcsCity: { nullValue: null },
    });
  });

  it("rejects unknown fields and non-objects", () => {
    expect(planLegal({ updatedAt: "2026-10-13" }).errors.length).toBeGreaterThan(0);
    expect(planLegal([]).errors).toEqual(["the file must hold a JSON object"]);
  });
});
