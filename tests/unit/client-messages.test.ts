import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { pickMessages, PUBLIC_CLIENT_NAMESPACES, SEARCH_PAGE_CLIENT_NAMESPACES } from "@/i18n/client-messages";

// The public pages ship only PUBLIC_CLIENT_NAMESPACES to the browser. A client component that reads
// another namespace would show raw keys there: this walks the import graph of the public routes
// (static and dynamic imports, from each "use client" boundary down) and checks every
// useTranslations namespace a client module reads is in the list.

const SRC = path.resolve(__dirname, "../../src");

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

const IMPORT = /(?:import|export)\s+(type\s+)?[^"';]*?\sfrom\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm;

/** Client modules reachable from `entries`: each "use client" module and everything it imports. */
function clientModules(entries: string[]): Set<string> {
  const modules = new Set<string>();
  const seen = new Set<string>();
  const stack: Array<[string, boolean]> = entries.map((file) => [file, false]);
  while (stack.length > 0) {
    const [file, importedByClient] = stack.pop()!;
    const text = readFileSync(file, "utf8");
    const client = importedByClient || /^\s*["']use client["']/.test(text);
    const key = `${file}|${client}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (client) modules.add(file);
    for (const match of text.matchAll(IMPORT)) {
      if (match[1]) continue; // import type: erased
      const resolved = resolveImport(file, match[2] ?? match[3] ?? match[4] ?? "");
      if (resolved) stack.push([resolved, client]);
    }
  }
  return modules;
}

/** The wrapper of useTranslations (src/i18n/numbers.ts): its callers name the namespaces. */
const WRAPPER = path.join(SRC, "i18n/numbers.ts");

/** Namespaces read by useTranslations (or useNumbersTranslations) in client modules reachable from `entries`, with their readers. */
function clientNamespaces(entries: string[]): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of clientModules(entries)) {
    if (file === WRAPPER) continue;
    for (const match of readFileSync(file, "utf8").matchAll(/use(?:Numbers)?Translations\(([^)]*)\)/g)) {
      const literal = /^\s*"([^"]+)"\s*$/.exec(match[1] ?? "");
      const namespace = literal?.[1] ?? `<not a literal: ${match[1]}>`;
      if (!found.has(namespace)) found.set(namespace, new Set());
      found.get(namespace)!.add(path.relative(SRC, file));
    }
  }
  return found;
}

const coveredBy = (list: readonly string[]) => (namespace: string) => list.some((path) => namespace === path || namespace.startsWith(`${path}.`));
const covered = coveredBy(PUBLIC_CLIENT_NAMESPACES);
const lookup = (tree: unknown, dotted: string) => dotted.split(".").reduce<unknown>((node, key) => (typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined), tree);

/** The search page wraps its content in its own provider with the extra search namespaces. */
const SEARCH_PAGE = path.join(SRC, "app/[locale]/(public)/recherche/page.tsx");

describe("public client messages", () => {
  const entries = filesUnder(path.join(SRC, "app/[locale]/(public)"))
    .filter((file) => /\/(page|layout|error|not-found|loading|template)\.tsx$/.test(file))
    .filter((file) => file !== SEARCH_PAGE);
  const used = clientNamespaces(entries);

  it("covers what the search page's islands read with the public and search lists", () => {
    const search = clientNamespaces([SEARCH_PAGE]);
    expect(search.has("SearchFilters")).toBe(true);
    const both = coveredBy([...PUBLIC_CLIENT_NAMESPACES, ...SEARCH_PAGE_CLIENT_NAMESPACES]);
    const missing = [...search].filter(([namespace]) => !both(namespace)).map(([namespace, files]) => `${namespace} (${[...files].join(", ")})`);
    expect(missing).toEqual([]);
    for (const namespace of SEARCH_PAGE_CLIENT_NAMESPACES) expect(lookup(fr, namespace), namespace).toBeTypeOf("object");
  });

  it("finds the client islands of the public routes", () => {
    expect(entries.length).toBeGreaterThan(5);
    for (const namespace of ["Nav", "ListingPage.gallery", "ListingPage.contact"]) expect(used.has(namespace), namespace).toBe(true);
  });

  it("covers every namespace a public client component reads", () => {
    const missing = [...used].filter(([namespace]) => !covered(namespace)).map(([namespace, files]) => `${namespace} (${[...files].join(", ")})`);
    expect(missing).toEqual([]);
  });

  it("names only namespaces that exist", () => {
    for (const namespace of PUBLIC_CLIENT_NAMESPACES) expect(lookup(fr, namespace), namespace).toBeTypeOf("object");
  });

  it("ships a fraction of the catalog", () => {
    const picked = JSON.stringify(pickMessages(fr, PUBLIC_CLIENT_NAMESPACES)).length;
    expect(picked).toBeLessThan(JSON.stringify(fr).length / 4);
  });
});

describe("listing page JavaScript", () => {
  it("pulls no validation schemas (zod): client islands import paths and limits from contracts/endpoints", () => {
    const entries = ["app/[locale]/(public)/layout.tsx", "app/[locale]/(public)/annonce/[slugId]/page.tsx"].map((file) => path.join(SRC, file));
    const modules = clientModules(entries);
    expect(modules.has(path.join(SRC, "components/favorites/favorite-button.tsx"))).toBe(true);
    const withZod = [...modules].filter((file) => /from\s+["'](?:zod|@\/lib\/zod)["']/.test(readFileSync(file, "utf8"))).map((file) => path.relative(SRC, file));
    expect(withZod).toEqual([]);
  });
});

describe("pickMessages", () => {
  const messages = { A: { x: "1", y: { z: "2" } }, B: { w: "3" }, C: "4" };

  it("keeps the named subtrees, merged under their parents", () => {
    expect(pickMessages(messages, ["A.y", "A.x", "C"])).toEqual({ A: { x: "1", y: { z: "2" } }, C: "4" });
    expect(pickMessages(messages, ["B"])).toEqual({ B: { w: "3" } });
  });

  it("skips unknown paths", () => {
    expect(pickMessages(messages, ["D", "A.q", "C.x"])).toEqual({});
  });
});
