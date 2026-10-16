// Edge of the app (§4): admin host routing, locale routing, the page CSP and the page-view
// limits of the server-rendered pages (§6, design D14).
// NOT an authorization barrier (CVE-2025-29927): every route handler and protected layout
// runs its own guards.

import { NextResponse, type NextRequest } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import { PRIVATE_SEGMENTS } from "@/config/site";
import { DEVICE_COOKIE, setDeviceCookie } from "@/lib/security/cookies";
import { buildCsp, createNonce, INLINE_HASH_MARKER, type CspVariant } from "@/lib/security/csp";
import { PINNED_SCRIPT_HASHES } from "@/lib/security/inline-hashes";
import { newDeviceCookie, readDeviceId } from "@/lib/security/device";
import { coopFor } from "@/lib/security/headers";
import { checkPageLimits, isMeteredPath, pathLocale, tooManyPagesHtml, TOO_MANY_CSP } from "@/lib/rate-limit/proxy-limits";
import { challengeUrlPath } from "@/lib/security/challenge-path";

const handleI18nRouting = createMiddleware(routing);

/** API paths served on the admin host; every other /api path answers 404 there. */
const ADMIN_HOST_API = /^\/api\/(admin(\/|$)|health$|csp-report$)/;

/** Host without port or trailing dot ("admin.localhost:3100" in e2e, "admin.joutiya.ma" deployed). */
function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

function notFound(): NextResponse {
  return new NextResponse("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Origin of the Sentry ingest host named by the DSN (connect-src), or undefined. */
function sentryOrigin(dsn: string | undefined): string | undefined {
  if (!dsn) return undefined;
  try {
    return new URL(dsn).origin;
  } catch {
    return undefined;
  }
}

function cspHeaderName(): string {
  return process.env.CSP_REPORT_ONLY === "true" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
}

function csp(variant: CspVariant, nonce?: string, scriptHashes?: readonly string[]): string {
  return buildCsp({
    variant,
    nonce,
    scriptHashes,
    dev: process.env.NODE_ENV === "development",
    mediaOrigin: process.env.MEDIA_BASE_URL,
    r2Origin: process.env.R2_S3_ENDPOINT,
    tilesOrigin: process.env.MAP_PMTILES_URL,
    errorIngestOrigin: sentryOrigin(process.env.SENTRY_DSN),
    authEmulatorOrigin: process.env.FIREBASE_AUTH_EMULATOR_HOST ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}` : undefined,
    reportPath: "/api/csp-report",
    // Deployed sites are https only; a production build served on http://127.0.0.1 (e2e) is not.
    upgradeInsecure: (process.env.SITE_URL ?? "").startsWith("https://"),
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
  // Read by the (account) layout to send an anonymous visitor back here after sign-in.
  headers.set("x-pathname", `${request.nextUrl.pathname}${request.nextUrl.search}`);

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

/** Second path segment: "/fr/connexion/..." -> "connexion". */
function pageSegment(pathname: string): string {
  return pathname.split("/")[2] ?? "";
}

function isPrivatePath(pathname: string): boolean {
  return PRIVATE_SEGMENTS.includes(pageSegment(pathname));
}

/**
 * Public pages rendered per request and streamed (Suspense): React's inline streaming scripts
 * ($RC...) change with every response and match no framework shape of the hash CSP, so these
 * pages take the nonce CSP of private pages. They are never cached anyway. Their layout is the
 * public one, whose theme script has no nonce: its pinned hash is allowed instead.
 */
const DYNAMIC_PUBLIC_SEGMENTS: readonly string[] = ["recherche"];

/** Device cookie as a raw header: the cookies API would also write back a removed locale cookie. */
function appendDeviceCookie(response: NextResponse): void {
  const device = new NextResponse(null);
  setDeviceCookie(device, newDeviceCookie().value);
  for (const cookie of device.headers.getSetCookie()) response.headers.append("set-cookie", cookie);
}

/**
 * Over the page-view limits (D14): without a pass, GET and HEAD go to the Turnstile page (302);
 * otherwise a small 429 page. Never cached (Cloudflare would cache a bare 302 for 20 minutes).
 */
async function pageLimitResponse(request: NextRequest): Promise<NextResponse | null> {
  const decision = await checkPageLimits(request);
  if (decision.kind === "allow") return null;
  const locale = pathLocale(request.nextUrl.pathname) ?? "fr";
  if (decision.kind === "challenge" && (request.method === "GET" || request.method === "HEAD")) {
    const target = new URL(challengeUrlPath(locale, `${request.nextUrl.pathname}${request.nextUrl.search}`), request.url);
    const response = NextResponse.redirect(target, 302);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  return new NextResponse(tooManyPagesHtml(locale), {
    status: 429,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": String(Math.max(1, decision.retryAfterSeconds)),
      "Content-Security-Policy": TOO_MANY_CSP,
      "X-Robots-Tag": "noindex",
    },
  });
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const host = normalizeHost(request.headers.get("host"));
  const adminHostName = normalizeHost(process.env.ADMIN_HOST);
  if (adminHostName && host === adminHostName) return adminHost(request);

  const { pathname } = request.nextUrl;
  // The back office only exists on the admin host (§4).
  if (/^\/(api\/)?admin(\/|$)/.test(pathname)) return notFound();
  if (pathname.startsWith("/api/")) return NextResponse.next();

  const routed = handleI18nRouting(request);
  if (routed.status >= 300 && routed.status < 400) return routed;

  // Category pages take no query (D15): `?x=` would bypass the edge cache, so it goes to the clean
  // path. Next strips `_rsc` from nextUrl before the proxy, so client navigations never loop here.
  if (pageSegment(pathname) === "c" && request.nextUrl.search) {
    const clean = request.nextUrl.clone();
    clean.search = "";
    return NextResponse.redirect(clean, 308);
  }

  // Page-view limits (D14). RSC and prefetch requests count too: a scraper can send `RSC: 1`.
  if (isMeteredPath(pathname)) {
    const limited = await pageLimitResponse(request);
    if (limited) return limited;
  }

  const dynamicPublic = DYNAMIC_PUBLIC_SEGMENTS.includes(pageSegment(pathname));
  if (isPrivatePath(pathname) || dynamicPublic) {
    const nonce = createNonce();
    const policy = csp("private", nonce, dynamicPublic ? [...PINNED_SCRIPT_HASHES] : undefined);
    const response = decorate(forwardWithNonce(routed, request, policy, nonce), "public", policy);
    if (dynamicPublic) {
      // Like shared pages, no locale cookie. The device cookie makes the per-device search limits
      // apply (D13) instead of the anonymous bucket of the IP.
      response.headers.delete("set-cookie");
      if (!readDeviceId(request.cookies.get(DEVICE_COOKIE)?.value)) appendDeviceCookie(response);
      return response;
    }
    // The device cookie exists before the first API call: sign-up and sign-in limits are counted
    // per device, and a browser without the cookie would share the anonymous bucket of its IP
    // (src/lib/rate-limit/keys.ts). Private pages are dynamic, so the cookie costs no cache.
    if (!readDeviceId(request.cookies.get(DEVICE_COOKIE)?.value)) setDeviceCookie(response, newDeviceCookie().value);
    return response;
  }
  // Fallback policy; the server hook swaps 'unsafe-inline' for the hashes of this HTML.
  const response = decorate(routed, "public", csp("public"));
  response.headers.set(INLINE_HASH_MARKER, "1");
  // Shared pages carry no cookie, so Cloudflare can cache them. The locale cookie is written by
  // the locale switcher (next-intl Link) and still read here for the "/" redirect.
  response.headers.delete("set-cookie");
  return response;
}

export const config = {
  // Everything but build assets and files with an extension (brand images, robots.txt). Page
  // slugs must never contain a dot (phase 3 slug rules), or they would skip the CSP set here.
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
};
