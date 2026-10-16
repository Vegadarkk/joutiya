import { describe, expect, it } from "vitest";
import { LISTING_STATUSES, type ListingStatus } from "@/lib/contracts/listings";
import {
  IllegalTransitionError,
  RENEW_WINDOW_DAYS,
  TRANSITIONS,
  addDays,
  addMonths,
  approvalOutcome,
  approveHold,
  canRenew,
  canTransition,
  expiresAtFor,
  holdKind,
  purgeAtFor,
  renew,
  renewForReview,
  transition,
} from "@/lib/listings/lifecycle";

// Status machine (architecture §5, design D16): the table, the field patches, the renewal window,
// the expiry and purge dates. Pure module: no Firestore.

const NOW = new Date("2026-10-16T10:00:00.000Z");
const LIFETIME = { ttlDays: 60, purgeMonths: 12 };
const ctx = { now: NOW, lifetime: LIFETIME, ip: "41.250.1.2" };

function listing(status: ListingStatus, extra: Partial<{ version: number; publishedAt: Date; expiresAt: Date; purgeAt: Date; pausedReason: "owner" | "quota"; sortAt: Date; sortSource: "publish" | "renew" | "bump" }> = {}) {
  return { status, version: 3, sortAt: addDays(NOW, -10), sortSource: "publish" as const, ...extra };
}

describe("transition table", () => {
  it("covers every status with the designed targets", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...LISTING_STATUSES].sort());
    expect(TRANSITIONS.draft).toEqual(["pending_review", "published", "removed"]);
    expect(TRANSITIONS.pending_review).toEqual(["published", "paused", "expired", "rejected", "removed"]);
    expect(TRANSITIONS.published).toEqual(["paused", "sold", "expired", "removed", "pending_review"]);
    expect(TRANSITIONS.paused).toEqual(["published", "sold", "expired", "removed", "pending_review"]);
    expect(TRANSITIONS.sold).toEqual(["removed", "expired", "purged"]);
    expect(TRANSITIONS.expired).toEqual(["published", "removed", "purged", "pending_review"]);
    expect(TRANSITIONS.rejected).toEqual(["draft", "removed", "purged"]);
    expect(TRANSITIONS.removed).toEqual(["purged"]);
    expect(TRANSITIONS.purged).toEqual([]);
  });

  it("purges every status the retention job purges (expired, sold, removed, rejected), never a live one", () => {
    const purgeable = LISTING_STATUSES.filter((status) => TRANSITIONS[status].includes("purged"));
    expect(purgeable.sort()).toEqual(["expired", "rejected", "removed", "sold"]);
  });

  it("refuses what the table does not list, with the pair in the error", () => {
    expect(canTransition("draft", "sold")).toBe(false);
    expect(canTransition("sold", "published")).toBe(false);
    expect(canTransition("purged", "draft")).toBe(false);
    expect(() => transition(listing("sold"), "published", ctx)).toThrow(IllegalTransitionError);
    try {
      transition(listing("draft"), "paused", ctx);
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as IllegalTransitionError).from).toBe("draft");
      expect((error as IllegalTransitionError).to).toBe("paused");
    }
    // Every forbidden pair of the full matrix throws; every allowed pair returns a patch, except
    // the way out of review to published, paused or expired: only a moderator's approval takes it.
    const approvals: ListingStatus[] = ["published", "paused", "expired"];
    for (const from of LISTING_STATUSES) {
      for (const to of LISTING_STATUSES) {
        const allowed = TRANSITIONS[from].includes(to) && !(from === "pending_review" && approvals.includes(to));
        const source = listing(from, { expiresAt: addDays(NOW, 10), purgeAt: addDays(NOW, 300) });
        if (allowed) expect(transition(source, to, ctx).patch.status, `${from} -> ${to}`).toBe(to);
        else expect(() => transition(source, to, ctx), `${from} -> ${to}`).toThrow(IllegalTransitionError);
      }
    }
  });

  it("lets nobody but a moderator take a held listing out of review (an owner's pause would bypass it)", () => {
    const heldPaused = listing("pending_review", { publishedAt: addDays(NOW, -5), expiresAt: addDays(NOW, 55), pausedReason: "owner" });
    for (const to of ["published", "paused", "expired"] as const) {
      expect(() => transition(heldPaused, to, ctx), to).toThrow(/moderator's approval/);
    }
    expect(approveHold(heldPaused, ctx).patch.status).toBe("paused");
    expect(() => approveHold(listing("paused", { pausedReason: "owner" }), ctx)).toThrow(IllegalTransitionError);
  });
});

describe("publish and hold", () => {
  it("dates a publication: publishedAt, expiresAt = + ttlDays, purgeAt = expiresAt + purgeMonths, sortAt now", () => {
    const { patch, effects } = transition(listing("draft"), "published", ctx);
    expect(patch).toMatchObject({ status: "published", version: 4, updatedAt: NOW, publishedAt: NOW, sortAt: NOW, sortSource: "publish", pausedReason: null });
    expect(patch.expiresAt).toEqual(new Date("2026-12-15T10:00:00.000Z"));
    expect(patch.purgeAt).toEqual(new Date("2027-12-15T10:00:00.000Z"));
    expect(effects).toEqual({ search: "upsert", contentOp: { op: "listing.publish", ip: "41.250.1.2" }, audit: "listing.publish", revalidate: true, mail: "listingPublished" });
  });

  it("holds a flagged publication: pending_review, dated, not indexed, seller told", () => {
    const { patch, effects } = transition(listing("draft"), "pending_review", ctx);
    expect(patch).toMatchObject({ status: "pending_review", sortAt: NOW, sortSource: "publish", version: 4 });
    // Not published yet: a reopened rejected listing drops the date of its earlier publication.
    expect(patch.publishedAt).toBeNull();
    expect(effects).toEqual({ search: null, contentOp: { op: "listing.publish", ip: "41.250.1.2" }, audit: "listing.publish", revalidate: false, mail: "listingPendingReview" });
  });

  it("approves a held publication like a publication, without the publication mail (admin lot mails listingApproved)", () => {
    const { patch, effects, outcome } = approveHold(listing("pending_review"), ctx);
    expect(outcome).toEqual({ status: "published", kind: "publication" });
    expect(patch).toMatchObject({ status: "published", publishedAt: NOW, sortAt: NOW, sortSource: "publish", expiresAt: addDays(NOW, 60), purgeAt: addMonths(addDays(NOW, 60), 12) });
    expect(effects.audit).toBe("listing.approve");
    expect(effects.mail).toBeNull();
    expect(effects.search).toBe("upsert");
  });

  it("takes an edited live, paused or expired listing off the index and its page while it waits for review", () => {
    for (const status of ["published", "paused", "expired"] as const) {
      const { patch, effects } = transition(listing(status, { publishedAt: addDays(NOW, -5), expiresAt: addDays(NOW, 55) }), "pending_review", ctx);
      expect(patch, status).toEqual({ version: 4, updatedAt: NOW, status: "pending_review" });
      expect(effects, status).toMatchObject({ search: "delete", audit: "listing.hold", mail: "listingPendingReview", revalidate: true });
    }
  });

  it("approves a held edit of a published listing keeping its dates and rank", () => {
    const publishedAt = addDays(NOW, -5);
    const held = listing("pending_review", { publishedAt, expiresAt: addDays(NOW, 55), purgeAt: addMonths(addDays(NOW, 55), 12), sortAt: addDays(NOW, -5) });
    const { patch, effects, outcome } = approveHold(held, ctx);
    expect(outcome).toEqual({ status: "published", kind: "edit" });
    expect(patch).toEqual({ version: 4, updatedAt: NOW, status: "published", pausedReason: null });
    expect(effects).toEqual({ search: "upsert", contentOp: { op: "listing.update", ip: "41.250.1.2" }, audit: "listing.approve", revalidate: true, mail: null });
  });

  it("approves a held edit of a paused listing back to paused: same reason, same dates, still off the index", () => {
    for (const reason of ["owner", "quota"] as const) {
      const held = listing("pending_review", { publishedAt: addDays(NOW, -5), expiresAt: addDays(NOW, 55), purgeAt: addMonths(addDays(NOW, 55), 12), pausedReason: reason });
      const { patch, effects, outcome } = approveHold(held, ctx);
      expect(outcome, reason).toEqual({ status: "paused", kind: "edit" });
      expect(patch, reason).toEqual({ version: 4, updatedAt: NOW, status: "paused" });
      expect(effects, reason).toEqual({ search: "delete", contentOp: { op: "listing.update", ip: "41.250.1.2" }, audit: "listing.approve", revalidate: true, mail: null });
    }
  });

  it("approves a held edit past its expiry as expired: no free renewal, purge date kept (fresh only if it passed meanwhile)", () => {
    // An expired listing's plain edit (its expiry passed before the hold).
    const expiredEdit = listing("pending_review", { publishedAt: addDays(NOW, -70), expiresAt: addDays(NOW, -10), purgeAt: addDays(NOW, 355) });
    const expired = approveHold(expiredEdit, ctx);
    expect(expired.outcome).toEqual({ status: "expired", kind: "edit" });
    expect(expired.patch).toEqual({ version: 4, updatedAt: NOW, status: "expired", purgeAt: addDays(NOW, 355) });
    expect(expired.effects).toEqual({ search: "delete", contentOp: { op: "listing.update", ip: "41.250.1.2" }, audit: "listing.approve", revalidate: true, mail: null });
    // A published (or paused) listing whose expiry passed while its edit waited: what the nightly job would have done.
    for (const pausedReason of [undefined, "owner"] as const) {
      const lapsed = listing("pending_review", { publishedAt: addDays(NOW, -61), expiresAt: addDays(NOW, -1), purgeAt: addMonths(addDays(NOW, -1), 12), ...(pausedReason ? { pausedReason } : {}) });
      const result = approveHold(lapsed, ctx);
      expect(result.outcome, String(pausedReason)).toEqual({ status: "expired", kind: "edit" });
      expect(result.patch, String(pausedReason)).toEqual({ version: 4, updatedAt: NOW, status: "expired", purgeAt: addMonths(addDays(NOW, -1), 12) });
    }
    // Its purge date passed while it waited: the owner still gets time to renew it.
    const late = listing("pending_review", { publishedAt: addDays(NOW, -500), expiresAt: addDays(NOW, -440), purgeAt: addDays(NOW, -2) });
    expect(approveHold(late, ctx).patch).toMatchObject({ status: "expired", purgeAt: addMonths(NOW, 12) });
  });

  it("approves a held renewal as a renewal: published, back on top, new lifetime, publishedAt kept", () => {
    const held = listing("pending_review", { publishedAt: addDays(NOW, -70), purgeAt: addDays(NOW, 355), sortAt: addDays(NOW, -1), sortSource: "renew", pausedReason: "owner" });
    const { patch, effects, outcome } = approveHold(held, ctx);
    expect(outcome).toEqual({ status: "published", kind: "renewal" });
    expect(patch).toEqual({ version: 4, updatedAt: NOW, status: "published", sortAt: NOW, sortSource: "renew", expiresAt: addDays(NOW, 60), purgeAt: addMonths(addDays(NOW, 60), 12), pausedReason: null });
    expect(effects).toEqual({ search: "upsert", contentOp: { op: "listing.update", ip: "41.250.1.2" }, audit: "listing.approve", revalidate: true, mail: null });
  });

  it("reads the hold from the listing: publication (no publishedAt), renewal (no expiresAt), else an edit", () => {
    expect(holdKind({})).toBe("publication");
    expect(holdKind({ expiresAt: addDays(NOW, 5) })).toBe("publication");
    expect(holdKind({ publishedAt: addDays(NOW, -70) })).toBe("renewal");
    expect(holdKind({ publishedAt: addDays(NOW, -5), expiresAt: addDays(NOW, -1) })).toBe("edit");
    expect(approvalOutcome({ publishedAt: addDays(NOW, -5), expiresAt: NOW, pausedReason: "owner" }, NOW)).toEqual({ status: "expired", kind: "edit" });
    expect(approvalOutcome({ publishedAt: addDays(NOW, -5), expiresAt: addDays(NOW, 1), pausedReason: "quota" }, NOW)).toEqual({ status: "paused", kind: "edit" });
  });

  it("rejects with a purge date and the rejection mail; editing again reopens a draft without purge", () => {
    const rejected = transition(listing("pending_review"), "rejected", ctx);
    expect(rejected.patch).toMatchObject({ status: "rejected", purgeAt: addMonths(NOW, 12) });
    expect(rejected.effects).toMatchObject({ search: "delete", audit: "listing.reject", mail: "listingRejected" });
    const reopened = transition(listing("rejected", { purgeAt: addMonths(NOW, 12) }), "draft", ctx);
    expect(reopened.patch).toMatchObject({ status: "draft", purgeAt: null });
    expect(reopened.effects).toMatchObject({ search: null, audit: "listing.edit", mail: null });
  });
});

describe("pause, resume, sold, remove, expire, purge", () => {
  const live = listing("published", { publishedAt: addDays(NOW, -20), expiresAt: addDays(NOW, 40), purgeAt: addMonths(addDays(NOW, 40), 12) });

  it("pauses with the owner reason by default, or the quota reason", () => {
    const owner = transition(live, "paused", ctx);
    expect(owner.patch).toMatchObject({ status: "paused", pausedReason: "owner" });
    expect(owner.effects).toMatchObject({ search: "delete", audit: "listing.pause", contentOp: { op: "listing.update" } });
    expect(transition(live, "paused", { ...ctx, pausedReason: "quota" }).patch.pausedReason).toBe("quota");
    // Pause keeps the dates (D16).
    expect(owner.patch.expiresAt).toBeUndefined();
  });

  it("resumes a paused listing before expiry, keeping its dates; refuses after expiry", () => {
    const paused = listing("paused", { pausedReason: "owner", publishedAt: addDays(NOW, -20), expiresAt: addDays(NOW, 40) });
    const { patch, effects } = transition(paused, "published", ctx);
    expect(patch).toEqual({ version: 4, updatedAt: NOW, status: "published", pausedReason: null });
    expect(effects).toMatchObject({ search: "upsert", audit: "listing.resume" });
    const stale = listing("paused", { pausedReason: "owner", expiresAt: addDays(NOW, -1) });
    expect(() => transition(stale, "published", ctx)).toThrow(/expired/);
    expect(() => transition(listing("paused"), "published", ctx)).toThrow(IllegalTransitionError);
  });

  it("marks sold: purge clock from now, expiresAt untouched, off the index", () => {
    const { patch, effects } = transition(live, "sold", ctx);
    expect(patch).toMatchObject({ status: "sold", purgeAt: addMonths(NOW, 12) });
    expect(patch.expiresAt).toBeUndefined();
    expect(effects).toMatchObject({ search: "delete", audit: "listing.sold", contentOp: { op: "listing.update" } });
    expect(transition(listing("paused", { pausedReason: "owner" }), "sold", ctx).patch.status).toBe("sold");
  });

  it("removes with the LCEN entry; a removed draft needs no index or page work", () => {
    const published = transition(live, "removed", ctx);
    expect(published.patch).toMatchObject({ status: "removed", purgeAt: addMonths(NOW, 12) });
    expect(published.effects).toEqual({ search: "delete", contentOp: { op: "listing.remove", ip: "41.250.1.2" }, audit: "listing.remove", revalidate: true, mail: null });
    const draft = transition(listing("draft"), "removed", ctx);
    expect(draft.effects).toMatchObject({ search: null, revalidate: false, contentOp: { op: "listing.remove" } });
  });

  it("expires (system) and purges (system)", () => {
    const expired = transition(live, "expired", { now: NOW, lifetime: LIFETIME });
    expect(expired.patch).toMatchObject({ status: "expired", purgeAt: addMonths(NOW, 12) });
    expect(expired.effects).toEqual({ search: "delete", contentOp: null, audit: "listing.expire", revalidate: true, mail: null });
    const purged = transition(listing("removed", { purgeAt: addDays(NOW, -1) }), "purged", { now: NOW, lifetime: LIFETIME });
    expect(purged.patch).toEqual({ version: 4, updatedAt: NOW, status: "purged" });
    expect(purged.effects.audit).toBe("listing.purge");
  });
});

describe("renewal (D16)", () => {
  it("is allowed when expired before purgeAt, or published with fewer than 7 days left", () => {
    expect(canRenew(listing("expired", { purgeAt: addDays(NOW, 100) }), NOW)).toBe(true);
    expect(canRenew(listing("expired", { purgeAt: addDays(NOW, -1) }), NOW)).toBe(false);
    expect(canRenew(listing("expired"), NOW)).toBe(true);
    expect(canRenew(listing("published", { expiresAt: addDays(NOW, RENEW_WINDOW_DAYS - 1) }), NOW)).toBe(true);
    expect(canRenew(listing("published", { expiresAt: addDays(NOW, RENEW_WINDOW_DAYS) }), NOW)).toBe(false);
    expect(canRenew(listing("published", { expiresAt: addDays(NOW, 30) }), NOW)).toBe(false);
    expect(canRenew(listing("published"), NOW)).toBe(false);
    for (const status of ["draft", "paused", "sold", "rejected", "removed", "purged", "pending_review"] as const) {
      expect(canRenew(listing(status, { expiresAt: addDays(NOW, 1), purgeAt: addDays(NOW, 100) }), NOW), status).toBe(false);
    }
  });

  it("puts the listing back on top with a fresh lifetime, sortSource renew, publishedAt untouched", () => {
    const expired = listing("expired", { publishedAt: addDays(NOW, -70), expiresAt: addDays(NOW, -10), purgeAt: addDays(NOW, 355) });
    const { patch, effects } = renew(expired, ctx);
    expect(patch).toEqual({
      version: 4,
      updatedAt: NOW,
      status: "published",
      sortAt: NOW,
      sortSource: "renew",
      expiresAt: addDays(NOW, 60),
      purgeAt: addMonths(addDays(NOW, 60), 12),
      pausedReason: null,
    });
    expect(effects).toEqual({ search: "upsert", contentOp: { op: "listing.update", ip: "41.250.1.2" }, audit: "listing.renew", revalidate: true, mail: null });
    // Same result through the table (expired -> published).
    expect(transition(expired, "published", ctx).patch).toEqual(patch);
    // A published listing in its last week renews in place.
    const soon = listing("published", { publishedAt: addDays(NOW, -55), expiresAt: addDays(NOW, 5) });
    expect(renew(soon, ctx).patch).toMatchObject({ status: "published", sortSource: "renew", expiresAt: addDays(NOW, 60) });
  });

  it("holds an expired listing's renewal for review: back on top, the lapsed expiry dropped, the approval dates the new lifetime", () => {
    const expired = listing("expired", { publishedAt: addDays(NOW, -70), expiresAt: addDays(NOW, -10), purgeAt: addDays(NOW, 355) });
    const { patch, effects } = renewForReview(expired, ctx);
    expect(patch).toEqual({ version: 4, updatedAt: NOW, status: "pending_review", sortAt: NOW, sortSource: "renew", expiresAt: null });
    // What the approval reads: a renewal, published with a new lifetime.
    expect(approvalOutcome({ publishedAt: expired.publishedAt, expiresAt: patch.expiresAt ?? undefined }, NOW)).toEqual({ status: "published", kind: "renewal" });
    expect(effects).toMatchObject({ search: "delete", contentOp: { op: "listing.update" }, audit: "listing.renew", revalidate: true, mail: "listingPendingReview" });
    expect(() => renewForReview(listing("expired", { purgeAt: addDays(NOW, -1) }), ctx)).toThrow(IllegalTransitionError);
    expect(() => renewForReview(listing("published", { expiresAt: addDays(NOW, 2) }), ctx)).toThrow(IllegalTransitionError);
  });

  it("refuses a renewal outside the window or after purgeAt", () => {
    expect(() => renew(listing("published", { expiresAt: addDays(NOW, 30) }), ctx)).toThrow(IllegalTransitionError);
    expect(() => renew(listing("expired", { purgeAt: addDays(NOW, -1) }), ctx)).toThrow(IllegalTransitionError);
    expect(() => transition(listing("expired", { purgeAt: addDays(NOW, -1) }), "published", ctx)).toThrow(/purgeable/);
    expect(() => renew(listing("paused", { pausedReason: "owner", expiresAt: addDays(NOW, 2) }), ctx)).toThrow(IllegalTransitionError);
  });
});

describe("dates", () => {
  it("computes expiry and purge from the legal lifetime, month arithmetic in UTC", () => {
    expect(expiresAtFor(new Date("2026-01-31T12:00:00.000Z"), LIFETIME)).toEqual(new Date("2026-04-01T12:00:00.000Z"));
    expect(purgeAtFor(new Date("2026-04-01T12:00:00.000Z"), LIFETIME)).toEqual(new Date("2027-04-01T12:00:00.000Z"));
    expect(addMonths(new Date("2026-01-31T00:00:00.000Z"), 1)).toEqual(new Date("2026-03-03T00:00:00.000Z"));
    expect(expiresAtFor(NOW, { ttlDays: 30, purgeMonths: 6 })).toEqual(addDays(NOW, 30));
    expect(purgeAtFor(NOW, { ttlDays: 30, purgeMonths: 6 })).toEqual(new Date("2027-04-16T10:00:00.000Z"));
  });
});
