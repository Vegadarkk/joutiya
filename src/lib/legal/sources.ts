import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { LegalSlug } from "@/config/legal-pages";

// Markdown sources of the legal pages (src/content/legal/{fr,ar}/{slug}.md), read once per process.
// next.config.ts traces the folder into the standalone output (outputFileTracingIncludes): the ISR
// regeneration reads them inside the container. Published as written: the Markdown is the
// machine-readable form of the terms (DSA art. 14(1)).

const ROOT = path.join(process.cwd(), "src", "content", "legal");
const cache = new Map<string, string>();

export function legalSource(slug: LegalSlug, language: "fr" | "ar"): string {
  const key = `${language}/${slug}`;
  let source = cache.get(key);
  if (source === undefined) {
    source = readFileSync(path.join(ROOT, language, `${slug}.md`), "utf8");
    cache.set(key, source);
  }
  return source;
}
