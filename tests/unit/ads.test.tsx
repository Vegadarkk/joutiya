import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import rif from "../../messages/rif.json";
import { GET as adsTxt } from "@/app/ads.txt/route";
import { AdSlot } from "@/components/ads/ad-slot";
import { infeedPositions } from "@/config/ads";
import { DEFAULT_FLAGS } from "@/config/flags";
import { availablePromos, HOUSE_PROMOS, pickPromo } from "@/config/house-promos";
import { SITE_NAME, type Locale } from "@/config/site";
import { adRequest, type AdVisitor } from "@/lib/ads/policy";
import type { PublicAdsConfig } from "@/lib/config/public-types";
import { resetServerEnv } from "@/lib/env";
import { buildCsp } from "@/lib/security/csp";
import { withScriptHashes } from "@/lib/security/inline-hashes";

// Advertising (phase 6, D4-D10): who may get an ad, the slots' server markup, ads.txt and the CSP.

const ADS: PublicAdsConfig = {
  mode: "live",
  cmpEea: false,
  client: "ca-pub-0000000000000001",
  units: { leaderboard: "1000000001", halfpage: "1000000002", rectangle: "1000000003", banner: null },
};
const ACCEPTED = { ads: true, perso: true, t: 1_790_000_000 };
const visitor = (overrides: Partial<AdVisitor> = {}): AdVisitor => ({ ads: ADS, env: "prod", choice: ACCEPTED, country: "MA", ...overrides });

describe("adRequest", () => {
  it("asks for an ad in production for a visitor outside the EEA who accepted, personalised or not", () => {
    expect(adRequest("rectangle", visitor())).toEqual({ client: ADS.client, unit: "1000000003", test: false, npa: 0 });
    expect(adRequest("rectangle", visitor({ choice: { ...ACCEPTED, perso: false } }))?.npa).toBe(1);
  });

  it("sends no request without a choice or after a refusal (house promotion instead)", () => {
    expect(adRequest("rectangle", visitor({ choice: null }))).toBeNull();
    expect(adRequest("rectangle", visitor({ choice: { ads: false, perso: false, t: 1 } }))).toBeNull();
    // Google's message covers EEA visitors, but a refusal in our own panel still wins.
    expect(adRequest("rectangle", visitor({ country: "FR", ads: { ...ADS, cmpEea: true }, choice: { ads: false, perso: false, t: 1 } }))).toBeNull();
  });

  it("keeps EEA/UK/CH visitors, and unknown ones, on house promotions until Google's message covers them", () => {
    for (const country of ["FR", "GB", "CH", null]) expect(adRequest("rectangle", visitor({ country })), String(country)).toBeNull();
    const covered = adRequest("rectangle", visitor({ country: "FR", choice: null, ads: { ...ADS, cmpEea: true } }));
    expect(covered).toEqual({ client: ADS.client, unit: "1000000003", test: false, npa: undefined });
  });

  it("runs live ads only in production, test ads anywhere, nothing when off or unconfigured", () => {
    expect(adRequest("rectangle", visitor({ env: "staging" }))).toBeNull();
    expect(adRequest("rectangle", visitor({ env: "staging", ads: { ...ADS, mode: "test" } }))?.test).toBe(true);
    expect(adRequest("rectangle", visitor({ ads: { ...ADS, mode: "off" } }))).toBeNull();
    expect(adRequest("rectangle", visitor({ ads: { ...ADS, client: null } }))).toBeNull();
    expect(adRequest("banner", visitor())).toBeNull();
  });
});

describe("placements and house promotions", () => {
  it("puts in-feed slots after the 6th card, then every 10th, 3 at most, never after the last card", () => {
    expect(infeedPositions(6)).toEqual([]);
    expect(infeedPositions(7)).toEqual([6]);
    expect(infeedPositions(17)).toEqual([6, 16]);
    expect(infeedPositions(60)).toEqual([6, 16, 26]);
  });

  it("offers Pro while the Pro sign-up is open and the boost only once sales are open", () => {
    const ids = (flags: typeof DEFAULT_FLAGS) => availablePromos(flags).map((promo) => promo.id);
    expect(ids(DEFAULT_FLAGS)).toEqual(["post", "alert", "safety", "pro"]);
    expect(ids({ ...DEFAULT_FLAGS, proSignupEnabled: false, salesEnabled: true })).toEqual(["post", "alert", "safety", "boost"]);
  });

  it("picks the same promotion for the same key", () => {
    expect(pickPromo(HOUSE_PROMOS, "listing-bottom:abcd2345")).toBe(pickPromo(HOUSE_PROMOS, "listing-bottom:abcd2345"));
  });

  it("has every promotion's texts in French and Arabic", () => {
    for (const { id } of HOUSE_PROMOS) {
      for (const messages of [fr, ar]) expect(Object.keys(messages.Ads.promos[id])).toEqual(["title", "body", "cta"]);
    }
  });
});

function render(node: ReactNode, locale: Locale = "fr") {
  const messages = locale === "ar" ? ar : locale === "rif" ? { ...fr, ...rif } : fr;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

describe("AdSlot", () => {
  const promos = availablePromos(DEFAULT_FLAGS);

  it("renders the house promotion in a box of the unit's height plus its label, with no ad script", () => {
    const html = render(<AdSlot placement="listing-bottom" eligible promos={promos} seed="abcd2345" />);
    expect(html).toContain('data-ad-slot="listing-bottom"');
    expect(html).toContain('data-ad-state="promo"');
    expect(html).toContain('data-ad-eligible="true"');
    expect(html).toContain("height:270px");
    expect(html).toContain(`aria-label="${fr.Ads.promoLabel.replace("{brand}", SITE_NAME)}"`);
    expect(html).toContain(`>${SITE_NAME}</p>`);
    expect(html).not.toContain(">Publicité<");
    expect(html).toMatch(/href="\/fr\/(deposer|recherche|legal\/confiance-et-securite|pro)"/);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("adsbygoogle");
  });

  it("hides desktop-only slots below their breakpoint from the first paint", () => {
    const html = render(<AdSlot placement="home-leaderboard" eligible promos={promos} seed="home" />);
    expect(html).toContain("max-lg:hidden");
    expect(html).toContain("height:110px");
  });

  it("never makes a Tarifit page eligible (AdSense does not support the language)", () => {
    expect(render(<AdSlot placement="listing-bottom" eligible promos={promos} seed="x" />, "rif")).not.toContain("data-ad-eligible");
    expect(render(<AdSlot placement="listing-bottom" eligible promos={promos} seed="x" />, "ar")).toContain('data-ad-eligible="true"');
  });
});

describe("ads.txt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerEnv();
  });

  it("answers 404 until a publisher id is configured", async () => {
    vi.stubEnv("ADSENSE_CLIENT_ID", "");
    resetServerEnv();
    expect(adsTxt().status).toBe(404);
  });

  it("declares Google as the direct seller with the publisher id", async () => {
    vi.stubEnv("ADSENSE_CLIENT_ID", "ca-pub-0000000000000001");
    resetServerEnv();
    const response = adsTxt();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("google.com, pub-0000000000000001, DIRECT, f08c47fec0942fa0\n");
  });
});

describe("CSP with ads (D10)", () => {
  const directive = (policy: string, name: string) => policy.split("; ").find((part) => part.startsWith(`${name} `)) ?? "";

  it("lists no ad host before AdSense is configured", () => {
    expect(buildCsp({ variant: "public" })).not.toContain("googlesyndication");
  });

  it("strict: the listed hosts only; broad: also any https image and frame for the creatives", () => {
    const strict = buildCsp({ variant: "public", ads: "strict" });
    expect(directive(strict, "script-src")).toContain("https://pagead2.googlesyndication.com");
    expect(directive(strict, "frame-src")).toContain("https://googleads.g.doubleclick.net");
    expect(directive(strict, "frame-src").split(" ")).not.toContain("https:");
    const broad = buildCsp({ variant: "public", ads: "broad" });
    expect(directive(broad, "img-src").split(" ")).toContain("https:");
    expect(directive(broad, "frame-src").split(" ")).toContain("https:");
    expect(directive(broad, "script-src").split(" ")).not.toContain("https:");
  });

  it("keeps the ad script hosts when the hash hook rebuilds script-src", () => {
    const policy = withScriptHashes(buildCsp({ variant: "public", ads: "strict" }), ["abc="]);
    expect(directive(policy, "script-src")).toBe(
      "script-src 'self' 'sha256-abc=' https://challenges.cloudflare.com https://pagead2.googlesyndication.com https://tpc.googlesyndication.com https://*.adtrafficquality.google https://fundingchoicesmessages.google.com",
    );
    expect(directive(withScriptHashes(buildCsp({ variant: "public" }), ["abc="]), "script-src")).not.toContain("googlesyndication");
  });
});
