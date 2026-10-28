import { isOfficialHost, type GuideSource } from "@/content/guide/sources";

// Link checker of the admin procedures guide (design guide-demarches G4), pure part: what a fetched
// page means, its fingerprint, the state carried from one weekly run to the next, what the back
// office flags and what visitors see. The fetch is in fetch-page.ts, the run in
// src/worker/jobs/guide-links.ts. No server import: the pages and the tests share it.

export const LINK_OUTCOMES = ["ok", "redirected", "offsite", "broken", "blocked", "soft-error", "unreachable"] as const;
export type LinkOutcome = (typeof LINK_OUTCOMES)[number];

/** What one GET of a source gave (redirects followed by hand, see fetch-page.ts). */
export interface PageFetch {
  /** Last HTTP status, null when no response came (network error, timeout, refused host). */
  status: number | null;
  finalUrl: string;
  /** A redirect pointed outside OFFICIAL_HOSTS (or to plain http): not followed. */
  offsite?: boolean;
  contentType: string;
  /** Decoded text of an HTML or text body (capped), "" otherwise. */
  body: string;
  error?: string;
}

// Anti-bot pages: the site works for people, our robot is refused (F5 TSPD on consulat.ma, DGI's
// "Session bloquée", Cloudflare challenges). Never shown to visitors as a broken link.
const BLOCK_MARKERS = /TSPD|Request Rejected|The requested URL was rejected|cf-chl|challenge-platform|Just a moment\.\.\.|Attention Required|Session bloqu[ée]e|V[ée]rification de s[ée]curit[ée]/i;
// A 200 that is not the page: maintenance, construction, parked domain, soft 404.
const SOFT_ERROR_TITLE = /maintenance|en cours de construction|under construction|page introuvable|page not found|\b404\b|domain (?:is )?for sale|صيانة/i;
const SHORT_PAGE_CHARS = 400;

const sameUrl = (a: string, b: string) => {
  const norm = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    } catch {
      return value;
    }
  };
  return norm(a) === norm(b);
};

export interface PageText {
  title: string;
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16) || 32);
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10) || 32);
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Title and visible text of an HTML page: scripts, styles and markup out, whitespace collapsed. */
export function pageText(html: string): PageText {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  return { title, text };
}

/** Classifies one fetch of `sourceUrl`. */
export function classifyFetch(sourceUrl: string, page: PageFetch): { outcome: LinkOutcome; detail: string } {
  if (page.offsite) return { outcome: "offsite", detail: `redirection vers ${page.finalUrl}` };
  if (page.status === null) return { outcome: "unreachable", detail: page.error ?? "pas de réponse" };
  const { title, text } = page.body ? pageText(page.body) : { title: "", text: "" };
  const head = `${title} ${page.body.slice(0, 20_000)}`;
  if (page.status === 401 || page.status === 403 || page.status === 429) return { outcome: "blocked", detail: `HTTP ${page.status}` };
  if (BLOCK_MARKERS.test(head)) return { outcome: "blocked", detail: `page anti-robot (HTTP ${page.status})` };
  if (page.status >= 400) return { outcome: "broken", detail: `HTTP ${page.status}` };
  if (/\/lander\b/i.test(new URL(page.finalUrl).pathname)) return { outcome: "soft-error", detail: "domaine parqué" };
  const html = page.contentType.includes("html");
  if (html && (SOFT_ERROR_TITLE.test(title) || (text.length < SHORT_PAGE_CHARS && /maintenance|en cours de construction|under construction|صيانة/i.test(text)))) return { outcome: "soft-error", detail: title || "page de maintenance" };
  if (!sameUrl(sourceUrl, page.finalUrl)) return { outcome: "redirected", detail: `redirigé vers ${page.finalUrl}` };
  return { outcome: "ok", detail: `HTTP ${page.status}` };
}

// ---- Fingerprint: a 64-bit simhash of word 3-grams (16 hex digits), digits dropped so dates and
// counters do not move it. Near pages stay within a few bits; a rewritten page moves many.

export const CHANGE_THRESHOLD_BITS = 12;

function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\p{N}]+/gu, " ")
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length > 1);
}

/** Simhash of the text's word 3-grams, "" for a text without words. */
export function simhash(text: string): string {
  const tokens = words(text);
  if (tokens.length === 0) return "";
  const weights = new Array<number>(64).fill(0);
  const grams = tokens.length < 3 ? [tokens.join(" ")] : tokens.slice(2).map((word, index) => `${tokens[index]} ${tokens[index + 1]} ${word}`);
  for (const gram of grams) {
    const halves = [fnv1a(gram, 0x811c9dc5), fnv1a(gram, 0x01000193 ^ 0x9e3779b9)];
    for (let bit = 0; bit < 64; bit += 1) weights[bit]! += (halves[bit >> 5]! >>> (bit & 31)) & 1 ? 1 : -1;
  }
  const half = (offset: number) => {
    let value = 0;
    for (let bit = 0; bit < 32; bit += 1) if (weights[offset + bit]! > 0) value |= 1 << bit;
    return (value >>> 0).toString(16).padStart(8, "0");
  };
  return half(32) + half(0);
}

/** Differing bits of two simhashes (64 when one is missing or malformed). */
export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 64;
  let distance = 0;
  for (const offset of [0, 8]) {
    let x = (Number.parseInt(a.slice(offset, offset + 8), 16) ^ Number.parseInt(b.slice(offset, offset + 8), 16)) >>> 0;
    while (x) {
      distance += x & 1;
      x >>>= 1;
    }
  }
  return distance;
}

// ---- State carried between runs (Firestore system/guide-links, one entry per source id).

export interface Fingerprint {
  simhash: string;
  sha256: string;
}

export interface LinkState {
  /** The source URL this state was built for: a changed registry URL starts over. */
  url: string;
  outcome: LinkOutcome;
  detail: string;
  httpStatus: number | null;
  finalUrl: string;
  checkedAt: string;
  /** Consecutive runs with this same non-ok outcome (0 when ok). */
  streak: number;
  lastOkAt?: string;
  fingerprint?: Fingerprint;
  /** Fingerprint accepted as correct: the first OK fetch, then each staff "verified". */
  baseline?: Fingerprint & { at: string };
  /** Last staff "verified" (ISO time and uid). */
  acceptedAt?: string;
  acceptedBy?: string;
}

/** The state after one fetch. `fingerprint` only for an OK page (redirected counts as OK). */
export function nextLinkState(previous: LinkState | undefined, url: string, result: { outcome: LinkOutcome; detail: string; httpStatus: number | null; finalUrl: string; fingerprint?: Fingerprint }, now: Date): LinkState {
  const prev = previous?.url === url ? previous : undefined;
  const at = now.toISOString();
  const reached = result.outcome === "ok" || result.outcome === "redirected";
  const state: LinkState = {
    url,
    outcome: result.outcome,
    detail: result.detail,
    httpStatus: result.httpStatus,
    finalUrl: result.finalUrl,
    checkedAt: at,
    streak: result.outcome === "ok" ? 0 : prev?.outcome === result.outcome ? prev.streak + 1 : 1,
  };
  const lastOkAt = reached ? at : prev?.lastOkAt;
  if (lastOkAt) state.lastOkAt = lastOkAt;
  const fingerprint = reached ? result.fingerprint : prev?.fingerprint;
  if (fingerprint) state.fingerprint = fingerprint;
  const baseline = prev?.baseline ?? (reached && result.fingerprint ? { ...result.fingerprint, at } : undefined);
  if (baseline) state.baseline = baseline;
  if (prev?.acceptedAt) state.acceptedAt = prev.acceptedAt;
  if (prev?.acceptedBy) state.acceptedBy = prev.acceptedBy;
  return state;
}

/** Staff "verified": the current fingerprint becomes the baseline. */
export function acceptLinkState(state: LinkState, uid: string, now: Date): LinkState {
  const at = now.toISOString();
  return { ...state, ...(state.fingerprint ? { baseline: { ...state.fingerprint, at } } : {}), acceptedAt: at, acceptedBy: uid };
}

/** Bits between the current page and the accepted one; null when either is unknown. */
export function changeDistance(state: LinkState | undefined): number | null {
  if (!state?.fingerprint || !state.baseline) return null;
  if (!state.fingerprint.simhash || !state.baseline.simhash) return state.fingerprint.sha256 === state.baseline.sha256 ? 0 : 64;
  return hammingDistance(state.fingerprint.simhash, state.baseline.simhash);
}

export const REVIEW_MAX_DAYS = 180;
/** Runs before a failure is flagged: one bad week is often the site's maintenance. */
export const FAIL_RUNS = 2;
/** Anti-bot refusals and timeouts concern our robot more than the page: flagged later. */
export const BLOCK_RUNS = 4;

export const LINK_FLAGS = ["failing", "blocked", "changed", "review-due", "unconfirmed"] as const;
export type LinkFlag = (typeof LINK_FLAGS)[number];

const DAY_MS = 86_400_000;

/** Why the back office should look at a source; empty when nothing is due. */
export function linkFlags(source: Pick<GuideSource, "url" | "reviewedAt" | "confirmed">, state: LinkState | undefined, now: Date): LinkFlag[] {
  const flags: LinkFlag[] = [];
  const current = state?.url === source.url ? state : undefined;
  if (current) {
    if ((["broken", "offsite", "soft-error", "redirected"] as LinkOutcome[]).includes(current.outcome) && current.streak >= FAIL_RUNS) flags.push("failing");
    if ((current.outcome === "blocked" || current.outcome === "unreachable") && current.streak >= BLOCK_RUNS) flags.push("blocked");
    const distance = changeDistance(current);
    if (distance !== null && distance > CHANGE_THRESHOLD_BITS) flags.push("changed");
  }
  const reviewed = Math.max(Date.parse(`${source.reviewedAt}T00:00:00Z`), current?.acceptedAt ? Date.parse(current.acceptedAt) : 0);
  if (now.getTime() - reviewed > REVIEW_MAX_DAYS * DAY_MS) flags.push("review-due");
  if (!source.confirmed && current && !current.lastOkAt) flags.push("unconfirmed");
  return flags;
}

/**
 * How a visitor sees the link: "hidden" (never seen working, `confirmed: false`), "withdrawn"
 * (label without the address: the page now points outside the official hosts, or is gone two runs
 * in a row), or
 * "live".
 */
export function linkDisplay(source: Pick<GuideSource, "url" | "confirmed">, state: LinkState | undefined): "live" | "withdrawn" | "hidden" {
  const current = state?.url === source.url ? state : undefined;
  if (!source.confirmed && !current?.lastOkAt) return "hidden";
  if (current?.outcome === "offsite") return "withdrawn";
  if (current && (current.outcome === "broken" || current.outcome === "soft-error") && current.streak >= FAIL_RUNS) return "withdrawn";
  return "live";
}

/** True when the redirect target may be followed: https on an official host. */
export function isFollowable(url: URL): boolean {
  return url.protocol === "https:" && !url.username && !url.password && !url.port && isOfficialHost(url.hostname);
}
