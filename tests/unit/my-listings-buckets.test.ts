import { describe, expect, it } from "vitest";
import { BUCKET_STATUSES, primaryAction, tabKeyTarget, visibleListings } from "@/components/listings/owner/buckets";
import { allowedActions, canResume } from "@/components/listings/owner/listing-actions";
import { OWNER_LIST_BUCKETS, type ListingStatus, type OwnerListingSummary } from "@/lib/contracts/listings";

// "Mes annonces": what each tab shows, the action each row puts forward, the actions its menu
// offers per status, and the tab keyboard model.

function summary(status: ListingStatus, overrides: Partial<OwnerListingSummary> = {}): OwnerListingSummary {
  return {
    id: `id-${status}`,
    slugId: status === "draft" ? null : `velo-${status}`,
    status,
    title: "Vélo de ville",
    price: 1500,
    isDonation: false,
    categoryId: "loisirs",
    subcategoryId: "velos",
    citySlug: "casablanca",
    thumb: null,
    photoCount: 1,
    moderation: { state: "auto_ok", flags: [] },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    publishedAt: null,
    expiresAt: null,
    canRenew: false,
    ...overrides,
  };
}

describe("visibleListings", () => {
  it("hides deleted listings from the ended tab and sorts by last change", () => {
    const rows = [summary("sold", { id: "a", updatedAt: "2026-10-02T00:00:00.000Z" }), summary("removed", { id: "b" }), summary("expired", { id: "c", updatedAt: "2026-10-05T00:00:00.000Z" })];
    expect(visibleListings("ended", rows).map((row) => row.id)).toEqual(["c", "a"]);
  });

  it("covers every bucket and never shows removed or purged listings", () => {
    expect(Object.keys(BUCKET_STATUSES).sort()).toEqual([...OWNER_LIST_BUCKETS].sort());
    for (const statuses of Object.values(BUCKET_STATUSES)) {
      expect(statuses).not.toContain("removed");
      expect(statuses).not.toContain("purged");
    }
  });
});

describe("primaryAction", () => {
  it("puts forward the next useful step of each status", () => {
    expect(primaryAction(summary("draft"))).toEqual({ kind: "continue" });
    expect(primaryAction(summary("rejected"))).toEqual({ kind: "fix" });
    expect(primaryAction(summary("paused", { expiresAt: "2099-01-01T00:00:00.000Z" }))).toEqual({ kind: "resume" });
    // Past expiry the server refuses resume (409) until the nightly job turns it expired.
    expect(primaryAction(summary("paused", { expiresAt: "2026-10-16T02:00:00.000Z" }), new Date("2026-10-16T12:00:00.000Z"))).toBeNull();
    expect(primaryAction(summary("published"))).toBeNull();
    expect(primaryAction(summary("published", { canRenew: true }))).toEqual({ kind: "renew" });
    expect(primaryAction(summary("expired", { canRenew: true }))).toEqual({ kind: "renew" });
    expect(primaryAction(summary("expired"))).toBeNull();
    expect(primaryAction(summary("sold"))).toBeNull();
    expect(primaryAction(summary("pending_review"))).toBeNull();
  });
});

describe("allowedActions", () => {
  it("pauses and sells a published listing, renews it only when renewable", () => {
    expect(allowedActions(summary("published"))).toMatchObject({ edit: true, view: true, pause: true, resume: false, sold: true, renew: false, remove: true });
    expect(allowedActions(summary("published", { canRenew: true })).renew).toBe(true);
  });

  it("resumes a paused listing and keeps a sold one read-only", () => {
    const now = new Date("2026-10-16T12:00:00.000Z");
    expect(allowedActions(summary("paused", { expiresAt: "2026-11-01T00:00:00.000Z" }), now)).toMatchObject({ pause: false, resume: true, sold: true, view: false });
    expect(allowedActions(summary("sold"))).toMatchObject({ edit: false, pause: false, resume: false, sold: false, renew: false, remove: true });
  });

  it("never offers resume once the expiry has passed (the nightly job has not run yet)", () => {
    const now = new Date("2026-10-16T12:00:00.000Z");
    const lapsed = summary("paused", { expiresAt: "2026-10-16T02:00:00.000Z" });
    expect(allowedActions(lapsed, now)).toMatchObject({ resume: false, sold: true, remove: true, renew: false });
    expect(canResume(summary("paused", { expiresAt: now.toISOString() }), now)).toBe(false);
    expect(canResume(summary("paused", { expiresAt: "2026-10-16T12:00:01.000Z" }), now)).toBe(true);
    expect(canResume(summary("paused"), now)).toBe(false);
    expect(canResume(summary("published", { expiresAt: "2026-11-01T00:00:00.000Z" }), now)).toBe(false);
  });

  it("offers only edit and delete on drafts and listings under review", () => {
    for (const status of ["draft", "pending_review"] as const) {
      expect(allowedActions(summary(status))).toEqual({ edit: true, view: false, pause: false, resume: false, sold: false, renew: false, remove: true });
    }
  });
});

describe("tabKeyTarget", () => {
  it("follows the reading direction with wrap-around, Home and End", () => {
    expect(tabKeyTarget("ArrowRight", 0, 4, false)).toBe(1);
    expect(tabKeyTarget("ArrowLeft", 0, 4, false)).toBe(3);
    expect(tabKeyTarget("ArrowLeft", 0, 4, true)).toBe(1);
    expect(tabKeyTarget("ArrowRight", 0, 4, true)).toBe(3);
    expect(tabKeyTarget("Home", 2, 4, false)).toBe(0);
    expect(tabKeyTarget("End", 0, 4, true)).toBe(3);
    expect(tabKeyTarget("Enter", 0, 4, false)).toBeNull();
  });
});
