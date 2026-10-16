import { describe, expect, it } from "vitest";
import { assertPasswordPolicy, checkPassword } from "@/lib/auth/password-policy";
import { HttpError } from "@/lib/http/errors";

describe("checkPassword", () => {
  it("accepts a reasonable password", () => {
    expect(checkPassword("Correct-Horse-9", { email: "yasmine@example.com", displayName: "Yasmine B" })).toBeNull();
    expect(checkPassword("medina2026!tanger")).toBeNull();
  });

  it("enforces the length bounds", () => {
    expect(checkPassword("Ab1!xyz")).toBe("too_short");
    expect(checkPassword("x".repeat(129))).toBe("too_long");
  });

  it("refuses the most common passwords, whatever the case or trailing punctuation", () => {
    expect(checkPassword("password")).toBe("common");
    expect(checkPassword("Password123")).toBe("common");
    expect(checkPassword("motdepasse!")).toBe("common");
    expect(checkPassword("Qwertyuiop")).toBe("common");
    expect(checkPassword("casablanca")).toBe("common");
  });

  it("refuses passwords built on the e-mail local part or the display name", () => {
    expect(checkPassword("youssef.b2026", { email: "Youssef.B@example.com" })).toBe("personal");
    expect(checkPassword("xxYOUSSEFxx", { email: "youssef.b@example.com" })).toBe("personal");
    expect(checkPassword("Nadia-Alaoui!", { displayName: "nadia alaoui" })).toBe("personal");
    expect(checkPassword("alaoui12345", { displayName: "Nadia Alaoui" })).toBe("personal");
    // Tokens shorter than 4 characters are not personal information worth refusing.
    expect(checkPassword("bo-grand-mur-77", { email: "bo@example.com", displayName: "Bo" })).toBeNull();
  });

  it("refuses a repeated character and a plain sequence", () => {
    expect(checkPassword("aaaaaaaa")).toBe("repeated");
    expect(checkPassword("abcdefgh")).toBe("common");
    expect(checkPassword("bcdefghi")).toBe("sequence");
    expect(checkPassword("12345678")).toBe("common");
    expect(checkPassword("23456789")).toBe("sequence");
    expect(checkPassword("zyxwvuts")).toBe("sequence");
    expect(checkPassword("abcdefg1")).toBeNull();
  });

  it("assertPasswordPolicy throws 400 weak_password with the reason", () => {
    expect(() => assertPasswordPolicy("Correct-Horse-9")).not.toThrow();
    try {
      assertPasswordPolicy("iloveyou");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe("weak_password");
      expect((error as HttpError).details).toEqual({ reason: "common" });
    }
  });
});
