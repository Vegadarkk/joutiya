import { describe, expect, it } from "vitest";
import targets from "../../infra/targets.json";
import { adminOrigin, existingAccountProblem, oobCodeOf, parseCli, planSteps, projectErrors, setPasswordUrl } from "../../scripts/create-admin";

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
