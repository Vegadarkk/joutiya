// Staging demo data set: realistic listings in every subcategory and region, from fictitious
// sellers, with matching photos (src/lib/demo/catalog.ts). Run in the worker container, which has
// Firestore, the media bucket and Meilisearch with its own access:
//
//   docker compose exec worker node dist/worker/seed-demo.mjs [--apply]            seed (again)
//   docker compose exec worker node dist/worker/seed-demo.mjs --remove [--apply]   remove
//
// Dry run by default: prints the counts. The photos are downloaded from images.pexels.com (Pexels
// License), go through the listing photo pipeline (sharp: metadata dropped, WebP variants, blurhash)
// and are stored like a member's under listings/{id}/. Writes: ~165 Firestore documents. Removal
// deletes by id (no read). Refused outside APP_ENV=staging; removed before launch (launch checklist).

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PHOTO_VARIANTS, type ListingPhoto } from "@/lib/contracts/media";
import { COLLECTIONS } from "@/lib/db/schemas";
import { demoListings, demoPhotoRefs, demoSellers, pexelsUrl, type DemoPhotoRef } from "@/lib/demo/data";
import { serverEnv } from "@/lib/env";
import { db, isFirebaseConfigured } from "@/lib/firebase/admin";
import { processImage } from "@/lib/media/process";
import { MEDIA_CACHE_CONTROL, MEDIA_CONTENT_TYPE, mediaObjectKey } from "@/lib/media/urls";
import { consume } from "@/lib/quota";
import { toSearchDocument } from "@/lib/search/document";
import { searchEngine } from "@/lib/search/engine";
import type { SearchDocument, SearchEngine } from "@/lib/search/types";
import { objectStore, type ObjectStore } from "@/lib/storage";
import { recordMediaBytes } from "@/lib/uploads/storage-gauge";
import { closeValkey } from "@/lib/valkey/clients";

const FIRESTORE_BATCH = 500;
/** A Pexels JPEG at 1600 px weighs well under this. */
const MAX_SOURCE_BYTES = 15_000_000;
const FETCH_TIMEOUT_MS = 30_000;

export interface SeedDemoArgs {
  remove: boolean;
  apply: boolean;
}

export function parseSeedDemoCli(argv: readonly string[]): SeedDemoArgs {
  const { values } = parseArgs({ args: [...argv], options: { remove: { type: "boolean", default: false }, apply: { type: "boolean", default: false } }, strict: true });
  return { remove: values.remove === true, apply: values.apply === true };
}

/** What the seed writes to: Firestore batches, the media bucket and the search engine. */
export interface SeedDemoTarget {
  write(operations: { path: string; data: Record<string, unknown> | null }[]): Promise<void>;
  store: Pick<ObjectStore, "head" | "put" | "delete">;
  engine: Pick<SearchEngine, "upsert" | "remove">;
  /** Source bytes of a photo. */
  download(url: string): Promise<Buffer>;
  /** R2 storage gauge (src/lib/uploads/storage-gauge.ts). */
  recordBytes(delta: number): Promise<void>;
  log(line: string): void;
}

async function inBatches<T>(items: readonly T[], size: number, run: (batch: T[]) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += size) await run(items.slice(start, start + size));
}

/** Bytes already stored for a photo's variants (a second run replaces them). */
async function storedBytes(store: SeedDemoTarget["store"], ref: DemoPhotoRef): Promise<number> {
  let total = 0;
  for (const variant of PHOTO_VARIANTS) total += (await store.head("media", mediaObjectKey(ref.listingId, ref.photoId, variant)))?.size ?? 0;
  return total;
}

/** Downloads, processes and stores one photo; null when it could not be fetched or decoded. */
async function storePhoto(target: SeedDemoTarget, ref: DemoPhotoRef): Promise<{ photo: ListingPhoto; delta: number } | null> {
  try {
    const processed = await processImage(await target.download(pexelsUrl(ref.pexelsId)));
    const before = await storedBytes(target.store, ref);
    let after = 0;
    for (const variant of PHOTO_VARIANTS) {
      const body = processed.variants[variant];
      await target.store.put("media", mediaObjectKey(ref.listingId, ref.photoId, variant), body, { contentType: MEDIA_CONTENT_TYPE, cacheControl: MEDIA_CACHE_CONTROL });
      after += body.byteLength;
    }
    return { photo: { id: ref.photoId, w: processed.width, h: processed.height, blurhash: processed.blurhash, hash: processed.hash, variants: [...PHOTO_VARIANTS] }, delta: after - before };
  } catch (error) {
    target.log(`photo ${ref.pexelsId} of ${ref.listingId} skipped: ${(error as Error).message}`);
    return null;
  }
}

/** Seeds the data set: photos first (the listings carry their dimensions), then Firestore, then the index. */
export async function seedDemo(target: SeedDemoTarget, now: Date): Promise<{ documents: number; photos: number; indexed: number }> {
  const photos = new Map<string, ListingPhoto[]>();
  let stored = 0;
  let delta = 0;
  for (const ref of demoPhotoRefs()) {
    const result = await storePhoto(target, ref);
    if (!result) continue;
    photos.set(ref.listingId, [...(photos.get(ref.listingId) ?? []), result.photo]);
    stored += 1;
    delta += result.delta;
  }
  if (delta !== 0) await target.recordBytes(delta);
  target.log(`Photos: ${stored} stored`);

  const listings = demoListings(now, (listingId) => photos.get(listingId) ?? []);
  const operations = [
    ...demoSellers(now).map(({ uid, doc }) => ({ path: `${COLLECTIONS.users}/${uid}`, data: doc as unknown as Record<string, unknown> })),
    ...listings.map(({ id, ...doc }) => ({ path: `${COLLECTIONS.listings}/${id}`, data: doc as unknown as Record<string, unknown> })),
  ];
  await inBatches(operations, FIRESTORE_BATCH, (batch) => target.write(batch));
  target.log(`Firestore: ${operations.length} documents written`);

  const documents = listings.map((listing) => toSearchDocument(listing, now)).filter((document): document is SearchDocument => document !== null);
  await target.engine.upsert(documents);
  target.log(`Index: ${documents.length} documents`);
  return { documents: operations.length, photos: stored, indexed: documents.length };
}

/** Removes the data set by id: the index first, then the photos and Firestore. */
export async function removeDemo(target: SeedDemoTarget, now: Date = new Date()): Promise<{ documents: number; photos: number }> {
  const listings = demoListings(now);
  await target.engine.remove(listings.map((listing) => listing.id));
  target.log(`Index: ${listings.length} ids removed`);

  let freed = 0;
  const refs = demoPhotoRefs();
  for (const ref of refs) {
    freed += await storedBytes(target.store, ref);
    for (const variant of PHOTO_VARIANTS) await target.store.delete("media", mediaObjectKey(ref.listingId, ref.photoId, variant));
  }
  if (freed > 0) await target.recordBytes(-freed);
  target.log(`Photos: ${refs.length} deleted`);

  const operations = [
    ...listings.map((listing) => ({ path: `${COLLECTIONS.listings}/${listing.id}`, data: null })),
    ...demoSellers(now).map(({ uid }) => ({ path: `${COLLECTIONS.users}/${uid}`, data: null })),
  ];
  await inBatches(operations, FIRESTORE_BATCH, (batch) => target.write(batch));
  target.log(`Firestore: ${operations.length} documents deleted`);
  return { documents: operations.length, photos: refs.length };
}

/** Pexels only, size-capped, with a timeout. */
export async function downloadPhoto(url: string, fetcher: typeof fetch = fetch): Promise<Buffer> {
  if (new URL(url).host !== "images.pexels.com") throw new Error(`host not allowed: ${url}`);
  const response = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "JoutiyaSeed/1.0 (staging test data)" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > MAX_SOURCE_BYTES) throw new Error(`too large (${body.byteLength} bytes)`);
  return body;
}

async function main(): Promise<void> {
  const args = parseSeedDemoCli(process.argv.slice(2));
  const env = serverEnv();
  if (env.APP_ENV !== "staging") throw new Error(`the demo data set goes to staging only (APP_ENV=${env.APP_ENV})`);
  if (!env.MEILI_URL || !env.MEILI_INDEX_KEY) throw new Error("MEILI_URL and MEILI_INDEX_KEY are required (run it in the worker container)");
  if (!isFirebaseConfigured()) throw new Error("Firebase is not configured");
  const now = new Date();
  const listings = demoListings(now).length;
  const photos = demoPhotoRefs().length;
  if (!args.apply) {
    console.log(args.remove ? `Would remove ${listings} listings, their ${photos} photos and the demo sellers.` : `Would store ${photos} photos and write ${listings} listings plus the demo sellers, then index them.`);
    console.log("Dry run: nothing written. Add --apply.");
    return;
  }
  const target: SeedDemoTarget = {
    async write(operations) {
      const batch = db().batch();
      for (const { path, data } of operations) {
        if (data === null) batch.delete(db().doc(path));
        else batch.set(db().doc(path), data);
      }
      await batch.commit();
      await consume(operations.some(({ data }) => data === null) ? "firestore.deletes" : "firestore.writes", operations.length);
    },
    store: objectStore(),
    engine: searchEngine(),
    download: (url) => downloadPhoto(url),
    recordBytes: async (delta) => {
      await recordMediaBytes(delta, now);
    },
    log: (line) => console.log(line),
  };
  if (args.remove) await removeDemo(target, now);
  else await seedDemo(target, now);
}

const self = fileURLToPath(import.meta.url);
if (/[\\/]seed-demo\.(?:ts|mjs)$/.test(self) && process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
  main()
    .then(async () => {
      await closeValkey().catch(() => undefined);
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      console.error(`seed-demo: ${(error as Error).message}`);
      await closeValkey().catch(() => undefined);
      process.exit(1);
    });
}
