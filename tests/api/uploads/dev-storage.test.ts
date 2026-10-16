import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as StorageFs from "@/lib/storage/fs";

// D11 end to end in development: no R2, the factory serves the file store, the browser's PUT goes
// to the signed dev route exactly as it would to R2, complete runs the pipeline inline (D12) and
// the variant is served back by the dev route of the media bucket (MEDIA_BASE_URL in dev).

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
const root = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtempSync(join(realpathSync(tmpdir()), "joutiya-dev-e2e-"));
});
vi.mock("@/lib/storage/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof StorageFs>();
  const store = new actual.FsObjectStore(root, "http://localhost:3000");
  return { ...actual, fsObjectStore: () => store };
});

import { rmSync } from "node:fs";
import { NextRequest } from "next/server";
import { GET as devGet, PUT as devPut } from "@/app/api/dev/storage/[bucket]/[...key]/route";
import { POST as complete } from "@/app/api/uploads/[id]/complete/route";
import { POST as sign } from "@/app/api/uploads/sign/route";
import type { SignUploadResponse, UploadStatusResponse } from "@/lib/contracts/media";
import { resetServerEnv, serverEnv } from "@/lib/env";
import { sharp } from "@/lib/media/sharp-setup";
import { photoUrl } from "@/lib/media/urls";
import { resetObjectStore } from "@/lib/storage";
import { call, draft, exifGpsJpeg, member } from "./helpers";

beforeAll(() => {
  resetServerEnv();
  resetObjectStore();
});
afterAll(() => {
  resetObjectStore();
  rmSync(root, { recursive: true, force: true });
});

/** Calls the dev storage route as the browser would (the bucket and key from the URL path). */
function devRoute(handler: typeof devPut, url: string, init: { method: string; headers?: Record<string, string>; body?: Buffer }): Promise<Response> {
  const [, bucket, ...key] = new URL(url).pathname.replace("/api/dev/storage", "").split("/");
  const request = new NextRequest(url, { method: init.method, headers: init.headers, ...(init.body ? { body: new Uint8Array(init.body) } : {}) });
  return handler(request, { params: Promise.resolve({ bucket, key }) });
}

describe("uploads in development (file store and signed dev route)", () => {
  it("signs, accepts the browser's PUT, processes inline and serves the metadata-free variant", async () => {
    const owner = await member();
    const listingId = await draft(owner);
    const file = await exifGpsJpeg();

    const signed = await call<SignUploadResponse>(sign, "POST", "/api/uploads/sign", { member: owner, body: { purpose: "listing", targetId: listingId, declaredSize: file.byteLength, declaredType: "image/jpeg" } });
    expect(signed.status).toBe(201);
    const { uploadId, url, headers } = signed.body;
    expect(url.startsWith(`http://localhost:3000/api/dev/storage/joutiya-dev-quarantine/uploads/${uploadId}?`)).toBe(true);

    // A Content-Type other than the signed one is refused, like R2.
    expect((await devRoute(devPut, url, { method: "PUT", headers: { "content-type": "image/png" }, body: file })).status).toBe(403);
    expect((await devRoute(devPut, url, { method: "PUT", headers, body: file })).status).toBe(200);

    const done = await call<UploadStatusResponse>(complete, "POST", `/api/uploads/${uploadId}/complete`, { member: owner, body: {} });
    expect(done.body).toMatchObject({ status: "ready", photo: { id: uploadId, w: 50, h: 100 } });

    const variant = photoUrl(serverEnv(), listingId, uploadId, "l")!;
    expect(variant).toBe(`http://localhost:3000/api/dev/storage/joutiya-dev-media/listings/${listingId}/${uploadId}-l.webp`);
    const served = await devRoute(devGet, variant, { method: "GET" });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/webp");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const meta = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
    expect([meta.format, meta.exif, meta.width, meta.height]).toEqual(["webp", undefined, 50, 100]);

    // The original never becomes public: gone from quarantine, and quarantine needs a signed GET anyway.
    expect((await devRoute(devGet, `http://localhost:3000/api/dev/storage/joutiya-dev-quarantine/uploads/${uploadId}`, { method: "GET" })).status).toBe(403);
  });
});
