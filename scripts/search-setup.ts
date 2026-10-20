// Prepares the Meilisearch of one environment (design D3, D12): the live index `listings_v1` with
// its settings (src/lib/search/settings.ts) and the two API keys of the app, created with fixed uids:
//   joutiya-search  `search`, `documents.get`                              on listings_*, help  (web: MEILI_SEARCH_KEY)
//   joutiya-index   documents.*, indexes.*, settings.*, tasks.get, stats.get on listings_*, help  (worker: MEILI_INDEX_KEY)
// The `help` index (phase-5 D25) is created and filled by the worker at start (src/lib/help/search.ts).
// A key's value is derived from the master key and its uid, so re-running yields the same values.
// The master key comes from MEILI_MASTER_KEY in the environment (never an argument, never printed);
// key values are written only to the env file given with --write-env (mode 600), never printed
// (not --env-file: Node itself would read that option and load the file).
// Without --apply nothing is written: the plan is read from the server.
//
//   MEILI_MASTER_KEY=... node scripts/search-setup.ts --url http://127.0.0.1:7700 [--write-env app.env] [--apply]
//   (MEILI_URL is used when --url is absent)

import { chmodSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export interface KeySpec {
  uid: string;
  name: string;
  description: string;
  envName: "MEILI_SEARCH_KEY" | "MEILI_INDEX_KEY";
  actions: string[];
  indexes: string[];
}

/** Fixed uids: the key values only depend on the master key and these. */
export const SEARCH_KEYS: readonly KeySpec[] = [
  {
    uid: "5e7b1c3a-9d2f-4b8e-a1c6-0f4d2e8b7a31",
    name: "joutiya-search",
    description: "Joutiya web: search and documents.get (sitemaps) on listings_* and help",
    envName: "MEILI_SEARCH_KEY",
    actions: ["search", "documents.get"],
    indexes: ["listings_*", "help"],
  },
  {
    uid: "a3c9e2f1-6b4d-4e7a-9c8b-1d2f3e4a5b62",
    name: "joutiya-index",
    description: "Joutiya worker: indexing, settings, rebuilds on listings_* and help",
    envName: "MEILI_INDEX_KEY",
    actions: ["documents.*", "indexes.*", "settings.*", "tasks.get", "stats.get"],
    indexes: ["listings_*", "help"],
  },
];

export interface LiveKey {
  uid: string;
  actions: string[];
  indexes: string[];
}

export type KeyAction = "create" | "keep" | "recreate";

/** What to do with each key: create it, keep it, or recreate it when its rights differ (same value). */
export function planKeys(live: readonly LiveKey[]): { spec: KeySpec; action: KeyAction }[] {
  const same = (a: readonly string[], b: readonly string[]) => [...a].sort().join(",") === [...b].sort().join(",");
  return SEARCH_KEYS.map((spec) => {
    const current = live.find((key) => key.uid === spec.uid);
    if (!current) return { spec, action: "create" };
    return { spec, action: same(current.actions, spec.actions) && same(current.indexes, spec.indexes) ? "keep" : "recreate" };
  });
}

/** Sets `name=value` lines in an env file's text, keeping every other line. */
export function mergeEnvFile(content: string, values: Readonly<Record<string, string>>): string {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  const pending = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const name = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (name === undefined || !pending.has(name)) return line;
    const value = pending.get(name) ?? "";
    pending.delete(name);
    return `${name}=${value}`;
  });
  for (const [name, value] of pending) out.push(`${name}=${value}`);
  return `${out.join("\n")}\n`;
}

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Lets plain `node` load src modules: `@/x` -> src/x(.ts|/index.ts), extensionless relative imports,
 * `server-only` -> an empty module. Shared with scripts/bench-search.ts.
 */
export function registerSrcResolver(): void {
  const candidates = (base: string) => [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") return nextResolve(pathToFileURL(resolvePath(ROOT, "src/lib/empty.ts")).href, context);
      let base: string | undefined;
      if (specifier.startsWith("@/")) base = resolvePath(ROOT, "src", specifier.slice(2));
      else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
        base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      }
      if (base !== undefined) {
        const found = candidates(base).find((path) => existsSync(path) && statSync(path).isFile());
        if (found) return nextResolve(pathToFileURL(found).href, context);
      }
      return nextResolve(specifier, context);
    },
  });
}

async function call(url: string, masterKey: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${masterKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed };
}

function fail(what: string, result: { status: number; body: unknown }): never {
  const code = (result.body as { code?: unknown } | undefined)?.code;
  throw new Error(`${what}: HTTP ${result.status}${typeof code === "string" ? ` ${code}` : ""}`);
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { url: { type: "string" }, "write-env": { type: "string" }, apply: { type: "boolean", default: false } } });
  const url = (args.url ?? process.env.MEILI_URL ?? "").replace(/\/+$/, "");
  const masterKey = process.env.MEILI_MASTER_KEY ?? "";
  if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error("usage: MEILI_MASTER_KEY=... node scripts/search-setup.ts --url <meilisearch url> [--write-env <path>] [--apply]");
  if (masterKey.length < 16) throw new Error("MEILI_MASTER_KEY must be set (16 bytes at least) in the environment");

  registerSrcResolver();
  const { MeiliEngine } = await import("../src/lib/search/meili.ts");
  const { settingsDiff } = await import("../src/lib/search/settings.ts");
  const { SEARCH_INDEX } = await import("../src/lib/search/types.ts");

  const health = await call(url, masterKey, "GET", "/health");
  if (health.status !== 200) fail("Meilisearch is not healthy", health);
  const version = await call(url, masterKey, "GET", "/version");
  if (version.status !== 200) fail("master key refused", version);
  console.log(`Meilisearch ${String((version.body as { pkgVersion?: unknown }).pkgVersion)} at ${url}`);

  // Index and settings.
  const index = await call(url, masterKey, "GET", `/indexes/${SEARCH_INDEX}`);
  if (index.status !== 200 && index.status !== 404) fail("index lookup", index);
  const settings = index.status === 200 ? await call(url, masterKey, "GET", `/indexes/${SEARCH_INDEX}/settings`) : undefined;
  const changed = index.status === 200 ? settingsDiff(settings?.body) : ["(all)"];
  console.log(`Index ${SEARCH_INDEX}: ${index.status === 404 ? "to create" : "present"}; settings ${changed.length ? `to update: ${changed.join(", ")}` : "up to date"}`);

  // Keys.
  const keys = await call(url, masterKey, "GET", "/keys?limit=1000");
  if (keys.status !== 200) fail("key listing", keys);
  const live = ((keys.body as { results?: LiveKey[] }).results ?? []).map(({ uid, actions, indexes }) => ({ uid, actions, indexes }));
  const plan = planKeys(live);
  for (const { spec, action } of plan) console.log(`Key ${spec.name} (${spec.envName}, uid ${spec.uid}): ${action}`);
  const envFile = args["write-env"];
  if (!envFile) console.log("No --write-env: key values will not be written anywhere.");

  if (!args.apply) {
    console.log("\nDry run: nothing changed. Add --apply to create the index, settings and keys.");
    return;
  }

  const engine = new MeiliEngine({ url, indexKey: masterKey, searchKey: masterKey, index: SEARCH_INDEX });
  const ready = await engine.ensureReady();
  console.log(`Index ${SEARCH_INDEX}: ${ready.created ? "created" : "present"}, settings ${ready.settingsUpdated ? "updated" : "unchanged"}`);

  const values: Record<string, string> = {};
  for (const { spec, action } of plan) {
    const body = { uid: spec.uid, name: spec.name, description: spec.description, actions: spec.actions, indexes: spec.indexes, expiresAt: null };
    if (action === "recreate") {
      const removed = await call(url, masterKey, "DELETE", `/keys/${spec.uid}`);
      if (removed.status !== 204) fail(`delete key ${spec.name}`, removed);
    }
    if (action !== "keep") {
      const created = await call(url, masterKey, "POST", "/keys", body);
      if (created.status !== 201) fail(`create key ${spec.name}`, created);
    }
    const fetched = await call(url, masterKey, "GET", `/keys/${spec.uid}`);
    const value = (fetched.body as { key?: unknown } | undefined)?.key;
    if (fetched.status !== 200 || typeof value !== "string") fail(`read key ${spec.name}`, fetched);
    values[spec.envName] = value;
    console.log(`Key ${spec.name}: ${action === "keep" ? "kept" : action === "create" ? "created" : "recreated"}`);
  }
  if (envFile) {
    const path = resolvePath(envFile);
    writeFileSync(path, mergeEnvFile(existsSync(path) ? readFileSync(path, "utf8") : "", values), { mode: 0o600 });
    chmodSync(path, 0o600);
    console.log(`Wrote ${Object.keys(values).join(", ")} to ${path} (values not shown).`);
  }
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]search-setup\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main().catch((error: unknown) => {
    console.error(`search-setup: ${(error as Error).message}`);
    process.exit(1);
  });
}
