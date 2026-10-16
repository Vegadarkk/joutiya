import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEnv } from "@/lib/env";

// MemoryObjectStore (tests), the quota-metering wrapper and the factory's choice by environment.

const quota = vi.hoisted(() => ({ consume: vi.fn(async (id: string) => ({ id, level: "ok" })) }));
vi.mock("@/lib/quota", () => ({ consume: quota.consume, isDegraded: vi.fn(async () => false) }));

const { MemoryObjectStore } = await import("@/lib/storage/memory");
const { MeteredObjectStore } = await import("@/lib/storage/metered");
const { createObjectStore, StorageNotConfiguredError } = await import("@/lib/storage");
const { bucketName, bucketRole, mediaBaseUrl } = await import("@/lib/storage/keys");

const body = new TextEncoder().encode("bytes");

beforeEach(() => {
  quota.consume.mockClear();
});

describe("MemoryObjectStore", () => {
  it("stores objects and records every call in order", async () => {
    const store = new MemoryObjectStore();
    const signed = await store.presignPut({ bucket: "quarantine", key: "uploads/u1/original", contentType: "image/jpeg", contentLength: 5, expiresInSeconds: 300 });
    expect(signed).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/jpeg" } });
    expect(signed.url).toMatch(/^memory:\/\/quarantine\/uploads\/u1\/original\?len=5&exp=\d+$/);
    expect(await store.head("quarantine", "uploads/u1/original")).toBeNull();
    // seed() stands for the browser's PUT and is not recorded.
    store.seed("quarantine", "uploads/u1/original", body, { contentType: "image/jpeg" });
    expect(await store.head("quarantine", "uploads/u1/original")).toEqual({ size: 5, contentType: "image/jpeg" });
    expect(Buffer.from((await store.get("quarantine", "uploads/u1/original")) ?? []).toString()).toBe("bytes");
    await store.put("media", "listings/l1/p-l.webp", body, { contentType: "image/webp", cacheControl: "public, max-age=1" });
    await store.delete("quarantine", "uploads/u1/original");
    expect(store.has("quarantine", "uploads/u1/original")).toBe(false);
    expect(store.keys("media")).toEqual(["listings/l1/p-l.webp"]);
    expect(store.opsFor("quarantine", "uploads/u1/original")).toEqual(["presignPut", "head", "head", "get", "delete"]);
    expect(store.calls.at(-2)).toEqual({ op: "put", bucket: "media", key: "listings/l1/p-l.webp" });
    // An oversized object must be deleted before any GET: the call log makes that assertable.
    const ops = store.opsFor("quarantine", "uploads/u1/original");
    expect(ops.indexOf("delete")).toBeGreaterThan(ops.indexOf("head"));
    store.clear();
    expect(store.calls).toEqual([]);
    expect(store.keys("media")).toEqual([]);
  });

  it("refuses unsafe keys like every adapter", async () => {
    const store = new MemoryObjectStore();
    await expect(store.get("media", "../x")).rejects.toMatchObject({ status: 400 });
    expect(store.calls).toEqual([]);
  });
});

describe("MeteredObjectStore", () => {
  it("counts Class A operations for mutations and Class B for reads", async () => {
    const inner = new MemoryObjectStore();
    const store = new MeteredObjectStore(inner);
    expect(store.name).toBe("memory");
    await store.presignPut({ bucket: "quarantine", key: "k", contentType: "image/jpeg", contentLength: 1, expiresInSeconds: 1 });
    await store.put("media", "k", body, { contentType: "image/webp" });
    await store.head("media", "k");
    await store.get("media", "k");
    await store.delete("media", "k");
    expect(quota.consume.mock.calls.map(([id]) => id)).toEqual(["r2.classA", "r2.classA", "r2.classB", "r2.classB", "r2.classA"]);
    expect(inner.calls.map((call) => call.op)).toEqual(["presignPut", "put", "head", "get", "delete"]);
  });
});

describe("createObjectStore", () => {
  const r2 = {
    R2_S3_ENDPOINT: "https://0123456789abcdef.eu.r2.cloudflarestorage.com",
    R2_ACCESS_KEY_ID: "r2-key-id",
    R2_SECRET_ACCESS_KEY: "r2-key-secret",
    R2_BUCKET_QUARANTINE: "joutiya-staging-quarantine",
    R2_BUCKET_MEDIA: "joutiya-staging-media",
    R2_BUCKET_PRIVATE: "joutiya-staging-private",
    MEDIA_BASE_URL: "https://media-staging.joutiya.ma",
  };

  it("uses the file store in development without R2", () => {
    expect(createObjectStore(parseEnv({}).env).name).toBe("fs");
    // Half a configuration in dev still means the file store.
    expect(createObjectStore(parseEnv({ R2_BUCKET_MEDIA: "joutiya-dev-media" }).env).name).toBe("fs");
  });

  it("refuses to run deployed without R2", () => {
    expect(() => createObjectStore(parseEnv({ APP_ENV: "staging", SITE_URL: "https://staging.joutiya.ma" }).env)).toThrow(StorageNotConfiguredError);
  });

  it("picks the S3 adapter when R2 is configured", () => {
    const store = createObjectStore(parseEnv({ APP_ENV: "staging", SITE_URL: "https://staging.joutiya.ma", ...r2 }).env);
    expect(store.name).toBe("s3");
    expect(quota.consume).not.toHaveBeenCalled();
  });
});

describe("bucket names and the media base URL", () => {
  it("maps roles to the configured names, dev names otherwise", () => {
    const dev = parseEnv({}).env;
    expect(bucketName("quarantine", dev)).toBe("joutiya-dev-quarantine");
    expect(bucketName("media", dev)).toBe("joutiya-dev-media");
    expect(bucketName("private", dev)).toBe("joutiya-dev-private");
    const staging = parseEnv({ R2_BUCKET_MEDIA: "joutiya-staging-media" }).env;
    expect(bucketName("media", staging)).toBe("joutiya-staging-media");
    expect(bucketRole("joutiya-staging-media", staging)).toBe("media");
    expect(bucketRole("joutiya-dev-media", staging)).toBeNull();
    expect(bucketRole("joutiya-dev-private", dev)).toBe("private");
  });

  it("derives the media base URL from MEDIA_BASE_URL, the dev route, or nothing", () => {
    expect(mediaBaseUrl(parseEnv({}).env)).toBe("http://localhost:3000/api/dev/storage/joutiya-dev-media");
    expect(mediaBaseUrl(parseEnv({ SITE_URL: "http://127.0.0.1:3100/", R2_BUCKET_MEDIA: "custom-media" }).env)).toBe("http://127.0.0.1:3100/api/dev/storage/custom-media");
    expect(mediaBaseUrl(parseEnv({ MEDIA_BASE_URL: "https://media.joutiya.ma///" }).env)).toBe("https://media.joutiya.ma");
    expect(mediaBaseUrl(parseEnv({ APP_ENV: "prod", SITE_URL: "https://joutiya.ma" }).env)).toBeNull();
  });
});
