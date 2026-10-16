import { gunzipSync } from "node:zlib";
import type { Firestore } from "firebase-admin/firestore";
import { decryptAge } from "./crypto.ts";
import { decodeDocument, type DecodedDocument } from "./encode.ts";

// Restore of backup parts (D17): age -> gunzip -> NDJSON -> decode -> BulkWriter set() (no merge).
// Objects are applied in the order given (oldest first: the newest copy of a document wins), each
// object flushed before the next. Pure module (no server-only, no "@/"): used by
// scripts/restore-firestore.ts under plain Node and by the API test against the emulator.

export interface RestoreInput {
  db: Firestore;
  /** Encrypted parts (*.ndjson.gz.age), oldest first. */
  objects: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  /** AGE-SECRET-KEY-1... (never logged). */
  identity: string;
  /** Decode and count everything, write nothing. */
  dryRun?: boolean;
  /** Keep only documents whose root collection or own collection is listed. */
  collections?: readonly string[];
  /** Documents queued between two flushes of the BulkWriter (which commits 500 at most at a time). */
  batchSize?: number;
}

export interface RestoreResult {
  dryRun: boolean;
  objects: number;
  /** NDJSON lines read (after decoding, so a malformed line throws before any write of its object). */
  documents: number;
  written: number;
  /** Documents left out by the collections filter. */
  skipped: number;
  failed: number;
  /** Documents kept, per collection ("users", "users/private"). */
  byCollection: Record<string, number>;
}

/** One part: age -> gzip -> NDJSON bytes. Rejects when the identity does not match. */
export async function openBackupObject(bytes: Uint8Array, identity: string): Promise<Buffer> {
  return gunzipSync(await decryptAge(bytes, identity));
}

/** Non-empty lines of an NDJSON buffer. */
export function* ndjsonLines(plain: Uint8Array): Generator<string> {
  const text = Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength).toString("utf8");
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    if (line.trim().length > 0) yield line;
    start = end + 1;
  }
}

function kept(doc: DecodedDocument, filter: ReadonlySet<string> | null): boolean {
  return filter === null || filter.has(doc.rootCollection) || filter.has(doc.collection);
}

export async function restoreFromObjects(input: RestoreInput): Promise<RestoreResult> {
  const dryRun = input.dryRun ?? false;
  const batchSize = Math.max(1, input.batchSize ?? 500);
  const filter = input.collections && input.collections.length > 0 ? new Set(input.collections) : null;
  const result: RestoreResult = { dryRun, objects: 0, documents: 0, written: 0, skipped: 0, failed: 0, byCollection: {} };
  const writer = dryRun ? null : input.db.bulkWriter();
  writer?.onWriteError((error) => error.failedAttempts < 3);
  const pending: Promise<void>[] = [];
  let queued = 0;

  const settle = async (): Promise<void> => {
    if (!writer) return;
    await writer.flush();
    await Promise.all(pending);
    pending.length = 0;
    queued = 0;
  };

  for await (const object of input.objects) {
    result.objects += 1;
    const plain = await openBackupObject(object, input.identity);
    // Decode the whole object first: a corrupt part is refused before any of its documents is written.
    const docs: DecodedDocument[] = [];
    for (const line of ndjsonLines(plain)) {
      result.documents += 1;
      docs.push(decodeDocument(line, input.db));
    }
    for (const doc of docs) {
      if (!kept(doc, filter)) {
        result.skipped += 1;
        continue;
      }
      const label = doc.rootCollection === doc.collection ? doc.collection : `${doc.rootCollection}/${doc.collection}`;
      result.byCollection[label] = (result.byCollection[label] ?? 0) + 1;
      if (!writer) continue;
      pending.push(
        writer.set(doc.ref, doc.data).then(
          () => {
            result.written += 1;
          },
          () => {
            result.failed += 1;
          },
        ),
      );
      queued += 1;
      if (queued >= batchSize) await settle();
    }
    // Objects apply in order: the next one may hold a newer copy of the same document.
    await settle();
  }
  if (writer) {
    await writer.close();
    await Promise.all(pending);
  }
  return result;
}
