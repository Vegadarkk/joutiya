import type { Locale } from "@/config/site";

// Mail adapter (§2 "Adapters": MailTransport). Resend in production, Brevo as the security
// fallback, an in-memory mailbox in development (DEV_MAILBOX). The web app only enqueues; the
// worker sends (BullMQ queue "mail", priorities), or the web sends inline when no queue is set.

export type TemplateId =
  | "verifyEmail"
  | "resetPassword"
  | "signupExisting"
  | "passwordChanged"
  | "staffInvite"
  | "phoneVerified"
  | "phoneRemoved"
  // Listings (phase 3): publication, hold and rejection with an art. 17-style statement.
  | "listingPublished"
  | "listingPendingReview"
  | "listingRejected";

/**
 * Statement of reasons (art. 17 DSA, design D8) carried by the hold and rejection mails. The
 * sentences are rendered by the template in the recipient's language; `facts` are flag codes
 * (MODERATION_FLAGS) or free text already in the recipient's language, `ground` a CGU reference.
 */
export interface ModerationStatement {
  /** What was done: held for review, or rejected. */
  measure: "hold" | "reject";
  /** Signals that led to the measure: moderation flag codes, or a moderator's sentence. */
  facts: string[];
  /** Legal or contractual ground, e.g. "CGU §7.2". */
  ground: string;
  /** Automated detection and decision (no human in the loop at this stage). */
  automated: true;
  /** Where to object: the DSA contact address of the legal configuration. */
  redress: string;
}

export interface TemplateData {
  verifyEmail: { displayName: string; actionUrl: string };
  resetPassword: { displayName: string; actionUrl: string };
  signupExisting: { displayName: string; loginUrl: string; resetUrl: string };
  passwordChanged: { displayName: string; at: string };
  staffInvite: { displayName: string; actionUrl: string; role: "moderator" | "admin" };
  phoneVerified: { displayName: string; phone: string };
  /** The number was verified on another account and left this one. */
  phoneRemoved: { displayName: string; phone: string };
  /** The listing is online: its public URL (localized) and the expiry date (ISO). */
  listingPublished: { displayName: string; title: string; url: string; expiresAt: string };
  /** Held by the pre-moderation: a moderator will decide; statement of the automated measure. */
  listingPendingReview: { displayName: string; title: string; listingId: string; statement: ModerationStatement };
  /** Rejected (automated or by a moderator): statement of reasons and how to object. */
  listingRejected: { displayName: string; title: string; listingId: string; statement: ModerationStatement };
}

/** Security mails bypass the suppression list and fall back to Brevo when Resend is exhausted. */
export type MailPriority = "security" | "transactional" | "bulk";

export interface TemplateMail<T extends TemplateId = TemplateId> {
  template: T;
  locale: Locale;
  to: string;
  data: TemplateData[T];
  priority?: MailPriority;
  /** Dedupe key for the queue (same key within 24 h = one mail). */
  idempotencyKey?: string;
}

export interface RenderedMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: Record<string, string>;
  /** Source of the rendering (dev mailbox and logs only): never sent to a provider. */
  meta?: { template: TemplateId; locale: Locale; data: TemplateData[TemplateId] };
}

export interface SendResult {
  provider: string;
  id: string;
  /** Used quota reported by the provider, when it says so (Resend headers). */
  quota?: { daily?: number; monthly?: number };
}

export interface MailTransport {
  readonly name: string;
  send(mail: RenderedMail, idempotencyKey?: string): Promise<SendResult>;
}
