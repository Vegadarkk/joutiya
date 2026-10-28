// Full rebuild of the search index (design D12): builds `listings_v2` from Firestore with the
// current settings, swaps it with the live `listings_v1`, deletes the old documents, then re-indexes
// every listing changed during the build. For a settings change the worker's ensureReady cannot
// apply in place, a lost Meilisearch volume, or a document format change.
//
// Meilisearch is only reachable on the VM's data network: run it in the worker container, from the
// worker bundle (scripts/build-node.ts), with the worker's environment (MEILI_URL, MEILI_INDEX_KEY,
// Firebase, QUEUE_REDIS_URL):
//
//   docker compose exec worker node dist/worker/reindex-search.mjs [--apply] [--max-reads 20000]
//
// Dry run by default: counts the published listings (1 read) and prints the plan. With --apply:
//   1. refuses when the Firestore read quota is degraded or the build would read more than
//      --max-reads documents (published count + catch-up allowance);
//   2. deletes a leftover listings_v2, creates it with SEARCH_SETTINGS (MeiliEngine.ensureReady);
//   3. streams the published listings (pages of 500) into listings_v2; past the budget it stops,
//      deletes listings_v2 and leaves the live index untouched;
//   4. swaps listings_v1 and listings_v2 (one atomic task), deletes listings_v2 (the old documents);
//   5. enqueues forced index-listing jobs for every listing updated since step 2 (catch-up of what
//      the live worker wrote into the old index meanwhile).
// Prints counts and index names only, never a key.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Timestamp } from "firebase-admin/firestore";
import { COLLECTIONS } from "@/lib/db/schemas";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import { serverEnv } from "@/lib/env";
import { db, isFirebaseConfigured } from "@/lib/firebase/admin";
import { consume, isDegraded } from "@/lib/quota";
import { toSearchDocument } from "@/lib/search/document";
import { PUBLISHED_PAGE_SIZE, publishedListingPages, type PublishedPage } from "@/lib/search/indexer";
import { closeSearchQueue, enqueueIndex } from "@/lib/search/queue";
import { MeiliEngine } from "@/lib/search/meili";
import { SEARCH_INDEX, SEARCH_REBUILD_INDEX, type SearchDocument } from "@/lib/search/types";
import { closeValkey } from "@/lib/valkey/clients";
import { requireEnvProxy } from "./env-proxy.ts";

export const DEFAULT_MAX_READS = 20_000;
/** Reads kept for the catch-up query (listings changed during the build). */
export const CATCH_UP_MAX = 2_000;
const USAGE = "usage: reindex-search [--apply] [--max-reads <n>]";

export interface ReindexArgs {
  apply: boolean;
  maxReads: number;
}

export function parseCli(argv: readonly string[]): ReindexArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: { apply: { type: "boolean", default: false }, "max-reads": { type: "string" } },
    strict: true,
  });
  const raw = values["max-reads"];
  const maxReads = raw === undefined ? DEFAULT_MAX_READS : Number(raw);
  if (!Number.isSafeInteger(maxReads) || maxReads < 1) throw new Error(`--max-reads must be a positive integer\n${USAGE}`);
  return { apply: values.apply === true, maxReads };
}

// ---- Rebuild ------------------------------------------------------------------------------------

/** What the rebuild uses of an index (MeiliEngine, src/lib/search/meili.ts). */
export type RebuildIndex = Pick<MeiliEngine, "exists" | "stats" | "ensureReady" | "upsert" | "deleteIndex" | "swapWith">;

export interface ReindexDeps {
  /** The live index (SEARCH_INDEX) and the rebuild index (SEARCH_REBUILD_INDEX) on the same server. */
  live: RebuildIndex;
  next: RebuildIndex;
  countPublished(): Promise<number>;
  pages(): AsyncIterable<PublishedPage>;
  /** Ids of listings updated at or after `since` (any status), `limit` at most. */
  changedSince(since: Date, limit: number): Promise<string[]>;
  enqueue(ids: string[]): Promise<void>;
  readsDegraded(): Promise<boolean>;
  now(): Date;
  log(line: string): void;
}

export interface ReindexReport {
  applied: boolean;
  published: number;
  indexed: number;
  skipped: number;
  reads: number;
  caughtUp: number;
}

export async function reindex(args: ReindexArgs, deps: ReindexDeps): Promise<ReindexReport> {
  const report: ReindexReport = { applied: false, published: 0, indexed: 0, skipped: 0, reads: 1, caughtUp: 0 };
  report.published = await deps.countPublished();
  const live = (await deps.live.exists()) ? (await deps.live.stats()).numberOfDocuments : null;
  deps.log(`${report.published} published listing(s) in Firestore; live index ${SEARCH_INDEX}: ${live === null ? "missing" : `${live} document(s)`}`);
  const planned = report.published + 1 + CATCH_UP_MAX;
  deps.log(`Plan: build ${SEARCH_REBUILD_INDEX}, swap it with ${SEARCH_INDEX}, delete the old documents, catch up; about ${planned} Firestore read(s) at most (budget ${args.maxReads}).`);
  if (!args.apply) {
    deps.log("Dry run: nothing written. Add --apply to rebuild.");
    return report;
  }
  if (planned > args.maxReads) throw new Error(`the rebuild may read ${planned} documents (published + 1 + ${CATCH_UP_MAX} catch-up), over --max-reads ${args.maxReads}: rerun with --max-reads ${planned} or more`);
  if (await deps.readsDegraded()) throw new Error("the Firestore read quota is degraded: try after its reset");

  const start = deps.now();
  if (await deps.next.exists()) {
    deps.log(`Deleting the leftover ${SEARCH_REBUILD_INDEX}.`);
    await deps.next.deleteIndex();
  }
  // Creates the index (primary key id) with SEARCH_SETTINGS.
  await deps.next.ensureReady();
  try {
    for await (const page of deps.pages()) {
      report.reads += Math.max(1, page.read);
      if (report.reads + CATCH_UP_MAX > args.maxReads) throw new Error(`read budget reached after ${report.reads} reads`);
      const documents = page.listings.map((listing: ListingRecord) => toSearchDocument(listing, start)).filter((document): document is SearchDocument => document !== null);
      report.skipped += page.listings.length - documents.length;
      if (documents.length > 0) await deps.next.upsert(documents);
      report.indexed += documents.length;
    }
  } catch (error) {
    deps.log(`Build stopped (${(error as Error).message}): deleting ${SEARCH_REBUILD_INDEX}, the live index is untouched.`);
    await deps.next.deleteIndex().catch(() => undefined);
    throw error;
  }
  deps.log(`${report.indexed} document(s) written to ${SEARCH_REBUILD_INDEX} (${report.skipped} published listing(s) not indexable).`);

  await deps.live.swapWith(SEARCH_REBUILD_INDEX);
  await deps.next.deleteIndex();
  report.applied = true;
  deps.log(`${SEARCH_INDEX} now serves the rebuilt documents; the old ones are deleted.`);

  const changed = await deps.changedSince(start, CATCH_UP_MAX);
  report.reads += Math.max(1, changed.length);
  if (changed.length > 0) await deps.enqueue(changed);
  report.caughtUp = changed.length;
  deps.log(`${changed.length} listing(s) changed during the build re-enqueued${changed.length >= CATCH_UP_MAX ? " (cap reached: the nightly reconciliation covers the rest)" : ""}.`);
  return report;
}

// ---- Firestore side -------------------------------------------------------------------------------

async function countPublished(): Promise<number> {
  const result = await db().collection(COLLECTIONS.listings).where("status", "==", "published").count().get();
  const count = result.data().count;
  void consume("firestore.reads", Math.max(1, Math.ceil(count / 1_000)));
  return count;
}

async function changedSince(since: Date, limit: number): Promise<string[]> {
  const snapshot = await db().collection(COLLECTIONS.listings).where("updatedAt", ">=", Timestamp.fromDate(since)).select().limit(limit).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs.map((doc) => doc.id);
}

async function main(): Promise<void> {
  requireEnvProxy();
  const args = parseCli(process.argv.slice(2));
  const env = serverEnv();
  if (!env.MEILI_URL || !env.MEILI_INDEX_KEY) throw new Error("MEILI_URL and MEILI_INDEX_KEY are required (run it in the worker container)");
  if (!isFirebaseConfigured()) throw new Error("Firebase is not configured");
  const live = new MeiliEngine({ url: env.MEILI_URL, indexKey: env.MEILI_INDEX_KEY, taskTimeoutMs: 10 * 60_000 });
  const report = await reindex(args, {
    live,
    next: live.withIndex(SEARCH_REBUILD_INDEX),
    countPublished,
    pages: () => publishedListingPages(PUBLISHED_PAGE_SIZE),
    changedSince,
    enqueue: (ids) => enqueueIndex(ids, { force: true }),
    readsDegraded: () => isDegraded("firestore.reads"),
    now: () => new Date(),
    log: (line) => console.log(line),
  });
  console.log(`Firestore reads: ${report.reads}.`);
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]reindex-search\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main()
    .then(async () => {
      await Promise.allSettled([closeSearchQueue(), closeValkey()]);
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      console.error(`reindex-search: ${(error as Error).message}`);
      await Promise.allSettled([closeSearchQueue(), closeValkey()]);
      process.exit(1);
    });
}
