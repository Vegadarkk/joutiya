import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitId } from "@/config/rate-limits";
import { resetServerEnv } from "@/lib/env";
import type { IpIdentity, LimitOutcome } from "@/lib/rate-limit/limiter";
import { checkPageLimits, isMeteredPath, pathLocale, TOO_MANY_CSP, tooManyPagesHtml } from "@/lib/rate-limit/proxy-limits";
import { challengePassCookie } from "@/lib/security/challenge-pass";
import { newDeviceCookie } from "@/lib/security/device";

// Page-view limits of the proxy (§6, design D14), with the store stubbed per limiter id. The IP
// limiter goes through consumeIpLimit (its /48 sibling is covered in rate-limit-ip.test.ts).

const store = vi.hoisted(() => ({
  outcomes: new Map<string, LimitOutcome>(),
  calls: [] as { id: string; key: string }[],
  ipIdentities: [] as IpIdentity[],
}));

vi.mock("@/lib/rate-limit/limiter", () => ({
  consumeLimit: vi.fn(async (id: string, key: string): Promise<LimitOutcome> => {
    store.calls.push({ id, key });
    return store.outcomes.get(id) ?? { ok: true, remaining: 10 };
  }),
  consumeIpLimit: vi.fn(async (id: string, identity: IpIdentity): Promise<LimitOutcome> => {
    store.calls.push({ id, key: identity.ipBucket });
    store.ipIdentities.push(identity);
    return store.outcomes.get(id) ?? { ok: true, remaining: 10 };
  }),
}));

const LIMITED: LimitOutcome = { ok: false, reason: "limited", retryAfterSeconds: 90 };
const DOWN: LimitOutcome = { ok: false, reason: "unavailable" };

function request(cookies: Record<string, string> = {}, headers: Record<string, string> = {}): Request {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return new Request("https://joutiya.ma/fr/annonce/velo-casablanca-abcd2345", {
    headers: { "x-forwarded-for": "203.0.113.7", ...(cookie ? { cookie } : {}), ...headers },
  });
}

const ids = () => store.calls.map((call) => call.id as RateLimitId);

beforeEach(() => {
  process.env.APP_ENV = "dev";
  resetServerEnv();
  store.outcomes.clear();
  store.calls.length = 0;
  store.ipIdentities.length = 0;
});
afterEach(() => resetServerEnv());

describe("metered paths", () => {
  it("meters the four server-rendered page families of every locale", () => {
    for (const path of ["/fr/annonce/x-abcd2345", "/ar/c/vehicules", "/rif/c/vehicules/voitures/casablanca", "/fr/profil/abcdefghjk", "/ar/boutique/abc", "/fr/c"]) {
      expect(isMeteredPath(path), path).toBe(true);
    }
    for (const path of ["/", "/fr", "/fr/recherche", "/fr/anti-robot", "/fr/connexion", "/en/annonce/x", "/api/search", "/fr/annonces/x", "/fr/cx/y"]) {
      expect(isMeteredPath(path), path).toBe(false);
    }
    expect(pathLocale("/ar/annonce/x")).toBe("ar");
    expect(pathLocale("/xx/annonce/x")).toBeNull();
  });
});

describe("checkPageLimits", () => {
  it("counts an anonymous visitor on the IP only", async () => {
    await expect(checkPageLimits(request())).resolves.toEqual({ kind: "allow" });
    expect(ids()).toEqual(["pages.ip"]);
    expect(store.calls[0]?.key).toBe("203.0.113.7");
  });

  it("counts an IPv6 visitor on its /64 and its /48", async () => {
    await checkPageLimits(request({}, { "x-forwarded-for": "2001:db8:1:2::7" }));
    expect(ids()).toEqual(["pages.ip"]);
    expect(store.ipIdentities[0]).toMatchObject({ ipBucket: "2001:0db8:0001:0002::/64", ipNetwork: "2001:0db8:0001::/48", ipv6: true });
  });

  it("counts a visitor with a device cookie on the device and the IP", async () => {
    const device = newDeviceCookie();
    await checkPageLimits(request({ "__Host-did": device.value }));
    expect(ids()).toEqual(["pages.device", "pages.ip"]);
    expect(store.calls[0]?.key).toBe(`d:${device.id}`);
  });

  it("counts a signed-in member on the session bucket instead of the device", async () => {
    const device = newDeviceCookie();
    await checkPageLimits(request({ "__Host-did": device.value, "__Host-session": "session-cookie-value" }));
    expect(ids()).toEqual(["pages.session", "pages.ip"]);
    // The raw value goes to limitKey(), which stores its peppered HMAC only.
    expect(store.calls[0]?.key).toBe("session-cookie-value");
  });

  it("exempts verified bots without consuming anything", async () => {
    store.outcomes.set("pages.ip", LIMITED);
    await expect(checkPageLimits(request({}, { "x-verified-bot": "1" }))).resolves.toEqual({ kind: "allow" });
    expect(store.calls).toEqual([]);
    // Any other value is a client header, not Cloudflare's.
    await expect(checkPageLimits(request({}, { "x-verified-bot": "true" }))).resolves.toMatchObject({ kind: "challenge" });
  });

  it("sends a visitor over any limit to the challenge when it holds no pass", async () => {
    store.outcomes.set("pages.device", LIMITED);
    const device = newDeviceCookie();
    await expect(checkPageLimits(request({ "__Host-did": device.value }))).resolves.toEqual({ kind: "challenge", retryAfterSeconds: 90 });
    store.outcomes.clear();
    store.outcomes.set("pages.ip", { ok: false, reason: "limited", retryAfterSeconds: 400 });
    await expect(checkPageLimits(request())).resolves.toEqual({ kind: "challenge", retryAfterSeconds: 400 });
    expect(ids()).not.toContain("pages.passed.device");
  });

  it("lets a valid pass through within its own allowance, then answers limited", async () => {
    store.outcomes.set("pages.ip", LIMITED);
    const device = newDeviceCookie();
    const pass = /^__Host-tsv=([^;]+)/.exec(await challengePassCookie(device.id))?.[1] ?? "";
    const withPass = request({ "__Host-did": device.value, "__Host-tsv": pass });
    await expect(checkPageLimits(withPass)).resolves.toEqual({ kind: "allow" });
    expect(store.calls.at(-1)).toEqual({ id: "pages.passed.device", key: `d:${device.id}` });
    store.outcomes.set("pages.passed.device", { ok: false, reason: "limited", retryAfterSeconds: 1200 });
    await expect(checkPageLimits(withPass)).resolves.toEqual({ kind: "limited", retryAfterSeconds: 1200 });
    // A pass of another device does not count.
    const other = newDeviceCookie();
    await expect(checkPageLimits(request({ "__Host-did": other.value, "__Host-tsv": pass }))).resolves.toMatchObject({ kind: "challenge" });
  });

  it("stays open when the store is down", async () => {
    for (const id of ["pages.device", "pages.session", "pages.ip", "pages.passed.device"]) store.outcomes.set(id, DOWN);
    const device = newDeviceCookie();
    await expect(checkPageLimits(request({ "__Host-did": device.value }))).resolves.toEqual({ kind: "allow" });
    await expect(checkPageLimits(request({ "__Host-session": "s" }))).resolves.toEqual({ kind: "allow" });
    // Limited, then the pass allowance cannot be counted: open as well.
    store.outcomes.set("pages.ip", LIMITED);
    const pass = /^__Host-tsv=([^;]+)/.exec(await challengePassCookie(device.id))?.[1] ?? "";
    await expect(checkPageLimits(request({ "__Host-did": device.value, "__Host-tsv": pass }))).resolves.toEqual({ kind: "allow" });
  });
});

describe("429 page", () => {
  it("is a small localized page whose only inline style matches its CSP hash", () => {
    const fr = tooManyPagesHtml("fr");
    const ar = tooManyPagesHtml("ar");
    expect(fr).toContain('lang="fr" dir="ltr"');
    expect(ar).toContain('lang="ar" dir="rtl"');
    expect(tooManyPagesHtml("rif")).toContain('href="/rif"');
    expect(fr).not.toContain("<script");
    expect(fr.length).toBeLessThan(2048);
    const style = /<style>([^<]*)<\/style>/.exec(fr)?.[1] ?? "";
    const hash = createHash("sha256").update(style).digest("base64");
    expect(TOO_MANY_CSP).toContain(`'sha256-${hash}'`);
    expect(TOO_MANY_CSP).toContain("default-src 'none'");
  });
});
