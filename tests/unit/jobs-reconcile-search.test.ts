import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchEngine } from "@/lib/search/types";

// reconcile-search (04:20 UTC, design D11): drift between Firestore and the index (missing, stale,
// orphan inside the scanned id window), full scan up to 8 000 published listings, a rolling window
// of 8 000 by id beyond (cursor in system/searchReconcile), forced jobs for every drifted id, the
// report document and the P2 alert. Firestore is an in-memory fake of the queries the job runs.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("@/lib/quota", () => ({ consume: vi.fn(async () => ({ level: "ok" })), isDegraded: vi.fn(async () => false) }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/search/queue", () => ({ enqueueIndex: vi.fn(async () => undefined) }));

interface Row {
  id: string;
  data: Record<string, unknown>;
}
let published: Row[] = [];
let countOverride: number | undefined;
let cursorDoc: Record<string, unknown> = {};
const reports: Record<string, unknown>[] = [];
const selects: string[][] = [];
const configured = { value: true };

function listingsQuery(state: { after?: string; limit?: number } = {}): Record<string, unknown> {
  return {
    where: () => listingsQuery(state),
    orderBy: () => listingsQuery(state),
    startAfter: (id: string) => listingsQuery({ ...state, after: id }),
    select: (...fields: string[]) => (selects.push(fields), listingsQuery(state)),
    limit: (limit: number) => listingsQuery({ ...state, limit }),
    count: () => ({ get: async () => ({ data: () => ({ count: countOverride ?? published.length }) }) }),
    get: async () => {
      const docs = published
        .filter((row) => state.after === undefined || row.id > state.after)
        .slice(0, state.limit ?? Number.POSITIVE_INFINITY)
        .map((row) => ({ id: row.id, data: () => row.data }));
      return { docs, size: docs.length };
    },
  };
}
vi.mock("@/lib/firebase/admin", () => ({
  isFirestoreConfigured: () => configured.value,
  db: () => ({
    collection: (name: string) =>
      name === "system"
        ? { doc: () => ({ get: async () => ({ get: (field: string) => cursorDoc[field] }), set: async (data: Record<string, unknown>) => void reports.push(data) }) }
        : listingsQuery(),
  }),
}));

let indexed = new Map<string, number>();
const engineState = { healthy: true };
vi.mock("@/lib/search/engine", () => ({
  searchEngine: () =>
    ({
      healthy: async () => engineState.healthy,
      versions: async function* () {
        const all = [...indexed].map(([id, version]) => ({ id, version }));
        for (let i = 0; i < all.length; i += 1000) yield all.slice(i, i + 1000);
      },
    }) as unknown as SearchEngine,
}));

const { alert } = await import("@/lib/alert");
const { isDegraded } = await import("@/lib/quota");
const { enqueueIndex } = await import("@/lib/search/queue");
const reconcile = await import("@/worker/jobs/reconcile-search");

const NOW = new Date("2026-10-16T04:20:00Z");

function row(id: string, version: number, overrides: Record<string, unknown> = {}): Row {
  return {
    id,
    data: {
      status: "published",
      version,
      slugId: `velo-${id}`,
      categoryId: "vehicules",
      subcategoryId: "velos",
      location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.6, lng: -7.62 } },
      moderation: { state: "auto_ok" },
      ...overrides,
    },
  };
}

/** Distinct, sorted listing ids. */
function ids(count: number, prefix = "a"): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: count }, (_, i) => `${prefix}${alphabet[Math.floor(i / 961) % 31]}${alphabet[Math.floor(i / 31) % 31]}${alphabet[i % 31]}zzzz`).sort();
}

beforeEach(() => {
  published = [];
  countOverride = undefined;
  cursorDoc = {};
  reports.length = 0;
  selects.length = 0;
  indexed = new Map();
  configured.value = true;
  engineState.healthy = true;
  vi.mocked(isDegraded).mockResolvedValue(false);
  vi.mocked(alert).mockClear();
  vi.mocked(enqueueIndex).mockClear();
});

describe("computeDrift and inWindow", () => {
  it("finds missing, stale and orphan ids inside the window only", () => {
    const rows = [
      { id: "b", version: 2, indexable: true },
      { id: "c", version: 3, indexable: true },
      { id: "d", version: 1, indexable: true },
      { id: "e", version: 1, indexable: false },
    ];
    const engine = new Map([
      ["a", 1],
      ["c", 2],
      ["d", 1],
      ["e", 1],
      ["f", 4],
      ["z", 9],
    ]);
    expect(reconcile.computeDrift(rows, engine, { after: "a", through: "f" })).toEqual({ missing: ["b"], stale: ["c"], orphans: ["e", "f"] });
    expect(reconcile.computeDrift(rows, engine, { after: null, through: null }).orphans).toEqual(["a", "e", "f", "z"]);
  });

  it("windows are (after, through]", () => {
    expect(reconcile.inWindow("b", { after: "b", through: null })).toBe(false);
    expect(reconcile.inWindow("c", { after: "b", through: "c" })).toBe(true);
    expect(reconcile.inWindow("d", { after: null, through: "c" })).toBe(false);
  });
});

describe("reconcileSearch", () => {
  it("full scan: enqueues forced jobs for every drifted id, reports and alerts", async () => {
    published = [
      row("aaaaaaaa", 1),
      row("bbbbbbbb", 3),
      row("cccccccc", 2, { moderation: { state: "auto_ok", hiddenBy: { reportId: "r1" } } }),
      row("dddddddd", 1, { slugId: undefined }),
      { id: "eeeeeeee", data: { status: "published", version: 5, moderation: { state: "bogus" } } },
    ];
    indexed = new Map([
      ["bbbbbbbb", 2],
      ["cccccccc", 2],
      ["zzzzzzzz", 1],
    ]);
    const result = await reconcile.reconcileSearch(NOW);
    expect(result).toEqual({ mode: "full", published: 5, scanned: 5, indexed: 3, missing: 1, stale: 1, orphans: 2, enqueued: 4, cursor: null });
    expect(enqueueIndex).toHaveBeenCalledWith(["aaaaaaaa", "bbbbbbbb", "cccccccc", "zzzzzzzz"], { force: true });
    expect(selects[0]).toEqual(["status", "version", "slugId", "categoryId", "subcategoryId", "location", "moderation.state", "moderation.hiddenBy"]);
    expect(reports[0]).toMatchObject({ cursor: "", mode: "full", missing: 1, stale: 1, orphans: 2, enqueued: 4 });
    expect(alert).toHaveBeenCalledWith({ severity: "P2", title: "Écarts entre Firestore et la recherche", body: expect.stringContaining("Manquantes : 1, versions différentes : 1, en trop : 2") });
  });

  it("no drift: no job, no alert, the report is still written", async () => {
    published = [row("aaaaaaaa", 1), row("bbbbbbbb", 2)];
    indexed = new Map([
      ["aaaaaaaa", 1],
      ["bbbbbbbb", 2],
    ]);
    expect(await reconcile.reconcileSearch(NOW)).toMatchObject({ missing: 0, stale: 0, orphans: 0, enqueued: 0 });
    expect(enqueueIndex).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(reports).toHaveLength(1);
  });

  it("beyond 8 000 published listings: a rolling window of 8 000 from the cursor", async () => {
    const all = ids(9_000);
    published = all.map((id) => row(id, 1));
    // Index everything at the right version, except one stale id in the window and one outside it.
    indexed = new Map(all.map((id) => [id, 1]));
    const start = all[500]!;
    const inside = all[600]!;
    const outside = all[8_700]!;
    indexed.set(inside, 0);
    indexed.set(outside, 0);
    indexed.set(all[100]!, 7);
    cursorDoc = { cursor: start };
    const result = await reconcile.reconcileSearch(NOW);
    expect(result).toMatchObject({ mode: "window", published: 9_000, scanned: reconcile.RECONCILE_WINDOW, stale: 1, missing: 0, orphans: 0, cursor: all[500 + reconcile.RECONCILE_WINDOW] });
    expect(enqueueIndex).toHaveBeenCalledWith([inside], { force: true });
    expect(reports[0]).toMatchObject({ cursor: all[8_500] });
  });

  it("the last window reaches the end and restarts from the first id next time", async () => {
    const all = ids(9_000);
    published = all.map((id) => row(id, 1));
    indexed = new Map(all.map((id) => [id, 1]));
    indexed.set("zzzzzzzz", 1);
    cursorDoc = { cursor: all[8_499] };
    const result = await reconcile.reconcileSearch(NOW);
    expect(result).toMatchObject({ scanned: 500, orphans: 1, cursor: null });
    expect(enqueueIndex).toHaveBeenCalledWith(["zzzzzzzz"], { force: true });
    expect(reports[0]).toMatchObject({ cursor: "" });
  });

  it("skips without Firebase, with the read quota degraded or the engine down", async () => {
    configured.value = false;
    expect(await reconcile.reconcileSearch(NOW)).toMatchObject({ skipped: "not_configured" });
    configured.value = true;
    vi.mocked(isDegraded).mockResolvedValueOnce(true);
    expect(await reconcile.reconcileSearch(NOW)).toMatchObject({ skipped: "quota" });
    engineState.healthy = false;
    expect(await reconcile.reconcileSearch(NOW)).toMatchObject({ skipped: "engine" });
    expect(reports).toHaveLength(0);
    expect(enqueueIndex).not.toHaveBeenCalled();
  });

  it("uses an injected dispatch", async () => {
    published = [row("aaaaaaaa", 1)];
    const dispatch = vi.fn(async () => undefined);
    await reconcile.reconcileSearch(NOW, { dispatch });
    expect(dispatch).toHaveBeenCalledWith(["aaaaaaaa"]);
    expect(enqueueIndex).not.toHaveBeenCalled();
  });
});
