// Hash-based CSP for public ISR pages (§6). Next.js inlines the RSC payload as <script> tags
// whose content changes with every render, so their hashes are computed on the rendered HTML,
// once per response, by src/server/csp-hash-hook.ts. The cached HTML and its CSP header then
// travel together through Cloudflare's cache.

import { createHash } from "node:crypto";

export { INLINE_HASH_MARKER } from "./csp.ts";

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const TYPE = /\btype\s*=\s*["']?([^"'\s>]+)/i;
const JS_TYPES = new Set(["", "module", "text/javascript", "application/javascript"]);

/** Base64 SHA-256 of every executable inline script, in document order, deduplicated. */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const match of html.matchAll(SCRIPT)) {
    const attributes = match[1] ?? "";
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const type = (TYPE.exec(attributes)?.[1] ?? "").toLowerCase();
    // Data blocks (application/ld+json...) never execute: script-src does not apply to them.
    if (!JS_TYPES.has(type)) continue;
    // Browsers hash the text after newline normalization.
    const body = (match[2] ?? "").replace(/\r\n?/g, "\n");
    hashes.add(createHash("sha256").update(body, "utf8").digest("base64"));
  }
  return [...hashes];
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
