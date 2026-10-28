import type { OwnerListBucket } from "./listings";

// API paths shared by the browser and the route handlers. No zod here: a public client island that
// only needs a path (the phone reveal, the session, a favorite's heart) must not pull the validation
// schemas into the page's JavaScript. auth.ts, listings.ts and search.ts re-export them.

/** Password length bounds, shown by the forms' error messages (auth.ts re-exports them). */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export const AUTH_API = {
  signup: "/api/auth/signup",
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  /** Google Identity Services credential -> session (existing account or sign-up with consents). */
  google: "/api/auth/google",
  /** Firebase ID token (google.com provider) -> session; kept for the SDK flow. */
  session: "/api/auth/session",
  me: "/api/auth/me",
  resetRequest: "/api/auth/password/reset",
  resetConfirm: "/api/auth/password/confirm",
  passwordChange: "/api/auth/password/change",
  verifyResend: "/api/auth/verify/resend",
  action: "/api/auth/action",
  phoneStart: "/api/auth/phone/start",
  phoneStatus: "/api/auth/phone/status",
  profile: "/api/auth/profile",
  /** Renewed transfers consent (art. 44 loi 09-08) of the re-consent panel. */
  consents: "/api/auth/consents",
  staffLogin: "/api/admin/auth/login",
  staffLogout: "/api/admin/auth/logout",
} as const;

/** Account closure and personal data export (phase 5, D26). */
export const ACCOUNT_API = {
  /** POST { confirm: true } -> CloseAccountResponse (session cookies cleared); recent sign-in required (403 recent_auth_required). */
  close: "/api/account/close",
  /** GET with the X-CSRF-Token header -> the AccountExport JSON file (attachment, no-store). */
  export: "/api/account/export",
  /** GET -> StorefrontSettings; POST StorefrontInput -> StorefrontSettings (vitrine-avis §1). */
  storefront: "/api/account/storefront",
} as const;

export const LISTING_API = {
  /** POST create a draft; GET is not served (use `mine`). */
  listings: "/api/listings",
  mine: (bucket: OwnerListBucket) => `/api/listings/mine?status=${bucket}`,
  /** GET (owner), PATCH, DELETE. */
  listing: (id: string) => `/api/listings/${id}`,
  publish: (id: string) => `/api/listings/${id}/publish`,
  pause: (id: string) => `/api/listings/${id}/pause`,
  resume: (id: string) => `/api/listings/${id}/resume`,
  sold: (id: string) => `/api/listings/${id}/sold`,
  renew: (id: string) => `/api/listings/${id}/renew`,
  /** POST, answer `Cache-Control: no-store`. */
  phone: (id: string) => `/api/listings/${id}/phone`,
} as const;

// Phase 5 (design phase-5 §3, §4).
/** Longest message text (characters after trimming); messaging.ts re-exports it. */
export const MESSAGE_TEXT_MAX = 2000;

export const MESSAGING_API = {
  /** POST: first message about a listing (Turnstile). GET ?cursor=&archived=1 -> ConversationsPage. */
  conversations: "/api/conversations",
  /** GET -> ConversationResponse (one inbox row). */
  conversation: (cid: string) => `/api/conversations/${cid}`,
  /** POST a message. GET ?cursor= (older) or ?after= (newer) -> MessagesPage. */
  messages: (cid: string) => `/api/conversations/${cid}/messages`,
  /** POST: zero my unread count. */
  read: (cid: string) => `/api/conversations/${cid}/read`,
  /** POST { archived } | { hidden: true } | { blocked }. */
  state: (cid: string) => `/api/conversations/${cid}/state`,
  /** POST AppointmentAction -> 201 AppointmentResponse (contracts/appointments.ts). */
  appointment: (cid: string) => `/api/conversations/${cid}/appointment`,
  /** GET { total } (Valkey). */
  unread: "/api/messages/unread",
  /** GET text/event-stream of MessagingEvent (session cookie; one per tab, D2). */
  stream: "/api/messages/stream",
} as const;

/** Explanation of a notice, in characters after trimming (reports.ts re-exports them). */
export const REPORT_EXPLANATION_MIN = 10;
export const REPORT_EXPLANATION_MAX = 2000;

export const REPORT_API = {
  /** POST the notice form -> 201 (new) or 200 (duplicate) CreateReportResponse. */
  reports: "/api/reports",
} as const;

/** Text of an appeal, in characters after trimming (appeals.ts re-exports them). */
export const APPEAL_TEXT_MIN = 10;
export const APPEAL_TEXT_MAX = 2000;

export const APPEAL_API = {
  /** GET -> MyDecisionsResponse (signed in, suspended included); POST { decisionId, text } -> 201. */
  appeals: "/api/appeals",
  /** GET ?token= -> { decision }; POST { token, text } -> 201 (the signed link of the e-mail). */
  link: "/api/appeals/link",
} as const;

/** Assistant Joutiya (assistant.ts re-exports them): question, earlier turns, how many turns. */
export const ASSISTANT_QUESTION_MAX = 500;
export const ASSISTANT_TURN_MAX = 1500;
export const ASSISTANT_HISTORY_MAX = 6;

export const ASSISTANT_API = {
  /** POST AssistantRequest -> AssistantResponse (`ai`, or `search` when the AI is unavailable). */
  assistant: "/api/assistant",
} as const;

export const SEARCH_API = {
  /** GET ?<search params> -> SearchApiResponse. Over the limits: 403 turnstile_required, then 429. */
  search: "/api/search",
  /** GET -> { ids: string[] } (hearts state; Valkey cache over the subcollection). */
  favoriteIds: "/api/favorites/ids",
  /** GET ?cursor= -> FavoritesPage. */
  favorites: "/api/favorites",
  /** PUT -> 201/200 { favorite } ; DELETE -> 204. */
  favorite: (listingId: string) => `/api/favorites/${listingId}`,
  /** GET -> { searches: SavedSearchView[] } ; POST SavedSearchCreate -> 201 { search }. */
  savedSearches: "/api/saved-searches",
  /** PATCH SavedSearchPatch -> { search } ; DELETE -> 204. */
  savedSearch: (id: string) => `/api/saved-searches/${id}`,
  /** POST { token } (and RFC 8058 one-click POST with ?t=) -> 204. No session, no CSRF: the token authenticates. */
  unsubscribe: "/api/alerts/unsubscribe",
  /** POST { token } -> 204 + __Host-tsv pass (page challenge of /anti-robot). */
  challengePass: "/api/challenge/pass",
} as const;
