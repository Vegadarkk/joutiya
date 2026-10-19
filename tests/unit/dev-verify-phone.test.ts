import { describe, expect, it } from "vitest";
import targets from "../../infra/targets.json";
import { accountProblem, envProblems, holderProblem, parseCli, planSteps, toE164 } from "../../scripts/dev-verify-phone";

// Seeds a verified phone on a test account (dev and staging): production is refused by APP_ENV
// and by the project id, the number must be a free Moroccan mobile, the account activated.

describe("dev-verify-phone", () => {
  it("normalizes a Moroccan mobile to E.164 and refuses the rest", () => {
    expect(toE164("06 12 34 56 78")).toBe("+212612345678");
    expect(toE164("07.12.34.56.78")).toBe("+212712345678");
    expect(toE164("+212 612-345-678")).toBe("+212612345678");
    expect(toE164("00212612345678")).toBe("+212612345678");
    expect(toE164("0512345678")).toBeNull();
    expect(toE164("+33612345678")).toBeNull();
    expect(toE164("061234567")).toBeNull();
    expect(toE164("")).toBeNull();
  });

  it("parses the CLI, lower-cases the e-mail and defaults to a dry run", () => {
    expect(parseCli(["--email", "Test@Joutiya.MA", "--phone", "06 12 34 56 78"])).toEqual({ email: "test@joutiya.ma", phone: "+212612345678", apply: false });
    expect(parseCli(["--email", "a@b.co", "--phone", "+212712345678", "--apply"]).apply).toBe(true);
    expect(() => parseCli(["--phone", "0612345678"])).toThrow(/usage/);
    expect(() => parseCli(["--email", "nope", "--phone", "0612345678"])).toThrow(/usage/);
    expect(() => parseCli(["--email", "a@b.co", "--phone", "0512345678"])).toThrow(/Moroccan mobile/);
    expect(() => parseCli(["--email", "a@b.co"])).toThrow(/Moroccan mobile/);
    expect(() => parseCli(["--email", "a@b.co", "--phone", "0612345678", "--force"])).toThrow();
  });

  it("never runs against production, by APP_ENV or by the project id", () => {
    expect(envProblems(targets, { APP_ENV: "prod", FIREBASE_PROJECT_ID: "demo-joutiya" })).toEqual(["APP_ENV=prod: this script never runs against production"]);
    const prodProject = targets.environments.prod.firebase.projectId;
    expect(prodProject).toBeTypeOf("string");
    const byProject = envProblems(targets, { APP_ENV: "staging", FIREBASE_PROJECT_ID: prodProject as string });
    expect(byProject).toHaveLength(1);
    expect(byProject[0]).toMatch(/^FIREBASE_PROJECT_ID is environments\.prod\.firebase\.projectId/);
    expect(byProject[0]).not.toContain(prodProject);
    expect(envProblems(targets, { FIREBASE_PROJECT_ID: prodProject as string })).toHaveLength(1);
  });

  it("accepts dev and staging when the project is the recorded one", () => {
    expect(envProblems(targets, { APP_ENV: "dev", FIREBASE_PROJECT_ID: "demo-joutiya" })).toEqual([]);
    expect(envProblems(targets, { APP_ENV: "staging", FIREBASE_PROJECT_ID: targets.environments.staging.firebase.projectId as string })).toEqual([]);
    const mismatch = envProblems(targets, { APP_ENV: "staging", FIREBASE_PROJECT_ID: "joutiya-staging-1234" });
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toMatch(/^FIREBASE_PROJECT_ID (is set but|does not match) environments\.staging\.firebase\.projectId/);
    expect(mismatch[0]).not.toContain("joutiya-staging-1234");
    expect(envProblems(targets, { FIREBASE_PROJECT_ID: "demo-joutiya" })).toEqual(["APP_ENV is required when FIREBASE_PROJECT_ID is set"]);
    expect(envProblems({ shared: {} }, { APP_ENV: "dev", FIREBASE_PROJECT_ID: "demo-joutiya" })[0]).toMatch(/^infra\/targets\.json: /);
  });

  it("seeds only an activated, active account whose number nobody else holds", () => {
    expect(accountProblem({ exists: false })).toMatch(/does not exist/);
    expect(accountProblem({ exists: true, activation: "pending", status: "active" })).toMatch(/not activated/);
    expect(accountProblem({ exists: true, activation: "done", status: "suspended" })).toMatch(/suspended, not active/);
    expect(accountProblem({ exists: true, activation: "done", status: "active" })).toBeNull();
    expect(holderProblem("u1", [])).toBeNull();
    expect(holderProblem("u1", ["u1"])).toBeNull();
    expect(holderProblem("u1", ["u2"])).toMatch(/another account/);
  });

  it("plans the steps without touching anything", () => {
    const lines = planSteps({ args: { email: "a@b.co", phone: "+212612345678", apply: false }, appEnv: "staging", projectId: "joutiya-staging", emulated: false });
    expect(lines[0]).toContain("joutiya-staging");
    expect(lines[0]).toContain("Application Default Credentials");
    expect(lines.join("\n")).toContain("+212612345678");
    expect(lines.join("\n")).toContain("--apply");
  });
});
