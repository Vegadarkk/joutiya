import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/auth/client";
import type { UploadStatusResponse } from "@/lib/contracts/media";
import { pollUpload } from "@/lib/listings/client/api";
import type { PreparedImage } from "@/lib/listings/client/prepare-image";
import { uploadErrorCode, uploadListingPhoto, type PhotoUploadPhase } from "@/lib/listings/client/upload";
import { createUploadRunner } from "@/lib/listings/client/store";

// Upload orchestration of design §3: prepare -> sign -> presigned PUT (progress) -> complete ->
// poll. The network is injected; only the sequence and the phases are under test.

const PHOTO = { id: "upload0001", w: 2048, h: 1536, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" };

function prepared(): PreparedImage {
  return { blob: new Blob([new Uint8Array(1234)], { type: "image/jpeg" }), type: "image/jpeg", width: 2048, height: 1536, source: "jpeg" };
}

function stubFetch(answers: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${url}`;
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    const answer = answers[key];
    if (!answer) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("uploadListingPhoto", () => {
  it("runs the whole sequence and reports the phases", async () => {
    const calls = stubFetch({
      "POST /api/uploads/sign": { body: { uploadId: "upload0001", url: "https://quarantine.example/put", method: "PUT", headers: { "Content-Type": "image/jpeg" }, expiresAt: "2026-10-16T00:05:00Z" } },
      "POST /api/uploads/upload0001/complete": { body: { status: "processing" } },
      "GET /api/uploads/upload0001": { body: { status: "ready", photo: PHOTO } },
    });
    const put = vi.fn(async (_url: string, _headers: Record<string, string>, _blob: Blob, onProgress?: (f: number, l: number, t: number) => void) => {
      onProgress?.(0.5, 617, 1234);
      onProgress?.(1, 1234, 1234);
    });
    const phases: PhotoUploadPhase[] = [];
    const result = await uploadListingPhoto("abcdefgh", new Blob([new Uint8Array([1])]), {
      prepare: async () => prepared(),
      put,
      onPhase: (phase) => phases.push(phase),
      pollOptions: { sleep: async () => {} },
    });
    expect(result.uploadId).toBe("upload0001");
    expect(result.status).toEqual({ status: "ready", photo: PHOTO });
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/uploads/sign", body: { purpose: "listing", targetId: "abcdefgh", declaredSize: 1234, declaredType: "image/jpeg" } });
    expect(put).toHaveBeenCalledWith("https://quarantine.example/put", { "Content-Type": "image/jpeg" }, expect.any(Blob), expect.any(Function), undefined);
    expect(calls[1]).toMatchObject({ method: "POST", url: "/api/uploads/upload0001/complete" });
    expect(calls[2]).toMatchObject({ method: "GET", url: "/api/uploads/upload0001" });
    expect(phases.map((p) => p.phase)).toEqual(["preparing", "uploading", "uploading", "uploading", "processing", "ready"]);
    expect(phases.filter((p) => p.phase === "uploading").map((p) => (p as { progress: number }).progress)).toEqual([0, 0.5, 1]);
  });

  it("reports a rejected photo without polling when complete answers at once", async () => {
    stubFetch({
      "POST /api/uploads/sign": { body: { uploadId: "upload0002", url: "https://q/put", method: "PUT", headers: { "Content-Type": "image/jpeg" }, expiresAt: "x" } },
      "POST /api/uploads/upload0002/complete": { body: { status: "rejected", rejectReason: "nsfw" } },
    });
    const phases: PhotoUploadPhase[] = [];
    const result = await uploadListingPhoto("abcdefgh", new Blob([new Uint8Array([1])]), { prepare: async () => prepared(), put: async () => {}, onPhase: (phase) => phases.push(phase) });
    expect(result.status).toEqual({ status: "rejected", rejectReason: "nsfw" });
    expect(phases.at(-1)).toEqual({ phase: "rejected", uploadId: "upload0002", reason: "nsfw" });
  });

  it("surfaces the API refusal of the signature (quota, storage) as an ApiError", async () => {
    stubFetch({ "POST /api/uploads/sign": { status: 422, body: { error: { code: "photo_limit" } } } });
    const put = vi.fn();
    await expect(uploadListingPhoto("abcdefgh", new Blob([new Uint8Array([1])]), { prepare: async () => prepared(), put })).rejects.toMatchObject({ code: "photo_limit" });
    expect(put).not.toHaveBeenCalled();
  });

  it("stops before signing when the preparation fails", async () => {
    const calls = stubFetch({});
    const error = Object.assign(new Error("too big"), { name: "PrepareImageError", code: "file_too_large" });
    await expect(
      uploadListingPhoto("abcdefgh", new Blob([new Uint8Array([1])]), {
        prepare: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(calls).toEqual([]);
  });

  it("names the error code for the tile", () => {
    expect(uploadErrorCode(new ApiError(507, "storage_full"))).toBe("storage_full");
    expect(uploadErrorCode(new Error("?"))).toBe("internal");
  });
});

describe("pollUpload", () => {
  it("polls every interval until the pipeline answers", async () => {
    const answers: UploadStatusResponse[] = [{ status: "processing" }, { status: "processing" }, { status: "ready", photo: PHOTO }];
    const waits: number[] = [];
    const fetchStatus = vi.fn(async () => answers.shift()!);
    const result = await pollUpload("upload0001", { intervalMs: 2000, maxMs: 60_000, sleep: async (ms) => void waits.push(ms), fetchStatus });
    expect(result).toEqual({ status: "ready", photo: PHOTO });
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([2000, 2000, 2000]);
  });

  it("gives up after the deadline and returns the last processing answer", async () => {
    vi.useFakeTimers();
    try {
      const fetchStatus = vi.fn(async (): Promise<UploadStatusResponse> => ({ status: "processing" }));
      const sleep = async (ms: number) => {
        vi.advanceTimersByTime(ms);
      };
      const result = await pollUpload("upload0001", { intervalMs: 2000, maxMs: 60_000, sleep, fetchStatus });
      expect(result).toEqual({ status: "processing" });
      expect(fetchStatus).toHaveBeenCalledTimes(30);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createUploadRunner", () => {
  it("runs at most `concurrency` jobs at once, in order", async () => {
    const runner = createUploadRunner(2);
    const log: string[] = [];
    const gates: (() => void)[] = [];
    const job = (name: string) => () =>
      new Promise<void>((resolve) => {
        log.push(`start ${name}`);
        gates.push(() => {
          log.push(`end ${name}`);
          resolve();
        });
      });
    runner.enqueue(job("a"));
    runner.enqueue(job("b"));
    runner.enqueue(job("c"));
    expect(log).toEqual(["start a", "start b"]);
    gates[0]!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["start a", "start b", "end a", "start c"]);
    gates[1]!();
    gates[2]!();
    await Promise.resolve();
    expect(log.filter((l) => l.startsWith("end")).length).toBe(3);
  });
});
