import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { HttpError, notFound } from "@/lib/http/errors";
import { apiRoute } from "@/lib/http/route";
import { fsObjectStore, verifyDevSignature } from "@/lib/storage/fs";
import { bucketRole, isValidObjectKey } from "@/lib/storage/keys";
import type { BucketRole } from "@/lib/storage/types";

// Development only (APP_ENV=dev): the "R2" the browser and the worker talk to locally (D11).
// PUT needs the signature issued by FsObjectStore.presignPut (HMAC + expiry, Content-Type bound);
// GET/HEAD on the media bucket are public like media.joutiya.ma, the other buckets need a signed
// GET. Anywhere else the route does not exist.
export const dynamic = "force-dynamic";

/** Larger than MAX_UPLOAD_BYTES on purpose: the worker's HEAD gate must be testable locally. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

interface Target {
  bucketName: string;
  role: BucketRole;
  key: string;
}

function target(params: Record<string, string | string[] | undefined>): Target {
  const env = serverEnv();
  if (env.APP_ENV !== "dev") throw notFound();
  const bucketName = typeof params.bucket === "string" ? params.bucket : "";
  const role = bucketRole(bucketName, env);
  if (!role) throw notFound();
  const key = Array.isArray(params.key) ? params.key.join("/") : (params.key ?? "");
  if (!isValidObjectKey(key)) throw new HttpError(400, "invalid_body", "invalid object key");
  return { bucketName, role, key };
}

function requireSignature(request: NextRequest, method: "PUT" | "GET", { bucketName, key }: Target, contentType?: string): void {
  const query = new URL(request.url).searchParams;
  const expires = Number(query.get("exp"));
  const signature = query.get("sig") ?? "";
  const length = query.get("len");
  const input = { method, bucket: bucketName, key, expires, ...(method === "PUT" ? { contentType, contentLength: length === null ? undefined : Number(length) } : {}) };
  const outcome = verifyDevSignature(input, signature);
  if (outcome !== "ok") throw new HttpError(403, "forbidden", `storage signature ${outcome}`);
}

function headers(contentType: string, size: number, role: BucketRole, cacheControl: string | undefined): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Length": String(size),
    "X-Content-Type-Options": "nosniff",
    // Public media keys are immutable; the other buckets are read once by the worker.
    "Cache-Control": role === "media" ? (cacheControl ?? "public, max-age=300") : "no-store",
  };
}

async function locate(request: NextRequest, params: Record<string, string | string[] | undefined>): Promise<{ target: Target; size: number; contentType: string; cacheControl: string | undefined }> {
  const found = target(params);
  if (found.role !== "media") requireSignature(request, "GET", found);
  const store = fsObjectStore();
  const head = await store.head(found.role, found.key);
  if (!head) throw notFound();
  return { target: found, size: head.size, contentType: head.contentType, cacheControl: await store.cacheControl(found.role, found.key) };
}

export const PUT = apiRoute(async (request, context) => {
  const found = target(await context.params);
  const contentType = request.headers.get("content-type") ?? "";
  requireSignature(request, "PUT", found, contentType);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
  const body = Buffer.from(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
  await fsObjectStore().put(found.role, found.key, body, { contentType });
  // Like S3: 200 with the MD5 ETag of the body.
  return new Response(null, { status: 200, headers: { ETag: `"${createHash("md5").update(body).digest("hex")}"`, "Cache-Control": "no-store" } });
});

export const HEAD = apiRoute(async (request, context) => {
  const { target: found, size, contentType, cacheControl } = await locate(request, await context.params);
  return new Response(null, { status: 200, headers: headers(contentType, size, found.role, cacheControl) });
});

export const GET = apiRoute(async (request, context) => {
  const { target: found, size, contentType, cacheControl } = await locate(request, await context.params);
  const body = await fsObjectStore().get(found.role, found.key);
  if (!body) throw notFound();
  return new Response(new Uint8Array(body), { status: 200, headers: headers(contentType, size, found.role, cacheControl) });
});
