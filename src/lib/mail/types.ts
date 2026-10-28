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
  // Listings (phase 3): publication, hold and rejection with an art. 17-style statement, the
  // moderator's approval (online now, or changes approved on a paused or expired listing), the
  // expiry reminder and the expiry notice.
  | "listingPublished"
  | "listingPendingReview"
  | "listingRejected"
  | "listingApproved"
  | "listingChangesApproved"
  | "listingExpiringSoon"
  | "listingExpired"
  // Reports (phase 5, L2): acknowledgement of a notice (art. 16(4) DSA).
  | "reportReceived"
  // Decisions (phase 5, L3): statement of reasons (art. 17), outcome to the reporter (art. 16(5)),
  // restoration, appeal received and decided (art. 20), reporter warning (art. 23).
  | "decisionNotice"
  | "reportOutcome"
  | "contentRestored"
  | "appealReceived"
  | "appealOutcome"
  | "reporterWarning"
  // Search (phase 4): the daily digest of the saved searches with an alert (design D19).
  | "savedSearchAlert"
  // Pro accounts (phase 7): the moderator's decision on the application.
  | "proApproved"
  | "proRejected"
  // Pro plans (phase 7, lot 4b): the end of the launch offer, notices then downgrade (design D3).
  | "launchOfferNotice"
  // Messaging (phase 5, L5): the grouped new-messages mail (design D21).
  | "newMessages"
  // Account closure (phase 5, L7, D26): confirmation with what is kept and until when.
  | "accountClosed";

/**
 * Statement of reasons (art. 17 DSA, design D8) carried by the hold and rejection mails. The
 * sentences are rendered by the template in the recipient's language; `facts` are flag codes
 * (MODERATION_FLAGS), reject reason codes (`reason:<code>`, src/lib/moderation/decisions.ts) or a
 * moderator's free text, `ground` a CGU reference.
 */
export interface ModerationStatement {
  /** What was done: held for review, or rejected. */
  measure: "hold" | "reject";
  /** Signals that led to the measure: moderation flag codes, or a moderator's sentence. */
  facts: string[];
  /** Legal or contractual ground, e.g. "CGU §7.2". */
  ground: string;
  /** true: automated detection and decision (pre-moderation); false: decided by a moderator. */
  automated: boolean;
  /** Where to object: the DSA contact address of the legal configuration. */
  redress: string;
}

/** Why a phase 5 decision was taken (art. 17(3)(b)): a notice, our own check, or an authority order. */
export type DecisionSource = "notice" | "own_initiative" | "authority_order";
/** Automated means used (art. 17(3)(c)): detection and/or decision. */
export interface DecisionAutomation {
  detection: boolean;
  decision: boolean;
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
  /** Approved by a moderator after a hold: online now, public URL and expiry date (ISO). */
  listingApproved: { displayName: string; title: string; url: string; expiresAt: string };
  /**
   * A held edit approved on a listing that stays off line: paused by its owner (resumable until
   * `until` = its expiry) or expired (renewable until `until` = its purge date). `url`: "Mes annonces".
   */
  listingChangesApproved: { displayName: string; title: string; status: "paused" | "expired"; url: string; until: string };
  /** Reminder a few days before expiry (bulk): public URL and expiry date (ISO). */
  listingExpiringSoon: { displayName: string; title: string; url: string; expiresAt: string };
  /** Expired: renewable from "Mes annonces" until `purgeAt` (ISO), then deleted. */
  listingExpired: { displayName: string; title: string; purgeAt: string };
  /**
   * Notice received (art. 16(4) DSA): reference, target type, reason id (labels in
   * src/config/report-reasons.ts), target delay in hours, reception date (ISO). `displayName` is
   * null for a visitor who gave no name (P0); `urgent` adds the emergency numbers.
   */
  reportReceived: { displayName: string | null; reportId: string; targetType: "listing" | "user" | "message" | "pro"; reasonId: string; slaHours: number; receivedAt: string; urgent: boolean };
  /** Statement of reasons of a restrictive decision (art. 17 DSA), with the signed appeal link (null: authority order). */
  decisionNotice: {
    displayName: string;
    decisionId: string;
    /** src/config/decision-templates.ts: facts and ground in the recipient's language. */
    templateId: string;
    action: "remove" | "restrict_visibility" | "warn" | "suspend_account" | "ban";
    targetType: "listing" | "user" | "message";
    /** Listing title (listing target), else null. */
    title: string | null;
    /** The moderator's own words, quoted as written. */
    details: string | null;
    durationDays: number | null;
    /** End of a suspension (ISO). */
    until: string | null;
    source: DecisionSource;
    automated: DecisionAutomation;
    appealToken: string | null;
    /** ISO. */
    appealDeadline: string;
  };
  /** What became of a notice (art. 16(5) DSA); no detail on the measures beyond what is needed. */
  reportOutcome: {
    displayName: string | null;
    reportId: string;
    /** ISO date of the notice. */
    reportedAt: string;
    targetType: "listing" | "user" | "message" | "pro";
    outcome: "actioned" | "dismissed";
    action: "remove" | "restrict_visibility" | "restore" | "no_action" | "warn" | "suspend_account" | "ban";
    automated: DecisionAutomation;
    decisionId: string;
    appealToken: string | null;
    appealDeadline: string;
  };
  /** Hidden content shown again, or an account restriction lifted (report dismissed or appeal granted). */
  contentRestored: { displayName: string; targetType: "listing" | "user" | "message"; title: string | null; via: "report" | "appeal"; decisionId: string };
  /** Appeal received (art. 20 DSA): reference, date (ISO), answer delay. */
  appealReceived: { displayName: string | null; decisionId: string; receivedAt: string; slaDays: number };
  /** Appeal decided by another moderator: upheld or reversed, with the reasons. */
  appealOutcome: { displayName: string | null; decisionId: string; outcome: "upheld" | "reversed"; by: "affected" | "reporter"; note: string; reviewedAt: string };
  /** Art. 23(2) DSA: prior warning after manifestly unfounded notices, then the suspension of the notices until `until`. */
  reporterWarning: { displayName: string; kind: "warning" | "suspended"; count: number; windowDays: number; until: string | null };
  /**
   * Daily digest (bulk): the saved searches with new listings since the last digest.
   * `unsubscribeToken` (src/lib/alerts/unsubscribe-token.ts, every alert of the account) builds the
   * List-Unsubscribe header and the "Se désabonner" link.
   */
  savedSearchAlert: { displayName: string; searches: SavedSearchAlertSection[]; unsubscribeToken: string };
  /** `launchOffer`: Essentiel offered until sales open, `noticeDays` of notice before any payment. */
  proApproved: { displayName: string; shopName: string; launchOffer: boolean; noticeDays: number };
  /** The moderator's reason; `contact` is where to object (legal configuration). */
  proRejected: { displayName: string; shopName: string; reason: string; contact: string };
  /**
   * `ending`: notice before `endsAt` (ISO); `ended`: the shop was downgraded, `paused` listings over
   * the free quota (`freeListings`, null = unlimited) were paused.
   */
  launchOfferNotice: { displayName: string; shopName: string; plan: "essentiel" | "business"; kind: "ending" | "ended"; endsAt: string; freeListings: number | null; paused: number };
  /**
   * Grouped new-messages mail (bulk, D21): the unread total and up to 3 conversations (listing
   * title, the other member's display name). Never the text of a message.
   */
  newMessages: { displayName: string; count: number; conversations: { listingTitle: string; counterpartName: string }[] };
  /** The account is closed: closure date and the purge of the account data (ISO). */
  accountClosed: { displayName: string; closedAt: string; purgeAt: string };
}

/** One saved search of the digest: its results page, the count of new listings and the newest few. */
export interface SavedSearchAlertSection {
  name: string;
  /** Results page of the search (absolute, recipient's locale). */
  url: string;
  /** New listings since the last digest (the ones listed included). */
  total: number;
  listings: SavedSearchAlertListing[];
}

export interface SavedSearchAlertListing {
  title: string;
  /** Listing page (absolute, recipient's locale). */
  url: string;
  price: number | null;
  isDonation: boolean;
  citySlug: string | null;
}

/** Templates whose Firebase action link (live oobCode) the worker generates at delivery. */
export type ActionLinkTemplate = "verifyEmail" | "resetPassword" | "staffInvite";

/**
 * The action link of a queued mail, for its recipient (`to`): the queue holds this request, never
 * a live oobCode (audit B3-12). At delivery the Admin SDK generates the code and the mail gets
 * `actionUrl` = `url` plus `oobCode`; `continueUrl` is the SDK's own continue URL.
 */
export interface ActionLinkRequest {
  action: "verifyEmail" | "resetPassword";
  /** The Joutiya page the code is appended to, its other query parameters included (`mode`). */
  url: string;
  continueUrl: string;
}

/**
 * The data of a queued mail: an action-link template carries its link request in place of
 * `actionUrl` (a resolved `actionUrl` stays accepted: jobs queued before B3-12, and tests).
 */
export type QueuedTemplateData = {
  [T in TemplateId]: T extends ActionLinkTemplate ? TemplateData[T] | (Omit<TemplateData[T], "actionUrl"> & { actionLink: ActionLinkRequest }) : TemplateData[T];
};

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

/** A mail as the web app enqueues it and the worker receives it (`deliverMail` resolves its action link). */
export interface MailJob<T extends TemplateId = TemplateId> extends Omit<TemplateMail<T>, "data"> {
  data: QueuedTemplateData[T];
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
