import "server-only";
import { FieldPath } from "firebase-admin/firestore";
import { alert } from "@/lib/alert";
import { fromSnapshot, getListing, type ListingRecord } from "@/lib/db/repositories/listings";
import { ackSearchOutbox, getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { timestampsToDates } from "@/lib/db/repositories/timestamps";
import { COLLECTIONS, searchOutboxSchema } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";
import { toSearchDocument } from "./document";
import { searchEngine } from "./engine";
import type { SearchDocument } from "./types";

// The one consumer of searchOutbox (design D9, D10; architecture §5). Every lane (fast lane,
// onSnapshot watch, 60 s poll, reconciliation, boost expiry) ends in `indexListing`, run by the
// worker's `search` queue at concurrency 1, so the engine has a single writer. The document always
// comes from the listing as it is now (tombstone, missing or not indexable = removed); the entry is
// acknowledged only if its version did not move meanwhile (`ackSearchOutbox`), else one more pass.

/** Passes per job: a false ack (newer entry) re-reads once more; past this the poll takes it. */
export const INDEX_MAX_PASSES = 3;
/** Outbox entries read per poll (oldest first). */
export const OUTBOX_POLL_LIMIT = 200;
/** D10: oldest entry older than this -> P1 alert. */
export const LAG_ALERT_SECONDS = 5 * 60;
/** Lag of the last poll, seconds (health information); expires when the poll stops. */
export const SEARCH_LAG_KEY = "search:outbox:lagSeconds";
export const SEARCH_LAG_TTL_SECONDS = 10 * 60;
export const LAG_ALERT_TITLE = "Indexation de la recherche en retard";
/** Listings read per Firestore page when streaming published listings. */
export const PUBLISHED_PAGE_SIZE = 500;

export interface IndexOutcome {
  id: string;
  /** Last write sent to the engine (none: no entry and not forced). */
  action: "upsert" | "remove" | "none";
  /** Listing version written (null when removed or nothing happened). */
  version: number | null;
  /** The entry this job read was acknowledged (or there was none to acknowledge). */
  acked: boolean;
  /** A newer entry is still waiting after INDEX_MAX_PASSES (the poll takes it). */
  pending: boolean;
  passes: number;
}

export interface IndexOptions {
  /** Index from the listing even without an outbox entry (reconciliation, rebuild catch-up). */
  force?: boolean;
  now?: Date;
}

/** Upserts the document or removes the id; resolves once the engine applied it. */
async function write(id: string, listing: ListingRecord | null, now: Date): Promise<{ action: "upsert" | "remove"; version: number | null }> {
  const document = listing ? toSearchDocument(listing, now) : null;
  const engine = searchEngine();
  if (document) {
    await engine.upsert([document]);
    return { action: "upsert", version: document.version };
  }
  await engine.remove([id]);
  return { action: "remove", version: null };
}

/**
 * Indexes one listing from its outbox entry (D9). Absent entry = already done, unless `force`.
 * Throws when Firestore or the engine fails (the job retries; the entry stays for the poll).
 */
export async function indexListing(id: string, options: IndexOptions = {}): Promise<IndexOutcome> {
  const outcome: IndexOutcome = { id, action: "none", version: null, acked: false, pending: false, passes: 0 };
  for (let pass = 0; pass < INDEX_MAX_PASSES; pass += 1) {
    const entry = await getSearchOutbox(id);
    if (!entry && !(options.force && pass === 0)) {
      outcome.acked = true;
      return outcome;
    }
    outcome.passes = pass + 1;
    const listing = await getListing(id);
    Object.assign(outcome, await write(id, listing, options.now ?? new Date()));
    if (!entry || (await ackSearchOutbox(id, entry.version))) {
      outcome.acked = true;
      return outcome;
    }
    logger.debug({ listingId: id, version: entry.version }, "search outbox moved while indexing: one more pass");
  }
  outcome.pending = true;
  logger.info({ listingId: id }, "search outbox still moving: left to the poll");
  return outcome;
}

// ---- Poll and lag (D10) ------------------------------------------------------------------------

export interface OutboxPage {
  ids: string[];
  /** enqueuedAt of the oldest entry (null: empty outbox). */
  oldest: Date | null;
}

/** Oldest `limit` entries (single-field index on enqueuedAt). */
export async function readOutboxPage(limit = OUTBOX_POLL_LIMIT): Promise<OutboxPage> {
  const snapshot = await db().collection(COLLECTIONS.searchOutbox).orderBy("enqueuedAt", "asc").limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  let oldest: Date | null = null;
  for (const doc of snapshot.docs) {
    const parsed = searchOutboxSchema.safeParse(timestampsToDates(doc.data()));
    if (parsed.success && (!oldest || parsed.data.enqueuedAt < oldest)) oldest = parsed.data.enqueuedAt;
  }
  return { ids: snapshot.docs.map((doc) => doc.id), oldest };
}

export function outboxLagSeconds(oldest: Date | null, now: Date): number {
  return oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)) : 0;
}

/** Stores the lag for the health report and raises the P1 alert past 5 min (deduped 1 h by title). Never throws. */
export async function reportOutboxLag(lagSeconds: number, pending: number): Promise<boolean> {
  if (isValkeyConfigured("queue")) {
    try {
      await valkey("queue").set(SEARCH_LAG_KEY, String(lagSeconds), "EX", SEARCH_LAG_TTL_SECONDS);
    } catch (error) {
      logger.warn({ err: (error as Error).message }, "search lag not stored");
    }
  }
  if (lagSeconds <= LAG_ALERT_SECONDS) return false;
  await alert({
    severity: "P1",
    title: LAG_ALERT_TITLE,
    body: `La plus ancienne entrée de searchOutbox attend depuis ${Math.floor(lagSeconds / 60)} min (${pending} entrée(s) lue(s) par le relevé). Vérifier le worker (file "search") et Meilisearch.`,
  });
  return true;
}

/** Lag stored by the last poll (seconds); null when unknown (no Valkey, no poll for 10 min). Never throws. */
export async function readOutboxLag(): Promise<number | null> {
  if (!isValkeyConfigured("queue")) return null;
  try {
    const value = await valkey("queue").get(SEARCH_LAG_KEY);
    const seconds = value === null ? Number.NaN : Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "search lag not read");
    return null;
  }
}

export interface OutboxPollResult {
  pending: number;
  lagSeconds: number;
  alerted: boolean;
}

/** Inline dispatch (tests, dev): one listing after the other, a failure logged and left to the next poll. */
async function indexEach(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      await indexListing(id);
    } catch (error) {
      logger.warn({ listingId: id, err: (error as Error).message }, "search indexing failed");
    }
  }
}

/**
 * The 60 s poll (D9 lane 3, D10): reads the oldest entries, records the lag (alert past 5 min),
 * then hands the ids to `dispatch` (the worker enqueues `index-listing` jobs; inline by default).
 */
export async function processOutbox(options: { now?: Date; limit?: number; dispatch?: (ids: string[]) => Promise<void> } = {}): Promise<OutboxPollResult> {
  const page = await readOutboxPage(options.limit ?? OUTBOX_POLL_LIMIT);
  const lagSeconds = outboxLagSeconds(page.oldest, options.now ?? new Date());
  const alerted = await reportOutboxLag(lagSeconds, page.ids.length);
  if (page.ids.length > 0) await (options.dispatch ?? indexEach)(page.ids);
  return { pending: page.ids.length, lagSeconds, alerted };
}

// ---- Published listings stream (dev rebuild, reindex script) ---------------------------------

export interface PublishedPage {
  listings: ListingRecord[];
  /** Documents read (parsed or not). */
  read: number;
}

/** Published listings by document id, `pageSize` per read, after `startAfter`. */
export async function* publishedListingPages(pageSize = PUBLISHED_PAGE_SIZE, startAfter?: string): AsyncGenerator<PublishedPage> {
  let cursor = startAfter;
  for (;;) {
    let query = db().collection(COLLECTIONS.listings).where("status", "==", "published").orderBy(FieldPath.documentId(), "asc");
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.limit(pageSize).get();
    void consume("firestore.reads", Math.max(1, snapshot.size));
    yield { listings: snapshot.docs.map(fromSnapshot).filter((record): record is ListingRecord => record !== null), read: snapshot.size };
    const last = snapshot.docs[snapshot.docs.length - 1];
    if (!last || snapshot.size < pageSize) return;
    cursor = last.id;
  }
}

export interface RebuildResult {
  indexed: number;
  /** Engine documents that are not indexable any more. */
  removed: number;
  /** Published listings that are not indexable (hidden, under review...). */
  skipped: number;
}

/**
 * Development rebuild (POST /api/dev/search/rebuild, e2e): every indexable published listing goes
 * to the live index, every other engine document is removed. Outbox entries are left alone.
 */
export async function rebuildFromFirestore(now: Date = new Date()): Promise<RebuildResult> {
  const engine = searchEngine();
  await engine.ensureReady();
  const kept = new Set<string>();
  let skipped = 0;
  for await (const page of publishedListingPages()) {
    const documents: SearchDocument[] = [];
    for (const listing of page.listings) {
      const document = toSearchDocument(listing, now);
      if (document) documents.push(document);
      else skipped += 1;
    }
    if (documents.length > 0) await engine.upsert(documents);
    for (const document of documents) kept.add(document.id);
  }
  const stale: string[] = [];
  for await (const versions of engine.versions()) for (const { id } of versions) if (!kept.has(id)) stale.push(id);
  if (stale.length > 0) await engine.remove(stale);
  logger.info({ indexed: kept.size, removed: stale.length, skipped }, "search index rebuilt from Firestore");
  return { indexed: kept.size, removed: stale.length, skipped };
}
