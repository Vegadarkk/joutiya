import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiDelete, apiPatch, apiPost, isApiError, uploadToPresignedUrl } from "@/lib/auth/client";

// Browser API helpers added for phase 3: PATCH/DELETE with the CSRF rules of POST, and the
// cross-origin presigned PUT (XMLHttpRequest for progress, no cookie, no CSRF header).

type Sent = { url: string; init: RequestInit };

function stubFetch(status: number, body?: unknown, headers: Record<string, string> = {}): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  });
  return sent;
}

class FakeXhr {
  static instances: FakeXhr[] = [];
  static behaviour: { status?: number; fail?: "error" | "timeout" } = {};
  method = "";
  url = "";
  async = true;
  withCredentials = true;
  status = 0;
  headers: Record<string, string> = {};
  body: unknown;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  aborted = false;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string, async: boolean): void {
    this.method = method;
    this.url = url;
    this.async = async;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: unknown): void {
    this.body = body;
    queueMicrotask(() => {
      if (this.aborted) return;
      if (FakeXhr.behaviour.fail === "error") return this.onerror?.();
      if (FakeXhr.behaviour.fail === "timeout") return this.ontimeout?.();
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 });
      this.status = FakeXhr.behaviour.status ?? 200;
      this.onload?.();
    });
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.instances = [];
  FakeXhr.behaviour = {};
});

describe("apiPatch / apiDelete", () => {
  it("send same-origin mutations with the CSRF header when the cookie is readable", async () => {
    vi.stubGlobal("document", { cookie: "theme=dark; __Host-csrf=csrf-token-value" });
    const sent = stubFetch(200, { listing: { id: "abcd2345" } });
    await expect(apiPatch("/api/listings/abcd2345", { title: "Vélo" })).resolves.toEqual({ listing: { id: "abcd2345" } });
    expect(sent[0]?.url).toBe("/api/listings/abcd2345");
    expect(sent[0]?.init).toMatchObject({ method: "PATCH", credentials: "same-origin", cache: "no-store", body: JSON.stringify({ title: "Vélo" }) });
    expect(sent[0]?.init.headers).toEqual({ accept: "application/json", "content-type": "application/json", "x-csrf-token": "csrf-token-value" });

    const deleted = stubFetch(204);
    await expect(apiDelete("/api/listings/abcd2345")).resolves.toBeUndefined();
    expect(deleted[0]?.init).toMatchObject({ method: "DELETE", credentials: "same-origin" });
    expect(deleted[0]?.init.headers).toEqual({ accept: "application/json", "x-csrf-token": "csrf-token-value" });
    expect(deleted[0]?.init.body).toBeUndefined();

    const posted = stubFetch(201, { id: "x" });
    await apiPost("/api/listings", {});
    expect(posted[0]?.init.headers).toEqual({ accept: "application/json", "content-type": "application/json", "x-csrf-token": "csrf-token-value" });
  });

  it("omit the CSRF header without a cookie and translate error bodies", async () => {
    vi.stubGlobal("document", { cookie: "" });
    stubFetch(409, { error: { code: "draft_limit" } }, { "retry-after": "30" });
    const error = await apiPatch("/api/listings", {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(isApiError(error, "draft_limit")).toBe(true);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).retryAfter).toBe(30);
    const sent = stubFetch(204);
    await apiDelete("/api/uploads/u1");
    expect(sent[0]?.init.headers).toEqual({ accept: "application/json" });
  });
});

describe("uploadToPresignedUrl", () => {
  const blob = new Blob([new Uint8Array(10)], { type: "image/jpeg" });

  it("PUTs the blob cross-origin without credentials, with the signed headers only, and reports progress", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.stubGlobal("document", { cookie: "__Host-csrf=csrf-token-value" });
    const progress: number[] = [];
    await uploadToPresignedUrl("https://acc.eu.r2.cloudflarestorage.com/joutiya-prod-quarantine/uploads/u1?X-Amz-Signature=x", { "Content-Type": "image/jpeg" }, blob, (fraction) => progress.push(fraction));
    const xhr = FakeXhr.instances[0]!;
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toContain("r2.cloudflarestorage.com");
    expect(xhr.withCredentials).toBe(false);
    expect(xhr.headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(xhr.body).toBe(blob);
    expect(progress).toEqual([0.5, 1, 1]);
  });

  it("rejects with a typed error on a non-2xx answer, a network failure, a timeout and an abort", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    FakeXhr.behaviour = { status: 403 };
    await expect(uploadToPresignedUrl("https://r2.example/x", {}, blob)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    FakeXhr.behaviour = { fail: "error" };
    await expect(uploadToPresignedUrl("https://r2.example/x", {}, blob)).rejects.toMatchObject({ status: 0, code: "network" });
    FakeXhr.behaviour = { fail: "timeout" };
    await expect(uploadToPresignedUrl("https://r2.example/x", {}, blob)).rejects.toMatchObject({ code: "network" });
    FakeXhr.behaviour = {};
    const controller = new AbortController();
    const pending = uploadToPresignedUrl("https://r2.example/x", {}, blob, undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(FakeXhr.instances.at(-1)?.aborted).toBe(true);
    const already = new AbortController();
    already.abort();
    await expect(uploadToPresignedUrl("https://r2.example/x", {}, blob, undefined, already.signal)).rejects.toMatchObject({ code: "aborted" });
  });
});
