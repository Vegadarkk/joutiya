import "server-only";
import type { BucketRole, ObjectHead, ObjectStore, PresignedPut, PresignPutInput, PutOptions } from "./types";

// Cloudflare R2 through its S3 API (EU jurisdiction endpoint, architecture §2): presigned PUT for
// the browser, HEAD/GET/PUT/DELETE for the worker. Typed stub for now.
// TODO(lot B): implement with the SDK chosen in research/libs-map-backup.md (presigned URLs valid
// 5 minutes with the Content-Type signed; path-style addressing; region "auto"), wrapped by
// MeteredObjectStore for the r2.classA / r2.classB counters.

export interface S3ObjectStoreConfig {
  /** https://<account>.eu.r2.cloudflarestorage.com */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function notImplemented(method: string): Error {
  return new Error(`S3ObjectStore.${method} is not implemented yet (phase 3, lot B)`);
}

export class S3ObjectStore implements ObjectStore {
  readonly name = "s3";

  constructor(readonly config: S3ObjectStoreConfig) {}

  async presignPut(_input: PresignPutInput): Promise<PresignedPut> {
    throw notImplemented("presignPut");
  }

  async head(_bucket: BucketRole, _key: string): Promise<ObjectHead | null> {
    throw notImplemented("head");
  }

  async get(_bucket: BucketRole, _key: string): Promise<Buffer | null> {
    throw notImplemented("get");
  }

  async put(_bucket: BucketRole, _key: string, _body: Uint8Array, _options: PutOptions): Promise<void> {
    throw notImplemented("put");
  }

  async delete(_bucket: BucketRole, _key: string): Promise<void> {
    throw notImplemented("delete");
  }
}
