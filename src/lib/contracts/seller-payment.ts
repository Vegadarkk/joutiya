import { PAYMENT_HOSTS_MAX, PAYMENT_URL_MAX, SELLER_INFO_LIMITS, type PaymentLinkProblem } from "@/config/seller-payments";
import { z } from "@/lib/zod";

// « Payer chez le vendeur » API contracts (design phase-7/boutique-temporaire.md §2): the owner's
// settings (/pro/paiement), the public button and the back office. Client-safe.

export { SELLER_PAYMENT_API } from "./endpoints";

/** Version of the « prices include tax » commitment the owner ticks (law 31-08: prices TTC). */
export const SELLER_TERMS_VERSION = "2026-10";

export const sellerInfoInputSchema = z
  .object({
    address: z.string().trim().min(10).max(SELLER_INFO_LIMITS.address),
    email: z.email().max(SELLER_INFO_LIMITS.email),
    delivery: z.string().trim().min(10).max(SELLER_INFO_LIMITS.delivery),
    returns: z.string().trim().min(10).max(SELLER_INFO_LIMITS.returns),
  })
  .strict();

export const sellerPaymentInputSchema = z
  .object({
    /** The payment page, or null to remove the button (removal is immediate). */
    url: z.string().max(PAYMENT_URL_MAX).nullable(),
    cashOnDelivery: z.boolean(),
    /** Required to turn the link or cash on delivery on. */
    info: sellerInfoInputSchema.nullable(),
    /** The owner states its listed prices include tax and that it alone handles payment, delivery and after-sales. */
    acceptTerms: z.boolean(),
  })
  .strict();
export type SellerPaymentInput = z.infer<typeof sellerPaymentInputSchema>;

/** The owner's view of its settings. */
export interface SellerPaymentView {
  /** The shop's state allows the button (verified, active or grace). */
  eligible: boolean;
  shopName: string;
  ice: string;
  /** The link the button opens now. */
  url: string | null;
  /** The saved link, also while its host is off the list (then `url` is null and the button hidden). */
  storedUrl: string | null;
  pending: { url: string; host: string; activeFrom: string | null; review: boolean } | null;
  hostRejected: { host: string; reason: string; at: string } | null;
  cashOnDelivery: boolean;
  info: z.infer<typeof sellerInfoInputSchema> | null;
  suspended: { reason: string; at: string } | null;
  termsVersion: string;
}

/** 422 `payment_link_invalid` details. */
export interface PaymentLinkIssue {
  problem: PaymentLinkProblem;
}

/** What a public page shows of a shop's payment (no link: the button asks for it at click time). */
export interface PublicShopPayment {
  proId: string;
  shopName: string;
  ice: string;
  /** A link is in force (re-checked when the buyer clicks). */
  online: boolean;
  host: string | null;
  cashOnDelivery: boolean;
  info: z.infer<typeof sellerInfoInputSchema>;
}

/** `PUT /api/listings/{id}/payment-link`: the listing's own payment page, or null to go back to the shop's. */
export const listingPaymentLinkInputSchema = z.object({ url: z.string().max(PAYMENT_URL_MAX).nullable() }).strict();
export type ListingPaymentLinkInput = z.infer<typeof listingPaymentLinkInputSchema>;

export const openPaymentSchema = z.object({ listingId: z.string().min(1).max(64).optional() }).strict();

/** POST /api/shops/{proId}/payment: the link to open now. */
export interface OpenPaymentResponse {
  url: string;
  host: string;
  shopName: string;
  ice: string;
}

const hostSchema = z.string().trim().toLowerCase().min(4).max(253);

export const sellerPaymentsUpdateSchema = z.object({ hosts: z.array(hostSchema).max(PAYMENT_HOSTS_MAX) }).strict();
export const paymentHostReviewSchema = z
  .object({ host: hostSchema, decision: z.enum(["approve", "reject"]), reason: z.string().trim().min(3).max(500).optional() })
  .strict()
  .refine((value) => value.decision === "approve" || value.reason !== undefined, { message: "reason required", path: ["reason"] });
export const shopPaymentActionSchema = z.object({ action: z.enum(["suspend", "restore"]), reason: z.string().trim().min(3).max(500) }).strict();

export interface PaymentHostQueueItem {
  proId: string;
  shopName: string;
  host: string;
  url: string;
  /** ISO, when the owner saved the link. */
  since: string;
}

export interface SellerPaymentsAdminView {
  hosts: string[];
  queue: PaymentHostQueueItem[];
}

/** The back office's view of one shop's button. */
export interface ShopPaymentAdminView {
  url: string | null;
  pendingUrl: string | null;
  cashOnDelivery: boolean;
  suspended: { reason: string; at: string } | null;
}
