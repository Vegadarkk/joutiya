import type { ListingStatus } from "@/lib/contracts/listings";
import { RECENT_AUTH_SECONDS, type ExportSection } from "@/lib/contracts/account";

// Account closure rules (phase 5 D26, lot L7; AF §5 UserPrivate, §7 retention table). Pure: the
// closure service, the retention step and the unit tests share them. No server import.

/** Account data (e-mail, phone, pseudonym, identifiers): 1 year after the closure (décret 2021-1362). */
export const ACCOUNT_RETENTION_YEARS = 1;
/** Civil identity (legal name, when collected): 5 years after the closure. */
export const IDENTITY_RETENTION_YEARS = 5;

function addYears(from: Date, years: number): Date {
  const date = new Date(from.getTime());
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date;
}

export interface ClosureDates {
  closedAt: Date;
  purgeAt: Date;
  identityPurgeAt: Date;
}

export function closureDates(now: Date): ClosureDates {
  return { closedAt: now, purgeAt: addYears(now, ACCOUNT_RETENTION_YEARS), identityPurgeAt: addYears(now, IDENTITY_RETENTION_YEARS) };
}

/** The session's sign-in (auth_time, seconds) is recent enough for a closure. */
export function isRecentSignIn(authTimeSeconds: number, now: Date, maxAgeSeconds = RECENT_AUTH_SECONDS): boolean {
  const age = now.getTime() / 1000 - authTimeSeconds;
  return Number.isFinite(age) && age <= maxAgeSeconds && age >= -60;
}

/** A banned account stays banned once closed (the ban is what blocks a new sign-up); any other becomes "closed". */
export function statusAfterClosure(current: string): "closed" | "banned" {
  return current === "banned" ? "banned" : "closed";
}

/**
 * Listings the closure takes off: every status a public page or the search still shows, and the
 * one held for review. Drafts (purged 30 days after their last edit), rejected, removed and purged
 * listings keep their own clock.
 */
export const CLOSURE_LISTING_STATUSES: readonly ListingStatus[] = ["published", "paused", "pending_review", "sold", "expired"];

/** Removal + 12 months (AF §7), never later than the purge date the listing already had. */
export function closurePurgeAt(current: Date | undefined, computed: Date): Date {
  return current && current.getTime() < computed.getTime() ? current : computed;
}

// ---- Pro refusal (phase 7 state, read only) ------------------------------------------------------

/** Subscription states that still renew or are being recovered (phase 7 design §3 `subscriptions`). */
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "grace", "billing_issue"] as const;

export interface ClosureBillingState {
  /** proProfiles/{proId}: `planSource` "subscription" in `active` or `grace` is a paid plan running. */
  proProfile: { planSource: string; lifecycle: string } | null;
  /** subscriptions/{uid} and subscriptions/pro_{proId}, as stored (missing: absent from the list). */
  subscriptions: readonly { status?: unknown; willRenew?: unknown }[];
  /** wallets/{uid} and wallets/pro_{proId}, as stored. */
  wallets: readonly { balance?: unknown }[];
}

export type ClosureBlocker = "pro_subscription_active" | "wallet_not_empty";

/**
 * Why the account cannot close yet: a Pro subscription that still renews (cancel it first), or
 * purchased credits left (spend them or ask for a refund). The spec says nothing about Pro
 * accounts; refusing keeps a closure from cutting a paid service short (owner follow-up, L7).
 * A subscription document decides when there is one (a cancelled one, `willRenew` false, runs out
 * on its own); the profile's copy of the plan only when there is none.
 */
export function closureBlocker(state: ClosureBillingState): ClosureBlocker | null {
  const paidPlan = state.subscriptions.length === 0 && state.proProfile?.planSource === "subscription" && (state.proProfile.lifecycle === "active" || state.proProfile.lifecycle === "grace");
  const liveSubscription = state.subscriptions.some((subscription) => (LIVE_SUBSCRIPTION_STATUSES as readonly unknown[]).includes(subscription.status) && subscription.willRenew !== false);
  if (paidPlan || liveSubscription) return "pro_subscription_active";
  if (state.wallets.some((wallet) => typeof wallet.balance === "number" && wallet.balance > 0)) return "wallet_not_empty";
  return null;
}

// ---- Retention (retention-purge step) -----------------------------------------------------------

const dateOf = (value: unknown): Date | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value : null);
const holdOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

export type AccountPurgeVerdict =
  /** Not a closed account past its purgeAt (changed since the query, or malformed). */
  | { kind: "skip" }
  /** Under a legal hold: kept, the next nights look again. */
  | { kind: "held" }
  /** Purge now; `keepIdentity` writes users/{uid}/private/identity until identityPurgeAt. */
  | { kind: "purge"; keepIdentity: boolean; keepEmailBlock: boolean };

/**
 * What the nightly purge does with users/{uid}/private/account (dates converted): closed, past
 * purgeAt and not held -> purge the account; the civil identity (legalName) and, for a banned
 * account, the e-mail block outlive it until identityPurgeAt.
 */
export function accountPurgeVerdict(account: Record<string, unknown>, userStatus: string | null, now: Date): AccountPurgeVerdict {
  const closedAt = dateOf(account.closedAt);
  const purgeAt = dateOf(account.purgeAt);
  if (!closedAt || !purgeAt || purgeAt.getTime() > now.getTime()) return { kind: "skip" };
  if (holdOf(account.legalHold).length > 0) return { kind: "held" };
  const identityPurgeAt = dateOf(account.identityPurgeAt);
  const identityDue = !identityPurgeAt || identityPurgeAt.getTime() <= now.getTime();
  const banned = userStatus === "banned";
  const legalName = typeof account.legalName === "string" && account.legalName.length > 0;
  const keepEmailBlock = banned && !identityDue;
  return { kind: "purge", keepIdentity: !identityDue && (legalName || keepEmailBlock), keepEmailBlock };
}

/** users/{uid}/private/identity past its purgeAt (the account's identityPurgeAt) and not held. */
export function identityPurgeable(identity: Record<string, unknown>, now: Date): boolean {
  const at = dateOf(identity.purgeAt);
  return at !== null && at.getTime() <= now.getTime() && holdOf(identity.legalHold).length === 0;
}

// ---- Export (GET /api/account/export) -----------------------------------------------------------

/**
 * Documents read per list of the export, the newest kept when a list is longer (stated in the
 * file). Firestore Spark allows 50 000 reads a day for the whole site: one export reads at most
 * EXPORT_MAX_READS, and an account downloads three a day (rate limit `account.export.uid`).
 */
export const EXPORT_LIMITS = {
  listings: 200,
  favorites: 200,
  savedSearches: 50,
  conversations: 50,
  /** All conversations together. */
  messages: 1000,
  reportsFiled: 100,
  decisions: 100,
  blockedAccounts: 100,
} as const satisfies Record<ExportSection, number>;

/** Messages of one conversation at most (its newest). */
export const EXPORT_MESSAGES_PER_CONVERSATION = 200;

/**
 * Upper bound of the reads of one export: the four single documents (profile, account, Pro
 * profile, block list), one more per paged list (the "is there more" probe), the lists, and the
 * decision behind each filed report (a notifier's own appeal lives on it).
 */
export const EXPORT_MAX_READS =
  4 +
  EXPORT_LIMITS.listings + 1 +
  EXPORT_LIMITS.favorites + 1 +
  EXPORT_LIMITS.savedSearches +
  EXPORT_LIMITS.conversations + 1 +
  EXPORT_LIMITS.messages + EXPORT_LIMITS.conversations +
  EXPORT_LIMITS.reportsFiled + 1 + EXPORT_LIMITS.reportsFiled +
  EXPORT_LIMITS.decisions + 1 +
  EXPORT_LIMITS.blockedAccounts;

/** Messages to read for each conversation (newest first), within the per-conversation and total limits. */
export function messageAllowances(counts: readonly number[], total: number = EXPORT_LIMITS.messages, perConversation: number = EXPORT_MESSAGES_PER_CONVERSATION): number[] {
  let left = total;
  return counts.map((count) => {
    const take = Math.max(0, Math.min(count, perConversation, left));
    left -= take;
    return take;
  });
}
