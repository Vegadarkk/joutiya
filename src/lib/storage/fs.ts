import "server-only";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serverEnv } from "@/lib/env";
import { pepperedHash, safeEqual } from "@/lib/security/hash";
import { assertObjectKey, bucketName } from "./keys";
import type { BucketRole, GetOptions, ObjectHead, ObjectStore, PresignedPut, PresignPutInput, PutOptions } from "./types";

// Development stand-in for R2 (D11): objects live under os.tmpdir()/joutiya-dev-storage/<bucket>,
// shared by the web and worker processes of one machine. "Presigned" URLs point to the dev-only
// route /api/dev/storage/<bucket>/<key> and carry an HMAC (HASH_PEPPER) with an expiry, so the
// browser flow (sign -> PUT -> complete) runs exactly as against R2.

export const DEV_STORAGE_ROUTE = "/api/dev/storage";
export const DEFAULT_FS_ROOT = path.join(os.tmpdir(), "joutiya-dev-storage");

interface StoredMeta {
  contentType: string;
  size: number;
  cacheControl?: string;
  storedAt: string;
}

/** What a signed dev URL commits to; the signature covers every field. */
export interface DevSignatureInput {
  method: "PUT" | "GET";
  /** Bucket name (not role): the URL names the bucket. */
  bucket: string;
  key: string;
  /** PUT only: the Content-Type the request must carry. */
  contentType?: string;
  /** PUT only: the declared size (informative, like R2). */
  contentLength?: number;
  /** Unix seconds. */
  expires: number;
}

export function devStorageSignature(input: DevSignatureInput): string {
  const payload = [input.method, input.bucket, input.key, input.contentType ?? "", String(input.contentLength ?? ""), String(input.expires)].join("\n");
  return pepperedHash("dev-storage", payload);
}

export type DevSignatureCheck = "ok" | "invalid" | "expired";

export function verifyDevSignature(input: DevSignatureInput, signature: string, now = Date.now()): DevSignatureCheck {
  if (!signature || !safeEqual(devStorageSignature(input), signature)) return "invalid";
  if (!Number.isFinite(input.expires) || input.expires * 1000 < now) return "expired";
  return "ok";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export class FsObjectStore implements ObjectStore {
  readonly name = "fs";
  readonly root: string;
  private readonly siteUrl: string | undefined;

  /** `siteUrl` overrides SITE_URL as the origin of presigned URLs (tests). */
  constructor(root: string = DEFAULT_FS_ROOT, siteUrl?: string) {
    this.root = root;
    this.siteUrl = siteUrl;
  }

  /** Bodies and metadata live in separate trees, so a key can never collide with a sidecar. */
  private objectPath(bucket: BucketRole, key: string): string {
    return path.join(this.root, bucketName(bucket), "objects", ...key.split("/"));
  }

  private metaPath(bucket: BucketRole, key: string): string {
    return `${path.join(this.root, bucketName(bucket), "meta", ...key.split("/"))}.json`;
  }

  async presignPut({ bucket, key, contentType, contentLength, expiresInSeconds }: PresignPutInput): Promise<PresignedPut> {
    assertObjectKey(key);
    const name = bucketName(bucket);
    const expires = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expiresInSeconds));
    const signature = devStorageSignature({ method: "PUT", bucket: name, key, contentType, contentLength, expires });
    const url = new URL(`${DEV_STORAGE_ROUTE}/${name}/${key}`, this.siteUrl ?? serverEnv().SITE_URL);
    url.searchParams.set("exp", String(expires));
    url.searchParams.set("len", String(contentLength));
    url.searchParams.set("sig", signature);
    return { url: url.toString(), method: "PUT", headers: { "Content-Type": contentType }, expiresAt: new Date(expires * 1000) };
  }

  async head(bucket: BucketRole, key: string): Promise<ObjectHead | null> {
    assertObjectKey(key);
    try {
      const meta = JSON.parse(await readFile(this.metaPath(bucket, key), "utf8")) as StoredMeta;
      return { size: meta.size, contentType: meta.contentType };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async get(bucket: BucketRole, key: string, options?: GetOptions): Promise<Buffer | null> {
    assertObjectKey(key);
    try {
      if (options?.maxBytes === undefined) return await readFile(this.objectPath(bucket, key));
      const file = await open(this.objectPath(bucket, key), "r");
      try {
        const buffer = Buffer.alloc(options.maxBytes + 1);
        let length = 0;
        while (length < buffer.byteLength) {
          const { bytesRead } = await file.read(buffer, length, buffer.byteLength - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        return buffer.subarray(0, length);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async put(bucket: BucketRole, key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    assertObjectKey(key);
    const objectPath = this.objectPath(bucket, key);
    const metaPath = this.metaPath(bucket, key);
    await Promise.all([mkdir(path.dirname(objectPath), { recursive: true }), mkdir(path.dirname(metaPath), { recursive: true })]);
    const meta: StoredMeta = {
      contentType: options.contentType,
      size: body.byteLength,
      ...(options.cacheControl ? { cacheControl: options.cacheControl } : {}),
      storedAt: new Date().toISOString(),
    };
    await writeFile(objectPath, body);
    await writeFile(metaPath, JSON.stringify(meta));
  }

  async delete(bucket: BucketRole, key: string): Promise<void> {
    assertObjectKey(key);
    await Promise.all([rm(this.objectPath(bucket, key), { force: true }), rm(this.metaPath(bucket, key), { force: true })]);
  }

  /** The stored Cache-Control of an object, if any (served back by the dev route). */
  async cacheControl(bucket: BucketRole, key: string): Promise<string | undefined> {
    assertObjectKey(key);
    try {
      const meta = JSON.parse(await readFile(this.metaPath(bucket, key), "utf8")) as StoredMeta;
      return meta.cacheControl;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
}

let shared: FsObjectStore | undefined;

/** The process-wide development store (the dev route and the factory share it). */
export function fsObjectStore(): FsObjectStore {
  shared ??= new FsObjectStore();
  return shared;
}
