import { beforeEach, describe, expect, it } from "vitest";
import { resetServerEnv } from "@/lib/env";
import { appealToken, verifyAppealToken } from "@/lib/decisions/appeal-token";

// D16: signed appeal links (HMAC purpose "appeal:v1" under HASH_PEPPER), valid until the appeal
// deadline, for the affected user or one reporter's report.

const DECISION = "AbCdEfGhIjKlMnOpQrSt";
const REPORT = "ZyXwVuTsRqPoNmLkJiHg";
const NOW = new Date("2026-10-16T10:00:00.000Z");
const DEADLINE = new Date("2027-04-16T10:00:00.000Z");

beforeEach(() => {
  process.env.APP_ENV = "dev";
  delete process.env.HASH_PEPPER;
  resetServerEnv();
});

describe("appeal token", () => {
  it("round-trips the affected user's and a reporter's claims", () => {
    expect(verifyAppealToken(appealToken({ decisionId: DECISION, by: "affected", expiresAt: DEADLINE }), NOW)).toEqual({
      ok: true,
      claims: { decisionId: DECISION, by: "affected", expiresAt: DEADLINE },
    });
    expect(verifyAppealToken(appealToken({ decisionId: DECISION, by: "reporter", reportId: REPORT, expiresAt: DEADLINE }), NOW)).toEqual({
      ok: true,
      claims: { decisionId: DECISION, by: "reporter", reportId: REPORT, expiresAt: DEADLINE },
    });
  });

  it("is URL-safe and short enough for a mail link", () => {
    const token = appealToken({ decisionId: DECISION, by: "reporter", reportId: REPORT, expiresAt: DEADLINE });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(token.length).toBeLessThan(200);
  });

  it("expires at the appeal deadline", () => {
    const token = appealToken({ decisionId: DECISION, by: "affected", expiresAt: DEADLINE });
    expect(verifyAppealToken(token, DEADLINE)).toEqual({ ok: false, reason: "expired" });
    expect(verifyAppealToken(token, new Date(DEADLINE.getTime() - 1000)).ok).toBe(true);
  });

  it("refuses tampered, truncated and re-shaped tokens", () => {
    const token = appealToken({ decisionId: DECISION, by: "affected", expiresAt: DEADLINE });
    const [payload, sig] = token.split(".") as [string, string];
    const reporter = Buffer.from(`v1.${DECISION}.reporter.${REPORT}.${Math.floor(DEADLINE.getTime() / 1000)}`).toString("base64url");
    expect(verifyAppealToken(`${reporter}.${sig}`, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyAppealToken(`${payload}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyAppealToken(payload, NOW).ok).toBe(false);
    expect(verifyAppealToken(`${payload}.${sig}.x`, NOW).ok).toBe(false);
    expect(verifyAppealToken("", NOW).ok).toBe(false);
  });

  it("refuses claims of the wrong shape when signing", () => {
    expect(() => appealToken({ decisionId: "short", by: "affected", expiresAt: DEADLINE })).toThrow();
    expect(() => appealToken({ decisionId: DECISION, by: "reporter", expiresAt: DEADLINE })).toThrow();
    expect(() => appealToken({ decisionId: DECISION, by: "affected", reportId: REPORT, expiresAt: DEADLINE })).toThrow();
  });

  it("depends on HASH_PEPPER", () => {
    const token = appealToken({ decisionId: DECISION, by: "affected", expiresAt: DEADLINE });
    process.env.HASH_PEPPER = "another-pepper-of-at-least-32-characters-xx";
    resetServerEnv();
    expect(verifyAppealToken(token, NOW)).toEqual({ ok: false, reason: "invalid" });
  });
});
