import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerEnv } from "@/lib/env";
import type { TemplateMail } from "@/lib/mail/types";
import type { AlertSearchRecord, DailySearchPage } from "@/lib/saved-searches/repository";
import type { SearchCard, SearchResponse } from "@/lib/search/types";

// saved-search-alerts (07:00 UTC, design D19): one bulk digest per account with news, at most 40
// a run, account groups kept whole across collection-group pages, rotation through the stored
// cursor (after the last account served, then wrap), stop on degraded quota or engine outage,
// exact matches only. Repositories, engine and mail are mocked; the token is the real one.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => configured.value, isFirebaseConfigured: () => configured.value, db: vi.fn() }));
const degraded = new Set<string>();
vi.mock("@/lib/quota", () => ({ isDegraded: vi.fn(async (id: string) => degraded.has(id)), consume: vi.fn() }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail/recipients", () => ({
  listingRecipient: vi.fn(async (uid: string) => (uid.startsWith("closed") ? null : { email: `${uid}@example.com`, locale: uid.startsWith("ar") ? "ar" : "fr", displayName: `Nom ${uid}` })),
  siteUrl: (locale: string, path: string) => `https://joutiya.ma/${locale}/${path.replace(/^\//, "")}`,
}));

/** The daily searches, in collection-group path order; the repository mock pages through them. */
let store: AlertSearchRecord[];
/** New listings per search id (any sortAt; the engine mock applies the cursor filter). */
let listings: Map<string, SearchCard[]>;
let cursor: string | null;
let approximateFor: Set<string>;

const pathOf = (search: AlertSearchRecord) => `users/${search.uid}/savedSearches/${search.id}`;

vi.mock("@/lib/saved-searches/repository", () => ({
  accountEndPath: (uid: string) => `users/${uid}/savedSearches/`,
  listDailySearches: vi.fn(async (options: { afterPath?: string; endAtPath?: string; limit: number }): Promise<DailySearchPage> => {
    const rows = store.filter((search) => (!options.afterPath || pathOf(search) > options.afterPath) && (!options.endAtPath || pathOf(search) <= options.endAtPath)).slice(0, options.limit);
    const last = rows[rows.length - 1];
    return { searches: rows.map((row) => ({ ...row })), ...(last ? { lastPath: pathOf(last) } : {}), read: rows.length };
  }),
  markSearchesNotified: vi.fn(async (updates: { uid: string; id: string; lastNotifiedSortAt: number }[]) => {
    for (const update of updates) {
      const row = store.find((search) => search.uid === update.uid && search.id === update.id);
      if (row) row.lastNotifiedSortAt = update.lastNotifiedSortAt;
    }
  }),
  readAlertsCursor: vi.fn(async () => cursor),
  writeAlertsCursor: vi.fn(async (afterUid: string | null) => {
    cursor = afterUid;
  }),
}));

vi.mock("@/lib/search/service", () => ({ runSearch: vi.fn() }));

const repository = await import("@/lib/saved-searches/repository");
const { runSearch } = await import("@/lib/search/service");
const { sendMail } = await import("@/lib/mail");
const { SearchUnavailableError } = await import("@/lib/search/types");
const { verifyUnsubscribeToken } = await import("@/lib/alerts/unsubscribe-token");
const { ALERTS_MAX_PAGES, ALERTS_PAGE_SIZE, SAVED_SEARCH_ALERTS_MAX_MAILS, sendSavedSearchAlerts } = await import("@/worker/jobs/saved-search-alerts");

const NOW = new Date("2026-10-16T07:00:00Z");
const LAST = Date.parse("2026-10-15T07:00:00Z");

function search(uid: string, id: string, extra: Partial<AlertSearchRecord> = {}): AlertSearchRecord {
  return {
    uid,
    id,
    name: `Recherche ${id}`,
    // The district tells the engine mock which search a query comes from.
    params: { category: "vehicules", subcategory: "velos", district: id },
    alert: "daily",
    lastNotifiedSortAt: LAST,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...extra,
  };
}

function card(id: string, sortAt: number): SearchCard {
  return { id, slugId: `velo-${id}`, title: `Vélo ${id}`, subcategoryId: "velos", price: 900, priceNegotiable: false, isDonation: false, citySlug: "rabat", photo: null, photoCount: 0, sellerType: "individual", sortAt: new Date(sortAt).toISOString(), bumped: false, featured: false };
}

/** `count` listings after the default cursor for each search id. */
function news(ids: string[], count = 1): void {
  for (const id of ids) listings.set(id, Array.from({ length: count }, (_, index) => card(`${id}x${index}`, LAST + (index + 1) * 60_000)));
}

const pad = (index: number) => String(index).padStart(4, "0");

function mails(): TemplateMail[] {
  return vi.mocked(sendMail).mock.calls.map(([mail]) => mail as TemplateMail);
}

function digestOf(uid: string): TemplateMail<"savedSearchAlert"> | undefined {
  const mail = mails().find((item) => item.to === `${uid}@example.com`);
  return mail?.template === "savedSearchAlert" ? (mail as TemplateMail<"savedSearchAlert">) : undefined;
}

beforeAll(() => {
  process.env.APP_ENV = "dev";
  delete process.env.HASH_PEPPER;
  resetServerEnv();
});

beforeEach(() => {
  configured.value = true;
  degraded.clear();
  store = [];
  listings = new Map();
  cursor = null;
  approximateFor = new Set();
  vi.mocked(sendMail).mockReset().mockResolvedValue(undefined);
  vi.mocked(repository.listDailySearches).mockClear();
  vi.mocked(repository.markSearchesNotified).mockClear();
  vi.mocked(repository.writeAlertsCursor).mockClear();
  vi.mocked(runSearch)
    .mockReset()
    .mockImplementation(async (params, options = {}) => {
      const filter = options.extraFilter as { value: number };
      const id = params.district ?? "";
      const matching = [...(listings.get(id) ?? [])].filter((hit) => Date.parse(hit.sortAt) > filter.value).sort((a, b) => b.sortAt.localeCompare(a.sortAt));
      const approximate = approximateFor.has(id);
      return { params, sort: "recent", hits: matching.slice(0, options.hitsPerPage), featured: [], total: matching.length, page: 1, totalPages: 1, approximate, facets: { categories: {}, subcategories: {}, districts: {} }, tookMs: 1 } as unknown as SearchResponse;
    });
});

describe("sendSavedSearchAlerts", () => {
  it("does nothing without Firestore, and nothing while mail or read quotas are degraded", async () => {
    configured.value = false;
    expect(await sendSavedSearchAlerts(NOW)).toMatchObject({ mails: 0, complete: false });
    configured.value = true;
    for (const id of ["resend.daily", "firestore.reads"]) {
      degraded.clear();
      degraded.add(id);
      expect((await sendSavedSearchAlerts(NOW)).stopped).toBe("quota");
    }
    expect(repository.listDailySearches).not.toHaveBeenCalled();
    expect(repository.writeAlertsCursor).not.toHaveBeenCalled();
  });

  it("sends one bulk digest per account with news, exact matches only, and moves each search cursor", async () => {
    store = [search("ar-amine", "s1"), search("ar-amine", "s2"), search("ar-amine", "s3"), search("bilal", "s4"), search("closed-c", "s5"), search("dounia", "s6")];
    news(["s1"], 7);
    news(["s2", "s5", "s6"]);
    // s3: nothing new; s6: only approximate matches.
    approximateFor.add("s6");
    const result = await sendSavedSearchAlerts(NOW);
    expect(result).toEqual({ accounts: 4, searches: 6, mails: 1, skipped: 1, failed: 0, complete: true });
    expect(mails()).toHaveLength(1);
    const mail = digestOf("ar-amine");
    expect(mail).toMatchObject({ locale: "ar", priority: "bulk", idempotencyKey: "savedSearchAlert-ar-amine-20261016" });
    expect(mail?.data.searches.map((section) => [section.name, section.total, section.listings.length])).toEqual([
      ["Recherche s1", 7, 5],
      ["Recherche s2", 1, 1],
    ]);
    expect(mail?.data.searches[0]?.url).toMatch(/^https:\/\/joutiya\.ma\/ar\/recherche\?.*sous-categorie=velos/);
    expect(verifyUnsubscribeToken(mail?.data.unsubscribeToken ?? "")).toEqual({ uid: "ar-amine", searchId: "*" });
    // One engine query per search: the saved filters, newest first, after its cursor, no retry.
    expect(runSearch).toHaveBeenCalledTimes(6);
    expect(vi.mocked(runSearch).mock.calls[0]?.[0]).toMatchObject({ sort: "recent", subcategory: "velos" });
    expect(vi.mocked(runSearch).mock.calls[0]?.[1]).toMatchObject({ extraFilter: { field: "sortAt", op: "gt", value: LAST }, hitsPerPage: 5, featured: false, facets: false, approximate: false, now: NOW });
    expect(repository.markSearchesNotified).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repository.markSearchesNotified).mock.calls[0]?.[0]).toEqual([
      { uid: "ar-amine", id: "s1", lastNotifiedSortAt: LAST + 7 * 60_000 },
      { uid: "ar-amine", id: "s2", lastNotifiedSortAt: LAST + 60_000 },
    ]);
    expect(vi.mocked(repository.writeAlertsCursor).mock.calls[0]?.[0]).toBeNull();
    // The same listings are never sent twice.
    vi.mocked(sendMail).mockClear();
    expect((await sendSavedSearchAlerts(NOW)).mails).toBe(0);
  });

  it("keeps an account whole when its searches straddle two pages", async () => {
    store = Array.from({ length: ALERTS_PAGE_SIZE - 1 }, (_, index) => search(`a${pad(index)}`, `q${pad(index)}`));
    store.push(search("zz-split", "first"), search("zz-split", "second"), search("zzz-last", "tail"));
    news(["first", "second", "tail"]);
    const result = await sendSavedSearchAlerts(NOW);
    expect(repository.listDailySearches).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ accounts: ALERTS_PAGE_SIZE + 1, mails: 2, complete: true });
    expect(digestOf("zz-split")?.data.searches.map((section) => section.name)).toEqual(["Recherche first", "Recherche second"]);
  });

  it("stops at the cap, then starts after the last account served and wraps around", async () => {
    const total = SAVED_SEARCH_ALERTS_MAX_MAILS + 5;
    store = Array.from({ length: total }, (_, index) => search(`u${pad(index)}`, `s${pad(index)}`));
    news(store.map((row) => row.id));
    const first = await sendSavedSearchAlerts(NOW);
    expect(first).toMatchObject({ mails: SAVED_SEARCH_ALERTS_MAX_MAILS, stopped: "cap", complete: false });
    const served = `u${pad(SAVED_SEARCH_ALERTS_MAX_MAILS - 1)}`;
    expect(cursor).toBe(served);

    // An account added before the cursor during the night is reached on the wrap.
    store.unshift(search("t-new", "early"));
    news(["early"]);
    vi.mocked(sendMail).mockClear();
    vi.mocked(repository.listDailySearches).mockClear();
    const second = await sendSavedSearchAlerts(new Date("2026-10-17T07:00:00Z"));
    expect(mails().map((mail) => mail.to)).toEqual([...store.slice(SAVED_SEARCH_ALERTS_MAX_MAILS + 1).map((row) => `${row.uid}@example.com`), "t-new@example.com"]);
    expect(second).toMatchObject({ mails: 6, accounts: total + 1, complete: true });
    expect(vi.mocked(repository.listDailySearches).mock.calls.map(([options]) => [options.afterPath ?? null, options.endAtPath ?? null])).toEqual([
      [`users/${cursor === null ? `u${pad(SAVED_SEARCH_ALERTS_MAX_MAILS - 1)}` : ""}/savedSearches/`, null],
      [null, `users/u${pad(SAVED_SEARCH_ALERTS_MAX_MAILS - 1)}/savedSearches/`],
    ]);
    expect(cursor).toBeNull();
  });

  it("stops on an engine outage and resumes after the last account served", async () => {
    store = [search("u1", "s1"), search("u2", "s2"), search("u3", "s3")];
    news(["s1", "s2", "s3"]);
    const engine = vi.mocked(runSearch).getMockImplementation()!;
    vi.mocked(runSearch).mockImplementation(async (params, options) => {
      if (params.district === "s2") throw new SearchUnavailableError();
      return engine(params, options);
    });
    const result = await sendSavedSearchAlerts(NOW);
    expect(result).toMatchObject({ mails: 1, accounts: 1, stopped: "engine", complete: false });
    expect(cursor).toBe("u1");
    expect(store.find((row) => row.id === "s2")?.lastNotifiedSortAt).toBe(LAST);
  });

  it("stops when the mail quota degrades or the queue fails, keeping the unserved accounts", async () => {
    store = [search("u1", "s1"), search("u2", "s2"), search("u3", "s3")];
    news(["s1", "s2", "s3"]);
    vi.mocked(sendMail)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("queue down"));
    const result = await sendSavedSearchAlerts(NOW);
    expect(result).toMatchObject({ mails: 1, stopped: "queue", complete: false });
    expect(cursor).toBe("u1");
    expect(store.find((row) => row.id === "s2")?.lastNotifiedSortAt).toBe(LAST);

    vi.mocked(sendMail).mockReset().mockImplementation(async () => {
      degraded.add("resend.daily");
    });
    const next = await sendSavedSearchAlerts(NOW);
    expect(next).toMatchObject({ mails: 1, stopped: "quota", complete: false });
    expect(cursor).toBe("u2");
  });

  it("stops at the page budget on a complete account and resumes there", async () => {
    const budget = ALERTS_MAX_PAGES * ALERTS_PAGE_SIZE;
    store = Array.from({ length: budget + 10 }, (_, index) => search(`u${String(index).padStart(5, "0")}`, `s${index}`));
    const result = await sendSavedSearchAlerts(NOW);
    expect(repository.listDailySearches).toHaveBeenCalledTimes(ALERTS_MAX_PAGES);
    expect(result).toMatchObject({ stopped: "pages", complete: false, mails: 0 });
    // The last account of the budget may have more searches on the next page: not counted yet.
    expect(result.accounts).toBe(budget - 1);
    expect(cursor).toBe(store[budget - 2]?.uid);
  });
});
