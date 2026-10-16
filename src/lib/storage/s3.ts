import "server-only";
import { AwsClient } from "aws4fetch";
import { assertObjectKey, bucketName } from "./keys";
import type { BucketRole, GetOptions, ObjectHead, ObjectStore, PresignedPut, PresignPutInput, PutOptions } from "./types";

// Cloudflare R2 through its S3 API (research/libs-map-backup.md §C3): aws4fetch SigV4, region
// "auto", path-style URLs on the EU endpoint (`https://<account>.eu.r2.cloudflarestorage.com/
// <bucket>/<key>`, one origin for CSP and CORS). presignPut signs the query (X-Amz-Expires = the
// requested validity, 300 s by default) with Content-Type and Content-Length as signed headers;
// the worker's HEAD remains the size authority. Server calls sign headers and carry
// `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD` (accepted by R2 over HTTPS). Class A/B accounting is
// MeteredObjectStore's job; this adapter only talks to R2.

export interface S3ObjectStoreConfig {
  /** https://<account>.eu.r2.cloudflarestorage.com */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Bucket names by role; defaults to R2_BUCKET_* (keys.ts). */
  buckets?: Record<BucketRole, string>;
  /** Clock of signatures and expiries (tests pin it). */
  now?: () => Date;
  /** fetch implementation (tests inject a mock). */
  fetch?: typeof fetch;
  /** Extra attempts on HTTP 5xx and 429; default 3. */
  retries?: number;
}

export type S3Operation = "head" | "get" | "put" | "delete";

/** A non-2xx answer that is not "missing object": status for the caller, nothing from the body. */
export class StorageError extends Error {
  readonly operation: S3Operation;
  readonly status: number;
  readonly bucket: string;

  constructor(operation: S3Operation, status: number, bucket: string) {
    super(`S3 ${operation} on ${bucket} failed with HTTP ${status}`);
    this.name = "StorageError";
    this.operation = operation;
    this.status = status;
    this.bucket = bucket;
  }
}

/** Presigned URLs live between 1 s and 7 days on R2. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 3600;
const DEFAULT_RETRIES = 3;
const RETRY_BASE_MS = 50;

/** SigV4 timestamp, e.g. 20261016T120000Z. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to free.
  }
}

/** The body up to `maxBytes + 1` bytes; the rest of the stream is cancelled, never downloaded. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let ended = false;
  try {
    while (length <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    // Over the cap or failed: stop the download.
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, length);
  return length > maxBytes ? body.subarray(0, maxBytes + 1) : body;
}

export class S3ObjectStore implements ObjectStore {
  readonly name = "s3";
  private readonly endpoint: string;
  private readonly client: AwsClient;

  constructor(readonly config: S3ObjectStoreConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    // Retries are ours (the injected fetch must see every attempt).
    this.client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: "auto", retries: 0 });
  }

  bucket(role: BucketRole): string {
    return this.config.buckets?.[role] ?? bucketName(role);
  }

  /** Path-style object URL; the key is validated and each segment percent-encoded. */
  objectUrl(role: BucketRole, key: string): URL {
    assertObjectKey(key);
    return new URL(`${this.endpoint}/${this.bucket(role)}/${key.split("/").map(encodeURIComponent).join("/")}`);
  }

  private now(): Date {
    return this.config.now?.() ?? new Date();
  }

  async presignPut({ bucket, key, contentType, contentLength, expiresInSeconds }: PresignPutInput): Promise<PresignedPut> {
    const url = this.objectUrl(bucket, key);
    const expires = Math.min(Math.max(1, Math.floor(expiresInSeconds)), MAX_PRESIGN_SECONDS);
    url.searchParams.set("X-Amz-Expires", String(expires));
    const now = this.now();
    const signed = await this.client.sign(url, {
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": String(contentLength) },
      aws: { signQuery: true, allHeaders: true, datetime: amzDate(now) },
    });
    return {
      url: signed.url,
      method: "PUT",
      // The browser sets Content-Length itself from the Blob; only Content-Type is for the caller.
      headers: { "Content-Type": contentType },
      expiresAt: new Date(Math.floor(now.getTime() / 1000) * 1000 + expires * 1000),
    };
  }

  private async send(bucket: BucketRole, key: string, init: { method: string; headers?: Record<string, string>; body?: Uint8Array }): Promise<Response> {
    const url = this.objectUrl(bucket, key);
    const fetchImpl = this.config.fetch ?? fetch;
    const retries = this.config.retries ?? DEFAULT_RETRIES;
    // Buffers and Uint8Arrays are ArrayBuffer-backed here; the lib typing of BodyInit is stricter.
    const body = init.body as Uint8Array<ArrayBuffer> | undefined;
    for (let attempt = 0; ; attempt++) {
      const request = await this.client.sign(url, { method: init.method, headers: init.headers, body, aws: { datetime: amzDate(this.now()) } });
      const response = await fetchImpl(request);
      if ((response.status < 500 && response.status !== 429) || attempt >= retries) return response;
      await discardBody(response);
      await sleep(RETRY_BASE_MS * 2 ** attempt * (0.5 + Math.random()));
    }
  }

  async head(bucket: BucketRole, key: string): Promise<ObjectHead | null> {
    const response = await this.send(bucket, key, { method: "HEAD" });
    await discardBody(response);
    if (response.status === 404) return null;
    if (!response.ok) throw new StorageError("head", response.status, this.bucket(bucket));
    const size = Number(response.headers.get("content-length"));
    return { size: Number.isFinite(size) ? size : 0, contentType: response.headers.get("content-type") ?? "application/octet-stream" };
  }

  async get(bucket: BucketRole, key: string, options?: GetOptions): Promise<Buffer | null> {
    const response = await this.send(bucket, key, { method: "GET" });
    if (response.status === 404) {
      await discardBody(response);
      return null;
    }
    if (!response.ok) {
      await discardBody(response);
      throw new StorageError("get", response.status, this.bucket(bucket));
    }
    if (options?.maxBytes !== undefined) return readCapped(response, options.maxBytes);
    return Buffer.from(await response.arrayBuffer());
  }

  async put(bucket: BucketRole, key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": options.contentType };
    if (options.cacheControl) headers["Cache-Control"] = options.cacheControl;
    const response = await this.send(bucket, key, { method: "PUT", body, headers });
    await discardBody(response);
    if (!response.ok) throw new StorageError("put", response.status, this.bucket(bucket));
  }

  async delete(bucket: BucketRole, key: string): Promise<void> {
    const response = await this.send(bucket, key, { method: "DELETE" });
    await discardBody(response);
    // 204 for deleted and for missing (idempotent, free Class of operation).
    if (!response.ok && response.status !== 404) throw new StorageError("delete", response.status, this.bucket(bucket));
  }
}
