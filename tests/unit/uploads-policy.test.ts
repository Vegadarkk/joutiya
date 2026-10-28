import { describe, expect, it, vi } from "vitest";

// Shared rules of the uploads API and the pipeline: target statuses (kept equal to the listing
// service's editable statuses), automatic attachment only where nothing is public, the photo
// limit per seller type, and the client view of an upload document.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

const { AUTO_ATTACH_STATUSES, LIVE_STATUSES, MANUAL_ATTACH_STATUSES, PHOTO_TARGET_STATUSES, RETAINED_STATUSES, maxPhotosOf, toStatusResponse } = await import("@/lib/uploads/policy");
const { EDITABLE_STATUSES } = await import("@/lib/listings/service");
const { MAX_PHOTOS_INDIVIDUAL, MAX_PHOTOS_PRO } = await import("@/lib/contracts/media");

const base = { id: "upl00001abcdefgh", width: 1600, height: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", hash: "0123456789abcdef" } as const;

describe("upload policy", () => {
  it("accepts photos exactly on the listings the owner may edit", () => {
    expect([...PHOTO_TARGET_STATUSES].sort()).toEqual([...EDITABLE_STATUSES].sort());
    expect(PHOTO_TARGET_STATUSES).not.toContain("sold");
    expect(PHOTO_TARGET_STATUSES).not.toContain("removed");
  });

  it("attaches automatically only to listings nobody else sees", () => {
    expect(AUTO_ATTACH_STATUSES).toEqual(["draft", "rejected"]);
    for (const status of LIVE_STATUSES) expect(AUTO_ATTACH_STATUSES).not.toContain(status);
    expect(AUTO_ATTACH_STATUSES).not.toContain("expired");
  });

  it("leaves the other editable listings to the owner's save, and retains a removed listing's uploads", () => {
    expect(MANUAL_ATTACH_STATUSES).toEqual(["pending_review", "published", "paused", "expired"]);
    expect(RETAINED_STATUSES).toEqual(["removed"]);
  });

  it("allows 10 photos to an individual and 20 to a Pro (D5)", () => {
    expect(maxPhotosOf({ sellerType: "individual" })).toBe(MAX_PHOTOS_INDIVIDUAL);
    expect(maxPhotosOf({ sellerType: "pro" })).toBe(MAX_PHOTOS_PRO);
  });

  it("maps upload documents to the MEDIA_API answer", () => {
    expect(toStatusResponse({ ...base, status: "ready" })).toEqual({ status: "ready", photo: { id: base.id, w: 1600, h: 1200, blurhash: base.blurhash, hash: base.hash } });
    expect(toStatusResponse({ ...base, hash: undefined, status: "ready" })).toEqual({ status: "ready", photo: { id: base.id, w: 1600, h: 1200, blurhash: base.blurhash } });
    expect(toStatusResponse({ ...base, status: "signed" })).toEqual({ status: "processing" });
    expect(toStatusResponse({ ...base, status: "processing" })).toEqual({ status: "processing" });
    expect(toStatusResponse({ ...base, status: "rejected", rejectReason: "nsfw" })).toEqual({ status: "rejected", rejectReason: "nsfw" });
    expect(toStatusResponse({ ...base, status: "rejected" })).toEqual({ status: "rejected", rejectReason: "expired" });
    // Faces found by the local check: the wizard proposes a crop; none, or unchecked, say nothing.
    expect(toStatusResponse({ ...base, status: "ready", checks: { faces: 1 } })).toMatchObject({ status: "ready", faces: 1 });
    expect(toStatusResponse({ ...base, status: "ready", checks: { faces: 0 } })).not.toHaveProperty("faces");
    // A ready document missing its dimensions never yields an invalid photo.
    expect(toStatusResponse({ id: base.id, status: "ready" })).toEqual({ status: "processing" });
  });
});
