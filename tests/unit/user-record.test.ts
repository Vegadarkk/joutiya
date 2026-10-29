import { beforeEach, describe, expect, it, vi } from "vitest";

// parseUserRecord (src/lib/db/repositories/profiles.ts): a negative stats counter is read as 0
// instead of hiding the whole account ("account record missing", staging 28 Oct); any other
// mismatch is logged with field paths only.

const error = vi.hoisted(() => vi.fn());
vi.mock("@/lib/firebase/admin", () => ({ db: vi.fn() }));
vi.mock("@/lib/logging/logger", () => ({ logger: { error, warn: vi.fn(), info: vi.fn() } }));

import { parseUserRecord } from "@/lib/db/repositories/profiles";

const NOW = new Date("2026-10-28T19:54:00.000Z");

function raw(stats: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publicId: "abcdefgh23",
    displayName: "Vendeur Test",
    type: "individual",
    badges: { emailVerified: true, phoneVerified: false, proCertified: false },
    stats: { activeListings: 0, responseRate: 0, medianReplyMin: 0, ratingCount: 0, ...stats },
    status: "active",
    activation: "done",
    locale: "fr",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("parseUserRecord", () => {
  beforeEach(() => error.mockClear());

  it("returns the record with its uid", () => {
    expect(parseUserRecord("uid-a", raw())).toMatchObject({ uid: "uid-a", displayName: "Vendeur Test" });
  });

  it("returns null for a missing document", () => {
    expect(parseUserRecord("uid-a", undefined)).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("reads negative counters as 0 instead of dropping the account", () => {
    const user = parseUserRecord("uid-a", raw({ activeListings: -1, ratingCount: -2, ratingSum: -3, medianReplyMin: -4 }));
    expect(user?.stats).toMatchObject({ activeListings: 0, ratingCount: 0, ratingSum: 0, medianReplyMin: 0 });
    expect(error).not.toHaveBeenCalled();
  });

  it("logs the failing field paths, never the values, for any other mismatch", () => {
    expect(parseUserRecord("uid-a", { ...raw(), displayName: "x" })).toBeNull();
    expect(error).toHaveBeenCalledWith({ uid: "uid-a", fields: ["displayName"] }, "user record invalid");
  });
});
