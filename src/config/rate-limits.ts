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
  key: "device" | "ip" | "ip48" | "uid" | "email" | "account+ip" | "account" | "phone" | "uid+cid";
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
  // IPv6 clients also count on their /48 (§6 "Les clés": the wider counter for aggressive sources),
  // ten times the /64 allowance; IPv4 clients have no such counter (keys.ts `ip48`).
  "signup.ip48": { points: 300, duration: HOUR, policy: "closed", key: "ip48" },
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
  "login.ip48": { points: 3000, duration: HOUR, policy: "closed", key: "ip48" },
  // Password reset: 3 per hour per normalized e-mail, IP in escalation.
  "reset.email": { points: 3, duration: HOUR, policy: "closed", key: "email" },
  "reset.ip": { points: 30, duration: HOUR, policy: "closed", key: "ip" },
  // Verification e-mail resend.
  "verify.resend.uid": { points: 3, duration: HOUR, policy: "closed", key: "uid" },
  // Action codes (verification and reset links): per IP, brute force on oobCode.
  "action.ip": { points: 60, duration: HOUR, policy: "closed", key: "ip" },
  // WhatsApp verification: 3 per day per account, 5 per day per IP /64, 1 per minute per number and account.
  "phone.uid": { points: 3, duration: DAY, policy: "closed", key: "uid" },
  "phone.ip": { points: 5, duration: DAY, policy: "closed", key: "ip" },
  "phone.number": { points: 1, duration: MINUTE, policy: "closed", key: "phone" },
  "phone.status.uid": { points: 400, duration: HOUR, policy: "open", key: "uid" },
  // Staff login on the admin host (Access already in front): tight.
  "staff.login.accountIp": { points: 5, duration: 15 * MINUTE, blockDuration: 15 * MINUTE, policy: "closed", key: "account+ip" },
  // Account settings mutations (display name, password change, account closure).
  "account.mutation.uid": { points: 60, duration: HOUR, policy: "closed", key: "uid" },
  // Account closure (phase 5, L7): idempotent but heavy (listings, conversations, Auth), 5 per hour.
  // Personal data export: up to ~2 000 Firestore reads each (Spark: 50 000 a day), 3 per day.
  "account.close.uid": { points: 5, duration: HOUR, policy: "closed", key: "uid" },
  "account.export.uid": { points: 3, duration: DAY, policy: "closed", key: "uid" },
  // --- Listings and media (phase 3, design §4) ---------------------------------------------
  // Draft autosave (PATCH /api/listings/{id}): coalesced client-side, never per keystroke.
  "listing.draft.uid": { points: 120, duration: HOUR, policy: "open", key: "uid" },
  // PATCH /api/listings/{id} on a listing that is not a draft (live listings save on request): a
  // save may screen again (photos, up to 50 other listings) and commits ~3 writes (listing,
  // searchOutbox, contentOps). 30 per day per account, besides listing.draft.uid.
  "listing.edit.uid": { points: 30, duration: DAY, policy: "open", key: "uid" },
  // POST /api/listings: 5 per day per account (individuals, D5), 30 per hour per IP then Turnstile.
  "listing.create.uid": { points: 5, duration: DAY, policy: "open", key: "uid" },
  // Pros (phase 7): the plan's listingsPerDay is counted in Firestore at publish (25, 100 or
  // unlimited); this only caps runaway scripts, Premium included.
  "listing.create.pro.uid": { points: 500, duration: DAY, policy: "open", key: "uid" },
  "listing.create.ip": { points: 30, duration: HOUR, policy: "open", key: "ip" },
  // The owner's routes cost Firestore quota shared by the whole site (Spark: 20 000 writes and
  // 50 000 reads a day). POST /api/listings (a new draft; the 5 above count publications, at
  // publish): 20 per day per account. MAX_DRAFTS caps live drafts, this caps create-delete loops.
  "listing.new.uid": { points: 20, duration: DAY, policy: "open", key: "uid" },
  // POST /api/pro/apply (phase 7): a few attempts a day per account (reads the account, the
  // owner's shop and up to 6 uploads, then one transaction).
  "pro.apply.uid": { points: 5, duration: DAY, policy: "open", key: "uid" },
  // GET /api/pro/me (3 to 4 reads: account, shop, active count): the Pro area's page loads.
  "pro.read.uid": { points: 300, duration: HOUR, policy: "open", key: "uid" },
  // POST /api/listings/{id}/options (phase 7): a paid option, ~4 reads and 4 writes. Closed: it
  // debits credits. 30 per day per account.
  "listing.options.uid": { points: 30, duration: DAY, policy: "closed", key: "uid" },
  // GET /api/wallet and /api/listings/{id}/options, points = documents read (a ledger page reads
  // up to 22, the options of a listing 2): 2 000 per day per account.
  "wallet.read.uid": { points: 2000, duration: DAY, policy: "open", key: "uid" },
  // POST /api/wallet/packs (phase 7): opens a pack's payment page (Turnstile, 2 reads, 1 write).
  // Closed: it leads to a charge. 20 per day per account, 60 per hour per IP.
  "billing.checkout.uid": { points: 20, duration: DAY, policy: "closed", key: "uid" },
  "billing.checkout.ip": { points: 60, duration: HOUR, policy: "closed", key: "ip" },
  // DELETE /api/listings/{id} and pause / resume / sold / renew (~4 writes and an ISR
  // revalidation each): 120 per day per account (an individual has at most 20 active listings).
  "listing.status.uid": { points: 120, duration: DAY, policy: "open", key: "uid" },
  // POST /api/listings/{id}/publish, every attempt (a refused one still reads the listing, the
  // account and the seller's other listings for the screening): 60 per day per account, before
  // any read. The 5 publications a day (listing.create.uid) are counted inside, at the transition.
  "listing.publish.uid": { points: 60, duration: DAY, policy: "open", key: "uid" },
  // GET /api/listings/{id} and /mine, points = documents read (a /mine tab reads up to 100, the
  // owner view the listing and its uploads, also when PATCH and the status routes answer with it):
  // 5 000 per day per account, a tenth of the Spark day. Pause and sold (they take a listing down)
  // are charged without being refused.
  "listing.owner.read.uid": { points: 5000, duration: DAY, policy: "open", key: "uid" },
  // POST /api/uploads/sign: 30 per hour; bytes declared per day (points = bytes, 200 MiB).
  // Closed: every signed upload costs R2 operations and storage.
  "upload.sign.uid": { points: 30, duration: HOUR, policy: "closed", key: "uid" },
  "upload.bytes.uid": { points: 200 * MIB, duration: DAY, policy: "closed", key: "uid" },
  // KYBC pieces of a Pro application (phase 7): a few documents, resent after a rejection.
  "pro.kybc.sign.uid": { points: 20, duration: DAY, policy: "closed", key: "uid" },
  // GET /api/uploads/{id} (polling) and repeated completes: one Firestore read each.
  "upload.status.uid": { points: 900, duration: HOUR, policy: "open", key: "uid" },
  // DELETE /api/uploads/{id} (~3 reads, the detach transaction, the document delete and up to 3
  // object deletions): 300 per day per account (20 active listings of 10 photos is 200).
  "upload.delete.uid": { points: 300, duration: DAY, policy: "open", key: "uid" },
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
  // Pro applications (phase 7): a moderator's verify or reject; each verification retags the
  // owner's listings (up to RETAG_PAGE x RETAG_MAX_PAGES writes), so far fewer than listings.
  "pro.decision.uid": { points: 60, duration: HOUR, policy: "closed", key: "uid" },
  // Staff reads of KYBC pieces (identity documents, admin host): a review opens a few; closed, a
  // bulk download by a careless or stolen staff session stops at the ceiling.
  "pro.kybc.view.uid": { points: 300, duration: HOUR, policy: "closed", key: "uid" },
  // --- Search and discovery (phase 4, design §6) ---------------------------------------------
  // /api/search and /recherche pages: 30 per minute and 600 per hour per device (or uid), 120 per
  // minute per IP; over: Turnstile, then 429. Open: reading and searching stay up without Valkey.
  "search.device.minute": { points: 30, duration: MINUTE, policy: "open", key: "device" },
  "search.device.hour": { points: 600, duration: HOUR, policy: "open", key: "device" },
  "search.ip": { points: 120, duration: MINUTE, policy: "open", key: "ip" },
  "search.ip48": { points: 1200, duration: MINUTE, policy: "open", key: "ip48" },
  // After a solved challenge (30 min pass): a bounded allowance, then 429.
  "search.passed.device": { points: 300, duration: 30 * MINUTE, policy: "open", key: "device" },
  // Server-rendered pages /annonce, /c, /profil, /boutique (proxy.ts): visitor 120 per hour per
  // device, signed in 600 per hour, 1 200 per hour per IP /64; verified bots exempt.
  "pages.device": { points: 120, duration: HOUR, policy: "open", key: "device" },
  "pages.session": { points: 600, duration: HOUR, policy: "open", key: "account" },
  "pages.ip": { points: 1200, duration: HOUR, policy: "open", key: "ip" },
  "pages.ip48": { points: 12000, duration: HOUR, policy: "open", key: "ip48" },
  "pages.passed.device": { points: 600, duration: HOUR, policy: "open", key: "device" },
  // Turnstile tokens refused by the page and search challenges (security/challenge-handler.ts):
  // past 10 an hour per device, 429 without a siteverify call. Per IP, 300 an hour, only held
  // against a device that already failed, so a stranger on a shared IPv4 cannot cheaply block a
  // first, valid solve; the hard ceiling (5x) holds whatever the device and bounds the siteverify
  // calls of a client minting one device cookie per junk token.
  "challenge.device": { points: 10, duration: HOUR, policy: "closed", key: "device" },
  "challenge.ip": { points: 300, duration: HOUR, policy: "closed", key: "ip" },
  "challenge.ip.hard": { points: 1500, duration: HOUR, policy: "closed", key: "ip" },
  "challenge.ip48.hard": { points: 15000, duration: HOUR, policy: "closed", key: "ip48" },
  // Favorites: adding and removing hearts (one write or delete each), 300 per day per account.
  "favorites.write.uid": { points: 300, duration: DAY, policy: "open", key: "uid" },
  // Reading them: 1 200 calls per hour (GET /api/favorites/ids answers from the Valkey set), and
  // the documents read like listing.owner.read.uid (a page reads up to 49, a rebuild of the hearts
  // set up to 600): 2 500 per day per account.
  "favorites.read.uid": { points: 1200, duration: HOUR, policy: "open", key: "uid" },
  "favorites.docs.uid": { points: 2500, duration: DAY, policy: "open", key: "uid" },
  // Saved searches (10 per account): create, rename, alert toggle, delete, 100 per day; list,
  // 600 calls per hour and 1 000 documents read per day.
  "savedSearch.write.uid": { points: 100, duration: DAY, policy: "open", key: "uid" },
  "savedSearch.read.uid": { points: 600, duration: HOUR, policy: "open", key: "uid" },
  "savedSearch.docs.uid": { points: 1000, duration: DAY, policy: "open", key: "uid" },
  // One-click unsubscribe links of the alert e-mails (signed token, no session).
  "alerts.unsubscribe.ip": { points: 60, duration: HOUR, policy: "open", key: "ip" },

  // Phase 5 (architecture §6, design phase-5 §2).
  // Messaging: 20 messages per minute; new conversations 50 per day, 10 for accounts under 7 days;
  // Turnstile on the first message of every conversation. Open: a Valkey outage never blocks a reply.
  "message.send.uid": { points: 20, duration: MINUTE, policy: "open", key: "uid" },
  // Every send costs 2-3 writes of the shared 20 000/day Firestore quota (audit D1a-01): besides the
  // burst above, 120 per hour and 400 per day per account, and 60 per hour per account and thread
  // (key `${uid}:${cid}`), checked together in handlers.ts before the quota gate.
  "message.send.hour.uid": { points: 120, duration: HOUR, policy: "open", key: "uid" },
  "message.send.day.uid": { points: 400, duration: DAY, policy: "open", key: "uid" },
  "message.send.thread": { points: 60, duration: HOUR, policy: "open", key: "uid+cid" },
  "conversation.new.uid": { points: 50, duration: DAY, policy: "open", key: "uid" },
  "conversation.new.young.uid": { points: 10, duration: DAY, policy: "open", key: "uid" },
  // Read, archive, hide, block calls of the inbox, and the unread badge.
  "conversation.state.uid": { points: 600, duration: HOUR, policy: "open", key: "uid" },
  "messages.unread.uid": { points: 600, duration: HOUR, policy: "open", key: "uid" },
  // The browser reads conversations through the API only (D2, 19 Oct): inbox pages, inbox rows and
  // thread pages, 1 200 calls per hour (a live thread refetches its newer messages on each event),
  // and the documents they read (an inbox page up to 31, a thread page up to 52, a refetch 2 or 3):
  // 5 000 per day per account, a tenth of the Spark day, like listing.owner.read.uid.
  "conversation.read.uid": { points: 1200, duration: HOUR, policy: "open", key: "uid" },
  "conversation.docs.uid": { points: 5000, duration: DAY, policy: "open", key: "uid" },
  // GET /api/messages/stream opens (one per tab; the stream ends after 30 min and reconnects).
  "messages.stream.uid": { points: 120, duration: HOUR, policy: "open", key: "uid" },
  // Reports: signed in 20 per day; anonymous 5 per hour per device and 20 per hour per IP (Turnstile
  // always); P0 reasons 3 per day per account, 2 per device, 5 per IP /64. Open: a report is always
  // accepted, and without Valkey a P0 hides nothing (no "multi" strong signal).
  "report.uid": { points: 20, duration: DAY, policy: "open", key: "uid" },
  "report.device": { points: 5, duration: HOUR, policy: "open", key: "device" },
  "report.ip": { points: 20, duration: HOUR, policy: "open", key: "ip" },
  "report.p0.uid": { points: 3, duration: DAY, policy: "open", key: "uid" },
  "report.p0.device": { points: 2, duration: DAY, policy: "open", key: "device" },
  "report.p0.ip": { points: 5, duration: DAY, policy: "open", key: "ip" },
  // Acknowledgement mail of a notice (art. 16(4)): 2 per day per normalized e-mail, whoever typed it
  // (an anonymous reporter may type a stranger's address, audit D1a-04); the report id is on screen,
  // the mail is a courtesy (bulk priority). Closed: without the store no acknowledgement leaves.
  "report.ack.email": { points: 2, duration: DAY, policy: "closed", key: "email" },
  // Appeals (art. 20): signed-in and signed-link routes.
  "appeal.uid": { points: 10, duration: DAY, policy: "closed", key: "uid" },
  "appeal.link.ip": { points: 30, duration: HOUR, policy: "closed", key: "ip" },
  // Assistant Joutiya: 20 messages per hour and 50 per day per device or account; 200 per day per IP
  // /64, then Turnstile. Closed: it spends the AI budget.
  "assistant.device.hour": { points: 20, duration: HOUR, policy: "closed", key: "device" },
  "assistant.device.day": { points: 50, duration: DAY, policy: "closed", key: "device" },
  "assistant.ip": { points: 200, duration: DAY, policy: "closed", key: "ip" },
  // Back-office reads (queues, target views, stats) and the staff conversation view (D18).
  "admin.read.uid": { points: 3000, duration: HOUR, policy: "open", key: "uid" },
  "admin.conversation.uid": { points: 60, duration: HOUR, policy: "closed", key: "uid" },
} as const satisfies Record<string, RateLimitDefinition>;

export type RateLimitId = keyof typeof RATE_LIMITS;
