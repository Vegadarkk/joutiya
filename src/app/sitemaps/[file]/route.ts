import { buildSitemapFile } from "@/lib/search/sitemaps";

// XML sitemaps (design D16): index.xml (/sitemap.xml rewrites here, next.config.ts), pages.xml,
// listings-{k}.xml. ISR: nothing at build (no engine in the Docker build), rendered on the first
// request, kept one hour. Reads no request header, so every file is cacheable; outside production
// (APP_ENV, read at render time) every file is a 404. Outside [locale]: the proxy never sees dotted
// paths, and the Cloudflare rule `sitemaps_verified_bots` (starts_with "/sitemap") lets bots only.

export const revalidate = 3600;

export function generateStaticParams(): { file: string }[] {
  return [];
}

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await context.params;
  const xml = await buildSitemapFile(file);
  if (xml === null) return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
