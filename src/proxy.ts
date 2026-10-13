// Edge of the app (§4): admin host routing, locale routing and the page CSP.
// NOT an authorization barrier (CVE-2025-29927): every route handler and protected layout
// runs its own guards. SSR rate limiting arrives in phase 4.

import { NextResponse, type NextRequest } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import { PRIVATE_SEGMENTS } from "@/config/site";
import { buildCsp, createNonce, INLINE_HASH_MARKER, type CspVariant } from "@/lib/security/csp";
import { coopFor } from "@/lib/security/headers";

const handleI18nRouting = createMiddleware(routing);

/** API paths served on the admin host; every other /api path answers 404 there. */
const ADMIN_HOST_API = /^\/api\/(admin(\/|$)|health$|csp-report$)/;

function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\.$/, "");
}

function notFound(): NextResponse {
  return new NextResponse("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function cspHeaderName(): string {
  return process.env.CSP_REPORT_ONLY === "true" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
}

function csp(variant: CspVariant, nonce?: string): string {
  return buildCsp({
    variant,
    nonce,
    dev: process.env.NODE_ENV === "development",
    mediaOrigin: process.env.NEXT_PUBLIC_MEDIA_BASE_URL,
    r2Origin: process.env.R2_S3_ENDPOINT,
    errorIngestOrigin: process.env.ERROR_INGEST_ORIGIN,
    reportPath: "/api/csp-report",
    // Deployed sites are https only; a production build served on http://127.0.0.1 (e2e) is not.
    upgradeInsecure: (process.env.NEXT_PUBLIC_SITE_URL ?? "").startsWith("https://"),
  });
}

/** Headers shared by every page response. */
function decorate(response: NextResponse, host: "public" | "admin", policy: string): NextResponse {
  response.headers.set(cspHeaderName(), policy);
  response.headers.set("Cross-Origin-Opener-Policy", coopFor(host));
  response.headers.set("Reporting-Endpoints", 'csp="/api/csp-report"');
  if (host === "admin" || process.env.APP_ENV !== "prod") {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return response;
}

/**
 * Forwards the request to the app with extra request headers (the nonce and the CSP, read by
 * Next.js to stamp its scripts), keeping what the locale routing decided: rewrite target,
 * request header overrides, cookies and response headers.
 */
function forwardWithNonce(routed: NextResponse, request: NextRequest, policy: string, nonce: string): NextResponse {
  const headers = new Headers(request.headers);
  const overridden = routed.headers.get("x-middleware-override-headers");
  if (overridden) {
    for (const name of overridden.split(",")) {
      const value = routed.headers.get(`x-middleware-request-${name}`);
      if (value !== null) headers.set(name, value);
    }
  }
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);

  const rewrite = routed.headers.get("x-middleware-rewrite");
  const response = rewrite
    ? NextResponse.rewrite(new URL(rewrite, request.url), { request: { headers } })
    : NextResponse.next({ request: { headers } });
  routed.headers.forEach((value, key) => {
    if (!key.startsWith("x-middleware-") && key !== "set-cookie") response.headers.set(key, value);
  });
  for (const cookie of routed.cookies.getAll()) response.cookies.set(cookie);
  return response;
}

function adminHost(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/")) return ADMIN_HOST_API.test(pathname) ? NextResponse.next() : notFound();

  const nonce = createNonce();
  const policy = csp("private", nonce);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const url = request.nextUrl.clone();
  url.pathname = pathname === "/" ? "/admin" : `/admin${pathname}`;
  return decorate(NextResponse.rewrite(url, { request: { headers } }), "admin", policy);
}

function isPrivatePath(pathname: string): boolean {
  // "/fr/connexion/..." -> ["", "fr", "connexion", ...]
  const segment = pathname.split("/")[2] ?? "";
  return PRIVATE_SEGMENTS.includes(segment);
}

export function proxy(request: NextRequest): NextResponse {
  const host = normalizeHost(request.headers.get("host"));
  const adminHostName = normalizeHost(process.env.ADMIN_HOST);
  if (adminHostName && host === adminHostName) return adminHost(request);

  const { pathname } = request.nextUrl;
  // The back office only exists on the admin host (§4).
  if (/^\/(api\/)?admin(\/|$)/.test(pathname)) return notFound();
  if (pathname.startsWith("/api/")) return NextResponse.next();

  const routed = handleI18nRouting(request);
  if (routed.status >= 300 && routed.status < 400) return routed;

  if (isPrivatePath(pathname)) {
    const nonce = createNonce();
    const policy = csp("private", nonce);
    return decorate(forwardWithNonce(routed, request, policy, nonce), "public", policy);
  }
  // Fallback policy; the server hook swaps 'unsafe-inline' for the hashes of this HTML.
  const response = decorate(routed, "public", csp("public"));
  response.headers.set(INLINE_HASH_MARKER, "1");
  return response;
}

export const config = {
  // Everything but build assets and files with an extension (brand images, robots.txt). Page
  // slugs must never contain a dot (phase 3 slug rules), or they would skip the CSP set here.
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
};
