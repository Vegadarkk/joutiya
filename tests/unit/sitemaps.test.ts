import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { subcategoryById } from "@/config/categories";
import { cityBySlug } from "@/config/regions";
import { parseEnv, resetServerEnv, type ServerEnv } from "@/lib/env";
import { resetSearchEngine, setSearchEngineForTests } from "@/lib/search/engine";
import { MemoryEngine } from "@/lib/search/memory";
import { buildSitemapFile, escapeXml, parseSitemapFile, SITEMAP_LISTINGS_MAX, urlEntries } from "@/lib/search/sitemaps";
import { SITEMAP_SHARDS, sitemapShardOf, type SearchDocument } from "@/lib/search/types";
import { GET } from "@/app/sitemaps/[file]/route";

// XML sitemaps (design D16): files, escaping, shards, hreflang alternates, production only.

const PROD = { ...parseEnv({ APP_ENV: "dev" }).env, APP_ENV: "prod" } as ServerEnv;
const STAGING = { ...PROD, APP_ENV: "staging" } as ServerEnv;
const UPDATED = Date.UTC(2026, 9, 1, 8, 30, 0);

function doc(id: string, subcategoryId: string, citySlug: string, slugId = `annonce-${id}`): SearchDocument {
  const sub = subcategoryById(subcategoryId);
  const city = cityBySlug(citySlug);
  if (!sub || !city) throw new Error("fixture");
  return {
    id,
    slugId,
    title: "Annonce",
    description: "",
    categoryText: "",
    placeText: "",
    attrsText: "",
    categoryId: sub.categoryId,
    subcategoryId,
    regionCode: city.regionCode,
    citySlug,
    sellerType: "individual",
    sellerPublicId: "abcdefghjk",
    priceNegotiable: false,
    isDonation: false,
    hasPhoto: false,
    photoCount: 0,
    sortAt: UPDATED,
    updatedAt: UPDATED,
    sitemapShard: sitemapShardOf(id),
    isBumped: false,
    _geo: { lat: city.lat, lng: city.lng },
    version: 1,
  };
}

/** Listing ids (8 characters of the listing alphabet) spread over the shards. */
function ids(count: number): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: count }, (_, n) => {
    let value = n + 1;
    let id = "";
    for (let i = 0; i < 8; i += 1) {
      id += alphabet[value % alphabet.length];
      value = Math.floor(value / alphabet.length);
    }
    return id;
  });
}

let engine: MemoryEngine;

beforeEach(async () => {
  process.env.APP_ENV = "dev";
  resetServerEnv();
  engine = new MemoryEngine({ synonyms: {} });
  setSearchEngineForTests(engine);
});
afterEach(() => {
  resetSearchEngine();
  resetServerEnv();
});

describe("sitemap files", () => {
  it("knows the index, the pages file and one file per shard", () => {
    expect(parseSitemapFile("index.xml")).toEqual({ kind: "index" });
    expect(parseSitemapFile("pages.xml")).toEqual({ kind: "pages" });
    expect(parseSitemapFile("listings-0.xml")).toEqual({ kind: "listings", shard: 0 });
    expect(parseSitemapFile(`listings-${SITEMAP_SHARDS - 1}.xml`)).toEqual({ kind: "listings", shard: SITEMAP_SHARDS - 1 });
    for (const file of [`listings-${SITEMAP_SHARDS}.xml`, "listings-01.xml", "listings--1.xml", "listings-1", "index", "sitemap.xml", "pages.xml.gz", "../index.xml", ""]) {
      expect(parseSitemapFile(file), file).toBeNull();
    }
  });

  it("escapes XML special characters", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });

  it("writes fr and ar URLs, each with the whole hreflang cluster, x-default and lastmod", () => {
    const [fr, ar] = urlEntries("/annonce/velo-a&b-abcd2345", UPDATED);
    expect(fr).toContain("<loc>https://joutiya.ma/fr/annonce/velo-a&amp;b-abcd2345</loc>");
    expect(ar).toContain("<loc>https://joutiya.ma/ar/annonce/velo-a&amp;b-abcd2345</loc>");
    for (const entry of [fr, ar]) {
      expect(entry).toContain("<lastmod>2026-10-01T08:30:00.000Z</lastmod>");
      expect(entry).toContain('<xhtml:link rel="alternate" hreflang="fr-MA" href="https://joutiya.ma/fr/annonce/velo-a&amp;b-abcd2345"/>');
      expect(entry).toContain('<xhtml:link rel="alternate" hreflang="ar-MA" href="https://joutiya.ma/ar/annonce/velo-a&amp;b-abcd2345"/>');
      expect(entry).toContain('<xhtml:link rel="alternate" hreflang="x-default" href="https://joutiya.ma/fr/annonce/velo-a&amp;b-abcd2345"/>');
      expect(entry).not.toContain("/rif/");
    }
    expect(urlEntries("")[0]).toBe(
      '<url><loc>https://joutiya.ma/fr</loc><xhtml:link rel="alternate" hreflang="fr-MA" href="https://joutiya.ma/fr"/><xhtml:link rel="alternate" hreflang="ar-MA" href="https://joutiya.ma/ar"/><xhtml:link rel="alternate" hreflang="x-default" href="https://joutiya.ma/fr"/></url>',
    );
  });
});

describe("buildSitemapFile", () => {
  it("serves nothing outside production", async () => {
    await engine.upsert([doc("a2345678", "voitures", "casablanca")]);
    for (const file of ["index.xml", "pages.xml", `listings-${sitemapShardOf("a2345678")}.xml`]) {
      await expect(buildSitemapFile(file, STAGING), file).resolves.toBeNull();
    }
    await expect(buildSitemapFile("unknown.xml", PROD)).resolves.toBeNull();
  });

  it("indexes the pages file and the non-empty shards only", async () => {
    const all = ids(40);
    await engine.upsert(all.map((id) => doc(id, "voitures", "casablanca")));
    const shards = [...new Set(all.map(sitemapShardOf))].sort((a, b) => a - b);
    const xml = (await buildSitemapFile("index.xml", PROD)) ?? "";
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(locs).toEqual(["https://joutiya.ma/sitemaps/pages.xml", ...shards.map((shard) => `https://joutiya.ma/sitemaps/listings-${shard}.xml`)]);
    expect(shards.length).toBeLessThan(SITEMAP_SHARDS + 1);
  });

  it("lists each listing of a shard once per locale, with its lastmod; empty shards are 404s", async () => {
    const all = ids(60);
    await engine.upsert(all.map((id) => doc(id, "voitures", "casablanca")));
    const shard = sitemapShardOf(all[0] ?? "");
    const mine = all.filter((id) => sitemapShardOf(id) === shard);
    const xml = (await buildSitemapFile(`listings-${shard}.xml`, PROD)) ?? "";
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(locs.sort()).toEqual(mine.flatMap((id) => [`https://joutiya.ma/fr/annonce/annonce-${id}`, `https://joutiya.ma/ar/annonce/annonce-${id}`]).sort());
    expect(xml.match(/<lastmod>2026-10-01T08:30:00.000Z<\/lastmod>/g)).toHaveLength(mine.length * 2);
    const empty = Array.from({ length: SITEMAP_SHARDS }, (_, k) => k).find((k) => !all.some((id) => sitemapShardOf(id) === k));
    if (empty !== undefined) await expect(buildSitemapFile(`listings-${empty}.xml`, PROD)).resolves.toBeNull();
    // Each listing is one URL per locale: a file stays under Google's 50 000 URLs.
    expect(SITEMAP_LISTINGS_MAX * 2).toBeLessThanOrEqual(50_000);
  });

  it("lists home and the landing pages with at least 3 listings", async () => {
    await engine.upsert([
      // vehicules/voitures: 3 in Casablanca, 1 in Rabat; vehicules/velos: 2 in Casablanca.
      doc("a2345678", "voitures", "casablanca"),
      doc("b2345678", "voitures", "casablanca"),
      doc("c2345678", "voitures", "casablanca"),
      doc("d2345678", "voitures", "rabat"),
      doc("e2345678", "velos", "casablanca"),
      doc("f2345678", "velos", "casablanca"),
      // immobilier: 2 listings only.
      doc("g2345678", "vente", "rabat"),
      doc("h2345678", "location", "rabat"),
    ]);
    const xml = (await buildSitemapFile("pages.xml", PROD)) ?? "";
    const paths = [...xml.matchAll(/<loc>https:\/\/joutiya\.ma\/fr([^<]*)<\/loc>/g)].map((match) => match[1]);
    expect(paths.sort()).toEqual(["", "/c/vehicules", "/c/vehicules/casablanca", "/c/vehicules/voitures", "/c/vehicules/voitures/casablanca"].sort());
    expect(xml.match(/<url>/g)).toHaveLength(paths.length * 2);
  });
});

describe("GET /sitemaps/[file]", () => {
  it("answers XML in production and 404 elsewhere", async () => {
    await engine.upsert([doc("a2345678", "voitures", "casablanca")]);
    const call = (file: string) => GET(new Request(`https://joutiya.ma/sitemaps/${file}`), { params: Promise.resolve({ file }) });
    const notFound = await call("index.xml");
    expect(notFound.status).toBe(404);
    process.env.APP_ENV = "prod";
    resetServerEnv();
    const ok = await call("index.xml");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await ok.text()).toContain("<sitemapindex");
    expect((await call("nope.xml")).status).toBe(404);
  });
});
