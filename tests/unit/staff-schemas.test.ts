import { describe, expect, it } from "vitest";
import { inviteSchema, STAFF_PASSWORD_MIN, staffLoginSchema, staffPasswordSchema } from "@/lib/auth/staff";
import { staffDocSchema } from "@/lib/db/repositories/staff";

describe("staffLoginSchema", () => {
  it("normalizes the e-mail and accepts an optional Turnstile token", () => {
    const parsed = staffLoginSchema.parse({ email: "  Admin@Joutiya.MA ", password: "x", turnstileToken: "tok" });
    expect(parsed).toEqual({ email: "admin@joutiya.ma", password: "x", turnstileToken: "tok" });
    expect(staffLoginSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
  });

  it("refuses an empty or oversized password, an oversized token and unknown fields", () => {
    expect(staffLoginSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
    expect(staffLoginSchema.safeParse({ email: "a@b.co", password: "p".repeat(129) }).success).toBe(false);
    expect(staffLoginSchema.safeParse({ email: "a@b.co", password: "x", turnstileToken: "t".repeat(2049) }).success).toBe(false);
    expect(staffLoginSchema.safeParse({ email: "a@b.co", password: "x", role: "admin" }).success).toBe(false);
    expect(staffLoginSchema.safeParse({ email: "not-an-email", password: "x" }).success).toBe(false);
  });
});

describe("staffPasswordSchema", () => {
  it("needs a plausible code and a password of 12 to 128 characters (owner guide: 12 or more)", () => {
    expect(STAFF_PASSWORD_MIN).toBe(12);
    const password = "x".repeat(STAFF_PASSWORD_MIN);
    expect(staffPasswordSchema.safeParse({ oobCode: "a".repeat(10), password }).success).toBe(true);
    expect(staffPasswordSchema.safeParse({ oobCode: "short", password }).success).toBe(false);
    // The member minimum (8) is not enough for staff.
    expect(staffPasswordSchema.safeParse({ oobCode: "a".repeat(10), password: "x".repeat(STAFF_PASSWORD_MIN - 1) }).success).toBe(false);
    expect(staffPasswordSchema.safeParse({ oobCode: "a".repeat(10), password: "x".repeat(8) }).success).toBe(false);
    expect(staffPasswordSchema.safeParse({ oobCode: "a".repeat(10), password: "p".repeat(129) }).success).toBe(false);
    expect(staffPasswordSchema.safeParse({ oobCode: "a".repeat(10), password, email: "a@b.co" }).success).toBe(false);
  });
});

describe("inviteSchema", () => {
  it("accepts a moderator or an admin with a clean display name", () => {
    expect(inviteSchema.parse({ email: "Mod@Joutiya.ma", displayName: " Salma El Idrissi ", role: "moderator" })).toEqual({
      email: "mod@joutiya.ma",
      displayName: "Salma El Idrissi",
      role: "moderator",
    });
    expect(inviteSchema.safeParse({ email: "a@b.co", displayName: "Ali", role: "admin" }).success).toBe(true);
  });

  it("refuses member roles, bad names and unknown fields", () => {
    expect(inviteSchema.safeParse({ email: "a@b.co", displayName: "Ali", role: "individual" }).success).toBe(false);
    expect(inviteSchema.safeParse({ email: "a@b.co", displayName: "Ali", role: "pro" }).success).toBe(false);
    expect(inviteSchema.safeParse({ email: "a@b.co", displayName: "A", role: "admin" }).success).toBe(false);
    expect(inviteSchema.safeParse({ email: "a@b.co", displayName: "x".repeat(41), role: "admin" }).success).toBe(false);
    expect(inviteSchema.safeParse({ email: "a@b.co", displayName: "<script>", role: "admin" }).success).toBe(false);
    expect(inviteSchema.safeParse({ email: "a@b.co", displayName: "Ali", role: "admin", uid: "x" }).success).toBe(false);
  });
});

describe("staffDocSchema", () => {
  const base = { email: "a@b.co", displayName: "Ali", role: "admin", invitedBy: "script", createdAt: new Date() };

  it("accepts the roster document, with or without a revocation", () => {
    expect(staffDocSchema.safeParse(base).success).toBe(true);
    expect(staffDocSchema.safeParse({ ...base, invitedBy: "uid-123", revokedAt: new Date() }).success).toBe(true);
  });

  it("refuses an empty inviter, a member role and unknown fields", () => {
    expect(staffDocSchema.safeParse({ ...base, invitedBy: "" }).success).toBe(false);
    expect(staffDocSchema.safeParse({ ...base, role: "individual" }).success).toBe(false);
    expect(staffDocSchema.safeParse({ ...base, password: "x" }).success).toBe(false);
    expect(staffDocSchema.safeParse({ ...base, createdAt: "2026-10-16" }).success).toBe(false);
  });
});
