import "server-only";
import { createHash } from "node:crypto";
import { LOCALES, type Locale } from "@/config/site";
import type { RateLimitId } from "@/config/rate-limits";
import { readCookie } from "@/lib/http/cookies";
import { hasChallengePass } from "@/lib/security/challenge-pass";
import { SESSION_COOKIE } from "@/lib/security/cookies";
import { consumeLimit, type LimitOutcome } from "./core";
import { requestIdentity } from "./keys";
import { isLoadTestRequest } from "./loadtest";

// Page-view limits of the server-rendered pages (§6 table, design D14), checked in proxy.ts. The
// proxy bundle has its own module instances, so these limiters use their own valkey-ratelimit
// client (core.ts connects it). Visitor: 120/h per device; signed in: 600/h keyed by the session
// cookie (never verified here: a forged cookie only buys a bucket the IP limit still caps); always
// 1 200/h per IP /64, and 12 000/h per /48 for an IPv6 client. Over a limit: a valid challenge pass gets its own allowance, else the visitor
// is sent to the Turnstile page. Store down: open. Verified bots (Cloudflare header) are exempt.
// Committed values only (core.ts, not limiter.ts): the `config/abuse` overrides would put a
// Firestore client and its reads on the path of every page view, so `pages.*` overrides are ignored.

/** Second path segment of the metered pages: /{locale}/annonce/..., /c/..., /profil/..., /boutique/... */
export const METERED_SEGMENTS: readonly string[] = ["annonce", "c", "profil", "boutique"];

/** Set by a Cloudflare Transform Rule on every request (overwritten, so a client cannot forge it). */
export const VERIFIED_BOT_HEADER = "x-verified-bot";

const LOCALE_SET: ReadonlySet<string> = new Set(LOCALES);

/** Locale of a /{locale}/... path, or null. */
export function pathLocale(pathname: string): Locale | null {
  const segment = pathname.split("/")[1] ?? "";
  return LOCALE_SET.has(segment) ? (segment as Locale) : null;
}

export function isMeteredPath(pathname: string): boolean {
  const [, locale = "", segment = ""] = pathname.split("/");
  return LOCALE_SET.has(locale) && METERED_SEGMENTS.includes(segment);
}

export type PageLimitDecision =
  | { kind: "allow" }
  /** No pass: send the visitor to /{locale}/anti-robot. */
  | { kind: "challenge"; retryAfterSeconds: number }
  /** Pass allowance spent too: 429. */
  | { kind: "limited"; retryAfterSeconds: number };

function retryAfter(outcomes: LimitOutcome[]): number | null {
  let seconds: number | null = null;
  for (const outcome of outcomes) {
    if (!outcome.ok && outcome.reason === "limited") seconds = Math.max(seconds ?? 0, outcome.retryAfterSeconds);
  }
  return seconds;
}

/** Consumes the page-view limiters of this request and says what the proxy answers. */
export async function checkPageLimits(request: Request): Promise<PageLimitDecision> {
  // Verified bots (Cloudflare header) and the staging load test (loadtest.ts) are exempt.
  if (request.headers.get(VERIFIED_BOT_HEADER) === "1" || isLoadTestRequest(request.headers)) return { kind: "allow" };
  const identity = requestIdentity(request.headers);
  const session = readCookie(request.headers, SESSION_COOKIE);
  // A signed-in member counts on the session bucket instead of the visitor's device bucket.
  const checks: [RateLimitId, string][] = [];
  if (session) checks.push(["pages.session", session]);
  else if (identity.deviceId) checks.push(["pages.device", identity.deviceKey]);
  checks.push(["pages.ip", identity.ipBucket]);
  if (identity.ip48) checks.push(["pages.ip48", identity.ip48]);
  // limitKey() stores a peppered HMAC of each raw key: no cookie or IP in clear in Valkey.
  const over = retryAfter(await Promise.all(checks.map(([id, key]) => consumeLimit(id, key))));
  if (over === null) return { kind: "allow" };
  if (!(await hasChallengePass(request))) return { kind: "challenge", retryAfterSeconds: over };
  const passed = await consumeLimit("pages.passed.device", identity.deviceKey);
  if (passed.ok || passed.reason === "unavailable") return { kind: "allow" };
  return { kind: "limited", retryAfterSeconds: passed.retryAfterSeconds };
}

// ---- 429 page: tiny, self-contained, no script, never cached.

const TOO_MANY: Record<"fr" | "ar", { title: string; body: string; home: string }> = {
  fr: {
    title: "Trop de pages consultées",
    body: "Vous avez consulté beaucoup de pages en peu de temps. Merci de patienter quelques minutes avant de reprendre votre visite.",
    home: "Retour à l’accueil",
  },
  ar: {
    title: "عدد كبير من الصفحات",
    body: "لقد تصفحت عددًا كبيرًا من الصفحات في وقت قصير. يرجى الانتظار بضع دقائق قبل متابعة التصفح.",
    home: "العودة إلى الصفحة الرئيسية",
  },
};

const STYLE =
  "body{margin:0;font-family:system-ui,sans-serif;background:#fbf7ef;color:#1d2a24;display:grid;min-height:100vh;place-items:center}" +
  "main{max-width:32rem;padding:2rem 1.25rem}h1{font-size:1.5rem;margin:0 0 .75rem}p{line-height:1.6;margin:0 0 1.25rem}a{color:#0f5c3f}" +
  "@media (prefers-color-scheme:dark){body{background:#14201b;color:#f3ede1}a{color:#9fd3b8}}";
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");

/** CSP of the 429 page: nothing but its own inline style. */
export const TOO_MANY_CSP = `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export function tooManyPagesHtml(locale: Locale): string {
  const lang = locale === "ar" ? "ar" : "fr";
  const text = TOO_MANY[lang];
  return (
    `<!doctype html><html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${text.title} · Aalan</title><style>${STYLE}</style></head>` +
    `<body><main><h1>${text.title}</h1><p>${text.body}</p><p><a href="/${locale}">${text.home}</a></p></main></body></html>`
  );
}
