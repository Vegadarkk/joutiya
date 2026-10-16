import { beforeEach, describe, expect, it, vi } from "vitest";

// claimVerifiedPhone (src/lib/phone-verify/accounts.ts) counts what Firestore bills on the Spark
// quotas: the holder query on every attempt of the transaction (at least one read, even when
// empty), the writes once, after the commit: two for the caller, two per account that lost the
// number. A fake transaction stands in for the Admin SDK.

vi.mock("@/lib/quota", () => ({ consume: vi.fn(async () => ({ level: "ok" })) }));

interface FakeHolder {
  ref: { path: string; parent: { parent: { id: string } | null } };
}

const state = vi.hoisted(() => ({ holders: [] as string[], attempts: 1, commitFails: false, updates: [] as string[] }));

function holder(uid: string): FakeHolder {
  return { ref: { path: `users/${uid}/private/account`, parent: { parent: { id: uid } } } };
}

vi.mock("@/lib/firebase/admin", () => {
  const doc = (path: string) => ({ path, collection: (name: string) => ({ doc: (id: string) => doc(`${path}/${name}/${id}`) }) });
  const firestore = {
    collection: (name: string) => ({ doc: (id: string) => doc(`${name}/${id}`) }),
    collectionGroup: () => ({ where: () => ({ kind: "holders" }) }),
    runTransaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => {
      let result: T | undefined;
      // A contended transaction runs its callback again; only the last attempt commits.
      for (let attempt = 1; attempt <= state.attempts; attempt += 1) {
        const pending: string[] = [];
        const tx = {
          get: async () => ({ size: state.holders.length, docs: state.holders.map(holder) }),
          update: (ref: { path: string }) => void pending.push(ref.path),
        };
        result = await run(tx);
        if (attempt === state.attempts) {
          if (state.commitFails) throw Object.assign(new Error("10 ABORTED"), { code: 10 });
          state.updates.push(...pending);
        }
      }
      return result as T;
    },
  };
  return { db: () => firestore };
});

const { consume } = await import("@/lib/quota");
const { claimVerifiedPhone } = await import("@/lib/phone-verify/accounts");

const calls = (id: string) => vi.mocked(consume).mock.calls.filter(([quota]) => quota === id).map(([, amount]) => amount);

beforeEach(() => {
  vi.mocked(consume).mockClear();
  Object.assign(state, { holders: [], attempts: 1, commitFails: false, updates: [] });
});

describe("claimVerifiedPhone quota counting", () => {
  it("bills one read for an empty holder query and the caller's two writes", async () => {
    expect(await claimVerifiedPhone("uid-a", "+212612345678")).toEqual({ previousUid: null });
    expect(calls("firestore.reads")).toEqual([1]);
    expect(calls("firestore.writes")).toEqual([2]);
    expect(state.updates).toEqual(["users/uid-a/private/account", "users/uid-a"]);
  });

  it("bills every holder read and two writes per account that loses the number, none for the caller's own", async () => {
    state.holders = ["uid-a", "uid-b", "uid-c"];
    expect(await claimVerifiedPhone("uid-a", "+212612345678")).toEqual({ previousUid: "uid-b" });
    expect(calls("firestore.reads")).toEqual([3]);
    expect(calls("firestore.writes")).toEqual([6]);
    expect(state.updates).toHaveLength(6);
  });

  it("bills the query on each attempt of a retried transaction, the writes once", async () => {
    state.holders = ["uid-b"];
    state.attempts = 2;
    await claimVerifiedPhone("uid-a", "+212612345678");
    expect(calls("firestore.reads")).toEqual([1, 1]);
    expect(calls("firestore.writes")).toEqual([4]);
  });

  it("bills no write when the transaction does not commit", async () => {
    state.holders = ["uid-b"];
    state.commitFails = true;
    await expect(claimVerifiedPhone("uid-a", "+212612345678")).rejects.toThrow("ABORTED");
    expect(calls("firestore.reads")).toEqual([1]);
    expect(calls("firestore.writes")).toEqual([]);
  });
});
