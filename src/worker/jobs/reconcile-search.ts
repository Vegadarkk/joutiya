import { FieldPath, Timestamp, type Query } from "firebase-admin/firestore";
import { alert } from "@/lib/alert";
import { LISTING_STATUSES, MODERATION_STATES } from "@/lib/contracts/listings";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume, isDegraded } from "@/lib/quota";
import { isIndexable } from "@/lib/search/document";
import { searchEngine } from "@/lib/search/engine";
import { enqueueIndex } from "@/lib/search/queue";
import type { SearchEngine } from "@/lib/search/types";
import { z } from "@/lib/zod";

// Nightly at 04:20 UTC, after the backup's reads (design D11): Firestore vs the search index.
// Up to 8 000 published listings: full scan; beyond, a rolling window of 8 000 by document id
// (cursor in system/searchReconcile), so the read budget stays flat as the site grows. Drift =
// indexable but missing or at another version, or in the index without being indexable (inside
// the scanned id window). Drifted ids become forced `index-listing` jobs (the engine keeps a
// single writer), counts go to system/searchReconcile and the log, any drift raises a P2 alert.

export const RECONCILE_FULL_MAX = 8_000;
export const RECONCILE_WINDOW = 8_000;
export const RECONCILE_PAGE = 500;
export const RECONCILE_ALERT_TITLE = "Écarts entre Firestore et la recherche";
const RECONCILE_DOC = "searchReconcile";
/** Ids per enqueue call. */
const DISPATCH_CHUNK = 500;

/** One published listing as the scan selects it. */
export interface ReconcileRow {
  id: string;
  version: number;
  indexable: boolean;
}

/** Document ids in (after, through]; null = unbounded on that side. */
export interface IdWindow {
  after: string | null;
  through: string | null;
}

export function inWindow(id: string, window: IdWindow): boolean {
  return (window.after === null || id > window.after) && (window.through === null || id <= window.through);
}

export interface Drift {
  /** Indexable, absent from the index. */
  missing: string[];
  /** Indexable, indexed at another version. */
  stale: string[];
  /** Indexed (inside the window) without being indexable. */
  orphans: string[];
}

/** Pure drift computation: `engine` maps indexed ids to their version. */
export function computeDrift(rows: readonly ReconcileRow[], engine: ReadonlyMap<string, number>, window: IdWindow): Drift {
  const drift: Drift = { missing: [], stale: [], orphans: [] };
  const indexable = new Set<string>();
  for (const row of rows) {
    if (!row.indexable) continue;
    indexable.add(row.id);
    const version = engine.get(row.id);
    if (version === undefined) drift.missing.push(row.id);
    else if (version !== row.version) drift.stale.push(row.id);
  }
  for (const id of engine.keys()) if (inWindow(id, window) && !indexable.has(id)) drift.orphans.push(id);
  return drift;
}

const SELECTED = ["status", "version", "slugId", "categoryId", "subcategoryId", "location", "moderation.state", "moderation.hiddenBy"] as const;

/** The projection of SELECTED; a document that does not parse counts as not indexable. */
const rowSchema = z.object({
  status: z.enum(LISTING_STATUSES),
  version: z.number().int().min(0),
  slugId: z.string().min(1).optional(),
  categoryId: z.string().min(1).optional(),
  subcategoryId: z.string().min(1).optional(),
  location: z.object({ regionCode: z.string().min(1), citySlug: z.string().min(1) }).optional(),
  moderation: z.object({ state: z.enum(MODERATION_STATES), hiddenBy: z.unknown().optional() }),
});

function toRow(id: string, data: unknown): ReconcileRow {
  const parsed = rowSchema.safeParse(data);
  if (parsed.success) return { id, version: parsed.data.version, indexable: isIndexable(parsed.data) };
  const version = typeof data === "object" && data !== null && "version" in data && typeof data.version === "number" ? data.version : -1;
  return { id, version, indexable: false };
}

interface Scan {
  rows: ReconcileRow[];
  window: IdWindow;
  /** Where the next run starts (null: from the first id). */
  next: string | null;
}

/** Published listings by id after `after`, up to `max` documents (pages of RECONCILE_PAGE). */
async function scanPublished(after: string | null, max: number): Promise<Scan> {
  const rows: ReconcileRow[] = [];
  let cursor = after;
  let reachedEnd = false;
  while (rows.length < max) {
    let query: Query = db().collection(COLLECTIONS.listings).where("status", "==", "published").orderBy(FieldPath.documentId(), "asc");
    if (cursor) query = query.startAfter(cursor);
    const limit = Math.min(RECONCILE_PAGE, max - rows.length);
    const snapshot = await query.select(...SELECTED).limit(limit).get();
    void consume("firestore.reads", Math.max(1, snapshot.size));
    for (const doc of snapshot.docs) rows.push(toRow(doc.id, doc.data()));
    const last = snapshot.docs[snapshot.docs.length - 1];
    if (!last || snapshot.size < limit) {
      reachedEnd = true;
      break;
    }
    cursor = last.id;
  }
  const through = reachedEnd ? null : (rows[rows.length - 1]?.id ?? null);
  return { rows, window: { after, through }, next: through };
}

async function countPublished(): Promise<number> {
  const result = await db().collection(COLLECTIONS.listings).where("status", "==", "published").count().get();
  const count = result.data().count;
  // Aggregations bill one read per 1 000 index entries matched (at least one).
  void consume("firestore.reads", Math.max(1, Math.ceil(count / 1_000)));
  return count;
}

async function readCursor(): Promise<string | null> {
  const snapshot = await db().collection(COLLECTIONS.system).doc(RECONCILE_DOC).get();
  void consume("firestore.reads", 1);
  const cursor: unknown = snapshot.get("cursor");
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

/** The engine when it answers; an outage is reported by the outbox lag alert, nothing to compare tonight. */
async function healthyEngine(): Promise<SearchEngine | null> {
  try {
    const engine = searchEngine();
    if (await engine.healthy()) return engine;
    logger.warn("reconcile-search skipped: search engine not healthy");
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "reconcile-search skipped: search engine unavailable");
  }
  return null;
}

export interface ReconcileResult {
  skipped?: "not_configured" | "quota" | "engine";
  mode?: "full" | "window";
  published: number;
  scanned: number;
  /** Engine documents inside the window. */
  indexed: number;
  missing: number;
  stale: number;
  orphans: number;
  enqueued: number;
  /** Next window start (null: the next run starts from the first id). */
  cursor: string | null;
}

export interface ReconcileDeps {
  /** Where drifted ids go (default: forced index-listing jobs, inline without Valkey). */
  dispatch?: (ids: string[]) => Promise<void>;
}

export async function reconcileSearch(now: Date = new Date(), deps: ReconcileDeps = {}): Promise<ReconcileResult> {
  const result: ReconcileResult = { published: 0, scanned: 0, indexed: 0, missing: 0, stale: 0, orphans: 0, enqueued: 0, cursor: null };
  if (!isFirestoreConfigured()) {
    logger.warn("reconcile-search skipped: Firebase not configured");
    return { ...result, skipped: "not_configured" };
  }
  if (await isDegraded("firestore.reads")) {
    logger.warn("reconcile-search skipped: Firestore read quota degraded");
    return { ...result, skipped: "quota" };
  }
  const engine = await healthyEngine();
  if (!engine) return { ...result, skipped: "engine" };

  result.published = await countPublished();
  result.mode = result.published <= RECONCILE_FULL_MAX ? "full" : "window";
  const scan = result.mode === "full" ? await scanPublished(null, Number.POSITIVE_INFINITY) : await scanPublished(await readCursor(), RECONCILE_WINDOW);
  const window: IdWindow = result.mode === "full" ? { after: null, through: null } : scan.window;
  result.scanned = scan.rows.length;
  result.cursor = result.mode === "full" ? null : scan.next;

  const indexed = new Map<string, number>();
  for await (const page of engine.versions()) for (const { id, version } of page) if (inWindow(id, window)) indexed.set(id, version);
  result.indexed = indexed.size;

  const drift = computeDrift(scan.rows, indexed, window);
  result.missing = drift.missing.length;
  result.stale = drift.stale.length;
  result.orphans = drift.orphans.length;
  const ids = [...drift.missing, ...drift.stale, ...drift.orphans];
  const dispatch = deps.dispatch ?? ((chunk: string[]) => enqueueIndex(chunk, { force: true }));
  for (let start = 0; start < ids.length; start += DISPATCH_CHUNK) {
    const chunk = ids.slice(start, start + DISPATCH_CHUNK);
    await dispatch(chunk);
    result.enqueued += chunk.length;
  }

  await db()
    .collection(COLLECTIONS.system)
    .doc(RECONCILE_DOC)
    .set({
      cursor: result.cursor ?? "",
      mode: result.mode,
      published: result.published,
      scanned: result.scanned,
      indexed: result.indexed,
      missing: result.missing,
      stale: result.stale,
      orphans: result.orphans,
      enqueued: result.enqueued,
      lastRunAt: Timestamp.fromDate(now),
      updatedAt: Timestamp.fromDate(now),
    });
  void consume("firestore.writes", 1);
  logger.info({ ...result }, "reconcile-search");

  if (ids.length > 0) {
    await alert({
      severity: "P2",
      title: RECONCILE_ALERT_TITLE,
      body:
        `Réconciliation ${result.mode === "full" ? "complète" : "par fenêtre"} : ${result.scanned} annonces publiées lues, ${result.indexed} documents indexés comparés.\n` +
        `Manquantes : ${result.missing}, versions différentes : ${result.stale}, en trop : ${result.orphans}. ${result.enqueued} réindexations mises en file.`,
    });
  }
  return result;
}
