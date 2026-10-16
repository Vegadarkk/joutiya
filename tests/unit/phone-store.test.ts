import { beforeEach, describe, expect, it } from "vitest";
import { CHALLENGE_TTL_SECONDS, EXPIRED_GRACE_SECONDS, MemoryChallengeStore, ValkeyChallengeStore, WAMID_TTL_SECONDS, type ChallengeClient, type ChallengeStore } from "@/lib/phone-verify/store";

// Same semantics for both stores: the Valkey one runs against a fake client (GET/SET EX [NX]/DEL).

class FakeRedis {
  readonly data = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly now: () => number) {}

  async get(key: string): Promise<string | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, _ex: "EX", seconds: number, nx?: "NX"): Promise<"OK" | null> {
    if (nx === "NX" && (await this.get(key)) !== null) return null;
    this.data.set(key, { value, expiresAt: this.now() + seconds * 1000 });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) if (this.data.delete(key)) count += 1;
    return count;
  }

  ttl(key: string): number {
    const entry = this.data.get(key);
    return entry ? Math.round((entry.expiresAt - this.now()) / 1000) : -2;
  }
}

const T0 = 1_760_000_000_000;
let clock = T0;
const now = () => clock;

const challenge = (phoneE164: string, codeHash = "hash") => ({ phoneE164, codeHash, expiresAt: clock + CHALLENGE_TTL_SECONDS * 1000 });

type Variant = { name: string; make: () => { store: ChallengeStore; redis?: FakeRedis } };

const variants: Variant[] = [
  { name: "MemoryChallengeStore", make: () => ({ store: new MemoryChallengeStore(now) }) },
  {
    name: "ValkeyChallengeStore",
    make: () => {
      const redis = new FakeRedis(now);
      return { store: new ValkeyChallengeStore(redis as unknown as ChallengeClient, now), redis };
    },
  },
];

describe.each(variants)("$name", ({ make }) => {
  let store: ChallengeStore;
  let redis: FakeRedis | undefined;

  beforeEach(() => {
    clock = T0;
    ({ store, redis } = make());
  });

  it("stores a challenge, readable by uid and by number", async () => {
    await store.put("alice", challenge("+212612345678"));
    const expected = { uid: "alice", phoneE164: "+212612345678", codeHash: "hash", expiresAt: T0 + CHALLENGE_TTL_SECONDS * 1000 };
    expect(await store.getByUid("alice")).toEqual(expected);
    expect(await store.getByPhone("+212612345678")).toEqual(expected);
    expect(await store.getByUid("bob")).toBeNull();
    expect(await store.getByPhone("+212699999999")).toBeNull();
  });

  it("replaces the challenge of a uid and moves the number pointer", async () => {
    await store.put("alice", challenge("+212612345678", "h1"));
    await store.put("alice", challenge("+212712345678", "h2"));
    expect(await store.getByUid("alice")).toMatchObject({ phoneE164: "+212712345678", codeHash: "h2" });
    expect(await store.getByPhone("+212612345678")).toBeNull();
    expect(await store.getByPhone("+212712345678")).toMatchObject({ uid: "alice" });
  });

  it("gives a number to the latest account that started a challenge for it", async () => {
    await store.put("alice", challenge("+212612345678", "ha"));
    await store.put("bob", challenge("+212612345678", "hb"));
    expect(await store.getByPhone("+212612345678")).toMatchObject({ uid: "bob", codeHash: "hb" });
    // Alice's own challenge still exists, but it is no longer reachable from the number.
    expect(await store.getByUid("alice")).toMatchObject({ codeHash: "ha" });
    // Deleting Alice's challenge must not drop Bob's pointer.
    await store.delete("alice");
    expect(await store.getByPhone("+212612345678")).toMatchObject({ uid: "bob" });
  });

  it("deletes a challenge and its number pointer", async () => {
    await store.put("alice", challenge("+212612345678"));
    await store.delete("alice");
    expect(await store.getByUid("alice")).toBeNull();
    expect(await store.getByPhone("+212612345678")).toBeNull();
    await expect(store.delete("alice")).resolves.toBeUndefined();
  });

  it("keeps an expired challenge readable during the grace period, then forgets it", async () => {
    await store.put("alice", challenge("+212612345678"));
    clock = T0 + (CHALLENGE_TTL_SECONDS + 60) * 1000;
    const stale = await store.getByUid("alice");
    expect(stale).not.toBeNull();
    expect(stale!.expiresAt).toBeLessThan(clock);
    clock = T0 + (CHALLENGE_TTL_SECONDS + EXPIRED_GRACE_SECONDS + 1) * 1000;
    expect(await store.getByUid("alice")).toBeNull();
    expect(await store.getByPhone("+212612345678")).toBeNull();
  });

  it("remembers a wamid for 24 h", async () => {
    expect(await store.seen("wamid.1")).toBe(false);
    expect(await store.seen("wamid.1")).toBe(true);
    expect(await store.seen("wamid.2")).toBe(false);
    clock = T0 + (WAMID_TTL_SECONDS - 1) * 1000;
    expect(await store.seen("wamid.1")).toBe(true);
    clock = T0 + (WAMID_TTL_SECONDS + 1) * 1000;
    expect(await store.seen("wamid.1")).toBe(false);
  });

  it("uses hashed number keys and bounded TTLs in Valkey", async () => {
    if (!redis) return;
    await store.put("alice", challenge("+212612345678"));
    await store.seen("wamid.1");
    const keys = [...redis.data.keys()];
    expect(keys).toContain("pv:u:alice");
    expect(keys).toContain("pv:m:wamid.1");
    expect(keys.some((key) => key.startsWith("pv:p:") && !key.includes("212612345678"))).toBe(true);
    expect(redis.ttl("pv:u:alice")).toBe(CHALLENGE_TTL_SECONDS + EXPIRED_GRACE_SECONDS);
    expect(redis.ttl("pv:m:wamid.1")).toBe(WAMID_TTL_SECONDS);
    expect(JSON.parse(redis.data.get("pv:u:alice")!.value)).toEqual({ phoneE164: "+212612345678", codeHash: "hash", expiresAt: T0 + CHALLENGE_TTL_SECONDS * 1000 });
  });

  it("ignores a corrupted Valkey value", async () => {
    if (!redis) return;
    await redis.set("pv:u:alice", "{not json", "EX", 600);
    expect(await store.getByUid("alice")).toBeNull();
    await redis.set("pv:u:alice", JSON.stringify({ phoneE164: 1 }), "EX", 600);
    expect(await store.getByUid("alice")).toBeNull();
  });
});
