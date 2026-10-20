import type { Locale } from "@/config/site";
import { z } from "@/lib/zod";

// Account closure and personal data export (phase 5 design D26, lot L7; AF §5 UserPrivate, §6
// "La clôture passe par l'API", §7 retention table). Client-safe: the settings page and the API
// share these shapes. Paths are in endpoints.ts (ACCOUNT_API).

/** A closure needs a sign-in younger than this (session auth_time); older: 403 `recent_auth_required`. */
export const RECENT_AUTH_SECONDS = 10 * 60;

/** POST /api/account/close body: an explicit confirmation, nothing else. */
export const closeAccountSchema = z.object({ confirm: z.literal(true) }).strict();
export type CloseAccountInput = z.infer<typeof closeAccountSchema>;

/** POST /api/account/close: the account is closed (also when it already was: idempotent). */
export interface CloseAccountResponse {
  status: "closed";
  /** ISO. */
  closedAt: string;
  /** ISO: e-mail, phone and pseudonym are deleted at this date (closure + 1 year). */
  purgeAt: string;
}

export const ACCOUNT_EXPORT_FORMAT = "joutiya.account-export";
export const ACCOUNT_EXPORT_VERSION = 1;

/** Lists of the export, each read up to its limit (Firestore Spark: 50 000 reads a day for the whole site). */
export const EXPORT_SECTIONS = ["listings", "favorites", "savedSearches", "conversations", "messages", "reportsFiled", "decisions", "blockedAccounts"] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

export interface ExportListing {
  id: string;
  slugId: string | null;
  status: string;
  pausedReason: string | null;
  sellerName: string;
  sellerType: "individual" | "pro";
  title: string;
  description: string;
  categoryId: string | null;
  subcategoryId: string | null;
  attributes: Record<string, unknown>;
  condition: string | null;
  price: number | null;
  priceNegotiable: boolean;
  isDonation: boolean;
  location: { regionCode: string; citySlug: string; district: string | null } | null;
  photoIds: string[];
  contact: { messaging: boolean; showPhone: boolean; whatsapp: boolean };
  sensitiveDeclaration: { kind: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  expiresAt: string | null;
}

export interface ExportMessage {
  mine: boolean;
  type: "text" | "system";
  /** As stored: links and contact details masked, `⟦hidden⟧` once hidden by moderation. */
  text: string;
  flags: string[];
  hidden: boolean;
  createdAt: string;
  readAt: string | null;
}

export interface ExportConversation {
  cid: string;
  role: "buyer" | "seller";
  listing: { slugId: string; title: string; price: number | null; isDonation: boolean };
  counterpart: { publicId: string; displayName: string };
  archived: boolean;
  deletedForMe: boolean;
  blockedByMe: boolean;
  frozen: boolean;
  createdAt: string;
  updatedAt: string;
  /** Oldest first; the newest ones when the conversation is longer than the limit. */
  messages: ExportMessage[];
  messagesTruncated: boolean;
}

export interface ExportReport {
  id: string;
  target: { type: string; listingId: string | null; publicId: string | null };
  reasonId: string;
  explanation: string;
  reporter: { name: string | null; email: string | null; locale: Locale };
  status: string;
  outcome: string | null;
  createdAt: string;
  closedAt: string | null;
  /** This notifier's own appeal against the outcome (art. 20 DSA), when there is one. */
  appeal: { status: string; text: string | null; openedAt: string; closedAt: string | null; note: string | null } | null;
}

export interface ExportDecision {
  decisionId: string;
  action: string;
  targetType: string;
  templateId: string;
  durationDays: number | null;
  origin: string;
  automated: { detection: boolean; decision: boolean };
  /** Statement of reasons as stored (French). */
  facts: string;
  ground: { type: string; ref: string; explanation: string };
  createdAt: string;
  notifiedAt: string | null;
  appealDeadline: string;
  appeal: { status: string; text: string | null; openedAt: string; closedAt: string | null; note: string | null } | null;
}

export interface AccountExport {
  format: typeof ACCOUNT_EXPORT_FORMAT;
  version: typeof ACCOUNT_EXPORT_VERSION;
  /** ISO. */
  generatedAt: string;
  /** What the file is and what it leaves out, in the account's language (French for Tarifit). */
  about: string[];
  /** Lists cut at their limit for this download (the newest kept). */
  truncated: Partial<Record<ExportSection, { limit: number }>>;
  profile: {
    publicId: string;
    displayName: string;
    type: "individual" | "pro";
    regionCode: string | null;
    citySlug: string | null;
    locale: Locale;
    status: string;
    badges: { emailVerified: boolean; phoneVerified: boolean; proCertified: boolean };
    stats: { activeListings: number; responseRate: number; medianReplyMin: number; ratingAvg: number | null; ratingCount: number };
    createdAt: string;
    updatedAt: string;
  } | null;
  account: {
    email: string;
    phone: string | null;
    phoneVerifiedAt: string | null;
    legalName: string | null;
    providers: string[];
    consents: { cgu: { version: string; at: string }; transfers: { version: string; at: string }; marketing: boolean };
    notifications: { messagesEmail: boolean };
    sanctions: { strikeLevel: number; lastAt: string | null; suspendedUntil: string | null };
    reporting: { abusiveUntil: string | null; warnedAt: string | null };
  } | null;
  pro: {
    name: string;
    slug: string;
    description: string;
    website: string | null;
    regionCode: string;
    citySlug: string;
    whatsapp: boolean;
    phonePublic: string | null;
    legal: Record<string, string>;
    verification: { status: string; submittedAt: string | null; pieces: number; rejectReason: string | null; phoneCheck: { at: string; outcome: string; phone: string } | null };
    certifiedAt: string | null;
    lifecycle: string;
    plan: string;
    planSource: string;
    createdAt: string;
  } | null;
  listings: ExportListing[];
  favorites: { listingId: string; slugId: string; title: string; price: number | null; isDonation: boolean; savedAt: string }[];
  savedSearches: { name: string; params: Record<string, unknown>; alert: string; createdAt: string; updatedAt: string; lastAlertAt: string | null }[];
  conversations: ExportConversation[];
  reportsFiled: ExportReport[];
  decisions: ExportDecision[];
  blockedAccounts: { publicId: string; displayName: string }[];
}
