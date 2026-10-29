import { z } from "@/lib/zod";

// « Payer chez le vendeur » (owner decision 2026-10-28, design phase-7/boutique-temporaire.md §2): a
// verified Pro links its own payment page (its bank's, its acquirer's or its provider's) or accepts
// cash on delivery. Money never goes through the platform, which takes no commission and adds
// nothing to the link. Firestore `config/sellerPayments` holds the hosts an admin has checked
// belong to a licensed payment provider: exact names, no wildcard, empty by default (no Moroccan
// provider's payment domain was confirmed on 2026-10-28). A link on another host waits for an
// admin's review. The server never fetches a link. Client-safe.

/** A lower-case DNS name with at least one dot, no IP literal (checked apart), no trailing dot. */
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const PAYMENT_HOSTS_MAX = 200;

export const sellerPaymentsConfigSchema = z
  .object({
    hosts: z
      .array(z.string().regex(HOST))
      .max(PAYMENT_HOSTS_MAX)
      .refine((hosts) => new Set(hosts).size === hosts.length, { message: "duplicate host" }),
  })
  .strict();
export type SellerPaymentsConfig = z.infer<typeof sellerPaymentsConfigSchema>;

export const DEFAULT_SELLER_PAYMENTS: SellerPaymentsConfig = { hosts: [] };

/** Admin metadata a stored document may carry besides the config. */
const METADATA_KEYS: ReadonlySet<string> = new Set(["updatedAt", "updatedBy"]);

/** The stored document over the defaults; an invalid one falls back whole (no host allowed is the safe side). */
export function resolveSellerPaymentsConfig(stored: unknown): { config: SellerPaymentsConfig; errors: string[] } {
  if (stored === undefined || stored === null) return { config: DEFAULT_SELLER_PAYMENTS, errors: [] };
  if (typeof stored !== "object" || Array.isArray(stored)) return { config: DEFAULT_SELLER_PAYMENTS, errors: ["config/sellerPayments: not an object"] };
  const fields = Object.fromEntries(Object.entries(stored).filter(([key]) => !METADATA_KEYS.has(key)));
  const parsed = sellerPaymentsConfigSchema.safeParse({ ...DEFAULT_SELLER_PAYMENTS, ...fields });
  if (parsed.success) return { config: parsed.data, errors: [] };
  return { config: DEFAULT_SELLER_PAYMENTS, errors: parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`) };
}

/** A new link turns active this long after it was saved (a hijacked account cannot divert payments silently). */
export const PAYMENT_LINK_DELAY_MS = 24 * 60 * 60 * 1000;
/** Saving a link needs a sign-in this recent (seconds). */
export const PAYMENT_LINK_RECENT_AUTH_SECONDS = 10 * 60;
export const PAYMENT_URL_MAX = 500;

/** URL shorteners and redirectors: they hide the real payment page. */
const SHORTENERS: ReadonlySet<string> = new Set([
  "bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "rebrand.ly", "cutt.ly", "shorturl.at", "rb.gy", "t.ly", "tiny.cc", "s.id", "lnkd.in", "linktr.ee", "qr.io",
]);

/** `unlisted`: a listing's own link must be on a host already checked (catalogue §6); the shop's link goes to review instead. */
export type PaymentLinkProblem = "invalid" | "https" | "credentials" | "port" | "ip" | "shortener" | "unlisted";

/** The host of an acceptable payment link, or why the link is refused (the allowlist is checked apart). */
export function parsePaymentLink(raw: string): { host: string; url: string } | { problem: PaymentLinkProblem } {
  const text = raw.trim();
  if (text.length === 0 || text.length > PAYMENT_URL_MAX || /\s/.test(text)) return { problem: "invalid" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { problem: "invalid" };
  }
  if (url.protocol !== "https:") return { problem: "https" };
  if (url.username || url.password) return { problem: "credentials" };
  if (url.port) return { problem: "port" };
  const host = url.hostname.toLowerCase();
  if (/^\d+(?:\.\d+){3}$/.test(host) || host.startsWith("[")) return { problem: "ip" };
  if (!HOST.test(host)) return { problem: "invalid" };
  if (SHORTENERS.has(host)) return { problem: "shortener" };
  // Percent-encoding can lengthen the link past what the stored document accepts.
  const normalized = url.toString();
  if (normalized.length > PAYMENT_URL_MAX) return { problem: "invalid" };
  return { host, url: normalized };
}

/** The host of a stored link (already parsed when saved), or null. */
export function paymentLinkHost(raw: string | undefined): string | null {
  if (!raw) return null;
  const parsed = parsePaymentLink(raw);
  return "host" in parsed ? parsed.host : null;
}

/** Whether `host` is on the allowlist (exact name). */
export function isAllowedPaymentHost(host: string, config: SellerPaymentsConfig): boolean {
  return config.hosts.includes(host);
}

/** Seller information that law 31-08 (art. 29) asks of a distance seller, filled by the Pro. */
export const SELLER_INFO_LIMITS = { address: 300, email: 254, delivery: 600, returns: 600 } as const;
