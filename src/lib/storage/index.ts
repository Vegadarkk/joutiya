import "server-only";
import { isR2Configured, serverEnv, type ServerEnv } from "@/lib/env";
import { fsObjectStore } from "./fs";
import { MeteredObjectStore } from "./metered";
import { S3ObjectStore } from "./s3";
import type { ObjectStore } from "./types";

// Factory (D11): R2 when the R2_* variables are set, the local file store in development,
// nothing elsewhere (a deployed environment without R2 cannot accept uploads: callers answer 503).

export type { BucketRole, GetOptions, ObjectHead, ObjectStore, PresignedPut, PresignPutInput, PutOptions } from "./types";
export { assertObjectKey, bucketName, bucketRole, isValidObjectKey, mediaBaseUrl } from "./keys";
export { MemoryObjectStore } from "./memory";
export type { MemoryCall, MemoryOp } from "./memory";
export { MeteredObjectStore } from "./metered";
export { ObjectMoveError, moveObject } from "./move";
export type { MoveOptions, MoveOutcome, ObjectLocation } from "./move";
export { S3ObjectStore, StorageError } from "./s3";
export type { S3ObjectStoreConfig, S3Operation } from "./s3";

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("object storage is not configured: set the R2_* variables and MEDIA_BASE_URL");
    this.name = "StorageNotConfiguredError";
  }
}

/** A metered store for `env`, built on every call (tests); objectStore() caches one. */
export function createObjectStore(env: ServerEnv): ObjectStore {
  const { R2_S3_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (endpoint && accessKeyId && secretAccessKey && isR2Configured(env)) {
    return new MeteredObjectStore(new S3ObjectStore({ endpoint, accessKeyId, secretAccessKey }));
  }
  if (env.APP_ENV === "dev") return new MeteredObjectStore(fsObjectStore());
  throw new StorageNotConfiguredError();
}

let shared: ObjectStore | undefined;

/** The process-wide store; throws StorageNotConfiguredError outside dev without R2. */
export function objectStore(): ObjectStore {
  shared ??= createObjectStore(serverEnv());
  return shared;
}

/** Tests only: forget the cached store after changing the environment. */
export function resetObjectStore(): void {
  shared = undefined;
}

/** Tests only: serve `store` from objectStore() until the next reset (API tests use a MemoryObjectStore). */
export function setObjectStoreForTests(store: ObjectStore | undefined): void {
  shared = store;
}

export function isStorageNotConfigured(error: unknown): error is StorageNotConfiguredError {
  return error instanceof StorageNotConfiguredError;
}
