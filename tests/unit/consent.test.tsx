import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { ConsentBanner } from "@/components/consent/consent-banner";
import { ConsentLink } from "@/components/consent/consent-link";
import { ConsentProvider } from "@/components/consent/consent-provider";
import { applyConsentMode, consentModeState } from "@/lib/consent/consent-mode";
import { CONSENT_MAX_AGE_S, consentCookieString, normalizeChoice, parseConsent, readConsentCookie, serializeConsent } from "@/lib/consent/cookie";
import { isEeaUkCh, traceCountry } from "@/lib/consent/region";
import { PUBLIC_CLIENT_NAMESPACES } from "@/i18n/client-messages";

// Cookie consent (phase 6, D1-D5): the stored choice, Consent Mode signals, region rule, banner.

const NOW = 1_793_000_000;

describe("jt_consent cookie", () => {
  it("round-trips a choice and keeps personalisation under ads", () => {
    const choice = normalizeChoice(true, true, NOW);
    expect(parseConsent(serializeConsent(choice), NOW)).toEqual({ ads: true, perso: true, t: NOW });
    expect(normalizeChoice(false, true, NOW).perso).toBe(false);
    expect(serializeConsent(choice)).toMatch(/^1\.[A-Za-z0-9_-]+$/);
  });

  it("is no choice when missing, malformed, of another version, expired or dated in the future", () => {
    const value = serializeConsent(normalizeChoice(false, false, NOW));
    expect(parseConsent(undefined, NOW)).toBeNull();
    expect(parseConsent("garbage", NOW)).toBeNull();
    expect(parseConsent(`2.${value.slice(2)}`, NOW)).toBeNull();
    expect(parseConsent("1.e30", NOW)).toBeNull();
    expect(parseConsent(value, NOW + CONSENT_MAX_AGE_S - 1)).not.toBeNull();
    expect(parseConsent(value, NOW + CONSENT_MAX_AGE_S + 1)).toBeNull();
    expect(parseConsent(value, NOW - 2 * 24 * 60 * 60)).toBeNull();
  });

  it("is written for six months, site-wide, Lax and Secure over HTTPS", () => {
    const cookie = consentCookieString(normalizeChoice(true, false, NOW), true);
    expect(cookie).toMatch(/^jt_consent=1\.[\w-]+; Max-Age=15724800; Path=\/; SameSite=Lax; Secure$/);
    expect(consentCookieString(normalizeChoice(true, false, NOW), false)).not.toContain("Secure");
    expect(readConsentCookie(`theme=dark; ${cookie.split(";")[0]}; NEXT_LOCALE=fr`)).toBe(cookie.split(";")[0]!.slice("jt_consent=".length));
  });
});

describe("Consent Mode v2", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("denies everything by default, then grants what the choice allows", () => {
    expect(consentModeState(null)).toEqual({ ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" });
    expect(consentModeState(normalizeChoice(true, false, NOW))).toMatchObject({ ad_storage: "granted", ad_personalization: "denied", ad_user_data: "denied" });
    const win: { dataLayer?: unknown[]; gtag?: unknown } = {};
    vi.stubGlobal("window", win);
    applyConsentMode(normalizeChoice(true, true, NOW));
    const calls = win.dataLayer!.map((entry) => Array.from(entry as ArrayLike<unknown>));
    expect(calls[0]).toEqual(["consent", "default", { ...consentModeState(null), wait_for_update: 500 }]);
    expect(calls[1]).toEqual(["consent", "update", consentModeState(normalizeChoice(true, true, NOW))]);
  });
});

describe("visitor region", () => {
  it("reads Cloudflare's trace and treats unknown as EEA/UK/CH", () => {
    expect(traceCountry("fl=1\nip=1.2.3.4\nloc=MA\ntls=TLSv1.3\n")).toBe("MA");
    expect(traceCountry("ip=1.2.3.4\n")).toBeNull();
    expect(isEeaUkCh("MA")).toBe(false);
    expect(isEeaUkCh("FR")).toBe(true);
    expect(isEeaUkCh("GB")).toBe(true);
    expect(isEeaUkCh("CH")).toBe(true);
    expect(isEeaUkCh(null)).toBe(true);
  });
});

function render(node: ReactNode, locale: "fr" | "ar" = "fr"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ar" ? ar : fr}
      timeZone="Africa/Casablanca"
      onError={(error) => {
        throw error;
      }}
    >
      <ConsentProvider>{node}</ConsentProvider>
    </NextIntlClientProvider>,
  );
}

describe("consent banner", () => {
  it("offers accept, refuse and customise with the same size and style", () => {
    const html = render(<ConsentBanner />);
    const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)<\/button>/g)];
    expect(buttons.map((match) => match[2])).toEqual([fr.Consent.acceptAll, fr.Consent.refuseAll, fr.Consent.customize]);
    expect(new Set(buttons.map((match) => match[1])).size).toBe(1);
  });

  it("names Google LLC, the United States and the express consent to the transfer, in French and Arabic", () => {
    expect(render(<ConsentBanner />)).toContain("Google LLC (États-Unis)");
    expect(render(<ConsentBanner />)).toContain("art. 44");
    const arabic = render(<ConsentBanner />, "ar");
    expect(arabic).toContain("Google LLC");
    expect(arabic).toContain("09.08");
    expect(arabic).toContain("Aalan");
  });

  it("renders nothing on the server: the choice is read in the browser, so static pages stay static", () => {
    expect(render(<p>page</p>)).toBe("<p>page</p>");
  });
});

describe("footer link", () => {
  it("is a button that reopens the panel, on every page through the public namespaces", () => {
    expect(render(<ConsentLink />)).toMatch(/^<button type="button"[^>]*>Gérer mes cookies<\/button>$/);
    expect(PUBLIC_CLIENT_NAMESPACES).toContain("Consent");
  });
});
