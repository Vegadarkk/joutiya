import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/auth/client";
import type { OwnerListing } from "@/lib/contracts/listings";
import { Autosave } from "@/lib/listings/client/autosave";
import { blockersAfterPatch, blockersOf, confirmsLeave, isPhotoBusy, ownerPhotosOf, photoItemsFromListing, photoOrder, readyPhotoIds, recoverPatch, saveModeOf, saveRetryDelay, type PhotoItem } from "@/lib/listings/client/store";

// Pure parts of the wizard store: save mode per status, the retry policy of a failed save, what a
// failed save keeps, the photo order sent to the API and the tiles built from the listing.

function listing(overrides: Partial<OwnerListing> = {}): OwnerListing {
  return {
    id: "abcdefgh",
    slugId: null,
    status: "draft",
    sellerType: "individual",
    pausedReason: null,
    categoryId: null,
    subcategoryId: null,
    title: "",
    description: "",
    attributes: {},
    condition: null,
    price: null,
    priceNegotiable: false,
    isDonation: false,
    location: null,
    photos: [],
    contact: { showPhone: false, whatsapp: false },
    sensitiveDeclaration: null,
    moderation: { state: "auto_ok", flags: [] },
    version: 1,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    publishedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function tile(key: string, status: PhotoItem["status"], uploadId: string | null = key): PhotoItem {
  return {
    key,
    uploadId,
    status,
    progress: 1,
    previewUrl: null,
    photo: status === "ready" ? { id: uploadId ?? key, w: 800, h: 600, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" } : null,
  };
}

describe("saveModeOf", () => {
  it("saves drafts and rejected listings by themselves, live ones on request", () => {
    expect(saveModeOf("draft")).toBe("auto");
    expect(saveModeOf("rejected")).toBe("auto");
    for (const status of ["published", "paused", "pending_review", "expired"] as const) expect(saveModeOf(status)).toBe("manual");
  });
});

describe("saveRetryDelay", () => {
  it("backs off on network and server failures, up to two minutes", () => {
    expect(saveRetryDelay(new ApiError(0, "network"), 1)).toBe(15_000);
    expect(saveRetryDelay(new ApiError(503, "unavailable"), 2)).toBe(30_000);
    expect(saveRetryDelay(new ApiError(500, "internal"), 10)).toBe(120_000);
    expect(saveRetryDelay(new TypeError("Failed to fetch"), 1)).toBe(15_000);
  });

  it("waits for Retry-After when rate limited", () => {
    expect(saveRetryDelay(new ApiError(429, "rate_limited", { retryAfter: 7 }), 1)).toBe(7_000);
  });

  it("retries a version conflict once, quickly, then stops", () => {
    expect(saveRetryDelay(new ApiError(409, "conflict"), 1)).toBe(400);
    expect(saveRetryDelay(new ApiError(409, "conflict"), 2)).toBeNull();
  });

  it("resends at once what is left of a refused body, stops on other refusals", () => {
    expect(saveRetryDelay(new ApiError(400, "invalid_body"), 1)).toBe(0);
    expect(saveRetryDelay(new ApiError(422, "invalid_listing"), 1)).toBeNull();
    expect(saveRetryDelay(new ApiError(403, "forbidden"), 1)).toBeNull();
  });

  it("stops on a spent daily quota although it is a 503: the changes stay in the page until a manual retry", async () => {
    const quota = new ApiError(503, "quota_exhausted", { retryAfter: 7_200 });
    expect(saveRetryDelay(quota, 1)).toBeNull();
    expect(saveRetryDelay(quota, 3)).toBeNull();
    vi.useFakeTimers();
    try {
      // Wired into the autosave: one request, then none however long the page stays open.
      const save = vi.fn(async (_patch: { title?: string; price?: number }) => {});
      save.mockRejectedValueOnce(quota);
      const autosave = new Autosave<{ title?: string; price?: number }>({ save, retryAfter: saveRetryDelay });
      autosave.queue({ title: "Vélo" });
      expect(await autosave.flush()).toBe(false);
      autosave.queue({ price: 900 });
      await vi.advanceTimersByTimeAsync(3 * 3_600_000);
      expect(save).toHaveBeenCalledTimes(1);
      expect(autosave.currentState).toBe("error");
      expect(await autosave.flush({ force: true })).toBe(true);
      expect(save).toHaveBeenLastCalledWith({ title: "Vélo", price: 900 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("confirmsLeave", () => {
  type Patch = { title?: string; price?: number };
  const quota = new ApiError(503, "quota_exhausted", { retryAfter: 7_200 });

  it("asks before leaving a draft whose changes a spent daily quota left unsaved, not one that saves normally", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    const autosave = new Autosave<Patch>({ save, retryAfter: saveRetryDelay });
    expect(confirmsLeave(autosave, 0)).toBe(false);
    // Pending changes of a draft that saves normally go out with the keepalive request on page hide.
    autosave.queue({ title: "Vélo" });
    expect(confirmsLeave(autosave, 0)).toBe(false);
    expect(await autosave.flush()).toBe(true);
    expect(confirmsLeave(autosave, 0)).toBe(false);

    save.mockRejectedValueOnce(quota);
    autosave.queue({ price: 900 });
    expect(await autosave.flush()).toBe(false);
    expect(confirmsLeave(autosave, 0)).toBe(true);
    autosave.queue({ title: "Vélo de ville" });
    expect(confirmsLeave(autosave, 0)).toBe(true);
    // Saved by the manual retry: nothing left to lose.
    expect(await autosave.flush({ force: true })).toBe(true);
    expect(confirmsLeave(autosave, 0)).toBe(false);
  });

  it("asks after any failed save that still holds changes, and for a field too short to be sent", async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async (_patch: Patch) => {});
      save.mockRejectedValueOnce(new ApiError(503, "unavailable"));
      const autosave = new Autosave<Patch>({ save, retryAfter: saveRetryDelay });
      autosave.queue({ title: "Vélo" });
      expect(await autosave.flush()).toBe(false);
      expect(confirmsLeave(autosave, 0)).toBe(true);
      // The automatic retry saves it.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(save).toHaveBeenCalledTimes(2);
      expect(confirmsLeave(autosave, 0)).toBe(false);
      expect(confirmsLeave(autosave, 1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for a live listing's unsaved changes", () => {
    const autosave = new Autosave<Patch>({ save: async () => {}, manual: true });
    expect(confirmsLeave(autosave, 0)).toBe(false);
    autosave.queue({ price: 900 });
    expect(confirmsLeave(autosave, 0)).toBe(true);
  });
});

describe("recoverPatch", () => {
  it("drops the fields the API refused and keeps the others", () => {
    const error = new ApiError(400, "invalid_body", { details: [{ path: "title", code: "too_small" }] });
    expect(recoverPatch({ title: "x", price: 10 }, error)).toEqual({ price: 10 });
  });

  it("drops everything for a listing that no longer exists, keeps everything otherwise", () => {
    expect(recoverPatch({ title: "Vélo" }, new ApiError(404, "not_found"))).toBeNull();
    expect(recoverPatch({ title: "Vélo" }, new ApiError(0, "network"))).toEqual({ title: "Vélo" });
  });
});

describe("blockersOf", () => {
  it("reads both shapes of details and ignores malformed entries", () => {
    const issue = { path: "photos", code: "photos_required" };
    expect(blockersOf(new ApiError(422, "invalid_listing", { details: [issue, { path: 3 }] }))).toEqual([issue]);
    expect(blockersOf(new ApiError(422, "invalid_listing", { details: { blockers: [issue] } }))).toEqual([issue]);
    expect(blockersOf(new ApiError(422, "invalid_listing"))).toEqual([]);
  });
});

describe("blockersAfterPatch", () => {
  it("clears the blockers of an edited field group only", () => {
    const blockers = [
      { path: "price", code: "price_required" },
      { path: "title", code: "phone_in_text" },
      { path: "contact.showPhone", code: "phone_required" },
    ];
    expect(blockersAfterPatch(blockers, { isDonation: true })).toEqual(blockers.slice(1));
    expect(blockersAfterPatch(blockers, { contact: { showPhone: false, whatsapp: false } })).toEqual(blockers.slice(0, 2));
  });
});

describe("photo tiles", () => {
  it("builds tiles from the listing, hiding abandoned signed uploads", () => {
    const items = photoItemsFromListing(
      listing({
        photos: [
          { id: "photo0001", status: "ready", w: 800, h: 600, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
          { id: "photo0002", status: "processing" },
          { id: "photo0003", status: "signed" },
          { id: "photo0004", status: "rejected", rejectReason: "nsfw" },
        ],
      }),
      "https://media.example/bucket/",
    );
    expect(items.map((item) => [item.key, item.status])).toEqual([
      ["photo0001", "ready"],
      ["photo0002", "processing"],
      ["photo0004", "rejected"],
    ]);
    expect(items[0]!.previewUrl).toBe("https://media.example/bucket/listings/abcdefgh/photo0001-s.webp");
    expect(items[1]!.previewUrl).toBeNull();
  });

  it("keeps the face count of a ready photo on its tile and in the photos the review counts", () => {
    const items = photoItemsFromListing(listing({ photos: [{ id: "photo0001", status: "ready", w: 800, h: 600, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", faces: 1 }] }), null);
    expect(items[0]!.faces).toBe(1);
    expect(ownerPhotosOf(items)[0]).toMatchObject({ id: "photo0001", faces: 1 });
  });

  it("sends ready and processing photos in tile order, never uploads in progress or failed", () => {
    const items = [tile("b", "processing"), tile("a", "ready"), tile("c", "uploading"), tile("d", "failed"), tile("e", "timeout"), tile("f", "rejected"), tile("g", "preparing", null)];
    expect(photoOrder(items)).toEqual(["b", "a", "e"]);
    expect(readyPhotoIds(items)).toEqual(["a"]);
  });

  it("derives the listing photos the validation counts from the tiles", () => {
    const items = [tile("a", "ready"), tile("b", "processing"), tile("c", "uploading"), { ...tile("d", "rejected"), rejectReason: "nsfw" as const }];
    expect(ownerPhotosOf(items)).toEqual([
      { id: "a", status: "ready", w: 800, h: 600, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
      { id: "b", status: "processing" },
      { id: "d", status: "rejected", rejectReason: "nsfw" },
    ]);
  });

  it("counts preparing, uploading and processing tiles as busy", () => {
    expect(["preparing", "uploading", "processing"].every((status) => isPhotoBusy(tile("x", status as PhotoItem["status"])))).toBe(true);
    expect(["ready", "failed", "rejected", "timeout"].some((status) => isPhotoBusy(tile("x", status as PhotoItem["status"])))).toBe(false);
  });
});
