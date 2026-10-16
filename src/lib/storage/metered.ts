import "server-only";
import { consume } from "@/lib/quota";
import type { BucketRole, GetOptions, ObjectHead, ObjectStore, PresignedPut, PresignPutInput, PutOptions } from "./types";

// R2 free tier accounting (§2 quota guards): every mutation is a Class A operation, every read a
// Class B one. The wrapper counts for whichever adapter is active, so the dev store exercises the
// same counters as R2. A presigned PUT is counted when signed: the browser's request is not
// observable from here, and an unused URL over-counts by one at most.

export class MeteredObjectStore implements ObjectStore {
  readonly name: string;

  constructor(private readonly inner: ObjectStore) {
    this.name = inner.name;
  }

  async presignPut(input: PresignPutInput): Promise<PresignedPut> {
    const signed = await this.inner.presignPut(input);
    await consume("r2.classA");
    return signed;
  }

  async head(bucket: BucketRole, key: string): Promise<ObjectHead | null> {
    const result = await this.inner.head(bucket, key);
    await consume("r2.classB");
    return result;
  }

  async get(bucket: BucketRole, key: string, options?: GetOptions): Promise<Buffer | null> {
    const result = await this.inner.get(bucket, key, options);
    await consume("r2.classB");
    return result;
  }

  async put(bucket: BucketRole, key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    await this.inner.put(bucket, key, body, options);
    await consume("r2.classA");
  }

  async delete(bucket: BucketRole, key: string): Promise<void> {
    await this.inner.delete(bucket, key);
    await consume("r2.classA");
  }
}
