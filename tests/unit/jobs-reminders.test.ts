import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingRecord } from "@/lib/db/repositories/listings";
import type { ReminderCursor } from "@/lib/db/repositories/retention";

// listing-expiry-reminders (02:40 UTC, design D16): one listingExpiringSoon mail (bulk) per
// published listing expiring on the UTC day three days ahead, at most once: the cursor in
// system/listingReminders moves before a page's mails are queued, a second run the same day sends
// nothing, a missed night is caught up. Repositories are mocked.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => configured.value, isFirebaseConfigured: () => configured.value, db: vi.fn() }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail/recipients", () => ({
  recipientCache: () => async (uid: string) => (uid === "closed" ? null : { email: `${uid}@example.com`, locale: "fr", displayName: "Salma" }),
  siteUrl: (locale: string, path: string) => `https://joutiya.ma/${locale}/${path}`,
}));
vi.mock("@/lib/db/repositories/retention", () => ({
  listListingsExpiringBetween: vi.fn(),
  readReminderCursor: vi.fn(),
  writeReminderCursor: vi.fn(async () => undefined),
}));

const retention = await import("@/lib/db/repositories/retention");
const { sendMail } = await import("@/lib/mail");
const { REMINDER_BATCH, REMINDER_PAGES, reminderStart, reminderWindow, sendExpiryReminders } = await import("@/worker/jobs/listing-expiry-reminders");

const NOW = new Date("2026-10-16T02:40:00Z");
const START = new Date("2026-10-19T00:00:00Z");
const END = new Date("2026-10-20T00:00:00Z");

function listing(id: string, expiresAt: Date, overrides: Partial<ListingRecord> = {}): ListingRecord {
  return { id, ownerUid: "owner-1", status: "published", title: `Annonce ${id}`, slugId: `velo-casablanca-${id}`, expiresAt, version: 3, ...overrides } as unknown as ListingRecord;
}

function page(listings: ListingRecord[], read = listings.length) {
  const last = listings[listings.length - 1];
  return { listings, read, ...(last ? { next: { at: last.expiresAt!, id: last.id } } : {}) };
}

/** Call order of cursor writes and mails, to check the cursor always moves first. */
let events: string[];

beforeEach(() => {
  configured.value = true;
  events = [];
  vi.mocked(retention.readReminderCursor).mockReset().mockResolvedValue(null);
  vi.mocked(retention.listListingsExpiringBetween).mockReset().mockResolvedValue({ listings: [], read: 0 });
  vi.mocked(retention.writeReminderCursor)
    .mockReset()
    .mockImplementation(async (cursor: ReminderCursor) => {
      events.push(`cursor ${cursor.through.toISOString()} ${cursor.lastId ?? "-"}`);
    });
  vi.mocked(sendMail)
    .mockReset()
    .mockImplementation(async (mail) => {
      events.push(`mail ${String((mail.data as { title: string }).title)}`);
    });
});

describe("reminderWindow", () => {
  it("is the whole UTC day three days ahead, whatever the hour of the run", () => {
    expect(reminderWindow(NOW)).toEqual({ start: START, end: END });
    expect(reminderWindow(new Date("2026-10-16T00:00:00Z"))).toEqual({ start: START, end: END });
    expect(reminderWindow(new Date("2026-10-16T23:59:59.999Z"))).toEqual({ start: START, end: END });
  });

  it("rolls over months and years, and consecutive days tile without gap or overlap", () => {
    expect(reminderWindow(new Date("2026-10-30T02:40:00Z"))).toEqual({ start: new Date("2026-11-02T00:00:00Z"), end: new Date("2026-11-03T00:00:00Z") });
    expect(reminderWindow(new Date("2026-12-30T02:40:00Z")).start).toEqual(new Date("2027-01-02T00:00:00Z"));
    const today = reminderWindow(NOW);
    const tomorrow = reminderWindow(new Date(NOW.getTime() + 86_400_000));
    expect(tomorrow.start).toEqual(today.end);
  });
});

describe("reminderStart", () => {
  it("first run: the window start; normal run: after the stored cursor; a stale cursor: never before now", () => {
    expect(reminderStart(NOW, null)).toEqual({ from: START });
    expect(reminderStart(NOW, { through: START, lastId: null })).toEqual({ from: START });
    const mid = new Date("2026-10-19T09:00:00Z");
    expect(reminderStart(NOW, { through: mid, lastId: "abcd2345" })).toEqual({ from: mid, cursor: { at: mid, id: "abcd2345" } });
    expect(reminderStart(NOW, { through: new Date("2026-10-10T00:00:00Z"), lastId: "old23456" })).toEqual({ from: NOW });
  });
});

describe("sendExpiryReminders", () => {
  it("mails each listing of the window (bulk, public URL, expiry date) and records the window as done before mailing", async () => {
    const a = listing("aaaa2345", new Date("2026-10-19T08:00:00Z"));
    const b = listing("bbbb2345", new Date("2026-10-19T21:00:00Z"));
    vi.mocked(retention.listListingsExpiringBetween).mockResolvedValueOnce(page([a, b]));

    expect(await sendExpiryReminders(NOW)).toEqual({ reminded: 2, skipped: 0, failed: 0 });
    expect(retention.listListingsExpiringBetween).toHaveBeenCalledWith(START, END, REMINDER_BATCH, undefined);
    expect(sendMail).toHaveBeenCalledWith({
      template: "listingExpiringSoon",
      locale: "fr",
      to: "owner-1@example.com",
      data: { displayName: "Salma", title: "Annonce aaaa2345", url: "https://joutiya.ma/fr/annonce/velo-casablanca-aaaa2345", expiresAt: "2026-10-19T08:00:00.000Z" },
      priority: "bulk",
      idempotencyKey: `listingExpiringSoon-aaaa2345-${a.expiresAt!.getTime()}`,
    });
    expect(events).toEqual([`cursor ${END.toISOString()} -`, "mail Annonce aaaa2345", "mail Annonce bbbb2345"]);
  });

  it("a second run the same day sends nothing", async () => {
    vi.mocked(retention.readReminderCursor).mockResolvedValue({ through: END, lastId: null });
    expect(await sendExpiryReminders(new Date("2026-10-16T09:00:00Z"))).toEqual({ reminded: 0, skipped: 0, failed: 0 });
    expect(retention.listListingsExpiringBetween).not.toHaveBeenCalled();
    expect(retention.writeReminderCursor).not.toHaveBeenCalled();
  });

  it("the next day continues from where the previous window ended", async () => {
    vi.mocked(retention.readReminderCursor).mockResolvedValue({ through: END, lastId: null });
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    await sendExpiryReminders(tomorrow);
    expect(retention.listListingsExpiringBetween).toHaveBeenCalledWith(END, new Date("2026-10-21T00:00:00Z"), REMINDER_BATCH, undefined);
  });

  it("catches up a missed night: listings expiring sooner are reminded late, once", async () => {
    // Last successful run on the 14th: it covered expiries up to the 18th.
    vi.mocked(retention.readReminderCursor).mockResolvedValue({ through: new Date("2026-10-18T00:00:00Z"), lastId: null });
    await sendExpiryReminders(NOW);
    expect(retention.listListingsExpiringBetween).toHaveBeenCalledWith(new Date("2026-10-18T00:00:00Z"), END, REMINDER_BATCH, undefined);
  });

  it("pages with a progress cursor written before each page's mails; a capped run resumes after the last page", async () => {
    const full = (prefix: string) => Array.from({ length: REMINDER_BATCH }, (_, index) => listing(`${prefix}${String(index).padStart(6, "0")}`, new Date(START.getTime() + index * 1000)));
    vi.mocked(retention.listListingsExpiringBetween).mockImplementation(async () => page(full("pp")));
    const result = await sendExpiryReminders(NOW);
    expect(result.reminded).toBe(REMINDER_BATCH * REMINDER_PAGES);
    expect(retention.listListingsExpiringBetween).toHaveBeenCalledTimes(REMINDER_PAGES);
    const cursors = vi.mocked(retention.writeReminderCursor).mock.calls.map(([cursor]) => cursor);
    expect(cursors).toHaveLength(REMINDER_PAGES);
    // Never marked done: the next run resumes at the last page's position.
    expect(cursors.every((cursor) => cursor.lastId !== null)).toBe(true);
    expect(events[0]).toMatch(/^cursor /);
    expect(events[1]).toMatch(/^mail /);
  });

  it("a resumed run passes the stored position to the query", async () => {
    const mid = new Date("2026-10-19T09:00:00Z");
    vi.mocked(retention.readReminderCursor).mockResolvedValue({ through: mid, lastId: "abcd2345" });
    await sendExpiryReminders(NOW);
    expect(retention.listListingsExpiringBetween).toHaveBeenCalledWith(mid, END, REMINDER_BATCH, { at: mid, id: "abcd2345" });
  });

  it("skips sellers without address and counts mail failures without retrying them", async () => {
    const a = listing("aaaa2345", new Date("2026-10-19T08:00:00Z"), { ownerUid: "closed" });
    const b = listing("bbbb2345", new Date("2026-10-19T09:00:00Z"));
    const c = listing("cccc2345", new Date("2026-10-19T10:00:00Z"));
    vi.mocked(retention.listListingsExpiringBetween).mockResolvedValueOnce(page([a, b, c]));
    vi.mocked(sendMail).mockRejectedValueOnce(new Error("queue down"));
    expect(await sendExpiryReminders(NOW)).toEqual({ reminded: 1, skipped: 1, failed: 1 });
  });

  it("falls back to Mes annonces when a listing has no slug, and does nothing without Firebase", async () => {
    vi.mocked(retention.listListingsExpiringBetween).mockResolvedValueOnce(page([listing("noslug23", new Date("2026-10-19T08:00:00Z"), { slugId: undefined })]));
    await sendExpiryReminders(NOW);
    expect(vi.mocked(sendMail).mock.calls[0]?.[0].data).toMatchObject({ url: "https://joutiya.ma/fr/mes-annonces" });
    configured.value = false;
    vi.mocked(retention.readReminderCursor).mockClear();
    expect(await sendExpiryReminders(NOW)).toEqual({ reminded: 0, skipped: 0, failed: 0 });
    expect(retention.readReminderCursor).not.toHaveBeenCalled();
  });
});
