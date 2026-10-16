import type { Locale } from "@/config/site";

// Mail adapter (§2 "Adapters": MailTransport). Resend in production, Brevo as the security
// fallback, an in-memory mailbox in development (DEV_MAILBOX). The web app only enqueues; the
// worker sends (BullMQ queue "mail", priorities), or the web sends inline when no queue is set.

export type TemplateId = "verifyEmail" | "resetPassword" | "signupExisting" | "passwordChanged" | "staffInvite" | "phoneVerified" | "phoneRemoved";

export interface TemplateData {
  verifyEmail: { displayName: string; actionUrl: string };
  resetPassword: { displayName: string; actionUrl: string };
  signupExisting: { displayName: string; loginUrl: string; resetUrl: string };
  passwordChanged: { displayName: string; at: string };
  staffInvite: { displayName: string; actionUrl: string; role: "moderator" | "admin" };
  phoneVerified: { displayName: string; phone: string };
  /** The number was verified on another account and left this one. */
  phoneRemoved: { displayName: string; phone: string };
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
