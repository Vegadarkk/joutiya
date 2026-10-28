import type { UserRecord } from "firebase-admin/auth";
import { describe, expect, it, vi } from "vitest";

// authUserLine (D20): what one Firebase Auth account becomes in the encrypted backup.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/quota", () => ({ consume: vi.fn(), isDegraded: vi.fn(async () => false) }));

const { authUserLine } = await import("@/lib/backup/export");

const user = (extra: Partial<UserRecord> = {}) =>
  ({
    uid: "u1",
    email: "pro@joutiya.test",
    emailVerified: true,
    disabled: false,
    displayName: undefined,
    providerData: [{ providerId: "google.com", uid: "g-1", email: "pro@joutiya.test" }],
    customClaims: { role: "pro" },
    metadata: { creationTime: "Tue, 20 Oct 2026 08:00:00 GMT", lastSignInTime: undefined },
    tokensValidAfterTime: undefined,
    ...extra,
  }) as unknown as UserRecord;

describe("authUserLine", () => {
  it("keeps what an import needs, nulls for absent fields", () => {
    expect(JSON.parse(authUserLine(user()))).toEqual({
      uid: "u1",
      email: "pro@joutiya.test",
      emailVerified: true,
      disabled: false,
      displayName: null,
      providerData: [{ providerId: "google.com", uid: "g-1", email: "pro@joutiya.test" }],
      customClaims: { role: "pro" },
      createdAt: "Tue, 20 Oct 2026 08:00:00 GMT",
      lastSignInAt: null,
      tokensValidAfter: null,
    });
  });

  it("adds the password hash only with its salt", () => {
    expect(JSON.parse(authUserLine(user({ passwordHash: "aGFzaA==", passwordSalt: "c2FsdA==" })))).toMatchObject({ passwordHash: "aGFzaA==", passwordSalt: "c2FsdA==" });
    expect(JSON.parse(authUserLine(user({ passwordHash: "aGFzaA==" })))).not.toHaveProperty("passwordHash");
  });
});
