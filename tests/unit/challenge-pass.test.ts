import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetServerEnv } from "@/lib/env";
import { challengePassCookie, hasChallengePass, requestDeviceId } from "@/lib/security/challenge-pass";
import { newDeviceCookie } from "@/lib/security/device";
import { turnstilePass } from "@/lib/security/turnstile";

// __Host-tsv challenge pass (design D13/D14): bound to the signed device cookie, 30 minutes.

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

function passValue(setCookie: string): string {
  const match = /^__Host-tsv=([^;]+);/.exec(setCookie);
  if (!match?.[1]) throw new Error("no pass value");
  return match[1];
}

function request(cookies: Record<string, string>): Request {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return new Request("https://joutiya.ma/fr/annonce/x", { headers: cookie ? { cookie } : {} });
}

beforeEach(() => {
  process.env.APP_ENV = "dev";
  resetServerEnv();
});
afterEach(() => resetServerEnv());

describe("challenge pass", () => {
  it("builds a 30-minute, host-only, http-only, Lax cookie", async () => {
    const device = newDeviceCookie();
    const header = await challengePassCookie(device.id, NOW);
    expect(header).toMatch(/^__Host-tsv=\d{10}\.[A-Za-z0-9_-]{32}; Path=\/; Max-Age=1800; Secure; HttpOnly; SameSite=Lax$/);
    expect(header).not.toContain("Domain");
  });

  it("accepts the pass of the request's own device until it expires", async () => {
    const device = newDeviceCookie();
    const pass = passValue(await challengePassCookie(device.id, NOW));
    const req = request({ "__Host-did": device.value, "__Host-tsv": pass });
    expect(requestDeviceId(req)).toBe(device.id);
    await expect(hasChallengePass(req, NOW + 29 * 60_000)).resolves.toBe(true);
    await expect(hasChallengePass(req, NOW + 31 * 60_000)).resolves.toBe(false);
  });

  it("refuses a pass minted for another device", async () => {
    const mine = newDeviceCookie();
    const other = newDeviceCookie();
    const pass = passValue(await challengePassCookie(other.id, NOW));
    await expect(hasChallengePass(request({ "__Host-did": mine.value, "__Host-tsv": pass }), NOW)).resolves.toBe(false);
  });

  it("refuses tampered values, a forged device cookie and a missing device", async () => {
    const device = newDeviceCookie();
    const pass = passValue(await challengePassCookie(device.id, NOW));
    const [expires, sig] = pass.split(".") as [string, string];
    const flipped = `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    // A later expiry with the old signature, a modified signature, garbage.
    for (const value of [`${Number(expires) + 3600}.${sig}`, `${expires}.${flipped}`, "garbage", ""]) {
      await expect(hasChallengePass(request({ "__Host-did": device.value, "__Host-tsv": value }), NOW)).resolves.toBe(false);
    }
    const forgedDevice = `${device.id}.${"x".repeat(22)}`;
    await expect(hasChallengePass(request({ "__Host-did": forgedDevice, "__Host-tsv": pass }), NOW)).resolves.toBe(false);
    await expect(hasChallengePass(request({ "__Host-tsv": pass }), NOW)).resolves.toBe(false);
  });

  it("shares the auth flows' pass format (one cookie, either flow's pass counts)", async () => {
    const device = newDeviceCookie();
    // What applyTurnstilePass (src/lib/auth/respond.ts) writes for this device.
    const authPass = turnstilePass(`d:${device.id}`, NOW);
    await expect(hasChallengePass(request({ "__Host-did": device.value, "__Host-tsv": authPass }), NOW)).resolves.toBe(true);
    // An anonymous-IP binding never counts as a device pass.
    const ipPass = turnstilePass("anon:1.2.3.4", NOW);
    await expect(hasChallengePass(request({ "__Host-did": device.value, "__Host-tsv": ipPass }), NOW)).resolves.toBe(false);
  });

  it("refuses to mint a pass for a malformed device id", async () => {
    await expect(challengePassCookie("not a device id")).rejects.toThrow();
  });
});
