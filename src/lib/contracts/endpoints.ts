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
  clientToken: "/api/auth/client-token",
  me: "/api/auth/me",
  resetRequest: "/api/auth/password/reset",
  resetConfirm: "/api/auth/password/confirm",
  passwordChange: "/api/auth/password/change",
  verifyResend: "/api/auth/verify/resend",
  action: "/api/auth/action",
  phoneStart: "/api/auth/phone/start",
  phoneStatus: "/api/auth/phone/status",
  profile: "/api/auth/profile",
  staffLogin: "/api/admin/auth/login",
  staffLogout: "/api/admin/auth/logout",
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
export const MESSAGING_API = {
  /** POST: first message about a listing (Turnstile). */
  conversations: "/api/conversations",
  /** POST a message. */
  messages: (cid: string) => `/api/conversations/${cid}/messages`,
  /** POST: zero my unread count. */
  read: (cid: string) => `/api/conversations/${cid}/read`,
  /** POST { archived } | { hidden: true } | { blocked }. */
  state: (cid: string) => `/api/conversations/${cid}/state`,
  /** GET { total } (Valkey). */
  unread: "/api/messages/unread",
} as const;

export const REPORT_API = {
  /** POST the notice form. */
  reports: "/api/reports",
} as const;

export const APPEAL_API = {
  /** POST (signed in). */
  appeals: "/api/appeals",
  /** POST with the signed token of the e-mail. */
  link: "/api/appeals/link",
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
