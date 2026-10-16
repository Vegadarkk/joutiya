import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Search indexing against the emulators with the memory engine (design D8, D9, D10): the fast lane
// (inline without Valkey), the outbox drain by the poll, the version race of ackSearchOutbox, the
// lag alert past 5 minutes (fake clock), boost expiry (delayed job and nightly sweep) and the dev
// rebuild route. The fast lane is switched off where a test needs the outbox entries to stay.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/alert", async (importOriginal) => ({ ...(await importOriginal<typeof AlertModule>()), alert: vi.fn(async () => true) }));
const fastLane = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/lib/search/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof QueueModule>();
  return {
    ...actual,
    notifySearchIndex: vi.fn(async (ids: readonly string[]) => {
      if (fastLane.enabled) await actual.notifySearchIndex(ids);
    }),
  };
});

import { POST as pause } from "@/app/api/listings/[id]/pause/route";
import { POST as rebuild } from "@/app/api/dev/search/rebuild/route";
import { NextRequest } from "next/server";
import type * as AlertModule from "@/lib/alert";
import { alert } from "@/lib/alert";
import { getListing, listingRef } from "@/lib/db/repositories/listings";
import { enqueueSearchOutbox, getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { toSearchDocument } from "@/lib/search/document";
import { resetSearchEngine, setSearchEngineForTests } from "@/lib/search/engine";
import { indexListing, LAG_ALERT_TITLE, processOutbox } from "@/lib/search/indexer";
import { MemoryEngine } from "@/lib/search/memory";
import type * as QueueModule from "@/lib/search/queue";
import type { SearchDocument } from "@/lib/search/types";
import { Timestamp } from "firebase-admin/firestore";
import { processSearchJob } from "@/worker/jobs/search";
import { sweepExpiredBoosts } from "@/worker/jobs/expire-boosts";
import { listingApi, member, patchListing, publishedListing, type Member } from "../uploads/helpers";

let engine: MemoryEngine;

beforeAll(() => resetServerEnv());
afterAll(() => resetSearchEngine());
beforeEach(async () => {
  resetRateLimiters();
  engine = new MemoryEngine();
  setSearchEngineForTests(engine);
  fastLane.enabled = false;
  vi.mocked(alert).mockClear();
  await clearOutbox();
});

/** Leftovers of other suites in the shared emulator would make the poll's page unpredictable. */
async function clearOutbox(): Promise<void> {
  for (;;) {
    const snapshot = await db().collection(COLLECTIONS.searchOutbox).limit(400).get();
    if (snapshot.empty) return;
    const batch = db().batch();
    for (const doc of snapshot.docs) batch.delete(doc.ref);
    await batch.commit();
  }
}

async function stored(id: string): Promise<SearchDocument | undefined> {
  for await (const page of engine.documents<SearchDocument>({ filter: { field: "id", op: "eq", value: id }, fields: ["id", "version", "title", "featuredUntil"] })) return page[0];
  return undefined;
}

async function published(owner?: Member): Promise<string> {
  return (await publishedListing(owner ?? (await member()))).id;
}

describe("fast lane (inline without Valkey)", () => {
  it("a publication, an edit and a pause reach the index at once and leave no outbox entry", async () => {
    fastLane.enabled = true;
    const owner = await member();
    const id = await published(owner);
    const listing = (await getListing(id))!;
    expect(await stored(id)).toMatchObject({ id, version: listing.version });
    expect(await getSearchOutbox(id)).toBeNull();

    const edited = await listingApi(patchListing, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: "Vélo de ville Peugeot révisé" } });
    expect(edited.status).toBe(200);
    expect(await stored(id)).toMatchObject({ title: "Vélo de ville Peugeot révisé", version: listing.version + 1 });

    const paused = await listingApi(pause, "POST", `/api/listings/${id}/pause`, { member: owner });
    expect(paused.status).toBe(200);
    expect(await stored(id)).toBeUndefined();
    expect(await getSearchOutbox(id)).toBeNull();
  });
});

describe("outbox drain (poll)", () => {
  it("indexes every pending entry at its listing's version and empties the outbox", async () => {
    const owner = await member();
    const ids = [await published(owner), await published(owner)];
    for (const id of ids) expect(await getSearchOutbox(id)).toMatchObject({ op: "upsert" });

    const result = await processOutbox();
    expect(result).toMatchObject({ pending: 2, alerted: false });
    for (const id of ids) {
      expect(await getSearchOutbox(id)).toBeNull();
      expect((await stored(id))?.version).toBe((await getListing(id))!.version);
    }
    expect(await processOutbox()).toMatchObject({ pending: 0, lagSeconds: 0 });
  });

  it("a delete entry removes the document (tombstone, missing or unpublished listing)", async () => {
    await engine.upsert([{ id: "zzzzzzzz", version: 1 } as SearchDocument]);
    await enqueueSearchOutbox("zzzzzzzz", "delete", 2);
    await processOutbox();
    expect(await stored("zzzzzzzz")).toBeUndefined();
    expect(await getSearchOutbox("zzzzzzzz")).toBeNull();
  });
});

describe("version race (ackSearchOutbox)", () => {
  it("an edit committed while the listing is being indexed gets one more pass", async () => {
    const owner = await member();
    const id = await published(owner);
    const before = (await getListing(id))!;
    const upsert = engine.upsert.bind(engine);
    let edits = 0;
    vi.spyOn(engine, "upsert").mockImplementation(async (documents) => {
      await upsert(documents);
      if (edits === 0) {
        edits += 1;
        // The owner saves an edit between the engine write and the acknowledgement.
        const edited = await listingApi(patchListing, "PATCH", `/api/listings/${id}`, { member: owner, body: { title: "Vélo de ville Peugeot, prix ferme" } });
        expect(edited.status).toBe(200);
      }
    });

    const outcome = await indexListing(id);
    expect(outcome).toMatchObject({ action: "upsert", acked: true, pending: false, passes: 2, version: before.version + 1 });
    expect(await stored(id)).toMatchObject({ version: before.version + 1, title: "Vélo de ville Peugeot, prix ferme" });
    expect(await getSearchOutbox(id)).toBeNull();
  });
});

describe("lag alert (D10, fake clock)", () => {
  it("raises the P1 alert once the oldest entry waits more than 5 minutes", async () => {
    const id = await published();
    const entry = (await getSearchOutbox(id))!;
    const hold = async () => undefined;

    const early = await processOutbox({ now: new Date(entry.enqueuedAt.getTime() + 4 * 60_000), dispatch: hold });
    expect(early).toMatchObject({ pending: 1, lagSeconds: 240, alerted: false });
    expect(alert).not.toHaveBeenCalled();

    const late = await processOutbox({ now: new Date(entry.enqueuedAt.getTime() + 6 * 60_000), dispatch: hold });
    expect(late).toMatchObject({ pending: 1, lagSeconds: 360, alerted: true });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P1", title: LAG_ALERT_TITLE }));

    // Once drained, the lag is back to zero.
    await processOutbox();
    expect(await processOutbox({ now: new Date(entry.enqueuedAt.getTime() + 60 * 60_000) })).toMatchObject({ pending: 0, lagSeconds: 0, alerted: false });
  });
});

describe("À la Une expiry (D8)", () => {
  async function featured(until: Date): Promise<string> {
    fastLane.enabled = true;
    const id = await published();
    fastLane.enabled = false;
    // Nothing writes boosts before phase 7: seeded, with the document as it was indexed while it ran.
    await listingRef(id).update({ "boosts.featuredUntil": Timestamp.fromDate(until) });
    const running = toSearchDocument((await getListing(id))!, new Date(until.getTime() - 3_600_000));
    await engine.upsert([running!]);
    expect((await stored(id))?.featuredUntil).toBe(until.getTime());
    return id;
  }

  it("the nightly sweep re-indexes the boosts ended since the last sweep", async () => {
    await db().collection(COLLECTIONS.system).doc("searchBoosts").delete();
    const now = new Date();
    const id = await featured(new Date(now.getTime() - 60_000));
    const version = (await getListing(id))!.version;
    fastLane.enabled = true;

    const result = await sweepExpiredBoosts(now);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await stored(id)).toMatchObject({ id, version });
    expect((await stored(id))?.featuredUntil).toBeUndefined();
    expect(await getSearchOutbox(id)).toBeNull();
    const cursor: unknown = (await db().collection(COLLECTIONS.system).doc("searchBoosts").get()).get("through");
    expect((cursor as Timestamp).toMillis()).toBe(now.getTime());
  });

  it("the delayed expire-boost job writes the entry and indexes", async () => {
    const until = new Date(Date.now() - 1_000);
    const id = await featured(until);
    expect(await processSearchJob({ name: "expire-boost", data: { id, until: until.getTime() } })).toBe(true);
    expect((await stored(id))?.featuredUntil).toBeUndefined();
    expect(await getSearchOutbox(id)).toBeNull();
  });

  it("an extended boost is left alone", async () => {
    const until = new Date(Date.now() + 3_600_000);
    const id = await featured(until);
    expect(await processSearchJob({ name: "expire-boost", data: { id, until: Date.now() - 1_000 } })).toBe(false);
    expect((await stored(id))?.featuredUntil).toBe(until.getTime());
    expect(await getSearchOutbox(id)).toBeNull();
  });
});

describe("POST /api/dev/search/rebuild", () => {
  it("indexes every published listing and drops the rest", async () => {
    const id = await published();
    await engine.upsert([{ id: "zzzzzzzz", version: 1 } as SearchDocument]);
    const response = await rebuild(new NextRequest("http://localhost:3000/api/dev/search/rebuild", { method: "POST" }), { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { indexed: number; removed: number };
    expect(body.indexed).toBeGreaterThanOrEqual(1);
    expect(body.removed).toBeGreaterThanOrEqual(1);
    expect((await stored(id))?.version).toBe((await getListing(id))!.version);
    expect(await stored("zzzzzzzz")).toBeUndefined();
  });
});
