import "server-only";
import type { AuthContext } from "@/lib/auth/guards";
import type { InvoicesResponse, InvoiceView } from "@/lib/contracts/payments";
import { getBillingAccount } from "@/lib/db/repositories/billing";
import { z } from "@/lib/zod";
import { isStripeConfigured, stripeRequest } from "./stripe-api";
import { ownShop } from "./plans";

// /pro/factures (phase 7 design §7): the shop's Stripe invoices, read on demand (never stored), owner
// only. Drafts are left out; the links are Stripe's hosted page and PDF, kept only on Stripe's hosts.

export const INVOICES_PAGE_SIZE = 24;
const STRIPE_HOSTS: ReadonlySet<string> = new Set(["invoice.stripe.com", "pay.stripe.com"]);

const stripeLink = z
  .string()
  .max(2_000)
  .nullish()
  .transform((value) => {
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && STRIPE_HOSTS.has(url.hostname) ? url.toString() : null;
    } catch {
      return null;
    }
  });

const invoiceSchema = z.object({
  id: z.string().regex(/^in_[A-Za-z0-9]{1,100}$/),
  number: z.string().max(64).nullish(),
  created: z.number().int().positive(),
  total: z.number().int(),
  currency: z.string().regex(/^[a-z]{3}$/),
  status: z.string().max(32).nullish(),
  hosted_invoice_url: stripeLink,
  invoice_pdf: stripeLink,
});
const invoiceListSchema = z.object({ data: z.array(z.unknown()), has_more: z.boolean().optional() });

const SHOWN_STATUSES: ReadonlySet<string> = new Set(["open", "paid", "uncollectible", "void"]);

export function invoiceViews(body: unknown): InvoiceView[] {
  const list = invoiceListSchema.parse(body);
  return list.data.flatMap((item) => {
    const parsed = invoiceSchema.safeParse(item);
    if (!parsed.success || !parsed.data.status || !SHOWN_STATUSES.has(parsed.data.status)) return [];
    const invoice = parsed.data;
    return [
      {
        id: invoice.id,
        number: invoice.number ?? null,
        issuedAt: new Date(invoice.created * 1_000).toISOString(),
        totalMinor: invoice.total,
        currency: invoice.currency.toUpperCase(),
        status: invoice.status as InvoiceView["status"],
        hostedUrl: invoice.hosted_invoice_url,
        pdfUrl: invoice.invoice_pdf,
      },
    ];
  });
}

export async function shopInvoices(auth: AuthContext): Promise<InvoicesResponse> {
  const { accountId } = await ownShop(auth);
  const account = await getBillingAccount(accountId);
  if (!account?.stripeCustomerId || !isStripeConfigured()) return { invoices: [] };
  const body = await stripeRequest<unknown>("GET", "/v1/invoices", { customer: account.stripeCustomerId, limit: INVOICES_PAGE_SIZE });
  return { invoices: invoiceViews(body) };
}
