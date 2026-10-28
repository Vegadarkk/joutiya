import { describe, expect, it } from "vitest";
import { DEFAULT_FLAGS, flagsConfigSchema, resolveFlagsConfig } from "@/config/flags";

// config/flags (architecture §5, §10): production-safe defaults, Firestore overrides flag by flag,
// invalid or unknown flags reported while the valid ones still apply (an admin closing the Pro
// sign-up is not undone by a typo elsewhere in the document).

describe("config/flags", () => {
  it("keeps sales off and Pro applications open by default", () => {
    expect(DEFAULT_FLAGS).toEqual({ salesEnabled: false, proSignupEnabled: true, paymentInstallmentsEnabled: false, adsMode: "off", adsCmpEea: false });
    expect(flagsConfigSchema.safeParse(DEFAULT_FLAGS).success).toBe(true);
  });

  it("reads the ad mode as one of three values, the defaults for anything else (phase 6, D8)", () => {
    expect(resolveFlagsConfig({ adsMode: "test", adsCmpEea: true }).config).toMatchObject({ adsMode: "test", adsCmpEea: true });
    const invalid = resolveFlagsConfig({ adsMode: "on" });
    expect(invalid.config.adsMode).toBe("off");
    expect(invalid.errors).toHaveLength(1);
  });

  it("applies a stored override over the defaults", () => {
    expect(resolveFlagsConfig({ salesEnabled: true }).config).toEqual({ ...DEFAULT_FLAGS, salesEnabled: true });
    expect(resolveFlagsConfig(undefined).config).toBe(DEFAULT_FLAGS);
    expect(resolveFlagsConfig(null).config).toBe(DEFAULT_FLAGS);
  });

  it("reports a mistyped or unknown flag and keeps the valid ones", () => {
    const typo = resolveFlagsConfig({ salesEnabled: "yes", proSignupEnabled: false });
    expect(typo.config).toEqual({ ...DEFAULT_FLAGS, proSignupEnabled: false });
    expect(typo.errors).toHaveLength(1);
    expect(typo.errors[0]).toMatch(/^salesEnabled/);
    const unknown = resolveFlagsConfig({ unknownFlag: true, proSignupEnabled: false });
    expect(unknown.config.proSignupEnabled).toBe(false);
    expect(unknown.errors).toEqual(["unknownFlag: unknown flag"]);
    expect(resolveFlagsConfig("off")).toEqual({ config: DEFAULT_FLAGS, errors: ["config/flags: not an object"] });
  });

  it("ignores the editing metadata an admin writes next to the flags", () => {
    expect(resolveFlagsConfig({ proSignupEnabled: false, updatedAt: new Date(), updatedBy: "uid-admin" })).toEqual({ config: { ...DEFAULT_FLAGS, proSignupEnabled: false }, errors: [] });
  });
});
