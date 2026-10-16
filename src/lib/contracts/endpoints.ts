import type { OwnerListBucket } from "./listings";

// API paths shared by the browser and the route handlers. No zod here: a public client island that
// only needs a path (the phone reveal, the session) must not pull the validation schemas into the
// page's JavaScript. auth.ts and listings.ts re-export them.

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
