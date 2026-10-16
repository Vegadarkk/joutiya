import "server-only";
import { FieldPath, Timestamp, type DocumentReference, type Firestore, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { QUOTAS } from "@/config/quotas";
import { alert } from "@/lib/alert";
import { COLLECTIONS } from "@/lib/db/schemas";
import { logger } from "@/lib/logging/logger";
import { consume, isDegraded } from "@/lib/quota";
import type { ObjectStore } from "@/lib/storage";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";
import { encryptAge, isAgeRecipient } from "./crypto.ts";
import { encodeDocument, isDocumentPath } from "./encode.ts";
import { PART_MAX_BYTES, PART_MAX_DOCS, PartBuilder, manifestKey, partKey, sealPart, type BackupMode, type SealedPart } from "./parts.ts";

// Nightly export (D17), two passes written to the private bucket as NDJSON -> gzip -> age:
//   1. incremental, per collection: documents whose `updatedAt` (or, failing that, `createdAt`) is
//      at or after the collection's cursor, in (time, path) order. A budget or the read quota that
//      stops a scan leaves the cursor on the last exported (time, path): the next run continues
//      strictly after it, so documents sharing one timestamp are neither skipped nor looped on.
//      The pass starts with the collection it stopped at (round robin). Collections without such
//      a field are only in the rolling full;
//   2. rolling full: up to `fullBudget` documents a night across collections, ordered by document
//      path and continued from a per-collection cursor; a cycle is one pass over the table below.
// Cursors live in `system/backup` and move only once the manifest is stored: a failed run is
// redone by the next one. One run per UTC date: keys are per date, a second run would overwrite
// the first. Scans stop when the Firestore read quota reaches `readsStopRatio` (the app keeps its
// share), and one run reads at most `maxRunReads` documents (incremental first, the rolling full
// gets what is left of it). Without a valid recipient nothing is written: a backup is encrypted
// or does not exist. Deletions are not exported: a restore resurrects deleted documents
// (docs/backups.md); a purged listing is not deleted but replaced by a tombstone with `updatedAt`,
// so the next incremental carries it and the restore writes it over the older captures.
// The cursor document also keeps the encrypted bytes written per night (98 days, the private
// bucket's lifecycle): the R2 storage gauge counts them.

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
  favorites: { scope: "group", timeField: "createdAt" },
  savedSearches: { scope: "group", timeField: "updatedAt" },
  // Phase 5: messages and their evidence are subcollections of conversations/{cid}.
  conversations: { scope: "root", timeField: "updatedAt" },
  messages: { scope: "group", timeField: "createdAt" },
  evidence: { scope: "group", timeField: "createdAt" },
  userBlocks: { scope: "root", timeField: "updatedAt" },
  reports: { scope: "root", timeField: "updatedAt" },
  aiDecisions: { scope: "root", timeField: "createdAt" },
  authorityRequests: { scope: "root", timeField: "updatedAt" },
  suspensions: { scope: "root", timeField: "createdAt" },
};

export const BACKUP_COLLECTIONS: readonly BackupCollection[] = (Object.keys(TABLE) as BackedUpId[]).map((id) => ({ id, ...TABLE[id] }));

export interface BackupConfig {
  collections: readonly BackupCollection[];
  /** Documents the rolling full reads per run (D17: 10 000 a night, Spark 50 000 reads/day shared with the app), within maxRunReads. */
  fullBudget: number;
  /** Reads of one run, both passes together: the incremental goes first, the rolling full gets the rest. */
  maxRunReads: number;
  /** Documents the incremental reads per run; past it the cursors stay on the last exported document (nothing lost). */
  incrementalMax: number;
  pageSize: number;
  partMaxDocs: number;
  partMaxBytes: number;
  /** A collection read to its end restarts at now - overlapMs: tolerates clock skew between the app servers and the worker. */
  overlapMs: number;
  /** A collection without a cursor (first run): documents of the last 24 h, older ones come with the rolling full. */
  firstRunWindowMs: number;
  /** Share of the daily Firestore read quota at which the scans stop. */
  readsStopRatio: number;
  /** A rolling full cycle older than this alerts: past the 98-day retention some documents would have no copy. */
  maxCycleMs: number;
}

/** Share of the daily Firestore read quota one backup run may take (20 000 of 50 000 on Spark). */
export const BACKUP_RUN_READS_SHARE = 0.4;
/** Days a backup object lives in the private bucket (R2 lifecycle rule `backups-98d`, docs/backups.md). */
export const BACKUP_RETENTION_DAYS = 98;

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  collections: BACKUP_COLLECTIONS,
  fullBudget: 10_000,
  maxRunReads: Math.floor(QUOTAS["firestore.reads"].limit * BACKUP_RUN_READS_SHARE),
  incrementalMax: 20_000,
  pageSize: 500,
  partMaxDocs: PART_MAX_DOCS,
  partMaxBytes: PART_MAX_BYTES,
  overlapMs: 10 * 60_000,
  firstRunWindowMs: 24 * 3_600_000,
  readsStopRatio: 0.75,
  maxCycleMs: 60 * 86_400_000,
};

export interface IncrementalCursor {
  /** Inclusive lower bound of the time field (Firestore precision kept). */
  since: Timestamp;
  /** Last exported path at exactly `since`: the scan resumes strictly after (since, after). Null: `since` included. */
  after: string | null;
}

export interface FullCursor {
  /** Collection where the budget ran out (continued next night); null = the cycle is complete. */
  next: string | null;
  /** Last exported document path per collection still in progress. */
  after: Record<string, string>;
  cycleStartedAt: Date | null;
  cycleCompletedAt: Date | null;
}

export interface BackupCursors {
  incremental: Record<string, IncrementalCursor>;
  /** Collection the next incremental pass starts with (where a budget stopped it); null = table order. */
  incrementalNext: string | null;
  full: FullCursor;
  lastRunAt: Date | null;
  /** UTC date of the last completed run. */
  lastDate: string | null;
  /** Encrypted bytes (parts + manifest) written per UTC date, within the retention: the R2 gauge sums them. */
  storedBytes: Record<string, number>;
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
  counts: Record<BackupMode, Record<string, number>>;
  parts: ManifestPart[];
  /** Encrypted bytes of all parts. */
  bytes: number;
  reads: number;
  truncated: boolean;
  quotaStopped: boolean;
  /** Cursors stored for the next run. */
  cursors: CursorsJson;
  collections: BackupCollection[];
}

export interface CursorsJson {
  incremental: Record<string, { since: string; after: string | null }>;
  incrementalNext: string | null;
  full: { next: string | null; after: Record<string, string>; cycleStartedAt: string | null; cycleCompletedAt: string | null };
}

export type BackupSkipReason = "no_recipient" | "no_storage" | "reads_degraded" | "already_done";

export interface BackupResult {
  status: "done" | "skipped";
  reason?: BackupSkipReason;
  date: string;
  manifestKey: string | null;
  counts: Record<BackupMode, Record<string, number>>;
  parts: number;
  bytes: number;
  reads: number;
  /** The incremental pass did not reach the end of every collection (budget or quota): the next run continues. */
  truncated: boolean;
  /** The read quota stopped the scans. */
  quotaStopped: boolean;
  durationMs: number;
  cursors: BackupCursors | null;
  /** Encrypted bytes of every backup still within the retention, this run included (null when skipped). */
  retainedBytes: number | null;
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
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  return null;
}

function toTimestamp(value: unknown): Timestamp | null {
  if (value instanceof Timestamp) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return Timestamp.fromDate(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Paths only: a hand-edited value that is not a document path would make every run throw. */
function toPathMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string" && isDocumentPath(entry[1])));
}

function toIncremental(value: unknown): Record<string, IncrementalCursor> {
  if (!isRecord(value)) return {};
  const out: Record<string, IncrementalCursor> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const since = toTimestamp(raw["since"]);
    if (!since) continue;
    const after = raw["after"];
    out[id] = { since, after: typeof after === "string" && isDocumentPath(after) ? after : null };
  }
  return out;
}

export const EMPTY_CURSORS: BackupCursors = {
  incremental: {},
  incrementalNext: null,
  full: { next: null, after: {}, cycleStartedAt: null, cycleCompletedAt: null },
  lastRunAt: null,
  lastDate: null,
  storedBytes: {},
};

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function toBytesMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => DATE_KEY.test(entry[0]) && typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] >= 0));
}

/** First UTC date whose backups still exist on `now` (the lifecycle deletes objects older than the retention). */
function retentionStart(now: Date): string {
  return new Date(now.getTime() - BACKUP_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/** The entries of `storedBytes` still within the retention on `now`. */
export function retainedStoredBytes(storedBytes: Record<string, number>, now: Date): Record<string, number> {
  const start = retentionStart(now);
  return Object.fromEntries(Object.entries(storedBytes).filter(([date]) => date >= start));
}

/** Encrypted bytes of the backups still in the private bucket on `now`. */
export function sumRetainedBytes(storedBytes: Record<string, number>, now: Date): number {
  return Object.values(retainedStoredBytes(storedBytes, now)).reduce((sum, bytes) => sum + bytes, 0);
}

/** Backup bytes for the R2 storage gauge, from the cursor document (one read). */
export async function readRetainedBackupBytes(db: Firestore, now = new Date(), cursorDoc?: DocumentReference): Promise<number> {
  const snapshot = await (cursorDoc ?? db.collection(COLLECTIONS.system).doc("backup")).get();
  await consume("firestore.reads", 1);
  return sumRetainedBytes(parseCursors(snapshot.data()).storedBytes, now);
}

/** Tolerant read of system/backup: a missing or hand-edited document never breaks the job. */
export function parseCursors(data: unknown): BackupCursors {
  if (!isRecord(data)) return EMPTY_CURSORS;
  const full = isRecord(data["full"]) ? data["full"] : {};
  return {
    incremental: toIncremental(data["incremental"]),
    incrementalNext: typeof data["incrementalNext"] === "string" ? data["incrementalNext"] : null,
    full: {
      next: typeof full["next"] === "string" ? full["next"] : null,
      after: toPathMap(full["after"]),
      cycleStartedAt: toDate(full["cycleStartedAt"]),
      cycleCompletedAt: toDate(full["cycleCompletedAt"]),
    },
    lastRunAt: toDate(data["lastRunAt"]),
    lastDate: typeof data["lastDate"] === "string" && DATE_KEY.test(data["lastDate"]) ? data["lastDate"] : null,
    storedBytes: toBytesMap(data["storedBytes"]),
  };
}

/** The system/backup document for `cursors` (Timestamps, so the incremental bounds keep Firestore precision). */
export function serializeCursors(cursors: BackupCursors, now: Date): Record<string, unknown> {
  const ts = (date: Date | null) => (date ? Timestamp.fromDate(date) : null);
  return {
    incremental: Object.fromEntries(Object.entries(cursors.incremental).map(([id, cursor]) => [id, { since: cursor.since, after: cursor.after }])),
    incrementalNext: cursors.incrementalNext,
    full: { next: cursors.full.next, after: cursors.full.after, cycleStartedAt: ts(cursors.full.cycleStartedAt), cycleCompletedAt: ts(cursors.full.cycleCompletedAt) },
    lastRunAt: ts(cursors.lastRunAt),
    lastDate: cursors.lastDate,
    storedBytes: cursors.storedBytes,
    updatedAt: Timestamp.fromDate(now),
  };
}

function cursorsJson(cursors: BackupCursors): CursorsJson {
  const iso = (date: Date | null) => date?.toISOString() ?? null;
  return {
    incremental: Object.fromEntries(Object.entries(cursors.incremental).map(([id, cursor]) => [id, { since: cursor.since.toDate().toISOString(), after: cursor.after }])),
    incrementalNext: cursors.incrementalNext,
    full: { next: cursors.full.next, after: cursors.full.after, cycleStartedAt: iso(cursors.full.cycleStartedAt), cycleCompletedAt: iso(cursors.full.cycleCompletedAt) },
  };
}

// --- Alert when a run cannot happen (once per day and reason) ----------------------------------

const alertedInProcess = new Set<string>();

/** Tests: forget the in-process "alerted today" markers. */
export function resetBackupAlertMemory(): void {
  alertedInProcess.clear();
}

const SKIP_ALERT: Record<"no_recipient" | "no_storage", { title: string; body: (date: string) => string }> = {
  no_recipient: {
    title: "Sauvegarde Firestore non effectuée : clé de chiffrement absente",
    body: (date) =>
      `BACKUP_AGE_RECIPIENT absent ou invalide le ${date} : aucune sauvegarde écrite (jamais en clair). Générer la paire de clés age hors ligne (age-keygen) et renseigner la clé publique age1… dans l'environnement du worker.`,
  },
  no_storage: {
    title: "Sauvegarde Firestore non effectuée : stockage R2 non configuré",
    body: (date) => `Variables R2_* absentes le ${date} : aucune sauvegarde écrite. Renseigner les variables R2 dans l'environnement du worker.`,
  },
};

/** One alert per UTC date and reason (SET NX in valkey-queue, in-process without it); alert() also dedupes for an hour. */
export async function alertBackupSkipped(date: string, reason: "no_recipient" | "no_storage"): Promise<void> {
  const marker = `backup:alerted:${reason}:${date}`;
  if (isValkeyConfigured("queue")) {
    try {
      if ((await valkey("queue").set(marker, "1", "EX", 2 * 86_400, "NX")) !== "OK") return;
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "backup-firestore: alert marker unavailable");
    }
  } else {
    if (alertedInProcess.has(marker)) return;
    alertedInProcess.add(marker);
  }
  await alert({ severity: "P1", title: SKIP_ALERT[reason].title, body: SKIP_ALERT[reason].body(date) });
}

/** A syntactically valid recipient can still carry a bad checksum: encrypting nothing proves it before any read. */
async function usableRecipient(recipient: string | undefined): Promise<boolean> {
  if (!isAgeRecipient(recipient)) return false;
  try {
    await encryptAge(new Uint8Array(0), recipient);
    return true;
  } catch {
    return false;
  }
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

  constructor(
    private readonly ctx: WriterContext,
    private readonly mode: BackupMode,
    private readonly collection: string,
  ) {
    this.builder = new PartBuilder(ctx.limits);
  }

  async add(snapshot: QueryDocumentSnapshot): Promise<void> {
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

interface RunState {
  reads: number;
  /** Set once the read quota reached readsStopRatio: every later scan returns at once. */
  quotaStopped: boolean;
  readsStopRatio: number;
}

interface ScanResult {
  docs: number;
  /** True when the query returned fewer documents than asked: nothing left after `last`. */
  exhausted: boolean;
  last: QueryDocumentSnapshot | null;
}

/**
 * Reads `query` in pages of `pageSize`, at most `max` documents, from strictly after `startAfter`
 * (values of the query's orderBy fields). Counts the reads: one at least per page, Firestore bills
 * an empty result as one read.
 */
async function scan(query: Query, max: number, pageSize: number, startAfter: unknown[] | null, state: RunState, onDoc: (snapshot: QueryDocumentSnapshot) => Promise<void>): Promise<ScanResult> {
  let docs = 0;
  let last: QueryDocumentSnapshot | null = null;
  while (docs < max && !state.quotaStopped) {
    const limit = Math.min(pageSize, max - docs);
    let page = query.limit(limit);
    if (last) page = page.startAfter(last);
    else if (startAfter) page = page.startAfter(...startAfter);
    const snapshot = await page.get();
    const billed = Math.max(1, snapshot.size);
    state.reads += billed;
    const quota = await consume("firestore.reads", billed);
    if (quota.level !== "unknown" && quota.ratio >= state.readsStopRatio) state.quotaStopped = true;
    for (const doc of snapshot.docs) await onDoc(doc);
    docs += snapshot.size;
    if (snapshot.size > 0) last = snapshot.docs[snapshot.size - 1] as QueryDocumentSnapshot;
    if (snapshot.size < limit) return { docs, exhausted: true, last };
  }
  return { docs, exhausted: false, last };
}

function baseQuery(db: Firestore, collection: BackupCollection): Query {
  return collection.scope === "group" ? db.collectionGroup(collection.id) : db.collection(collection.id);
}

/** A cursor path the collection's query can resume after (a stray hand-edited path would make every run throw). */
function resumable(collection: BackupCollection, path: string | null | undefined): path is string {
  if (!path) return false;
  const segments = path.split("/");
  return collection.scope === "root" ? segments.length === 2 && segments[0] === collection.id : segments[segments.length - 2] === collection.id;
}

// --- The job -----------------------------------------------------------------------------------

/** A run that wrote nothing (also used by the worker job when the storage is missing). */
export function skippedBackup(reason: BackupSkipReason, date: string, durationMs = 0): BackupResult {
  return { status: "skipped", reason, date, manifestKey: null, counts: { incremental: {}, full: {} }, parts: 0, bytes: 0, reads: 0, truncated: false, quotaStopped: false, durationMs, cursors: null, retainedBytes: null };
}

export async function runBackup(input: RunBackupInput): Promise<BackupResult> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const config: BackupConfig = { ...DEFAULT_BACKUP_CONFIG, ...input.config };

  if (!(await usableRecipient(input.recipient))) {
    logger.warn({ date }, "backup-firestore: BACKUP_AGE_RECIPIENT missing or invalid, nothing written");
    await alertBackupSkipped(date, "no_recipient");
    return skippedBackup("no_recipient", date);
  }
  const recipient = input.recipient as string;
  if (await isDegraded("firestore.reads")) {
    logger.warn({ date }, "backup-firestore deferred: Firestore read quota degraded");
    return skippedBackup("reads_degraded", date);
  }

  const { db, store } = input;
  const cursorDoc = input.cursorDoc ?? db.collection(COLLECTIONS.system).doc("backup");
  const previous = parseCursors((await cursorDoc.get()).data());
  const state: RunState = { reads: 1, quotaStopped: false, readsStopRatio: config.readsStopRatio };
  await consume("firestore.reads", 1);
  const key = manifestKey(date);
  // A manifest without moved cursors (a run that failed after storing it) is kept: its cursors
  // stayed behind, so tomorrow's run covers the same windows again.
  if (previous.lastDate === date || (await store.head("private", key))) {
    logger.info({ date }, "backup-firestore: already done for this date");
    return skippedBackup("already_done", date, Date.now() - started);
  }

  const ctx: WriterContext = { store, recipient, date, limits: { maxDocs: config.partMaxDocs, maxBytes: config.partMaxBytes } };
  const counts: Record<BackupMode, Record<string, number>> = { incremental: {}, full: {} };
  const parts: ManifestPart[] = [];
  const order = config.collections;
  const known = new Set(order.map((collection) => collection.id));

  // 1. Incremental, from each collection's cursor, starting where the previous pass stopped.
  const incremental = Object.fromEntries(Object.entries(previous.incremental).filter(([id]) => known.has(id)));
  const firstSince = Timestamp.fromDate(new Date(now.getTime() - config.firstRunWindowMs));
  const overlapSince = Timestamp.fromDate(new Date(now.getTime() - config.overlapMs));
  const timed = order.filter((collection) => collection.timeField !== null);
  const startAt = Math.max(0, timed.findIndex((collection) => collection.id === previous.incrementalNext));
  let budget = Math.min(config.incrementalMax, config.maxRunReads - state.reads);
  let incrementalNext: string | null = null;
  for (let step = 0; step < timed.length; step += 1) {
    const collection = timed[(startAt + step) % timed.length] as BackupCollection;
    const field = collection.timeField as TimeField;
    // Recorded even when the scan does not happen tonight: a later first window would skip documents.
    const cursor = (incremental[collection.id] ??= { since: firstSince, after: null });
    if (budget <= 0 || state.quotaStopped) {
      incrementalNext ??= collection.id;
      continue;
    }
    const writer = new CollectionWriter(ctx, "incremental", collection.id);
    const query = baseQuery(db, collection).where(field, ">=", cursor.since).orderBy(field).orderBy(FieldPath.documentId());
    const result = await scan(query, budget, config.pageSize, resumable(collection, cursor.after) ? [cursor.since, db.doc(cursor.after)] : null, state, (doc) => writer.add(doc));
    await writer.finish();
    budget -= result.docs;
    counts.incremental[collection.id] = result.docs;
    parts.push(...writer.parts);
    if (result.exhausted) {
      incremental[collection.id] = { since: overlapSince, after: null };
      continue;
    }
    incrementalNext ??= collection.id;
    const lastAt: unknown = result.last?.get(field);
    // Nothing read (quota stop before the first page): the cursor stays where it was.
    if (result.last && lastAt instanceof Timestamp) incremental[collection.id] = { since: lastAt, after: result.last.ref.path };
  }
  const truncated = incrementalNext !== null;

  // 2. Rolling full, continued from the previous night (a new cycle forgets stray cursors).
  const continuing = previous.full.next !== null && known.has(previous.full.next);
  const after = continuing ? Object.fromEntries(Object.entries(previous.full.after).filter(([id]) => known.has(id))) : {};
  const startIndex = continuing ? order.findIndex((collection) => collection.id === previous.full.next) : 0;
  const cycleStartedAt = continuing ? (previous.full.cycleStartedAt ?? now) : now;
  // Bounded by what the incremental left of the run's reads: a busy day shortens the rotation, never the app's share.
  let remaining = Math.min(config.fullBudget, config.maxRunReads - state.reads);
  let fullNext: string | null = null;
  for (let index = startIndex; index < order.length; index += 1) {
    const collection = order[index] as BackupCollection;
    if (remaining <= 0 || state.quotaStopped) {
      fullNext = collection.id;
      break;
    }
    const writer = new CollectionWriter(ctx, "full", collection.id);
    const resume = after[collection.id];
    const result = await scan(baseQuery(db, collection).orderBy(FieldPath.documentId()), remaining, config.pageSize, resumable(collection, resume) ? [db.doc(resume)] : null, state, (doc) => writer.add(doc));
    await writer.finish();
    remaining -= result.docs;
    counts.full[collection.id] = result.docs;
    parts.push(...writer.parts);
    if (result.exhausted) {
      delete after[collection.id];
    } else {
      if (result.last) after[collection.id] = result.last.ref.path;
      fullNext = collection.id;
      break;
    }
  }
  const cycleComplete = fullNext === null;
  if (truncated || state.quotaStopped) logger.warn({ date, incrementalNext, quotaStopped: state.quotaStopped }, "backup-firestore: incremental stopped early, the cursors stay behind");

  // 3. Manifest, then the cursors (a failed upload leaves the cursors untouched: the next run redoes the work).
  const cursors: BackupCursors = {
    incremental,
    incrementalNext,
    full: { next: fullNext, after, cycleStartedAt, cycleCompletedAt: cycleComplete ? now : previous.full.cycleCompletedAt },
    lastRunAt: now,
    lastDate: date,
    storedBytes: retainedStoredBytes(previous.storedBytes, now),
  };
  const finishedAt = new Date();
  const bytes = parts.reduce((sum, part) => sum + part.bytes, 0);
  const manifest: BackupManifest = {
    version: 1,
    date,
    startedAt: now.toISOString(),
    finishedAt: finishedAt.toISOString(),
    counts,
    parts,
    bytes,
    reads: state.reads,
    truncated,
    quotaStopped: state.quotaStopped,
    cursors: cursorsJson(cursors),
    collections: [...order],
  };
  // The manifest is age only (no gzip), as its name says: `age -d` prints it.
  const manifestBody = await encryptAge(Buffer.from(JSON.stringify(manifest), "utf8"), recipient);
  await store.put("private", key, manifestBody, { contentType: CONTENT_TYPE });
  cursors.storedBytes[date] = bytes + manifestBody.byteLength;
  const retainedBytes = sumRetainedBytes(cursors.storedBytes, now);
  await cursorDoc.set(serializeCursors(cursors, finishedAt));
  await consume("firestore.writes", 1);

  if (state.quotaStopped) {
    await alert({ severity: "P2", title: "Sauvegarde Firestore incomplète : quota de lectures", body: `Le ${date}, les lectures Firestore ont atteint ${Math.round(config.readsStopRatio * 100)} % du quota du jour : sauvegarde arrêtée, reprise la nuit suivante depuis les curseurs.` });
  }
  if (!cycleComplete && now.getTime() - cycleStartedAt.getTime() > config.maxCycleMs) {
    await alert({
      severity: "P2",
      title: "Sauvegarde Firestore : rotation complète trop lente",
      body: `La rotation complète commencée le ${cycleStartedAt.toISOString().slice(0, 10)} n'est pas terminée : au-delà de 98 jours, des documents n'auraient plus aucune copie. Augmenter le budget de nuit ou réduire les lectures de l'application.`,
    });
  }

  const durationMs = Date.now() - started;
  const result: BackupResult = { status: "done", date, manifestKey: key, counts, parts: parts.length, bytes, reads: state.reads, truncated, quotaStopped: state.quotaStopped, durationMs, cursors, retainedBytes };
  logger.info({ date, counts, parts: parts.length, bytes, reads: state.reads, truncated, quotaStopped: state.quotaStopped, fullNext, cycleComplete, durationMs }, "backup-firestore");
  return result;
}
