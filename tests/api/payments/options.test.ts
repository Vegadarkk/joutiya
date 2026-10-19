import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeModule from "@/lib/config/runtime";
import type * as BoostsModule from "@/lib/search/boosts";

// Paid listing options (phase 7 design §5, §10): the sales gate, the purchase transaction (plan
// credits first, then the balance; the À la Une allowance), idempotent retries, insufficient and
// frozen wallets, someone else's listing (IDOR), a listing that cannot be promoted, the shop's
// wallet paid by its owner only, and the wallet read.

const flags = vi.hoisted(() => ({ salesEnabled: true, proSignupEnabled: true, paymentInstallmentsEnabled: false }));
vi.mock("@/lib/config/runtime", async (importOriginal) => ({ ...(await importOriginal<typeof RuntimeModule>()), getFlags: vi.fn(async () => ({ ...flags })) }));
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/search/boosts", async (importOriginal) => ({ ...(await importOriginal<typeof BoostsModule>()), scheduleBoostExpiry: vi.fn(async () => true) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as pause } from "@/app/api/listings/[id]/pause/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { GET as options, POST as buy } from "@/app/api/listings/[id]/options/route";
import { GET as wallet } from "@/app/api/wallet/route";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import type { BuyOptionResponse, ListingOptionsResponse, WalletResponse } from "@/lib/contracts/payments";
import { getListing, updateListing } from "@/lib/db/repositories/listings";
import { getSearchOutbox } from "@/lib/db/repositories/search-outbox";
import { getWallet, ledgerRef, setWallet } from "@/lib/db/repositories/wallets";
import type { WalletDoc } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { scheduleBoostExpiry } from "@/lib/search/boosts";
import { csrfToken } from "@/lib/security/csrf";
import { DAY_MS, api, member, readyPatch, seedReadyUpload, type ErrorBody, type Member } from "../listings/helpers";

beforeAll(() => resetServerEnv());
beforeEach(() => {
  resetRateLimiters();
  flags.salesEnabled = true;
  vi.mocked(scheduleBoostExpiry).mockClear();
});

const HOUR_MS = 60 * 60 * 1000;
const code = (body: unknown) => (body as ErrorBody).error.code;

/** A published bicycle listing (category vehicules: the higher price tier), sorted two hours ago. */
async function published(owner: Member): Promise<string> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  const id = created.body.id;
  expect((await api(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch() })).status).toBe(200);
  const upload = await seedReadyUpload(owner, id);
  expect((await api(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [upload] } })).status).toBe(200);
  expect((await api(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } })).body).toMatchObject({ status: "published" });
  await updateListing(id, { sortAt: new Date(Date.now() - 2 * HOUR_MS) });
  return id;
}

async function fund(accountId: string, wallet: Partial<WalletDoc>): Promise<void> {
  const now = new Date();
  await setWallet(accountId, { balance: 0, frozen: false, planCredits: 0, allowances: { featured: 0 }, createdAt: now, updatedAt: now, ...wallet });
}

const order = (optionId: string, requestId: string = randomUUID()) => ({ optionId, requestId, acceptTerms: true, immediateExecutionConsent: true });
const purchase = (owner: Member, id: string, body: unknown) => api<BuyOptionResponse & ErrorBody>(buy, "POST", `/api/listings/${id}/options`, { member: owner, body });

describe("buying an option", () => {
  it("is refused while sales are closed, before any debit", async () => {
    const owner = await member();
    const id = await published(owner);
    await fund(owner.uid, { balance: 100 });
    flags.salesEnabled = false;
    const result = await purchase(owner, id, order("bump"));
    expect(result.status).toBe(403);
    expect(code(result.body)).toBe("sales_closed");
    expect((await getWallet(owner.uid))?.balance).toBe(100);
  });

  it("bumps the listing, spends the plan's credits first, records the consent and replays a retry", async () => {
    const owner = await member();
    const id = await published(owner);
    await fund(owner.uid, { balance: 50, planCredits: 5, planCreditsResetsAt: new Date(Date.now() + 10 * DAY_MS) });
    const before = await getListing(id);
    const requestId = randomUUID();

    const result = await purchase(owner, id, order("bump", requestId));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ optionId: "bump", replayed: false, cost: { planCredits: 5, credits: 15, allowance: 0 }, wallet: { balance: 35, planCredits: 0, frozen: false } });

    const listing = await getListing(id);
    expect(listing?.sortSource).toBe("bump");
    expect(listing?.version).toBe(before!.version + 1);
    expect(Math.abs(listing!.sortAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(listing?.boosts.bumpedAt).toBeInstanceOf(Date);
    expect(await getSearchOutbox(id)).toMatchObject({ op: "upsert", version: listing!.version });
    const entry = (await ledgerRef(owner.uid, `option_${id}_${requestId}`).get()).data();
    expect(entry).toMatchObject({ reason: "option", delta: -15, planCreditsDelta: -5, price: 20, balanceAfter: 35, refs: { listingId: id, optionId: "bump", requestId }, consent: { version: "2026-10" }, actorUid: owner.uid });

    // The same request again (a lost answer): nothing debited twice, nothing bumped again.
    const replay = await purchase(owner, id, order("bump", requestId));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, cost: { planCredits: 5, credits: 15 }, wallet: { balance: 35 } });
    expect((await getListing(id))?.version).toBe(listing!.version);
    // The same request id for another option is a client bug, never a second purchase.
    const reused = await purchase(owner, id, order("featured7", requestId));
    expect(reused.status).toBe(409);
    expect(code(reused.body)).toBe("conflict");
  });

  it("refuses a bump while the listing is at the top already", async () => {
    const owner = await member();
    const id = await published(owner);
    await updateListing(id, { sortAt: new Date(Date.now() - 10 * 60 * 1000) });
    await fund(owner.uid, { balance: 100 });
    const offer = await api<ListingOptionsResponse>(options, "GET", `/api/listings/${id}/options`, { member: owner });
    expect(Date.parse(offer.body.options.find((option) => option.id === "bump")!.availableAt!)).toBeGreaterThan(Date.now());
    expect(offer.body.options.find((option) => option.id === "featured7")!.availableAt).toBeNull();
    const result = await purchase(owner, id, order("bump"));
    expect(result.status).toBe(409);
    expect(code(result.body)).toBe("bump_too_soon");
    expect((await getWallet(owner.uid))?.balance).toBe(100);
  });

  it("puts the listing À la Une with the plan's allowance, then extends it with credits", async () => {
    const owner = await member();
    const id = await published(owner);
    await fund(owner.uid, { balance: 200, allowances: { featured: 1, resetsAt: new Date(Date.now() + 10 * DAY_MS) } });

    const first = await purchase(owner, id, order("featured7"));
    expect(first.status).toBe(200);
    expect(first.body.cost).toEqual({ planCredits: 0, credits: 0, allowance: 1 });
    expect(first.body.wallet).toMatchObject({ balance: 200, featuredAllowance: 0 });
    const until = Date.parse(first.body.boosts.featuredUntil!);
    expect(Math.abs(until - (Date.now() + 7 * DAY_MS))).toBeLessThan(60_000);
    expect(vi.mocked(scheduleBoostExpiry)).toHaveBeenCalledWith(id, new Date(until), expect.any(Date));
    expect((await getListing(id))?.sortSource).toBe("publish");

    // 30 more days from the current end, at the vehicles price.
    const second = await purchase(owner, id, order("featured30"));
    expect(second.status).toBe(200);
    expect(second.body.cost).toEqual({ planCredits: 0, credits: 149, allowance: 0 });
    expect(Date.parse(second.body.boosts.featuredUntil!) - until).toBe(30 * DAY_MS);
    expect((await getWallet(owner.uid))?.balance).toBe(51);
  });

  it("answers 402 when the credits do not cover the price; expired plan credits do not count", async () => {
    const owner = await member();
    const id = await published(owner);
    await fund(owner.uid, { balance: 10, planCredits: 100, planCreditsResetsAt: new Date(Date.now() - DAY_MS) });
    const before = await getListing(id);
    const result = await purchase(owner, id, order("featured7"));
    expect(result.status).toBe(402);
    expect(code(result.body)).toBe("insufficient_credits");
    expect(await getWallet(owner.uid)).toMatchObject({ balance: 10, planCredits: 100 });
    expect((await getListing(id))?.version).toBe(before!.version);
  });

  it("refuses a frozen wallet, a paused listing and someone else's listing", async () => {
    const owner = await member();
    const id = await published(owner);
    await fund(owner.uid, { balance: -29, frozen: true });
    const frozen = await purchase(owner, id, order("featured7"));
    expect(frozen.status).toBe(409);
    expect(code(frozen.body)).toBe("wallet_frozen");

    await fund(owner.uid, { balance: 100 });
    expect((await api(pause, "POST", `/api/listings/${id}/pause`, { member: owner })).status).toBe(200);
    const paused = await purchase(owner, id, order("featured7"));
    expect(paused.status).toBe(409);
    expect(code(paused.body)).toBe("listing_not_promotable");

    const stranger = await member();
    await fund(stranger.uid, { balance: 100 });
    const idor = await purchase(stranger, id, order("featured7"));
    expect(idor.status).toBe(404);
    expect((await api(options, "GET", `/api/listings/${id}/options`, { member: stranger })).status).toBe(404);
    expect((await getWallet(stranger.uid))?.balance).toBe(100);
    expect((await getWallet(owner.uid))?.balance).toBe(100);
  });

  it("needs both consent boxes and the CSRF header", async () => {
    const owner = await member();
    const id = await published(owner);
    const unticked = await purchase(owner, id, { optionId: "bump", requestId: randomUUID(), acceptTerms: true, immediateExecutionConsent: false });
    expect(unticked.status).toBe(400);
    const priced = await purchase(owner, id, { ...order("bump"), price: 1 });
    expect(priced.status).toBe(400);
    const csrf = await api(buy, "POST", `/api/listings/${id}/options`, { member: owner, body: order("bump"), csrf: false });
    expect(csrf.status).toBe(403);
  });

  it("charges a shop's listing to the shop's wallet, its owner only", async () => {
    const owner = await member();
    const id = await published(owner);
    const proId = "shep2345";
    await updateListing(id, { proId, sellerType: "pro" });
    await fund(`pro_${proId}`, { balance: 100 });
    await fund(owner.uid, { balance: 100 });

    await setClaims(owner.uid, { role: "pro", proId, proRole: "editor" });
    let minted = await createSessionForUid(owner.uid);
    owner.jar.cookies.set("__Host-session", minted.cookie);
    owner.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
    const editor = await purchase(owner, id, order("featured7"));
    expect(editor.status).toBe(403);
    expect(code(editor.body)).toBe("billing_owner_only");

    await setClaims(owner.uid, { role: "pro", proId, proRole: "owner" });
    minted = await createSessionForUid(owner.uid);
    owner.jar.cookies.set("__Host-session", minted.cookie);
    owner.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
    const bought = await purchase(owner, id, order("featured7"));
    expect(bought.status).toBe(200);
    expect((await getWallet(`pro_${proId}`))?.balance).toBe(41);
    expect((await getWallet(owner.uid))?.balance).toBe(100);

    const shopWallet = await api<WalletResponse>(wallet, "GET", "/api/wallet", { member: owner });
    expect(shopWallet.body).toMatchObject({ account: "shop", wallet: { balance: 41 } });
    expect(shopWallet.body.entries.map((entry) => entry.optionId)).toEqual(["featured7"]);
  });
});

describe("reading the options and the wallet", () => {
  it("prices the listing's category and pages the ledger, newest first", async () => {
    const owner = await member();
    const id = await published(owner);
    await fund(owner.uid, { balance: 25 });

    const offer = await api<ListingOptionsResponse>(options, "GET", `/api/listings/${id}/options`, { member: owner });
    expect(offer.status).toBe(200);
    expect(offer.body).toMatchObject({ salesOpen: true, promotable: true, wallet: { balance: 25, planCredits: 0, frozen: false }, consentVersion: "2026-10" });
    expect(offer.body.options.map(({ id: option, price, affordable }) => [option, price, affordable])).toEqual([
      ["bump", 20, true],
      ["featured7", 59, false],
      ["featured30", 149, false],
    ]);

    expect((await purchase(owner, id, order("bump"))).status).toBe(200);
    await updateListing(id, { sortAt: new Date(Date.now() - 2 * HOUR_MS) });
    await fund(owner.uid, { ...(await getWallet(owner.uid)), balance: 25 });
    expect((await purchase(owner, id, order("bump"))).status).toBe(200);

    const first = await api<WalletResponse>(wallet, "GET", "/api/wallet", { member: owner });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ salesOpen: true, account: "personal", wallet: { balance: 5 }, next: null });
    expect(first.body.entries).toHaveLength(2);
    expect(Date.parse(first.body.entries[0]!.at)).toBeGreaterThanOrEqual(Date.parse(first.body.entries[1]!.at));
    expect(first.body.entries[0]).toMatchObject({ reason: "option", optionId: "bump", listingId: id, delta: -20, balanceAfter: 5 });

    const rest = await api<WalletResponse>(wallet, "GET", `/api/wallet?after=${first.body.entries[0]!.id}`, { member: owner });
    expect(rest.body.entries.map((entry) => entry.id)).toEqual([first.body.entries[1]!.id]);

    const bad = await api(wallet, "GET", "/api/wallet?after=../x", { member: owner });
    expect(bad.status).toBe(400);
    const anonymous = await api(wallet, "GET", "/api/wallet");
    expect(anonymous.status).toBe(401);
  });
});
