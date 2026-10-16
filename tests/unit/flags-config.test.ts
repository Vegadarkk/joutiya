import { describe, expect, it } from "vitest";
import { DEFAULT_FLAGS, flagsConfigSchema, resolveFlagsConfig } from "@/config/flags";

// config/flags (architecture §5, §10): production-safe defaults, Firestore overrides, invalid
// documents fall back to the defaults.

describe("config/flags", () => {
  it("keeps sales off and Pro applications open by default", () => {
    expect(DEFAULT_FLAGS).toEqual({ salesEnabled: false, proSignupEnabled: true, paymentInstallmentsEnabled: false });
    expect(flagsConfigSchema.safeParse(DEFAULT_FLAGS).success).toBe(true);
  });

  it("applies a stored override over the defaults", () => {
    expect(resolveFlagsConfig({ salesEnabled: true }).config).toEqual({ ...DEFAULT_FLAGS, salesEnabled: true });
    expect(resolveFlagsConfig(undefined).config).toBe(DEFAULT_FLAGS);
  });

  it("rejects unknown or mistyped flags and keeps the defaults", () => {
    const typo = resolveFlagsConfig({ salesEnabled: "yes" });
    expect(typo.config).toBe(DEFAULT_FLAGS);
    expect(typo.errors[0]).toMatch(/^salesEnabled/);
    expect(resolveFlagsConfig({ unknownFlag: true }).errors.length).toBeGreaterThan(0);
  });
});
