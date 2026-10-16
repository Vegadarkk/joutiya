import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticateWebhook, expectedSignature, parseSignatureHeader } from "@/lib/payments/revenuecat-webhook";

// RevenueCat webhook authentication: static Authorization value + HMAC-SHA256 over "<t>.<body>"
// with a 300 s window (phase-7/research/revenuecat.md §4).

const SECRET = "test-signing-secret";
const AUTH = "Bearer test-webhook-authorization";
const BODY = JSON.stringify({ api_version: "1.0", event: { id: "evt_1", type: "NON_RENEWING_PURCHASE" } });
const NOW = new Date("2026-10-16T10:00:00.000Z");
const T = Math.floor(NOW.getTime() / 1000);

function sign(body: string, t: number, secret = SECRET): string {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

function check(overrides: Partial<Parameters<typeof authenticateWebhook>[0]> = {}) {
  return authenticateWebhook({
    rawBody: BODY,
    authorization: AUTH,
    signature: `t=${T},v1=${sign(BODY, T)}`,
    expectedAuthorization: AUTH,
    signingSecret: SECRET,
    now: NOW,
    ...overrides,
  });
}

describe("signature header", () => {
  it("parses t and every v1", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    expect(parseSignatureHeader(`t=${T},v1=${a}, v1=${b}`)).toEqual({ timestamp: T, signatures: [a, b.toLowerCase()] });
  });

  it("rejects malformed headers", () => {
    for (const bad of [null, "", `t=${T}`, `v1=${"a".repeat(64)}`, `t=abc,v1=${"a".repeat(64)}`, `t=${T},v1=xyz`]) expect(parseSignatureHeader(bad)).toBeNull();
  });

  it("matches an independent HMAC computation", () => {
    expect(expectedSignature(SECRET, T, BODY)).toBe(sign(BODY, T));
  });
});

describe("authenticateWebhook", () => {
  it("accepts an authentic delivery, including a retry within the window", () => {
    expect(check()).toBeNull();
    const t = T - 299;
    expect(check({ signature: `t=${t},v1=${sign(BODY, t)}` })).toBeNull();
  });

  it("rejects a wrong or missing Authorization value", () => {
    expect(check({ authorization: "Bearer other" })).toBe("authorization");
    expect(check({ authorization: null })).toBe("authorization");
  });

  it("rejects a stale, missing or forged signature", () => {
    const old = T - 301;
    expect(check({ signature: `t=${old},v1=${sign(BODY, old)}` })).toBe("signature_stale");
    expect(check({ signature: null })).toBe("signature_missing");
    expect(check({ signature: `t=${T},v1=${sign(BODY, T, "other-secret")}` })).toBe("signature_mismatch");
    expect(check({ rawBody: BODY.replace("evt_1", "evt_2") })).toBe("signature_mismatch");
  });

  it("refuses everything when not configured", () => {
    expect(check({ signingSecret: "" })).toBe("not_configured");
    expect(check({ expectedAuthorization: "" })).toBe("not_configured");
  });
});
