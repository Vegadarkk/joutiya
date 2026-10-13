// Hash-based CSP for public ISR pages (§6). Next.js inlines the RSC payload as <script> tags
// whose content changes with every render, so their hashes are computed on the rendered HTML,
// once per response, by src/server/csp-hash-hook.ts. The cached HTML and its CSP header then
// travel together through Cloudflare's cache.
//
// Only scripts the framework emits are hashed, each checked on its whole body, so an HTML
// injection that slipped past React escaping still cannot run: it gets no hash and the browser
// blocks it (and reports it to /api/csp-report).

import { createHash } from "node:crypto";
import { THEME_SCRIPT } from "../theme/script.ts";

export { INLINE_HASH_MARKER } from "./csp.ts";

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const TYPE = /\btype\s*=\s*["']?([^"'\s>]+)/i;
const JS_TYPES = new Set(["", "module", "text/javascript", "application/javascript"]);

/** A JSON string literal: no unescaped quote, so nothing can follow it inside the call. */
const JSON_STRING = String.raw`"(?:[^"\\\n\r]|\\.)*"`;

/** Whole-body shapes of the scripts Next.js emits in prerendered HTML. */
const FRAMEWORK_SCRIPTS = [
  // RSC bootstrap.
  /^\(self\.__next_f=self\.__next_f\|\|\[\]\)\.push\(\[0\]\)(?:;self\.__next_f\.push\(\[2,null\]\))?$/,
  // RSC payload chunks: a type number and one JSON string (or null).
  new RegExp(String.raw`^self\.__next_f\.push\(\[\d,(?:null|${JSON_STRING})\]\)$`),
];

export function scriptHash(body: string): string {
  // Browsers hash the text after newline normalization.
  return createHash("sha256").update(body.replace(/\r\n?/g, "\n"), "utf8").digest("base64");
}

/** Our own constant inline scripts (string literals: same hash in every build). */
export const PINNED_SCRIPT_HASHES: ReadonlySet<string> = new Set([scriptHash(THEME_SCRIPT)]);

export function isFrameworkScript(body: string, hash = scriptHash(body)): boolean {
  return PINNED_SCRIPT_HASHES.has(hash) || FRAMEWORK_SCRIPTS.some((shape) => shape.test(body));
}

export interface InlineScripts {
  /** Base64 SHA-256 of the trusted inline scripts, in document order, deduplicated. */
  hashes: string[];
  /** Executable inline scripts left unhashed (blocked by the browser). */
  untrusted: number;
}

export function inlineScripts(html: string): InlineScripts {
  const hashes = new Set<string>();
  let untrusted = 0;
  for (const match of html.matchAll(SCRIPT)) {
    const attributes = match[1] ?? "";
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const type = (TYPE.exec(attributes)?.[1] ?? "").toLowerCase();
    // Data blocks (application/ld+json...) never execute: script-src does not apply to them.
    if (!JS_TYPES.has(type)) continue;
    const body = match[2] ?? "";
    const hash = scriptHash(body);
    if (isFrameworkScript(body, hash)) hashes.add(hash);
    else untrusted += 1;
  }
  return { hashes: [...hashes], untrusted };
}

/** Replaces the script-src directive with 'self' plus the given hashes; keeps 'unsafe-eval' (dev). */
export function withScriptHashes(policy: string, hashes: string[]): string {
  return policy
    .split(";")
    .map((directive) => {
      const trimmed = directive.trim();
      if (!/^script-src\s/i.test(trimmed)) return trimmed;
      const extra = trimmed.includes("'unsafe-eval'") ? ["'unsafe-eval'"] : [];
      return ["script-src", "'self'", ...hashes.map((hash) => `'sha256-${hash}'`), ...extra].join(" ");
    })
    .filter(Boolean)
    .join("; ");
}
