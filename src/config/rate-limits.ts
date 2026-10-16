// Rate limits (architecture §6, "Limitation de débit"). Keys are HMACs of the IP bucket (IPv4 or
// IPv6 /64), the device cookie, the uid or the normalized e-mail: nothing in clear in Valkey.
// `policy` says what happens when valkey-ratelimit is down: "closed" refuses (what costs money or
// exposes data), "open" lets the request through.

export type FailPolicy = "open" | "closed";

export interface RateLimitDefinition {
  /** Allowed consumptions per `duration`. */
  points: number;
  /** Window, seconds. */
  duration: number;
  /** Extra block once the window is exceeded, seconds (0 = until the window ends). */
  blockDuration?: number;
  policy: FailPolicy;
  /** What the key is made of, for the audit of this table. */
  key: "device" | "ip" | "ip48" | "uid" | "email" | "account+ip" | "account" | "phone";
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;

export const RATE_LIMITS = {
  // /api/auth/signup: 3 per day per device; one account per normalized e-mail (users repository);
  // IP: 30 per hour, Turnstile always required.
  "signup.device": { points: 3, duration: DAY, policy: "closed", key: "device" },
  "signup.ip": { points: 30, duration: HOUR, policy: "closed", key: "ip" },
  // Sign-up attempt on an e-mail that already has an account: the warning mail to its owner is
  // sent 3 times per hour at most per normalized e-mail (mail bombing); the answer never changes.
  "signup.existing.email": { points: 3, duration: HOUR, policy: "closed", key: "email" },
  // Google sign-in (/api/auth/google and /api/auth/session): 10 per hour per device, 60 per hour per IP.
  "google.device": { points: 10, duration: HOUR, policy: "closed", key: "device" },
  "google.ip": { points: 60, duration: HOUR, policy: "closed", key: "ip" },
  // /api/auth/login: 5 failures in 15 min then a 15 min lock for this account + IP /64;
  // 20 failures per hour on an account: Turnstile mandatory for that account.
  "login.fail.accountIp": { points: 5, duration: 15 * MINUTE, blockDuration: 15 * MINUTE, policy: "closed", key: "account+ip" },
  "login.fail.account": { points: 20, duration: HOUR, policy: "closed", key: "account" },
  // Login attempts per IP (CGNAT: high, escalates to Turnstile, never a hard block).
  "login.ip": { points: 300, duration: HOUR, policy: "closed", key: "ip" },
  // Password reset: 3 per hour per normalized e-mail, IP in escalation.
  "reset.email": { points: 3, duration: HOUR, policy: "closed", key: "email" },
  "reset.ip": { points: 30, duration: HOUR, policy: "closed", key: "ip" },
  // Verification e-mail resend.
  "verify.resend.uid": { points: 3, duration: HOUR, policy: "closed", key: "uid" },
  // Action codes (verification and reset links): per IP, brute force on oobCode.
  "action.ip": { points: 60, duration: HOUR, policy: "closed", key: "ip" },
  // /api/auth/client-token: 120 per hour per uid.
  "clientToken.uid": { points: 120, duration: HOUR, policy: "open", key: "uid" },
  // WhatsApp verification: 3 per day per account, 5 per day per IP /64, 1 per minute per number and account.
  "phone.uid": { points: 3, duration: DAY, policy: "closed", key: "uid" },
  "phone.ip": { points: 5, duration: DAY, policy: "closed", key: "ip" },
  "phone.number": { points: 1, duration: MINUTE, policy: "closed", key: "phone" },
  "phone.status.uid": { points: 400, duration: HOUR, policy: "open", key: "uid" },
  // Staff login on the admin host (Access already in front): tight.
  "staff.login.accountIp": { points: 5, duration: 15 * MINUTE, blockDuration: 15 * MINUTE, policy: "closed", key: "account+ip" },
  // Account settings mutations (display name, password change, account closure).
  "account.mutation.uid": { points: 60, duration: HOUR, policy: "closed", key: "uid" },
  // --- Listings and media (phase 3, design §4) ---------------------------------------------
  // Draft autosave (PATCH /api/listings/{id}): coalesced client-side, never per keystroke.
  "listing.draft.uid": { points: 120, duration: HOUR, policy: "open", key: "uid" },
  // POST /api/listings: 5 per day per account (individuals, D5), 30 per hour per IP then Turnstile.
  "listing.create.uid": { points: 5, duration: DAY, policy: "open", key: "uid" },
  "listing.create.ip": { points: 30, duration: HOUR, policy: "open", key: "ip" },
  // The owner's routes cost Firestore quota shared by the whole site (Spark: 20 000 writes and
  // 50 000 reads a day). POST /api/listings (a new draft; the 5 above count publications, at
  // publish): 20 per day per account. MAX_DRAFTS caps live drafts, this caps create-delete loops.
  "listing.new.uid": { points: 20, duration: DAY, policy: "open", key: "uid" },
  // DELETE /api/listings/{id} and pause / resume / sold / renew (~4 writes and an ISR
  // revalidation each): 120 per day per account (an individual has at most 20 active listings).
  "listing.status.uid": { points: 120, duration: DAY, policy: "open", key: "uid" },
  // GET /api/listings/{id} and /mine, points = documents read (a /mine tab reads up to 100, the
  // owner view the listing and its uploads): 5 000 per day per account, a tenth of the Spark day.
  "listing.owner.read.uid": { points: 5000, duration: DAY, policy: "open", key: "uid" },
  // POST /api/uploads/sign: 30 per hour; bytes declared per day (points = bytes, 200 MiB).
  // Closed: every signed upload costs R2 operations and storage.
  "upload.sign.uid": { points: 30, duration: HOUR, policy: "closed", key: "uid" },
  "upload.bytes.uid": { points: 200 * MIB, duration: DAY, policy: "closed", key: "uid" },
  // GET /api/uploads/{id} (polling) and repeated completes: one Firestore read each.
  "upload.status.uid": { points: 900, duration: HOUR, policy: "open", key: "uid" },
  // POST /api/listings/{id}/phone (§6): 10 per hour and 30 per day per account, 20 per day per
  // device, 60 per day per IP then Turnstile. Closed: the number is personal data.
  "reveal.uid.hour": { points: 10, duration: HOUR, policy: "closed", key: "uid" },
  "reveal.uid.day": { points: 30, duration: DAY, policy: "closed", key: "uid" },
  "reveal.device": { points: 20, duration: DAY, policy: "closed", key: "device" },
  "reveal.ip": { points: 60, duration: DAY, policy: "closed", key: "ip" },
  // Every reveal call, repeats included: a listing this account already revealed skips the four
  // limiters above yet still reads ~5 documents. 200 per day per account; open, a repeat discloses
  // nothing new and first reveals stay behind the closed limiters.
  "reveal.call.uid": { points: 200, duration: DAY, policy: "open", key: "uid" },
  // Public listing and profile reads (API; the SSR page limit lives in the proxy, phase 4).
  "listing.read.ip": { points: 1200, duration: HOUR, policy: "open", key: "ip" },
  "profile.read.ip": { points: 1200, duration: HOUR, policy: "open", key: "ip" },
  // Staff moderation decisions (admin host, behind Access): a moderator working the queue.
  "moderation.decision.uid": { points: 300, duration: HOUR, policy: "closed", key: "uid" },
  // --- Search and discovery (phase 4, design §6) ---------------------------------------------
  // /api/search and /recherche pages: 30 per minute and 600 per hour per device (or uid), 120 per
  // minute per IP; over: Turnstile, then 429. Open: reading and searching stay up without Valkey.
  "search.device.minute": { points: 30, duration: MINUTE, policy: "open", key: "device" },
  "search.device.hour": { points: 600, duration: HOUR, policy: "open", key: "device" },
  "search.ip": { points: 120, duration: MINUTE, policy: "open", key: "ip" },
  // After a solved challenge (30 min pass): a bounded allowance, then 429.
  "search.passed.device": { points: 300, duration: 30 * MINUTE, policy: "open", key: "device" },
  // Server-rendered pages /annonce, /c, /profil, /boutique (proxy.ts): visitor 120 per hour per
  // device, signed in 600 per hour, 1 200 per hour per IP /64; verified bots exempt.
  "pages.device": { points: 120, duration: HOUR, policy: "open", key: "device" },
  "pages.session": { points: 600, duration: HOUR, policy: "open", key: "account" },
  "pages.ip": { points: 1200, duration: HOUR, policy: "open", key: "ip" },
  "pages.passed.device": { points: 600, duration: HOUR, policy: "open", key: "device" },
  // Solving the page challenge (/anti-robot): Turnstile verifications per IP.
  "challenge.ip": { points: 30, duration: HOUR, policy: "closed", key: "ip" },
  // Favorites: adding and removing hearts, reading the list.
  "favorites.write.uid": { points: 300, duration: HOUR, policy: "open", key: "uid" },
  "favorites.read.uid": { points: 1200, duration: HOUR, policy: "open", key: "uid" },
  // Saved searches (10 per account): create, rename, alert toggle, delete; list.
  "savedSearch.write.uid": { points: 60, duration: HOUR, policy: "open", key: "uid" },
  "savedSearch.read.uid": { points: 600, duration: HOUR, policy: "open", key: "uid" },
  // One-click unsubscribe links of the alert e-mails (signed token, no session).
  "alerts.unsubscribe.ip": { points: 60, duration: HOUR, policy: "open", key: "ip" },
} as const satisfies Record<string, RateLimitDefinition>;

export type RateLimitId = keyof typeof RATE_LIMITS;
