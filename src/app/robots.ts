import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { LOCALES, PRIVATE_SEGMENTS } from "@/config/site";

// Per request: one image serves staging and production, so APP_ENV is read at runtime.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = ((await headers()).get("host") ?? "").toLowerCase().split(":")[0];
  const adminHost = (process.env.ADMIN_HOST ?? "").toLowerCase();
  if (process.env.APP_ENV !== "prod" || (adminHost && host === adminHost)) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  const privatePaths = LOCALES.flatMap((locale) => PRIVATE_SEGMENTS.map((segment) => `/${locale}/${segment}`));
  return { rules: { userAgent: "*", allow: "/", disallow: ["/api/", ...privatePaths] } };
}
