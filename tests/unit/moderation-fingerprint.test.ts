import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { textFingerprint } from "@/lib/moderation/fingerprint";

describe("textFingerprint", () => {
  it("is the sha256 of the normalised title and description", () => {
    const expected = createHash("sha256").update("dacia logan 2019\nlogan 1 5 dci 85 000 km", "utf8").digest("hex");
    expect(textFingerprint("Dacia Logan 2019", "Logan 1.5 dCi, 85 000 km")).toBe(expected);
    expect(textFingerprint("a", "b")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores case, accents, punctuation and spacing, but not words", () => {
    const base = textFingerprint("Vélo électrique", "Très bon état, peu servi.");
    expect(textFingerprint("VELO  ELECTRIQUE", "tres bon etat - peu servi !")).toBe(base);
    expect(textFingerprint("Vélo électrique", "Très bon état, peu servi, facture.")).not.toBe(base);
    expect(textFingerprint("Vélo électrique Très bon état, peu servi.", "")).not.toBe(base);
    expect(textFingerprint("دراجة كهربائية", "حالة جيدة")).toBe(textFingerprint("دراجة  كهربائية", "حالة جيدة."));
  });
});
