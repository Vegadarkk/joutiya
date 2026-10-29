import { randomInt, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RuntimeModule from "@/lib/config/runtime";
import type { RevenueCatPurchase } from "@/lib/payments/revenuecat-api";
import type * as StripeApiModule from "@/lib/payments/stripe-api";

// Tax exports and yearly thresholds (phase 7 design §8): the admin-only CSV downloads (staff role,
// admin host, period shape per report, one audit entry per download), the DGI register and
// totals from the orders and Stripe's paid invoices, URSSAF's EUR received from Stripe's balance
// transactions, the e-reporting feed, and the nightly counters: EU B2C packs and every EUR
// received, each level alerted once a year, the EUR packs leaving the grid at the EU threshold.
// Seeded periods (2023-2025) stay clear of the orders other files create today.

const stripe = vi.hoisted(() => ({
  configured: true,
  calls: [] as { path: string; params: Record<string, unknown> }[],
  invoices: [] as Record<string, unknown>[],
  balance: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/config/runtime", async (importOriginal) => {
  const { DEFAULT_PRICING } = await import("@/config/pricing");
  const eur = { id: "eur_10", currency: "EUR", priceMinor: 1_000, paid: 100, bonus: 0, productId: "joutiya_credits_100_eur", packageId: "credits_100_eur" };
  return {
    ...(await importOriginal<typeof RuntimeModule>()),
    getFlags: vi.fn(async () => ({ salesEnabled: true, proSignupEnabled: true, paymentInstallmentsEnabled: false })),
    getPricing: vi.fn(async () => ({ ...DEFAULT_PRICING, packs: [...DEFAULT_PRICING.packs, eur] })),
  };
});
vi.mock("@/lib/payments/stripe-api", async (importOriginal) => ({
  ...(await importOriginal<typeof StripeApiModule>()),
  isStripeConfigured: vi.fn(() => stripe.configured),
  stripeRequest: vi.fn(async (_method: string, path: string, params: Record<string, unknown> = {}) => {
    stripe.calls.push({ path, params });
    const created = params.created as { gte: number; lt: number };
    const inRange = (item: Record<string, unknown>) => (item.created as number) >= created.gte && (item.created as number) < created.lt;
    if (path === "/v1/invoices") return { data: stripe.invoices.filter(inRange), has_more: false };
    if (path === "/v1/balance_transactions") return { data: stripe.balance.filter(inRange), has_more: false };
    throw new Error(`unexpected Stripe call ${path}`);
  }),
}));
vi.mock("@/lib/security/turnstile", () => ({ verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })) }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { GET as exportReport } from "@/app/api/admin/exports/[report]/route";
import { GET as packs, POST as checkout } from "@/app/api/wallet/packs/route";
import { DEFAULT_PRICING } from "@/config/pricing";
import { MA_TIME_ZONE } from "@/config/tax";
import type { PacksResponse } from "@/lib/contracts/payments";
import { alert } from "@/lib/alert";
import { billingAccountRef, createBillingEvent, orderId, orderRef } from "@/lib/db/repositories/billing";
import { proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { COLLECTIONS, orderSchema, type OrderDoc } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { processBillingEvent } from "@/lib/payments/revenuecat-events";
import { parsePeriod } from "@/lib/payments/sales";
import { stripeRequest } from "@/lib/payments/stripe-api";
import { euPacksOpen, resetThresholdsCache, updateBillingThresholds } from "@/lib/payments/thresholds";
import type { ProProfileDoc } from "@/lib/pro/profile-schema";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { expectedOrigin } from "@/lib/security/origin";
import { api, member, type ErrorBody } from "../listings/helpers";
import { audits, staff, type Staff } from "../admin/decisions/helpers";

const LINK = "https://pay.rev.cat/sandbox-token";
const SHOP_CUSTOMER = "cus_ExportShop";
const PRO_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const proId = Array.from({ length: 8 }, () => PRO_ID_ALPHABET[randomInt(PRO_ID_ALPHABET.length)]).join("");
const seconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1_000);
const thresholdsRef = () => db().collection(COLLECTIONS.system).doc("billingThresholds");

let admin: Staff;
let moderator: Staff;

async function seedOrder(transactionId: string, extra: Partial<OrderDoc>): Promise<string> {
  const at = extra.purchasedAt ?? new Date("2025-02-10T12:00:00Z");
  const order: OrderDoc = {
    kind: "pack",
    accountId: "uid_exports_buyer",
    packId: "mad_100",
    productId: "joutiya_credits_100_mad",
    quantity: 1,
    credits: { paid: 100, bonus: 10 },
    currency: "MAD",
    amountMinor: 10_000,
    status: "paid",
    environment: "SANDBOX",
    store: "RC_BILLING",
    taxJurisdiction: "MA",
    locationEvidence: { countryCode: "MA" },
    eventId: randomUUID(),
    purchasedAt: at,
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
  // Firestore refuses undefined fields (an order without amount drops the key).
  await orderRef(transactionId).set(Object.fromEntries(Object.entries(orderSchema.parse(order)).filter(([, value]) => value !== undefined)));
  return orderId(transactionId);
}

const eurOrder = (amountMinor: number, purchasedAt: string, extra: Partial<OrderDoc> = {}): Partial<OrderDoc> => ({
  taxJurisdiction: "EU",
  currency: "EUR",
  packId: "eur_10",
  productId: "joutiya_credits_100_eur",
  credits: { paid: 100, bonus: 0 },
  amountMinor,
  locationEvidence: { countryCode: "FR" },
  purchasedAt: new Date(purchasedAt),
  ...extra,
});

/** A CSV download on the admin host (Access e-mail + session; a GET needs no CSRF token). */
async function download(as: Staff | undefined, report: string, period: string, host = new URL(expectedOrigin("admin")).host) {
  const headers = new Headers({ host, "user-agent": "vitest", "x-forwarded-for": "10.88.0.7" });
  if (as) {
    headers.set("x-dev-access-email", as.email);
    headers.set("cookie", `__Host-session=${as.session}`);
  }
  const request = new NextRequest(`http://${host}/api/admin/exports/${report}?period=${encodeURIComponent(period)}`, { headers });
  const response = await exportReport(request, { params: Promise.resolve({ report }) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const table = (csv: string) =>
  csv
    .replace(/^﻿/, "")
    .trimEnd()
    .split("\r\n")
    .map((row) => row.split(";"));

const ids: Record<string, string> = {};

beforeAll(async () => {
  process.env.REVENUECAT_PURCHASE_LINK = LINK;
  resetServerEnv();
  [admin, moderator] = await Promise.all([staff("admin"), staff("moderator")]);

  // A verified shop billed by Stripe, and the quarter's packs: a sale, a refund of a December
  // sale, an EU pack, and an April sale outside the quarter.
  const now = new Date();
  const profile: ProProfileDoc = {
    ownerUid: "uid_exports_owner",
    members: { uid_exports_owner: "owner" },
    name: "Atlas Auto",
    slug: `atlas-auto-${proId}`,
    description: "Voitures d'occasion contrôlées.",
    whatsapp: false,
    regionCode: "06",
    citySlug: "casablanca",
    legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
    kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
    lifecycle: "verified",
    plan: "business",
    planSource: "subscription",
    quotas: DEFAULT_PRICING.pro.business,
    createdAt: now,
    updatedAt: now,
  };
  await proProfileRef(proId).set(proProfileToFirestore(profile));
  await billingAccountRef(`pro_${proId}`).set({ kind: "shop", ownerUid: "uid_exports_owner", proId, rcAppUserId: randomUUID(), stripeCustomerId: SHOP_CUSTOMER, createdAt: now, updatedAt: now });

  ids.sale = await seedOrder("txn_exports_sale", {});
  ids.refund = await seedOrder("txn_exports_refund", {
    packId: "mad_50",
    productId: "joutiya_credits_50_mad",
    credits: { paid: 50, bonus: 0 },
    amountMinor: 5_000,
    status: "refunded",
    purchasedAt: new Date("2024-12-20T12:00:00Z"),
    refundedAt: new Date("2025-01-15T12:00:00Z"),
  });
  ids.eu = await seedOrder("txn_exports_eu", eurOrder(1_000, "2025-03-01T12:00:00Z"));
  ids.april = await seedOrder("txn_exports_april", { purchasedAt: new Date("2025-04-02T12:00:00Z") });

  stripe.invoices = [
    // Paid in April, issued in March: outside the quarter.
    { id: "in_april", number: "JOUT-0008", customer: SHOP_CUSTOMER, currency: "mad", total: 59_000, total_excluding_tax: 59_000, total_taxes: [], created: seconds("2025-03-31T12:00:00Z"), status_transitions: { paid_at: seconds("2025-04-03T12:00:00Z") } },
    { id: "in_march", number: "JOUT-0007", customer: SHOP_CUSTOMER, currency: "mad", total: 59_000, total_excluding_tax: 59_000, total_taxes: [], created: seconds("2025-03-05T11:00:00Z"), status_transitions: { paid_at: seconds("2025-03-05T12:00:00Z") }, lines: { data: [{ description: "Business (mensuel)" }] } },
  ];
  stripe.balance = [
    { id: "txn_b_plan", created: seconds("2025-03-05T12:00:00Z"), amount: 5_428, currency: "eur", fee: 200, net: 5_228, exchange_rate: 0.092, reporting_category: "charge", source: { object: "charge", amount: 59_000, currency: "mad", billing_details: { address: { country: "MA" } } } },
    { id: "txn_b_eu", created: seconds("2025-03-01T12:00:00Z"), amount: 1_000, currency: "eur", fee: 40, net: 960, exchange_rate: null, reporting_category: "charge", source: { object: "charge", amount: 1_000, currency: "eur", payment_method_details: { card: { country: "FR" } } } },
    { id: "txn_b_payout", created: seconds("2025-03-10T12:00:00Z"), amount: -6_000, currency: "eur", fee: 0, net: -6_000, reporting_category: "payout", source: "po_1" },
    { id: "txn_b_december", created: seconds("2024-12-31T12:00:00Z"), amount: 900, currency: "eur", fee: 30, net: 870, reporting_category: "charge", source: null },
  ];
});
afterAll(async () => {
  delete process.env.REVENUECAT_PURCHASE_LINK;
  resetServerEnv();
  await thresholdsRef().delete();
});
beforeEach(() => {
  resetRateLimiters();
  stripe.configured = true;
  stripe.calls = [];
  vi.mocked(alert).mockClear();
});

describe("tax exports", () => {
  it("are for admins on the admin host, with the period each report takes", async () => {
    expect((await download(moderator, "registre-dgi", "2025-T1")).status).toBe(403);
    expect((await download(admin, "registre-dgi", "2025-T1", "localhost:3000")).status).toBe(404);
    expect((await download(undefined, "registre-dgi", "2025-T1")).status).toBe(401);
    expect((await download(admin, "bilan", "2025-T1")).status).toBe(404);
    for (const [report, period] of [["registre-dgi", "2025-03"], ["totaux-dgi", "2025"], ["urssaf", "2025-13"], ["e-reporting", "mars"]] as const) {
      const refused = await download(admin, report, period);
      expect(refused.status).toBe(400);
      expect((JSON.parse(refused.text) as ErrorBody).error.code).toBe("invalid_body");
    }
    expect(stripe.calls).toEqual([]);
  });

  it("lists the quarter's Moroccan pack sales, refunds and paid Pro invoices in the DGI register, and audits the download", async () => {
    const result = await download(admin, "registre-dgi", "2025-Q1");
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(result.headers.get("content-disposition")).toBe('attachment; filename="aalan-registre-dgi-2025-T1.csv"');
    expect(result.headers.get("cache-control")).toBe("no-store");
    const rows = table(result.text);
    expect(rows.slice(1).map((row) => [row[0], row[2], row[3], row[5], row[11]])).toEqual([
      ["2025-01-15", "Remboursement", "B2C", ids.refund, "-50,00"],
      ["2025-02-10", "Vente", "B2C", ids.sale, "100,00"],
      ["2025-03-05", "Vente", "B2B", "JOUT-0007", "590,00"],
    ]);
    expect(rows[3]!.slice(4, 9)).toEqual(["Business (mensuel)", "JOUT-0007", `pro_${proId}`, "Atlas Auto", "001234567000089"]);
    // Invoices issued up to 45 days before the quarter (in Moroccan time) may be paid in it.
    const quarter = parsePeriod("2025-T1", MA_TIME_ZONE)!;
    expect(stripe.calls).toEqual([{ path: "/v1/invoices", params: expect.objectContaining({ status: "paid", created: { gte: Math.floor(quarter.from.getTime() / 1_000) - 45 * 86_400, lt: Math.floor(quarter.to.getTime() / 1_000) } }) }]);
    expect(await audits("billing.export", "registre-dgi_2025-T1")).toEqual([expect.objectContaining({ actorUid: admin.uid, actorRole: "admin", automated: false })]);
  });

  it("totals the quarter, and leaves the plans out while Stripe is not configured", async () => {
    expect(table((await download(admin, "totaux-dgi", "2025-T1")).text).slice(1)).toEqual([
      ["2025-T1", "B2B", "0 %", "MAD", "1", "590,00", "0,00", "590,00"],
      ["2025-T1", "B2C", "20 %", "MAD", "2", "41,66", "8,34", "50,00"],
      ["2025-T1", "Total MAD", "", "MAD", "3", "631,66", "8,34", "640,00"],
    ]);
    stripe.configured = false;
    const packsOnly = table((await download(admin, "totaux-dgi", "2025-T1")).text).slice(1);
    expect(packsOnly.map((row) => row[1])).toEqual(["B2C", "Total MAD"]);
    expect(stripe.calls.map((call) => call.path)).toEqual(["/v1/invoices"]);
  });

  it("feeds the e-reporting by day of a month, EU packs included", async () => {
    expect(table((await download(admin, "e-reporting", "2025-03")).text).slice(1)).toEqual([
      ["2025-03-01", "B2C", "EU", "0 %", "EUR", "1", "10,00", "0,00", "10,00"],
      ["2025-03-05", "B2B", "MA", "0 %", "MAD", "1", "590,00", "0,00", "590,00"],
    ]);
  });

  it("gives URSSAF the EUR received less the Moroccan VAT, and needs Stripe for it", async () => {
    const rows = table((await download(admin, "urssaf", "2025-T1")).text);
    expect(rows.slice(1, 3).map((row) => row.slice(1))).toEqual([
      ["txn_b_plan", "charge", "590,00", "MAD", "MA", "0,092", "54,28", "-2,00", "52,28"],
      ["txn_b_eu", "charge", "", "", "FR", "", "10,00", "-0,40", "9,60"],
    ]);
    const [received, vat, net] = rows.slice(-3);
    expect(received!.slice(7)).toEqual(["64,28", "-2,40", "61,88"]);
    // 8,34 MAD of VAT in the quarter, at the 5 428 EUR cents received for 59 000 MAD cents.
    expect(vat!.slice(3, 8)).toEqual(["8,34", "MAD", "", "0,092", "0,77"]);
    expect(net![7]).toBe("63,51");
    // The quarter in French time.
    expect(stripe.calls.find((call) => call.path === "/v1/balance_transactions")?.params).toMatchObject({ expand: ["data.source"], created: { gte: seconds("2024-12-31T23:00:00Z"), lt: seconds("2025-03-31T22:00:00Z") } });

    stripe.configured = false;
    expect((await download(admin, "urssaf", "2025-T1")).status).toBe(503);
  });
});

describe("yearly thresholds", () => {
  it("counts the year's paid EU packs and the EUR received by month, alerting each level once a year", async () => {
    await seedOrder("txn_thresholds_1", eurOrder(700_000, "2023-03-01T12:00:00Z"));
    // Credited by the reconciliation: no amount recorded, the pack's price counts.
    await seedOrder("txn_thresholds_reconciled", eurOrder(1_000, "2023-03-02T12:00:00Z", { amountMinor: undefined }));
    await seedOrder("txn_thresholds_refunded", eurOrder(500_000, "2023-04-01T12:00:00Z", { status: "refunded", refundedAt: new Date("2023-04-03T12:00:00Z") }));
    await seedOrder("txn_thresholds_next_year", eurOrder(900_000, "2024-01-02T12:00:00Z"));
    await seedOrder("txn_thresholds_morocco", { amountMinor: 9_000_000, purchasedAt: new Date("2023-05-01T12:00:00Z") });
    stripe.balance.push({ id: "txn_b_2023", created: seconds("2023-05-10T12:00:00Z"), amount: 2_700_000, currency: "eur", fee: 0, net: 2_700_000, reporting_category: "charge", source: null });
    const titles = () => vi.mocked(alert).mock.calls.map(([sent]) => [sent.severity, sent.title]);
    const balanceReads = () => stripe.calls.filter((call) => call.path === "/v1/balance_transactions").length;

    const first = await updateBillingThresholds(new Date("2023-06-01T12:00:00Z"), stripeRequest);
    expect(first).toMatchObject({ year: 2023, euB2cEurMinor: 701_000, previousYearEuB2cEurMinor: 0, turnoverEurMinor: 2_700_000, alerted: { euB2c: 0.7, franchise: 0.7 } });
    expect(first.turnoverMonths).toEqual({ "01": 0, "02": 0, "03": 0, "04": 0, "05": 2_700_000, "06": 0 });
    expect(balanceReads()).toBe(6);
    expect(titles()).toEqual([
      ["P2", "Ventes B2C dans l'UE : 70 % du seuil annuel"],
      ["P2", "Franchise en base de TVA : 72 % du seuil annuel"],
    ]);

    // The next night reads only the months that may still change, and alerts nothing new.
    vi.mocked(alert).mockClear();
    stripe.calls = [];
    await updateBillingThresholds(new Date("2023-06-02T12:00:00Z"), stripeRequest);
    expect(balanceReads()).toBe(2);
    expect(alert).not.toHaveBeenCalled();

    // Stripe down: the EU counter goes on, the months counted stay.
    await seedOrder("txn_thresholds_2", eurOrder(320_000, "2023-06-02T15:00:00Z"));
    const down = vi.fn(async () => {
      throw new Error("Stripe unavailable");
    }) as unknown as typeof stripeRequest;
    const full = await updateBillingThresholds(new Date("2023-06-03T12:00:00Z"), down);
    expect(full).toMatchObject({ euB2cEurMinor: 1_021_000, turnoverEurMinor: 2_700_000, alerted: { euB2c: 1, franchise: 0.7 } });
    expect(titles()).toEqual([["P1", "Ventes B2C dans l'UE : 102 % du seuil annuel"]]);
    expect(euPacksOpen(full, new Date("2023-06-03T12:00:00Z"))).toBe(false);
    // Reached in 2023: closed through 2024 as well.
    expect(euPacksOpen(full, new Date("2024-01-01T00:00:00Z"))).toBe(false);

    // A new year starts its counters and alerts again, and keeps last year's figure.
    vi.mocked(alert).mockClear();
    const next = await updateBillingThresholds(new Date("2024-02-01T12:00:00Z"), null);
    expect(next).toMatchObject({ year: 2024, euB2cEurMinor: 900_000, previousYearEuB2cEurMinor: 1_021_000, turnoverEurMinor: null, alerted: { euB2c: 0.7, franchise: 0 } });
    expect(titles()).toEqual([["P2", "Ventes B2C dans l'UE : 90 % du seuil annuel"]]);
    expect(euPacksOpen(next, new Date("2024-02-01T12:00:00Z"))).toBe(false);
  });

  it("takes the EUR packs off the grid, refuses their checkout and alerts one sold anyway once this year's EU threshold is reached", async () => {
    const buyer = await member();
    const grid = async () => (await api<PacksResponse>(packs, "GET", "/api/wallet/packs", { member: buyer })).body.packs.map((pack) => pack.id);
    const pay = (packId: string, expectedPriceMinor: number) => api<ErrorBody>(checkout, "POST", "/api/wallet/packs", { member: buyer, body: { packId, expectedPriceMinor, acceptTerms: true, turnstileToken: "dev" } });
    expect((await pay("mad_100", 10_000)).status).toBe(200);
    await thresholdsRef().set({ year: new Date().getUTCFullYear(), euB2cEurMinor: 1_000_000, turnoverEurMinor: null, alerted: { euB2c: 1, franchise: 0 }, computedAt: new Date() });
    resetThresholdsCache();
    expect(await grid()).toEqual(["mad_50", "mad_100", "mad_250"]);
    const refused = await pay("eur_10", 1_000);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("price_changed");

    // An edited purchase link sold one: credited (it was paid), and alerted.
    const account = (await billingAccountRef(buyer.uid).get()).data()!;
    const transactionId = `txn_${randomUUID()}`;
    const eventId = randomUUID();
    await createBillingEvent({ source: "revenuecat", eventId, type: "NON_RENEWING_PURCHASE", environment: "SANDBOX", appUserId: account.rcAppUserId, productId: "joutiya_credits_100_eur", transactionId, store: "RC_BILLING", currency: "EUR", amountMinor: 1_000, countryCode: "FR", kind: "pack", status: "received", attempts: 0, receivedAt: new Date() });
    const owned: RevenueCatPurchase = { id: `rcp_${transactionId}`, storePurchaseIdentifier: transactionId, status: "owned", environment: "sandbox", quantity: 1 };
    expect(await processBillingEvent(eventId, { listPurchases: async () => [owned] })).toBe("credited");
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: "P1", title: "Pack en euros vendu au-delà du seuil UE" }));

    await thresholdsRef().delete();
    resetThresholdsCache();
    expect(await grid()).toEqual(["mad_50", "mad_100", "mad_250", "eur_10"]);
  });
});
