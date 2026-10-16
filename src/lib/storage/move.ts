import "server-only";
import type { BucketRole, ObjectStore, PutOptions } from "./types";

// Moves one object between buckets with the plain ObjectStore operations (no server-side copy in
// the adapter): GET the source, PUT the target, HEAD the target (same size), and only then DELETE
// the source. A crash at any point leaves at least one complete copy, and a rerun finishes the
// move: a missing source next to a present target is a move that already went through (the target
// was checked before the source went).

export interface ObjectLocation {
  bucket: BucketRole;
  key: string;
}

/** `moved`: copied and source deleted; `already`: only the target exists; `missing`: neither exists. */
export type MoveOutcome = "moved" | "already" | "missing";

export class ObjectMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectMoveError";
  }
}

export interface MoveOptions extends PutOptions {
  /** Larger sources are refused (memory guard: the body is held once in memory). */
  maxBytes: number;
}

export async function moveObject(store: ObjectStore, from: ObjectLocation, to: ObjectLocation, options: MoveOptions): Promise<MoveOutcome> {
  const { maxBytes, ...put } = options;
  const body = await store.get(from.bucket, from.key, { maxBytes });
  if (!body) return (await store.head(to.bucket, to.key)) ? "already" : "missing";
  if (body.byteLength > maxBytes) throw new ObjectMoveError(`source larger than ${maxBytes} bytes`);
  await store.put(to.bucket, to.key, body, put);
  const copy = await store.head(to.bucket, to.key);
  if (!copy || copy.size !== body.byteLength) throw new ObjectMoveError(`copy check failed (${copy ? `${copy.size} of ${body.byteLength} bytes` : "missing"})`);
  await store.delete(from.bucket, from.key);
  return "moved";
}
