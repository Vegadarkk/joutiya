import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { encodeDocument, parseBackupLine } from "./encode.ts";
import { openPart } from "./parts.ts";
import type { BackupSource, RestoreCheck, RestorePlan } from "./restore.ts";

// Restore drill (D20), run by scripts/restore-drill.ts after a restore into an empty emulator
// project: every restored document is read back and compared with the version the restore chose
// (per collection: count, SHA-256 over the sorted paths and canonical data, and the paths that
// differ, so the "1 % deep sample" of the design is a full comparison), then the references
// between collections are counted (a rolling full slice may lag behind an incremental: dangling
// references are reported, not fatal), and the RPO is the age of the newest captured version.
// Pure module (no server-only, no "@/"): plain Node runs it. Prints and returns counts and paths,
// never document contents.

export interface CollectionReport {
  expected: number;
  restored: number;
  /** Paths whose data differs, missing from the restore or not expected (at most 10 of each). */
  missing: string[];
  extra: string[];
  different: string[];
  /** SHA-256 over "path\tcanonical data" lines sorted by path, backup side and restored side. */
  expectedSha256: string;
  restoredSha256: string;
}

export interface ReferenceReport {
  rule: string;
  checked: number;
  dangling: number;
}

export interface DrillReport {
  collections: Record<string, CollectionReport>;
  references: ReferenceReport[];
  /** Newest update time among the restored versions (the RPO is the time since). */
  newestCapture: Date | null;
  ok: boolean;
}

const LIST_MAX = 10;

/** JSON with object keys sorted at every level: the same data gives the same text whatever the field order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(entries: Map<string, string>): string {
  const hash = createHash("sha256");
  for (const path of [...entries.keys()].sort()) hash.update(`${path}\t${entries.get(path)}\n`);
  return hash.digest("hex");
}

/** The version the restore chose for each path, as canonical encoded data, grouped by collection. */
async function expectedVersions(source: BackupSource, plan: RestorePlan, check: RestoreCheck, identity: string): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  for (const [index, part] of plan.parts.entries()) {
    const opened = await openPart(await source.read(part.key), identity);
    for (const [lineIndex, line] of opened.lines.entries()) {
      const { p, d } = parseBackupLine(line);
      const choice = check.choices.get(p);
      if (!choice || choice.part !== index || choice.line !== lineIndex) continue;
      const collection = out.get(choice.collection) ?? new Map<string, string>();
      collection.set(p, canonicalJson(d));
      out.set(choice.collection, collection);
    }
  }
  return out;
}

/** Root collection when its documents sit at depth 2 (`id/doc`), a collection group otherwise. */
function isRoot(paths: Iterable<string>): boolean {
  for (const path of paths) return path.split("/").length === 2;
  return true;
}

/** Reference rules between restored collections: field (or parent) -> document that must exist. */
const REFERENCE_RULES: { rule: string; collection: string; group: boolean; target: (path: string, data: Record<string, unknown>) => string | null }[] = [
  { rule: "listings.ownerUid -> users", collection: "listings", group: false, target: (_, data) => (typeof data["ownerUid"] === "string" ? `users/${data["ownerUid"]}` : null) },
  {
    rule: "uploads.targetId -> listings (purpose listing)",
    collection: "uploads",
    group: false,
    target: (_, data) => (data["purpose"] === "listing" && typeof data["targetId"] === "string" ? `listings/${data["targetId"]}` : null),
  },
  { rule: "users/{uid}/private/* -> users/{uid}", collection: "private", group: true, target: (path) => path.split("/").slice(0, 2).join("/") },
  { rule: "conversations/{cid}/messages/* -> conversations/{cid}", collection: "messages", group: true, target: (path) => path.split("/").slice(0, 2).join("/") },
  { rule: "wallets/{id}/ledger/* -> wallets/{id}", collection: "ledger", group: true, target: (path) => path.split("/").slice(0, 2).join("/") },
];

/** Compares the restored database with the chosen versions, then counts dangling references. */
export async function verifyRestore(source: BackupSource, plan: RestorePlan, check: RestoreCheck, identity: string, db: Firestore): Promise<DrillReport> {
  const expected = await expectedVersions(source, plan, check, identity);
  const collections: Record<string, CollectionReport> = {};
  const present = new Set<string>();
  let ok = true;
  for (const [collection, versions] of [...expected.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const snapshot = await (isRoot(versions.keys()) ? db.collection(collection) : db.collectionGroup(collection)).get();
    const restored = new Map<string, string>();
    for (const doc of snapshot.docs) {
      restored.set(doc.ref.path, canonicalJson(parseBackupLine(encodeDocument(doc)).d));
      present.add(doc.ref.path);
    }
    const missing = [...versions.keys()].filter((path) => !restored.has(path));
    const extra = [...restored.keys()].filter((path) => !versions.has(path));
    const different = [...versions.keys()].filter((path) => restored.has(path) && restored.get(path) !== versions.get(path));
    const report: CollectionReport = {
      expected: versions.size,
      restored: restored.size,
      missing: missing.slice(0, LIST_MAX),
      extra: extra.slice(0, LIST_MAX),
      different: different.slice(0, LIST_MAX),
      expectedSha256: digest(versions),
      restoredSha256: digest(restored),
    };
    if (missing.length > 0 || extra.length > 0 || different.length > 0 || report.expectedSha256 !== report.restoredSha256) ok = false;
    collections[collection] = report;
  }

  const references: ReferenceReport[] = [];
  for (const { rule, collection, group, target } of REFERENCE_RULES) {
    if (!expected.has(collection)) continue;
    const snapshot = await (group ? db.collectionGroup(collection) : db.collection(collection)).get();
    let checked = 0;
    let dangling = 0;
    for (const doc of snapshot.docs) {
      const path = target(doc.ref.path, doc.data());
      if (!path) continue;
      checked += 1;
      if (!present.has(path) && !(await db.doc(path).get()).exists) dangling += 1;
    }
    references.push({ rule, checked, dangling });
  }

  let newest = Number.NEGATIVE_INFINITY;
  for (const choice of check.choices.values()) if (choice.at > newest) newest = choice.at;
  return { collections, references, newestCapture: Number.isFinite(newest) ? new Date(newest) : null, ok };
}
