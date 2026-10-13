import { describe, expect, it } from "vitest";
import { planLegal } from "../../scripts/legal-config";

describe("legal-config", () => {
  it("lists the mentions production still needs", () => {
    const plan = planLegal({});
    expect(plan.errors).toEqual([]);
    expect(plan.missing).toContain("host.name");
  });

  it("accepts the host entity and reports nothing missing once complete", () => {
    const entity = { name: "Hébergeur Exemple SAS", address: "1 rue de l'Exemple, 75000 Paris", phone: "+33 1 00 00 00 00" };
    const plan = planLegal({ host: entity, dataHosts: [{ ...entity, region: "europe-west9, Paris" }] });
    expect(plan.errors).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it("rejects unknown fields and non-objects", () => {
    expect(planLegal({ updatedAt: "2026-10-13" }).errors.length).toBeGreaterThan(0);
    expect(planLegal([]).errors).toEqual(["the file must hold a JSON object"]);
  });
});
