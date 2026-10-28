import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { CANONICAL_ORIGIN, LOCALES, PRIVATE_SEGMENTS } from "@/config/site";

// Per request: one image serves staging and production, so APP_ENV is read at runtime.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = ((await headers()).get("host") ?? "").toLowerCase().split(":")[0];
  const adminHost = (process.env.ADMIN_HOST ?? "").toLowerCase();
  if (process.env.APP_ENV !== "prod" || (adminHost && host === adminHost)) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  // Exact segment, its subpaths and its query variants: a bare prefix would also block public pages
  // that start alike ("/fr/pro" matched "/fr/profil/...").
  const privatePaths = LOCALES.flatMap((locale) => PRIVATE_SEGMENTS.flatMap((segment) => [`/${locale}/${segment}$`, `/${locale}/${segment}/`, `/${locale}/${segment}?`]));
  // Internal search results stay out of crawling (design D16: Google prefers robots.txt for them);
  // the category landing pages (/c/...) are the crawlable entry points.
  const searchPaths = LOCALES.map((locale) => `/${locale}/recherche`);
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/api/", ...privatePaths, ...searchPaths] },
      // AdSense's crawler reads the pages that carry ads, search results included (phase 6, D9).
      { userAgent: "Mediapartners-Google", allow: "/", disallow: ["/api/", ...privatePaths] },
    ],
    sitemap: `${CANONICAL_ORIGIN}/sitemap.xml`,
  };
}
