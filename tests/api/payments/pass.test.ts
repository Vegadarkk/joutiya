import { createHmac, randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeModule from "@/lib/config/runtime";
import type * as RevenueCatApiModule from "@/lib/payments/revenuecat-api";
import type * as StripeApiModule from "@/lib/payments/stripe-api";
import type * as QuotaModule from "@/lib/quota";

// Pass Boutique (owner decision 2026-10-28, design phase-7/boutique-temporaire.md §1): the plan page
// offers it, its Stripe Checkout (payment mode, invoice, sales gate, never over a subscription or the
// free launch offer, never beyond maxAheadDays), the webhook that applies a paid session once
// (lifecycle, end, plan credits) and extends a running pass, a subscription taken during a pass
// (trial until its end), and the nightly end (notices, downgrade, listings paused).

const flags = vi.hoisted(() => ({ salesEnabled: true, proSignupEnabled: true, paymentInstallmentsEnabled: false }));
const offer = vi.hoisted(() => ({ endsAt: null as string | null }));
const stripe = vi.hoisted(() => ({
  calls: [] as { method: string; path: string; params: Record<string, unknown>; idempotencyKey?: string }[],
  /** Checkout Sessions read back by id (the webhook re-reads a pass session). */
  sessions: {} as Record<string, Record<string, unknown>>,
}));

vi.mock("@/lib/config/runtime", async (importOriginal) => {
  const { DEFAULT_PRICING } = await import("@/config/pricing");
  const plans = {
    ...DEFAULT_PRICING.plans,
    essentiel: { ...DEFAULT_PRICING.plans.essentiel, stripePrices: { monthly: "price_EssentielMonthly", yearly: "price_EssentielYearly" } },
    business: { ...DEFAULT_PRICING.plans.business, stripePrices: { monthly: "price_BusinessMonthly", yearly: "price_BusinessYearly" } },
  };
  const passes = DEFAULT_PRICING.passes.map((pass) => ({ ...pass, stripePrice: "price_PassBoutique30" }));
  return {
    ...(await importOriginal<typeof RuntimeModule>()),
    getFlags: vi.fn(async () => ({ ...flags })),
    getPricing: vi.fn(async () => ({ ...DEFAULT_PRICING, plans, passes, launchOffer: { ...DEFAULT_PRICING.launchOffer, endsAt: offer.endsAt } })),
  };
});
vi.mock("@/lib/payments/revenuecat-api", async (importOriginal) => ({
  ...(await importOriginal<typeof RevenueCatApiModule>()),
  listCustomerSubscriptions: vi.fn(async () => []),
  postStripeReceipt: vi.fn(async () => undefined),
}));
vi.mock("@/lib/payments/stripe-api", async (importOriginal) => ({
  ...(await importOriginal<typeof StripeApiModule>()),
  stripeRequest: vi.fn(async (method: string, path: string, params: Record<string, unknown> = {}, options: { idempotencyKey?: string } = {}) => {
    stripe.calls.push({ method, path, params, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) });
    if (path === "/v1/customers") return { id: `cus_${options.idempotencyKey?.split("_").pop()}` };
    if (path.startsWith("/v1/customers/")) return { id: path.split("/").pop() };
    if (path === "/v1/checkout/sessions") return { id: `cs_test_${stripe.calls.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${stripe.calls.length}` };
    if (path.endsWith("/expire")) return { status: "expired" };
    if (path.startsWith("/v1/checkout/sessions/")) return stripe.sessions[decodeURIComponent(path.split("/").pop()!)] ?? { status: "open" };
    throw new Error(`unexpected Stripe call ${method} ${path}`);
  }),
}));
vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof QuotaModule>()), headroom: vi.fn(async () => null) }));

import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { POST as checkout } from "@/app/api/billing/checkout/route";
import { POST as passCheckout } from "@/app/api/billing/pass/route";
import { GET as subscriptionPage } from "@/app/api/billing/subscription/route";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { DEFAULT_PRICING } from "@/config/pricing";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import type { BillingRedirectResponse, SubscriptionResponse } from "@/lib/contracts/payments";
import { alert } from "@/lib/alert";
import { getBillingAccount } from "@/lib/db/repositories/billing";
import { getListing } from "@/lib/db/repositories/listings";
import { getProProfile, proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { getWallet, ledgerRef } from "@/lib/db/repositories/wallets";
import { resetServerEnv } from "@/lib/env";
import { sendMail } from "@/lib/mail";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import type { ProProfileDoc } from "@/lib/pro/profile-schema";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { proPlansNightly } from "@/worker/jobs/pro-plans";
import { DAY_MS, api, member, readyPatch, seedReadyUpload, type ErrorBody, type Member } from "../listings/helpers";

const STRIPE_SECRET = "whsec_test_secret";
const VARS = { STRIPE_SECRET_KEY: "sk_test_joutiya", STRIPE_WEBHOOK_SECRET: STRIPE_SECRET, REVENUECAT_SECRET_API_KEY: "sk-test", REVENUECAT_PROJECT_ID: "proj-test" };

beforeAll(() => {
  Object.assign(process.env, VARS);
  resetServerEnv();
});
afterAll(() => {
  for (const name of Object.keys(VARS)) delete process.env[name];
  resetServerEnv();
});
beforeEach(() => {
  resetRateLimiters();
  flags.salesEnabled = true;
  // The launch offer has ended: the shops are downgraded and may buy a pass.
  offer.endsAt = new Date(Date.now() - DAY_MS).toISOString();
  stripe.calls = [];
  stripe.sessions = {};
  vi.mocked(alert).mockClear();
  vi.mocked(sendMail).mockClear();
});

const code = (body: unknown) => (body as ErrorBody).error.code;
const PRO_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newProId = () => Array.from({ length: 8 }, () => PRO_ID_ALPHABET[randomInt(PRO_ID_ALPHABET.length)]).join("");

async function signIn(owner: Member, claims: Parameters<typeof setClaims>[1]): Promise<void> {
  await setClaims(owner.uid, claims);
  const minted = await createSessionForUid(owner.uid);
  owner.jar.cookies.set("__Host-session", minted.cookie);
  owner.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
}

/** A verified shop whose launch offer ended (downgraded), signed in as its owner. */
async function shop(owner: Member, extra: Partial<ProProfileDoc> = {}): Promise<string> {
  const proId = newProId();
  const now = new Date();
  const profile: ProProfileDoc = {
    ownerUid: owner.uid,
    members: { [owner.uid]: "owner" },
    name: "Miel d'Imouzzer",
    slug: `miel-imouzzer-${proId}`,
    description: "Miel de thym et huile d'olive de la coopérative.",
    whatsapp: false,
    regionCode: "03",
    citySlug: "fes",
    legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
    kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
    lifecycle: "downgraded",
    plan: "none",
    planSource: "none",
    downgradedAt: now,
    quotas: DEFAULT_PRICING.pro.none,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  await proProfileRef(proId).set(proProfileToFirestore(profile));
  await signIn(owner, { role: "pro", proId, proRole: "owner" });
  return proId;
}

const buyPass = (owner: Member, body: unknown = { pass: "boutique30", acceptTerms: true, locale: "fr" }) => api<BillingRedirectResponse & ErrorBody>(passCheckout, "POST", "/api/billing/pass", { member: owner, body });
const page = async (owner: Member) => (await api<SubscriptionResponse>(subscriptionPage, "GET", "/api/billing/subscription", { member: owner })).body;

async function stripeDeliver(type: string, object: Record<string, unknown>) {
  const event = { id: `evt_${randomUUID().replace(/-/g, "")}`, object: "event", type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object } };
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", STRIPE_SECRET).update(`${t}.${JSON.stringify(event)}`).digest("hex");
  return api<ErrorBody>(stripeWebhook, "POST", "/api/webhooks/stripe", { body: event, origin: null, headers: { "stripe-signature": `t=${t},v1=${signature}` } });
}

/** Pays the last pass session opened for `proId` (Stripe's answer, then its webhook). */
async function pay(proId: string, passId = "boutique30"): Promise<string> {
  const account = await getBillingAccount(`pro_${proId}`);
  const sessionId = account!.lastPassCheckout!.sessionId!;
  const metadata = { accountId: `pro_${proId}`, app_user_id: account!.rcAppUserId, env: "dev", kind: "pass", passId };
  stripe.sessions[sessionId] = { id: sessionId, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", metadata };
  const delivered = await stripeDeliver("checkout.session.completed", { id: sessionId, object: "checkout.session", mode: "payment", customer: account!.stripeCustomerId, metadata });
  expect(delivered.status).toBe(200);
  return sessionId;
}

const daysFromNow = (date: Date | undefined) => Math.round(((date?.getTime() ?? 0) - Date.now()) / DAY_MS);

async function published(owner: Member): Promise<string> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  const id = created.body.id;
  expect((await api(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: readyPatch() })).status).toBe(200);
  const upload = await seedReadyUpload(owner, id);
  expect((await api(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [upload] } })).status).toBe(200);
  expect((await api(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } })).body).toMatchObject({ status: "published" });
  return id;
}

describe("pass checkout", () => {
  it("offers the pass and opens a one-time Stripe Checkout with an invoice", async () => {
    const owner = await member();
    const proId = await shop(owner);
    const before = await page(owner);
    expect(before).toMatchObject({ planSource: "none", passEndsAt: null, passConsentVersion: "2026-10" });
    expect(before.passes).toEqual([{ id: "boutique30", plan: "essentiel", days: 30, priceMinor: 24_900, credits: 30, activeListings: 50, available: true, withinLimit: true, otherPlan: false }]);

    const opened = await buyPass(owner);
    expect(opened.status).toBe(200);
    expect(opened.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const session = stripe.calls.find((call) => call.path === "/v1/checkout/sessions")!;
    const account = await getBillingAccount(`pro_${proId}`);
    expect(session.params).toMatchObject({
      mode: "payment",
      customer: `cus_${proId}`,
      payment_method_types: ["card"],
      line_items: [{ price: "price_PassBoutique30", quantity: 1 }],
      invoice_creation: { enabled: true },
      metadata: { accountId: `pro_${proId}`, app_user_id: account!.rcAppUserId, kind: "pass", passId: "boutique30" },
    });
    expect(session.params.success_url).toMatch(/\/fr\/pro\/abonnement\?pass=0$/);
    expect(account?.lastPassCheckout).toMatchObject({ passId: "boutique30", consentVersion: "2026-10", sessionId: expect.stringMatching(/^cs_test_/) });
  });

  it("is refused while sales are closed, during the free launch offer, under a subscription, without consent or for an unknown pass", async () => {
    const owner = await member();
    await shop(owner);
    flags.salesEnabled = false;
    expect(code((await buyPass(owner)).body)).toBe("sales_closed");
    flags.salesEnabled = true;
    expect((await buyPass(owner, { pass: "boutique30", acceptTerms: false })).status).toBe(400);
    expect((await buyPass(owner, { pass: "boutique90", acceptTerms: true })).status).toBe(404);

    offer.endsAt = new Date(Date.now() + 10 * DAY_MS).toISOString();
    const onOffer = await member();
    await shop(onOffer, { lifecycle: "verified", plan: "essentiel", planSource: "launch_offer", quotas: DEFAULT_PRICING.pro.essentiel });
    const refused = await buyPass(onOffer);
    expect(refused.status).toBe(409);
    expect(code(refused.body)).toBe("launch_offer_running");
    expect((await page(onOffer)).launchOfferOpen).toBe(true);
    expect((await page(owner)).launchOfferOpen).toBe(false);

    const subscribed = await member();
    await shop(subscribed, { lifecycle: "active", plan: "essentiel", planSource: "subscription", quotas: DEFAULT_PRICING.pro.essentiel });
    expect(code((await buyPass(subscribed)).body)).toBe("already_subscribed");

    const pending = await member();
    await shop(pending, { lifecycle: "pending_verification", kybc: { status: "submitted", iceFormatOk: true, uploadIds: [] } });
    expect(code((await buyPass(pending)).body)).toBe("pro_not_verified");

    // A shop on another plan's pass extends that one, never mixes two plans.
    const onBusiness = await member();
    await shop(onBusiness, { lifecycle: "active", plan: "business", planSource: "pass", quotas: DEFAULT_PRICING.pro.business, passEndsAt: new Date(Date.now() + 10 * DAY_MS) });
    expect((await page(onBusiness)).passes[0]?.otherPlan).toBe(true);
    expect(code((await buyPass(onBusiness)).body)).toBe("pass_other_plan");
  });

  it("closes a plan page still payable, so that it cannot bill over the pass days", async () => {
    const owner = await member();
    const proId = await shop(owner);
    expect((await api(checkout, "POST", "/api/billing/checkout", { member: owner, body: { plan: "essentiel", interval: "monthly", acceptTerms: true, locale: "fr" } })).status).toBe(200);
    const planSession = (await getBillingAccount(`pro_${proId}`))!.lastPlanCheckout!.sessionId!;
    expect((await buyPass(owner)).status).toBe(200);
    expect(stripe.calls.some((call) => call.method === "POST" && call.path === `/v1/checkout/sessions/${planSession}/expire`)).toBe(true);
    // And the reverse: a plan page opened during the pass closes the pass page still payable.
    const passSession = (await getBillingAccount(`pro_${proId}`))!.lastPassCheckout!.sessionId!;
    expect((await api(checkout, "POST", "/api/billing/checkout", { member: owner, body: { plan: "business", interval: "monthly", acceptTerms: true, locale: "fr" } })).status).toBe(200);
    expect(stripe.calls.some((call) => call.method === "POST" && call.path === `/v1/checkout/sessions/${passSession}/expire`)).toBe(true);
  });
});

describe("pass webhook", () => {
  it("activates the shop once for 30 days with its plan credits, and extends a running pass", async () => {
    const owner = await member();
    const proId = await shop(owner);
    const opened = await buyPass(owner);
    expect(opened.status).toBe(200);
    const first = await pay(proId);

    const profile = await getProProfile(proId);
    expect(profile).toMatchObject({ lifecycle: "active", plan: "essentiel", planSource: "pass", quotas: DEFAULT_PRICING.pro.essentiel });
    expect(daysFromNow(profile?.passEndsAt)).toBe(30);
    const wallet = await getWallet(`pro_${proId}`);
    expect(wallet).toMatchObject({ planCredits: 30 });
    expect(wallet?.planCreditsResetsAt?.getTime()).toBe(profile?.passEndsAt?.getTime());
    expect((await ledgerRef(`pro_${proId}`, `pass_${first}`).get()).exists).toBe(true);
    expect((await page(owner)).passEndsAt).toBe(profile?.passEndsAt?.toISOString());

    // The same event delivered again changes nothing.
    await stripeDeliver("checkout.session.completed", { id: first, object: "checkout.session", mode: "payment", metadata: stripe.sessions[first]!.metadata });
    expect((await getProProfile(proId))?.passEndsAt?.getTime()).toBe(profile?.passEndsAt?.getTime());

    // A second pass starts at the end of the first, on another Stripe page, and adds its credits.
    const second = await buyPass(owner);
    expect(second.status).toBe(200);
    expect(second.body.url).not.toBe(opened.body.url);
    await pay(proId);
    expect(daysFromNow((await getProProfile(proId))?.passEndsAt)).toBe(60);
    expect(await getWallet(`pro_${proId}`)).toMatchObject({ planCredits: 60 });
    // A third one would end 90 days ahead: still allowed; a fourth, beyond: refused.
    expect((await buyPass(owner)).status).toBe(200);
    await pay(proId);
    expect((await page(owner)).passes[0]?.withinLimit).toBe(false);
    const beyond = await buyPass(owner);
    expect(beyond.status).toBe(409);
    expect(code(beyond.body)).toBe("pass_max_ahead");
  });

  it("ignores an unpaid session, alerts a pass unknown to the config and a shop that cannot take it", async () => {
    const owner = await member();
    const proId = await shop(owner);
    expect((await buyPass(owner)).status).toBe(200);
    const account = await getBillingAccount(`pro_${proId}`);
    const sessionId = account!.lastPassCheckout!.sessionId!;
    const metadata = { accountId: `pro_${proId}`, app_user_id: account!.rcAppUserId, env: "dev", kind: "pass", passId: "boutique30" };
    stripe.sessions[sessionId] = { id: sessionId, status: "open", payment_status: "unpaid", mode: "payment", metadata };
    await stripeDeliver("checkout.session.completed", { id: sessionId, object: "checkout.session", mode: "payment", metadata });
    expect((await getProProfile(proId))?.planSource).toBe("none");

    stripe.sessions[sessionId] = { id: sessionId, status: "complete", payment_status: "paid", mode: "payment", metadata: { ...metadata, passId: "boutique7" } };
    await stripeDeliver("checkout.session.completed", { id: `${sessionId}x`, object: "checkout.session", mode: "payment", metadata });
    stripe.sessions[`${sessionId}x`] = stripe.sessions[sessionId]!;
    await stripeDeliver("checkout.session.completed", { id: `${sessionId}x`, object: "checkout.session", mode: "payment", metadata });
    expect(vi.mocked(alert).mock.calls.some(([input]) => /inconnu/.test(input.title))).toBe(true);
    expect((await getProProfile(proId))?.planSource).toBe("none");

    // Suspended between the checkout and the payment: recorded once, not applied, an admin is told.
    await proProfileRef(proId).update({ lifecycle: "suspended", suspendedFrom: "downgraded" });
    await pay(proId);
    expect((await getProProfile(proId))).toMatchObject({ lifecycle: "suspended", planSource: "none" });
    expect(vi.mocked(alert).mock.calls.some(([input]) => /suspended/.test(input.title))).toBe(true);
  });

  it("starts a subscription taken during a pass at the end of the pass", async () => {
    const owner = await member();
    const proId = await shop(owner);
    expect((await buyPass(owner)).status).toBe(200);
    await pay(proId);
    const end = (await getProProfile(proId))!.passEndsAt!;
    stripe.calls = [];
    expect((await api(checkout, "POST", "/api/billing/checkout", { member: owner, body: { plan: "essentiel", interval: "monthly", acceptTerms: true, locale: "fr" } })).status).toBe(200);
    const session = stripe.calls.find((call) => call.path === "/v1/checkout/sessions")!;
    expect(session.params).toMatchObject({ mode: "subscription", subscription_data: { trial_end: Math.floor(end.getTime() / 1000) } });
  });
});

describe("pass end", () => {
  it("mails at J-7, then downgrades the shop at the end and pauses its listings over the free quota", async () => {
    const owner = await member();
    const listing = await published(owner);
    const now = Date.now();
    const proId = await shop(owner, { lifecycle: "active", plan: "essentiel", planSource: "pass", quotas: DEFAULT_PRICING.pro.essentiel, passEndsAt: new Date(now + 6 * DAY_MS) });

    // Sales closed: the shop could not renew, so the pass goes on and nothing is sent.
    flags.salesEnabled = false;
    expect((await proPlansNightly(new Date(now + 7 * DAY_MS))).pass).toEqual({ noticed: 0, ended: 0, failed: 0 });
    expect((await getProProfile(proId))?.lifecycle).toBe("active");
    flags.salesEnabled = true;

    let run = await proPlansNightly(new Date(now));
    expect(run.pass.noticed).toBeGreaterThanOrEqual(1);
    const mails = () => vi.mocked(sendMail).mock.calls.map(([input]) => input).filter((input) => input.template === "passNotice" && "shopName" in input.data && input.data.shopName === "Miel d'Imouzzer");
    expect(mails()).toMatchObject([{ template: "passNotice", data: { kind: "ending", freeListings: 0 } }]);
    expect((await getProProfile(proId))?.passNoticeSentAt).toBeInstanceOf(Date);
    // Same night again: no second mail.
    await proPlansNightly(new Date(now + 60_000));
    expect(mails()).toHaveLength(1);

    run = await proPlansNightly(new Date(now + 7 * DAY_MS));
    expect(run.pass.ended).toBeGreaterThanOrEqual(1);
    expect(await getProProfile(proId)).toMatchObject({ lifecycle: "downgraded", plan: "none", planSource: "none" });
    expect((await getListing(listing))?.status).toBe("paused");
    expect(mails().at(-1)).toMatchObject({ data: { kind: "ended", paused: 1 } });
  });
});
