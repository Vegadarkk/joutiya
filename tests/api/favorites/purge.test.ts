import { Timestamp } from "firebase-admin/firestore";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Favorites of a purged listing on the emulator (audit A3-06, architecture §5 "Fin de vie": the
// purge "supprime le texte"): retention-purge deletes every users/{uid}/favorites/{listingId}
// pointing at it (collection-group query on the stored listingId, in the purge transactions), so
// no saver keeps its title, price or cover; the hearts cache drops the id; the favorites of a
// listing still live, or under a legal hold, stay. Real queries: their shapes must be valid.

// Search fast lane off: the memory engine below is the index.
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));

import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { GET as list } from "@/app/api/favorites/route";
import { GET as ids } from "@/app/api/favorites/ids/route";
import { PUT as put } from "@/app/api/favorites/[listingId]/route";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import type { FavoriteView, FavoritesPage } from "@/lib/contracts/search";
import { getListing } from "@/lib/db/repositories/listings";
import { getListingDocument, purgeListing } from "@/lib/db/repositories/retention";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { REBUILD_SCRIPT, WRITE_SCRIPT, setFavoriteCacheClientForTests } from "@/lib/favorites/ids-cache";
import { db } from "@/lib/firebase/admin";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { setSearchEngineForTests } from "@/lib/search/engine";
import type { MemoryEngine } from "@/lib/search/memory";
import { MemoryObjectStore } from "@/lib/storage/memory";
import { isPurgeable, retentionPurge } from "@/worker/jobs/retention-purge";
import { DAY_MS, api, readyPatch, seedReadyUpload, type ListingBody, type PublishBody } from "../listings/helpers";
import { call, doc, member, serve, type ErrorBody, type Member } from "./helpers";

/** The hearts cache's two Lua scripts, in memory (tests/unit/favorites-ids-cache.test.ts has the full fake). */
class FakeValkey {
  sets = new Map<string, Set<string>>();
  strings = new Map<string, string>();
  smembers = async (key: string) => [...(this.sets.get(key) ?? [])];
  get = async (key: string) => this.strings.get(key) ?? null;
  incrby = async (key: string, delta: number) => {
    const next = Number(this.strings.get(key) ?? "0") + delta;
    this.strings.set(key, String(next));
    return next;
  };
  eval = async (script: string, _keys: number, setKey: string, versionKey: string, ...args: (string | number)[]) => {
    const argv = args.map(String);
    if (script === REBUILD_SCRIPT) {
      if ((this.strings.get(versionKey) ?? "0") !== argv[0]) return 0;
      this.sets.set(setKey, new Set(argv.slice(2)));
      return 1;
    }
    if (script !== WRITE_SCRIPT) throw new Error("unknown script");
    this.strings.set(versionKey, String(Number(this.strings.get(versionKey) ?? "0") + 1));
    const set = this.sets.get(setKey);
    if (set?.has(argv[3]!)) {
      if (argv[0] === "add") set.add(argv[1]!);
      else set.delete(argv[1]!);
    }
    return 1;
  };
}

let owner: Member;
let engine: MemoryEngine;
let valkey: FakeValkey;

beforeAll(async () => {
  resetServerEnv();
  owner = await member({ displayName: "Karim Vendeur" });
  engine = await serve([]);
});
beforeEach(() => {
  resetRateLimiters();
  valkey = new FakeValkey();
  setFavoriteCacheClientForTests(valkey as unknown as Pick<Redis, "smembers" | "get" | "eval" | "incrby">);
});
afterAll(() => {
  setFavoriteCacheClientForTests(undefined);
  setSearchEngineForTests(null);
});

/** A published listing with one ready photo, indexed in the memory engine (its card is what a favorite saves). */
async function indexedListing(title: string, price: number): Promise<{ id: string; photo: string }> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  const id = created.body.id;
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch({ title, price }) })).status).toBe(200);
  const upload = await seedReadyUpload(owner, id);
  expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [upload] } })).status).toBe(200);
  expect((await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } })).body.status).toBe("published");
  const listing = (await getListing(id))!;
  const { w, h, blurhash } = listing.photos[0]!;
  const location = { citySlug: listing.location!.citySlug, categoryId: listing.categoryId!, subcategoryId: listing.subcategoryId! };
  await engine.upsert([doc({ id, slugId: listing.slugId!, title, price, ...location, hasPhoto: true, photoCount: 1, photo: { id: upload, w, h, blurhash } })]);
  return { id, photo: upload };
}

/** Ended and past purgeAt (test seeding only: the job reads what it finds). */
async function endedPastPurge(id: string, now: Date, fields: Record<string, unknown> = {}): Promise<void> {
  await db()
    .collection(COLLECTIONS.listings)
    .doc(id)
    .update({ status: "expired", purgeAt: Timestamp.fromDate(new Date(now.getTime() - DAY_MS)), ...fields });
}

const favoriteDoc = (uid: string, listingId: string) => db().collection(COLLECTIONS.users).doc(uid).collection(COLLECTIONS.favorites).doc(listingId).get();
const favoritesOf = async (listingId: string) => (await db().collectionGroup(COLLECTIONS.favorites).where("listingId", "==", listingId).get()).docs;
const add = (who: Member, listingId: string) => call<{ favorite: FavoriteView } & ErrorBody>(put, "PUT", `/api/favorites/${listingId}`, { member: who, params: { listingId } });
const heartIds = async (who: Member) => (await call<{ ids: string[] }>(ids, "GET", "/api/favorites/ids", { member: who })).body.ids;
const page = (who: Member) => call<FavoritesPage & ErrorBody>(list, "GET", "/api/favorites", { member: who });

describe("retention-purge and favorites", () => {
  it("deletes every saver's favorite of a purged listing (text, price, cover gone) and its heart, keeps the others", async () => {
    const now = new Date();
    const { id: gone, photo: cover } = await indexedListing("Vélo de course Bianchi à purger", 4200);
    const { id: kept } = await indexedListing("Vélo de ville toujours en ligne", 900);
    const salma = await member();
    const omar = await member();
    for (const [who, listingId] of [[salma, gone], [salma, kept], [omar, gone]] as const) expect((await add(who, listingId)).status).toBe(201);
    // Stored with the listing id the purge query filters on, and the card's text and cover.
    const saved = await favoriteDoc(salma.uid, gone);
    expect(saved.get("listingId")).toBe(gone);
    expect(saved.get("listingSnapshot")).toMatchObject({ title: "Vélo de course Bianchi à purger", price: 4200, photo: { id: cover } });
    // Hearts cached (complete sets), as a browsing session leaves them.
    expect((await heartIds(salma)).sort()).toEqual([gone, kept].sort());
    expect(await heartIds(omar)).toEqual([gone]);

    await engine.remove([gone]);
    await endedPastPurge(gone, now);
    const result = await retentionPurge(now, { store: new MemoryObjectStore() });
    expect(result.failed).toBe(0);
    expect(result.favorites).toBeGreaterThanOrEqual(2);
    expect((await getListingDocument(gone)).get("status")).toBe("purged");

    expect((await favoriteDoc(salma.uid, gone)).exists).toBe(false);
    expect((await favoriteDoc(omar.uid, gone)).exists).toBe(false);
    expect(await favoritesOf(gone)).toEqual([]);
    const salmaPage = await page(salma);
    expect(salmaPage.body.total).toBe(1);
    expect(salmaPage.body.favorites.map((favorite) => favorite.listingId)).toEqual([kept]);
    expect(JSON.stringify(salmaPage.body)).not.toMatch(new RegExp(`Bianchi|${cover}`));
    expect((await page(omar)).body).toMatchObject({ favorites: [], total: 0 });
    // The cached sets followed (no Firestore rebuild: the sentinel is still there).
    expect(await heartIds(salma)).toEqual([kept]);
    expect(await heartIds(omar)).toEqual([]);
    expect((await favoriteDoc(salma.uid, kept)).get("listingSnapshot")).toMatchObject({ title: "Vélo de ville toujours en ligne", price: 900 });

    // Idempotent: the tombstone has no purgeAt, a second run finds nothing more.
    const again = await retentionPurge(new Date(now.getTime() + 1000), { store: new MemoryObjectStore() });
    expect(again.failed).toBe(0);
    expect((await getListingDocument(gone)).get("status")).toBe("purged");
  });

  it("pages the favorites over several transactions, the tombstone with the last one; a held listing keeps them", async () => {
    const now = new Date();
    const { id: crowded } = await indexedListing("Vélo électrique très demandé", 3000);
    const { id: held } = await indexedListing("Vélo pliant sous réquisition", 2500);
    const savers = [await member(), await member(), await member()];
    for (const saver of savers) {
      expect((await add(saver, crowded)).status).toBe(201);
      expect((await add(saver, held)).status).toBe(201);
    }
    await endedPastPurge(crowded, now);
    await endedPastPurge(held, now, { legalHold: ["requisition-2026-02"] });
    const purgeable = (current: Parameters<typeof isPurgeable>[0]) => isPurgeable(current, now);

    const first = await purgeListing(crowded, purgeable, now, 2);
    expect(first).toMatchObject({ tombstone: null });
    expect(first!.favoriteUids).toHaveLength(2);
    expect((await getListing(crowded))?.status).toBe("expired");
    expect(await favoritesOf(crowded)).toHaveLength(1);

    const last = await purgeListing(crowded, purgeable, now, 2);
    expect(last!.tombstone).toMatchObject({ status: "purged" });
    expect(last!.favoriteUids).toHaveLength(1);
    expect(new Set([...first!.favoriteUids, ...last!.favoriteUids])).toEqual(new Set(savers.map((saver) => saver.uid)));
    expect(await favoritesOf(crowded)).toEqual([]);
    expect(await purgeListing(crowded, purgeable, now)).toBeNull();

    expect(await purgeListing(held, purgeable, now)).toBeNull();
    expect(await favoritesOf(held)).toHaveLength(savers.length);
  });

  it("still reads a favorite stored before listingId was (the document id stands in)", async () => {
    const salma = await member();
    const listingId = "ab23cd45";
    const snapshot = { slugId: `ancien-velo-${listingId}`, title: "Ancien vélo", subcategoryId: "velos", price: 300, priceNegotiable: false, isDonation: false, citySlug: "fes", photo: null, photoCount: 0, sellerType: "individual" };
    await db().collection(COLLECTIONS.users).doc(salma.uid).collection(COLLECTIONS.favorites).doc(listingId).set({ createdAt: Timestamp.fromDate(new Date()), listingSnapshot: snapshot });
    const result = await page(salma);
    expect(result.body.favorites).toMatchObject([{ listingId, available: false, card: { id: listingId, title: "Ancien vélo" } }]);
  });
});
