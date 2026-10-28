// API error model (§6). Every route answers errors as `{ error: { code, message?, details? } }` with a
// stable `code` the client translates; `message` is a short English hint for logs and curl, never
// shown to users. Codes are deliberately coarse: a 401 never says whether an account exists.

export type ErrorCode =
  | "invalid_body"
  | "invalid_json"
  | "payload_too_large"
  | "unauthenticated"
  | "forbidden"
  | "csrf"
  | "origin"
  | "not_found"
  | "method_not_allowed"
  | "conflict"
  | "rate_limited"
  | "turnstile_required"
  | "turnstile_failed"
  | "invalid_credentials"
  | "account_locked"
  | "account_disabled"
  | "account_suspended"
  | "email_not_verified"
  | "role_missing"
  | "invalid_code"
  | "expired_code"
  | "weak_password"
  | "disposable_email"
  | "consent_required"
  | "phone_invalid"
  | "phone_not_mobile"
  // Listings and media (phase 3, design §3). Messages: Listing.errors.<code> in messages/*.json.
  /** 422 at publish: hard blockers (details: FieldIssue[]). */
  | "invalid_listing"
  /** 5 drafts per user. */
  | "draft_limit"
  /** Active listings quota of the account (individual 20, Pro by plan). */
  | "listing_limit"
  /** 5 listings created per day (individuals). */
  | "listing_daily_limit"
  /** Photos per listing (10, Pro 20). */
  | "photo_limit"
  /** Upload documents per listing (UPLOADS_PER_PHOTO_SLOT x the photo limit, refused ones included). */
  | "upload_limit"
  /** Declared or real size above MAX_UPLOAD_BYTES. */
  | "file_too_large"
  /** Declared type or sniffed bytes outside JPEG/WebP/PNG. */
  | "unsupported_media"
  /** r2.storage quota degraded: uploads suspended (D15). */
  | "storage_full"
  /** Upload referenced before its processing finished. */
  | "upload_not_ready"
  /** A verified phone is needed (showPhone, WhatsApp). */
  | "phone_required"
  /** Pro verification: the owner's number is not verified yet (WhatsApp, or the moderator's call). */
  | "phone_unverified"
  /** Listing not published any more (paused, sold, expired, removed). */
  | "listing_unavailable"
  /** Phone reveal refused: account too young, e-mail unverified or quota reached. */
  | "reveal_not_allowed"
  /** Publish in an adults-only subcategory without the seller's attestation (422). */
  | "adults_only_attestation"
  // Search and discovery (phase 4). Messages: Listing.errors.<code>.
  /** Search engine missing or unreachable (503). */
  | "search_unavailable"
  /** Favorites per account (FAVORITES_MAX). */
  | "favorite_limit"
  /** Saved searches per account (10, §5). */
  | "saved_search_limit"
  /** The same search is already saved (409; details: { id }). */
  | "saved_search_exists"
  /** Unsubscribe link token invalid or for another account. */
  | "invalid_token"
  // Pro accounts (phase 7, design §4). Messages: Pro.errors.<code> (with the wizard UI).
  /** config/flags.proSignupEnabled is off. */
  | "pro_signup_closed"
  /** The account is already a Pro. */
  | "already_pro"
  /** An application is pending or accepted for this account (409). */
  | "pro_application_exists"
  /** KYBC pieces that are not the applicant's `kyb` uploads. */
  | "invalid_pieces"
  // Credits and paid options (phase 7, design §5). Messages: Options.errors.<code>.
  /** config/flags.salesEnabled is off: nothing can be bought (403). */
  | "sales_closed"
  /** A shop's credits are spent by its owner only (403). */
  | "billing_owner_only"
  /** The listing is not published or is hidden by moderation (409). */
  | "listing_not_promotable"
  /** The listing sorted from a publication, renewal or bump within the last hour (409). */
  | "bump_too_soon"
  /** Negative balance after a refund: no purchase until it is covered (409). */
  | "wallet_frozen"
  /** Plan credits + balance below the price (402). */
  | "insufficient_credits"
  /** The option's cost moved since the buyer saw it (price, allowance or plan credits; 409). */
  | "price_changed"
  // Pro subscriptions (phase 7, design §7). Messages: Subscription.errors.<code>.
  /** The shop already has a plan: changes go through the Stripe portal (409). */
  | "already_subscribed"
  /** Pass Boutique: bought now it would end beyond `maxAheadDays`, or the free launch offer still runs. */
  | "pass_max_ahead"
  | "launch_offer_running"
  | "pass_other_plan"
  /** The shop's KYBC is not verified, or the shop is suspended (409). */
  | "pro_not_verified"
  /** The shop's plan does not include this feature (the stock import: Business and up) (403). */
  | "plan_upgrade_required"
  /** No Stripe customer yet: nothing to manage before a first plan (409). */
  | "no_billing_customer"
  /** A webhook whose signature does not match (400, Stripe's expected answer). */
  | "invalid_signature"
  /** A stock import file that is no CSV (empty, unclosed quote, over 300 lines; 400; details: { reason, line }). Messages: StockImport.errors. */
  | "invalid_csv"
    /** Firestore daily quota degraded (src/lib/quota/gate.ts): deposit or sign-up suspended until the reset. */
  | "quota_exhausted"
  // Messaging, reports, appeals, assistant (phase 5). Messages: Messaging.errors / Report.errors.
  /** One side blocked the other (403). */
  | "conversation_blocked"
  /** Conversation frozen (dispute or authority request) or the other account is gone (409). */
  | "conversation_unavailable"
  /** A seller cannot message himself about his own listing (409). */
  | "self_conversation"
  /** First message about an adults-only listing without the buyer's 18+ confirmation (422). */
  | "adult_confirmation_required"
  /** The appointment changed since the caller saw it (answered, withdrawn, replaced; 409). */
  | "appointment_changed"
  /** The chosen slot has started or passed (409). */
  | "appointment_slot_past"
  /** Reporter abusive (art. 23) or target not reportable by this account (403). */
  | "report_not_allowed"
  /** The reported target does not exist or is not visible to the reporter (404 semantics, 422). */
  | "report_target_invalid"
  /** Appeal window (6 months) closed, or the decision cannot be appealed (409). */
  | "appeal_closed"
  /** An appeal is already open or decided for this decision (409). */
  | "appeal_exists"
  /** Not the affected user nor a reporter of this decision (403). */
  | "appeal_not_allowed"
  /** An appeal is reviewed by another moderator than the one who decided (403). */
  | "same_reviewer"
  /** Ban by a moderator outside a P0 he confirmed, or a sanction above his role (403). */
  | "sanction_not_allowed"
  /** AI budget or provider unavailable: the assistant answers with help-center search results. */
  | "assistant_unavailable"
  // Account closure (phase 5, L7). Messages: Auth.errors.
  /** The session's sign-in is older than RECENT_AUTH_SECONDS: sign in again, then retry (403). */
  | "recent_auth_required"
  /** A Pro subscription still renews: cancel it before closing the account (409). */
  | "pro_subscription_active"
  /** Purchased credits are left in the wallet (409). */
  | "wallet_not_empty"
  // Back office (phase 6, D13).
  /** config/legal without a mention art. 1-1 LCEN requires (422; details: { missing }). */
  | "legal_incomplete"
  | "unavailable"
  /** 422: a short free text (storefront bio, review) refused by the text screen; details: { field, issue }. */
  | "invalid_text"
  | "internal";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(status: number, code: ErrorCode, message?: string, options: { details?: unknown; headers?: Record<string, string> } = {}) {
    super(message ?? code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers;
  }

  toResponse(): Response {
    return errorResponse(this.status, this.code, this.message === this.code ? undefined : this.message, this.details, this.headers);
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message?: string; details?: unknown };
}

export function errorResponse(status: number, code: ErrorCode, message?: string, details?: unknown, headers: Record<string, string> = {}): Response {
  const body: ErrorBody = { error: { code, ...(message ? { message } : {}), ...(details !== undefined ? { details } : {}) } };
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export const unauthenticated = (message?: string) => new HttpError(401, "unauthenticated", message);
export const forbidden = (message?: string) => new HttpError(403, "forbidden", message);
export const notFound = (message?: string) => new HttpError(404, "not_found", message);
export const unavailable = (message?: string) => new HttpError(503, "unavailable", message, { headers: { "Retry-After": "30" } });
export const rateLimited = (retryAfterSeconds: number) =>
  new HttpError(429, "rate_limited", undefined, { headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) } });
