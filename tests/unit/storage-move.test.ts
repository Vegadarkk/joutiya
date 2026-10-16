import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryObjectStore } from "@/lib/storage/memory";
import { ObjectMoveError, moveObject } from "@/lib/storage/move";

// moveObject: GET the source, PUT the target, HEAD the target (same size), then DELETE the source.
// Every crash point leaves a complete copy, and a rerun finishes the move.

const FROM = { bucket: "media", key: "listings/abcd2345/photo0001-l.webp" } as const;
const TO = { bucket: "private", key: "removed/listings/abcd2345/photo0001-l.webp" } as const;
const OPTIONS = { contentType: "image/webp", maxBytes: 1024 };
let store: MemoryObjectStore;

beforeEach(() => {
  store = new MemoryObjectStore();
});

describe("moveObject", () => {
  it("copies, checks the copy, then deletes the source", async () => {
    store.seed(FROM.bucket, FROM.key, Buffer.from("webp-bytes"), { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" });
    expect(await moveObject(store, FROM, TO, OPTIONS)).toBe("moved");
    expect(store.has(FROM.bucket, FROM.key)).toBe(false);
    expect(store.calls.map((call) => `${call.op} ${call.bucket}`)).toEqual(["get media", "put private", "head private", "delete media"]);
    expect((await store.get(TO.bucket, TO.key))?.toString()).toBe("webp-bytes");
    expect(await store.head(TO.bucket, TO.key)).toEqual({ size: 10, contentType: "image/webp" });
  });

  it("is idempotent: a source already gone next to its copy is a finished move, neither is missing", async () => {
    store.seed(TO.bucket, TO.key, Buffer.from("webp-bytes"), { contentType: "image/webp" });
    expect(await moveObject(store, FROM, TO, OPTIONS)).toBe("already");
    expect(store.calls.map((call) => call.op)).toEqual(["get", "head"]);
    store.clear();
    expect(await moveObject(store, FROM, TO, OPTIONS)).toBe("missing");
  });

  it("overwrites a partial copy left by an earlier run while the source is still there", async () => {
    store.seed(FROM.bucket, FROM.key, Buffer.from("webp-bytes"), { contentType: "image/webp" });
    store.seed(TO.bucket, TO.key, Buffer.from("webp"), { contentType: "image/webp" });
    expect(await moveObject(store, FROM, TO, OPTIONS)).toBe("moved");
    expect((await store.get(TO.bucket, TO.key))?.toString()).toBe("webp-bytes");
  });

  it("keeps the source when the copy does not check out (size, or missing)", async () => {
    store.seed(FROM.bucket, FROM.key, Buffer.from("webp-bytes"), { contentType: "image/webp" });
    vi.spyOn(store, "head").mockResolvedValueOnce({ size: 3, contentType: "image/webp" }).mockResolvedValueOnce(null);
    await expect(moveObject(store, FROM, TO, OPTIONS)).rejects.toThrow(ObjectMoveError);
    await expect(moveObject(store, FROM, TO, OPTIONS)).rejects.toThrow(/missing/);
    expect(store.has(FROM.bucket, FROM.key)).toBe(true);
    expect(store.calls.some((call) => call.op === "delete")).toBe(false);
  });

  it("keeps the source when the copy or the deletion fails", async () => {
    store.seed(FROM.bucket, FROM.key, Buffer.from("webp-bytes"), { contentType: "image/webp" });
    vi.spyOn(store, "put").mockRejectedValueOnce(new Error("R2 500"));
    await expect(moveObject(store, FROM, TO, OPTIONS)).rejects.toThrow("R2 500");
    expect(store.has(FROM.bucket, FROM.key)).toBe(true);
    vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("R2 503"));
    await expect(moveObject(store, FROM, TO, OPTIONS)).rejects.toThrow("R2 503");
    // Both copies remain: the rerun deletes the source.
    expect(store.has(FROM.bucket, FROM.key) && store.has(TO.bucket, TO.key)).toBe(true);
    expect(await moveObject(store, FROM, TO, OPTIONS)).toBe("moved");
    expect(store.has(FROM.bucket, FROM.key)).toBe(false);
  });

  it("refuses a source over maxBytes without writing anything", async () => {
    store.seed(FROM.bucket, FROM.key, Buffer.alloc(2048), { contentType: "image/webp" });
    await expect(moveObject(store, FROM, TO, OPTIONS)).rejects.toThrow(/larger than 1024/);
    expect(store.has(TO.bucket, TO.key)).toBe(false);
    expect(store.has(FROM.bucket, FROM.key)).toBe(true);
  });
});
