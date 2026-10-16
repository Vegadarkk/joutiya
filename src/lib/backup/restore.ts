import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import { decryptAge } from "./crypto.ts";
import { BackupFormatError, decodeDocument, parseBackupLine, type DecodedDocument, type RefResolver } from "./encode.ts";
import { openPart, parseBackupKey, type BackupMode } from "./parts.ts";

// Restore of the encrypted backups (D17), run by scripts/restore-firestore.ts and the emulator
// test. Two passes over the parts, decrypted in memory only (no plaintext file, ever):
//   1. check: each manifest decrypted, every part it lists present and matching its document
//      count, size and SHA-256; every line parsed and decoded; per document path the newest
//      version is chosen (highest Firestore updateTime `u`; equal: the part captured later);
//   2. apply: the chosen versions written with set() (no merge) in batches of 500, original
//      paths and Firestore types (Timestamp, GeoPoint, bytes, references) intact.
// Rolling fulls and incrementals mix capture dates, so "last file wins" would let an old
// incremental overwrite a newer full slice: the version is chosen per document instead.
// A date without a manifest (a run that did not finish) is restored unverified, with a warning.
// Pure module (no server-only, no "@/"): plain Node runs it.

export interface BackupSource {
  /** Where the objects come from (a folder, a bucket), for messages. */
  readonly label: string;
  /** Keys or relative paths of every object; entries that are not backup objects are ignored. */
  list(): Promise<string[]>;
  read(key: string): Promise<Uint8Array>;
}

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

export interface RestorePart {
  /** Key in the source. */
  key: string;
  /** `{date}/{mode}/{file}`, the same in the manifest and in a download folder. */
  logical: string;
  date: string;
  mode: BackupMode;
  collection: string;
  part: number | null;
  /** From the manifest of its date; null when the date has none. */
  expected: { docs: number; plainBytes: number; sha256: string } | null;
}

export interface RestorePlan {
  /** In capture order: date, then incremental before full (the export runs them in that order). */
  parts: RestorePart[];
  dates: string[];
  /** Dates whose manifest was read. */
  verifiedDates: string[];
  warnings: string[];
}

export interface PlanOptions {
  /** Restore only these collections (ids of the backup table, e.g. "users", "private"). */
  collections?: readonly string[] | null;
  /** Ignore backups after this UTC date (YYYY-MM-DD): the state as of that night. */
  until?: string | null;
}

const MODE_RANK: Record<BackupMode, number> = { incremental: 0, full: 1 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const RESTORE_BATCH_SIZE = 500;

// --- Sources -------------------------------------------------------------------------------------

/** A downloaded copy of the bucket: any folder that holds `{date}/...` trees (e.g. `backups/`). */
export function directorySource(root: string): BackupSource {
  const base = resolve(root);
  return {
    label: base,
    async list() {
      const entries = await readdir(base, { recursive: true, withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => relative(base, join(entry.parentPath, entry.name)).split(sep).join("/"));
    },
    async read(key) {
      const path = resolve(base, key);
      if (!path.startsWith(base + sep)) throw new RestoreError(`${key}: outside ${base}`);
      return readFile(path);
    },
  };
}

// --- Manifest ------------------------------------------------------------------------------------

interface ManifestEntry {
  logical: string;
  collection: string;
  docs: number;
  plainBytes: number;
  sha256: string;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The parts a manifest lists (fields the restore checks); throws on anything else. */
export function parseManifest(text: string, date: string): ManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RestoreError(`manifest of ${date}: not JSON`);
  }
  const manifest = parsed as { version?: unknown; date?: unknown; parts?: unknown };
  if (manifest === null || typeof manifest !== "object" || manifest.version !== 1 || manifest.date !== date || !Array.isArray(manifest.parts)) {
    throw new RestoreError(`manifest of ${date}: version 1 with this date and a parts list expected`);
  }
  return manifest.parts.map((raw: unknown, index) => {
    const part = (raw ?? {}) as Record<string, unknown>;
    const key = typeof part["key"] === "string" ? parseBackupKey(part["key"]) : null;
    const { docs, plainBytes, sha256 } = part;
    if (!key || key.kind !== "part" || key.date !== date || !isCount(docs) || !isCount(plainBytes) || typeof sha256 !== "string" || !SHA256.test(sha256)) {
      throw new RestoreError(`manifest of ${date}: part ${index} is malformed`);
    }
    return { logical: key.logical, collection: key.collection, docs, plainBytes, sha256 };
  });
}

async function readSource(source: BackupSource, key: string): Promise<Uint8Array> {
  try {
    return await source.read(key);
  } catch (error) {
    throw new RestoreError(`${key}: cannot be read from ${source.label} (${(error as Error).message})`);
  }
}

async function decryptManifest(source: BackupSource, key: string, identity: string): Promise<string> {
  try {
    return Buffer.from(await decryptAge(await readSource(source, key), identity)).toString("utf8");
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    throw new RestoreError(`${key}: cannot be decrypted, wrong identity? (${(error as Error).message})`);
  }
}

// --- Plan ----------------------------------------------------------------------------------------

/** Lists the source, reads each manifest and decides which parts to restore, in capture order. */
export async function planRestore(source: BackupSource, identity: string, options: PlanOptions = {}): Promise<RestorePlan> {
  if (options.until && !DATE.test(options.until)) throw new RestoreError("--until must be a date (YYYY-MM-DD)");
  const wanted = options.collections && options.collections.length > 0 ? new Set(options.collections) : null;
  const warnings: string[] = [];
  const manifests = new Map<string, string>();
  const byDate = new Map<string, Map<string, RestorePart>>();
  for (const key of await source.list()) {
    const parsed = parseBackupKey(key);
    if (!parsed || (options.until && parsed.date > options.until)) continue;
    if (parsed.kind === "manifest") {
      if (manifests.has(parsed.date)) throw new RestoreError(`two manifests for ${parsed.date} in ${source.label}`);
      manifests.set(parsed.date, key);
      continue;
    }
    const parts = byDate.get(parsed.date) ?? new Map<string, RestorePart>();
    if (parts.has(parsed.logical)) throw new RestoreError(`${parsed.logical} appears twice in ${source.label}`);
    parts.set(parsed.logical, { key, logical: parsed.logical, date: parsed.date, mode: parsed.mode, collection: parsed.collection, part: parsed.part, expected: null });
    byDate.set(parsed.date, parts);
  }

  const dates = [...new Set([...byDate.keys(), ...manifests.keys()])].sort();
  const selected: RestorePart[] = [];
  const verifiedDates: string[] = [];
  const seenCollections = new Set<string>();
  for (const date of dates) {
    const found = byDate.get(date) ?? new Map<string, RestorePart>();
    const manifestKey = manifests.get(date);
    let parts: RestorePart[];
    if (manifestKey) {
      const entries = parseManifest(await decryptManifest(source, manifestKey, identity), date);
      parts = entries.map((entry) => {
        const part = found.get(entry.logical);
        if (!part) throw new RestoreError(`${entry.logical} is listed in the manifest of ${date} but missing from ${source.label}`);
        return { ...part, expected: { docs: entry.docs, plainBytes: entry.plainBytes, sha256: entry.sha256 } };
      });
      const listed = new Set(entries.map((entry) => entry.logical));
      const extra = [...found.keys()].filter((logical) => !listed.has(logical)).sort();
      if (extra.length > 0) warnings.push(`${date}: ${extra.length} part(s) not in the manifest ignored (left by a failed attempt): ${extra.join(", ")}`);
      verifiedDates.push(date);
    } else {
      parts = [...found.values()];
      if (parts.length > 0) warnings.push(`${date}: no manifest (the run did not finish), ${parts.length} part(s) restored without verification`);
    }
    for (const part of parts) {
      seenCollections.add(part.collection);
      if (!wanted || wanted.has(part.collection)) selected.push(part);
    }
  }
  if (wanted) for (const id of wanted) if (!seenCollections.has(id)) warnings.push(`collection "${id}" is in no backup part`);
  selected.sort((a, b) => (a.date === b.date ? MODE_RANK[a.mode] - MODE_RANK[b.mode] || a.collection.localeCompare(b.collection) || (a.part ?? 0) - (b.part ?? 0) : a.date < b.date ? -1 : 1));
  return { parts: selected, dates, verifiedDates, warnings };
}

// --- Pass 1: check and choose ------------------------------------------------------------------

interface Choice {
  /** updateTime in ms; -Infinity when unknown. */
  at: number;
  part: number;
  line: number;
  collection: string;
}

export interface RestoreCheck {
  /** Lines read across all parts (every captured version). */
  lines: number;
  /** Documents to write: the newest version of each path. */
  documents: number;
  byCollection: Record<string, number>;
  /** SHA-256 of each part's NDJSON in plan order (pass 2 refuses a part that changed since). */
  sha256: string[];
  choices: Map<string, Choice>;
}

/** Validates a reference path without a database (pass 1 runs before any connection). */
const PATH_ONLY: RefResolver = { doc: (path: string) => path as unknown as DocumentReference };

async function openChecked(source: BackupSource, part: RestorePart, identity: string): Promise<{ lines: string[]; sha256: string }> {
  const body = await readSource(source, part.key);
  let opened: Awaited<ReturnType<typeof openPart>>;
  try {
    opened = await openPart(body, identity);
  } catch (error) {
    throw new RestoreError(`${part.key}: cannot be decrypted or decompressed, wrong identity? (${(error as Error).message})`);
  }
  const { expected } = part;
  if (expected && (opened.sha256 !== expected.sha256 || opened.lines.length !== expected.docs || opened.plainBytes !== expected.plainBytes)) {
    throw new RestoreError(`${part.key}: does not match its manifest (documents ${opened.lines.length}/${expected.docs}, SHA-256 ${opened.sha256 === expected.sha256 ? "ok" : "different"})`);
  }
  return { lines: opened.lines, sha256: opened.sha256 };
}

/** Pass 1: decrypts and checks every part, decodes every line, chooses the version of each document. */
export async function checkRestore(source: BackupSource, plan: RestorePlan, identity: string): Promise<RestoreCheck> {
  const choices = new Map<string, Choice>();
  const sha256: string[] = [];
  let lines = 0;
  for (const [index, part] of plan.parts.entries()) {
    const opened = await openChecked(source, part, identity);
    sha256.push(opened.sha256);
    for (const [lineIndex, line] of opened.lines.entries()) {
      lines += 1;
      let decoded: DecodedDocument;
      try {
        // The same decoding as the write pass, minus the database.
        decoded = decodeDocument(line, PATH_ONLY);
      } catch (error) {
        throw new RestoreError(`${part.key} line ${lineIndex + 1}: ${(error as Error).message}`);
      }
      if (decoded.collection !== part.collection) throw new RestoreError(`${part.key} line ${lineIndex + 1}: document of another collection`);
      const path = decoded.ref as unknown as string;
      const at = decoded.updateTime?.getTime() ?? Number.NEGATIVE_INFINITY;
      const current = choices.get(path);
      // Parts are in capture order: on equal update times the later capture wins.
      if (!current || at >= current.at) choices.set(path, { at, part: index, line: lineIndex, collection: part.collection });
    }
  }
  const byCollection: Record<string, number> = {};
  for (const choice of choices.values()) byCollection[choice.collection] = (byCollection[choice.collection] ?? 0) + 1;
  return { lines, documents: choices.size, byCollection, sha256, choices };
}

// --- Pass 2: write -------------------------------------------------------------------------------

export type RestoreTarget = Pick<Firestore, "doc" | "batch">;

export interface ApplyResult {
  writes: number;
  batches: number;
}

/** Pass 2: writes the chosen version of each document, `batchSize` set() per commit. */
export async function applyRestore(
  source: BackupSource,
  plan: RestorePlan,
  check: RestoreCheck,
  identity: string,
  db: RestoreTarget,
  options: { batchSize?: number; log?: (message: string) => void } = {},
): Promise<ApplyResult> {
  const batchSize = Math.min(options.batchSize ?? RESTORE_BATCH_SIZE, RESTORE_BATCH_SIZE);
  let batch = db.batch();
  let pending = 0;
  let writes = 0;
  let batches = 0;
  const commit = async () => {
    if (pending === 0) return;
    await batch.commit();
    writes += pending;
    batches += 1;
    pending = 0;
    batch = db.batch();
  };
  for (const [index, part] of plan.parts.entries()) {
    const opened = await openChecked(source, part, identity);
    if (opened.sha256 !== check.sha256[index]) throw new RestoreError(`${part.key}: changed since it was checked`);
    for (const [lineIndex, line] of opened.lines.entries()) {
      const { p } = parseBackupLine(line);
      const choice = check.choices.get(p);
      if (!choice || choice.part !== index || choice.line !== lineIndex) continue;
      let decoded: DecodedDocument;
      try {
        decoded = decodeDocument(line, db);
      } catch (error) {
        if (error instanceof BackupFormatError) throw new RestoreError(`${part.key} line ${lineIndex + 1}: ${error.message}`);
        throw error;
      }
      batch.set(decoded.ref, decoded.data);
      pending += 1;
      if (pending >= batchSize) await commit();
    }
    options.log?.(`${part.logical}: done (${writes + pending} documents so far)`);
  }
  await commit();
  return { writes, batches };
}
