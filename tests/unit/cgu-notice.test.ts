import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserRecord } from "@/lib/db/repositories/profiles";
import type { CguNoticeCursor } from "@/lib/db/repositories/users";

// CGU change notice (phase 6, D11): the banner's version check and the nightly cgu-notice job, which
// mails members who accepted an earlier version, once per version, within its mail budget.
// Repositories, quotas and the mail queue are mocked.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => true, isFirebaseConfigured: () => true, db: vi.fn() }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
const degraded = { value: false };
/** Resend headroom under the job's share (null: counter unreadable, the cap applies). */
const room = { value: null as number | null };
vi.mock("@/lib/quota", () => ({ isDegraded: vi.fn(async () => degraded.value), headroom: vi.fn(async () => room.value), consume: vi.fn() }));
vi.mock("@/lib/db/repositories/profiles", () => ({ listUserRecordsAfter: vi.fn() }));
vi.mock("@/lib/db/repositories/users", () => ({ getUserPrivate: vi.fn(), readCguNoticeCursor: vi.fn(), writeCguNoticeCursor: vi.fn(async () => undefined) }));

const { cguAccepted, LEGAL_VERSIONS } = await import("@/config/legal-versions");
const profiles = await import("@/lib/db/repositories/profiles");
const users = await import("@/lib/db/repositories/users");
const { sendMail } = await import("@/lib/mail");
const { CGU_NOTICE_MAX_MAILS, CGU_NOTICE_PAGE_SIZE, sendCguNotices } = await import("@/worker/jobs/cgu-notice");

const CURRENT = LEGAL_VERSIONS.cgu.version;

function user(uid: string, overrides: Partial<UserRecord> = {}): UserRecord {
  return { uid, displayName: `Membre ${uid}`, locale: "fr", status: "active", activation: "done", ...overrides } as unknown as UserRecord;
}

/** Stored CGU version per uid (missing uid: no private document). */
let accepted: Record<string, string>;
let pages: UserRecord[][];

beforeEach(() => {
  degraded.value = false;
  room.value = null;
  accepted = {};
  pages = [];
  vi.mocked(sendMail).mockReset();
  vi.mocked(users.writeCguNoticeCursor).mockReset();
  vi.mocked(users.readCguNoticeCursor).mockReset().mockResolvedValue({ version: "0.9", lastUid: null, done: true });
  vi.mocked(users.getUserPrivate)
    .mockReset()
    .mockImplementation(async (uid: string) => (uid in accepted ? ({ email: `${uid}@example.com`, consents: { cgu: { version: accepted[uid], at: new Date() } } } as never) : null));
  vi.mocked(profiles.listUserRecordsAfter)
    .mockReset()
    .mockImplementation(async (after: string | null, limit: number) => {
      const all = pages.flat();
      const start = after ? all.findIndex((entry) => entry.uid === after) + 1 : 0;
      const slice = all.slice(start, start + limit);
      return { users: slice, read: slice.length, lastUid: slice.at(-1)?.uid ?? null };
    });
});

describe("cguAccepted", () => {
  it("accepts the current version and the ones it replaces, nothing else", () => {
    expect(cguAccepted(CURRENT)).toBe(true);
    for (const replaced of LEGAL_VERSIONS.cgu.replaces ?? []) expect(cguAccepted(replaced)).toBe(true);
    expect(cguAccepted("0.9")).toBe(false);
    expect(cguAccepted(undefined)).toBe(false);
  });
});

describe("cgu-notice job", () => {
  it("mails active members who accepted an earlier version, once per version, and marks the version done", async () => {
    pages = [[user("a"), user("b"), user("c", { status: "closed" }), user("d", { activation: "pending" }), user("e")]];
    accepted = { a: "0.9", b: CURRENT, c: "0.9", d: "0.9" };
    const result = await sendCguNotices(new Date("2026-12-01T09:40:00Z"));
    expect(result).toMatchObject({ version: CURRENT, visited: 5, mails: 1, complete: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMail).mock.calls[0]![0]).toMatchObject({
      template: "cguChanged",
      to: "a@example.com",
      priority: "bulk",
      idempotencyKey: `cguChanged-${CURRENT}-a`,
      data: { version: CURRENT, effective: LEGAL_VERSIONS.cgu.effective },
    });
    expect(users.writeCguNoticeCursor).toHaveBeenLastCalledWith({ version: CURRENT, lastUid: "e", done: true }, expect.any(Date));
  });

  it("does nothing once the current version is done; a first run only records it", async () => {
    vi.mocked(users.readCguNoticeCursor).mockResolvedValue({ version: CURRENT, lastUid: null, done: true });
    expect(await sendCguNotices()).toMatchObject({ complete: true, visited: 0 });
    expect(profiles.listUserRecordsAfter).not.toHaveBeenCalled();

    vi.mocked(users.readCguNoticeCursor).mockResolvedValue(null);
    expect(await sendCguNotices()).toMatchObject({ complete: true, visited: 0 });
    expect(users.writeCguNoticeCursor).toHaveBeenLastCalledWith({ version: CURRENT, lastUid: null, done: true }, expect.any(Date));
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("stops at the mail budget and resumes after the last account visited", async () => {
    const many = Array.from({ length: CGU_NOTICE_MAX_MAILS + 5 }, (_, index) => user(`u${String(index).padStart(3, "0")}`));
    pages = [many];
    accepted = Object.fromEntries(many.map((entry) => [entry.uid, "0.9"]));
    const first = await sendCguNotices();
    expect(first).toMatchObject({ mails: CGU_NOTICE_MAX_MAILS, stopped: "cap", complete: false });
    const cursor = vi.mocked(users.writeCguNoticeCursor).mock.lastCall![0] as CguNoticeCursor;
    expect(cursor).toEqual({ version: CURRENT, lastUid: many[CGU_NOTICE_MAX_MAILS - 1]!.uid, done: false });

    vi.mocked(users.readCguNoticeCursor).mockResolvedValue(cursor);
    const second = await sendCguNotices();
    expect(second).toMatchObject({ mails: 5, complete: true });
    expect(vi.mocked(sendMail).mock.calls.map(([mail]) => mail.to)).toEqual(many.map((entry) => `${entry.uid}@example.com`));
  });

  it("sends no more than the Resend headroom left by the other mails", async () => {
    room.value = 2;
    pages = [[user("a"), user("b"), user("c")]];
    accepted = { a: "0.9", b: "0.9", c: "0.9" };
    expect(await sendCguNotices()).toMatchObject({ mails: 2, stopped: "cap", complete: false });
    expect(users.writeCguNoticeCursor).toHaveBeenLastCalledWith({ version: CURRENT, lastUid: "b", done: false }, expect.any(Date));
  });

  it("sends nothing while a Resend quota is degraded, and keeps its place", async () => {
    degraded.value = true;
    pages = [[user("a"), user("b")]];
    accepted = { a: CURRENT, b: "0.9" };
    expect(await sendCguNotices()).toMatchObject({ mails: 0, stopped: "quota", complete: false });
    expect(sendMail).not.toHaveBeenCalled();
    expect(users.writeCguNoticeCursor).toHaveBeenLastCalledWith({ version: CURRENT, lastUid: "a", done: false }, expect.any(Date));
  });

  it("walks several pages", async () => {
    pages = [Array.from({ length: CGU_NOTICE_PAGE_SIZE + 3 }, (_, index) => user(`p${String(index).padStart(3, "0")}`))];
    accepted = { p000: "0.9", [`p${CGU_NOTICE_PAGE_SIZE + 2}`]: "0.9" };
    expect(await sendCguNotices()).toMatchObject({ visited: CGU_NOTICE_PAGE_SIZE + 3, mails: 2, complete: true });
  });
});
