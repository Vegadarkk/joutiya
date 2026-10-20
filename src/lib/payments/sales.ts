import "server-only";
import { MA_VAT_RATE } from "@/config/tax";
import type { PricingConfig } from "@/config/pricing";
import { getPricing } from "@/lib/config/runtime";
import { findBillingAccountByStripeCustomer, listOrdersBetween, type OrderRecord } from "@/lib/db/repositories/billing";
import { getProProfile } from "@/lib/db/repositories/pro-profiles";
import { stripeRequest, type StripeParam } from "./stripe-api";

// The sales of a period, as the tax exports read them (phase 7 design §8): packs from `orders`
// (B2C, sold on RevenueCat's page; a refund is a line of its own on its date) and Pro plans from
// the invoices Stripe marked paid in the period (B2B). Amounts in minor units of the currency
// charged; a pack's price includes Moroccan VAT for a Moroccan buyer, an EUR pack carries none
// (French franchise). Periods are UTC calendar months or quarters. Plus Stripe's balance
// transactions of the period: the EUR actually received, for URSSAF.

export interface Period {
  label: string;
  from: Date;
  to: Date;
}

const DAY_MS = 86_400_000;
/** An invoice paid in the period may have been issued this long before it. */
const INVOICE_LOOKBACK_MS = 45 * DAY_MS;
const STRIPE_PAGES = 100;

/** `2027-03` (month), `2027-Q1` or `2027-T1` (quarter), `2027` (year), in UTC. */
export function parsePeriod(value: string): Period | null {
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  const quarter = /^(\d{4})-[QT]([1-4])$/.exec(value);
  const year = /^(\d{4})$/.exec(value);
  const at = (y: number, m: number) => new Date(Date.UTC(y, m, 1));
  if (month) return { label: value, from: at(Number(month[1]), Number(month[2]) - 1), to: at(Number(month[1]), Number(month[2])) };
  if (quarter) {
    const start = (Number(quarter[2]) - 1) * 3;
    return { label: `${quarter[1]}-T${quarter[2]}`, from: at(Number(quarter[1]), start), to: at(Number(quarter[1]), start + 3) };
  }
  if (year) return { label: value, from: at(Number(year[1]), 0), to: at(Number(year[1]) + 1, 0) };
  return null;
}

export interface SaleLine {
  at: Date;
  kind: "pack" | "plan";
  movement: "sale" | "refund";
  /** Order id (store transaction) or invoice number. */
  reference: string;
  accountId: string;
  /** B2B: the shop's legal name and ICE; B2C: none (the account id stands for the buyer). */
  customerName?: string;
  ice?: string;
  /** Customer location evidence (billing or card country), when known. */
  country?: string;
  jurisdiction: "MA" | "EU";
  currency: string;
  /** Signed: a refund is negative. */
  grossMinor: number;
  netMinor: number;
  vatMinor: number;
  vatRate: number;
  description: string;
}

/** Splits a tax-inclusive amount at `rate`. */
export function splitIncluded(grossMinor: number, rate: number): { netMinor: number; vatMinor: number } {
  const vatMinor = rate > 0 ? Math.round((grossMinor * rate) / (1 + rate)) : 0;
  return { netMinor: grossMinor - vatMinor, vatMinor };
}

function packLines(order: OrderRecord, pricing: PricingConfig, period: Period): SaleLine[] {
  const pack = pricing.packs.find((candidate) => candidate.id === order.packId);
  const grossMinor = order.amountMinor ?? (pack ? pack.priceMinor * order.quantity : order.credits.paid * 100);
  const rate = order.taxJurisdiction === "MA" ? MA_VAT_RATE : 0;
  const base = {
    kind: "pack" as const,
    reference: order.id,
    accountId: order.accountId,
    ...(order.locationEvidence.countryCode ? { country: order.locationEvidence.countryCode } : {}),
    jurisdiction: order.taxJurisdiction,
    currency: order.currency,
    vatRate: rate,
    description: `Pack de ${order.credits.paid + order.credits.bonus} crédits${order.quantity > 1 ? ` (x${order.quantity})` : ""}`,
  };
  const lines: SaleLine[] = [];
  const inPeriod = (at: Date) => at >= period.from && at < period.to;
  if (inPeriod(order.purchasedAt)) lines.push({ ...base, at: order.purchasedAt, movement: "sale", grossMinor, ...splitIncluded(grossMinor, rate) });
  if (order.status === "refunded" && order.refundedAt && inPeriod(order.refundedAt)) {
    const split = splitIncluded(grossMinor, rate);
    lines.push({ ...base, at: order.refundedAt, movement: "refund", grossMinor: -grossMinor, netMinor: -split.netMinor, vatMinor: -split.vatMinor });
  }
  return lines;
}

interface StripeInvoice {
  id: string;
  number?: string | null;
  customer?: string | null;
  currency?: string;
  total?: number;
  total_excluding_tax?: number | null;
  total_taxes?: { amount?: number }[] | null;
  status_transitions?: { paid_at?: number | null } | null;
  customer_address?: { country?: string | null } | null;
  lines?: { data?: { description?: string | null }[] } | null;
}

async function* listStripe<T extends { id: string }>(path: string, params: Record<string, StripeParam>, stripe: typeof stripeRequest): AsyncGenerator<T> {
  let startingAfter: string | undefined;
  for (let page = 0; page < STRIPE_PAGES; page += 1) {
    const list = await stripe<{ data?: T[]; has_more?: boolean }>("GET", path, { ...params, limit: 100, starting_after: startingAfter });
    for (const item of list.data ?? []) yield item;
    const last = list.data?.at(-1)?.id;
    if (!list.has_more || !last) return;
    startingAfter = last;
  }
  throw new Error(`${path}: more than ${STRIPE_PAGES * 100} items in the period`);
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1_000);

async function planLines(period: Period, stripe: typeof stripeRequest): Promise<SaleLine[]> {
  const lines: SaleLine[] = [];
  const shops = new Map<string, { accountId: string; name?: string; ice?: string } | null>();
  const invoices = listStripe<StripeInvoice>("/v1/invoices", { status: "paid", created: { gte: seconds(new Date(period.from.getTime() - INVOICE_LOOKBACK_MS)), lt: seconds(period.to) } }, stripe);
  for await (const invoice of invoices) {
    const paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1_000) : null;
    if (!paidAt || paidAt < period.from || paidAt >= period.to || typeof invoice.total !== "number" || !invoice.currency) continue;
    const customer = invoice.customer ?? "";
    if (!shops.has(customer)) {
      const account = customer ? await findBillingAccountByStripeCustomer(customer) : null;
      const profile = account?.proId ? await getProProfile(account.proId) : null;
      shops.set(customer, account ? { accountId: account.id, ...(profile ? { name: profile.name } : {}), ...(profile?.legal.ice ? { ice: profile.legal.ice } : {}) } : null);
    }
    const shop = shops.get(customer);
    const vatMinor = (invoice.total_taxes ?? []).reduce((sum, tax) => sum + (tax.amount ?? 0), 0);
    const netMinor = invoice.total_excluding_tax ?? invoice.total - vatMinor;
    const country = invoice.customer_address?.country ?? undefined;
    lines.push({
      at: paidAt,
      kind: "plan",
      movement: "sale",
      reference: invoice.number ?? invoice.id,
      accountId: shop?.accountId ?? customer,
      ...(shop?.name ? { customerName: shop.name } : {}),
      ...(shop?.ice ? { ice: shop.ice } : {}),
      ...(country ? { country } : {}),
      jurisdiction: country && country !== "MA" ? "EU" : "MA",
      currency: invoice.currency.toUpperCase(),
      grossMinor: invoice.total,
      netMinor,
      vatMinor,
      vatRate: vatMinor > 0 && netMinor > 0 ? Math.round((vatMinor / netMinor) * 10_000) / 10_000 : 0,
      description: (invoice.lines?.data?.[0]?.description ?? "Abonnement Pro").slice(0, 120),
    });
  }
  return lines;
}

/** The period's sales and refunds, oldest first; plans only when Stripe is configured. */
export async function salesOf(period: Period, options: { stripe?: typeof stripeRequest | null } = {}): Promise<SaleLine[]> {
  const pricing = await getPricing();
  const [paid, refunded] = await Promise.all([listOrdersBetween("purchasedAt", period.from, period.to), listOrdersBetween("refundedAt", period.from, period.to)]);
  const orders = new Map([...paid, ...refunded].map((order) => [order.id, order]));
  const lines = [...orders.values()].flatMap((order) => packLines(order, pricing, period));
  if (options.stripe !== null) lines.push(...(await planLines(period, options.stripe ?? stripeRequest)));
  return lines.sort((a, b) => a.at.getTime() - b.at.getTime() || a.reference.localeCompare(b.reference));
}

export interface ReceiptLine {
  id: string;
  at: Date;
  category: string;
  /** EUR received (signed), Stripe's fee and the net, in cents. */
  amountEurMinor: number;
  feeEurMinor: number;
  netEurMinor: number;
  exchangeRate: number | null;
  /** The amount as charged, when another currency than EUR. */
  originalMinor?: number;
  originalCurrency?: string;
  country?: string;
}

interface StripeBalanceTransaction {
  id: string;
  created: number;
  amount: number;
  currency: string;
  fee: number;
  net: number;
  exchange_rate?: number | null;
  reporting_category?: string;
  source?: { object?: string; amount?: number; currency?: string; billing_details?: { address?: { country?: string | null } | null } | null; payment_method_details?: { card?: { country?: string | null } | null } | null } | string | null;
}

/** Categories of money in or out for a sale: payments, refunds and disputes (fees and payouts left out). */
const RECEIPT_CATEGORIES: ReadonlySet<string> = new Set(["charge", "refund", "dispute", "dispute_reversal"]);

/** Stripe's balance transactions of the period in EUR (the account settles in EUR). */
export async function receiptsOf(period: Period, stripe: typeof stripeRequest = stripeRequest): Promise<ReceiptLine[]> {
  const out: ReceiptLine[] = [];
  const list = listStripe<StripeBalanceTransaction>("/v1/balance_transactions", { created: { gte: seconds(period.from), lt: seconds(period.to) }, expand: ["data.source"] }, stripe);
  for await (const transaction of list) {
    if (!transaction.reporting_category || !RECEIPT_CATEGORIES.has(transaction.reporting_category)) continue;
    if (transaction.currency.toLowerCase() !== "eur") throw new Error(`balance transaction ${transaction.id} settled in ${transaction.currency}, not EUR`);
    const source = typeof transaction.source === "object" && transaction.source ? transaction.source : null;
    const sign = transaction.amount < 0 ? -1 : 1;
    const country = source?.billing_details?.address?.country ?? source?.payment_method_details?.card?.country ?? undefined;
    out.push({
      id: transaction.id,
      at: new Date(transaction.created * 1_000),
      category: transaction.reporting_category,
      amountEurMinor: transaction.amount,
      feeEurMinor: transaction.fee,
      netEurMinor: transaction.net,
      exchangeRate: transaction.exchange_rate ?? null,
      ...(source?.currency && source.currency.toLowerCase() !== "eur" && typeof source.amount === "number" ? { originalMinor: sign * Math.abs(source.amount), originalCurrency: source.currency.toUpperCase() } : {}),
      ...(country ? { country } : {}),
    });
  }
  return out;
}
