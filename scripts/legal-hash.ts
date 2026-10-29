// Text hashes of the legal pages (D11, audit D-03), recorded next to their version in
// src/config/legal-hashes.json. Once the texts are frozen at the launch reset (LEGAL_TEXTS_FROZEN),
// tests/unit/legal-versions.test.ts fails when a page's French or Arabic text no longer matches its
// recorded hash: a change of substance needs a new version (CGU §22), a correction of form is
// recorded with --form-only.
//
//   node scripts/legal-hash.ts [--apply] [--form-only]     dry run without --apply

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LEGAL_PAGES, type LegalSlug } from "../src/config/legal-pages.ts";
import { LEGAL_TEXTS_FROZEN, LEGAL_VERSIONS } from "../src/config/legal-versions.ts";

const USAGE = "usage: scripts/legal-hash.ts [--apply] [--form-only]";
const root = fileURLToPath(new URL("..", import.meta.url));
export const LEGAL_HASHES_PATH = "src/config/legal-hashes.json";

export interface TextHashes {
  fr: string;
  /** Null for a page without an Arabic text. */
  ar: string | null;
}

export interface RecordedHashes extends TextHashes {
  version: string;
}

export type HashRecord = Partial<Record<string, RecordedHashes>>;

/** SHA-256 of a text, line endings normalised (a Windows checkout hashes the same). */
export function textHash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

/** Hashes of every legal page, from `read` (repository path to its content, or null). */
export function legalTextHashes(read: (path: string) => string | null): Record<LegalSlug, TextHashes> {
  const out = {} as Record<LegalSlug, TextHashes>;
  for (const { slug } of LEGAL_PAGES) {
    const fr = read(`src/content/legal/fr/${slug}.md`);
    if (fr === null) throw new Error(`src/content/legal/fr/${slug}.md is missing`);
    const ar = read(`src/content/legal/ar/${slug}.md`);
    out[slug] = { fr: textHash(fr), ar: ar === null ? null : textHash(ar) };
  }
  return out;
}

/** Pages whose recorded hashes or version no longer match (empty: the record is current). */
export function staleHashes<Slug extends string>(recorded: HashRecord | null, actual: Record<Slug, TextHashes>, versions: Record<Slug, { version: string }>): Slug[] {
  return (Object.keys(actual) as Slug[]).filter((slug) => {
    const entry = recorded?.[slug];
    return !entry || entry.version !== versions[slug].version || entry.fr !== actual[slug].fr || entry.ar !== actual[slug].ar;
  });
}

export interface HashPlan {
  next: Record<LegalSlug, RecordedHashes>;
  changed: LegalSlug[];
  /** Frozen texts changed under the same version, without --form-only. */
  refused: LegalSlug[];
}

export function planHashes(recorded: HashRecord | null, actual: Record<LegalSlug, TextHashes>, versions: Record<LegalSlug, { version: string }>, frozen: boolean, formOnly: boolean): HashPlan {
  const changed = staleHashes(recorded, actual, versions);
  const refused = frozen && !formOnly ? changed.filter((slug) => recorded?.[slug]?.version === versions[slug].version) : [];
  const next = {} as Record<LegalSlug, RecordedHashes>;
  for (const slug of Object.keys(actual) as LegalSlug[]) next[slug] = { version: versions[slug].version, ...actual[slug] };
  return { next, changed, refused };
}

function readRepo(path: string): string | null {
  const file = `${root}/${path}`;
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** The recorded hashes, or null before the launch reset wrote them. */
export function readHashRecord(read: (path: string) => string | null = readRepo): HashRecord | null {
  const text = read(LEGAL_HASHES_PATH);
  return text === null ? null : (JSON.parse(text) as HashRecord);
}

function main(): void {
  const flags = process.argv.slice(2);
  for (const flag of flags) if (flag !== "--apply" && flag !== "--form-only") throw new Error(`${flag}: not understood\n${USAGE}`);
  const plan = planHashes(readHashRecord(), legalTextHashes(readRepo), LEGAL_VERSIONS, LEGAL_TEXTS_FROZEN, flags.includes("--form-only"));
  if (plan.changed.length === 0) {
    console.log("The recorded hashes are current.");
    return;
  }
  for (const slug of plan.changed) console.log(`${plan.refused.includes(slug) ? "REFUSED" : "changed"}  ${slug} (version ${LEGAL_VERSIONS[slug].version})`);
  if (plan.refused.length > 0) {
    throw new Error("a frozen text changed under the same version: bump it in src/config/legal-versions.ts (CGU §22), or pass --form-only for a correction of form");
  }
  if (!flags.includes("--apply")) {
    console.log("\nDry run: --apply writes them.");
    return;
  }
  writeFileSync(`${root}/${LEGAL_HASHES_PATH}`, `${JSON.stringify(plan.next, null, 2)}\n`);
  console.log(`\nWrote ${LEGAL_HASHES_PATH}.`);
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]legal-hash\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  try {
    main();
  } catch (error) {
    console.error(`legal-hash: ${(error as Error).message}`);
    process.exit(1);
  }
}
