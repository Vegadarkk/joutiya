import { describe, expect, it } from "vitest";
import { adminOrigin, oobCodeOf, parseCli, planSteps, setPasswordUrl } from "../../scripts/create-admin";

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

  it("plans the steps without touching anything", () => {
    const lines = planSteps({ args: { email: "a@b.co", name: "Ab", apply: false }, projectId: "joutiya-dev", origin: "http://admin.localhost:3000", emulated: true });
    expect(lines[0]).toContain("joutiya-dev");
    expect(lines.join("\n")).toContain("--apply");
    expect(lines.join("\n")).toContain("http://admin.localhost:3000/connexion?mode=setPassword&oobCode=");
  });
});
