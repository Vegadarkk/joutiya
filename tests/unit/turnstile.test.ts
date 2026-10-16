import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerEnv } from "@/lib/env";
import { hasTurnstilePass, turnstilePass, verifyTurnstile } from "@/lib/security/turnstile";

// Cloudflare's always-pass testing pair (documented dummy keys), as in playwright.config.ts.
const TEST_SITE_KEY = "1x00000000000000000000AA";
const TEST_SECRET = "1x0000000000000000000000000000000AA";

function siteverify(body: Record<string, unknown>, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.APP_ENV = "dev";
  process.env.TURNSTILE_SITE_KEY = TEST_SITE_KEY;
  process.env.TURNSTILE_SECRET_KEY = TEST_SECRET;
  resetServerEnv();
});

afterEach(() => {
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  resetServerEnv();
});

describe("verifyTurnstile", () => {
  it("accepts a token solved on the site for the expected action", async () => {
    const fetchImpl = siteverify({ success: true, hostname: "joutiya.ma", action: "signup", "error-codes": [] });
    await expect(verifyTurnstile("token", { action: "signup", hostname: "joutiya.ma" }, fetchImpl)).resolves.toEqual({ ok: true, codes: [] });
  });

  it("refuses a token solved elsewhere or for another action", async () => {
    const elsewhere = siteverify({ success: true, hostname: "evil.example", action: "signup" });
    await expect(verifyTurnstile("token", { action: "signup", hostname: "joutiya.ma" }, elsewhere)).resolves.toEqual({ ok: false, codes: ["hostname-mismatch"] });
    const otherAction = siteverify({ success: true, hostname: "joutiya.ma", action: "login" });
    await expect(verifyTurnstile("token", { action: "signup", hostname: "joutiya.ma" }, otherAction)).resolves.toEqual({ ok: false, codes: ["action-mismatch"] });
  });

  it("ignores the hostname with Cloudflare's testing keys, which always answer example.com", async () => {
    const testing = siteverify({ success: true, hostname: "example.com", "error-codes": [], metadata: { result_with_testing_key: true } });
    await expect(verifyTurnstile("token", { action: "signup", hostname: "localhost" }, testing)).resolves.toEqual({ ok: true, codes: [] });
  });

  it("fails closed on a missing token, a failed check or an unreachable siteverify", async () => {
    await expect(verifyTurnstile(undefined, { action: "login" }, siteverify({ success: true }))).resolves.toEqual({ ok: false, codes: ["missing-input-response"] });
    const failed = siteverify({ success: false, "error-codes": ["invalid-input-response"] });
    await expect(verifyTurnstile("token", { action: "login" }, failed)).resolves.toEqual({ ok: false, codes: ["invalid-input-response"] });
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(verifyTurnstile("token", { action: "login" }, down)).resolves.toEqual({ ok: false, codes: ["unreachable"] });
    await expect(verifyTurnstile("token", { action: "login" }, siteverify({}, 502))).resolves.toEqual({ ok: false, codes: ["http-502"] });
  });

  it("bypasses the check only in dev without keys", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    resetServerEnv();
    await expect(verifyTurnstile(undefined, { action: "login" }, siteverify({}))).resolves.toEqual({ ok: true, codes: ["dev-bypass"] });
  });
});

describe("turnstilePass", () => {
  it("is bound to the device and expires", () => {
    const now = 1_760_000_000_000;
    const pass = turnstilePass("device-a", now);
    expect(hasTurnstilePass(pass, "device-a", now + 60_000)).toBe(true);
    expect(hasTurnstilePass(pass, "device-b", now + 60_000)).toBe(false);
    expect(hasTurnstilePass(pass, "device-a", now + 31 * 60_000)).toBe(false);
    expect(hasTurnstilePass("garbage", "device-a", now)).toBe(false);
  });
});
