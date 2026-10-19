import { beforeEach, describe, expect, it, vi } from "vitest";
import { DigestValkeyFake } from "./jobs-phase5-fake-valkey";

// message-digest (design D21, every 10 minutes): the accounts queued by scheduleDigest (ZADD NX
// `msg:digest`, due 30 minutes later) get one grouped `newMessages` mail (bulk), unless they read
// everything, were active in the last 30 minutes, got a digest less than 6 hours ago (put back
// until then), turned the mail off, or have no address; at most DIGEST_MAX_MAILS a run, within
// the digests' share of the Resend quotas. Firestore and the mail queue are mocked; Valkey is the
// messaging tests' in-memory fake with the commands of this job.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/quota", () => ({ isDegraded: vi.fn(async () => false), headroom: vi.fn(async () => null), consume: vi.fn(async () => ({ level: "ok" })) }));
const firebase = { configured: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => firebase.configured, isFirebaseConfigured: () => firebase.configured, db: vi.fn() }));
vi.mock("@/lib/valkey/clients", () => ({ isValkeyConfigured: () => false, valkey: vi.fn() }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/db/repositories/profiles", () => ({ getUserRecord: vi.fn() }));
vi.mock("@/lib/db/repositories/users", () => ({ getUserPrivate: vi.fn() }));
vi.mock("@/lib/messaging", async () => {
  const unread = await import("@/lib/messaging/unread");
  return { MESSAGING_KEYS: unread.MESSAGING_KEYS, scheduleDigest: unread.scheduleDigest, readUnreadTotal: vi.fn(), unreadSummary: vi.fn() };
});

const { isDegraded, headroom } = await import("@/lib/quota");
const { sendMail } = await import("@/lib/mail");
const { getUserRecord } = await import("@/lib/db/repositories/profiles");
const { getUserPrivate } = await import("@/lib/db/repositories/users");
const { MESSAGING_KEYS, readUnreadTotal, unreadSummary, scheduleDigest } = await import("@/lib/messaging");
const { setMessagingValkeyForTests } = await import("@/lib/messaging/unread");
const { DIGEST_GUARD_SECONDS, DIGEST_MAX_MAILS, DIGEST_RESEND_SHARE, parseDue, sendMessageDigests } = await import("@/worker/jobs/message-digest");

const T0 = Date.parse("2026-10-16T12:00:00Z");
const MIN = 60_000;
let clock = T0;

let redis: DigestValkeyFake;
const run = () => sendMessageDigests(new Date(clock), { valkey: redis as never });

function account(uid: string, overrides: { status?: string; email?: string | null; messagesEmail?: boolean; locale?: string } = {}) {
  vi.mocked(getUserRecord).mockImplementation(async (id) =>
    id === uid ? ({ uid, displayName: "Nadia", locale: overrides.locale ?? "fr", status: overrides.status ?? "active" } as never) : null,
  );
  vi.mocked(getUserPrivate).mockImplementation(async (id) =>
    id === uid
      ? ({ ...(overrides.email === null ? {} : { email: overrides.email ?? "nadia@example.com" }), ...(overrides.messagesEmail === undefined ? {} : { notifications: { messagesEmail: overrides.messagesEmail } }) } as never)
      : null,
  );
}

/** Queues `uid` the way a send does (scheduleDigest at `at`): due 30 minutes later. */
async function queue(uid: string, at = clock - 31 * MIN): Promise<void> {
  expect(await scheduleDigest(uid, new Date(at))).toBe(true);
}

beforeEach(() => {
  clock = T0;
  redis = new DigestValkeyFake(() => clock);
  setMessagingValkeyForTests(redis.asClient());
  firebase.configured = true;
  vi.mocked(isDegraded).mockReset().mockResolvedValue(false);
  vi.mocked(headroom).mockReset().mockResolvedValue(null);
  vi.mocked(sendMail).mockReset().mockResolvedValue(undefined);
  vi.mocked(readUnreadTotal).mockReset().mockResolvedValue(2);
  vi.mocked(unreadSummary)
    .mockReset()
    .mockResolvedValue({
      total: 4,
      items: [
        { cid: "c1", listingTitle: "Vélo de ville", counterpartName: "Karim", unread: 2 },
        { cid: "c2", listingTitle: "Table basse", counterpartName: "Salma", unread: 1 },
        { cid: "c3", listingTitle: "Lampe", counterpartName: "Omar", unread: 1 },
      ],
    });
  account("u1");
});

describe("parseDue", () => {
  it("reads a WITHSCORES reply and ignores a malformed score", () => {
    expect(parseDue(["u1", "100", "u2", "nope", "u3", "300"])).toEqual([
      { uid: "u1", dueAt: 100 },
      { uid: "u3", dueAt: 300 },
    ]);
    expect(parseDue(null)).toEqual([]);
  });
});

describe("message-digest", () => {
  it("sends one bulk newMessages mail with the count and up to 3 conversations, then sets the 6-hour guard", async () => {
    await queue("u1");
    const result = await run();
    expect(result).toMatchObject({ due: 1, sent: 1, failed: 0 });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = vi.mocked(sendMail).mock.calls[0]![0];
    expect(mail).toMatchObject({ template: "newMessages", locale: "fr", to: "nadia@example.com", priority: "bulk" });
    expect(mail.data).toEqual({
      displayName: "Nadia",
      count: 4,
      conversations: [
        { listingTitle: "Vélo de ville", counterpartName: "Karim" },
        { listingTitle: "Table basse", counterpartName: "Salma" },
        { listingTitle: "Lampe", counterpartName: "Omar" },
      ],
    });
    expect(mail.idempotencyKey).toMatch(/^newMessages-u1-\d+$/);
    expect(redis.score("u1")).toBeUndefined();
    expect(redis.ttlMs(MESSAGING_KEYS.digestLast("u1"))).toBe(DIGEST_GUARD_SECONDS * 1000);
    // Nothing due any more: a second run sends nothing.
    expect(await run()).toMatchObject({ due: 0, sent: 0 });
  });

  it("waits for the due time (30 minutes after the first unread message)", async () => {
    await queue("u1", clock - 10 * MIN);
    expect(await run()).toMatchObject({ due: 0, sent: 0 });
    expect(redis.score("u1")).toBe(clock + 20 * MIN);
    clock += 21 * MIN;
    expect(await run()).toMatchObject({ due: 1, sent: 1 });
  });

  it("drops the account when it was active in the last 30 minutes, or read everything", async () => {
    await queue("u1");
    await redis.set(MESSAGING_KEYS.seen("u1"), "1", "EX", 1800);
    expect(await run()).toMatchObject({ due: 1, active: 1, sent: 0 });
    expect(redis.score("u1")).toBeUndefined();

    await queue("u2");
    account("u2");
    vi.mocked(readUnreadTotal).mockResolvedValueOnce(0);
    expect(await run()).toMatchObject({ read: 1, sent: 0 });
    expect(unreadSummary).not.toHaveBeenCalled();
    expect(redis.score("u2")).toBeUndefined();

    // The Valkey badge lags: the Firestore summary has the last word.
    await queue("u3");
    account("u3");
    vi.mocked(unreadSummary).mockResolvedValueOnce({ total: 0, items: [] });
    expect(await run()).toMatchObject({ read: 1, sent: 0 });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("puts the account back until the 6-hour guard ends, then sends if messages are still unread", async () => {
    await queue("u1");
    await redis.set(MESSAGING_KEYS.digestLast("u1"), "1", "EX", 2 * 3600);
    expect(await run()).toMatchObject({ due: 1, rescheduled: 1, sent: 0 });
    expect(redis.score("u1")).toBe(clock + 2 * 3600 * 1000);
    clock += 2 * 3600 * 1000 + MIN;
    expect(await run()).toMatchObject({ due: 1, sent: 1 });
  });

  it("respects the account's choice and skips closed, banned or unreachable accounts", async () => {
    await queue("u1");
    account("u1", { messagesEmail: false });
    expect(await run()).toMatchObject({ optedOut: 1, sent: 0 });
    expect(redis.score("u1")).toBeUndefined();

    for (const overrides of [{ status: "closed" }, { status: "banned" }, { email: null }]) {
      await queue("u1");
      account("u1", overrides);
      expect(await run()).toMatchObject({ noRecipient: 1, sent: 0 });
    }
    // A suspended member still reads his conversations (D9): the mail goes.
    await queue("u1");
    account("u1", { status: "suspended", messagesEmail: true, locale: "ar" });
    expect(await run()).toMatchObject({ sent: 1 });
    expect(vi.mocked(sendMail).mock.calls[0]![0]).toMatchObject({ locale: "ar" });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("drops an entry due for more than a day without a mail", async () => {
    await queue("u1", clock - 26 * 3600 * 1000);
    expect(await run()).toMatchObject({ stale: 1, sent: 0 });
    expect(redis.score("u1")).toBeUndefined();
  });

  it("keeps the entry and lifts the guard when the mail cannot be queued", async () => {
    await queue("u1");
    vi.mocked(sendMail).mockRejectedValueOnce(new Error("queue down"));
    expect(await run()).toMatchObject({ failed: 1, sent: 0 });
    expect(redis.score("u1")).toBeDefined();
    expect(await redis.exists(MESSAGING_KEYS.digestLast("u1"))).toBe(0);
    expect(await run()).toMatchObject({ sent: 1 });
  });

  it("stops without touching the queue while a Resend or read quota is degraded, or the digests' share is used", async () => {
    await queue("u1");
    vi.mocked(isDegraded).mockImplementation(async (id) => id === "resend.daily");
    expect(await run()).toMatchObject({ stopped: "quota", due: 0 });
    vi.mocked(isDegraded).mockResolvedValue(false);
    vi.mocked(headroom).mockResolvedValue(0);
    expect(await run()).toMatchObject({ stopped: "budget", due: 0 });
    expect(headroom).toHaveBeenCalledWith("resend.daily", DIGEST_RESEND_SHARE);
    expect(headroom).toHaveBeenCalledWith("resend.monthly", DIGEST_RESEND_SHARE);
    expect(redis.score("u1")).toBeDefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends at most DIGEST_MAX_MAILS a run (or the quota headroom), oldest due first; the rest waits", async () => {
    vi.mocked(getUserRecord).mockImplementation(async (uid) => ({ uid, displayName: "Nadia", locale: "fr", status: "active" }) as never);
    vi.mocked(getUserPrivate).mockImplementation(async () => ({ email: "nadia@example.com" }) as never);
    for (let index = 0; index < DIGEST_MAX_MAILS + 5; index += 1) await queue(`u${String(index).padStart(2, "0")}`, clock - 40 * MIN + index * 1000);
    expect(await run()).toMatchObject({ sent: DIGEST_MAX_MAILS, stopped: "budget" });
    expect(redis.score("u00")).toBeUndefined();
    expect(redis.score(`u${DIGEST_MAX_MAILS + 4}`)).toBeDefined();
    vi.mocked(headroom).mockResolvedValue(3);
    expect(await run()).toMatchObject({ sent: 3 });
  });

  it("does nothing without Valkey or Firebase, and stops when Valkey fails", async () => {
    expect(await sendMessageDigests(new Date(clock), { valkey: null })).toMatchObject({ due: 0, sent: 0 });
    await queue("u1");
    firebase.configured = false;
    expect(await run()).toMatchObject({ due: 0, sent: 0 });
    firebase.configured = true;
    redis.failing = true;
    expect(await run()).toMatchObject({ stopped: "valkey", sent: 0 });
    expect(sendMail).not.toHaveBeenCalled();
  });
});
