import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import robots from "@/app/robots";
import { breadcrumbJsonLd } from "@/lib/seo/jsonld";

// robots.txt (design D16) and the BreadcrumbList helper of the landing pages (D15).

const host = vi.hoisted(() => ({ value: "joutiya.ma" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: host.value }) }));

beforeEach(() => {
  host.value = "joutiya.ma";
  vi.stubEnv("ADMIN_HOST", "admin.joutiya.ma");
  vi.stubEnv("APP_ENV", "prod");
});
afterEach(() => vi.unstubAllEnvs());

describe("robots.txt", () => {
  it("names the sitemap and keeps internal search, private pages and the API out in production", async () => {
    const result = await robots();
    expect(result.sitemap).toBe("https://joutiya.ma/sitemap.xml");
    const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    expect(rules?.allow).toBe("/");
    const disallow = rules?.disallow ?? [];
    // Google's matching: prefix, `$` anchors the end (https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt).
    const blocked = (path: string) =>
      (disallow as string[]).some((rule) => (rule.endsWith("$") ? path === rule.slice(0, -1) : path.startsWith(rule)));
    for (const path of ["/api/search", "/fr/recherche", "/ar/recherche?q=velo", "/rif/recherche", "/fr/anti-robot?next=/fr", "/ar/favoris", "/rif/connexion", "/fr/pro", "/fr/pro/abonnement", "/fr/deposer/photos"]) {
      expect(blocked(path), path).toBe(true);
    }
    // Landing pages, listings and public profiles stay crawlable ("/fr/pro" must not catch "/fr/profil").
    for (const path of ["/fr", "/fr/c/vehicules/casablanca", "/ar/annonce/velo-abcd2345", "/fr/profil/abcdefghjk", "/ar/legal/cgu"]) {
      expect(blocked(path), path).toBe(false);
    }
  });

  it("lets AdSense's crawler read the search results, never the API or private pages (phase 6, D9)", async () => {
    const result = await robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const adsense = rules.find((rule) => rule.userAgent === "Mediapartners-Google");
    expect(adsense?.allow).toBe("/");
    const disallow = (adsense?.disallow ?? []) as string[];
    expect(disallow).toContain("/api/");
    expect(disallow).toContain("/fr/connexion$");
    const blocked = (path: string) => disallow.some((rule) => (rule.endsWith("$") ? path === rule.slice(0, -1) : path.startsWith(rule)));
    expect(blocked("/fr/recherche?q=velo")).toBe(false);
    expect(blocked("/fr/recherches")).toBe(true);
  });

  it("closes everything outside production and on the admin host, without a sitemap", async () => {
    vi.stubEnv("APP_ENV", "staging");
    expect(await robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    vi.stubEnv("APP_ENV", "prod");
    host.value = "admin.joutiya.ma:443";
    expect(await robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });
});

describe("breadcrumbJsonLd", () => {
  it("numbers the steps from 1 and lets the last one go without a URL", () => {
    expect(breadcrumbJsonLd([{ name: "Accueil", url: "https://joutiya.ma/fr" }, { name: "Véhicules", url: "https://joutiya.ma/fr/c/vehicules" }, { name: "Casablanca" }])).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Accueil", item: "https://joutiya.ma/fr" },
        { "@type": "ListItem", position: 2, name: "Véhicules", item: "https://joutiya.ma/fr/c/vehicules" },
        { "@type": "ListItem", position: 3, name: "Casablanca" },
      ],
    });
  });

  it("needs two steps (Google's minimum)", () => {
    expect(breadcrumbJsonLd([{ name: "Accueil", url: "https://joutiya.ma/fr" }])).toBeNull();
  });
});
