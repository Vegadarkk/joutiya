import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";

// D17: the hearts cache `fav:{uid}` (complete-set sentinel, version key against a stale rebuild,
// fallback to the subcollection when Valkey is missing, failing or slow) and the favorites counter.
// The fake client runs the two Lua scripts' semantics in memory; the scripts themselves were
// checked against a real server (same assertions).

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const cache = await import("@/lib/favorites/ids-cache");
const { FAVORITE_IDS_SENTINEL, FAVORITE_IDS_TTL_MS, REBUILD_SCRIPT, WRITE_SCRIPT, bumpFavoriteStat, cachedFavoriteIds, favoriteIdsKey, favoriteIdsVersionKey, recordFavoriteChange, setFavoriteCacheClientForTests } = cache;

type Client = Pick<Redis, "smembers" | "get" | "eval" | "incrby">;

class FakeValkey {
  sets = new Map<string, Set<string>>();
  strings = new Map<string, string>();
  ttl = new Map<string, number>();

  smembers = vi.fn(async (key: string) => [...(this.sets.get(key) ?? [])]);
  get = vi.fn(async (key: string) => this.strings.get(key) ?? null);
  incrby = vi.fn(async (key: string, delta: number) => {
    const next = Number(this.strings.get(key) ?? "0") + delta;
    this.strings.set(key, String(next));
    return next;
  });
  eval = vi.fn(async (script: string, _keys: number, setKey: string, versionKey: string, ...args: (string | number)[]) => {
    const argv = args.map(String);
    if (script === REBUILD_SCRIPT) {
      if ((this.strings.get(versionKey) ?? "0") !== argv[0]) return 0;
      this.sets.set(setKey, new Set(argv.slice(2)));
      this.ttl.set(setKey, Number(argv[1]));
      return 1;
    }
    if (script === WRITE_SCRIPT) {
      this.strings.set(versionKey, String(Number(this.strings.get(versionKey) ?? "0") + 1));
      this.ttl.set(versionKey, Number(argv[2]));
      const set = this.sets.get(setKey);
      if (set?.has(argv[3]!)) {
        if (argv[0] === "add") set.add(argv[1]!);
        else set.delete(argv[1]!);
        this.ttl.set(setKey, Number(argv[2]));
      }
      return 1;
    }
    throw new Error("unknown script");
  });

  asClient(): Client {
    return this as unknown as Client;
  }
}

afterEach(() => {
  setFavoriteCacheClientForTests(undefined);
  vi.useRealTimers();
});

describe("cachedFavoriteIds", () => {
  it("reads the subcollection when Valkey is not configured", async () => {
    setFavoriteCacheClientForTests(null);
    const load = vi.fn(async () => ["abcd2345"]);
    expect(await cachedFavoriteIds("uid-1", load)).toEqual(["abcd2345"]);
    expect(await cachedFavoriteIds("uid-1", load)).toEqual(["abcd2345"]);
    expect(load).toHaveBeenCalledTimes(2);
    await expect(recordFavoriteChange("uid-1", "abcd2345", "add")).resolves.toBeUndefined();
    await expect(bumpFavoriteStat("abcd2345", 1)).resolves.toBeUndefined();
  });

  it("rebuilds on a miss, then answers from the set, an empty list included", async () => {
    const valkey = new FakeValkey();
    setFavoriteCacheClientForTests(valkey.asClient());
    const load = vi.fn(async () => ["abcd2345", "efgh2345"]);
    expect(await cachedFavoriteIds("uid-1", load)).toEqual(["abcd2345", "efgh2345"]);
    expect(valkey.eval).toHaveBeenCalledWith(REBUILD_SCRIPT, 2, "fav:uid-1", "fav:uid-1:v", "0", FAVORITE_IDS_TTL_MS, FAVORITE_IDS_SENTINEL, "abcd2345", "efgh2345");
    expect(valkey.ttl.get("fav:uid-1")).toBe(30 * 24 * 3600 * 1000);
    expect((await cachedFavoriteIds("uid-1", load)).sort()).toEqual(["abcd2345", "efgh2345"]);
    expect(load).toHaveBeenCalledTimes(1);

    const none = vi.fn(async () => []);
    expect(await cachedFavoriteIds("uid-2", none)).toEqual([]);
    expect(valkey.sets.get(favoriteIdsKey("uid-2"))).toEqual(new Set([FAVORITE_IDS_SENTINEL]));
    expect(await cachedFavoriteIds("uid-2", none)).toEqual([]);
    expect(none).toHaveBeenCalledTimes(1);
  });

  it("follows adds and removes on a cached set, and leaves a missing one missing", async () => {
    const valkey = new FakeValkey();
    setFavoriteCacheClientForTests(valkey.asClient());
    await recordFavoriteChange("uid-1", "abcd2345", "add");
    expect(valkey.sets.has(favoriteIdsKey("uid-1"))).toBe(false);
    expect(valkey.strings.get(favoriteIdsVersionKey("uid-1"))).toBe("1");

    const load = vi.fn(async () => ["abcd2345"]);
    await cachedFavoriteIds("uid-1", load);
    await recordFavoriteChange("uid-1", "efgh2345", "add");
    await recordFavoriteChange("uid-1", "abcd2345", "remove");
    expect(await cachedFavoriteIds("uid-1", load)).toEqual(["efgh2345"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("never stores a rebuild that a write overtook", async () => {
    const valkey = new FakeValkey();
    setFavoriteCacheClientForTests(valkey.asClient());
    // The add commits (and bumps the version) while the subcollection is being read.
    const stale = vi.fn(async () => {
      await recordFavoriteChange("uid-1", "abcd2345", "add");
      return [];
    });
    expect(await cachedFavoriteIds("uid-1", stale)).toEqual([]);
    expect(valkey.sets.has(favoriteIdsKey("uid-1"))).toBe(false);
    const fresh = vi.fn(async () => ["abcd2345"]);
    expect(await cachedFavoriteIds("uid-1", fresh)).toEqual(["abcd2345"]);
    expect(await cachedFavoriteIds("uid-1", fresh)).toEqual(["abcd2345"]);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("falls back to the subcollection when Valkey fails or hangs", async () => {
    const valkey = new FakeValkey();
    setFavoriteCacheClientForTests(valkey.asClient());
    valkey.smembers.mockRejectedValueOnce(new Error("connection lost"));
    const load = vi.fn(async () => ["abcd2345"]);
    expect(await cachedFavoriteIds("uid-1", load)).toEqual(["abcd2345"]);

    valkey.eval.mockRejectedValueOnce(new Error("OOM"));
    expect(await cachedFavoriteIds("uid-1", load)).toEqual(["abcd2345"]);

    vi.useFakeTimers();
    valkey.smembers.mockImplementationOnce(() => new Promise(() => undefined) as never);
    const pending = cachedFavoriteIds("uid-1", load);
    await vi.advanceTimersByTimeAsync(800);
    expect(await pending).toEqual(["abcd2345"]);
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe("bumpFavoriteStat", () => {
  it("counts adds minus removes per listing, best effort", async () => {
    const valkey = new FakeValkey();
    setFavoriteCacheClientForTests(valkey.asClient());
    await bumpFavoriteStat("abcd2345", 1);
    await bumpFavoriteStat("abcd2345", 1);
    await bumpFavoriteStat("abcd2345", -1);
    expect(valkey.strings.get("stats:favorites:abcd2345")).toBe("1");
    valkey.incrby.mockRejectedValueOnce(new Error("down"));
    await expect(bumpFavoriteStat("abcd2345", 1)).resolves.toBeUndefined();
  });
});
