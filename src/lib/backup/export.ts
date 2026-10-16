import "server-only";
import { FieldPath, Timestamp, type DocumentReference, type Firestore, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { alert } from "@/lib/alert";
import { COLLECTIONS } from "@/lib/db/schemas";
import { logger } from "@/lib/logging/logger";
import { consume, isDegraded } from "@/lib/quota";
import type { ObjectStore } from "@/lib/storage";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";
import { encryptAge, isAgeRecipient } from "./crypto.ts";
import { encodeDocument } from "./encode.ts";
import { PART_MAX_BYTES, PART_MAX_DOCS, PartBuilder, manifestKey, partKey, sealPart, type BackupMode, type SealedPart } from "./parts.ts";

// Nightly export (D17), two passes written to the private bucket as NDJSON -> gzip -> age:
//   - incremental: documents whose `updatedAt` (or, failing that, `createdAt`) is >= the last
//     cursor; collections without such a field are only in the rolling full;
//   - rolling full: up to `fullBudget` documents a night across collections, ordered by document
//     id and continued from a per-collection cursor; a cycle is one pass over the table below.
// Cursors live in `system/backup`. Without a valid recipient nothing is written: a backup is
// encrypted or does not exist. Deletions are not exported: a restore resurrects purged documents
// (run retention-purge after a restore, see notes-backup.md).

export type TimeField = "updatedAt" | "createdAt";

export interface BackupCollection {
  id: string;
  /** "group": a subcollection exported through collectionGroup() (users/{uid}/private/account). */
  scope: "root" | "group";
  /** Field of the incremental query; null = rolling full only. */
  timeField: TimeField | null;
}

type CollectionId = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
/** `account` is a document id, `system` holds the cursors themselves. */
type BackedUpId = Exclude<CollectionId, typeof COLLECTIONS.userPrivateDoc | typeof COLLECTIONS.system>;

/**
 * Time field per collection, from the Zod schemas of src/lib/db/schemas.ts. Adding a collection to
 * COLLECTIONS fails to compile until it is listed here: a backup is a conscious decision.
 * `connectionLogs`, `auditLogs`, `contentOps`, `revealLogs`, `mailSuppressions` only have `at`
 * (append-only journals): rolling full only. `quotaDaily` and `config/legal` are not in
 * COLLECTIONS and are rebuilt by the app and the owner (scripts/legal-config.ts).
 */
const TABLE: Record<BackedUpId, Omit<BackupCollection, "id">> = {
  users: { scope: "root", timeField: "updatedAt" },
  private: { scope: "group", timeField: null },
  emailIndex: { scope: "root", timeField: "createdAt" },
  connectionLogs: { scope: "root", timeField: null },
  auditLogs: { scope: "root", timeField: null },
  mailSuppressions: { scope: "root", timeField: null },
  staff: { scope: "root", timeField: "createdAt" },
  listings: { scope: "root", timeField: "updatedAt" },
  listingStats: { scope: "root", timeField: null },
  uploads: { scope: "root", timeField: "updatedAt" },
  searchOutbox: { scope: "root", timeField: null },
  contentOps: { scope: "root", timeField: null },
  revealLogs: { scope: "root", timeField: null },
  moderationDecisions: { scope: "root", timeField: "createdAt" },
};

export const BACKUP_COLLECTIONS: readonly BackupCollection[] = (Object.keys(TABLE) as BackedUpId[]).map((id) => ({ id, ...TABLE[id] }));

export interface BackupConfig {
  collections: readonly BackupCollection[];
  /** Documents the rolling full reads per run (D17: 10 000 a night, Spark 50 000 reads/day shared with the app). */
  fullBudget: number;
  /** Safety cap of the incremental; past it the cursor stops at the last exported document (nothing lost). */
  incrementalMax: number;
  pageSize: number;
  partMaxDocs: number;
  partMaxBytes: number;
  /** Next incremental lower bound = now - overlapMs: tolerates clock skew between the app servers and the worker. */
  overlapMs: number;
  /** First run (no cursor): documents of the last 24 h. */
  firstRunWindowMs: number;
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  collections: BACKUP_COLLECTIONS,
  fullBudget: 10_000,
  incrementalMax: 20_000,
  pageSize: 500,
  partMaxDocs: PART_MAX_DOCS,
  partMaxBytes: PART_MAX_BYTES,
  overlapMs: 10 * 60_000,
  firstRunWindowMs: 24 * 3_600_000,
};

export interface FullCursor {
  /** Collection where the budget ran out (continued next night); null = the cycle is complete. */
  next: string | null;
  /** Last exported document path per collection still in progress. */
  after: Record<string, string>;
  cycleStartedAt: Date | null;
  cycleCompletedAt: Date | null;
}

export interface BackupCursors {
  /** Lower bound of the next incremental run; null before the first run. */
  incrementalSince: Date | null;
  full: FullCursor;
  lastRunAt: Date | null;
  lastDate: string | null;
}

export interface ManifestPart {
  key: string;
  mode: BackupMode;
  collection: string;
  part: number | null;
  docs: number;
  plainBytes: number;
  gzipBytes: number;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  version: 1;
  date: string;
  startedAt: string;
  finishedAt: string;
  /** Incremental window used by this run (inclusive lower bound) and the one stored for the next. */
  since: string;
  nextSince: string;
  counts: Record<BackupMode, Record<string, number>>;
  parts: ManifestPart[];
  /** Encrypted bytes of all parts. */
  bytes: number;
  reads: number;
  truncated: boolean;
  cursors: {
    incrementalSince: string | null;
    full: { next: string | null; after: Record<string, string>; cycleStartedAt: string | null; cycleCompletedAt: string | null };
  };
  collections: BackupCollection[];
}

export interface BackupResult {
  status: "done" | "skipped";
  reason?: "no_recipient" | "reads_degraded";
  date: string;
  manifestKey: string | null;
  counts: Record<BackupMode, Record<string, number>>;
  parts: number;
  bytes: number;
  reads: number;
  truncated: boolean;
  cursors: BackupCursors | null;
}

export interface RunBackupInput {
  db: Firestore;
  store: ObjectStore;
  /** BACKUP_AGE_RECIPIENT; anything but a valid X25519 recipient skips the run. */
  recipient: string | undefined;
  now?: Date;
  /** Cursor document (default system/backup). */
  cursorDoc?: DocumentReference;
  config?: Partial<BackupConfig>;
}

const CONTENT_TYPE = "application/octet-stream";

// --- Cursor document ---------------------------------------------------------------------------

function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

function toStringMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export const EMPTY_CURSORS: BackupCursors = {
  incrementalSince: null,
  full: { next: null, after: {}, cycleStartedAt: null, cycleCompletedAt: null },
  lastRunAt: null,
  lastDate: null,
};

/** Tolerant read of system/backup: a missing or hand-edited document never breaks the job. */
export function parseCursors(data: unknown): BackupCursors {
  if (data === null || typeof data !== "object") return EMPTY_CURSORS;
  const doc = data as Record<string, unknown>;
  const full = (doc["full"] ?? {}) as Record<string, unknown>;
  return {
    incrementalSince: toDate(doc["incrementalSince"]),
    full: {
      next: typeof full["next"] === "string" ? full["next"] : null,
      after: toStringMap(full["after"]),
      cycleStartedAt: toDate(full["cycleStartedAt"]),
      cycleCompletedAt: toDate(full["cycleCompletedAt"]),
    },
    lastRunAt: toDate(doc["lastRunAt"]),
    lastDate: typeof doc["lastDate"] === "string" ? doc["lastDate"] : null,
  };
}

function cursorDocData(cursors: BackupCursors, now: Date): Record<string, unknown> {
  const ts = (date: Date | null) => (date ? Timestamp.fromDate(date) : null);
  return {
    incrementalSince: ts(cursors.incrementalSince),
    full: { next: cursors.full.next, after: cursors.full.after, cycleStartedAt: ts(cursors.full.cycleStartedAt), cycleCompletedAt: ts(cursors.full.cycleCompletedAt) },
    lastRunAt: ts(cursors.lastRunAt),
    lastDate: cursors.lastDate,
    updatedAt: Timestamp.fromDate(now),
  };
}

// --- Alert without a recipient (once per day) --------------------------------------------------

let alertedDate: string | null = null;

/** Tests: forget the in-process "alerted today" marker. */
export function resetBackupAlertMemory(): void {
  alertedDate = null;
}

async function alertNoRecipientOnce(date: string): Promise<void> {
  if (isValkeyConfigured("queue")) {
    try {
      if ((await valkey("queue").set(`backup:alerted:no-recipient:${date}`, "1", "EX", 2 * 86_400, "NX")) !== "OK") return;
    } catch (error) {
      // alert() still dedupes the same title for an hour.
      logger.warn({ err: (error as Error).message }, "backup-firestore: alert marker unavailable");
    }
  } else {
    if (alertedDate === date) return;
    alertedDate = date;
  }
  await alert({
    severity: "P1",
    title: "Sauvegarde Firestore non effectuée : clé de chiffrement absente",
    body: `BACKUP_AGE_RECIPIENT absent ou invalide le ${date} : aucune sauvegarde écrite (jamais en clair). Générer la paire de clés age hors ligne (age-keygen) et renseigner la clé publique age1… dans l'environnement du worker.`,
  });
}

// --- Parts of one (mode, collection) -----------------------------------------------------------

interface WriterContext {
  store: ObjectStore;
  recipient: string;
  date: string;
  limits: { maxDocs: number; maxBytes: number };
}

/**
 * Feeds lines to a PartBuilder and uploads sealed parts. The first part is held back until the
 * collection ends: alone it is `{collection}.ndjson.gz.age`, otherwise `{collection}-1`, `-2`, ...
 */
class CollectionWriter {
  private readonly builder: PartBuilder;
  private sealed = 0;
  private first: SealedPart | null = null;
  readonly parts: ManifestPart[] = [];
  docs = 0;

  constructor(
    private readonly ctx: WriterContext,
    private readonly mode: BackupMode,
    private readonly collection: string,
  ) {
    this.builder = new PartBuilder(ctx.limits);
  }

  async add(snapshot: QueryDocumentSnapshot): Promise<void> {
    this.docs += 1;
    const full = this.builder.push(encodeDocument(snapshot));
    if (full) await this.seal(full);
  }

  async finish(): Promise<void> {
    const rest = this.builder.flush();
    if (rest.length > 0) await this.seal(rest);
    if (this.first) {
      await this.upload(this.first, null);
      this.first = null;
    }
  }

  private async seal(lines: readonly string[]): Promise<void> {
    const part = await sealPart(lines, this.ctx.recipient);
    this.sealed += 1;
    if (this.sealed === 1) {
      this.first = part;
      return;
    }
    if (this.first) {
      await this.upload(this.first, 1);
      this.first = null;
    }
    await this.upload(part, this.sealed);
  }

  private async upload(part: SealedPart, number: number | null): Promise<void> {
    const key = partKey(this.ctx.date, this.mode, this.collection, number);
    await this.ctx.store.put("private", key, part.body, { contentType: CONTENT_TYPE });
    this.parts.push({ key, mode: this.mode, collection: this.collection, part: number, docs: part.docs, plainBytes: part.plainBytes, gzipBytes: part.gzipBytes, bytes: part.bytes, sha256: part.sha256 });
  }
}

// --- Paginated scans ---------------------------------------------------------------------------

interface ScanResult {
  docs: number;
  /** True when the query returned fewer documents than asked: nothing left after `last`. */
  exhausted: boolean;
  last: QueryDocumentSnapshot | null;
}

/** Reads `query` in pages of `pageSize`, at most `max` documents, counting the reads (one at least per page: Firestore bills an empty result as one read). */
async function scan(query: Query, max: number, pageSize: number, startAfter: DocumentReference | null, onDoc: (snapshot: QueryDocumentSnapshot) => Promise<void>): Promise<{ result: ScanResult; reads: number }> {
  let remaining = max;
  let reads = 0;
  let cursor: DocumentReference | QueryDocumentSnapshot | null = startAfter;
  let last: QueryDocumentSnapshot | null = null;
  while (remaining > 0) {
    const limit = Math.min(pageSize, remaining);
    let page = query.limit(limit);
    if (cursor) page = page.startAfter(cursor);
    const snapshot = await page.get();
    reads += Math.max(1, snapshot.size);
    await consume("firestore.reads", Math.max(1, snapshot.size));
    for (const doc of snapshot.docs) await onDoc(doc);
    remaining -= snapshot.size;
    if (snapshot.size > 0) {
      last = snapshot.docs[snapshot.size - 1] as QueryDocumentSnapshot;
      cursor = last;
    }
    if (snapshot.size < limit) return { result: { docs: max - remaining, exhausted: true, last }, reads };
  }
  return { result: { docs: max - remaining, exhausted: false, last }, reads };
}

function baseQuery(db: Firestore, collection: BackupCollection): Query {
  return collection.scope === "group" ? db.collectionGroup(collection.id) : db.collection(collection.id);
}

// --- The job -----------------------------------------------------------------------------------

function skipped(reason: NonNullable<BackupResult["reason"]>, date: string): BackupResult {
  return { status: "skipped", reason, date, manifestKey: null, counts: { incremental: {}, full: {} }, parts: 0, bytes: 0, reads: 0, truncated: false, cursors: null };
}

export async function runBackup(input: RunBackupInput): Promise<BackupResult> {
  const now = input.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const config: BackupConfig = { ...DEFAULT_BACKUP_CONFIG, ...input.config };

  if (!isAgeRecipient(input.recipient)) {
    logger.warn({ date }, "backup-firestore: BACKUP_AGE_RECIPIENT missing or invalid, nothing written");
    await alertNoRecipientOnce(date);
    return skipped("no_recipient", date);
  }
  const recipient = input.recipient;
  if (await isDegraded("firestore.reads")) {
    logger.warn({ date }, "backup-firestore deferred: Firestore read quota degraded");
    return skipped("reads_degraded", date);
  }

  const { db, store } = input;
  const cursorDoc = input.cursorDoc ?? db.collection(COLLECTIONS.system).doc("backup");
  const previous = parseCursors((await cursorDoc.get()).data());
  let reads = 1;
  await consume("firestore.reads", 1);

  const ctx: WriterContext = { store, recipient, date, limits: { maxDocs: config.partMaxDocs, maxBytes: config.partMaxBytes } };
  const counts: Record<BackupMode, Record<string, number>> = { incremental: {}, full: {} };
  const parts: ManifestPart[] = [];
  const order = config.collections;

  // 1. Rolling full, continued from the previous night.
  const after = Object.fromEntries(Object.entries(previous.full.after).filter(([id]) => order.some((collection) => collection.id === id)));
  const startIndex = Math.max(0, previous.full.next ? order.findIndex((collection) => collection.id === previous.full.next) : 0);
  const cycleStartedAt = previous.full.next ? (previous.full.cycleStartedAt ?? now) : now;
  let remaining = config.fullBudget;
  let next: string | null = null;
  for (let index = startIndex; index < order.length; index += 1) {
    const collection = order[index] as BackupCollection;
    if (remaining <= 0) {
      next = collection.id;
      break;
    }
    const writer = new CollectionWriter(ctx, "full", collection.id);
    const resume = after[collection.id];
    const { result, reads: pageReads } = await scan(baseQuery(db, collection).orderBy(FieldPath.documentId()), remaining, config.pageSize, resume ? db.doc(resume) : null, (doc) => writer.add(doc));
    await writer.finish();
    reads += pageReads;
    remaining -= result.docs;
    counts.full[collection.id] = result.docs;
    parts.push(...writer.parts);
    if (result.exhausted) {
      delete after[collection.id];
    } else {
      if (result.last) after[collection.id] = result.last.ref.path;
      next = collection.id;
      break;
    }
  }
  const cycleComplete = next === null;

  // 2. Incremental: documents touched since the previous run (first run: the last 24 h).
  const since = previous.incrementalSince ?? new Date(now.getTime() - config.firstRunWindowMs);
  const sinceTs = Timestamp.fromDate(since);
  let incrementalBudget = config.incrementalMax;
  let truncatedAt: Date | null = null;
  for (const collection of order) {
    if (!collection.timeField) continue;
    if (incrementalBudget <= 0) {
      truncatedAt ??= since;
      break;
    }
    const field = collection.timeField;
    const writer = new CollectionWriter(ctx, "incremental", collection.id);
    const query = baseQuery(db, collection).where(field, ">=", sinceTs).orderBy(field).orderBy(FieldPath.documentId());
    const { result, reads: pageReads } = await scan(query, incrementalBudget, config.pageSize, null, (doc) => writer.add(doc));
    await writer.finish();
    reads += pageReads;
    incrementalBudget -= result.docs;
    counts.incremental[collection.id] = result.docs;
    parts.push(...writer.parts);
    if (!result.exhausted) {
      // The cursor stops at the last exported document (">=" re-exports its instant): nothing is lost.
      const lastAt = toDate(result.last?.get(field)) ?? since;
      truncatedAt = truncatedAt && truncatedAt < lastAt ? truncatedAt : lastAt;
    }
  }
  const overlapSince = new Date(now.getTime() - config.overlapMs);
  const nextSince = truncatedAt && truncatedAt < overlapSince ? truncatedAt : overlapSince;
  const truncated = truncatedAt !== null;
  if (truncated) logger.warn({ date, incrementalMax: config.incrementalMax }, "backup-firestore: incremental capped, the cursor stays behind");

  // 3. Manifest, then the cursors (a failed upload leaves the cursors untouched: the next run redoes the work).
  const cursors: BackupCursors = {
    incrementalSince: nextSince,
    full: { next, after, cycleStartedAt, cycleCompletedAt: cycleComplete ? now : previous.full.cycleCompletedAt },
    lastRunAt: now,
    lastDate: date,
  };
  const finishedAt = new Date();
  const bytes = parts.reduce((sum, part) => sum + part.bytes, 0);
  const manifest: BackupManifest = {
    version: 1,
    date,
    startedAt: now.toISOString(),
    finishedAt: finishedAt.toISOString(),
    since: since.toISOString(),
    nextSince: nextSince.toISOString(),
    counts,
    parts,
    bytes,
    reads,
    truncated,
    cursors: {
      incrementalSince: nextSince.toISOString(),
      full: { next, after, cycleStartedAt: cycleStartedAt.toISOString(), cycleCompletedAt: cursors.full.cycleCompletedAt?.toISOString() ?? null },
    },
    collections: [...order],
  };
  // The manifest is age only (no gzip), as its name says: `age -d` prints it.
  const key = manifestKey(date);
  await store.put("private", key, await encryptAge(Buffer.from(JSON.stringify(manifest), "utf8"), recipient), { contentType: CONTENT_TYPE });
  await cursorDoc.set(cursorDocData(cursors, finishedAt));
  await consume("firestore.writes", 1);

  const result: BackupResult = { status: "done", date, manifestKey: key, counts, parts: parts.length, bytes, reads, truncated, cursors };
  logger.info({ date, counts, parts: parts.length, bytes, reads, truncated, fullNext: next, cycleComplete }, "backup-firestore");
  return result;
}
