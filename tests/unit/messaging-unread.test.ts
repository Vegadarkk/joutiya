import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cidSchema } from "@/lib/contracts/messaging";
import { conversationId } from "@/lib/messaging/ids";
import {
  DIGEST_DELAY_MS,
  MESSAGING_KEYS,
  RISK_WINDOW_MS,
  SEEN_TTL_SECONDS,
  UNREAD_TTL_MS,
  UnreadUnavailableError,
  clearUnread,
  markSeen,
  recordRiskyMessage,
  recordUnread,
  scheduleDigest,
  setMessagingValkeyForTests,
  unreadTotal,
} from "@/lib/messaging/unread";
import { FakeValkey } from "./messaging-fake-valkey";

// Messaging state in valkey-queue (design D3, D5, D21): the unread badge hash trusted only behind
// its init marker and rebuilt from Firestore otherwise (a stale rebuild is dropped), the activity
// marker, the digest queue and the repeat-risk rule. Valkey missing or failing never fails a send.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const T0 = 1_760_000_000_000;
let clock = T0;
let valkey: FakeValkey;

beforeEach(() => {
  clock = T0;
  valkey = new FakeValkey(() => clock);
  setMessagingValkeyForTests(valkey.asClient());
});

afterEach(() => setMessagingValkeyForTests(undefined));

describe("conversationId", () => {
  it("is deterministic, 22 base64url characters, distinct per listing and buyer", () => {
    const cid = conversationId("abcd2345", "buyer-1");
    expect(cid).toBe(conversationId("abcd2345", "buyer-1"));
    expect(cidSchema.safeParse(cid).success).toBe(true);
    expect(conversationId("abcd2345", "buyer-2")).not.toBe(cid);
    expect(conversationId("abcd2346", "buyer-1")).not.toBe(cid);
    // No uid or listing id in clear in the URL.
    expect(cid).not.toContain("buyer");
  });
});

describe("unread badge", () => {
  it("rebuilds from Firestore once, then answers from the hash", async () => {
    const load = vi.fn(async () => ({ c1: 2, c2: 3 }));
    expect(await unreadTotal("u1", load)).toBe(5);
    expect(await unreadTotal("u1", load)).toBe(5);
    expect(load).toHaveBeenCalledTimes(1);
    expect(valkey.ttlMs(MESSAGING_KEYS.unreadInit("u1"))).toBe(UNREAD_TTL_MS);
    expect(await valkey.hgetall(MESSAGING_KEYS.unread("u1"))).toEqual({ c1: "2", c2: "3" });
  });

  it("counts new messages and forgets read conversations once trusted", async () => {
    expect(await recordUnread("u1", "c1")).toBeNull();
    // The rebuild replaces whatever an untrusted hash held.
    expect(await unreadTotal("u1", async () => ({ c1: 1 }))).toBe(1);
    expect(await recordUnread("u1", "c1")).toBe(2);
    expect(await recordUnread("u1", "c2")).toBe(3);
    // The new total rides the live stream (D2): null while the hash is not trusted.
    expect(await clearUnread("u1", "c1")).toBe(1);
    expect(await unreadTotal("u1", async () => ({}))).toBe(1);
    expect(await clearUnread("u1", "c2")).toBe(0);
    expect(await unreadTotal("u1", async () => ({ c9: 9 }))).toBe(0);
    expect(await clearUnread("u9", "c1")).toBeNull();
  });

  it("drops a rebuild that raced with a new message (version check), so the next read rebuilds again", async () => {
    const total = await unreadTotal("u2", async () => {
      await recordUnread("u2", "cx");
      return { cy: 1 };
    });
    expect(total).toBe(1);
    expect(await valkey.exists(MESSAGING_KEYS.unreadInit("u2"))).toBe(0);
    expect(await unreadTotal("u2", async () => ({ cx: 1, cy: 1 }))).toBe(2);
  });

  it("caches an empty inbox too (marker without hash)", async () => {
    const load = vi.fn(async () => ({}));
    expect(await unreadTotal("u3", load)).toBe(0);
    expect(await unreadTotal("u3", load)).toBe(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await recordUnread("u3", "c1")).toBe(1);
  });

  it("expires with its marker after 30 days without activity", async () => {
    await unreadTotal("u4", async () => ({ c1: 1 }));
    clock += UNREAD_TTL_MS + 1;
    const load = vi.fn(async () => ({ c1: 4 }));
    expect(await unreadTotal("u4", load)).toBe(4);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reads Firestore every time without Valkey (dev), and throws when Valkey fails", async () => {
    setMessagingValkeyForTests(null);
    const load = vi.fn(async () => ({ c1: 1, c2: 2 }));
    expect(await unreadTotal("u5", load)).toBe(3);
    expect(await unreadTotal("u5", load)).toBe(3);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await recordUnread("u5", "c1")).toBeNull();

    setMessagingValkeyForTests(valkey.asClient());
    valkey.failing = true;
    await expect(unreadTotal("u5", load)).rejects.toBeInstanceOf(UnreadUnavailableError);
    expect(load).toHaveBeenCalledTimes(2);
    // Writes are best effort.
    expect(await recordUnread("u5", "c1")).toBeNull();
    expect(await clearUnread("u5", "c1")).toBeNull();
    await expect(markSeen("u5")).resolves.toBeUndefined();
    expect(await scheduleDigest("u5")).toBe(false);
    expect(await recordRiskyMessage("u5", "c/m")).toBe(false);
  });
});

describe("activity and digest", () => {
  it("marks the account as seen for 30 minutes", async () => {
    await markSeen("u1");
    expect(valkey.ttlMs(MESSAGING_KEYS.seen("u1"))).toBe(SEEN_TTL_SECONDS * 1000);
  });

  it("queues the digest 30 minutes after the first unread message, NX", async () => {
    expect(await scheduleDigest("u1", new Date(T0))).toBe(true);
    expect(await scheduleDigest("u1", new Date(T0 + 60_000))).toBe(false);
    expect(await valkey.zscore(MESSAGING_KEYS.digest, "u1")).toBe(String(T0 + DIGEST_DELAY_MS));
  });
});

describe("repeat-risk rule", () => {
  it("fires once when 3 flagged messages in 24 h span 2 conversations", async () => {
    const now = new Date(T0);
    expect(await recordRiskyMessage("s1", "ca/m1", now)).toBe(false);
    expect(await recordRiskyMessage("s1", "ca/m2", now)).toBe(false);
    expect(await recordRiskyMessage("s1", "ca/m3", now)).toBe(false);
    expect(await recordRiskyMessage("s1", "cb/m4", now)).toBe(true);
    expect(await recordRiskyMessage("s1", "cc/m5", now)).toBe(false);
    expect(valkey.ttlMs(MESSAGING_KEYS.riskReported("s1"))).toBe(RISK_WINDOW_MS);
  });

  it("forgets flagged messages older than 24 h and may fire again the next day", async () => {
    expect(await recordRiskyMessage("s2", "ca/m1", new Date(T0))).toBe(false);
    expect(await recordRiskyMessage("s2", "cb/m2", new Date(T0))).toBe(false);
    clock = T0 + RISK_WINDOW_MS + 1;
    expect(await recordRiskyMessage("s2", "cc/m3", new Date(clock))).toBe(false);
    expect(await recordRiskyMessage("s2", "cc/m4", new Date(clock))).toBe(false);
    expect(await recordRiskyMessage("s2", "cd/m5", new Date(clock))).toBe(true);
  });
});
