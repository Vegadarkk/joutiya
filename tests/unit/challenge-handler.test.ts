import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as turnstile from "@/lib/security/turnstile";
import { POST } from "@/app/api/challenge/pass/route";
import { resetServerEnv } from "@/lib/env";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { hasChallengePass } from "@/lib/security/challenge-pass";
import { newDeviceCookie } from "@/lib/security/device";

// POST /api/challenge/pass (design D14): Turnstile "pages" -> 204 + __Host-tsv bound to the device.

vi.mock("@/lib/security/turnstile", async (importOriginal) => {
  const actual = await importOriginal<typeof turnstile>();
  return { ...actual, verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) };
});
const verify = vi.mocked(turnstile.verifyTurnstile);

const ORIGIN = "http://localhost:3000";

function post(body: unknown, options: { origin?: string | null; cookie?: string; ip?: string } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost:3000", "x-forwarded-for": options.ip ?? "198.51.100.4" };
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.cookie) headers.cookie = options.cookie;
  return new NextRequest(`${ORIGIN}/api/challenge/pass`, { method: "POST", headers, body: JSON.stringify(body) });
}

const context = { params: Promise.resolve({}) };

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

beforeEach(() => {
  process.env.APP_ENV = "dev";
  resetServerEnv();
  resetRateLimiters();
  verify.mockClear();
  verify.mockResolvedValue({ ok: true, codes: [] });
});
afterEach(() => resetServerEnv());

describe("POST /api/challenge/pass", () => {
  it("sets a pass bound to the request's device after a solved challenge", async () => {
    const device = newDeviceCookie();
    const response = await POST(post({ token: "solved" }, { cookie: `__Host-did=${device.value}` }), context);
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(verify).toHaveBeenCalledWith("solved", expect.objectContaining({ action: "pages", remoteIp: "198.51.100.4", hostname: "localhost" }));
    const cookies = setCookies(response);
    expect(cookies).toHaveLength(1);
    const pass = /^__Host-tsv=([^;]+)/.exec(cookies[0] ?? "")?.[1];
    const next = new Request(`${ORIGIN}/fr/annonce/x`, { headers: { cookie: `__Host-did=${device.value}; __Host-tsv=${pass}` } });
    await expect(hasChallengePass(next)).resolves.toBe(true);
  });

  it("gives a client without a device cookie one, with the pass bound to it", async () => {
    const response = await POST(post({ token: "solved" }), context);
    expect(response.status).toBe(204);
    const cookies = setCookies(response);
    const did = cookies.find((cookie) => cookie.startsWith("__Host-did="));
    const tsv = cookies.find((cookie) => cookie.startsWith("__Host-tsv="));
    expect(did).toBeDefined();
    expect(tsv).toContain("SameSite=Lax");
    const value = (cookie: string | undefined) => /^[^=]+=([^;]+)/.exec(cookie ?? "")?.[1];
    const next = new Request(`${ORIGIN}/fr`, { headers: { cookie: `__Host-did=${value(did)}; __Host-tsv=${value(tsv)}` } });
    await expect(hasChallengePass(next)).resolves.toBe(true);
  });

  it("refuses a foreign or missing Origin before any check", async () => {
    for (const origin of ["https://evil.example", null]) {
      const response = await POST(post({ token: "solved" }, { origin }), context);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "origin" } });
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it("refuses a malformed body", async () => {
    for (const body of [{}, { token: "" }, { token: "x", extra: 1 }]) {
      expect((await POST(post(body), context)).status).toBe(400);
    }
  });

  it("answers 403 turnstile_failed, then 429 without siteverify once the IP spent its failures", async () => {
    verify.mockResolvedValue({ ok: false, codes: ["invalid-input-response"] });
    for (let i = 0; i < 30; i += 1) {
      const response = await POST(post({ token: "bad" }, { ip: "198.51.100.9" }), context);
      expect(response.status).toBe(403);
    }
    expect(verify).toHaveBeenCalledTimes(30);
    const blocked = await POST(post({ token: "bad" }, { ip: "198.51.100.9" }), context);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(verify).toHaveBeenCalledTimes(30);
    // Another IP is not affected.
    verify.mockResolvedValue({ ok: true, codes: [] });
    expect((await POST(post({ token: "solved" }, { ip: "198.51.100.10" }), context)).status).toBe(204);
  });
});
