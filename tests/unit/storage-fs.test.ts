import { rmSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerEnv } from "@/lib/env";
import type * as StorageFs from "@/lib/storage/fs";
import { devStorageSignature, verifyDevSignature, type FsObjectStore } from "@/lib/storage/fs";
import { assertObjectKey, isValidObjectKey } from "@/lib/storage/keys";
import { GET, HEAD, PUT } from "@/app/api/dev/storage/[bucket]/[...key]/route";

// The development stand-in for R2 (D11): presigned PUT -> dev route -> HEAD/GET/DELETE through the
// same store, with the signature, expiry, Content-Type and key hygiene the browser flow relies on.

// A temporary root instead of os.tmpdir()/joutiya-dev-storage, shared by the route and the test.
const root = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtempSync(join(realpathSync(tmpdir()), "joutiya-storage-test-"));
});

vi.mock("@/lib/storage/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof StorageFs>();
  const store = new actual.FsObjectStore(root, "http://localhost:3000");
  return { ...actual, fsObjectStore: () => store };
});

const { fsObjectStore } = await import("@/lib/storage/fs");
const store: FsObjectStore = fsObjectStore();

const QUARANTINE = "joutiya-dev-quarantine";
const MEDIA = "joutiya-dev-media";
const bytes = Buffer.from("not really a jpeg, but bytes");

type Handler = typeof PUT;

function call(handler: Handler, url: string, init: { method: string; headers?: Record<string, string>; body?: Buffer }, bucket: string, key: string): Promise<Response> {
  const request = new NextRequest(url, { method: init.method, headers: init.headers, ...(init.body ? { body: new Uint8Array(init.body) } : {}) });
  return handler(request, { params: Promise.resolve({ bucket, key: key.split("/") }) });
}

beforeEach(() => {
  process.env.APP_ENV = "dev";
  resetServerEnv();
});

afterEach(() => {
  vi.useRealTimers();
  resetServerEnv();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("object keys", () => {
  it("accepts S3-safe keys and refuses traversal, empty segments and odd characters", () => {
    expect(isValidObjectKey("uploads/abcd2345/photo-l.webp")).toBe(true);
    expect(isValidObjectKey("maps/morocco.pmtiles")).toBe(true);
    for (const key of ["", "/abs", "a//b", "a/../b", "../x", "./x", "a/./b", "a b", "a\\b", "a?b", "é", "x".repeat(513)]) {
      expect(isValidObjectKey(key), key).toBe(false);
    }
    expect(() => assertObjectKey("../etc/passwd")).toThrow(expect.objectContaining({ status: 400, code: "invalid_body" }));
  });
});

describe("FsObjectStore + dev route", () => {
  it("round-trips presign -> PUT -> HEAD/GET -> DELETE", async () => {
    const key = "uploads/upl0001/original";
    const signed = await store.presignPut({ bucket: "quarantine", key, contentType: "image/jpeg", contentLength: bytes.byteLength, expiresInSeconds: 300 });
    expect(signed.method).toBe("PUT");
    expect(signed.headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(signed.url).toMatch(new RegExp(`^http://localhost:3000/api/dev/storage/${QUARANTINE}/${key}\\?exp=\\d+&len=${bytes.byteLength}&sig=[A-Za-z0-9_-]+$`));
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 290_000);

    const put = await call(PUT, signed.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: bytes }, QUARANTINE, key);
    expect(put.status).toBe(200);
    expect(put.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);

    expect(await store.head("quarantine", key)).toEqual({ size: bytes.byteLength, contentType: "image/jpeg" });
    expect((await store.get("quarantine", key))?.equals(bytes)).toBe(true);
    // The object lives under <root>/<bucket>/, never outside.
    expect(path.relative(root, path.join(root, QUARANTINE)).startsWith("..")).toBe(false);

    await store.delete("quarantine", key);
    expect(await store.head("quarantine", key)).toBeNull();
    expect(await store.get("quarantine", key)).toBeNull();
    await expect(store.delete("quarantine", key)).resolves.toBeUndefined();
  });

  it("refuses an expired, tampered or missing signature and a Content-Type that was not signed", async () => {
    const key = "uploads/upl0002/original";
    const signed = await store.presignPut({ bucket: "quarantine", key, contentType: "image/webp", contentLength: bytes.byteLength, expiresInSeconds: 60 });
    const forbidden = async (url: string, contentType = "image/webp") => {
      const response = await call(PUT, url, { method: "PUT", headers: { "content-type": contentType }, body: bytes }, QUARANTINE, key);
      expect(response.status).toBe(403);
      return ((await response.json()) as { error: { message?: string } }).error.message;
    };
    // Wrong content type.
    expect(await forbidden(signed.url, "image/png")).toBe("storage signature invalid");
    // Tampered signature and missing signature.
    const url = new URL(signed.url);
    url.searchParams.set("sig", `${url.searchParams.get("sig")?.slice(0, -2)}xx`);
    expect(await forbidden(url.toString())).toBe("storage signature invalid");
    url.searchParams.delete("sig");
    expect(await forbidden(url.toString())).toBe("storage signature invalid");
    // A correctly signed URL whose expiry has passed.
    const past = Math.floor(Date.now() / 1000) - 10;
    const expired = new URL(signed.url);
    expired.searchParams.set("exp", String(past));
    expired.searchParams.set("sig", devStorageSignature({ method: "PUT", bucket: QUARANTINE, key, contentType: "image/webp", contentLength: bytes.byteLength, expires: past }));
    expect(await forbidden(expired.toString())).toBe("storage signature expired");
    // Expiry is honoured over time too.
    vi.useFakeTimers();
    vi.setSystemTime(signed.expiresAt.getTime() + 1000);
    expect(await forbidden(signed.url)).toBe("storage signature expired");
    vi.useRealTimers();
    expect(await store.head("quarantine", key)).toBeNull();
    expect(verifyDevSignature({ method: "PUT", bucket: QUARANTINE, key, expires: Number.NaN }, "x")).toBe("invalid");
  });

  it("refuses path traversal and unknown buckets", async () => {
    for (const key of ["../../etc/passwd", "a/../b", "./x"]) {
      const response = await call(PUT, `http://localhost:3000/api/dev/storage/${QUARANTINE}/x`, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: bytes }, QUARANTINE, key);
      expect(response.status, key).toBe(400);
    }
    const unknown = await call(GET, "http://localhost:3000/api/dev/storage/other/x", { method: "GET" }, "other-bucket", "x");
    expect(unknown.status).toBe(404);
  });

  it("serves the media bucket publicly with nosniff, and the other buckets only to a signed GET", async () => {
    const key = "listings/lst00001/photo-s.webp";
    await store.put("media", key, bytes, { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" });
    const base = `http://localhost:3000/api/dev/storage/${MEDIA}/${key}`;
    const head = await call(HEAD, base, { method: "HEAD" }, MEDIA, key);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/webp");
    expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(head.headers.get("x-content-type-options")).toBe("nosniff");
    expect(head.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const get = await call(GET, base, { method: "GET" }, MEDIA, key);
    expect(get.status).toBe(200);
    expect(Buffer.from(await get.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await call(GET, `${base}-missing`, { method: "GET" }, MEDIA, `${key}-missing`)).status).toBe(404);

    await store.put("quarantine", key, bytes, { contentType: "image/webp" });
    const quarantine = `http://localhost:3000/api/dev/storage/${QUARANTINE}/${key}`;
    expect((await call(GET, quarantine, { method: "GET" }, QUARANTINE, key)).status).toBe(403);
    const expires = Math.floor(Date.now() / 1000) + 60;
    const signedGet = `${quarantine}?exp=${expires}&sig=${devStorageSignature({ method: "GET", bucket: QUARANTINE, key, expires })}`;
    const response = await call(GET, signedGet, { method: "GET" }, QUARANTINE, key);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses bodies above the dev cap before storing anything", async () => {
    const key = "uploads/upl0003/original";
    const size = 33 * 1024 * 1024;
    const signed = await store.presignPut({ bucket: "quarantine", key, contentType: "image/jpeg", contentLength: size, expiresInSeconds: 60 });
    const request = new NextRequest(signed.url, { method: "PUT", headers: { "content-type": "image/jpeg", "content-length": String(size) }, body: new Uint8Array(16) });
    const response = await PUT(request, { params: Promise.resolve({ bucket: QUARANTINE, key: key.split("/") }) });
    expect(response.status).toBe(413);
    expect(await store.head("quarantine", key)).toBeNull();
  });

  it("does not exist outside development", async () => {
    process.env.APP_ENV = "staging";
    resetServerEnv();
    const key = "listings/lst00001/photo-s.webp";
    expect((await call(GET, `http://localhost:3000/api/dev/storage/${MEDIA}/${key}`, { method: "GET" }, MEDIA, key)).status).toBe(404);
    expect((await call(PUT, `http://localhost:3000/api/dev/storage/${MEDIA}/${key}`, { method: "PUT", headers: { "content-type": "image/webp" }, body: bytes }, MEDIA, key)).status).toBe(404);
  });
});
