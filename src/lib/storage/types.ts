import "server-only";

// Object storage adapter (CLAUDE.md "Adapters": ObjectStore). Buckets are addressed by role, never
// by name, so one code path serves dev (local files), staging and production (R2 buckets named in
// infra/targets.json). Implementations: s3.ts (R2), fs.ts (dev), memory.ts (tests).

/** The three buckets of an environment (architecture §5 uploads). */
export type BucketRole = "quarantine" | "media" | "private";

export interface PresignPutInput {
  bucket: BucketRole;
  key: string;
  /** Signed with the URL: the browser must send exactly this Content-Type. */
  contentType: string;
  /** Declared size (R2 does not enforce it; the worker's HEAD does). */
  contentLength: number;
  expiresInSeconds: number;
}

export interface PresignedPut {
  url: string;
  method: "PUT";
  /** Headers the browser must send with the PUT (Content-Type at least). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectHead {
  size: number;
  contentType: string;
}

export interface PutOptions {
  contentType: string;
  /** Cache-Control stored with the object (public media: long, immutable keys). */
  cacheControl?: string;
}

export interface GetOptions {
  /**
   * Reads at most `maxBytes + 1` bytes: a longer object comes back cut there (the caller sees it
   * exceeds the cap) and the rest is never downloaded. Guards the worker's memory when an object
   * is replaced between its HEAD and its GET (a presigned PUT stays usable for 5 minutes).
   */
  maxBytes?: number;
}

export interface ObjectStore {
  readonly name: string;
  presignPut(input: PresignPutInput): Promise<PresignedPut>;
  /** Size and type without reading the body; null when the object does not exist. */
  head(bucket: BucketRole, key: string): Promise<ObjectHead | null>;
  /** The whole body in memory (one image at a time, §2); null when the object does not exist. */
  get(bucket: BucketRole, key: string, options?: GetOptions): Promise<Buffer | null>;
  put(bucket: BucketRole, key: string, body: Uint8Array, options: PutOptions): Promise<void>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(bucket: BucketRole, key: string): Promise<void>;
}
