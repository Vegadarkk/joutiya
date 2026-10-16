import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Saved-search alerts on the emulator with the memory engine (design D19, D20): the collection
// group pages and account-boundary cursors of the job on real Firestore, one digest per account
// with its new listings, the cursors moved so nothing is sent twice, the rotation from a stored
// account (system/savedSearchAlerts), and the one-click unsubscribe
// (RFC 8058 POST with ?t=, or { token } from the confirm page): no session, no Origin, no CSRF,
// signed token only, idempotent, limited per IP, no GET.

vi.mock("@/lib/mail/deliver", () => ({ deliverMail: vi.fn(async () => ({ provider: "memory", id: "test" })) }));

import * as unsubscribeRoute from "@/app/api/alerts/unsubscribe/route";
import { POST as create } from "@/app/api/saved-searches/route";
import { describeUnsubscribe } from "@/lib/alerts/handlers";
import { unsubscribeToken, verifyUnsubscribeToken } from "@/lib/alerts/unsubscribe-token";
import type { SavedSearchView } from "@/lib/contracts/search";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { deliverMail } from "@/lib/mail/deliver";
import type { TemplateMail } from "@/lib/mail/types";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { accountEndPath, listDailySearches } from "@/lib/saved-searches/repository";
import { setSearchEngineForTests } from "@/lib/search/engine";
import type { MemoryEngine } from "@/lib/search/memory";
import { sendSavedSearchAlerts } from "@/worker/jobs/saved-search-alerts";
import { call, doc, expectError, member, serve, spend, type ErrorBody, type Member } from "../favorites/helpers";

const { POST: unsubscribe } = unsubscribeRoute;
type SearchBody = { search: SavedSearchView } & ErrorBody;

const HOUR = 3_600_000;
let engine: MemoryEngine;
// Words no other test file indexes or saves: the job also walks their daily searches.
const commode = doc({ title: "Commode marqueterie", categoryId: "maison", subcategoryId: "ameublement", citySlug: "fes", price: 4200, sortAt: Date.now() - 48 * HOUR });

const save = async (who: Member, q: string, alert: "daily" | "none" = "daily") => {
  const result = await call<SearchBody>(create, "POST", "/api/saved-searches", { member: who, body: { params: { q }, alert } });
  expect(result.status).toBe(201);
  return result.body.search;
};
const searchDoc = (who: Member, id: string) => db().collection(COLLECTIONS.users).doc(who.uid).collection(COLLECTIONS.savedSearches).doc(id).get();
const alertOf = async (who: Member, id: string) => (await searchDoc(who, id)).get("alert") as string;
const mailsTo = (who: Member): TemplateMail[] => vi.mocked(deliverMail).mock.calls.map(([mail]) => mail as TemplateMail).filter((mail) => mail.to === who.email);
const digest = (mail: TemplateMail | undefined) => (mail?.template === "savedSearchAlert" ? (mail as TemplateMail<"savedSearchAlert">) : undefined);
const oneClick = (token: string, ip?: string) =>
  call<ErrorBody>(unsubscribe, "POST", `/api/alerts/unsubscribe?t=${encodeURIComponent(token)}`, { origin: null, rawBody: { text: "List-Unsubscribe=One-Click", type: "application/x-www-form-urlencoded" }, ...(ip ? { ip } : {}) });
const confirmPost = (body: unknown) => call<ErrorBody>(unsubscribe, "POST", "/api/alerts/unsubscribe", { body });

beforeAll(async () => {
  resetServerEnv();
  engine = await serve([commode]);
});
beforeEach(() => {
  resetRateLimiters();
  vi.mocked(deliverMail).mockClear();
});
afterAll(() => setSearchEngineForTests(null));

describe("daily searches in the collection group", () => {
  it("pages in path order and cuts at an account boundary, both ways", async () => {
    const [a, b] = [await member(), await member()].sort((x, y) => (x.uid < y.uid ? -1 : 1)) as [Member, Member];
    const aIds = [(await save(a, "armoire ancienne")).id, (await save(a, "buffet ancien")).id];
    await save(a, "chevet ancien", "none");
    const bIds = [(await save(b, "armoire ancienne")).id];
    const mine = (rows: { uid: string; id: string }[]) => rows.filter((row) => row.uid === a.uid || row.uid === b.uid).map((row) => `${row.uid}/${row.id}`);

    const all = await listDailySearches({ limit: 1000 });
    expect(mine(all.searches)).toEqual([...aIds.sort().map((id) => `${a.uid}/${id}`), `${b.uid}/${bIds[0]}`]);
    expect(mine((await listDailySearches({ afterPath: accountEndPath(a.uid), limit: 1000 })).searches)).toEqual([`${b.uid}/${bIds[0]}`]);
    expect(mine((await listDailySearches({ endAtPath: accountEndPath(a.uid), limit: 1000 })).searches)).toEqual(aIds.sort().map((id) => `${a.uid}/${id}`));
    const firstOfA = await listDailySearches({ afterPath: `users/${a.uid}/savedSearches/${aIds.sort()[0]}`, endAtPath: accountEndPath(a.uid), limit: 1 });
    expect(firstOfA.read).toBe(1);
    expect(firstOfA.lastPath).toBe(`users/${a.uid}/savedSearches/${aIds.sort()[1]}`);
  });
});

describe("sendSavedSearchAlerts", () => {
  it("sends one digest per account with new listings, then nothing until newer ones", async () => {
    await db().collection(COLLECTIONS.system).doc("savedSearchAlerts").delete();
    const salma = await member();
    const karim = await member();
    const commodes = await save(salma, "commode");
    const tables = await save(salma, "table marqueterie");
    const quiet = await save(karim, "commode", "none");
    // Saved after the commode was indexed: only listings indexed later are news.
    const now = Date.now();
    const fresh = [
      doc({ title: "Commode en cedre", categoryId: "maison", subcategoryId: "ameublement", citySlug: "fes", price: 3500, sortAt: now - 2 * 60_000 }),
      doc({ title: "Petite commode", categoryId: "maison", subcategoryId: "ameublement", citySlug: "rabat", isDonation: true, sortAt: now - 60_000 }),
      doc({ title: "Table marqueterie", categoryId: "maison", subcategoryId: "ameublement", citySlug: "marrakech", sortAt: now - 30_000 }),
    ];
    await engine.upsert(fresh);
    // Past the indexing delay: the run sends listings older than 5 min only.
    const runAt = now + 10 * 60_000;
    try {
      const result = await sendSavedSearchAlerts(new Date(runAt));
      expect(result.complete).toBe(true);
      const [first, ...others] = mailsTo(salma);
      expect(others).toEqual([]);
      expect(mailsTo(karim)).toEqual([]);
      const mail = digest(first);
      if (!mail) throw new Error("no digest");
      expect(mail).toMatchObject({ locale: "fr", priority: "bulk", idempotencyKey: expect.stringMatching(new RegExp(`^savedSearchAlert-${salma.uid}-\\d{8}$`)) });
      expect(mail.data.searches.map((section) => [section.name, section.total, section.listings.map((listing) => listing.title)])).toEqual([
        ["table marqueterie", 1, ["Table marqueterie"]],
        ["commode", 2, ["Petite commode", "Commode en cedre"]],
      ]);
      expect(mail.data.searches[1]?.listings[0]).toMatchObject({ isDonation: true, citySlug: "rabat", url: `http://localhost:3000/fr/annonce/${fresh[1]!.slugId}` });
      expect(verifyUnsubscribeToken(mail.data.unsubscribeToken)).toEqual({ uid: salma.uid, searchId: "*" });
      const cursor = await searchDoc(salma, commodes.id);
      expect(cursor.get("lastNotifiedSortAt")).toBe(now - 60_000);
      expect(cursor.get("lastAlertAt")?.toMillis()).toBe(runAt);
      expect((await searchDoc(karim, quiet.id)).get("lastAlertAt")).toBeUndefined();

      vi.mocked(deliverMail).mockClear();
      await sendSavedSearchAlerts(new Date(now + HOUR));
      expect(mailsTo(salma)).toEqual([]);
      await engine.upsert([doc({ title: "Commode laquee", categoryId: "maison", subcategoryId: "ameublement", citySlug: "fes", sortAt: now + 30 * 60_000 })]);
      await sendSavedSearchAlerts(new Date(now + 2 * HOUR));
      const [next] = mailsTo(salma);
      expect(digest(next)?.data.searches.map((section) => section.name)).toEqual(["commode"]);
      expect((await searchDoc(salma, tables.id)).get("lastNotifiedSortAt")).toBe(now - 30_000);

      // Unsubscribed: the next listings stay out of the mailbox.
      expect((await oneClick(unsubscribeToken(salma.uid))).status).toBe(204);
      await engine.upsert([doc({ title: "Commode doree", categoryId: "maison", subcategoryId: "ameublement", citySlug: "fes", sortAt: now + 90 * 60_000 })]);
      vi.mocked(deliverMail).mockClear();
      await sendSavedSearchAlerts(new Date(now + 3 * HOUR));
      expect(mailsTo(salma)).toEqual([]);
    } finally {
      await db().collection(COLLECTIONS.system).doc("savedSearchAlerts").delete();
    }
  });
});

describe("rotation from a stored account", () => {
  it("starts after the stored account, wraps around to it, then clears the cursor", async () => {
    const cursorDoc = db().collection(COLLECTIONS.system).doc("savedSearchAlerts");
    const [first, second] = [await member(), await member()].sort((x, y) => (x.uid < y.uid ? -1 : 1)) as [Member, Member];
    await save(first, "gueridon fer forge");
    await save(second, "gueridon fer forge");
    const now = Date.now();
    await engine.upsert([doc({ title: "Gueridon fer forge", categoryId: "maison", subcategoryId: "ameublement", citySlug: "fes", sortAt: now + 60_000 })]);
    // A capped run stopped after `first`: the next one starts with the accounts after it.
    await cursorDoc.set({ afterUid: first.uid });
    try {
      const result = await sendSavedSearchAlerts(new Date(now + HOUR));
      expect(result).toMatchObject({ complete: true });
      expect(result.stopped).toBeUndefined();
      const order = vi.mocked(deliverMail).mock.calls.map(([mail]) => mail.to).filter((to) => to === first.email || to === second.email);
      expect(order).toEqual([second.email, first.email]);
      expect((await cursorDoc.get()).get("afterUid")).toBe("");
    } finally {
      await cursorDoc.delete();
    }
  });
});

describe("POST /api/alerts/unsubscribe", () => {
  it("one-click (RFC 8058): ?t= with the form body, no session, no Origin, every alert of the account", async () => {
    const salma = await member();
    const first = await save(salma, "armoire normande");
    const second = await save(salma, "vaisselier");
    const result = await oneClick(unsubscribeToken(salma.uid));
    expect(result.status).toBe(204);
    expect(result.header("cache-control")).toBe("no-store");
    expect([await alertOf(salma, first.id), await alertOf(salma, second.id)]).toEqual(["none", "none"]);
    expect((await oneClick(unsubscribeToken(salma.uid))).status).toBe(204);
  });

  it("confirm page: { token } of one search turns that alert off only, idempotently", async () => {
    const salma = await member();
    const first = await save(salma, "fauteuil club");
    const second = await save(salma, "bibliotheque chene");
    const token = unsubscribeToken(salma.uid, first.id);
    expect(await describeUnsubscribe(token)).toEqual({ kind: "one", name: "fauteuil club", active: true });
    expect((await confirmPost({ token })).status).toBe(204);
    expect([await alertOf(salma, first.id), await alertOf(salma, second.id)]).toEqual(["none", "daily"]);
    expect(await describeUnsubscribe(token)).toEqual({ kind: "one", name: "fauteuil club", active: false });
    expect((await confirmPost({ token })).status).toBe(204);
    // A search deleted since the e-mail: nothing to do, same answer.
    await searchDoc(salma, first.id).then((snapshot) => snapshot.ref.delete());
    expect(await describeUnsubscribe(token)).toEqual({ kind: "gone" });
    expect((await confirmPost({ token })).status).toBe(204);
    expect(await describeUnsubscribe(unsubscribeToken(salma.uid))).toEqual({ kind: "all" });
  });

  it("refuses a forged, tampered or missing token, and has no GET", async () => {
    const salma = await member();
    const search = await save(salma, "miroir soleil");
    const token = unsubscribeToken(salma.uid);
    const [payload, sig] = token.split(".") as [string, string];
    const other = Buffer.from(`v1.${salma.uid}x.*`).toString("base64url");
    expectError(await oneClick(`${other}.${sig}`), 400, "invalid_token");
    expectError(await oneClick(`${payload}.${sig.slice(0, -2)}AA`), 400, "invalid_token");
    expectError(await oneClick("short"), 400, "invalid_token");
    expectError(await confirmPost({}), 400, "invalid_body");
    expectError(await confirmPost({ token: `${payload}.${"A".repeat(43)}` }), 400, "invalid_token");
    expect(await describeUnsubscribe("garbage-token-of-some-length")).toEqual({ kind: "invalid" });
    expect(await describeUnsubscribe(undefined)).toEqual({ kind: "invalid" });
    expect(await alertOf(salma, search.id)).toBe("daily");
    expect("GET" in unsubscribeRoute).toBe(false);
  });

  it("limits attempts per IP (alerts.unsubscribe.ip) before checking the token", async () => {
    const ip = "10.97.3.4";
    await spend("alerts.unsubscribe.ip", requestIdentity(new Headers({ "x-forwarded-for": ip })).ipBucket);
    const limited = await oneClick("whatever-token-value", ip);
    expectError(limited, 429, "rate_limited");
    expect(Number(limited.header("retry-after"))).toBeGreaterThan(0);
    expectError(await oneClick("whatever-token-value", "172.16.5.5"), 400, "invalid_token");
  });
});
