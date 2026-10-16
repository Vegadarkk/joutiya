import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerEnv } from "@/lib/env";
import { FsObjectStore } from "@/lib/storage/fs";
import { MemoryObjectStore } from "@/lib/storage/memory";
import { MeteredObjectStore } from "@/lib/storage/metered";
import { S3ObjectStore } from "@/lib/storage/s3";

// Capped reads of the ObjectStore adapters (the media pipeline reads the quarantine object with
// maxBytes = its declared size): at most maxBytes + 1 bytes come back and an R2 body stream is
// cancelled past the cap, so an object swapped after the HEAD cannot fill the worker's memory.

vi.mock("@/lib/quota", () => ({ consume: vi.fn(async () => ({ level: "ok" })) }));

// Fake credentials in the AWS key format; nothing here is a real secret.
const r2 = { endpoint: "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com", accessKeyId: ["AKIA", "FAKE", "FAKE", "FAKE", "FAKE"].join(""), secretAccessKey: "fake-secret-".repeat(3), retries: 0 };
const root = mkdtempSync(path.join(realpathSync(tmpdir()), "joutiya-cap-test-"));
const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

beforeEach(() => {
  process.env.APP_ENV = "dev";
  resetServerEnv();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ObjectStore.get with maxBytes", () => {
  it("memory: cuts at maxBytes + 1, whole object at or under the cap, null when missing", async () => {
    const store = new MemoryObjectStore();
    store.seed("quarantine", "uploads/a", body, { contentType: "image/jpeg" });
    expect((await store.get("quarantine", "uploads/a", { maxBytes: 100 }))!.equals(body.subarray(0, 101))).toBe(true);
    expect((await store.get("quarantine", "uploads/a", { maxBytes: 1000 }))!.equals(body)).toBe(true);
    expect((await store.get("quarantine", "uploads/a"))!.equals(body)).toBe(true);
    expect(await store.get("quarantine", "uploads/missing", { maxBytes: 10 })).toBeNull();
  });

  it("files (dev): reads only up to the cap", async () => {
    const store = new FsObjectStore(root, "http://localhost:3000");
    await store.put("quarantine", "uploads/b", body, { contentType: "image/jpeg" });
    expect((await store.get("quarantine", "uploads/b", { maxBytes: 99 }))!.equals(body.subarray(0, 100))).toBe(true);
    expect((await store.get("quarantine", "uploads/b", { maxBytes: 5000 }))!.equals(body)).toBe(true);
    expect((await store.get("quarantine", "uploads/b", { maxBytes: 1000 }))!.equals(body)).toBe(true);
    expect(await store.get("quarantine", "uploads/missing", { maxBytes: 10 })).toBeNull();
  });

  it("R2: stops downloading past the cap and cancels the body stream", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = Buffer.alloc(64 * 1024, 7);
    // An endless body (a multi-GB object): only the capped read can end it.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(chunk));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(endless, { status: 200 })) as unknown as typeof fetch;
    const store = new S3ObjectStore({ ...r2, fetch: fetchImpl });
    const result = await store.get("quarantine", "uploads/c", { maxBytes: 200_000 });
    expect(result!.byteLength).toBe(200_001);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("R2: a body under the cap comes back whole", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(body), { status: 200 })) as unknown as typeof fetch;
    const store = new S3ObjectStore({ ...r2, fetch: fetchImpl });
    expect((await store.get("quarantine", "uploads/d", { maxBytes: 1000 }))!.equals(body)).toBe(true);
  });

  it("metered: passes the cap through", async () => {
    const inner = new MemoryObjectStore();
    inner.seed("quarantine", "uploads/e", body, { contentType: "image/jpeg" });
    const store = new MeteredObjectStore(inner);
    expect((await store.get("quarantine", "uploads/e", { maxBytes: 9 }))!.byteLength).toBe(10);
  });
});
