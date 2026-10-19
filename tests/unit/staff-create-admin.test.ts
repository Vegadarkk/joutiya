import { describe, expect, it } from "vitest";
import targets from "../../infra/targets.json";
import type { Targets } from "../../scripts/assert-target";
import { adminOrigin, existingAccountProblem, oobCodeOf, parseCli, planSteps, projectErrors, resolveSettings, setPasswordUrl } from "../../scripts/create-admin";

/** What resolveSettings throws for an environment, or "" when it does not (the message never names a value). */
function settingsError(env: Record<string, string | undefined>, registry: unknown = targets): string {
  try {
    resolveSettings(env, registry);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("create-admin", () => {
  it("derives the admin origin like expectedOrigin('admin')", () => {
    expect(adminOrigin("http://localhost:3000", "admin.localhost")).toBe("http://admin.localhost:3000");
    expect(adminOrigin("https://joutiya.ma", "admin.joutiya.ma")).toBe("https://admin.joutiya.ma");
    expect(adminOrigin("https://staging.joutiya.ma", " ADMIN-staging.joutiya.ma. ")).toBe("https://admin-staging.joutiya.ma");
    expect(adminOrigin("https://joutiya.ma", undefined)).toBe("https://joutiya.ma");
  });

  it("builds the set-password URL on our own page with the encoded code", () => {
    expect(setPasswordUrl("https://admin.joutiya.ma", "ab/c+d")).toBe("https://admin.joutiya.ma/connexion?mode=setPassword&oobCode=ab%2Fc%2Bd");
    expect(oobCodeOf("http://127.0.0.1:9099/emulator/action?mode=resetPassword&oobCode=XyZ123&apiKey=fake")).toBe("XyZ123");
    expect(() => oobCodeOf("https://example.com/?mode=resetPassword")).toThrow(/oobCode/);
  });

  it("parses the CLI, lower-cases the e-mail and defaults to a dry run", () => {
    expect(parseCli(["--email", "Owner@Joutiya.MA", "--name", " Adark "])).toEqual({ email: "owner@joutiya.ma", name: "Adark", apply: false });
    expect(parseCli(["--email", "a@b.co", "--name", "Ab", "--apply"]).apply).toBe(true);
    expect(() => parseCli(["--name", "Adark"])).toThrow(/usage/);
    expect(() => parseCli(["--email", "nope", "--name", "Adark"])).toThrow(/usage/);
    expect(() => parseCli(["--email", "a@b.co", "--name", "A"])).toThrow(/2 to 40/);
    expect(() => parseCli(["--email", "a@b.co", "--name", "Ab", "--force"])).toThrow();
  });

  it("plans the steps without touching anything, roster before claims", () => {
    const lines = planSteps({ args: { email: "a@b.co", name: "Ab", apply: false }, projectId: "joutiya-dev", origin: "http://admin.localhost:3000", emulated: true });
    expect(lines[0]).toContain("joutiya-dev");
    expect(lines.join("\n")).toContain("--apply");
    expect(lines.join("\n")).toContain("http://admin.localhost:3000/connexion?mode=setPassword&oobCode=");
    expect(lines.findIndex((line) => line.startsWith("2. staff/<uid>"))).toBeLessThan(lines.findIndex((line) => line.startsWith("3. Custom claims")));
  });

  it("checks FIREBASE_PROJECT_ID against infra/targets.json for APP_ENV", () => {
    // A demo project passes in dev only (the emulators never reach Google for it).
    expect(projectErrors(targets, { APP_ENV: "dev", FIREBASE_PROJECT_ID: "demo-joutiya" })).toEqual([]);
    expect(projectErrors(targets, { APP_ENV: "prod", FIREBASE_PROJECT_ID: "demo-joutiya" })).toHaveLength(1);
    // Without APP_ENV the project cannot be looked up; the configured value is never printed.
    const noEnv = projectErrors(targets, { FIREBASE_PROJECT_ID: "joutiya-prod-1234" });
    expect(noEnv).toEqual(["APP_ENV is required when FIREBASE_PROJECT_ID is set"]);
    expect(projectErrors(targets, { APP_ENV: "production", FIREBASE_PROJECT_ID: "joutiya-prod-1234" })[0]).toMatch(/^APP_ENV must be one of/);
    // A project the targets file does not record (or records differently) is refused.
    const mismatch = projectErrors(targets, { APP_ENV: "prod", FIREBASE_PROJECT_ID: "joutiya-prod-1234" });
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toMatch(/^FIREBASE_PROJECT_ID (is set but|does not match) environments\.prod\.firebase\.projectId/);
    expect(mismatch[0]).not.toContain("joutiya-prod-1234");
    expect(projectErrors({ shared: {} }, { APP_ENV: "dev", FIREBASE_PROJECT_ID: "demo-joutiya" })[0]).toMatch(/^infra\/targets\.json: /);
  });

  it("takes the project and the hosts of staging and prod from infra/targets.json, like the VM does", () => {
    const prodProject = targets.environments.prod.firebase.projectId;
    expect(resolveSettings({ APP_ENV: "prod" }, targets)).toEqual({ projectId: prodProject, origin: "https://admin.joutiya.ma", emulated: false });
    expect(resolveSettings({ APP_ENV: "staging" }, targets)).toEqual({ projectId: targets.environments.staging.firebase.projectId, origin: "https://admin-staging.joutiya.ma", emulated: false });
    // Set by hand, the project must still be the recorded one; a wrong value is refused without being printed.
    expect(resolveSettings({ APP_ENV: "prod", FIREBASE_PROJECT_ID: prodProject }, targets).projectId).toBe(prodProject);
    const mismatch = settingsError({ APP_ENV: "prod", FIREBASE_PROJECT_ID: "joutiya-prod-1234" });
    expect(mismatch).toMatch(/^FIREBASE_PROJECT_ID (is set but|does not match) environments\.prod\.firebase\.projectId/);
    expect(mismatch).not.toContain("joutiya-prod-1234");
    // Hosts set on purpose are kept; a dev .env.local loaded by mistake never yields a localhost link.
    expect(resolveSettings({ APP_ENV: "staging", SITE_URL: "https://staging.joutiya.ma", ADMIN_HOST: "admin-staging.joutiya.ma" }, targets).origin).toBe("https://admin-staging.joutiya.ma");
    expect(settingsError({ APP_ENV: "prod", SITE_URL: "http://localhost:3000", ADMIN_HOST: "" })).toMatch(/^SITE_URL must be https when APP_ENV=prod/);
    // A project not recorded yet is named, never guessed.
    const unrecorded = structuredClone(targets) as unknown as Targets;
    unrecorded.environments.prod.firebase.projectId = null;
    expect(settingsError({ APP_ENV: "prod" }, unrecorded)).toBe("FIREBASE_PROJECT_ID is required: environments.prod.firebase.projectId is not recorded in infra/targets.json");
  });

  it("keeps dev as given: the emulators' demo project and the local origin", () => {
    const emulated = { FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", FIREBASE_PROJECT_ID: "demo-joutiya", ADMIN_HOST: "admin.localhost" };
    expect(resolveSettings(emulated, targets)).toEqual({ projectId: "demo-joutiya", origin: "http://admin.localhost:3000", emulated: true });
    expect(settingsError({ APP_ENV: "dev" })).toMatch(/^FIREBASE_PROJECT_ID is required \(derived/);
    expect(settingsError({ FIREBASE_PROJECT_ID: "joutiya-prod-1234" })).toBe("APP_ENV is required when FIREBASE_PROJECT_ID is set");
    expect(settingsError({ APP_ENV: "prod" }, { shared: {} })).toMatch(/^infra\/targets\.json: /);
  });

  it("reuses only an existing staff account, revoked included, and refuses every other one", () => {
    expect(existingAccountProblem({ role: "admin", rosterExists: true })).toBeNull();
    expect(existingAccountProblem({ role: "moderator", rosterExists: true })).toBeNull();
    // Revoked: claims cleared, roster entry kept.
    expect(existingAccountProblem({ role: undefined, rosterExists: true })).toBeNull();
    // Claims without a roster entry (an interrupted run): still ours.
    expect(existingAccountProblem({ role: "admin", rosterExists: false })).toBeNull();
    // Member accounts and never-confirmed sign-ups keep their own password: never promoted.
    expect(existingAccountProblem({ role: "individual", rosterExists: false })).toMatch(/already exists/);
    expect(existingAccountProblem({ role: "pro", rosterExists: false })).toMatch(/already exists/);
    expect(existingAccountProblem({ role: undefined, rosterExists: false })).toMatch(/already exists/);
  });
});
