import { describe, expect, it, vi } from "vitest";
import { amzDate, S3ObjectStore, StorageError } from "@/lib/storage/s3";

// The R2 adapter against fake credentials: presigned URL structure and determinism under a pinned
// clock, then HEAD/GET/PUT/DELETE through an injected fetch (signed headers, 404 -> null, errors).

const ENDPOINT = "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com";
const BUCKETS = { quarantine: "joutiya-staging-quarantine", media: "joutiya-staging-media", private: "joutiya-staging-private" } as const;
const NOW = new Date("2026-10-16T12:00:00.250Z");
// Fake credentials in the AWS key format; nothing here is a real secret.
const credentials = { accessKeyId: ["AKIA", "FAKE", "FAKE", "FAKE", "FAKE"].join(""), secretAccessKey: "fake-secret-".repeat(3) };

function store(fetchImpl?: typeof fetch, retries = 0) {
  return new S3ObjectStore({ endpoint: `${ENDPOINT}/`, ...credentials, buckets: BUCKETS, now: () => NOW, fetch: fetchImpl, retries });
}

function mockFetch(...responses: Response[]) {
  const calls: Request[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(input as Request);
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("S3ObjectStore.presignPut", () => {
  it("signs a path-style PUT URL with Content-Type and Content-Length, valid X-Amz-Expires seconds", async () => {
    const signed = await store().presignPut({ bucket: "quarantine", key: "uploads/u1234567890", contentType: "image/jpeg", contentLength: 123_456, expiresInSeconds: 300 });
    const url = new URL(signed.url);
    expect(url.origin).toBe(ENDPOINT);
    expect(url.pathname).toBe("/joutiya-staging-quarantine/uploads/u1234567890");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(`${credentials.accessKeyId}/20261016/auto/s3/aws4_request`);
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261016T120000Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect([...url.searchParams.keys()].sort()).toEqual(["X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-Signature", "X-Amz-SignedHeaders"]);
    expect(signed.method).toBe("PUT");
    expect(signed.headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(signed.expiresAt.toISOString()).toBe("2026-10-16T12:05:00.000Z");
  });

  it("is deterministic under a fixed clock and changes with every signed input", async () => {
    const input = { bucket: "quarantine" as const, key: "uploads/u1234567890", contentType: "image/jpeg", contentLength: 10, expiresInSeconds: 300 };
    const [a, b] = await Promise.all([store().presignPut(input), store().presignPut(input)]);
    expect(a.url).toBe(b.url);
    const signature = (url: string) => new URL(url).searchParams.get("X-Amz-Signature");
    expect(signature((await store().presignPut({ ...input, contentType: "image/png" })).url)).not.toBe(signature(a.url));
    expect(signature((await store().presignPut({ ...input, contentLength: 11 })).url)).not.toBe(signature(a.url));
    expect(signature((await store().presignPut({ ...input, key: "uploads/u1234567891" })).url)).not.toBe(signature(a.url));
    const later = new S3ObjectStore({ endpoint: ENDPOINT, ...credentials, buckets: BUCKETS, now: () => new Date(NOW.getTime() + 60_000) });
    expect(signature((await later.presignPut(input)).url)).not.toBe(signature(a.url));
  });

  it("clamps the validity to R2's 1 s .. 7 days and refuses unsafe keys", async () => {
    expect(new URL((await store().presignPut({ bucket: "media", key: "k", contentType: "image/webp", contentLength: 1, expiresInSeconds: 0 })).url).searchParams.get("X-Amz-Expires")).toBe("1");
    expect(new URL((await store().presignPut({ bucket: "media", key: "k", contentType: "image/webp", contentLength: 1, expiresInSeconds: 10 ** 9 })).url).searchParams.get("X-Amz-Expires")).toBe("604800");
    await expect(store().presignPut({ bucket: "media", key: "../etc/passwd", contentType: "image/webp", contentLength: 1, expiresInSeconds: 300 })).rejects.toMatchObject({ status: 400, code: "invalid_body" });
    expect(amzDate(new Date("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
  });
});

describe("S3ObjectStore requests", () => {
  it("HEAD: signed headers, size and type, null on 404, StorageError otherwise", async () => {
    const { impl, calls } = mockFetch(
      new Response(null, { status: 200, headers: { "content-length": "4096", "content-type": "image/jpeg" } }),
      new Response(null, { status: 404 }),
      new Response("<Error/>", { status: 500 }),
    );
    const s3 = store(impl);
    expect(await s3.head("quarantine", "uploads/u1234567890")).toEqual({ size: 4096, contentType: "image/jpeg" });
    const request = calls[0]!;
    expect(request.method).toBe("HEAD");
    expect(request.url).toBe(`${ENDPOINT}/joutiya-staging-quarantine/uploads/u1234567890`);
    expect(request.headers.get("authorization")).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/20261016/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`));
    expect(request.headers.get("x-amz-date")).toBe("20261016T120000Z");
    expect(request.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    expect(await s3.head("quarantine", "uploads/missing")).toBeNull();
    const error = await s3.head("media", "k").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ name: "StorageError", operation: "head", status: 500, bucket: "joutiya-staging-media" });
    expect(calls).toHaveLength(3);
  });

  it("GET: the body as a Buffer, null on 404", async () => {
    const { impl, calls } = mockFetch(new Response(new Uint8Array([1, 2, 3]), { status: 200 }), new Response(null, { status: 404 }), new Response(null, { status: 403 }));
    const s3 = store(impl);
    const body = await s3.get("quarantine", "uploads/u1234567890");
    expect(Buffer.isBuffer(body)).toBe(true);
    expect([...body!]).toEqual([1, 2, 3]);
    expect(calls[0]!.method).toBe("GET");
    expect(await s3.get("quarantine", "uploads/missing")).toBeNull();
    await expect(s3.get("private", "k")).rejects.toMatchObject({ operation: "get", status: 403, bucket: "joutiya-staging-private" });
  });

  it("PUT: body, Content-Type and Cache-Control signed", async () => {
    const { impl, calls } = mockFetch(new Response(null, { status: 200 }), new Response(null, { status: 200 }), new Response(null, { status: 507 }));
    const s3 = store(impl);
    const bytes = new Uint8Array([82, 73, 70, 70]);
    await s3.put("media", "listings/abcd2345/u1234567890-l.webp", bytes, { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" });
    const request = calls[0]!;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(`${ENDPOINT}/joutiya-staging-media/listings/abcd2345/u1234567890-l.webp`);
    expect(request.headers.get("content-type")).toBe("image/webp");
    expect(request.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(request.headers.get("authorization")).toContain("SignedHeaders=cache-control;host;x-amz-content-sha256;x-amz-date,");
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
    await s3.put("private", "backups/x", bytes, { contentType: "application/octet-stream" });
    expect(calls[1]!.headers.has("cache-control")).toBe(false);
    await expect(s3.put("media", "k", bytes, { contentType: "image/webp" })).rejects.toMatchObject({ operation: "put", status: 507 });
  });

  it("DELETE: idempotent (204 and 404 both succeed), other statuses fail", async () => {
    const { impl, calls } = mockFetch(new Response(null, { status: 204 }), new Response(null, { status: 404 }), new Response(null, { status: 403 }));
    const s3 = store(impl);
    await s3.delete("quarantine", "uploads/u1234567890");
    await s3.delete("quarantine", "uploads/u1234567890");
    expect(calls.map((request) => request.method)).toEqual(["DELETE", "DELETE"]);
    await expect(s3.delete("quarantine", "uploads/u1234567890")).rejects.toMatchObject({ operation: "delete", status: 403 });
  });

  it("retries 5xx and 429 up to the configured count, never 4xx", async () => {
    const { impl, calls } = mockFetch(new Response(null, { status: 503 }), new Response(null, { status: 429 }), new Response(null, { status: 200, headers: { "content-length": "7" } }));
    expect(await store(impl, 2).head("media", "k")).toEqual({ size: 7, contentType: "application/octet-stream" });
    expect(calls).toHaveLength(3);
    const once = mockFetch(new Response(null, { status: 404 }));
    expect(await store(once.impl, 3).head("media", "k")).toBeNull();
    expect(once.calls).toHaveLength(1);
  });

  it("validates keys before any request and encodes URL segments", async () => {
    const { impl, calls } = mockFetch();
    const s3 = store(impl);
    await expect(s3.get("media", "a//b")).rejects.toMatchObject({ status: 400 });
    await expect(s3.delete("media", "")).rejects.toMatchObject({ status: 400 });
    await expect(s3.head("media", "k?x=1")).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
    expect(s3.objectUrl("private", "backups/2026-10-16/full/users.ndjson.gz.age").pathname).toBe("/joutiya-staging-private/backups/2026-10-16/full/users.ndjson.gz.age");
    expect(s3.bucket("quarantine")).toBe("joutiya-staging-quarantine");
    expect(s3.name).toBe("s3");
  });
});
