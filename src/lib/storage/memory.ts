import "server-only";
import { assertObjectKey } from "./keys";
import type { BucketRole, GetOptions, ObjectHead, ObjectStore, PresignedPut, PresignPutInput, PutOptions } from "./types";

// In-memory store for unit and API tests: records every call, so a test can assert, for example,
// that an oversized quarantine object was deleted before any GET (exit criterion of phase 3).

export type MemoryOp = "presignPut" | "head" | "get" | "put" | "delete";

export interface MemoryCall {
  op: MemoryOp;
  bucket: BucketRole;
  key: string;
}

interface StoredObject {
  body: Buffer;
  contentType: string;
  cacheControl?: string;
}

export class MemoryObjectStore implements ObjectStore {
  readonly name = "memory";
  readonly calls: MemoryCall[] = [];
  private readonly objects = new Map<string, StoredObject>();

  private static id(bucket: BucketRole, key: string): string {
    return `${bucket}/${key}`;
  }

  async presignPut({ bucket, key, contentType, contentLength, expiresInSeconds }: PresignPutInput): Promise<PresignedPut> {
    assertObjectKey(key);
    this.calls.push({ op: "presignPut", bucket, key });
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const url = new URL(`memory://${bucket}/${key}`);
    url.searchParams.set("len", String(contentLength));
    url.searchParams.set("exp", String(Math.floor(expiresAt.getTime() / 1000)));
    return { url: url.toString(), method: "PUT", headers: { "Content-Type": contentType }, expiresAt };
  }

  async head(bucket: BucketRole, key: string): Promise<ObjectHead | null> {
    assertObjectKey(key);
    this.calls.push({ op: "head", bucket, key });
    const object = this.objects.get(MemoryObjectStore.id(bucket, key));
    return object ? { size: object.body.byteLength, contentType: object.contentType } : null;
  }

  async get(bucket: BucketRole, key: string, options?: GetOptions): Promise<Buffer | null> {
    assertObjectKey(key);
    this.calls.push({ op: "get", bucket, key });
    const object = this.objects.get(MemoryObjectStore.id(bucket, key));
    if (!object) return null;
    const cap = options?.maxBytes;
    return Buffer.from(cap === undefined ? object.body : object.body.subarray(0, cap + 1));
  }

  async put(bucket: BucketRole, key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    assertObjectKey(key);
    this.calls.push({ op: "put", bucket, key });
    this.seed(bucket, key, body, options);
  }

  async delete(bucket: BucketRole, key: string): Promise<void> {
    assertObjectKey(key);
    this.calls.push({ op: "delete", bucket, key });
    this.objects.delete(MemoryObjectStore.id(bucket, key));
  }

  // --- Test helpers (not part of ObjectStore, never recorded) -------------------------------

  /** Stores an object as if a browser had PUT it through a presigned URL. */
  seed(bucket: BucketRole, key: string, body: Uint8Array, options: PutOptions): void {
    this.objects.set(MemoryObjectStore.id(bucket, key), {
      body: Buffer.from(body),
      contentType: options.contentType,
      ...(options.cacheControl ? { cacheControl: options.cacheControl } : {}),
    });
  }

  has(bucket: BucketRole, key: string): boolean {
    return this.objects.has(MemoryObjectStore.id(bucket, key));
  }

  /** Keys currently stored in a bucket, sorted. */
  keys(bucket: BucketRole): string[] {
    const prefix = `${bucket}/`;
    return [...this.objects.keys()]
      .filter((id) => id.startsWith(prefix))
      .map((id) => id.slice(prefix.length))
      .sort();
  }

  /** Operations recorded for one key, in order. */
  opsFor(bucket: BucketRole, key: string): MemoryOp[] {
    return this.calls.filter((call) => call.bucket === bucket && call.key === key).map((call) => call.op);
  }

  clear(): void {
    this.objects.clear();
    this.calls.length = 0;
  }
}
