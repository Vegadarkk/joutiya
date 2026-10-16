import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { UploadRecord } from "@/lib/db/repositories/uploads";

// The owner's view of a listing's photos: attached ones first, then the other uploads; a ready
// upload not on the listing is offered again (as `processing`: the wizard polls it and puts it in
// the next save) only where the pipeline never attaches and no legal hold applies. The uploads
// query reads only the statuses the view needs.

vi.mock("@/lib/db/repositories/uploads", () => ({ listUploadsByTarget: vi.fn(async () => []) }));

const { listUploadsByTarget } = await import("@/lib/db/repositories/uploads");
const { mergePhotos, ownerListingView } = await import("@/lib/listings/owner-view");

const NOW = new Date("2026-10-16T10:00:00Z");
const BLUR = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";

function upload(id: string, status: UploadRecord["status"], minutes: number, overrides: Partial<UploadRecord> = {}): UploadRecord {
  return {
    id,
    ownerUid: "owner-1",
    purpose: "listing",
    targetId: "abcdefgh",
    declaredSize: 1000,
    declaredType: "image/jpeg",
    status,
    quarantineKey: `uploads/${id}`,
    bucket: "media",
    checks: {},
    purgeAt: NOW,
    createdAt: new Date(NOW.getTime() + minutes * 60_000),
    updatedAt: NOW,
    ...(status === "ready" ? { width: 800, height: 600, blurhash: BLUR } : {}),
    ...overrides,
  };
}

function listing(status: ListingRecord["status"], overrides: Partial<ListingRecord> = {}): ListingRecord {
  return {
    id: "abcdefgh",
    status,
    photos: [{ id: "attached0001", w: 800, h: 600, blurhash: BLUR }],
    legalHold: [],
    title: "",
    description: "",
    attributes: {},
    price: null,
    priceNegotiable: false,
    isDonation: false,
    contact: { messaging: true, showPhone: false, whatsapp: false },
    moderation: { state: "auto_ok", flags: [] },
    version: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as ListingRecord;
}

const uploads = [
  upload("attached0001", "ready", 0),
  upload("unsaved00001", "ready", 3),
  upload("rejected0001", "rejected", 1, { rejectReason: "nsfw" }),
  upload("processing01", "processing", 2),
  upload("signed000001", "signed", 4),
];

beforeEach(() => {
  vi.mocked(listUploadsByTarget).mockReset().mockResolvedValue(uploads);
});

describe("mergePhotos", () => {
  it("offers a ready upload the owner has not saved yet on a published, paused, expired or held listing", () => {
    for (const status of ["published", "paused", "expired", "pending_review"] as const) {
      expect(mergePhotos(listing(status), uploads)).toEqual([
        { id: "attached0001", status: "ready", w: 800, h: 600, blurhash: BLUR },
        { id: "rejected0001", status: "rejected", rejectReason: "nsfw" },
        { id: "processing01", status: "processing" },
        { id: "unsaved00001", status: "processing" },
        { id: "signed000001", status: "signed" },
      ]);
    }
  });

  it("keeps hiding it on drafts (the pipeline attaches), read-only listings and under a legal hold", () => {
    const hidden = [
      { id: "attached0001", status: "ready", w: 800, h: 600, blurhash: BLUR },
      { id: "rejected0001", status: "rejected", rejectReason: "nsfw" },
      { id: "processing01", status: "processing" },
      { id: "signed000001", status: "signed" },
    ];
    for (const status of ["draft", "rejected", "sold", "removed"] as const) expect(mergePhotos(listing(status), uploads)).toEqual(hidden);
    expect(mergePhotos(listing("published", { legalHold: ["requisition-1"] }), uploads)).toEqual(hidden);
  });
});

describe("ownerListingView", () => {
  it("reads only the pending statuses where no ready upload can wait for a save", async () => {
    vi.mocked(listUploadsByTarget).mockResolvedValue(uploads.filter((item) => item.status !== "ready"));
    for (const record of [listing("draft"), listing("rejected"), listing("sold"), listing("published", { legalHold: ["requisition-1"] })]) {
      vi.mocked(listUploadsByTarget).mockClear();
      await ownerListingView(record);
      expect(listUploadsByTarget).toHaveBeenCalledWith("abcdefgh", ["signed", "processing", "rejected"]);
    }
  });

  it("reads every status where the owner attaches by saving", async () => {
    const view = await ownerListingView(listing("paused"));
    expect(listUploadsByTarget).toHaveBeenCalledWith("abcdefgh", undefined);
    expect(view.photos.map((photo) => photo.id)).toEqual(["attached0001", "rejected0001", "processing01", "unsaved00001", "signed000001"]);
  });
});
