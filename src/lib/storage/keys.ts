import "server-only";
import { serverEnv, type ServerEnv } from "@/lib/env";
import { HttpError } from "@/lib/http/errors";
import type { BucketRole } from "./types";

// Bucket roles -> names, object key hygiene and the public media base URL.

export const BUCKET_ROLES: readonly BucketRole[] = ["quarantine", "media", "private"];

const ENV_NAME: Record<BucketRole, "R2_BUCKET_QUARANTINE" | "R2_BUCKET_MEDIA" | "R2_BUCKET_PRIVATE"> = {
  quarantine: "R2_BUCKET_QUARANTINE",
  media: "R2_BUCKET_MEDIA",
  private: "R2_BUCKET_PRIVATE",
};

/** Names of the development buckets (infra/targets.json, environment dev): the FsObjectStore directories. */
const DEV_BUCKETS: Record<BucketRole, string> = {
  quarantine: "joutiya-dev-quarantine",
  media: "joutiya-dev-media",
  private: "joutiya-dev-private",
};

type BucketEnv = Pick<ServerEnv, "APP_ENV" | "SITE_URL" | "MEDIA_BASE_URL" | (typeof ENV_NAME)[BucketRole]>;

/** The bucket name of a role: R2_BUCKET_* when set, else the dev name. */
export function bucketName(role: BucketRole, env: BucketEnv = serverEnv()): string {
  return env[ENV_NAME[role]] ?? DEV_BUCKETS[role];
}

/** The role a bucket name plays, or null for a name that is not one of ours. */
export function bucketRole(name: string, env: BucketEnv = serverEnv()): BucketRole | null {
  return BUCKET_ROLES.find((role) => bucketName(role, env) === name) ?? null;
}

/** Object keys: lower-risk subset of S3 names, at most 512 chars, no empty, "." or ".." segment. */
export function isValidObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > 512 || !/^[A-Za-z0-9._/-]+$/.test(key)) return false;
  return key.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Throws 400 on a key that could escape its bucket (path traversal) or break a URL. */
export function assertObjectKey(key: string): void {
  if (!isValidObjectKey(key)) throw new HttpError(400, "invalid_body", "invalid object key");
}

/**
 * Where photos are served from, without a trailing slash: MEDIA_BASE_URL (media.joutiya.ma) or,
 * in development without it, the signed dev storage route of the media bucket (D11). Null when
 * nothing is configured outside dev: callers show listings without photos.
 */
export function mediaBaseUrl(env: BucketEnv = serverEnv()): string | null {
  if (env.MEDIA_BASE_URL) return env.MEDIA_BASE_URL.replace(/\/+$/, "");
  if (env.APP_ENV !== "dev") return null;
  return `${new URL(env.SITE_URL).origin}/api/dev/storage/${bucketName("media", env)}`;
}
