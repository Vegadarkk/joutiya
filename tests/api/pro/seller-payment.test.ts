import { randomInt } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SellerPaymentsConfig from "@/config/seller-payments";

// « Payer chez le vendeur » (owner decision 2026-10-28, design phase-7/boutique-temporaire.md §2)
// against the emulators: the owner's settings (seller information required, recent sign-in for a
// new link, mail, 24-hour delay, host review), the public click (state, suspension, allowlist and
// click counter checked then), the admin's host review and the moderator's suspension.

const recent = vi.hoisted(() => ({ seconds: 600 }));
vi.mock("@/config/seller-payments", async (importOriginal) => {
  const actual = await importOriginal<typeof SellerPaymentsConfig>();
  return {
    ...actual,
    get PAYMENT_LINK_RECENT_AUTH_SECONDS() {
      return recent.seconds;
    },
  };
});
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));

import { GET as getSettings, PUT as putSettings } from "@/app/api/pro/me/payment/route";
import { POST as openPayment } from "@/app/api/shops/[proId]/payment/route";
import { GET as getHosts, PUT as putHosts } from "@/app/api/admin/seller-payments/route";
import { POST as reviewHost } from "@/app/api/admin/seller-payments/review/route";
import { GET as getShopPayment, POST as postShopPayment } from "@/app/api/admin/pros/[proId]/payment/route";
import { DEFAULT_PRICING } from "@/config/pricing";
import type { OpenPaymentResponse, SellerPaymentsAdminView, SellerPaymentView, ShopPaymentAdminView } from "@/lib/contracts/seller-payment";
import { getListingStats } from "@/lib/db/repositories/listing-stats";
import { getProProfile, proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import { sendMail } from "@/lib/mail";
import type { ProProfileDoc } from "@/lib/pro/profile-schema";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { api, member, type ErrorBody, type Member } from "../listings/helpers";
import { seedListing } from "../messaging/helpers";
import { admin, code, staffAccount } from "./helpers";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newProId = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
const INFO = { address: "12 rue Allal Ben Abdellah, Fès", email: "contact@miel-imouzzer.ma", delivery: "Partout au Maroc en 3 jours, 30 MAD.", returns: "7 jours pour changer d'avis, retour à nos frais." };
const DAY = 86_400_000;

beforeEach(async () => {
  resetRateLimiters();
  recent.seconds = 600;
  vi.mocked(sendMail).mockClear();
  await db().collection("config").doc("sellerPayments").set({ hosts: ["paiement.banque-test.ma"] });
  const { getSellerPayments } = await import("@/lib/config/runtime");
  getSellerPayments.invalidate();
});

async function shop(owner: Member, extra: Partial<ProProfileDoc> = {}): Promise<string> {
  const proId = newProId();
  const now = new Date();
  const profile: ProProfileDoc = {
    ownerUid: owner.uid,
    members: { [owner.uid]: "owner" },
    name: "Miel d'Imouzzer",
    slug: `miel-imouzzer-${proId}`,
    description: "Miel de thym.",
    whatsapp: false,
    regionCode: "03",
    citySlug: "fes",
    legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
    kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
    lifecycle: "active",
    plan: "essentiel",
    planSource: "subscription",
    quotas: DEFAULT_PRICING.pro.essentiel,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  await proProfileRef(proId).set(proProfileToFirestore(profile));
  await setClaims(owner.uid, { role: "pro", proId, proRole: "owner" });
  const minted = await createSessionForUid(owner.uid);
  owner.jar.cookies.set("__Host-session", minted.cookie);
  owner.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return proId;
}

const save = (owner: Member, body: Record<string, unknown>) =>
  api<SellerPaymentView & ErrorBody>(putSettings, "PUT", "/api/pro/me/payment", { member: owner, body: { url: null, cashOnDelivery: false, info: INFO, acceptTerms: true, ...body } });
const open = (proId: string, body: Record<string, unknown> = {}) => api<OpenPaymentResponse & ErrorBody>(openPayment, "POST", `/api/shops/${proId}/payment`, { body, params: { proId } });

/** Moves the pending link's save back by `ms` (the 24-hour delay without a clock). */
async function age(proId: string, ms: number): Promise<void> {
  const profile = await getProProfile(proId);
  await proProfileRef(proId).update({ "sellerPayment.pendingFrom": new Date(profile!.sellerPayment!.pendingFrom!.getTime() - ms) });
}

describe("owner settings", () => {
  it("needs the seller information and the terms to turn the button on, and refuses a malformed link", async () => {
    const owner = await member();
    await shop(owner);
    const missing = await save(owner, { cashOnDelivery: true, info: null });
    expect(missing.status).toBe(422);
    expect(code(missing.body)).toBe("payment_info_required");
    expect(code((await save(owner, { cashOnDelivery: true, acceptTerms: false })).body)).toBe("payment_info_required");
    const http = await save(owner, { url: "http://paiement.banque-test.ma/x" });
    expect(http.status).toBe(422);
    expect(http.body.error.details).toEqual({ problem: "https" });
    expect(code((await save(owner, { url: "https://bit.ly/x" })).body)).toBe("payment_link_invalid");

    const cash = await save(owner, { cashOnDelivery: true });
    expect(cash.status).toBe(200);
    expect(cash.body).toMatchObject({ eligible: true, url: null, cashOnDelivery: true, info: INFO });
    expect(vi.mocked(sendMail)).not.toHaveBeenCalled();
  });

  it("delays a new link 24 hours, mails the owner and needs a recent sign-in", async () => {
    const owner = await member();
    const proId = await shop(owner);
    recent.seconds = -120;
    expect(code((await save(owner, { url: "https://paiement.banque-test.ma/miel" })).body)).toBe("recent_auth_required");
    recent.seconds = 600;

    const saved = await save(owner, { url: "https://paiement.banque-test.ma/miel" });
    expect(saved.status).toBe(200);
    expect(saved.body.url).toBeNull();
    expect(saved.body.pending).toMatchObject({ url: "https://paiement.banque-test.ma/miel", host: "paiement.banque-test.ma", review: false });
    expect(Date.parse(saved.body.pending!.activeFrom!) - Date.now()).toBeGreaterThan(DAY - 60_000);
    expect(vi.mocked(sendMail).mock.calls.at(-1)?.[0]).toMatchObject({ template: "sellerPaymentNotice", data: { kind: "changed", host: "paiement.banque-test.ma" } });
    expect(code((await open(proId)).body)).toBe("payment_unavailable");

    // Saved again unchanged: the delay keeps running, no new mail, no sign-in needed.
    vi.mocked(sendMail).mockClear();
    recent.seconds = -120;
    expect((await save(owner, { url: "https://paiement.banque-test.ma/miel" })).status).toBe(200);
    expect(vi.mocked(sendMail)).not.toHaveBeenCalled();
    recent.seconds = 600;

    await age(proId, DAY);
    const opened = await open(proId);
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({ url: "https://paiement.banque-test.ma/miel", host: "paiement.banque-test.ma", shopName: "Miel d'Imouzzer", ice: "001234567000089" });
    const settings = await api<SellerPaymentView>(getSettings, "GET", "/api/pro/me/payment", { member: owner });
    expect(settings.body).toMatchObject({ url: "https://paiement.banque-test.ma/miel", pending: null });

    // Removal is immediate.
    expect((await save(owner, { url: null })).body).toMatchObject({ url: null, pending: null });
    expect(code((await open(proId)).body)).toBe("payment_unavailable");
    expect(vi.mocked(sendMail).mock.calls.at(-1)?.[0]).toMatchObject({ data: { kind: "removed" } });
  });

  it("is for verified shops with an offer, and for their owner only", async () => {
    const owner = await member();
    await shop(owner, { lifecycle: "downgraded", plan: "none", planSource: "none", quotas: DEFAULT_PRICING.pro.none });
    expect(code((await save(owner, { cashOnDelivery: true })).body)).toBe("pro_not_verified");
    expect((await api<SellerPaymentView>(getSettings, "GET", "/api/pro/me/payment", { member: owner })).body.eligible).toBe(false);
    // Verified once the launch offer is over: no offer, no storefront, no button.
    const verified = await member();
    await shop(verified, { lifecycle: "verified", plan: "none", planSource: "none", quotas: DEFAULT_PRICING.pro.none });
    expect(code((await save(verified, { cashOnDelivery: true })).body)).toBe("pro_not_verified");

    const individual = await member();
    expect((await save(individual, { cashOnDelivery: true })).status).toBe(404);
  });

  it("needs a recent sign-in to change the contact shown to buyers, and tells the owner", async () => {
    const owner = await member();
    await shop(owner);
    expect((await save(owner, { cashOnDelivery: true })).status).toBe(200);
    vi.mocked(sendMail).mockClear();
    recent.seconds = -120;
    // Delivery and returns texts: no sign-in, no mail.
    expect((await save(owner, { cashOnDelivery: true, info: { ...INFO, delivery: "Partout au Maroc en 48 heures, 30 MAD." } })).status).toBe(200);
    expect(vi.mocked(sendMail)).not.toHaveBeenCalled();
    expect(code((await save(owner, { cashOnDelivery: true, info: { ...INFO, email: "autre@exemple.ma" } })).body)).toBe("recent_auth_required");
    recent.seconds = 600;
    expect((await save(owner, { cashOnDelivery: true, info: { ...INFO, email: "autre@exemple.ma" } })).body.info?.email).toBe("autre@exemple.ma");
    expect(vi.mocked(sendMail).mock.calls.at(-1)?.[0]).toMatchObject({ data: { kind: "contact" } });
  });
});

describe("public click", () => {
  it("opens the link of a shop in good standing only, and counts the click on its own published listing", async () => {
    const owner = await member();
    const proId = await shop(owner);
    expect((await save(owner, { url: "https://paiement.banque-test.ma/miel", cashOnDelivery: true })).status).toBe(200);
    await age(proId, DAY);
    const { id: listingId } = await seedListing(owner);
    expect((await open(proId, { listingId })).status).toBe(200);
    expect((await getListingStats(listingId))?.paymentClicks).toBe(1);
    // Same visitor, same listing, same day: counted once.
    expect((await open(proId, { listingId })).status).toBe(200);
    expect((await getListingStats(listingId))?.paymentClicks).toBe(1);
    // Another seller's listing is not counted.
    const other = await member();
    const { id: foreign } = await seedListing(other);
    expect((await open(proId, { listingId: foreign })).status).toBe(200);
    expect((await getListingStats(foreign))?.paymentClicks ?? 0).toBe(0);

    // Downgraded: no button.
    await proProfileRef(proId).update({ lifecycle: "downgraded" });
    expect(code((await open(proId)).body)).toBe("payment_unavailable");
    await proProfileRef(proId).update({ lifecycle: "active" });
    expect((await open(proId)).status).toBe(200);
    // The owner's account suspended: no button either (as for the storefront).
    await db().collection("users").doc(owner.uid).update({ status: "suspended" });
    expect(code((await open(proId)).body)).toBe("payment_unavailable");
    await db().collection("users").doc(owner.uid).update({ status: "active" });
    expect((await open("zzzzzzzz")).status).toBe(404);
    expect((await api(openPayment, "POST", `/api/shops/${proId}/payment`, { body: {}, origin: "https://evil.example", params: { proId } })).status).toBe(403);
  });
});

describe("back office", () => {
  it("reviews a new host: approve lists it, reject drops the links and tells the owner", async () => {
    const adminStaff = await staffAccount("admin");
    const owner = await member();
    const proId = await shop(owner);
    const saved = await save(owner, { url: "https://pay.new-psp.ma/miel" });
    expect(saved.body.pending).toMatchObject({ host: "pay.new-psp.ma", review: true, activeFrom: null });
    expect((await admin<SellerPaymentsAdminView>(getHosts, "GET", "/api/admin/seller-payments", adminStaff)).body.queue).toContainEqual(expect.objectContaining({ proId, host: "pay.new-psp.ma" }));

    // Rejected: the link goes, the owner is told why.
    const rejected = await admin<SellerPaymentsAdminView>(reviewHost, "POST", "/api/admin/seller-payments/review", adminStaff, { host: "pay.new-psp.ma", decision: "reject", reason: "Domaine inconnu de Bank Al-Maghrib." });
    expect(rejected.status).toBe(200);
    expect(rejected.body.queue.some((item) => item.proId === proId)).toBe(false);
    expect((await getProProfile(proId))?.sellerPayment).toMatchObject({ hostRejected: { host: "pay.new-psp.ma" } });
    expect(vi.mocked(sendMail).mock.calls.at(-1)?.[0]).toMatchObject({ data: { kind: "rejected", host: "pay.new-psp.ma" } });

    // Saved again, then approved: listed, active 24 h after the save.
    await save(owner, { url: "https://pay.new-psp.ma/miel" });
    const approved = await admin<SellerPaymentsAdminView>(reviewHost, "POST", "/api/admin/seller-payments/review", adminStaff, { host: "pay.new-psp.ma", decision: "approve" });
    expect(approved.body.hosts).toContain("pay.new-psp.ma");
    expect(approved.body.queue.some((item) => item.proId === proId)).toBe(false);
    await age(proId, DAY);
    expect((await open(proId)).status).toBe(200);
    // Saved again: the matured link is folded in as the active one.
    await save(owner, { url: "https://pay.new-psp.ma/miel", cashOnDelivery: true });
    expect((await getProProfile(proId))?.sellerPayment).toMatchObject({ url: "https://pay.new-psp.ma/miel" });

    // Another shop saves a link to the now listed host: no review needed.
    const second = await member();
    const secondId = await shop(second);
    expect((await save(second, { url: "https://pay.new-psp.ma/argan" })).body.pending).toMatchObject({ review: false });

    // Taken off the list: every button to it is hidden, the waiting link goes back to the queue.
    const hosts = await admin<SellerPaymentsAdminView>(putHosts, "PUT", "/api/admin/seller-payments", adminStaff, { hosts: ["paiement.banque-test.ma"] });
    expect(hosts.body.hosts).toEqual(["paiement.banque-test.ma"]);
    expect(hosts.body.queue).toContainEqual(expect.objectContaining({ proId: secondId, host: "pay.new-psp.ma" }));
    expect(code((await open(proId)).body)).toBe("payment_unavailable");
    // The owner still sees the saved link, and saving other settings keeps it.
    const kept = await api<SellerPaymentView>(getSettings, "GET", "/api/pro/me/payment", { member: owner });
    expect(kept.body).toMatchObject({ url: null, storedUrl: "https://pay.new-psp.ma/miel" });
    recent.seconds = -120;
    expect((await save(owner, { url: "https://pay.new-psp.ma/miel", cashOnDelivery: true })).status).toBe(200);
    recent.seconds = 600;
    expect((await getProProfile(proId))?.sellerPayment?.url).toBe("https://pay.new-psp.ma/miel");
    expect((await admin<ErrorBody>(putHosts, "PUT", "/api/admin/seller-payments", adminStaff, { hosts: ["*.psp.ma"] })).status).toBe(400);
  });

  it("lets a moderator suspend and restore a shop's button, listings untouched", async () => {
    const moderator = await staffAccount("moderator");
    const owner = await member();
    const proId = await shop(owner);
    await save(owner, { url: "https://paiement.banque-test.ma/miel" });
    await age(proId, DAY);
    const suspended = await admin<ShopPaymentAdminView>(postShopPayment, "POST", `/api/admin/pros/${proId}/payment`, moderator, { action: "suspend", reason: "Signalé : page de paiement d'un autre vendeur." });
    expect(suspended.body.suspended).toMatchObject({ reason: "Signalé : page de paiement d'un autre vendeur." });
    expect(code((await open(proId)).body)).toBe("payment_unavailable");
    expect((await api<SellerPaymentView>(getSettings, "GET", "/api/pro/me/payment", { member: owner })).body.suspended).not.toBeNull();
    expect(vi.mocked(sendMail).mock.calls.at(-1)?.[0]).toMatchObject({ data: { kind: "suspended" } });

    await admin(postShopPayment, "POST", `/api/admin/pros/${proId}/payment`, moderator, { action: "restore", reason: "Vérifié avec la boutique." });
    expect((await open(proId)).status).toBe(200);
    expect((await admin<ShopPaymentAdminView>(getShopPayment, "GET", `/api/admin/pros/${proId}/payment`, moderator)).body.suspended).toBeNull();
    // Hosts are for admins only.
    expect((await admin(getHosts, "GET", "/api/admin/seller-payments", moderator)).status).toBe(403);
  });
});
