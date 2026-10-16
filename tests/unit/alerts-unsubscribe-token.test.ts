import { beforeEach, describe, expect, it } from "vitest";
import { resetServerEnv } from "@/lib/env";
import { UNSUBSCRIBE_ALL, unsubscribeToken, verifyUnsubscribeToken } from "@/lib/alerts/unsubscribe-token";

// D20: one-click unsubscribe tokens. base64url("v1.<uid>.<searchId|*>") + "." + HMAC under a
// HASH_PEPPER-derived secret; anything altered, truncated or signed with another pepper is refused.

const SEARCH = "AbCdEfGhIjKlMnOpQrSt";

beforeEach(() => {
  process.env.APP_ENV = "dev";
  delete process.env.HASH_PEPPER;
  resetServerEnv();
});

describe("unsubscribe token", () => {
  it("round-trips one search and every alert of the account", () => {
    expect(verifyUnsubscribeToken(unsubscribeToken("uid-1", SEARCH))).toEqual({ uid: "uid-1", searchId: SEARCH });
    expect(verifyUnsubscribeToken(unsubscribeToken("uid-1"))).toEqual({ uid: "uid-1", searchId: UNSUBSCRIBE_ALL });
    // A uid with dots and dashes (test and custom uids) keeps its shape.
    expect(verifyUnsubscribeToken(unsubscribeToken("lst.a-1.b", SEARCH))).toEqual({ uid: "lst.a-1.b", searchId: SEARCH });
  });

  it("is URL-safe, bounded and stable for the same target", () => {
    const token = unsubscribeToken("Z9x8Y7w6V5u4T3s2R1q0P9o8N7m6", SEARCH);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(token.length).toBeLessThan(200);
    expect(unsubscribeToken("Z9x8Y7w6V5u4T3s2R1q0P9o8N7m6", SEARCH)).toBe(token);
  });

  it("refuses tampered, truncated and forged tokens", () => {
    const token = unsubscribeToken("uid-1", SEARCH);
    const [payload, sig] = token.split(".") as [string, string];
    const other = Buffer.from(`v1.uid-2.${SEARCH}`).toString("base64url");
    expect(verifyUnsubscribeToken(`${other}.${sig}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${payload}.${sig.slice(0, -1)}A`)).toBeNull();
    expect(verifyUnsubscribeToken(payload)).toBeNull();
    expect(verifyUnsubscribeToken(`${payload}.${sig}.x`)).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
    // A well-signed payload of another shape (version, search id) is still refused.
    const forged = unsubscribeToken("uid-1", SEARCH).replace(payload, Buffer.from(`v2.uid-1.${SEARCH}`).toString("base64url"));
    expect(verifyUnsubscribeToken(forged)).toBeNull();
  });

  it("depends on HASH_PEPPER", () => {
    const token = unsubscribeToken("uid-1");
    process.env.HASH_PEPPER = "another-pepper-of-at-least-32-characters-xx";
    resetServerEnv();
    expect(verifyUnsubscribeToken(token)).toBeNull();
    expect(verifyUnsubscribeToken(unsubscribeToken("uid-1"))).toEqual({ uid: "uid-1", searchId: UNSUBSCRIBE_ALL });
  });

  it("never signs a target that could escape its document path", () => {
    expect(() => unsubscribeToken("a/b")).toThrow();
    expect(() => unsubscribeToken("uid-1", "../x")).toThrow();
    expect(() => unsubscribeToken("")).toThrow();
  });
});
