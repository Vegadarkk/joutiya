import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Exit criterion of design D11 against the emulators with the memory engine: seeded drift between
// Firestore and the index (missing, stale, orphans) is found by reconcile-search, the forced
// index-listing jobs it enqueues (inline without Valkey) repair it, and the next run finds none.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/alert", async (importOriginal) => ({ ...(await importOriginal<typeof AlertModule>()), alert: vi.fn(async () => true) }));

import { Timestamp } from "firebase-admin/firestore";
import type * as AlertModule from "@/lib/alert";
import { alert } from "@/lib/alert";
import { getListing, listingRef } from "@/lib/db/repositories/listings";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { toSearchDocument } from "@/lib/search/document";
import { resetSearchEngine, setSearchEngineForTests } from "@/lib/search/engine";
import { MemoryEngine } from "@/lib/search/memory";
import type { SearchDocument } from "@/lib/search/types";
import { RECONCILE_ALERT_TITLE, reconcileSearch } from "@/worker/jobs/reconcile-search";
import { draft, member, publishedListing } from "../uploads/helpers";

let engine: MemoryEngine;

beforeAll(() => resetServerEnv());
afterAll(() => resetSearchEngine());
beforeEach(() => {
  resetRateLimiters();
  engine = new MemoryEngine();
  setSearchEngineForTests(engine);
  vi.mocked(alert).mockClear();
});

async function stored(id: string): Promise<SearchDocument | undefined> {
  for await (const page of engine.documents<SearchDocument>({ filter: { field: "id", op: "eq", value: id }, fields: ["id", "version", "title"] })) return page[0];
  return undefined;
}

async function documentOf(id: string): Promise<SearchDocument> {
  const document = toSearchDocument((await getListing(id))!);
  if (!document) throw new Error(`listing ${id} is not indexable`);
  return document;
}

describe("reconcile-search", () => {
  it("seeded drift (missing, stale, orphans) -> zero drift after one run and its jobs", async () => {
    const owner = await member();
    const missing = (await publishedListing(owner)).id;
    const stale = (await publishedListing(owner)).id;
    const hidden = (await publishedListing(owner)).id;
    const unpublished = await draft(owner);

    // The fast lane indexed the three publications. The index as drift leaves it: one listing
    // absent, one at an older version with an old title, one hidden by a report since it was
    // indexed, a draft and an unknown id indexed.
    const staleDocument = await documentOf(stale);
    const hiddenDocument = await documentOf(hidden);
    expect(await stored(hidden)).toMatchObject({ version: hiddenDocument.version });
    await engine.remove([missing]);
    await engine.upsert([
      { ...staleDocument, version: staleDocument.version - 1, title: "Ancien titre" },
      hiddenDocument,
      { ...staleDocument, id: unpublished, slugId: `brouillon-${unpublished}` },
      { ...staleDocument, id: "zzzzzzzz", slugId: "fantome-zzzzzzzz" },
    ]);
    await listingRef(hidden).update({ "moderation.hiddenBy": { reportId: "report-1", signal: "multi", at: Timestamp.now() } });
    expect(await stored(missing)).toBeUndefined();

    // Published listings left by other suites are missing from this fresh engine too: they are
    // part of the drift of the first run.
    const first = await reconcileSearch(new Date());
    expect(first.skipped).toBeUndefined();
    expect(first.mode).toBe("full");
    expect(first.missing).toBeGreaterThanOrEqual(1);
    expect(first.stale).toBe(1);
    expect(first.orphans).toBe(3);
    expect(first.enqueued).toBe(first.missing + first.stale + first.orphans);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P2", title: RECONCILE_ALERT_TITLE }));

    expect(await stored(missing)).toMatchObject({ version: (await getListing(missing))!.version });
    expect(await stored(stale)).toMatchObject({ version: staleDocument.version, title: staleDocument.title });
    expect(await stored(hidden)).toBeUndefined();
    expect(await stored(unpublished)).toBeUndefined();
    expect(await stored("zzzzzzzz")).toBeUndefined();

    vi.mocked(alert).mockClear();
    const second = await reconcileSearch(new Date());
    expect(second).toMatchObject({ mode: "full", missing: 0, stale: 0, orphans: 0, enqueued: 0, cursor: null });
    expect(second.scanned).toBe(first.scanned);
    expect(alert).not.toHaveBeenCalled();
    const report = (await db().collection(COLLECTIONS.system).doc("searchReconcile").get()).data();
    expect(report).toMatchObject({ mode: "full", missing: 0, stale: 0, orphans: 0, enqueued: 0, cursor: "" });
  });
});
